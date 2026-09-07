/**
 * Soft-score citation gate — the single source of truth for the pre-validation
 * that every soft `pass` must clear before it can reach the scorecard.
 *
 * A soft `pass` is what flips a spec's sign-off, so it can never be accepted on
 * an agent's (or a model's) word alone: it MUST cite real, non-empty screenshot
 * evidence from the spec's latest verify run. This module extracts that gate so
 * BOTH scoring entry points run identical rules:
 *
 *   - `validity__record_soft_scores` (MCP; the host-agent / fresh-context loop)
 *   - `validity judge` (the automated LLM judge)
 *
 * Neither may be a back door around the other. `applySoftScores` (scorecard.ts)
 * layers the remaining gates on top of whatever this accepts — soft-only,
 * unknown-id rejection, and the evidence-taint clamp — so a `pass` that clears
 * the citation floor here can still be withheld there.
 *
 * Pure: takes a run-meta + the spec's targets + the set of soft criterion ids,
 * returns the accepted scores plus an audited reject/warning list. No I/O.
 */
import { citableScreenshotIds } from './judge-pack.js';
import type { RunMeta } from './run.js';
import type { SoftScore } from './scorecard.js';
import { componentBaseKey } from './specs.js';

/**
 * The rubric version lives in the leaf module `rubric-version.ts` — keeping it
 * here made `specs.ts` (which stamps it at freeze) and this module import each
 * other. Re-exported so existing import sites are unaffected.
 */
export { RUBRIC_VERSION, rubricDriftWarning, specRubricVersion } from './rubric-version.js';

/** One incoming score, exactly as an agent or the judge model submits it. */
export interface SoftScoreInput {
  id: string;
  status: 'pass' | 'fail' | 'unverifiable';
  reasoning?: string;
  suggestion?: string;
  /** Optional normalized score [0,1]; enforced against a `softThreshold` downstream. */
  score?: number;
  /** Screenshot render ids this verdict rests on. REQUIRED for a soft `pass`. */
  screenshotIds?: string[];
}

/**
 * Derived, run-scoped context the gate checks each score against. Built once
 * per record/judge call from the spec's latest verify run + its declared
 * targets. Everything here comes from Validity-authored run-meta, never from
 * the submitter's ids — so a typo or forgery can't satisfy the floor.
 */
export interface SoftScoreGateContext {
  /** Real, citable render ids (errored / cost-skipped renders excluded). */
  validScreenshotIds: Set<string>;
  /** Citable ids whose PNG rendered blank — fine for fail/unverifiable, never a pass. */
  emptyScreenshotIds: Set<string>;
  /** Component render id → its source file path (for the cross-component warning). */
  renderComponentPathById: Map<string, string>;
  /** Criterion ids that are soft (only a soft `pass` is citation-gated). */
  softCriterionIds: Set<string>;
  /** Base keys of the spec's declared target components (cross-component warning). */
  targetKeys: Set<string>;
  /** The spec's declared target components (for the warning text). */
  targetComponents: string[];
  /** Hint appended to reject messages listing a few valid ids. */
  validIdHint: string;
  /** Hint appended to reject messages listing a few non-empty (pass-citable) ids. */
  passIdHint: string;
}

/**
 * Build the gate context from the spec's latest verify run-meta + its targets.
 * `meta` may be null (no run yet) — then no id is citable and every soft `pass`
 * is rejected for want of evidence, which is exactly right.
 */
export function buildSoftScoreGateContext(args: {
  meta: RunMeta | null | undefined;
  /** The spec's declared target components (best-effort; [] when unknown). */
  targetComponents: string[];
  /** Ids of the criteria that are soft (a mechanical id is decided elsewhere). */
  softCriterionIds: Set<string>;
}): SoftScoreGateContext {
  const { meta, targetComponents, softCriterionIds } = args;
  // Derived from the shared primitive so the ids an agent is SHOWN and the ids
  // it may CITE can never drift — including the `<id>::pre` companions.
  const validScreenshotIds = meta ? citableScreenshotIds(meta) : new Set<string>();
  // A `::pre` companion is judged by ITS OWN blank-PNG measurement
  // (`preInteractionLooksEmpty`), never by its post-interaction sibling's —
  // the two frames routinely disagree.
  const emptyScreenshotIds = new Set<string>();
  const renderComponentPathById = new Map<string, string>();
  for (const c of meta?.components ?? []) {
    if (!c.renderError && !c.screenshotSkipped) {
      if (c.looksEmpty) emptyScreenshotIds.add(c.id);
      if (c.preInteractionLooksEmpty) emptyScreenshotIds.add(`${c.id}::pre`);
      if (c.filePath) {
        renderComponentPathById.set(c.id, c.filePath);
        // The companion answers to the same component file, so the
        // cross-component relevance warning covers a `::pre` citation too.
        if (c.preInteractionScreenshotPath) {
          renderComponentPathById.set(`${c.id}::pre`, c.filePath);
        }
      }
    }
  }
  const validIdHint =
    validScreenshotIds.size > 0
      ? `valid ids: ${[...validScreenshotIds].slice(0, 8).join(', ')}`
      : "this spec's latest run produced no citable screenshots — run validity__verify first";
  const passCitableIds = [...validScreenshotIds].filter((id) => !emptyScreenshotIds.has(id));
  const passIdHint =
    passCitableIds.length > 0
      ? `non-empty ids: ${passCitableIds.slice(0, 8).join(', ')}`
      : 'this run produced no NON-EMPTY screenshots — re-verify to capture real pixels';
  const targetKeys = new Set(targetComponents.map(componentBaseKey));
  return {
    validScreenshotIds,
    emptyScreenshotIds,
    renderComponentPathById,
    softCriterionIds,
    targetKeys,
    targetComponents,
    validIdHint,
    passIdHint,
  };
}

