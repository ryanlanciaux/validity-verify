/**
 * URL-mode honesty (B6).
 *
 * URL mode points Playwright at a page the USER's dev server is serving and
 * takes screenshots. There is no Validity sandbox in the loop, so NO mechanical
 * criterion runs: no element assertion, no network/console capture against a
 * spec, no screenshot/perf check. The mode is genuinely useful (a real page,
 * real data, real routing) and its screenshots are perfectly scoreable by a
 * soft judge — but a hard criterion cannot be decided here, and the run must
 * say so rather than leaving the question blank.
 *
 * A blank is not neutral: with no persisted `criterionVerdicts`, submit_report
 * has nothing to override an agent's submitted `pass` on a hard criterion with,
 * so an unbacked hard pass could reach the report. Stamping every hard/property
 * criterion `unverifiable` with a named reason closes that door — `fail ⊐
 * unverifiable ⊐ pass`, never the other way.
 */
import type { CriterionVerdict, Spec } from './spec-schema.js';

/**
 * The disclosure sentence. ONE string, shared verbatim by the MCP tool text
 * and the HTML report, so the two surfaces can never drift.
 */
export const URL_MODE_DISCLOSURE =
  'URL mode: mechanical criteria (element/network/console/screenshot/perf) were not evaluated — ' +
  'only screenshots were captured. Soft criteria can be scored; hard criteria are unverifiable in this mode.';

/** Per-criterion `detail` on every hard/property verdict a URL run produces. */
export const URL_MODE_UNVERIFIABLE_DETAIL =
  'URL mode: mechanical criteria are not evaluated (no sandbox checks ran)';

/**
 * The criterion verdicts a URL-mode run persists for a spec in scope. Every
 * criterion — hard, property, and soft alike — is `unverifiable`: the hard
 * tiers because nothing mechanical ran, the soft tiers because they are always
 * verify-time placeholders the scoring agent fills in at submit time (the same
 * convention isolation mode uses).
 */
export function urlModeCriterionVerdicts(spec: Spec): CriterionVerdict[] {
  return spec.criteria.map((c) => ({
    id: c.id,
    tier: c.tier,
    status: 'unverifiable' as const,
    detail: URL_MODE_UNVERIFIABLE_DETAIL,
  }));
}
