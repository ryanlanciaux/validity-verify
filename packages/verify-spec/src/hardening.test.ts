/**
 * Hardening engine (hardening.ts) — the C4 acceptance criteria:
 *   - a soft criterion with FLAPPING evidence (any non-pass, changed pixels,
 *     changed citations, demoting taints) never produces a candidate;
 *   - a stable N-run streak produces a concrete, schema-valid proposal
 *     (compiler-derived element checks when the text compiles, else a
 *     screenshot baseline);
 *   - dismissing (resolving) the signal suppresses re-proposal until the
 *     evidence fingerprint changes;
 *   - streaks never span a re-freeze (specHash-bound).
 */
import { describe, expect, it } from 'vitest';
import {
  computeHardeningCandidates,
  computeHardeningSignals,
  HARDENING_STABLE_RUNS,
  type HardeningRunEvidence,
} from './hardening.js';
import { mergeSignals, type Signal } from './scorecard.js';
import { parseSpec, specCriterionSchema, type Spec } from './spec-schema.js';

const T = (i: number): string => `2026-01-0${i}T00:00:00.000Z`;

function spec(over: Partial<Spec> = {}): Spec {
  return {
    id: 'spec-hard',
    version: 2,
    status: 'frozen',
    hash: 'sha256-h2',
    source: { prompt: 'contact form', createdBy: 'agent' },
    runtime: 'web',
    criteria: [
      // Compiles: presence phrasing + quoted name + role keyword.
      { id: 'AC-1', text: 'a "Thanks!" success message is shown', tier: 'soft' },
      // Does not compile (pure aesthetics) → screenshot proposal.
      { id: 'AC-2', text: 'the layout looks polished and on-brand', tier: 'soft' },
    ],
    createdAt: T(1),
    ...over,
  };
}

/** One evidence run where both criteria pass, citing render `form` with a stable hash. */
function run(i: number, over: Partial<HardeningRunEvidence> = {}): HardeningRunEvidence {
  return {
    runId: `run-${i}`,
    createdAt: T(i),
    specHash: 'sha256-h2',
    verdicts: [
      { id: 'AC-1', tier: 'soft', status: 'pass', screenshotCitations: ['form'] },
      { id: 'AC-2', tier: 'soft', status: 'pass', screenshotCitations: ['form'] },
    ],
    shots: new Map([['form__base', 'hash-stable']]),
    idsToKeys: new Map([['form', ['form__base']]]),
    ...over,
  };
}

const stableHistory = (n = HARDENING_STABLE_RUNS): HardeningRunEvidence[] =>
  Array.from({ length: n }, (_, i) => run(i + 1));

