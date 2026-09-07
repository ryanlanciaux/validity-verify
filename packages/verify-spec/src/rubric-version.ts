/**
 * The soft-scoring rubric version (E2.2).
 *
 * A LEAF module on purpose. This lived in `judge-gate.ts`, which imports from
 * `specs.ts`, while `specs.ts` needs the constant to stamp a freeze — a genuine
 * ESM cycle. It resolved only because the read happened inside a function body
 * rather than at module scope, which is safe today and a TDZ crash the first
 * time someone hoists it. Nothing here imports from anywhere in the package, so
 * the cycle cannot come back. `judge-gate.ts` re-exports these names so
 * existing import sites keep working.
 */

/**
 * Version of the SOFT-SCORING RUBRIC — the instructions a judge (host agent,
 * fresh-context subagent, or `validity judge` model) is told to score against:
 * the citation floor in `judge-gate.ts`, the tier semantics, and the scoring
 * instructions SKILL.md publishes.
 *
 * It exists so a soft score is never an unattributable opinion. Every judgment
 * records the rubric it was produced under (`ScorerProvenance.rubricVersion`,
 * `RunMeta.scoring.rubricVersion`, `CriterionStanding.rubricVersion`), and a
 * frozen spec records the rubric it was baselined under (`Spec.rubric.version`),
 * so "these two soft scores disagree" can be answered with "they were scored
 * under different rubrics" instead of a shrug.
 *
 * DISTINCT from `SCORING_CONTRACT_VERSION` (specs.ts), which is folded into the
 * spec content hash and invalidates verdicts. The rubric version is provenance
 * and a WARNING only: bumping it never re-decides a stored verdict and never
 * perturbs a frozen hash. Bump it when the scoring INSTRUCTIONS change enough
 * that scores either side of the change aren't comparable.
 *
 * SKILL.md publishes the marker line `Rubric version: <n>`; a docs-consistency
 * test pins that copy to this constant.
 */
export const RUBRIC_VERSION = '1';

/**
 * The rubric version a spec was frozen under, or `undefined` when the spec
 * carries no stamp.
 *
 * The absence of a stamp means "frozen before rubric versioning existed", which
 * is NOT the same as "frozen under a different rubric" — we genuinely don't
 * know what it was scored against, and inventing a `'0'` to compare against
 * would manufacture drift out of missing information. Every spec in the field
 * predates this feature, so treating absence as drift would have warned on
 * every verify of every existing spec, forever, about something the author
 * cannot act on. A warning that fires unconditionally is one people learn to
 * scroll past, which costs the real drift warning its meaning.
 *
 * Such specs get a stamp the next time `spec_freeze` rewrites the frozen file.
 */
export function specRubricVersion(spec: { rubric?: { version: string } }): string | undefined {
  return spec.rubric?.version;
}

/**
 * The verify-time rubric-drift warning (E2.2), or undefined when there is
 * nothing to say — the spec was frozen under the current rubric, or it carries
 * no stamp at all (see `specRubricVersion`). Advisory: it never blocks and
 * never touches a verdict.
 */
export function rubricDriftWarning(spec: { rubric?: { version: string } }): string | undefined {
  const frozenUnder = specRubricVersion(spec);
  if (frozenUnder === undefined || frozenUnder === RUBRIC_VERSION) return undefined;
  return (
    `Spec frozen under rubric v${frozenUnder}, current rubric v${RUBRIC_VERSION} — soft scores ` +
    `may not be comparable; re-freeze to re-baseline.`
  );
}
