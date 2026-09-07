/**
 * Readers for the SIDECAR evidence files a run dir can accumulate after the
 * renders are done: `replay-divergence.json` (a later `validity replay` found
 * the recorded journey no longer holds) and the device-evidence bundles
 * (`device-evidence.json` from verify, `replay-device-evidence.json` from a
 * `--keep-session` replay).
 *
 * Distinct from `report-evidence.ts`, which builds the PER-CRITERION evidence
 * map out of run-meta. This module reads files that sit BESIDE run-meta, are
 * written by different commands at different times, and back no verdict at all.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SHAPES ARE RE-DECLARED HERE
 * ---------------------------------------------------------------------------
 * The producers live in `@validity.ai/verify` (`commands/replay.ts`) and
 * `@validity.ai/verify-native` (`perf-evidence.ts` / `network-evidence.ts`). The sandbox
 * depends on neither, and it must not: the report renderer sits UNDER the CLI
 * in the dependency graph, and importing upward to borrow a type would invert
 * it. So these are hand-written twins of a wire format, exactly the posture
 * `@validity.ai/verify-spec`'s `app-manifest.ts` takes toward `@validity.ai/verify-plugin-vite`'s
 * schema — and for the same reason: the writer and the reader are free to skew
 * by a release.
 *
 * Every parser here therefore behaves like a wire-format parser:
 *   - unknown fields are ignored, never rejected;
 *   - a malformed field is dropped while the rest of the record survives;
 *   - nothing throws — an unreadable file degrades to "no evidence", which is
 *     the same thing the report showed before these files existed.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * NOT a verdict input, and structurally incapable of becoming one. Nothing here
 * returns a status, a score, or a boolean a gate could read. A divergence is an
 * observation recorded AFTER the run was signed (the attestation never covered
 * these files); device evidence is captured under an explicit
 * `advisory-evidence-only` posture with no thresholds anywhere in the system.
 * The renderer states both facts on the page so a reader who never opens this
 * file cannot mistake either for proof.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/* ------------------------------------------------------------------ *
 * Wire-format filenames (twins — see the module header).              *
 * ------------------------------------------------------------------ */

/** Written by `validity replay` when the recorded journey diverged. */
export const REPLAY_DIVERGENCE_EVIDENCE_FILE = 'replay-divergence.json';

/** Written at verify time when `native.deviceEvidence` is on. */
export const VERIFY_DEVICE_EVIDENCE_FILE = 'device-evidence.json';

/** Written by a `--keep-session` `validity replay`, post-journey. */
export const REPLAY_DEVICE_EVIDENCE_FILE = 'replay-device-evidence.json';

/* ------------------------------------------------------------------ *
 * Report shapes                                                       *
 * ------------------------------------------------------------------ */

/** One ranked selector suggestion agent-device offered for the failed step. */
export interface ReportDivergenceSuggestion {
  selector: string;
  /** Upstream's ranking key: `id` > `role-label` > `label` > `other`. */
  basis?: string;
  role?: string;
  label?: string;
}

/**
 * The drift a later replay observed, flattened for rendering.
 *
 * `observedAt` comes off the FILE. The renderer never reads a clock — see
 * the determinism rule ("no `Date.now()`, no randomness").
 */
export interface ReportReplayDivergence {
  /** When the replay observed the drift, verbatim from the file. */
  observedAt?: string;
  /** The `.ad` recording that diverged, as the file names it. */
  recording?: string;
  /** 1-based step index the journey diverged on. */
  step?: number;
  /** `action-failure`, `identity-mismatch`, `selector-miss`, … */
  kind?: string;
  /** The recorded action, as upstream labels it. */
  action?: string;
  causeMessage?: string;
  causeCode?: string;
  causeHint?: string;
  /** Upstream's ranking order, preserved. */
  suggestions: ReportDivergenceSuggestion[];
  /** How many suggestions upstream had before ITS cap (may exceed the list). */
  suggestionCount?: number;
  /**
   * `agent-device replay <path> --from <n> --plan-digest <sha>`, rendered
   * exactly as it must be typed. Present only when upstream ALLOWED the resume;
   * a refusal surfaces as `resumeRefusedReason` instead, because printing a
   * command upstream would reject is worse than printing none.
   */
  resumeCommand?: string;
  /** Why upstream refused the resume, when it did. */
  resumeRefusedReason?: string;
  /** Advisory repair procedure upstream suggested. Never acted on. */
  repairHint?: string;
  /** Set when the landed screen could not be read (⇒ no suggestions). */
  screenUnavailableReason?: string;
}

