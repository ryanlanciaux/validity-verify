/**
 * Replay-divergence signal refresh — the one IO composition point between the
 * on-device journey lane (`validity replay`, the `.ad` recording, the
 * append-only `replay-divergence.jsonl` evidence ledger) and the signal queue
 * (scorecard.ts).
 *
 * Lives in its own module for the same reason `perf-drift.ts` does: the pure
 * signal builders belong in scorecard.ts, but persisting them needs
 * `history.ts` too — and history.ts already imports scorecard.js, so scorecard
 * cannot reach back without a cycle.
 *
 * WHAT THIS TOUCHES: `signals.json` (the actionable state) and, when the
 * project commits history, `.validity/history/signals.jsonl` (the transition
 * feed the dashboard trend folds). NEVER `scorecard.json`, run-meta, verdicts,
 * or `signedOff` — a journey divergence is drift evidence about a recording,
 * not a criterion verdict, and nothing here may move a gate.
 *
 * The evidence ledger written by the CLI stays exactly as it is: it is the
 * append-only trail of every observation. This module adds the STATE on top of
 * it — and, critically, both of the close paths that keep that state drainable
 * (see the section header in scorecard.ts).
 */
import {
  loadSignals,
  mergeSignals,
  replayDivergenceSignalId,
  replayDivergenceSignals,
  saveSignals,
  supersededReplayDivergenceSignals,
  type Signal,
} from './scorecard.js';
import { persistSignalTransitions } from './signal-lifecycle.js';

/** Persist fresh rows through the ONE signal writer + the transition feed. */
function persist(
  projectRoot: string,
  fresh: Signal[],
  now: string,
  sha: string | undefined,
  _historyCommitted: boolean | undefined,
  existing: Signal[],
): Signal[] {
  const merged = mergeSignals(existing, fresh);
  saveSignals(projectRoot, merged);
  persistSignalTransitions(projectRoot, existing, merged, now, sha);
  return fresh;
}

/**
 * Fold ONE replayed on-device journey into the signal queue.
 *
 *   - `diverged`   → OPEN `replay-divergence:<specId>:<recording>`. Re-running
 *     the same diverged journey updates that one signal in place, so the
 *     dashboard's open count rises by one and stays there — never two rows for
 *     one broken journey.
 *   - `reproduced` → CLOSE it, but only when one is actually open. A green
 *     replay of a journey nobody ever reported diverging writes nothing at all.
 *
 * Callers must NOT invoke this for `unverifiable-now`: a journey that could not
 * be re-executed is not evidence in either direction (the no-launder rule).
 *
 * Never throws — the signal queue is state, and a replay must still print its
 * verdict when the queue cannot be written.
 */
export function recordReplayDivergence(
  projectRoot: string,
  args: {
    specId: string;
    /** Run-dir-relative `.ad` that was replayed. */
    recording: string;
    outcome: 'diverged' | 'reproduced';
    detail: string;
    now?: string;
    sha?: string;
    runId?: string;
    /** `config.historyCommitted` — see {@link historyAllowed}. */
    historyCommitted?: boolean;
  },
): Signal[] {
  try {
    const now = args.now ?? new Date().toISOString();
    const existing = loadSignals(projectRoot);
    // A resolution marker with nothing open is a no-op that `mergeSignals`
    // would drop anyway — short-circuit so a routine green replay never
    // rewrites signals.json (or appends a phantom transition row).
    if (args.outcome === 'reproduced') {
      const id = replayDivergenceSignalId(args.specId, args.recording);
      if (!existing.some((s) => s.id === id && (s.status === 'open' || s.status === 'suppressed')))
        return [];
    }
    const fresh = replayDivergenceSignals({
      specId: args.specId,
      recording: args.recording,
      outcome: args.outcome,
      detail: args.detail,
      now,
      ...(args.sha ? { sha: args.sha } : {}),
      ...(args.runId ? { runId: args.runId } : {}),
    });
    return persist(projectRoot, fresh, now, args.sha, args.historyCommitted, existing);
  } catch {
    return [];
  }
}

/**
 * Close path (b): a fresh verify just published a NEW signed `.ad` for this
 * spec. Every open divergence about an earlier recording of the same spec
 * describes a journey the spec no longer cites, so it closes.
 *
 * Called from `attestRecording` — the moment of publication — and only when the
 * recording is genuinely new (re-signing bytes that were already attested is a
 * republication of the same journey and must resolve nothing).
 *
 * Never throws: signing a run must not fail because the queue could not be
 * updated.
 */
export function supersedeReplayDivergence(
  projectRoot: string,
  args: {
    specId: string;
    /** The newly published recording, run-dir relative. */
    recording: string;
    now?: string;
    sha?: string;
    historyCommitted?: boolean;
  },
): Signal[] {
  try {
    const now = args.now ?? new Date().toISOString();
    const existing = loadSignals(projectRoot);
    const fresh = supersededReplayDivergenceSignals({
      existing,
      specId: args.specId,
      recording: args.recording,
      now,
      ...(args.sha ? { sha: args.sha } : {}),
    });
    if (fresh.length === 0) return [];
    return persist(projectRoot, fresh, now, args.sha, args.historyCommitted, existing);
  } catch {
    return [];
  }
}
