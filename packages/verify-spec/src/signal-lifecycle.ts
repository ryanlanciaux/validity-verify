/**
 * Signal lifecycle helpers: suppress / manual resolve / reopen-on-code-change,
 * and rebuild of `signals.json` from the transition feed.
 *
 * Pure functions take facts; IO wrappers gather git + spec mapping. Nothing
 * here writes a verdict — it only moves queue rows.
 */
import {
  diffSignalTransitions,
  loadScorecard,
  loadSignals,
  mergeSignals,
  pruneResolvedSignals,
  saveSignals,
  staleSignalReason,
  type Signal,
  type SignalStateContext,
} from './scorecard.js';
import {
  appendSignalHistory,
  readSignalHistory,
  signalTransitionRows,
  type SignalHistoryRow,
} from './history.js';
import { buildReverseImportGraph, expandChangedFiles } from './import-graph.js';
import { gitChangedFilesSince } from './git.js';
import { listSpecs, mapChangedFilesToSpecs } from './specs.js';
import type { Spec } from './spec-schema.js';

const REOPEN_DETAIL = 'reopened: code changed since suppression';

/** Park an open signal until the spec's files change past `sha`. */
export function suppressSignal(
  signal: Signal,
  args: { now: string; sha: string; note?: string },
): Signal {
  return {
    ...signal,
    status: 'suppressed',
    resolvedBy: 'suppress',
    at: args.now,
    detail: args.note ? `${signal.detail} — suppressed: ${args.note}` : signal.detail,
    suppressedUntil: { sha: args.sha, ...(args.note ? { note: args.note } : {}) },
  };
}

/** Manually close an open or suppressed signal. */
export function resolveSignalManual(
  signal: Signal,
  args: { now: string; sha?: string; note?: string },
): Signal {
  return {
    ...signal,
    status: 'resolved',
    resolvedBy: 'manual',
    resolvedAt: args.now,
    at: args.now,
    sha: args.sha ?? signal.sha,
    detail: args.note ? `${signal.detail} — resolved: ${args.note}` : signal.detail,
    suppressedUntil: undefined,
  };
}

/**
 * One suppressed row's next state. Condition-cleared wins (resolves `pass`,
 * never reopens). A spec-relevant code change past the parked sha reopens.
 */
export function applySuppressionLifecycle(
  signal: Signal,
  opts: {
    now: string;
    sha?: string;
    specRelevantChange: boolean;
    conditionCleared: boolean;
    /** Latest claim text from a re-fire, if merge retained it. */
    freshDetail?: string;
  },
): Signal {
  if (signal.status !== 'suppressed') return signal;
  if (opts.conditionCleared) {
    return {
      ...signal,
      status: 'resolved',
      resolvedBy: 'pass',
      resolvedAt: opts.now,
      at: opts.now,
      sha: opts.sha ?? signal.sha,
      detail: `${signal.detail} — resolved: condition cleared while suppressed`,
      suppressedUntil: undefined,
    };
  }
  if (opts.specRelevantChange) {
    const claim = opts.freshDetail ?? signal.detail;
    return {
      ...signal,
      status: 'open',
      resolvedBy: undefined,
      resolvedAt: undefined,
      at: opts.now,
      sha: opts.sha ?? signal.sha,
      detail: `${REOPEN_DETAIL} — ${claim}`,
      suppressedUntil: undefined,
      openedAt: signal.openedAt ?? signal.at,
    };
  }
  return signal;
}

/** True when `changedFiles` (already ripple-expanded) maps onto this spec. */
export function specIsRelevantToChanges(args: {
  specId: string;
  specs: Spec[];
  changedFiles: string[];
}): boolean {
  if (args.changedFiles.length === 0) return false;
  if (args.specId === '*') return true;
  const spec = args.specs.find((s) => s.id === args.specId);
  if (!spec) return true;
  const { matched } = mapChangedFilesToSpecs({
    specs: [spec],
    changedFiles: args.changedFiles,
  });
  return matched.length > 0;
}

