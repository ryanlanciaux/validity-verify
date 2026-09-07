/**
 * Per-capture native session metrics — the evidence base for telling a DECAYED
 * device session apart from a broken component.
 *
 * The blocker this exists for (handoff-2026-07-28): on Android, the same build
 * and the same specs score 33 pass on a cold emulator and, after ~2h of use,
 * report every render `unconfirmed` — the companion still ACKs the bridge
 * navigate while the RN root never attaches, and nothing lands in logcat. Which
 * layer decays (the agent-device daemon, the emulator's RN surface, or Metro) is
 * NOT known, because all three were always reset together. Nothing here guesses:
 * it records what each capture actually cost, so the decay is VISIBLE while it
 * is happening and so the isolation experiment (reset exactly one layer between
 * sweeps) has numbers to compare.
 *
 * Everything is best-effort and side-effect-tolerant: a metrics write must never
 * be able to fail a capture, and a corrupt/absent log must never be able to fail
 * a read. Failures are swallowed on purpose — an unwritable `.validity/runs`
 * is not a verdict.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** One capture's host-side cost + outcome. Append-only; one JSON object per line. */
export interface CaptureMetricRow {
  /** ISO timestamp of when the capture finished. */
  ts: string;
  platform: 'ios' | 'android';
  /** The spec this capture served, when the caller knows it. */
  specId?: string;
  /** coldOpen → render confirmation (see NativeTiming.openMs). */
  openMs: number;
  /** agent-device `snapshot` duration — the metric observed to grow with session age. */
  snapshotMs?: number;
  /** agent-device `screenshot` duration. */
  screenshotMs?: number;
  /** The authoritative render confirmation for this capture. */
  renderStatus: 'confirmed' | 'unconfirmed' | 'failed';
  /** `agent-device open` calls this process has made so far (see {@link deviceOpenCount}). */
  openCallCount: number;
  /**
   * DAEMON-side duration of this capture's `snapshot`, from agent-device's own
   * `events.ndjson` — what the device actually cost, with Node spawn, IPC and
   * host scheduling excluded.
   *
   * Optional and purely additive. {@link snapshotMs} stays the host-side
   * wall-clock measurement and stays the field everything reads by default, so
   * a log written before this existed — or by a session with no readable event
   * stream — parses and summarizes exactly as it always did.
   *
   * Why both, rather than replacing one with the other: the decay being hunted
   * is "the same snapshot gets slower as the session ages", and the two numbers
   * answer different halves of it. If host and device time grow TOGETHER, the
   * device/daemon is decaying; if only host time grows, the cost is on this
   * side (spawn storms, an overloaded machine) and resetting the emulator would
   * have proved nothing.
   */
  snapshotDeviceMs?: number;
  /** DAEMON-side duration of this capture's `screenshot`. See {@link snapshotDeviceMs}. */
  screenshotDeviceMs?: number;
  /**
   * Daemon-reported wall clock (`cost.wallClockMs`, agent-device 0.20.5
   * `--cost`) summed across every cost-bearing command this capture issued —
   * the settle waits, `wait stable`, the capabilities probe, `diff snapshot`.
   *
   * A THIRD measurement, not a replacement for either of the two above, and it
   * answers a question neither can: {@link snapshotDeviceMs} times ONE command,
   * while this is what the daemon spent on this capture in total. A capture
   * whose snapshot stays fast while its total device cost climbs is being eaten
   * by the waits — the settle gate, the marker wait — rather than by the tree,
   * and that is a different investigation from a decaying snapshot.
   *
   * Optional and additive: a row written by a driver with `--cost` off, or by an
   * older binary, simply carries neither this nor {@link deviceCostSamples}.
   */
  deviceCostMs?: number;
  /** How many commands contributed to {@link deviceCostMs} (0 = none reported). */
  deviceCostSamples?: number;
}

