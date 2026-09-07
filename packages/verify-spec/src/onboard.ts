/**
 * Onboard — cold-start spec coverage for an existing React codebase.
 *
 * Validity has no LLM, so onboard can't write the acceptance criteria itself.
 * Instead it produces a WORKLIST: the renderable targets (components/screens)
 * that have no spec yet, paginated so a 1000-component repo never truncates
 * silently. The HOST agent loops over the worklist drafting criteria and calling
 * spec_create/freeze, marking progress as it goes (resumable).
 *
 * This module is the PURE core (coverage diff + pagination + state), unit-tested
 * without the catalog or filesystem. The MCP tools in
 * `mcp-server/src/onboard-tools.ts` wire it to buildCatalog + disk.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validityDir, ensureDir } from './runs.js';
import { writeFileAtomic } from './util.js';
import type { Spec } from './spec-schema.js';

/** A renderable target onboard can suggest a spec for. */
export interface OnboardCandidate {
  /** Project-relative path, e.g. "src/components/ContactForm.tsx". */
  path: string;
  /** Basename without extension, e.g. "ContactForm". */
  name: string;
  kind: 'component' | 'screen' | 'view';
}

export interface OnboardState {
  version: 1;
  updatedAt: string;
  /** Targets the agent created a spec for: path → { specId, at }. */
  done: Record<string, { specId?: string; at: string }>;
  /** Targets the agent chose to skip: path → { reason?, at }. Excluded from the worklist. */
  skipped: Record<string, { reason?: string; at: string }>;
  /**
   * Self-reported 'before' coverage, stamped once at the start of a bulk
   * onboard pass (first-write-wins — see `recordOnboardBaseline`). Absent on
   * legacy state files written before this field existed; `computeOnboardReport`
   * surfaces `before: null` in that case rather than fabricating a number.
   */
  baseline?: { totalUncovered: number; alreadyCovered: number; at: string };
}

/**
 * Collect every (path AND name) a spec already targets, so coverage matching
 * works whether the spec stored a path ("src/.../X.tsx") or a bare name ("X").
 */
