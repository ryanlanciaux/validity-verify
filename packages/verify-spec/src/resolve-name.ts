/**
 * Casual-name → catalog-entry resolver. Powers "show me my Button" /
 * "open the login form" so the agent (or CLI) can turn a loose human name
 * into a concrete path without guessing.
 *
 * Deterministic scoring ladder, highest first:
 *   1000  exact path match (project-relative)
 *    900  exact basename match (case-insensitive), e.g. "button" → Button.tsx
 *    800  exact route-path match (screens)
 *    600  basename starts with the query
 *    400  basename contains the query (or query contains basename)
 *    300  path contains the query
 *    150  subsequence ("lgnfrm" → LoginForm) — fuzzy floor
 *
 * Critically, it NEVER silently picks on a tie: when the top two matches
 * score within `AMBIGUITY_MARGIN` and point at different paths, `ambiguous`
 * is true and `best` is left undefined. Callers must surface the candidate
 * list and ask — honoring the CLAUDE.md "don't infer ambiguous targets" rule.
 */
import type { Catalog, CatalogEntry, CatalogKind } from './catalog.js';

export interface ResolveMatch {
  path: string;
  name: string;
  kind: CatalogKind;
  routePath?: string;
  score: number;
}

export interface ResolveResult {
  query: string;
  /** All scoring matches, highest first. */
  matches: ResolveMatch[];
  /** Set when there's a single confident winner. Undefined on a tie or no match. */
  best?: ResolveMatch;
  /** True when the top matches are too close to choose between. */
  ambiguous: boolean;
}

const AMBIGUITY_MARGIN = 80;

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '');
}

/** Does `needle` appear in `hay` as an in-order subsequence? */
function isSubsequence(needle: string, hay: string): boolean {
  if (!needle) return false;
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

function scoreEntry(entry: CatalogEntry, rawQuery: string): number {
  const q = norm(rawQuery);
  const path = entry.path.toLowerCase();
  const name = norm(entry.name);
  const route = entry.routePath?.toLowerCase();

  if (entry.path === rawQuery) return 1000;
  if (path === rawQuery.toLowerCase()) return 1000;
  if (name === q && q.length > 0) return 900;
  if (route && route === rawQuery.toLowerCase()) return 800;
  if (q.length > 0 && name.startsWith(q)) return 600;
  if (q.length > 0 && (name.includes(q) || (q.includes(name) && name.length >= 3))) return 400;
  if (q.length > 0 && path.includes(rawQuery.toLowerCase())) return 300;
  if (q.length >= 2 && isSubsequence(q, name)) return 150;
  return 0;
}

/**
 * Resolve a query against a catalog. Components are preferred over screens
 * over views on an exact score tie of the SAME path-kind only as a stable
 * sort tiebreak — it does not mask genuine cross-entry ambiguity.
 */
export function resolveName(query: string, catalog: Catalog): ResolveResult {
  const trimmed = query.trim();
  const scored: ResolveMatch[] = [];
  for (const entry of catalog.entries) {
    const score = scoreEntry(entry, trimmed);
    if (score <= 0) continue;
    scored.push({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      routePath: entry.routePath,
      score,
    });
  }

  // Sort by score desc, then a stable kind preference, then path for determinism.
  const kindRank: Record<CatalogKind, number> = { component: 0, screen: 1, view: 2 };
  scored.sort(
    (a, b) =>
      b.score - a.score || kindRank[a.kind] - kindRank[b.kind] || a.path.localeCompare(b.path),
  );

  if (scored.length === 0) {
    return { query: trimmed, matches: [], ambiguous: false };
  }

  const [top, second] = scored;
  // Ambiguous when the runner-up is within the margin AND a different path.
  const ambiguous = Boolean(
    second && second.path !== top!.path && top!.score - second.score < AMBIGUITY_MARGIN,
  );

  return {
    query: trimmed,
    matches: scored,
    best: ambiguous ? undefined : top,
    ambiguous,
  };
}
