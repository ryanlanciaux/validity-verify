/**
 * Data-state coverage: the informational branch scanner (E2.1) and the
 * DEMOTING `data-state` taint that keeps a branch-conditioned criterion from
 * ever reading green on a branch that never rendered.
 *
 * The two halves are deliberately asymmetric and the tests pin that asymmetry:
 * the scanner may be wrong in either direction (it only ever prints a hint),
 * while the taint may only ever be wrong in the SAFE direction (it can demote
 * a pass, never promote anything).
 */
import { describe, expect, it } from 'vitest';
import {
  buildDataStateHints,
  formatDataStateHint,
  scanDataStateBranches,
} from './data-state-scan.js';
import { applyDataStateCoverageTaints } from './run.js';
import type { CriterionVerdict } from './spec-schema.js';

describe('scanDataStateBranches', () => {
  it('finds a loading branch', () => {
    const hits = scanDataStateBranches('if (isLoading) return <Spinner />;');
    expect(hits.map((h) => h.state)).toContain('loading');
  });

  it('finds an error branch', () => {
    const hits = scanDataStateBranches('if (isError) return <ErrorPanel />;');
    expect(hits.map((h) => h.state)).toContain('error');
  });

  it('finds an empty branch from a zero-length guard', () => {
    const hits = scanDataStateBranches('if (users.length === 0) return <Empty />;');
    expect(hits.map((h) => h.state)).toContain('empty');
  });

  it('finds an empty branch from optional-chained length', () => {
    const hits = scanDataStateBranches('const n = data?.length ?? 0;');
    expect(hits.map((h) => h.state)).toContain('empty');
  });

  it('reads <Suspense> as a loading branch', () => {
    const hits = scanDataStateBranches('<Suspense fallback={<Skeleton />}>{children}</Suspense>');
    expect(hits.map((h) => h.state)).toContain('loading');
  });

  it('finds nothing in a branch-free component', () => {
    expect(scanDataStateBranches('export const Badge = () => <span>ok</span>;')).toEqual([]);
  });

  it('ignores indicators that only appear in comments', () => {
    const source = [
      '// this component has no loading state yet',
      '/* error handling lives in the parent */',
      'export const Badge = () => <span>ok</span>;',
    ].join('\n');
    expect(scanDataStateBranches(source)).toEqual([]);
  });

  it('reports at most one hit per state and quotes the matching line', () => {
    const source = ['if (isLoading) return <A />;', 'if (loading) return <B />;'].join('\n');
    const hits = scanDataStateBranches(source);
    expect(hits.filter((h) => h.state === 'loading')).toHaveLength(1);
    expect(hits[0]!.evidence).toBe('if (isLoading) return <A />;');
  });
});

describe('buildDataStateHints', () => {
  const source = 'if (isLoading) return <Spinner />;\nif (isError) return <Err />;';

  it('fires for an UNCOVERED branch', () => {
    const hints = buildDataStateHints({
      components: [{ component: 'user-list', sources: [source] }],
      coveredStates: [],
    });
    expect(hints.map((h) => h.state).sort()).toEqual(['error', 'loading']);
    expect(hints[0]!.component).toBe('user-list');
  });

  it('does NOT fire for a branch a criterion already covers', () => {
    const hints = buildDataStateHints({
      components: [{ component: 'user-list', sources: [source] }],
      coveredStates: ['loading', 'error'],
    });
    expect(hints).toEqual([]);
  });

  it('scans imported sources too, and dedupes a state across them', () => {
    const hints = buildDataStateHints({
      components: [
        {
          component: 'user-list',
          sources: [
            'export const List = () => null;',
            'const { isLoading } = useUsers();',
            'if (isLoading) {}',
          ],
        },
      ],
      coveredStates: [],
    });
    expect(hints.filter((h) => h.state === 'loading')).toHaveLength(1);
  });

  it('names the state and the fix in the printed line', () => {
    const line = formatDataStateHint({
      component: 'UserList',
      state: 'loading',
      evidence: 'if (isLoading)',
    });
    expect(line).toContain('UserList');
    expect(line).toContain('loading branch');
    expect(line).toContain('dataState: loading');
  });
});

describe('applyDataStateCoverageTaints — CANNOT FALSE-GREEN', () => {
  const criteria = [
    { id: 'AC-1', dataState: 'error' as const },
    { id: 'AC-2', dataState: 'populated' as const },
    { id: 'AC-3' },
  ];
  const verdict = (id: string, status: CriterionVerdict['status']): CriterionVerdict => ({
    id,
    tier: 'hard',
    status,
  });

  it("a dataState:'error' criterion whose forced render never happened is unverifiable + tainted", () => {
    // The error branch throws, so the clone was dropped: no `error` render.
    const verdicts = [verdict('AC-1', 'pass')];
    applyDataStateCoverageTaints({
      criteria,
      verdicts,
      renders: [{ dataState: undefined, renderError: undefined }],
    });
    expect(verdicts[0]!.status).toBe('unverifiable');
    expect(verdicts[0]!.evidenceTaints).toEqual(['data-state']);
    expect(verdicts[0]!.detail).toContain('error branch not rendered');
  });

  it('an ERRORED forced render is not coverage either', () => {
    const verdicts = [verdict('AC-1', 'pass')];
    applyDataStateCoverageTaints({
      criteria,
      verdicts,
      renders: [{ dataState: 'error', renderError: 'boom' }],
    });
    expect(verdicts[0]!.status).toBe('unverifiable');
    expect(verdicts[0]!.evidenceTaints).toEqual(['data-state']);
  });

  it('leaves the criterion alone when its forced render DID happen', () => {
    const verdicts = [verdict('AC-1', 'pass')];
    applyDataStateCoverageTaints({
      criteria,
      verdicts,
      renders: [{ dataState: 'error', renderError: undefined }],
    });
    expect(verdicts[0]!.status).toBe('pass');
    expect(verdicts[0]!.evidenceTaints).toBeUndefined();
  });

  it('never touches populated / unconditioned criteria', () => {
    const verdicts = [verdict('AC-2', 'pass'), verdict('AC-3', 'pass')];
    applyDataStateCoverageTaints({ criteria, verdicts, renders: [] });
    expect(verdicts.every((v) => v.status === 'pass')).toBe(true);
    expect(verdicts.every((v) => v.evidenceTaints === undefined)).toBe(true);
  });

  it('a fail stays a fail — the taint only ever demotes', () => {
    const verdicts = [verdict('AC-1', 'fail')];
    applyDataStateCoverageTaints({ criteria, verdicts, renders: [] });
    expect(verdicts[0]!.status).toBe('fail');
    expect(verdicts[0]!.evidenceTaints).toEqual(['data-state']);
  });

  it('is idempotent — a second pass adds no duplicate taint', () => {
    const verdicts = [verdict('AC-1', 'pass')];
    applyDataStateCoverageTaints({ criteria, verdicts, renders: [] });
    const afterFirst = verdicts[0]!.detail;
    applyDataStateCoverageTaints({ criteria, verdicts, renders: [] });
    expect(verdicts[0]!.evidenceTaints).toEqual(['data-state']);
    expect(verdicts[0]!.detail).toBe(afterFirst);
  });
});
