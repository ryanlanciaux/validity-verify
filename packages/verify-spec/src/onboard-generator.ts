/**
 * Deterministic candidate-criteria generator for bulk onboarding (Phase C).
 *
 * Onboarding can't write acceptance criteria with an LLM — Validity has none.
 * What it CAN do deterministically is mint a small, safe starter spec per
 * renderable target: "renders clean", "no serious a11y violations", "each
 * literal-union variant renders", and (for screens) "navigation edges land".
 *
 * HARD RULES the whole module is built around:
 *
 *   1. Purposive cap. At most FOUR normative (hard + property) criteria AND at
 *      most FOUR criteria total, emitted in a fixed priority order so the cap
 *      chops the lowest-value ones first (the appended advisory soft is dropped
 *      before any mechanical criterion). This cap IS the point of the phase:
 *      bulk onboarding must not spam a 200-component repo with 10-criterion
 *      specs.
 *   2. The generator is incapable of manufacturing blocking red. Mechanical
 *      (hard/property) criteria may default to blocking (the spec schema's
 *      default), but every SOFT criterion this module emits carries
 *      `severity: 'advisory'` — a wrong starter spec can't gate sign-off
 *      through judgment criteria before a human confirms it.
 *   3. Pure + deterministic. No Date / Math.random / fs / network. Identical
 *      input → deep-equal output. Criterion ids are AC-1..AC-n in the fixed
 *      priority order, so the same target always produces the same spec text
 *      (and therefore the same frozen hash once probation clears).
 */
import type { CatalogEntry } from './catalog.js';
import type { ResolvedNavigationEdge } from './navigation.js';
import { specCriterionSchema, type SpecCriterion } from './spec-schema.js';

/** Max normative (hard + property) criteria the generator will ever emit. */
export const MAX_NORMATIVE_CRITERIA = 4;

/**
 * Strict cap on the TOTAL number of criteria per component (normative +
 * advisory). The advisory soft is appended last and is the lowest-priority
 * criterion, so when a target already carries the full
 * {@link MAX_NORMATIVE_CRITERIA} mechanical criteria the advisory is the honest
 * chop — keeping every generated starter spec at ≤4 criteria/component.
 */
export const MAX_TOTAL_CRITERIA = 4;

export interface GenerateCandidateCriteriaInput {
  entry: CatalogEntry;
  navigation: ResolvedNavigationEdge[];
  /** Configured scenario names (e.g. ['logged-in', 'logged-out']). */
  scenarioNames: string[];
}

/**
 * Generate the deterministic starter criteria for one catalog entry.
 *
 * Pure: given equal input the output is deep-equal, criterion ids are
 * `AC-1..AC-n` in fixed priority order, at most
 * {@link MAX_NORMATIVE_CRITERIA} normative (hard/property) criteria are
 * emitted, and never more than {@link MAX_TOTAL_CRITERIA} criteria total. A
 * single advisory soft criterion is appended after the normative criteria —
 * except when they already fill the total cap, in which case the advisory
 * (lowest priority, appended last) is dropped so the total stays ≤4. render-clean
 * (AC-1) is always emitted, so a generated spec is never empty.
 */
export function generateCandidateCriteria(input: GenerateCandidateCriteriaInput): SpecCriterion[] {
  const scenarioList = input.scenarioNames.filter((n) => n.length > 0);
  const scenariosClause =
    scenarioList.length > 0 ? `, under each configured scenario: ${scenarioList.join(', ')}` : '';

  const criteria: SpecCriterion[] = [];

  // (1) render-clean — always first, always emitted.
  criteria.push({
    id: 'AC-1',
    text: `renders without console errors${scenariosClause}`,
    tier: 'hard',
    checks: [{ expect: { console: { errors: 0 } } }],
  });

  // (2) a11y-names — interactive elements have accessible names.
  criteria.push({
    id: 'AC-2',
    text: `interactive elements have accessible names (no serious+ axe violations)${scenariosClause}`,
    tier: 'hard',
    checks: [{ expect: { a11y: { severity: 'serious', maxViolations: 0 } } }],
  });

  // (3) variants — ONE criterion for the first literal-union prop (2–8 quoted
  // string literals), enumerating every variant value. Never one-per-variant.
  //
  // SOFT, not hard: the mechanical tier renders only the DEFAULT props, so it
  // cannot actually exercise each variant. Emitting a hard `console.errors: 0`
  // check here (as this once did) just re-ran AC-1's default-render check while
  // the text claimed per-variant coverage — a vacuous duplicate whose verdict
  // always equalled AC-1's, inflating confidence. As a soft (agent-scored)
  // criterion it honestly asks the judge to confirm each variant from
  // screenshots. Advisory (never blocking), matching the bulk-onboarding soft
  // posture.
  const union = findLiteralUnionProp(input.entry);
  if (union) {
    criteria.push({
      id: 'AC-3',
      text: `each ${union.propName} variant (${union.values.join(', ')}) renders correctly`,
      tier: 'soft',
      severity: 'advisory',
      softThreshold: 0.6,
    });
  }

  // (4) nav-edges — screens only, up to 2 resolved edges originating here.
  if (input.entry.kind === 'screen') {
    const destinations = resolveNavDestinations(input.entry.path, input.navigation);
    if (destinations.length > 0) {
      const checks: SpecCriterion['checks'] = [];
      for (const dest of destinations) {
        checks!.push({ navigate: { url: dest } });
      }
      checks!.push({ expect: { console: { errors: 0 } } });
      criteria.push({
        id: 'AC-4',
        text: `navigation reaches ${destinations.join(', ')} without console errors`,
        tier: 'hard',
        checks,
      });
    }
  }

  // Enforce the normative cap. The priority order above already places the
  // lowest-value criteria last, so a slice is the honest chop. (In practice
  // this only fires when a screen has both a literal-union prop AND nav edges
  // — the cap is 4 and the section above produces at most 4.)
  const normative = criteria.filter((c) => c.tier === 'hard' || c.tier === 'property');
  if (normative.length > MAX_NORMATIVE_CRITERIA) {
    const allowed = new Set(normative.slice(0, MAX_NORMATIVE_CRITERIA).map((c) => c.id));
    const trimmed = criteria.filter((c) => allowed.has(c.id));
    criteria.length = 0;
    criteria.push(...renumber(trimmed));
  }

  // Advisory soft criterion — at most ONE, always advisory (never blocking),
  // and only when it fits under the strict total cap. On a target already
  // carrying the full MAX_NORMATIVE_CRITERIA mechanical criteria the advisory
  // is the honest chop (lowest priority, appended last), so the generated spec
  // stays at ≤ MAX_TOTAL_CRITERIA criteria/component. render-clean (AC-1) is
  // always present, so `criteria.length` here is ≥1 and the spec is never empty.
  if (criteria.length > 0 && criteria.length < MAX_TOTAL_CRITERIA) {
    criteria.push({
      id: `AC-${criteria.length + 1}`,
      text: 'layout is visually coherent and content readable at the default viewport',
      tier: 'soft',
      severity: 'advisory',
      softThreshold: 0.6,
    });
  }

  // Validate every emitted criterion against the schema (defensive — the
  // shape is built by hand here and a silent drift would break freeze later).
  for (const c of criteria) {
    specCriterionSchema.parse(c);
  }

  return criteria;
}