describe('computeHardeningCandidates — the stable-streak rule', () => {
  it('N stable passing runs on identical evidence produce candidates for both criteria', () => {
    const out = computeHardeningCandidates({ spec: spec(), history: stableHistory() });
    expect(out.map((c) => c.criterionId).sort()).toEqual(['AC-1', 'AC-2']);
    expect(out.every((c) => c.runs === HARDENING_STABLE_RUNS)).toBe(true);
  });

  it('compilable text proposes compiler checks; aesthetic text proposes a screenshot baseline', () => {
    const [ac1, ac2] = computeHardeningCandidates({ spec: spec(), history: stableHistory() });
    expect(ac1!.kind).toBe('element');
    expect(JSON.stringify(ac1!.proposal.checks)).toContain('"element"');
    expect(ac2!.kind).toBe('screenshot');
    expect(ac2!.proposal.checks).toEqual([{ expect: { screenshot: { name: 'AC-2' } } }]);
    // Every proposal must be a valid hard criterion (ready-to-paste + freezable).
    for (const c of [ac1!, ac2!]) {
      expect(() => specCriterionSchema.parse(c.proposal)).not.toThrow();
      expect(c.proposal.tier).toBe('hard');
      // The accepted proposal round-trips through parseSpec as part of a spec.
      expect(() =>
        parseSpec({ ...spec(), status: 'draft', hash: undefined, criteria: [c.proposal] }),
      ).not.toThrow();
    }
  });

  it('FLAP: one failing run inside the window breaks the streak (no candidate)', () => {
    const history = stableHistory(HARDENING_STABLE_RUNS + 1);
    history[HARDENING_STABLE_RUNS - 2] = run(HARDENING_STABLE_RUNS - 1, {
      verdicts: [
        { id: 'AC-1', tier: 'soft', status: 'fail', screenshotCitations: ['form'] },
        { id: 'AC-2', tier: 'soft', status: 'pass', screenshotCitations: ['form'] },
      ],
    });
    const out = computeHardeningCandidates({ spec: spec(), history });
    expect(out.map((c) => c.criterionId)).toEqual(['AC-2']); // AC-1 flapped
  });

  it('FLAP: pixel-changed screenshots (different hash) break the streak', () => {
    const history = stableHistory();
    history[1] = run(2, { shots: new Map([['form__base', 'hash-DIFFERENT']]) });
    expect(computeHardeningCandidates({ spec: spec(), history })).toEqual([]);
  });

  it('FLAP: a demoting evidence taint on a pass breaks the streak', () => {
    const history = stableHistory();
    history[2] = run(3, {
      verdicts: [
        {
          id: 'AC-1',
          tier: 'soft',
          status: 'pass',
          screenshotCitations: ['form'],
          evidenceTaints: ['wrapper'],
        },
        { id: 'AC-2', tier: 'soft', status: 'pass', screenshotCitations: ['form'] },
      ],
    });
    const out = computeHardeningCandidates({ spec: spec(), history });
    expect(out.map((c) => c.criterionId)).toEqual(['AC-2']);
  });

  it('no citations / missing cited render / unreadable shot ⇒ no candidate', () => {
    const noCitations = stableHistory().map((r) => ({
      ...r,
      verdicts: r.verdicts.map((v) => ({ ...v, screenshotCitations: [] })),
    }));
    expect(computeHardeningCandidates({ spec: spec(), history: noCitations })).toEqual([]);

    const missingRender = stableHistory().map((r) => ({
      ...r,
      idsToKeys: new Map<string, string[]>(),
    }));
    expect(computeHardeningCandidates({ spec: spec(), history: missingRender })).toEqual([]);
  });

  it('a streak never spans a re-freeze (different specHash rows are outside the window)', () => {
    const history = [
      ...Array.from({ length: 3 }, (_, i) => run(i + 1, { specHash: 'sha256-h1' })),
      ...Array.from({ length: 3 }, (_, i) => run(i + 4)),
    ];
    // Only 3 same-hash runs < N=5 ⇒ nothing, even though 6 passes total.
    expect(computeHardeningCandidates({ spec: spec(), history })).toEqual([]);
  });

  it('advisory soft criteria are never candidates (they do not gate certification)', () => {
    const s = spec({
      criteria: [
        {
          id: 'AC-1',
          text: 'a "Thanks!" success message is shown',
          tier: 'soft',
          severity: 'advisory',
        },
      ],
    });
    const history = stableHistory().map((r) => ({
      ...r,
      verdicts: [r.verdicts[0]!],
    }));
    expect(computeHardeningCandidates({ spec: s, history })).toEqual([]);
  });

  it('non-frozen specs and short windows produce nothing', () => {
    expect(
      computeHardeningCandidates({
        spec: spec({ status: 'draft', hash: undefined }),
        history: stableHistory(),
      }),
    ).toEqual([]);
    expect(
      computeHardeningCandidates({
        spec: spec(),
        history: stableHistory(HARDENING_STABLE_RUNS - 1),
      }),
    ).toEqual([]);
  });
});