function expandFiles(projectRoot: string, files: string[]): string[] {
  if (files.length === 0) return files;
  try {
    const graph = buildReverseImportGraph({ projectRoot });
    return expandChangedFiles(graph, files).files;
  } catch {
    return files;
  }
}

/**
 * Reopen or pass-close every suppressed row against current git + scorecard.
 * Returns a new array; caller persists.
 *
 * Pass-close (`resolvedBy: 'pass'`) only when this call actually observed the
 * signal's spec (`observedSpecIds`) and the claim is gone. A suppress / score
 * record / judge persist is NOT an observation — "no re-fire" must not be
 * read as "condition cleared". Reopen-on-code-change is git-based and
 * independent of the observed set.
 */
export function reconcileSuppressedSignals(args: {
  projectRoot: string;
  signals: Signal[];
  ctx: SignalStateContext;
  now: string;
  sha?: string;
  specs?: Spec[];
  /** Specs this call re-evaluated. Empty ⇒ never pass-close. */
  observedSpecIds?: ReadonlySet<string>;
}): Signal[] {
  const specs = args.specs ?? listSpecs(args.projectRoot);
  const observed = args.observedSpecIds ?? new Set<string>();
  return args.signals.map((s) => {
    if (s.status !== 'suppressed' || !s.suppressedUntil?.sha) return s;
    const range = gitChangedFilesSince(args.projectRoot, s.suppressedUntil.sha);
    const changed = range === null ? [] : expandFiles(args.projectRoot, range);
    const specObserved = observed.has(s.specId);
    return applySuppressionLifecycle(s, {
      now: args.now,
      sha: args.sha,
      specRelevantChange: specIsRelevantToChanges({
        specId: s.specId,
        specs,
        changedFiles: changed,
      }),
      conditionCleared:
        specObserved && staleSignalReason({ ...s, status: 'open' }, args.ctx) !== null,
    });
  });
}

/**
 * Replay a transition feed into a signal set. Pure. Last row per id wins
 * after applying open/resolve/suppress in `at` order; `openedAt` is preserved
 * across reopen chains.
 */
export function replaySignalRows(rows: SignalHistoryRow[]): Signal[] {
  const ordered = [...rows].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  const byId = new Map<string, Signal>();
  for (const row of ordered) {
    const prior = byId.get(row.id);
    const base: Signal = {
      id: row.id,
      kind: row.kind as Signal['kind'],
      severity: row.severity as Signal['severity'],
      specId: row.specId,
      criterionId: row.criterionId,
      detail: row.detail,
      at: row.at,
      sha: row.sha,
      openedAt: prior?.openedAt ?? row.at,
      status: 'open',
    };
    if (row.status === 'open') {
      byId.set(row.id, {
        ...base,
        status: 'open',
        resolvedAt: undefined,
        resolvedBy: undefined,
        suppressedUntil: undefined,
      });
    } else if (row.status === 'suppressed') {
      if (prior && prior.status === 'resolved') continue;
      byId.set(row.id, {
        ...(prior ?? base),
        status: 'suppressed',
        at: row.at,
        sha: row.sha ?? prior?.sha,
        detail: row.detail || prior?.detail || base.detail,
        resolvedBy: 'suppress',
        suppressedUntil: row.suppressedUntil ?? prior?.suppressedUntil,
        resolvedAt: undefined,
      });
    } else {
      // resolved — apply even without a prior so standalone recovered / spec-changed notices rebuild
      byId.set(row.id, {
        ...(prior ?? base),
        status: 'resolved',
        at: row.at,
        sha: row.sha ?? prior?.sha,
        detail: row.detail || prior?.detail || base.detail,
        resolvedAt: row.at,
        resolvedBy: row.resolvedBy ?? prior?.resolvedBy,
        suppressedUntil: undefined,
      });
    }
  }
  return Array.from(byId.values());
}

/**
 * `signals.json` wins per id when its `at` is strictly newer than the last
 * feed row for that id (or the id is absent from the feed).
 */
