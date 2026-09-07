/**
 * Thin adapter between F1's Validity Score exports (@validity.ai/verify-spec) and the
 * F2 viewers (`validity trends`). Two jobs:
 *
 * - the CURRENT repo score for the trends header (full scorecard formula,
 *   freshness included — exactly what the dashboard shows);
 * - a PER-RUN score for timeline points, computed over a run's persisted
 *   criteria snapshot. The snapshot carries tier+status only (no
 *   severity/threshold/staleness), so every criterion is treated as blocking
 *   and fresh — the renderer labels the line "freshness not applied".
 *
 * ADVISORY ONLY: outputs feed HTML charts, never a verdict, signedOff, or an
 * exit code. Unknown statuses earn zero credit (computeSpecScore's
 * explicit-pass-only discipline), so a fabricated status can't chart green.
 */
import {
  computeSpecScore,
  computeValidityScore,
  VALIDITY_SCORE_FORMULA,
  type Scorecard,
  type ScoreCriterionInput,
} from '@validity.ai/verify-spec';

/** Repo-level score + published formula for the trends header; undefined when unmeasured. */
export function currentValidityScore(
  scorecard: Scorecard | null,
): { score: number; formula: string } | undefined {
  const computed = computeValidityScore(scorecard);
  if (!computed) return undefined;
  return { score: computed.score, formula: VALIDITY_SCORE_FORMULA };
}

/**
 * Score of one timeline row's criteria snapshot ("at run time"). Statuses come
 * from deserialized JSONL and are passed through as-is — `computeSpecScore`
 * credits only an exact `'pass'`. Undefined when the row carries no criteria.
 */
export function runScoreOf(
  criteria: Array<{ tier: ScoreCriterionInput['tier']; status: string }> | undefined,
): number | undefined {
  if (!criteria || criteria.length === 0) return undefined;
  const inputs: ScoreCriterionInput[] = criteria.map((c) => ({
    tier: c.tier,
    status: c.status as ScoreCriterionInput['status'],
  }));
  return computeSpecScore(inputs).score ?? undefined;
}
