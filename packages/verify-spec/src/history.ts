/**
 * Opt-in COMMITTED run history (F2) — compact per-spec run summaries under
 * `.validity/history/<specId>.jsonl`. Unlike `specs/<id>/runs.jsonl` (which is
 * gitignored per-machine noise), this directory is tracked by default, so a
 * team's timeline travels with the repo and merges across machines.
 *
 * Posture (§9.4): every write here is gated by `config.historyCommitted ===
 * true` — callers check the knob; nothing in this module reads config. Rows
 * are copies of already-gated verdicts (NO images, NO source, NO diff, NO
 * prompt text) and NOTHING reads them back into the scorecard, `signedOff`,
 * verify, or submit_report — this is a display-only sink for `validity trends`
 * / `validity compare`.
 *
 * Merge story: append-only files + a `history/*.jsonl merge=union`
 * gitattribute (shared with F1's score.jsonl via `ensureHistoryMergeUnion`).
 * Readers dedupe by runId (last occurrence wins — submit_report's post-scoring
 * re-append supersedes the verify-time placeholder row) and skip malformed
 * lines including unresolved git conflict markers, so a bad merge degrades to
 * "some rows missing", never a crash and never a fabricated status.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureDir, validityDir } from './runs.js';
import { ensureHistoryMergeUnion, type SignalResolvedBy } from './scorecard.js';
import type { CriterionTier } from './spec-schema.js';
import type { PerformanceMetrics } from './types.js';
import { slugify } from './util.js';

/** One compact, committable summary of a spec run. NO images, NO source, NO diff. */
export interface HistoryRunRow {
  /** Row-format version for forward evolution. */
  v: 1;
  specId: string;
  runId: string;
  /** ISO, from RunMeta.createdAt. */
  createdAt: string;
  specVersion?: number;
  specHash?: string;
  verdict: 'pass' | 'fail' | 'partial' | 'unknown';
  signedOff?: boolean;
  counts: { pass: number; fail: number; unverifiable: number };
  /**
   * Per-criterion snapshot, copied VERBATIM from the run's criterionVerdicts.
   * Statuses are never widened or coerced — an unknown string in a hand-edited
   * row round-trips as-is and every consumer renders non-'pass' as non-green.
   */
  criteria?: Array<{ id: string; tier: CriterionTier; status: 'pass' | 'fail' | 'unverifiable' }>;
  /** Git HEAD sha at verify time (RunMeta.git.sha), when known. */
  sha?: string;
  /** Validity Score at run time (F1), when cheaply available. 0–100. */
  score?: number;
  /** Per-render perf metrics mirrored from SpecRunSummary.perf (D1), when present. */
  perf?: Record<string, PerformanceMetrics>;
  /**
   * Run provenance mirrored from SpecRunSummary.origin (`'local'` | `'ci'`),
   * copied verbatim when present. Absent on legacy rows. DISPLAY-ONLY.
   */
  origin?: 'local' | 'ci';
}

export function historyDir(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'history');
}

/**
 * A spec id is already path-safe by schema (`/^spec-[A-Za-z0-9_-]+$/`), but a
 * hand-edited config/spec id must not traverse out of `.validity/history/` —
 * slugify collapses separators/dots to a safe basename.
 */
function historyBasename(specId: string): string {
  return slugify(specId) || 'spec';
}

export function historyPathFor(projectRoot: string, specId: string): string {
  return resolve(historyDir(projectRoot), `${historyBasename(specId)}.jsonl`);
}

/**
 * Append one row; also ensures `.validity/.gitattributes` contains
 * `history/*.jsonl merge=union`. Never throws (best-effort, same posture as
 * `indexRunForSpec`'s try/catch — history is derived, never a source of truth).
 *
 * Callers MUST gate on `config.historyCommitted === true` (§9.4).
 */
export function appendHistoryRow(projectRoot: string, row: HistoryRunRow): void {
  try {
    ensureDir(historyDir(projectRoot));
    ensureHistoryMergeUnion(projectRoot);
    appendFileSync(historyPathFor(projectRoot, row.specId), JSON.stringify(row) + '\n');
  } catch {
    // Non-fatal — the committed timeline is a convenience, not a gate input.
  }
}

/** An unresolved-merge artifact line (`<<<<<<<`/`=======`/`>>>>>>>`/diff3 `|||||||`). */
function isConflictMarker(line: string): boolean {
  return (
    line.startsWith('<<<<<<<') ||
    line.startsWith('=======') ||
    line.startsWith('>>>>>>>') ||
    line.startsWith('|||||||')
  );
}

/**
 * Read a spec's committed rows: dedupe (runId-keyed, LAST occurrence in file
 * order wins) then sort ascending by `createdAt` (ties broken by runId), newest
 * last, capped at `limit`. Tolerant: missing file ⇒ [], malformed lines and
 * git conflict markers skipped.
 */
export function readHistoryRows(projectRoot: string, specId: string, limit = 200): HistoryRunRow[] {
  const path = historyPathFor(projectRoot, specId);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !isConflictMarker(l));
    // Slice raw lines BEFORE parsing (the readSpecRunHistory pattern) — 2× the
    // cap because a runId legitimately appears twice (verify + submit_report).
    const byRunId = new Map<string, HistoryRunRow>();
    for (const line of lines.slice(-limit * 2)) {
      let row: HistoryRunRow;
      try {
        row = JSON.parse(line) as HistoryRunRow;
      } catch {
        continue;
      }
      if (typeof row?.runId !== 'string' || row.runId.length === 0) continue;
      byRunId.set(row.runId, row); // last occurrence wins
    }
    return [...byRunId.values()]
      .sort(
        (a, b) =>
          (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.runId.localeCompare(b.runId),
      )
      .slice(-limit);
  } catch {
    return [];
  }
}

