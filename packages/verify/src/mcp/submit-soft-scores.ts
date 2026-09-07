/**
 * Soft scores on submit (B3) — closing the last hole in the "one-off verify
 * writes through" story.
 *
 * `validity__submit_report` has always written the agent's soft scores back
 * into RUN-META (so the report and the per-spec timeline read pass/fail
 * instead of the verify-time `unverifiable` placeholders) but never into the
 * SCORECARD — that was `validity__record_soft_scores`' job alone. An agent
 * that ran verify → submit_report and stopped therefore left the durable
 * standing state carrying `unscored` soft rows and an open `needs-scoring`
 * signal for criteria it had, in fact, just scored.
 *
 * This module folds those same judgments into the scorecard through the
 * EXACT path record_soft_scores uses — `buildSoftScoreGateContext` +
 * `gateSoftScores` (the shared citation floor) then `applySoftScores` (the
 * targeted soft merge). Two consequences that are the whole point:
 *
 *   - an uncited / unreasoned pass is rejected here exactly as it is there;
 *     it can NEVER become an `unscored`-with-pass row;
 *   - `applySoftScores` replaces per criterion, so a later record_soft_scores
 *     for the same run is idempotent — it cannot double-open a signal.
 *
 * Deliberately NOT routed through `reconcileScorecard`: the reducer carries
 * soft rows forward as `unscored` (Rule 1), which would erase the very scores
 * being submitted.
 */
import {
  appendSignalHistory,
  applySoftScores,
  buildSoftScoreGateContext,
  collectGitInfo,
  diffSignalTransitions,
  gateSoftScores,
  loadScorecard,
  loadSignals,
  mergeSignals,
  saveScorecard,
  saveSignals,
  signalTransitionRows,
  type CriterionVerdict,
  type RunMeta,
  type SoftScoreInput,
  type Spec,
} from '@validity.ai/verify-spec';

/** One submitted criterion row, in the shape `submit_report` receives it. */
export interface SubmittedCriterion {
  id?: string;
  description: string;
  status: 'pass' | 'fail' | 'unverifiable';
  reasoning: string;
  suggestion?: string;
  screenshotIds?: string[];
}

export interface SubmitSoftScoreOutcome {
  /** Criterion ids whose scorecard soft row this submit updated. */
  applied: string[];
  /** Judgments the gate or the merge refused, each with a printable reason. */
  rejected: Array<{ criterionId: string; reason: string }>;
  /** Advisory cross-component citation notes (never a rejection). */
  citationWarnings: string[];
  /** Signal kinds this fold opened / closed (e.g. a `needs-scoring` close). */
  signalsOpened: Array<{ kind: string; specId: string; criterionId?: string }>;
  signalsResolved: Array<{ kind: string; specId: string; criterionId?: string }>;
}

const EMPTY: SubmitSoftScoreOutcome = {
  applied: [],
  rejected: [],
  citationWarnings: [],
  signalsOpened: [],
  signalsResolved: [],
};

/**
 * Fold the submitted judgments' SOFT rows into the scorecard.
 *
 * No-ops (returns an empty outcome) when the spec isn't frozen, has no
 * scorecard entry yet, or nothing soft was submitted — a submit_report on an
 * un-ticked spec must not conjure an entry out of agent-supplied statuses;
 * the deterministic tick owns entry creation.
 */