/** One captured — or explicitly un-captured — device evidence record. */
export interface ReportDeviceEvidenceRecord {
  /** `perf-metrics` | `perf-frames` | `network-dump` | a future family. */
  kind: string;
  status: 'captured' | 'unavailable';
  /** The exact command line, as run. Reproducible by hand. */
  command?: string;
  /** ISO capture timestamp, verbatim from the file. */
  capturedAt?: string;
  platform?: string;
  device?: string;
  /** The payload was withheld for size; `note` says how big it was. */
  truncated?: boolean;
  note?: string;
  errorCode?: string;
  /** Upstream's own reason, verbatim. Present iff `status === 'unavailable'`. */
  unavailableReason?: string;
  /**
   * The scoring posture stamped INTO the artifact by its producer
   * (`advisory-evidence-only`). Carried through so the page can quote the
   * file's own words rather than assert the posture on its behalf.
   */
  scoring?: string;
}

/** One evidence bundle, named by the file and the phase that produced it. */
export interface ReportDeviceEvidenceGroup {
  /** Run-dir-relative filename the records came from. */
  file: string;
  /** `verify` = captured during the run; `replay` = captured after it. */
  phase: 'verify' | 'replay';
  records: ReportDeviceEvidenceRecord[];
}

/** Everything the run dir's sidecars contribute to a report. */
export interface ReportRunEvidence {
  replayDivergence?: ReportReplayDivergence;
  /**
   * Bundles in a FIXED order — verify-time before replay-time, which is both
   * chronological and deterministic. Never a directory listing (whose order is
   * filesystem-dependent and would break byte-identical output).
   */
  deviceEvidence?: ReportDeviceEvidenceGroup[];
}