/* ------------------------------------------------------------------ *
 * Literal-union prop detection.                                       *
 * ------------------------------------------------------------------ */

interface LiteralUnionProp {
  propName: string;
  values: string[];
}

/**
 * Detect a prop whose `type` string is a literal union of 2–8 QUOTED string
 * literals, e.g. `"primary" | "outline" | "ghost"`. Rejects:
 *   - unions of 1 or >8 members,
 *   - any member that isn't a single- or double-quoted string literal
 *     (numbers, booleans, bare identifiers like `ReactNode`, `string`).
 *
 * Returns the first matching prop in `entry.props` order, or `null`. The
 * "first" choice is deterministic — props preserve their declaration order
 * in `extractPropsType`, so the same target always picks the same prop.
 */
export function findLiteralUnionProp(entry: CatalogEntry): LiteralUnionProp | null {
  const props = entry.props;
  if (!props || props.length === 0) return null;
  for (const p of props) {
    const parsed = parseLiteralUnion(p.type);
    if (parsed) return { propName: p.name, values: parsed };
  }
  return null;
}

/**
 * Parse a prop type string into a list of variant values when it is a union
 * of 2–8 quoted string literals. Returns `null` for anything else.
 *
 * Examples accepted:  `"a" | "b"`  → ['"a"', '"b"']  (values kept verbatim,
 * including the quotes, so the criterion text reads naturally).
 */
export function parseLiteralUnion(typeText: string): string[] | null {
  const text = typeText.trim();
  if (text.length === 0) return null;
  const parts = text.split('|').map((s) => s.trim());
  // 2–8 members.
  if (parts.length < 2 || parts.length > 8) return null;
  const values: string[] = [];
  for (const part of parts) {
    if (!isQuotedStringLiteral(part)) return null;
    values.push(part);
  }
  return values;
}

/** True when `s` is a single- or double-quoted string literal (e.g. `"a"`, `'b'`). */
function isQuotedStringLiteral(s: string): boolean {
  if (s.length < 2) return false;
  const q = s[0];
  if (q !== '"' && q !== "'") return false;
  return s[s.length - 1] === q;
}

/* ------------------------------------------------------------------ *
 * Navigation edges.                                                    *
 * ------------------------------------------------------------------ */

/** Max nav edges a single nav criterion will exercise. */
export const MAX_NAV_EDGES = 2;

/**
 * Collect up to {@link MAX_NAV_EDGES} route strings for edges originating from
 * `entryPath` whose target is resolvable. A `ResolvedNavigationEdge` carries
 * `to` (the verbatim route string) and `toPath` (the resolved target screen
 * path); we require `toPath` present (the edge must have resolved to a real
 * screen) and a non-empty `to` (the route to navigate to). Dedupes routes so
 * two edges to the same destination produce one navigate check.
 */
export function resolveNavDestinations(
  entryPath: string,
  navigation: ResolvedNavigationEdge[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const edge of navigation) {
    if (edge.from !== entryPath) continue;
    if (!edge.toPath || edge.toPath.length === 0) continue;
    const route = edge.to;
    if (!route || route.length === 0) continue;
    if (seen.has(route)) continue;
    seen.add(route);
    out.push(route);
    if (out.length >= MAX_NAV_EDGES) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Helpers.                                                             *
 * ------------------------------------------------------------------ */

/** Renumber a list of criteria AC-1..AC-n in order. */
function renumber(criteria: SpecCriterion[]): SpecCriterion[] {
  return criteria.map((c, i) => ({ ...c, id: `AC-${i + 1}` }));
}