export function coveredTargets(specs: Spec[]): Set<string> {
  const covered = new Set<string>();
  const addTarget = (t: string): void => {
    covered.add(t);
    covered.add(t.replace(/^\.\//, ''));
    // Basenames are matched case-INSENSITIVELY (lowercased) to mirror the
    // native verify / props resolvers — a spec targeting "Button" must cover a
    // file "button.tsx". Paths stay case-sensitive (Linux filesystems are).
    covered.add(baseNameNoExt(t).toLowerCase());
  };
  for (const spec of specs) {
    for (const t of spec.targets?.components ?? []) addTarget(t);
    // Views get the SAME normalization as components (a view target may be a
    // name or a path) so view coverage isn't weaker than component coverage.
    for (const v of spec.targets?.views ?? []) addTarget(v);
  }
  return covered;
}

function baseNameNoExt(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.(tsx|jsx|ts|js)$/i, '');
}

/** A candidate is covered when its path OR (case-insensitive) name is covered. */
export function isCovered(candidate: OnboardCandidate, covered: Set<string>): boolean {
  return (
    covered.has(candidate.path) ||
    covered.has(candidate.path.replace(/^\.\//, '')) ||
    covered.has(candidate.name.toLowerCase())
  );
}

export interface EnumerateArgs {
  candidates: OnboardCandidate[];
  specs: Spec[];
  state: OnboardState | null;
  /** Opaque cursor = the last path returned by the previous page. */
  cursor?: string;
  pageSize?: number;
}

export interface EnumerateResult {
  /** This page of uncovered candidates (path-sorted, after the cursor). */
  page: OnboardCandidate[];
  /** Total uncovered across the whole project (not just this page). */
  totalUncovered: number;
  alreadyCovered: number;
  /** Skipped by the agent AND still present in the catalog (excluded from uncovered). */
  skippedCount: number;
  hasMore: boolean;
  /** Pass back as `cursor` to get the next page. Absent when hasMore is false. */
  nextCursor?: string;
  /**
   * True when the supplied cursor sorted past every remaining uncovered item
   * (e.g. the catalog changed between pages) so enumeration RESTARTED from the
   * front of the current remainder. Surfacing this keeps the contract honest —
   * items are never silently skipped; the agent just sees the page reset.
   */
  staleCursor?: boolean;
}

export const ONBOARD_DEFAULT_PAGE = 25;
export const ONBOARD_MAX_PAGE = 100;

/**
 * Pure worklist computation. Filters covered + skipped candidates, sorts by path
 * for a stable cursor, and returns one page. NEVER truncates silently — the
 * totals + hasMore + nextCursor always describe the full remainder.
 */
export function enumerateUncovered(args: EnumerateArgs): EnumerateResult {
  const covered = coveredTargets(args.specs);
  const skipped = args.state?.skipped ?? {};
  const done = args.state?.done ?? {};

  const seen = new Set<string>();
  const present = new Set<string>();
  const uncovered: OnboardCandidate[] = [];
  let alreadyCovered = 0;
  for (const c of args.candidates) {
    if (seen.has(c.path)) continue; // dedupe by path
    seen.add(c.path);
    present.add(c.path);
    if (isCovered(c, covered) || c.path in done) {
      alreadyCovered += 1;
      continue;
    }
    if (c.path in skipped) continue;
    uncovered.push(c);
  }
  uncovered.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const size = Math.min(Math.max(1, args.pageSize ?? ONBOARD_DEFAULT_PAGE), ONBOARD_MAX_PAGE);
  const start = args.cursor ? uncovered.findIndex((c) => c.path > args.cursor!) : 0;
  // A cursor that sorts past every remaining item (start === -1) with work still
  // left means the catalog moved under us — RESTART from the front rather than
  // silently returning an empty "done" page and dropping that work. `uncovered`
  // already excludes done/covered/skipped, so a restart can't re-surface
  // finished targets.
  const staleCursor = start < 0 && Boolean(args.cursor) && uncovered.length > 0;
  const from = start < 0 ? 0 : start;
  const page = uncovered.slice(from, from + size);
  const hasMore = from + size < uncovered.length;

  // Honest skipped count: only skips that still exist in the current catalog
  // (a file deleted after being skipped shouldn't inflate the number).
  const skippedCount = Object.keys(skipped).filter((p) => present.has(p)).length;

  return {
    page,
    totalUncovered: uncovered.length,
    alreadyCovered,
    skippedCount,
    hasMore,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1]!.path : undefined,
    staleCursor: staleCursor || undefined,
  };
}

/* ------------------------------------------------------------------ *
 * State IO.                                                           *
 * ------------------------------------------------------------------ */

export function onboardStatePath(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'onboard-state.json');
}

export function loadOnboardState(projectRoot: string): OnboardState | null {
  const p = onboardStatePath(projectRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as OnboardState;
  } catch {
    return null;
  }
}

function emptyState(now: string): OnboardState {
  return { version: 1, updatedAt: now, done: {}, skipped: {} };
}

/**
 * Record a target as done/skipped.
 *
 * Load-merge-save: re-reads the latest state before mutating so sequential calls
 * compose. The write is ATOMIC (temp file + rename) so a crash or a concurrent
 * reader never sees a torn/partial JSON file. NOTE: this guards against
 * corruption, not cross-PROCESS lost-updates — running two onboard loops against
 * the same project concurrently is unsupported (one process's last write wins).
 * A single agent loop (the intended use) is unaffected: JS is single-threaded
 * and this function does its read-modify-write synchronously with no await.
 */
export function recordOnboardProgress(args: {
  projectRoot: string;
  path: string;
  status: 'done' | 'skipped';
  specId?: string;
  reason?: string;
  now: string;
}): OnboardState {
  const current = loadOnboardState(args.projectRoot) ?? emptyState(args.now);
  if (args.status === 'done') {
    current.done[args.path] = { specId: args.specId, at: args.now };
    delete current.skipped[args.path];
  } else {
    current.skipped[args.path] = { reason: args.reason, at: args.now };
    delete current.done[args.path];
  }
  current.updatedAt = args.now;
  ensureDir(validityDir(args.projectRoot));
  writeFileAtomic(onboardStatePath(args.projectRoot), JSON.stringify(current, null, 2) + '\n');
  return current;
}

/**
 * Stamp the self-reported 'before' coverage for a bulk onboard pass.
 *
 * Load-merge-save exactly like `recordOnboardProgress` (atomic temp + rename,
 * same tmp naming). The `baseline` field is written ONLY when absent —
 * FIRST-WRITE-WINS — so re-running `enumerate` mid-pass (which re-derives
 * coverage against a specs set that has since grown) never moves the 'before'
 * goalposts. A second call with different numbers leaves the first untouched
 * and does not rewrite the file (the prior baseline + prior `updatedAt` stand).
 *
 * Same crash/corruption guarantees as `recordOnboardProgress`: the write is
 * atomic for readers; cross-PROCESS lost-updates are still unsupported (one
 * process's last write wins); a single agent loop is single-threaded and
 * unaffected.
 */
export function recordOnboardBaseline(args: {
  projectRoot: string;
  totalUncovered: number;
  alreadyCovered: number;
  now: string;
}): OnboardState {
  const current = loadOnboardState(args.projectRoot) ?? emptyState(args.now);
  if (current.baseline) return current; // first-write-wins: leave the 'before' as-is
  current.baseline = {
    totalUncovered: args.totalUncovered,
    alreadyCovered: args.alreadyCovered,
    at: args.now,
  };
  current.updatedAt = args.now;
  ensureDir(validityDir(args.projectRoot));
  writeFileAtomic(onboardStatePath(args.projectRoot), JSON.stringify(current, null, 2) + '\n');
  return current;
}

/* ------------------------------------------------------------------ *
 * Report — self-reported before/after coverage.                       *
 * ------------------------------------------------------------------ */

export interface OnboardReport {
  /** 'Before' coverage snapshot, from `state.baseline`. null when no baseline
   *  was ever stamped (an honest unknown — never fabricated). */
  before: { covered: number; total: number; pct: number } | null;
  /** 'After' coverage, derived from the current candidates + specs + state. */
  after: { covered: number; total: number; pct: number };
  /** Every target marked done: path → { specId?, at }, in insertion order. */
  created: Array<{ path: string; specId?: string; at: string }>;
  /** COMPLETE skipped list (never truncated — see the module header's no-silent-caps
   *  posture). path → { reason?, at }, in insertion order. */
  skipped: Array<{ path: string; reason?: string; at: string }>;
  /** Uncovered candidates remaining after this pass. */
  remainingUncovered: number;
}

function pctOf(covered: number, total: number): number {
  if (total <= 0) return 0;
  // One decimal place — a 7/9 split reads as 77.8, not 77.77778.
  return Math.round((covered / total) * 1000) / 10;
}

/**
 * Pure report builder. Reuses `enumerateUncovered`/`coveredTargets` internals
 * for the 'after' math:
 *   - after.covered  = alreadyCovered INCLUDING done targets (enumerate's
 *                      `alreadyCovered` already counts `state.done` entries
 *                      alongside spec-coverage matches).
 *   - after.total    = deduped candidate count = alreadyCovered + totalUncovered
 *                      + skippedCount (the three disjoint buckets enumerate
 *                      partitions unique candidate paths into).
 *   - before         = derived from `state.baseline` (null when absent — an
 *                      honest unknown, never fabricated).
 *   - created        = state.done, in insertion order.
 *   - skipped        = state.skipped, COMPLETE and in insertion order.
 *   - remainingUncovered = enumerate's totalUncovered.
 *
 * No filesystem, no MCP, no LLM — unit-testable from a synthetic fixture.
 */
export function computeOnboardReport(args: {
  candidates: OnboardCandidate[];
  specs: Spec[];
  state: OnboardState | null;
}): OnboardReport {
  const enumResult = enumerateUncovered({
    candidates: args.candidates,
    specs: args.specs,
    state: args.state,
    pageSize: ONBOARD_MAX_PAGE,
  });
  const afterCovered = enumResult.alreadyCovered;
  const afterTotal =
    enumResult.alreadyCovered + enumResult.totalUncovered + enumResult.skippedCount;
  const after = { covered: afterCovered, total: afterTotal, pct: pctOf(afterCovered, afterTotal) };

  const baseline = args.state?.baseline;
  const before = baseline
    ? {
        covered: baseline.alreadyCovered,
        total: baseline.alreadyCovered + baseline.totalUncovered,
        pct: pctOf(baseline.alreadyCovered, baseline.alreadyCovered + baseline.totalUncovered),
      }
    : null;

  const created: Array<{ path: string; specId?: string; at: string }> = [];
  if (args.state) {
    for (const [path, v] of Object.entries(args.state.done)) {
      created.push({ path, specId: v.specId, at: v.at });
    }
  }
  const skipped: Array<{ path: string; reason?: string; at: string }> = [];
  if (args.state) {
    for (const [path, v] of Object.entries(args.state.skipped)) {
      skipped.push({ path, reason: v.reason, at: v.at });
    }
  }

  return { before, after, created, skipped, remainingUncovered: enumResult.totalUncovered };
}

/**
 * Pure per-spec tier counts. `advisorySoft` is the subset of `soft` criteria
 * that declared `severity: 'advisory'` (may fail without blocking sign-off —
 * used by the bulk-onboard generator for judgment-flavored criteria). For
 * per-spec breakdowns in onboarding reports.
 */
export function countCriteriaByTier(spec: Pick<Spec, 'criteria'>): {
  hard: number;
  property: number;
  soft: number;
  advisorySoft: number;
} {
  let hard = 0;
  let property = 0;
  let soft = 0;
  let advisorySoft = 0;
  for (const c of spec.criteria) {
    if (c.tier === 'hard') hard += 1;
    else if (c.tier === 'property') property += 1;
    else if (c.tier === 'soft') {
      soft += 1;
      if (c.severity === 'advisory') advisorySoft += 1;
    }
  }
  return { hard, property, soft, advisorySoft };
}