/* -------------------------------------------------------------------------- */
/* agent-device events.ndjson                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One finished agent-device request, out of a session's `events.ndjson`.
 *
 * Shape read off the live 0.20.3 stream (`agent-device events --json`), which
 * pairs a `request.started` with a `request.finished` per command, and
 * RE-VERIFIED against the installed 0.20.5 package on 2026-08-06 (its event
 * writer still emits `{kind:'request.finished', requestId, command, status,
 * details:{durationMs, …}}` with `ts`/`session` stamped alongside) — unchanged,
 * so this parser needed no edit for the upgrade:
 *
 *     {"version":1,"ts":"2026-07-30T22:05:28.331Z","session":"cwd:…:default",
 *      "kind":"request.finished","requestId":"…","command":"wait","status":"ok",
 *      "summary":"Ran wait","details":{"durationMs":583}}
 *
 * Only `request.finished` is modelled: it is the only kind that carries a
 * duration, and pairing starts to finishes by `requestId` would reconstruct a
 * number the stream already reports.
 */
export interface AgentDeviceEvent {
  /** ISO timestamp the request finished. */
  ts: string;
  /** The verb — `snapshot`, `screenshot`, `open`, `wait`, … */
  command: string;
  /** Upstream's own status token, typically `ok` or `error`. */
  status: string;
  /** Daemon-measured duration, when the stream reported one. */
  durationMs?: number;
  /** Correlates with the matching `request.started`. */
  requestId?: string;
}

/**
 * Parse `events.ndjson`. Best-effort and total: unreadable lines are dropped,
 * never thrown on, because a metrics stream is evidence and evidence that
 * cannot be parsed is missing evidence — not a failure. PURE.
 *
 * Accepts BOTH the raw ndjson file and the `events` array out of
 * `agent-device events --json`, since the records are identical either way.
 */
export function parseAgentDeviceEvents(ndjson: string): AgentDeviceEvent[] {
  const out: AgentDeviceEvent[] = [];
  for (const line of ndjson.split('\n').slice(-MAX_ROWS)) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const ev = toEvent(parsed);
    if (ev) out.push(ev);
  }
  return out;
}

function toEvent(parsed: unknown): AgentDeviceEvent | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const r = parsed as Record<string, unknown>;
  if (r.kind !== 'request.finished') return undefined;
  if (typeof r.ts !== 'string' || typeof r.command !== 'string') return undefined;
  const details = (r.details ?? {}) as Record<string, unknown>;
  return {
    ts: r.ts,
    command: r.command,
    status: typeof r.status === 'string' ? r.status : 'unknown',
    durationMs: typeof details.durationMs === 'number' ? details.durationMs : undefined,
    requestId: typeof r.requestId === 'string' ? r.requestId : undefined,
  };
}

/** Same parse, over the `{data:{events:[…]}}` envelope of `agent-device events --json`. */
export function parseAgentDeviceEventsJson(stdout: string): AgentDeviceEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const events = (parsed as { data?: { events?: unknown } })?.data?.events;
  if (!Array.isArray(events)) return [];
  return events.map(toEvent).filter((e): e is AgentDeviceEvent => e !== undefined);
}

/**
 * The daemon-side duration of the LAST successful `command` that finished
 * within `[startMs, endMs]`.
 *
 * Window-bounded and last-wins because a capture issues several commands of the
 * same verb (the settle gate alone snapshots repeatedly), and the one a row
 * should carry is the capture's own final read — the same event the host-side
 * `snapshotMs` timed. A window with no match answers undefined, which is what
 * keeps this additive: the row simply carries no device-side number.
 *
 * PURE — unit-tested without a device.
 */
export function deviceDurationFor(
  events: readonly AgentDeviceEvent[],
  command: string,
  startMs: number,
  endMs: number,
): number | undefined {
  let best: number | undefined;
  for (const e of events) {
    if (e.command !== command || e.status !== 'ok' || e.durationMs === undefined) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || t < startMs || t > endMs) continue;
    best = e.durationMs;
  }
  return best;
}

/**
 * A HOST-side event interleaved into the same log — something Validity DID to
 * the environment, as opposed to something a capture cost. Carries an `event`
 * discriminator that {@link readSessionMetrics} skips, so an event row can never
 * be mistaken for a capture and inflate (or dilute) session health.
 *
 * There is exactly one event today: the automatic companion-Metro restart. It
 * is written because a heal that is not in the record is indistinguishable from
 * a flake that fixed itself — and the whole reason the decay took 18 sweeps to
 * isolate is that nobody could see which layer had been touched when.
 */