export function applySubmittedSoftScores(args: {
  projectRoot: string;
  spec: Spec;
  meta: RunMeta;
  /**
   * The run's PERSISTED verdicts, post taint/dataState clamp. The clamped
   * status is what reaches the scorecard, so a submitted `pass` the run-meta
   * refused can't be laundered in through this path.
   */
  criterionVerdicts?: CriterionVerdict[];
  submitted: SubmittedCriterion[];
  scoredBy?: string;
  sessionFingerprint: string;
  historyCommitted?: boolean;
  now?: string;
}): SubmitSoftScoreOutcome {
  const { projectRoot, spec, meta } = args;
  if (spec.status !== 'frozen') return EMPTY;
  const scorecard = loadScorecard(projectRoot);
  const entry = scorecard?.specs[spec.id];
  if (!scorecard || !entry) return EMPTY;

  const softCriterionIds = new Set(
    Object.entries(entry.criteria)
      .filter(([, c]) => c.tier === 'soft')
      .map(([id]) => id),
  );
  if (softCriterionIds.size === 0) return EMPTY;

  // Resolve each submission to a canonical spec-criterion id the same way the
  // run-meta writeback does (id when it resolves, else description text), so
  // the two can never disagree about which criterion was scored.
  const persistedById = new Map((args.criterionVerdicts ?? []).map((v) => [v.id, v]));
  const inputs: SoftScoreInput[] = [];
  for (const c of args.submitted) {
    const id =
      (c.id && spec.criteria.some((cc) => cc.id === c.id) ? c.id : undefined) ??
      spec.criteria.find((cc) => cc.text === c.description)?.id;
    if (!id || !softCriterionIds.has(id)) continue;
    inputs.push({
      id,
      status: persistedById.get(id)?.status ?? c.status,
      reasoning: c.reasoning,
      suggestion: c.suggestion,
      ...(c.screenshotIds ? { screenshotIds: c.screenshotIds } : {}),
    });
  }
  if (inputs.length === 0) return EMPTY;

  // THE SHARED GATE — identical rules to record_soft_scores and `validity
  // judge`. Context comes from run-meta, never from the submitted ids.
  const gateCtx = buildSoftScoreGateContext({
    meta,
    targetComponents: spec.targets?.components ?? [],
    softCriterionIds,
  });
  const { accepted, preRejected, citationWarnings } = gateSoftScores(inputs, gateCtx);
  if (accepted.length === 0) {
    return {
      ...EMPTY,
      rejected: preRejected.map((r) => ({ criterionId: r.id, reason: r.reason })),
      citationWarnings,
    };
  }

  // The score judges THIS run's evidence, so it carries THIS run's capture sha
  // (same precedence rule as record_soft_scores) — a later commit then reads
  // the score as stale rather than fresh.
  const sha = meta.git?.sha ?? collectGitInfo(projectRoot)?.sha;
  const now = args.now ?? new Date().toISOString();
  let result;
  try {
    result = applySoftScores({ prev: scorecard, specId: spec.id, scores: accepted, now, sha });
  } catch (err) {
    return {
      ...EMPTY,
      rejected: [
        ...preRejected.map((r) => ({ criterionId: r.id, reason: r.reason })),
        ...accepted.map((s) => ({ criterionId: s.id, reason: (err as Error).message })),
      ],
      citationWarnings,
    };
  }

  // Provenance, stamped exactly as record_soft_scores does: the session
  // fingerprint always, the self-reported model when the host supplied one.
  const applied = result.scorecard.specs[spec.id]!;
  for (const id of result.applied) {
    const crit = applied.criteria[id];
    if (!crit) continue;
    crit.scoredBySession = args.sessionFingerprint;
    if (args.scoredBy) crit.scoredBy = args.scoredBy;
  }

  saveScorecard(projectRoot, result.scorecard);
  const existingSignals = loadSignals(projectRoot);
  const merged = mergeSignals(existingSignals, result.signals);
  saveSignals(projectRoot, merged);
  const { opened, resolved } = diffSignalTransitions(existingSignals, merged);
  if (args.historyCommitted) {
    appendSignalHistory(projectRoot, signalTransitionRows(opened, resolved, now, sha));
  }

  const project = (s: { kind: string; specId: string; criterionId?: string }) => ({
    kind: s.kind,
    specId: s.specId,
    ...(s.criterionId ? { criterionId: s.criterionId } : {}),
  });
  return {
    applied: result.applied,
    rejected: [
      ...preRejected.map((r) => ({ criterionId: r.id, reason: r.reason })),
      ...result.rejected.map((r) => ({ criterionId: r.id, reason: r.reason })),
    ],
    citationWarnings,
    signalsOpened: opened.map(project),
    signalsResolved: resolved.map(project),
  };
}