/**
 * Spec ids that have a committed history file — lets `validity trends` chart
 * specs whose local `specs/<id>/` dir was pruned on this machine. Names come
 * from filenames (already sanitized at write time); F1's `score.jsonl` (repo
 * score feed) and the signal-transition feed `signals.jsonl` are not specs
 * and are excluded.
 */
export function listHistorySpecIds(projectRoot: string): string[] {
  const dir = historyDir(projectRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(
        (name) => name.endsWith('.jsonl') && name !== 'score.jsonl' && name !== 'signals.jsonl',
      )
      .map((name) => name.slice(0, -'.jsonl'.length))
      .sort();
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Signal-transition feed — `.validity/history/signals.jsonl`.         *
 *                                                                     *
 * The durable, TEAM-VISIBLE drift ledger (signals-system-design.md    *
 * pillar 4): while `signals.json` is derived per-machine state, this  *
 * feed records each signal's open/re-open/resolve TRANSITIONS as      *
 * append-only committed rows, transported by the user's own git.      *
 * Always appended locally so the open-set is rebuildable;               *
 * `historyCommitted` only governs whether the file is meant to be       *
 * committed (gitignore when the knob is off). Display-only for          *
 * verdicts (nothing reads it back into signedOff). NO screenshots /     *
 * source / diff.                                                        *
 * ------------------------------------------------------------------ */

/** One signal transition. Kind/severity are copied strings, not re-derived. */
export interface SignalHistoryRow {
  v: 1;
  /** ISO timestamp of the transition. */
  at: string;
  /** Git HEAD sha at the tick that produced it, when known. */
  sha?: string;
  /** The signal's stable id (`kind:specId:criterionId|*`). */
  id: string;
  kind: string;
  severity: string;
  specId: string;
  criterionId?: string;
  status: 'open' | 'resolved' | 'suppressed';
  detail: string;
  /** Add-only close-path, copied from the signal when present. */
  resolvedBy?: SignalResolvedBy;
  /** Add-only; present on suppress transitions. */
  suppressedUntil?: { sha: string; note?: string };
}

export function signalHistoryPath(projectRoot: string): string {
  return resolve(historyDir(projectRoot), 'signals.jsonl');
}

/**
 * Build ledger rows from a `diffSignalTransitions` result. Shared by every
 * writer (watch tick, MCP verify fold, record_soft_scores) so the durable drift
 * feed reflects transitions no matter which surface produced them — an
 * MCP-originated open/resolve that skipped this used to be lost from the ledger
 * forever (the next tick sees it as already-open, so no transition re-fires).
 * `fallbackSha` stamps rows whose signal carries no sha of its own.
 */
type TransitionSignal = {
  id: string;
  kind: string;
  severity: string;
  specId: string;
  criterionId?: string;
  detail: string;
  sha?: string;
  resolvedBy?: SignalResolvedBy;
  suppressedUntil?: { sha: string; note?: string };
};

export function signalTransitionRows(
  opened: TransitionSignal[],
  resolved: TransitionSignal[],
  at: string,
  fallbackSha?: string,
  suppressed: TransitionSignal[] = [],
): SignalHistoryRow[] {
  const toRow = (
    s: TransitionSignal,
    status: 'open' | 'resolved' | 'suppressed',
  ): SignalHistoryRow => ({
    v: 1,
    at,
    sha: s.sha ?? fallbackSha,
    id: s.id,
    kind: s.kind,
    severity: s.severity,
    specId: s.specId,
    criterionId: s.criterionId,
    status,
    detail: s.detail,
    ...(s.resolvedBy ? { resolvedBy: s.resolvedBy } : {}),
    ...(s.suppressedUntil ? { suppressedUntil: s.suppressedUntil } : {}),
  });
  return [
    ...opened.map((s) => toRow(s, 'open')),
    ...resolved.map((s) => toRow(s, 'resolved')),
    ...suppressed.map((s) => toRow(s, 'suppressed')),
  ];
}

/**
 * Append transition rows (best-effort, never throws). Always called — the
 * local feed is the rebuild source of truth. `historyCommitted` only decides
 * whether the file is gitignored. Pass TRANSITIONS only (see
 * `diffSignalTransitions`) — steady-state re-fires don't belong in the feed.
 */
export function appendSignalHistory(projectRoot: string, rows: SignalHistoryRow[]): void {
  if (rows.length === 0) return;
  try {
    ensureDir(historyDir(projectRoot));
    ensureHistoryMergeUnion(projectRoot);
    appendFileSync(
      signalHistoryPath(projectRoot),
      rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
  } catch {
    // Non-fatal — the committed ledger is a convenience, not a gate input.
  }
}

/**
 * Read the feed, oldest first, capped at `limit` (most recent kept). The
 * usual tolerances: missing file ⇒ [], malformed lines and unresolved git
 * conflict markers skipped. Rows are events (not entities) so there is no
 * dedupe — one signal legitimately appears once per transition.
 */
export function readSignalHistory(projectRoot: string, limit = 500): SignalHistoryRow[] {
  const path = signalHistoryPath(projectRoot);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !isConflictMarker(l));
    const rows: SignalHistoryRow[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        const row = JSON.parse(line) as SignalHistoryRow;
        if (
          typeof row?.id === 'string' &&
          (row.status === 'open' || row.status === 'resolved' || row.status === 'suppressed')
        ) {
          rows.push(row);
        }
      } catch {
        continue;
      }
    }
    return rows.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  } catch {
    return [];
  }
}