export interface MetroRestartEventRow {
  event: 'metro-auto-restart';
  ts: string;
  platform: 'ios' | 'android';
  /** What asked for it — a `metro-decayed` diagnosis, or the pre-cliff recycle. */
  trigger: 'decay-diagnosis' | 'preventive';
  /** The spec being verified when it fired, when known. */
  specId?: string;
  /** Captures the recycled bundler had served (preventive trigger). */
  capturesOnBundler?: number;
  /** Did Metro come back up? */
  metroUp: boolean;
  /**
   * Did it help? `recovered` when the capture that followed confirmed,
   * `failed` when it did not. Absent when the restart itself did not happen.
   */
  outcome?: 'recovered' | 'failed';
}

/** Project-relative location of the metrics log. */
export const SESSION_METRICS_RELATIVE_PATH = '.validity/runs/native-session-metrics.jsonl';

/**
 * Captures more than this far apart belong to DIFFERENT sessions. Session-age
 * decay is a property of one continuous stretch of driving a device, so a
 * baseline computed across yesterday's sweep would be meaningless — and a
 * "snapshots got slower" claim built on it would be wrong.
 */
export const SESSION_GAP_MS = 10 * 60 * 1000;

/** Parse at most this many trailing lines — bounds the cost on a long-lived log. */
const MAX_ROWS = 5_000;

export function sessionMetricsPath(projectRoot: string): string {
  return resolve(projectRoot, SESSION_METRICS_RELATIVE_PATH);
}

/* -------------------------------------------------------------------------- */
/* open-call counter                                                           */
/* -------------------------------------------------------------------------- */

let openCalls = 0;

/**
 * Record that an `agent-device open` was attempted. Called by the driver on
 * every open (including the ones that fall back to the platform CLI) so a row
 * carries "how much has this daemon session been driven" — the handoff's
 * suspected decay dose. Returns the new count.
 */
export function noteDeviceOpen(): number {
  openCalls += 1;
  return openCalls;
}

/** `agent-device open` attempts in this process so far. */
export function deviceOpenCount(): number {
  return openCalls;
}

/** Reset the counter (a fresh daemon/session, or a test). */
export function resetDeviceOpenCount(): void {
  openCalls = 0;
}

/* -------------------------------------------------------------------------- */
/* daemon-reported command cost (agent-device 0.20.5 `--cost`)                 */
/* -------------------------------------------------------------------------- */

let costTotalMs = 0;
let costSamples = 0;

/**
 * Record a daemon-reported `cost.wallClockMs`. Called by the driver for every
 * `--cost` response it can parse (see `AgentDeviceOptions.cost`).
 *
 * Module-level, like {@link noteDeviceOpen}, and for the same reason: the thing
 * being counted belongs to the agent-device SESSION, not to a driver instance,
 * and `verify --all` builds a fresh driver per spec. Non-finite and negative
 * values are ignored rather than folded in — a bad number would quietly move a
 * total nobody can sanity-check.
 */
export function noteCommandCost(wallClockMs: number): void {
  if (!Number.isFinite(wallClockMs) || wallClockMs < 0) return;
  costTotalMs += wallClockMs;
  costSamples += 1;
}

/** Running totals of {@link noteCommandCost} for this process. */
export function commandCostTotals(): { totalMs: number; samples: number } {
  return { totalMs: costTotalMs, samples: costSamples };
}

/**
 * Totals since the last call, and reset — the per-CAPTURE delta a metrics row
 * carries. Returned before zeroing so a caller can never lose a sample to an
 * ordering mistake.
 */
export function takeCommandCost(): { totalMs: number; samples: number } {
  const taken = { totalMs: costTotalMs, samples: costSamples };
  costTotalMs = 0;
  costSamples = 0;
  return taken;
}

/** Reset the cost accumulator (a fresh daemon/session, or a test). */
export function resetCommandCost(): void {
  costTotalMs = 0;
  costSamples = 0;
}