export interface SoftScoreGateResult {
  /** Scores that cleared the citation floor, shaped for `applySoftScores`. */
  accepted: SoftScore[];
  /** Scores rejected before the scorecard merge, each with a printable reason. */
  preRejected: Array<{ id: string; reason: string }>;
  /** Advisory notes (a soft pass cites only renders outside the spec's targets). */
  citationWarnings: string[];
}

/**
 * Run the citation gate over a batch of incoming scores. A soft `pass` must
 * carry a valid, non-empty screenshot citation; every score must carry
 * reasoning. `fail`/`unverifiable` don't inflate the trust surface, so they
 * only need reasoning. Cross-component citations are advisory (surfaced, never
 * rejected). The accepted list preserves submission order; the caller hands it
 * to `applySoftScores`, which applies the remaining (soft-only / unknown-id /
 * taint) gates.
 */
export function gateSoftScores(
  scores: SoftScoreInput[],
  ctx: SoftScoreGateContext,
): SoftScoreGateResult {
  const accepted: SoftScore[] = [];
  const preRejected: Array<{ id: string; reason: string }> = [];
  const citationWarnings: string[] = [];

  for (const s of scores) {
    const reasoning = s.reasoning?.trim();
    if (!reasoning) {
      preRejected.push({ id: s.id, reason: 'missing reasoning — quote screenshot evidence' });
      continue;
    }
    // A soft `pass` is what flips sign-off, so it MUST cite real screenshot
    // evidence from the latest run. fail/unverifiable only need reasoning.
    if (s.status === 'pass' && ctx.softCriterionIds.has(s.id)) {
      const cited = s.screenshotIds ?? [];
      if (cited.length === 0) {
        preRejected.push({
          id: s.id,
          reason: `pass missing screenshotIds — cite the render id(s) you scored from (${ctx.validIdHint})`,
        });
        continue;
      }
      const invalid = cited.filter((id) => !ctx.validScreenshotIds.has(id));
      if (invalid.length > 0) {
        preRejected.push({
          id: s.id,
          reason: `screenshotIds reference unknown render id(s): ${invalid.join(', ')} (${ctx.validIdHint})`,
        });
        continue;
      }
      // RELEVANCE: a pass needs at least one NON-EMPTY citation. A blank-PNG
      // render is fine for fail/unverifiable but proves no pass.
      const nonEmptyCited = cited.filter((id) => !ctx.emptyScreenshotIds.has(id));
      if (nonEmptyCited.length === 0) {
        preRejected.push({
          id: s.id,
          reason:
            `pass sourced only from empty (blank) render(s): ${cited.join(', ')} — the ` +
            `screenshot shows no visible content. Cite a non-empty render, or score ` +
            `fail/unverifiable (${ctx.passIdHint})`,
        });
        continue;
      }
      // Cross-component (advisory): pass cites only renders of components NOT in
      // the spec's targets. Only when targets are declared and the cited ids
      // resolve to known component renders (pages/unknown ids are out of scope).
      if (ctx.targetKeys.size > 0) {
        const componentCited = cited.filter((id) => ctx.renderComponentPathById.has(id));
        if (
          componentCited.length > 0 &&
          !componentCited.some((id) =>
            ctx.targetKeys.has(componentBaseKey(ctx.renderComponentPathById.get(id)!)),
          )
        ) {
          citationWarnings.push(
            `${s.id}: soft pass cites render(s) of a component outside this spec's targets ` +
              `(${ctx.targetComponents.join(', ')}) — confirm the screenshot is of the component under test.`,
          );
        }
      }
    }
    accepted.push({ id: s.id, status: s.status, detail: reasoning.slice(0, 400), score: s.score });
  }

  return { accepted, preRejected, citationWarnings };
}