describe('computeHardeningSignals — dismissal + withdrawal', () => {
  it('emits an open low-severity signal carrying the proposal + evidence hash', () => {
    const signals = computeHardeningSignals({
      spec: spec(),
      history: stableHistory(),
      existingSignals: [],
      now: T(9),
    });
    const ac1 = signals.find((s) => s.criterionId === 'AC-1')!;
    expect(ac1).toMatchObject({
      id: 'hardening-candidate:spec-hard:AC-1',
      kind: 'hardening-candidate',
      severity: 'low',
      status: 'open',
    });
    expect(ac1.hardening?.proposal.tier).toBe('hard');
    expect(ac1.hardening?.evidenceHash).toMatch(/^sha256-/);
    expect(ac1.detail).toContain('passed 5 consecutive runs');
  });

  it('DISMISSAL: a resolved signal with the same evidence hash suppresses re-proposal', () => {
    const first = computeHardeningSignals({
      spec: spec(),
      history: stableHistory(),
      existingSignals: [],
      now: T(8),
    });
    // Human dismisses AC-1's proposal (resolve in place, hash retained).
    const dismissed: Signal[] = mergeSignals(first, []).map((s) =>
      s.criterionId === 'AC-1' ? { ...s, status: 'resolved' as const, resolvedAt: T(8) } : s,
    );

    const again = computeHardeningSignals({
      spec: spec(),
      history: stableHistory(),
      existingSignals: dismissed,
      now: T(9),
    });
    expect(again.find((s) => s.criterionId === 'AC-1')).toBeUndefined(); // suppressed
    expect(again.find((s) => s.criterionId === 'AC-2')).toBeDefined(); // untouched

    // Evidence CHANGES (new stable hash across the window) ⇒ re-proposed.
    const newEvidence = stableHistory().map((r) => ({
      ...r,
      shots: new Map([['form__base', 'hash-NEW']]),
    }));
    const reproposed = computeHardeningSignals({
      spec: spec(),
      history: newEvidence,
      existingSignals: dismissed,
      now: T(9),
    });
    expect(reproposed.find((s) => s.criterionId === 'AC-1')?.status).toBe('open');
  });

  it('WITHDRAWAL: an open proposal whose evidence flapped resolves in place', () => {
    const open = computeHardeningSignals({
      spec: spec(),
      history: stableHistory(),
      existingSignals: [],
      now: T(8),
    });
    const flapped = stableHistory();
    flapped[4] = run(5, {
      verdicts: [
        { id: 'AC-1', tier: 'soft', status: 'fail', screenshotCitations: ['form'] },
        { id: 'AC-2', tier: 'soft', status: 'pass', screenshotCitations: ['form'] },
      ],
    });
    const next = computeHardeningSignals({
      spec: spec(),
      history: flapped,
      existingSignals: open,
      now: T(9),
    });
    const withdrawn = next.find((s) => s.criterionId === 'AC-1');
    expect(withdrawn?.status).toBe('resolved');
    expect(withdrawn?.detail).toContain('withdrawn');
  });
});

describe('withdrawal vs dismissal — a system withdrawal never suppresses like a human "no"', () => {
  it('flap → withdrawal → same evidence re-stabilizes ⇒ RE-PROPOSED (through a real mergeSignals round-trip)', () => {
    // 1. Proposal opens and is persisted.
    let stored = mergeSignals(
      [],
      computeHardeningSignals({
        spec: spec(),
        history: stableHistory(),
        existingSignals: [],
        now: T(7),
      }),
    );
    expect(stored.find((s) => s.criterionId === 'AC-1')?.status).toBe('open');

    // 2. Evidence flaps ⇒ system withdrawal (resolved, payload stripped).
    const flapped = stableHistory();
    flapped[4] = run(5, {
      verdicts: [
        { id: 'AC-1', tier: 'soft', status: 'fail', screenshotCitations: ['form'] },
        { id: 'AC-2', tier: 'soft', status: 'pass', screenshotCitations: ['form'] },
      ],
    });
    stored = mergeSignals(
      stored,
      computeHardeningSignals({
        spec: spec(),
        history: flapped,
        existingSignals: stored,
        now: T(8),
      }),
    );
    const withdrawn = stored.find((s) => s.id === 'hardening-candidate:spec-hard:AC-1');
    expect(withdrawn?.status).toBe('resolved');
    expect(withdrawn?.hardening).toBeUndefined(); // stripped — NOT a dismissal record

    // 3. The SAME evidence re-stabilizes ⇒ the proposal must fire again.
    const again = computeHardeningSignals({
      spec: spec(),
      history: stableHistory(),
      existingSignals: stored,
      now: T(9),
    });
    expect(again.find((s) => s.criterionId === 'AC-1')?.status).toBe('open');
  });
});
