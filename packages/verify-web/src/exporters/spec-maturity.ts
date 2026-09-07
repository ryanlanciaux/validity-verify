/**
 * THE canonical maturity wiring — `assessMaturity` (pure, @validity.ai/verify-spec) fed
 * with the spec's durable evidence: its scorecard entry (statuses, evidence
 * taints, soft-score staleness, clean streak). Every surface that shows a
 * maturity level (CLI `spec ls`/`show`, dashboard, watch tick, MCP verify
 * fold) MUST derive it through this function so they can never disagree.
 *
 * Certification reads ONLY what Validity itself proves. Export health lives
 * in the separate optional portability badge — `assessSpecPortability`
 * (spec-portability.ts) — and never touches the level derived here.
 *
 * Evidence sourcing: callers inside a fold (verify, watch tick) pass the
 * FRESHLY-RECONCILED entry — the scorecard on disk is pre-fold at that point,
 * so loading it would lag the verify being described. Read-only surfaces
 * (spec ls/show, dashboard) omit `entry` and this wiring loads the committed
 * scorecard itself. Pass `null` to assert "known absent" (skips the disk
 * read).
 */
import {
  assessMaturity,
  loadScorecard,
  type MaturityAssessment,
  type ScorecardSpec,
  type Spec,
  type ValidityConfig,
} from '@validity.ai/verify-spec';

/**
 * Derive a spec's maturity from its durable evidence rooted at `projectRoot`.
 *
 * `config` is currently unused (certification no longer reads export config)
 * but kept in the signature: every call site already threads it, and future
 * knobs (e.g. a configurable stability threshold) belong here.
 */
export function assessSpecMaturity(
  projectRoot: string,
  spec: Spec,
  _config?: ValidityConfig,
  entry?: ScorecardSpec | null,
): MaturityAssessment {
  const evidence =
    entry !== undefined ? (entry ?? undefined) : loadScorecard(projectRoot)?.specs[spec.id];
  return assessMaturity(spec, { entry: evidence });
}
