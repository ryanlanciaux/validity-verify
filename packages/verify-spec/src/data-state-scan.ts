/**
 * Data-state COVERAGE hints (E2.1) — "this component has a loading branch and
 * no criterion covers it".
 *
 * The data-state axis (A2) can force a `loading` / `empty` / `error` render, but
 * nothing tells an author that a branch EXISTS and is going unverified. A spec
 * that only covers the populated path reads green while the error state is
 * whatever the component happens to do — the most common shipped-broken UI
 * there is.
 *
 * This module is the conservative source scanner behind that nudge. It is
 * deliberately NOT a taint and NOT a gate:
 *
 *   - the regexes are shallow (`isLoading`, `?.length`, `<Suspense>`, …) and
 *     WILL produce false positives on prose, unrelated identifiers, and
 *     commented-out code. A false positive costs the reader one informational
 *     line; a false NEGATIVE costs nothing either, because the honest signal
 *     that a branch went unrendered is the `data-state` evidence taint, which
 *     is derived from renders, not from this scan;
 *   - it never reads a verdict and never writes one.
 *
 * Pure — unit-tested on fixture strings.
 */
import type { DataState } from './spec-schema.js';

/** One branch indicator found in a source file. */
export interface DataStateBranchHit {
  /** The data state the indicator implies a branch for. */
  state: DataState;
  /** The matched source fragment (trimmed + capped) — shown to the reader. */
  evidence: string;
}

/**
 * A hint that a detected branch has no criterion covering it. `component` is
 * the render/component id the branch was found in (or under one of its direct
 * imports).
 */
export interface DataStateHint {
  component: string;
  state: DataState;
  evidence: string;
}

/**
 * Branch indicators, per state. Conservative and intentionally boring — each
 * one is an identifier or literal comparison that appears in the branch itself,
 * not a heuristic about what the component "looks like".
 *
 * `populated` has no detector: it is the base render, always covered.
 */
const BRANCH_PATTERNS: Array<{ state: DataState; re: RegExp }> = [
  { state: 'loading', re: /\bisLoading\b|\bisPending\b|\bisFetching\b|\bloading\b|\bSuspense\b/ },
  { state: 'error', re: /\bisError\b|\bErrorBoundary\b|\berror\b/ },
  { state: 'empty', re: /\bisEmpty\b|\.length\s*===\s*0\b|\?\.length\b|\blength\s*===\s*0\b/ },
];

/** Longest evidence fragment we quote back — one line, never a paragraph. */
const MAX_EVIDENCE = 120;

/**
 * Strip the obvious non-code so a comment or a string of prose ("handles the
 * loading case") doesn't mint a hint. Line/block comments only — this is a
 * lexical scrub, not a parse, and it errs toward keeping code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/gm, '$1');
}

/** Trim + collapse a source line into a quotable one-liner. */
function quotable(line: string): string {
  const clean = line.trim().replace(/\s+/g, ' ');
  return clean.length > MAX_EVIDENCE ? `${clean.slice(0, MAX_EVIDENCE - 1)}…` : clean;
}

/**
 * Scan one file's source for data-state branch indicators. At most one hit per
 * state (the first): the point is "there IS a loading branch", not a census.
 */
export function scanDataStateBranches(source: string): DataStateBranchHit[] {
  const lines = stripComments(source).split('\n');
  const out: DataStateBranchHit[] = [];
  for (const { state, re } of BRANCH_PATTERNS) {
    const line = lines.find((l) => re.test(l));
    if (line) out.push({ state, evidence: quotable(line) });
  }
  return out;
}

/**
 * Build the uncovered-branch hints for a set of scanned components.
 *
 * A hint fires when a component (or one of its directly-imported files) shows a
 * branch for state S and NO criterion in the spec is conditioned on S. Covered
 * states are supplied by the caller (the union of every criterion's `dataState`
 * plus the spec's `conditions.dataStates`) so this stays pure.
 */
export function buildDataStateHints(args: {
  /** One entry per target: its id + the sources to scan (own source first). */
  components: Array<{ component: string; sources: string[] }>;
  /** States the spec already covers — a covered state never produces a hint. */
  coveredStates: Iterable<DataState>;
}): DataStateHint[] {
  const covered = new Set(args.coveredStates);
  const hints: DataStateHint[] = [];
  for (const { component, sources } of args.components) {
    const seen = new Set<DataState>();
    for (const source of sources) {
      for (const hit of scanDataStateBranches(source)) {
        if (covered.has(hit.state) || seen.has(hit.state)) continue;
        seen.add(hit.state);
        hints.push({ component, state: hit.state, evidence: hit.evidence });
      }
    }
  }
  return hints;
}

/** The one-line agent-facing rendering of a hint. Shared by every surface. */
export function formatDataStateHint(hint: DataStateHint): string {
  return (
    `ℹ ${hint.component} has a ${hint.state} branch but no criterion covers ` +
    `dataState: ${hint.state} — evidence: ${hint.evidence}`
  );
}