export function applySnapshotTieBreakers(
  replayed: Signal[],
  snapshot: Signal[],
  lastFeedAtById: Map<string, string>,
): Signal[] {
  const byId = new Map(replayed.map((s) => [s.id, s]));
  for (const s of snapshot) {
    const last = lastFeedAtById.get(s.id);
    if (!last || (s.at ?? '') > last) byId.set(s.id, s);
  }
  return Array.from(byId.values());
}

function lastFeedAtById(rows: SignalHistoryRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const prev = map.get(row.id);
    if (!prev || (row.at ?? '') >= prev) map.set(row.id, row.at);
  }
  return map;
}

export interface RebuildSignalsResult {
  previous: Signal[];
  rebuilt: Signal[];
  opened: number;
  resolved: number;
}

/**
 * Replay `.validity/history/signals.jsonl` (plus a newer-than-feed
 * `signals.json` tie-breaker) into a fresh `signals.json`.
 */
export function rebuildSignalsFromHistory(projectRoot: string): RebuildSignalsResult {
  const previous = loadSignals(projectRoot);
  const rows = readSignalHistory(projectRoot, Number.POSITIVE_INFINITY);
  const replayed = replaySignalRows(rows);
  const rebuilt = pruneResolvedSignals(
    applySnapshotTieBreakers(replayed, previous, lastFeedAtById(rows)),
  );
  saveSignals(projectRoot, rebuilt);
  const prevOpen = new Set(previous.filter((s) => s.status === 'open').map((s) => s.id));
  const nextOpen = new Set(rebuilt.filter((s) => s.status === 'open').map((s) => s.id));
  let opened = 0;
  let resolved = 0;
  for (const id of nextOpen) if (!prevOpen.has(id)) opened += 1;
  for (const id of prevOpen) if (!nextOpen.has(id)) resolved += 1;
  return { previous, rebuilt, opened, resolved };
}

function signalStateContextFromDisk(projectRoot: string): SignalStateContext {
  return {
    scorecard: loadScorecard(projectRoot),
    specs: listSpecs(projectRoot).map((s) => ({
      id: s.id,
      version: s.version,
      criteria: s.criteria.map((c) => ({ id: c.id, tier: c.tier })),
    })),
  };
}

/** Always-on local transition append (historyCommitted only governs gitignore). */
export function persistSignalTransitions(
  projectRoot: string,
  before: Signal[],
  after: Signal[],
  at: string,
  fallbackSha?: string,
  observedSpecIds: ReadonlySet<string> = new Set(),
): Signal[] {
  // Reopen/pass-close parked rows here so MCP fold / record_soft_scores /
  // judge get the same lifecycle as the watch tick (N1) without those
  // callers growing a reconcile step — another slice is editing the fold.
  // Pass-close is gated on `observedSpecIds` (empty here by default): a
  // suppress persist must not read "no re-fire" as "condition cleared".
  const reconciled = after.some((s) => s.status === 'suppressed')
    ? reconcileSuppressedSignals({
        projectRoot,
        signals: after,
        ctx: signalStateContextFromDisk(projectRoot),
        now: at,
        sha: fallbackSha,
        observedSpecIds,
      })
    : after;
  if (reconciled !== after && reconciled.some((s, i) => s !== after[i])) {
    saveSignals(projectRoot, reconciled);
  }
  const { opened, resolved, suppressed } = diffSignalTransitions(before, reconciled);
  appendSignalHistory(
    projectRoot,
    signalTransitionRows(opened, resolved, at, fallbackSha, suppressed),
  );
  return reconciled;
}

/** Merge fresh rows, persist the queue, and append transitions. */
export function commitSignalUpdate(
  projectRoot: string,
  existing: Signal[],
  fresh: Signal[],
  at: string,
  fallbackSha?: string,
): Signal[] {
  const merged = mergeSignals(existing, fresh);
  saveSignals(projectRoot, merged);
  return persistSignalTransitions(projectRoot, existing, merged, at, fallbackSha);
}