/* -------------------------------------------------------------------------- */
/* write                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Append one capture row. BEST-EFFORT: every failure (unwritable dir, read-only
 * FS, serialization) is swallowed. Instrumentation that can fail a verify would
 * be a worse bug than the one it is here to diagnose.
 */
export function appendCaptureMetric(projectRoot: string, row: CaptureMetricRow): void {
  try {
    const path = sessionMetricsPath(projectRoot);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  } catch {
    /* diagnostics are never load-bearing */
  }
}

/**
 * Append one host-event row (see {@link MetroRestartEventRow}). Same
 * best-effort contract as {@link appendCaptureMetric} — an unwritable log must
 * never be able to fail (or, worse, un-do) a recovery that already happened.
 */
export function appendMetroRestartEvent(projectRoot: string, row: MetroRestartEventRow): void {
  try {
    const path = sessionMetricsPath(projectRoot);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`);
  } catch {
    /* diagnostics are never load-bearing */
  }
}

/* -------------------------------------------------------------------------- */
/* read                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Read the metrics log. Unreadable file → `[]`; individual malformed lines are
 * DROPPED rather than throwing (a half-written line from a killed process must
 * not blind the whole diagnosis). Only rows that carry the fields the summary
 * needs survive.
 */
export function readSessionMetrics(
  projectRoot: string,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf-8'),
): CaptureMetricRow[] {
  let raw: string;
  try {
    raw = readFile(sessionMetricsPath(projectRoot));
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  const rows: CaptureMetricRow[] = [];
  for (const line of lines.slice(-MAX_ROWS)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      // HOST EVENTS ARE NOT CAPTURES. An event row (a Metro auto-restart) shares
      // the log so the record is one ordered story, but counting it as a capture
      // would lengthen a session, shift its percentiles, and — worst — break a
      // trailing unconfirmed streak that is still running. Skipped on the
      // discriminator, ahead of the field checks, so a future event carrying an
      // `openMs`-shaped field can never leak in either.
      if (typeof (parsed as { event?: unknown }).event === 'string') continue;
      const r = parsed as Partial<CaptureMetricRow>;
      if (typeof r.ts !== 'string' || typeof r.openMs !== 'number') continue;
      if (
        r.renderStatus !== 'confirmed' &&
        r.renderStatus !== 'unconfirmed' &&
        r.renderStatus !== 'failed'
      )
        continue;
      rows.push({
        ts: r.ts,
        platform: r.platform === 'ios' ? 'ios' : 'android',
        specId: typeof r.specId === 'string' ? r.specId : undefined,
        openMs: r.openMs,
        snapshotMs: typeof r.snapshotMs === 'number' ? r.snapshotMs : undefined,
        screenshotMs: typeof r.screenshotMs === 'number' ? r.screenshotMs : undefined,
        renderStatus: r.renderStatus,
        openCallCount: typeof r.openCallCount === 'number' ? r.openCallCount : 0,
        // Absent on every row written before the events stream was consumed —
        // which is exactly why they are optional and why nothing above reads
        // them as a default.
        snapshotDeviceMs: typeof r.snapshotDeviceMs === 'number' ? r.snapshotDeviceMs : undefined,
        screenshotDeviceMs:
          typeof r.screenshotDeviceMs === 'number' ? r.screenshotDeviceMs : undefined,
        // Same additive contract as the two device-side durations above: absent
        // on every row written before `--cost` existed, and never defaulted to
        // 0 (which would claim a free capture).
        deviceCostMs: typeof r.deviceCostMs === 'number' ? r.deviceCostMs : undefined,
        deviceCostSamples:
          typeof r.deviceCostSamples === 'number' ? r.deviceCostSamples : undefined,
      });
    } catch {
      /* drop the bad line, keep the good ones */
    }
  }
  return rows;
}

/* -------------------------------------------------------------------------- */
/* summarize                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Nearest-rank percentile (no interpolation), so `p95` of a small sample is a
 * value that was actually MEASURED rather than one synthesized between two
 * observations. Empty input → undefined (never 0: "no data" and "instant" are
 * different claims, and conflating them is how a decay check false-fires).
 */
export function percentile(values: number[], p: number): number | undefined {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

/** How many opening captures of a session form its baseline. */
export const BASELINE_CAPTURES = 10;

export interface SessionHealth {
  /** Captures in the session being summarized. */
  count: number;
  /** p95 snapshot time across the whole session. */
  p95SnapshotMs?: number;
  /** p95 snapshot time over the session's OPENING captures — the "fresh" baseline. */
  openingP95SnapshotMs?: number;
  /** p95 snapshot time over the session's most RECENT captures — compared against the baseline. */
  recentP95SnapshotMs?: number;
  /** Length of the trailing run of renders that were NOT confirmed. */
  consecutiveUnconfirmed: number;
  /** `openCallCount` on the newest row — how hard this session has been driven. */
  openCallCount: number;
  /** ISO timestamp of the newest row in the session. */
  lastCaptureTs?: string;
  /** ISO timestamp of the OLDEST row still in scope — the epoch's first capture. */
  firstCaptureTs?: string;
  /**
   * The epoch cutoff that was applied, when one was (see
   * {@link SummarizeOptions.epochStartMs}). Present so a caller can SAY that
   * rows were excluded — "this session is 4 minutes old" is the sentence that
   * makes a suppressed decay diagnosis legible instead of merely absent.
   */
  epochStartMs?: number;
}

export interface SummarizeOptions {
  /** Summarize every row instead of only the trailing session. */
  allSessions?: boolean;
  /**
   * Epoch-milliseconds floor: rows captured BEFORE this are dropped outright.
   *
   * The session split ({@link splitSessions}) already isolates a stretch of
   * driving from the previous one, but it can only see what the log records.
   * An epoch the log cannot know about — the agent-device daemon's
   * `processStartTime`, a device that was cold-booted, an explicit state
   * wipe — has to be supplied. Anything at or after the floor is kept; a
   * non-finite floor is ignored (never an empty summary from a bad clock).
   */
  epochStartMs?: number;
}

/**
 * Split rows into sessions. Rows are assumed append-ordered (they are — one
 * writer, append-only); an out-of-order or unparseable timestamp starts no new
 * session rather than corrupting the split.
 *
 * TWO boundaries, and the second one is the fix for a real misattribution
 * (2026-07-29): a sweep run four minutes after `kill <daemon> && rm -rf
 * ~/.agent-device/{sessions,device-claims}` was diagnosed `session-decay` off
 * rows written BEFORE the reset, and the recommended remedy was the reset that
 * had just been done.
 *
 *  1. An idle gap over {@link SESSION_GAP_MS} — yesterday's sweep is not this
 *     session, and a baseline computed across it is meaningless.
 *  2. An `openCallCount` REGRESSION. That counter lives in the host process
 *     (see {@link noteDeviceOpen}) and starts at zero in a new one, so a value
 *     lower than its predecessor is proof that a DIFFERENT process wrote the
 *     later row — a new CLI/MCP invocation, which in practice is also a fresh
 *     daemon/device epoch. Two sweeps back-to-back inside the gap window are
 *     therefore no longer welded into one "session" whose trailing-unconfirmed
 *     streak spans the reset that was supposed to zero it. Equal counts are NOT
 *     a boundary: a warm bridge re-target performs no `open`, so a healthy
 *     session repeats the same count many times over.
 */
export function splitSessions(rows: CaptureMetricRow[]): CaptureMetricRow[][] {
  const sessions: CaptureMetricRow[][] = [];
  let current: CaptureMetricRow[] = [];
  let prev: number | undefined;
  let prevOpens: number | undefined;
  for (const row of rows) {
    const t = Date.parse(row.ts);
    const idleGap = prev !== undefined && Number.isFinite(t) && t - prev > SESSION_GAP_MS;
    const processRestarted = prevOpens !== undefined && row.openCallCount < prevOpens;
    if ((idleGap || processRestarted) && current.length > 0) {
      sessions.push(current);
      current = [];
    }
    current.push(row);
    if (Number.isFinite(t)) prev = t;
    prevOpens = row.openCallCount;
  }
  if (current.length > 0) sessions.push(current);
  return sessions;
}

/**
 * Summarize the CURRENT session (the trailing stretch of captures with no
 * {@link SESSION_GAP_MS} idle gap and no host-process restart). Pass
 * `{ allSessions: true }` to summarize every row instead, and
 * `{ epochStartMs }` to additionally drop everything written before a known
 * reset (daemon start, device boot) — see {@link SummarizeOptions.epochStartMs}.
 */
export function summarizeSessionHealth(
  rows: CaptureMetricRow[],
  opts: SummarizeOptions = {},
): SessionHealth {
  const floor = Number.isFinite(opts.epochStartMs) ? opts.epochStartMs : undefined;
  const inEpoch =
    floor === undefined
      ? rows
      : rows.filter((r) => {
          const t = Date.parse(r.ts);
          // An unparseable timestamp is KEPT: dropping it would silently shrink
          // the evidence base, and "I could not read this row's clock" is not
          // evidence that it predates the reset.
          return !Number.isFinite(t) || t >= floor;
        });
  const sessions = splitSessions(inEpoch);
  const session = opts.allSessions ? inEpoch : (sessions[sessions.length - 1] ?? []);
  const snapshots = session
    .map((r) => r.snapshotMs)
    .filter((n): n is number => typeof n === 'number');
  const openingRows = session.slice(0, BASELINE_CAPTURES);
  const recentRows = session.slice(-BASELINE_CAPTURES);
  const snapshotsOf = (rs: CaptureMetricRow[]): number[] =>
    rs.map((r) => r.snapshotMs).filter((n): n is number => typeof n === 'number');

  let consecutiveUnconfirmed = 0;
  for (let i = session.length - 1; i >= 0; i -= 1) {
    if (session[i]!.renderStatus === 'confirmed') break;
    consecutiveUnconfirmed += 1;
  }

  return {
    count: session.length,
    p95SnapshotMs: percentile(snapshots, 95),
    openingP95SnapshotMs: percentile(snapshotsOf(openingRows), 95),
    // With fewer than 2*BASELINE captures the opening and recent windows
    // OVERLAP; comparing a window against itself can only understate growth,
    // never invent it, so this stays honest on short sessions.
    recentP95SnapshotMs: percentile(snapshotsOf(recentRows), 95),
    consecutiveUnconfirmed,
    openCallCount: session[session.length - 1]?.openCallCount ?? 0,
    lastCaptureTs: session[session.length - 1]?.ts,
    firstCaptureTs: session[0]?.ts,
    epochStartMs: floor,
  };
}

/** Captures needed before a p95 slowdown is worth mentioning at all. */
export const WARN_MIN_CAPTURES = 20;
/** p95 snapshot time (ms) above which a session is called slow. */
export const WARN_P95_MS = 2_000;

/**
 * One line for the human when snapshots have gone slow — the leading indicator
 * of the session-age decay (agent-device prints its own version of this, first
 * observed on 0.20.1: "android snapshots are slow in this run: p95 2934ms over
 * 209 captures"; the wording is upstream's and not parsed here). Only
 * fires with enough samples to mean something; `undefined` otherwise, so a
 * caller can print it unconditionally.
 */
export function sessionHealthWarning(
  input: SessionHealth | CaptureMetricRow[],
): string | undefined {
  const health = Array.isArray(input) ? summarizeSessionHealth(input) : input;
  if (health.count < WARN_MIN_CAPTURES) return undefined;
  const p95 = health.p95SnapshotMs;
  if (p95 === undefined || p95 <= WARN_P95_MS) return undefined;
  const baseline = health.openingP95SnapshotMs;
  const drift =
    baseline !== undefined && baseline > 0 ? ` (opened this session at p95 ${baseline}ms)` : '';
  return (
    `native snapshots are slow in this session: p95 ${p95}ms over ${health.count} captures${drift} ` +
    '— device sessions that slow down like this go on to render unconfirmed; a cold reset restores them'
  );
}
