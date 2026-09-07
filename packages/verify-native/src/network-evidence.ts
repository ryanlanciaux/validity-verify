/**
 * HTTP(S) evidence from a device session — `agent-device network dump --json`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR
 * ---------------------------------------------------------------------------
 * The native runtime mocks the network with MSW inside the companion, and the
 * host has never been able to SEE whether that held: a screenshot scored green
 * looks identical whether the list came from a fixture or from production.
 * 0.20.5's `network dump` parses the session's app logs into structured
 * request records, which is the first host-side observation of what the device
 * actually talked to.
 *
 * This module CAPTURES that. It does not judge it. Mock-vs-real leakage
 * detection is a real never-false-green follow-up, and it needs a decision
 * about what "real" means for a dev build (Metro's own traffic, Expo's update
 * checks, and symbolication requests are all legitimately non-mocked), which is
 * a spec-level question rather than a parsing one. Until that lands, the
 * evidence is written down with full provenance and nothing reads it into a
 * verdict — see the `scoring: 'advisory-evidence-only'` stamp on every record.
 *
 * ---------------------------------------------------------------------------
 * WHY NO `--include headers`
 * ---------------------------------------------------------------------------
 * Upstream offers `network dump --include headers|all`, and headers are where
 * `Authorization: Bearer …`, session cookies and API keys live. This evidence
 * is written into `.validity/runs/…`, which people commit, zip and forward. So
 * the header/body-bearing forms are deliberately NOT requested: the capture
 * takes the default projection only. A user who wants headers can run the
 * command themselves, in their own terminal, where the secret does not become
 * an artifact.
 */
import {
  captureDeviceEvidence,
  type CollectEvidenceArgs,
  type DeviceEvidence,
} from './perf-evidence.js';

/**
 * `agent-device network dump [<n>] --json`.
 *
 * `limit` is the positional record count upstream accepts (`network dump 25`).
 * Omitted → upstream's own default window, which is the honest choice for
 * evidence: a number we picked would silently truncate someone's traffic.
 */
export function networkDumpArgs(opts: { limit?: number } = {}): string[] {
  const args = ['network', 'dump'];
  if (opts.limit !== undefined && Number.isInteger(opts.limit) && opts.limit > 0) {
    args.push(String(opts.limit));
  }
  args.push('--json');
  return args;
}

export interface CollectNetworkEvidenceArgs extends CollectEvidenceArgs {
  /** Max records to request (upstream positional). Omit for upstream's default. */
  limit?: number;
}

/** Capture one network dump after the interaction phase. */
export async function collectNetworkEvidence(
  args: CollectNetworkEvidenceArgs,
): Promise<DeviceEvidence> {
  return captureDeviceEvidence(
    'network-dump',
    networkDumpArgs(args.limit === undefined ? {} : { limit: args.limit }),
    args,
  );
}

/**
 * A bounded, SHAPE-TOLERANT summary of a captured dump — distinct hosts and a
 * request count, for the one line a human reads.
 *
 * Tolerant by construction: the payload is walked for objects carrying a
 * `url`-ish string rather than matched against a schema this repo has not
 * verified against a real device. An unrecognized payload summarizes as
 * `undefined` — no count, no hosts, no claim. That asymmetry is the point: a
 * summary that says "0 requests" because it could not parse the payload would
 * be read as "the app made no network calls", which is the false-green shape
 * this whole module exists to avoid.
 */
export interface NetworkDumpSummary {
  requests: number;
  /** Distinct hosts, first-seen order, capped. */
  hosts: string[];
  /** True when more hosts were seen than are listed. */
  moreHosts?: boolean;
}

const MAX_HOSTS = 10;

export function summarizeNetworkDump(data: unknown): NetworkDumpSummary | undefined {
  const urls: string[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const url = obj.url ?? obj.uri ?? obj.requestUrl;
    if (typeof url === 'string' && url !== '') urls.push(url);
    for (const value of Object.values(obj)) walk(value, depth + 1);
  };
  walk(data, 0);

  if (urls.length === 0) return undefined;
  const hosts: string[] = [];
  for (const url of urls) {
    const host = hostOf(url);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return {
    requests: urls.length,
    hosts: hosts.slice(0, MAX_HOSTS),
    ...(hosts.length > MAX_HOSTS ? { moreHosts: true } : {}),
  };
}

/**
 * Host of a URL, without throwing on the half-URLs a log parser produces
 * (`/v1/items`, `localhost:8081/status`). Returns undefined rather than
 * inventing a host.
 */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/?#\s]+)/i.exec(url);
    const host = m?.[1];
    return host && host.includes('.') ? host : (host ?? undefined);
  }
}

/** One line for the console. Descriptive only — never a pass/fail statement. */
export function networkSummaryLine(e: DeviceEvidence): string | undefined {
  if (e.status !== 'captured' || e.data === undefined) return undefined;
  const summary = summarizeNetworkDump(e.data);
  if (!summary) return undefined;
  const hosts = summary.hosts.join(', ');
  return (
    `${summary.requests} request${summary.requests === 1 ? '' : 's'} observed` +
    (hosts ? ` across ${hosts}${summary.moreHosts ? ', …' : ''}` : '')
  );
}
