/**
 * Tests for the onboard worklist core — coverage diff + pagination. The
 * load-bearing invariant: large codebases are NEVER silently truncated — the
 * totals + hasMore + cursor always describe the full remainder, and paging
 * through covers exactly the uncovered set once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  computeOnboardReport,
  countCriteriaByTier,
  coveredTargets,
  enumerateUncovered,
  isCovered,
  loadOnboardState,
  onboardStatePath,
  recordOnboardBaseline,
  type OnboardCandidate,
  type OnboardState,
} from './onboard.js';
import type { Spec } from './spec-schema.js';

function spec(targets: string[]): Spec {
  return {
    id: 'spec-x',
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    targets: { components: targets },
    criteria: [{ id: 'AC-1', text: 't', tier: 'soft' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function criteriaSpec(crit: Spec['criteria']): Spec {
  return {
    id: 'spec-c',
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    criteria: crit,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function cand(path: string): OnboardCandidate {
  const name = (path.split('/').pop() ?? path).replace(/\.(tsx|jsx|ts|js)$/i, '');
  return { path, name, kind: 'component' };
}

describe('coveredTargets / isCovered', () => {
  it('matches a candidate by path OR name (spec stored either form)', () => {
    const byPath = coveredTargets([spec(['src/components/ContactForm.tsx'])]);
    expect(isCovered(cand('src/components/ContactForm.tsx'), byPath)).toBe(true);
    const byName = coveredTargets([spec(['ContactForm'])]);
    expect(isCovered(cand('src/components/ContactForm.tsx'), byName)).toBe(true);
  });

  it('does not match an unrelated candidate', () => {
    const covered = coveredTargets([spec(['Button'])]);
    expect(isCovered(cand('src/components/Modal.tsx'), covered)).toBe(false);
  });
});

describe('enumerateUncovered', () => {
  const candidates = Array.from({ length: 10 }, (_, i) =>
    cand(`src/c/C${String(i).padStart(2, '0')}.tsx`),
  );

  it('excludes covered + skipped, returns uncovered totals', () => {
    const specs = [spec(['src/c/C00.tsx'])];
    const state: OnboardState = {
      version: 1,
      updatedAt: 't',
      done: {},
      skipped: { 'src/c/C01.tsx': { at: 't' } },
    };
    const r = enumerateUncovered({ candidates, specs, state, pageSize: 100 });
    expect(r.alreadyCovered).toBe(1);
    expect(r.skippedCount).toBe(1);
    expect(r.totalUncovered).toBe(8);
    expect(r.page.find((c) => c.path === 'src/c/C00.tsx')).toBeUndefined();
    expect(r.page.find((c) => c.path === 'src/c/C01.tsx')).toBeUndefined();
  });

  it('excludes targets already marked done', () => {
    const state: OnboardState = {
      version: 1,
      updatedAt: 't',
      done: { 'src/c/C00.tsx': { at: 't' } },
      skipped: {},
    };
    const r = enumerateUncovered({ candidates, specs: [], state, pageSize: 100 });
    expect(r.page.find((c) => c.path === 'src/c/C00.tsx')).toBeUndefined();
    expect(r.totalUncovered).toBe(9);
  });

  it('dedupes candidates by path', () => {
    const r = enumerateUncovered({
      candidates: [cand('src/c/A.tsx'), cand('src/c/A.tsx')],
      specs: [],
      state: null,
      pageSize: 100,
    });
    expect(r.totalUncovered).toBe(1);
  });

  it('NEVER truncates silently: paging covers the full set exactly once', () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const r = enumerateUncovered({ candidates, specs: [], state: null, cursor, pageSize: 3 });
      seen.push(...r.page.map((c) => c.path));
      if (!r.hasMore) break;
      cursor = r.nextCursor;
      expect(cursor).toBeDefined();
      if (++guard > 100) throw new Error('pagination did not terminate');
    }
    // every uncovered candidate appears exactly once, in path order, no dupes
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
    expect(seen).toEqual([...seen].sort());
  });

  it('matches coverage case-insensitively by basename', () => {
    // spec targets "Button"; file is lowercase button.tsx → still covered.
    const r = enumerateUncovered({
      candidates: [cand('src/c/button.tsx')],
      specs: [spec(['Button'])],
      state: null,
      pageSize: 100,
    });
    expect(r.totalUncovered).toBe(0);
    expect(r.alreadyCovered).toBe(1);
  });

  it('does not count a skipped target that no longer exists in the catalog', () => {
    const state: OnboardState = {
      version: 1,
      updatedAt: 't',
      done: {},
      skipped: { 'src/c/GHOST.tsx': { at: 't' }, 'src/c/C00.tsx': { at: 't' } },
    };
    const r = enumerateUncovered({ candidates, specs: [], state, pageSize: 100 });
    // GHOST isn't in the catalog → excluded from the count; only C00 is real.
    expect(r.skippedCount).toBe(1);
  });

  it('does NOT silently truncate when a cursor sorts past all remaining work', () => {
    // Cursor is beyond every current path, but work remains (catalog changed).
    const r = enumerateUncovered({
      candidates,
      specs: [],
      state: null,
      cursor: 'zzz~after~everything',
      pageSize: 3,
    });
    expect(r.staleCursor).toBe(true);
    expect(r.page.length).toBe(3); // restarted from the front, not an empty "done" page
    expect(r.totalUncovered).toBe(10);
  });

  it('clamps pageSize to the max', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      cand(`src/c/C${String(i).padStart(3, '0')}.tsx`),
    );
    const r = enumerateUncovered({ candidates: many, specs: [], state: null, pageSize: 9999 });
    expect(r.page.length).toBeLessThanOrEqual(100);
    expect(r.hasMore).toBe(true);
  });
});

describe('recordOnboardBaseline', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-onboard-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes baseline on first call and loads it back', () => {
    const s = recordOnboardBaseline({
      projectRoot: root,
      totalUncovered: 8,
      alreadyCovered: 2,
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(s.baseline).toEqual({
      totalUncovered: 8,
      alreadyCovered: 2,
      at: '2026-01-01T00:00:00.000Z',
    });
    const reloaded = loadOnboardState(root);
    expect(reloaded?.baseline).toEqual({
      totalUncovered: 8,
      alreadyCovered: 2,
      at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('first-write-wins: a second call with different numbers leaves the first', () => {
    recordOnboardBaseline({
      projectRoot: root,
      totalUncovered: 8,
      alreadyCovered: 2,
      now: '2026-01-01T00:00:00.000Z',
    });
    const second = recordOnboardBaseline({
      projectRoot: root,
      totalUncovered: 99,
      alreadyCovered: 1,
      now: '2026-02-02T00:00:00.000Z',
    });
    // The 'before' goalposts don't move — re-running enumerate mid-pass
    // can't rewrite the baseline.
    expect(second.baseline).toEqual({
      totalUncovered: 8,
      alreadyCovered: 2,
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(second.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    const onDisk = JSON.parse(readFileSync(onboardStatePath(root), 'utf-8')) as OnboardState;
    expect(onDisk.baseline?.totalUncovered).toBe(8);
    expect(onDisk.baseline?.alreadyCovered).toBe(2);
  });

  it('tolerates legacy state files written without a baseline field', () => {
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    const legacy: OnboardState = {
      version: 1,
      updatedAt: '2025-12-31T00:00:00.000Z',
      done: { 'src/Legacy.tsx': { at: '2025-12-31T00:00:00.000Z' } },
      skipped: {},
    };
    writeFileSync(onboardStatePath(root), JSON.stringify(legacy, null, 2) + '\n');
    const s = recordOnboardBaseline({
      projectRoot: root,
      totalUncovered: 5,
      alreadyCovered: 1,
      now: '2026-01-01T00:00:00.000Z',
    });
    expect(s.baseline?.totalUncovered).toBe(5);
    expect(s.done).toEqual(legacy.done); // pre-existing progress preserved
  });
});

describe('computeOnboardReport', () => {
  it('after math reuses enumerate internals (covered incl done, total = deduped count)', () => {
    const candidates = [
      cand('src/c/A.tsx'),
      cand('src/c/B.tsx'),
      cand('src/c/C.tsx'),
      cand('src/c/D.tsx'),
      cand('src/c/E.tsx'),
    ];
    const specs = [spec(['src/c/A.tsx'])]; // A covered by a spec
    const state: OnboardState = {
      version: 1,
      updatedAt: 't',
      done: { 'src/c/B.tsx': { specId: 'spec-b', at: 't1' } }, // B done
      skipped: { 'src/c/D.tsx': { reason: 'no spec needed', at: 't2' } }, // D skipped
      baseline: { totalUncovered: 4, alreadyCovered: 1, at: 'b0' }, // before: 1/5
    };
    const r = computeOnboardReport({ candidates, specs, state });
    // A (spec covers) + B (done) → alreadyCovered = 2; D skipped; C + E uncovered.
    expect(r.after.covered).toBe(2);
    expect(r.after.total).toBe(5); // deduped candidate count
    expect(r.remainingUncovered).toBe(2); // C + E
    expect(r.before).toEqual({ covered: 1, total: 5, pct: 20 }); // baseline snapshot, 1/5 = 20.0
  });

  it('rounds pct to one decimal place', () => {
    // 7 covered of 9 → 77.777… → 77.8
    const candidates = Array.from({ length: 9 }, (_, i) => cand(`src/c/C${i}.tsx`));
    const specOne = spec(['src/c/C0.tsx']);
    const state: OnboardState = {
      version: 1,
      updatedAt: 't',
      done: Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`src/c/C${i + 1}.tsx`, { at: 't' }]),
      ),
      skipped: {},
    };
    const r = computeOnboardReport({ candidates, specs: [specOne], state });
    expect(r.after.covered).toBe(7);
    expect(r.after.total).toBe(9);
    expect(r.after.pct).toBe(77.8);
  });

  it('skipped list is COMPLETE and preserves reasons (never truncated)', () => {
    const sk: Record<string, { reason?: string; at: string }> = {};
    for (let i = 0; i < 60; i++)
      sk[`src/c/S${String(i).padStart(2, '0')}.tsx`] = {
        reason: `r${i}`,
        at: `t${i}`,
      };
    const state: OnboardState = {
      version: 1,
      updatedAt: 't',
      done: {},
      skipped: sk,
    };
    const r = computeOnboardReport({ candidates: [], specs: [], state });
    expect(r.skipped).toHaveLength(60); // no cap, even above the page-size max
    expect(r.skipped.find((s) => s.path === 'src/c/S59.tsx')).toEqual({
      path: 'src/c/S59.tsx',
      reason: 'r59',
      at: 't59',
    });
  });

  it('before is null when the state has no baseline (honest unknown)', () => {
    const state: OnboardState = {
      version: 1,
      updatedAt: 't',
      done: {},
      skipped: {},
    };
    const r = computeOnboardReport({ candidates: [], specs: [], state });
    expect(r.before).toBeNull();
    expect(r.after).toEqual({ covered: 0, total: 0, pct: 0 });
    expect(r.created).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.remainingUncovered).toBe(0);
  });
});

describe('countCriteriaByTier', () => {
  it('counts each tier and the advisory-soft subset', () => {
    const s = criteriaSpec([
      { id: 'AC-1', text: 'h', tier: 'hard', checks: [{ navigate: { url: '/' } }] },
      { id: 'AC-2', text: 'p', tier: 'property', checks: [{ expect: { console: { errors: 0 } } }] },
      { id: 'AC-3', text: 's', tier: 'soft' },
      { id: 'AC-4', text: 'sa', tier: 'soft', severity: 'advisory' },
      { id: 'AC-5', text: 'sa2', tier: 'soft', severity: 'advisory' },
      // blocking (default) soft must NOT inflate advisorySoft
      { id: 'AC-6', text: 'sb', tier: 'soft', severity: 'blocking' },
    ]);
    const c = countCriteriaByTier(s);
    expect(c).toEqual({ hard: 1, property: 1, soft: 4, advisorySoft: 2 });
  });

  it('returns zeros for an empty criteria list', () => {
    expect(countCriteriaByTier(criteriaSpec([]))).toEqual({
      hard: 0,
      property: 0,
      soft: 0,
      advisorySoft: 0,
    });
  });
});