/* ------------------------------------------------------------------ *
 * Tolerant field coercion                                             *
 * ------------------------------------------------------------------ */

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Read + JSON-parse a run-dir sidecar. Undefined on absence or any failure. */
function readJson(dir: string, file: string): Record<string, unknown> | undefined {
  try {
    return rec(JSON.parse(readFileSync(resolve(dir, file), 'utf-8')));
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Divergence                                                          *
 * ------------------------------------------------------------------ */

/**
 * Flatten a persisted `replay-divergence.json` for the renderer. PURE —
 * exported so the mapping is testable from a fixture object without a run dir.
 *
 * The resume handle is assembled HERE, from the file's own `recording` path and
 * upstream's `from`/`planDigest`, so the page can print a command a reader can
 * copy. Both halves are required (upstream rejects `--from` without
 * `--plan-digest` before taking any action) and `allowed` must be true, so a
 * half-report or a refused resume never becomes a command we tell someone to
 * run.
 */
export function toReportDivergence(payload: unknown): ReportReplayDivergence | undefined {
  const root = rec(payload);
  const d = rec(root?.divergence);
  if (!d) return undefined;

  const cause = rec(d.cause);
  const resume = rec(d.resume);
  const screen = rec(d.screen);
  const recording = str(root?.recording);

  const suggestions: ReportDivergenceSuggestion[] = [];
  if (Array.isArray(d.suggestions)) {
    for (const raw of d.suggestions) {
      const s = rec(raw);
      const selector = s ? str(s.selector) : undefined;
      if (!selector) continue;
      suggestions.push({
        selector,
        ...(s && str(s.basis) ? { basis: str(s.basis) } : {}),
        ...(s && str(s.role) ? { role: str(s.role) } : {}),
        ...(s && str(s.label) ? { label: str(s.label) } : {}),
      });
    }
  }

  const from = num(resume?.from);
  const planDigest = str(resume?.planDigest);
  const resumeAllowed = resume?.allowed === true;
  const resumeCommand =
    resumeAllowed && recording && from !== undefined && planDigest
      ? `agent-device replay ${recording} --from ${from} --plan-digest ${planDigest}`
      : undefined;

  return {
    ...(str(root?.observedAt) ? { observedAt: str(root?.observedAt) } : {}),
    ...(recording ? { recording } : {}),
    ...(num(d.step) === undefined ? {} : { step: num(d.step) }),
    ...(str(d.kind) ? { kind: str(d.kind) } : {}),
    ...(str(d.action) ? { action: str(d.action) } : {}),
    ...(str(cause?.message) ? { causeMessage: str(cause?.message) } : {}),
    ...(str(cause?.code) ? { causeCode: str(cause?.code) } : {}),
    ...(str(cause?.hint) ? { causeHint: str(cause?.hint) } : {}),
    suggestions,
    ...(num(d.suggestionCount) === undefined ? {} : { suggestionCount: num(d.suggestionCount) }),
    ...(resumeCommand ? { resumeCommand } : {}),
    // A refusal is a real answer and is surfaced instead of the command.
    ...(!resumeAllowed && str(resume?.reason) ? { resumeRefusedReason: str(resume?.reason) } : {}),
    ...(str(d.repairHint) ? { repairHint: str(d.repairHint) } : {}),
    ...(screen?.state === 'unavailable'
      ? { screenUnavailableReason: str(screen.reason) ?? 'the screen could not be read' }
      : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Device evidence                                                     *
 * ------------------------------------------------------------------ */

/**
 * Flatten a persisted device-evidence bundle (`{ schema, records: [...] }`).
 * PURE. Record ORDER is preserved exactly as written — the producers emit a
 * deterministic sequence (metrics, frames, network), and re-sorting here would
 * make the rendered bytes depend on this module's opinion instead of the file's.
 */
export function toReportDeviceEvidence(payload: unknown): ReportDeviceEvidenceRecord[] {
  const root = rec(payload);
  if (!Array.isArray(root?.records)) return [];
  const out: ReportDeviceEvidenceRecord[] = [];
  for (const raw of root.records) {
    const r = rec(raw);
    const kind = r ? str(r.kind) : undefined;
    if (!r || !kind) continue;
    out.push({
      kind,
      // Anything that is not the exact string `captured` is `unavailable`. A
      // status this reader does not recognise must never read as a successful
      // capture — the never-false-green rule applied to a wire format.
      status: r.status === 'captured' ? 'captured' : 'unavailable',
      ...(str(r.command) ? { command: str(r.command) } : {}),
      ...(str(r.capturedAt) ? { capturedAt: str(r.capturedAt) } : {}),
      ...(str(r.platform) ? { platform: str(r.platform) } : {}),
      ...(str(r.device) ? { device: str(r.device) } : {}),
      ...(r.truncated === true ? { truncated: true } : {}),
      ...(str(r.note) ? { note: str(r.note) } : {}),
      ...(str(r.errorCode) ? { errorCode: str(r.errorCode) } : {}),
      ...(str(r.unavailableReason) ? { unavailableReason: str(r.unavailableReason) } : {}),
      ...(str(r.scoring) ? { scoring: str(r.scoring) } : {}),
    });
  }
  return out;
}

/**
 * Bundle order. FIXED, not discovered: verify-time evidence was captured during
 * the run, replay evidence after it, so this is chronological — and, unlike a
 * directory listing, identical on every machine.
 */
const DEVICE_EVIDENCE_FILES: ReadonlyArray<{ file: string; phase: 'verify' | 'replay' }> = [
  { file: VERIFY_DEVICE_EVIDENCE_FILE, phase: 'verify' },
  { file: REPLAY_DEVICE_EVIDENCE_FILE, phase: 'replay' },
];

/**
 * Read every sidecar a run dir may hold. BEST-EFFORT throughout: a missing,
 * unreadable, or malformed file contributes nothing and never throws, so a
 * report always renders — with less claimed, never with a failure.
 *
 * Presence-gated by construction: an empty result returns `{}`, so a run with
 * no sidecars leaves `ReportInput` byte-identical to what it was before this
 * module existed.
 */
export function readRunEvidence(runDirPath: string): ReportRunEvidence {
  const out: ReportRunEvidence = {};

  const divergence = toReportDivergence(readRunEvidenceFile(runDirPath));
  if (divergence) out.replayDivergence = divergence;

  const groups: ReportDeviceEvidenceGroup[] = [];
  for (const { file, phase } of DEVICE_EVIDENCE_FILES) {
    const records = toReportDeviceEvidence(readJson(runDirPath, file));
    if (records.length > 0) groups.push({ file, phase, records });
  }
  if (groups.length > 0) out.deviceEvidence = groups;

  return out;
}

/** Split out so the divergence read is as guarded as the bundle reads. */
function readRunEvidenceFile(runDirPath: string): Record<string, unknown> | undefined {
  return readJson(runDirPath, REPLAY_DIVERGENCE_EVIDENCE_FILE);
}
