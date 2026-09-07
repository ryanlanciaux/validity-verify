/**
 * Perf-drift refresh (D1) — the one IO composition point between the per-spec
 * run timeline (run.ts) and the signal queue (scorecard.ts). Lives in its own
 * module because it must import both sides: run.ts already imports
 * scorecard.js, so the pure detector can't reach back into run.ts without a
 * cycle.
 *
 * ADVISORY ONLY: this touches signals.json and nothing else — never
 * scorecard.json, run-meta, verdicts, or signedOff.
 */
import { readSpecRunHistory } from './run.js';
import {
  computePerfDriftSignals,
  loadSignals,
  mergeSignals,
  saveSignals,
  type Signal,
} from './scorecard.js';

/**
 * runs.jsonl rows to read for drift: 2x (window + latest), doubled again
 * because submit_report re-appends a scored twin per runId (deduped by the
 * detector, so raw rows ≈ 2 per run).
 */
export const PERF_HISTORY_READ_LIMIT = 24;

/**
 * Read the spec's runs.jsonl tail, compute perf-drift signals from the LATEST
 * entry (whoever produced it — MCP verify, native verify, or a watch tick),
 * persist them into signals.json, and return the fresh signals. Never throws;
 * IO failures return [] (the timeline is a convenience, not a source of truth).
 */
export function refreshPerfDrift(
  projectRoot: string,
  specId: string,
  opts?: { now?: string; sha?: string },
): Signal[] {
  try {
    const history = readSpecRunHistory(projectRoot, specId, PERF_HISTORY_READ_LIMIT);
    const existing = loadSignals(projectRoot);
    const fresh = computePerfDriftSignals({
      specId,
      history,
      existingSignals: existing,
      now: opts?.now ?? new Date().toISOString(),
      sha: opts?.sha,
    });
    if (fresh.length > 0) saveSignals(projectRoot, mergeSignals(existing, fresh));
    return fresh;
  } catch {
    return [];
  }
}
