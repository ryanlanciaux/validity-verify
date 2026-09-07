/**
 * Maturity ladder derivation (maturity.ts). The load-bearing invariants:
 * levels are DERIVED (no input field can claim one), every blocker kind is
 * reachable and actionable, certification demands frozen + a mechanically
 * anchored gate + current, untainted, fresh scorecard evidence + a clean
 * streak, and the assessment can never clear probation itself (only the
 * confirmed-pass path does). Evidence is passed in, so every case here runs
 * without IO. Export health is deliberately ABSENT — it lives in the separate
 * portability badge (@validity.ai/verify-web) and must never move a level.
 */
import { describe, expect, it } from 'vitest';
import {
  applyMaturityToScorecard,
  assessMaturity,
  CERTIFICATION_STABLE_RUNS,
  exportGateSpec,
  MATURITY_RANK,
  maturityDropSignal,
  tallyMaturity,
  type MaturityAssessment,
  type MaturityEvidence,
} from './maturity.js';
import type { Scorecard, ScorecardSpec } from './scorecard.js';
import type { Spec, SpecCriterion } from './spec-schema.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

const HARD: SpecCriterion = {
  id: 'AC-1',
  text: 'shows the More Info button',
  tier: 'hard',
  checks: [{ expect: { element: { role: 'button', name: 'More Info', state: 'visible' } } }],
};
const SOFT: SpecCriterion = { id: 'AC-2', text: 'looks polished', tier: 'soft' };

function spec(over: Partial<Spec> = {}): Spec {
  return {
    id: 'spec-mat',
    version: 1,
    status: 'frozen',
    hash: 'hash-mat-1',
    source: { prompt: 'build the widget', createdBy: 'agent' },
    runtime: 'web',
    criteria: [HARD],
    createdAt: T0,
    ...over,
  };
}

/** A scorecard entry that fully proves the default spec() unless overridden. */
function entry(over: Partial<ScorecardSpec> = {}): ScorecardSpec {
  return {
    specVersion: 1,
    specHash: 'hash-mat-1',
    verdict: 'pass',
    signedOff: true,
    coveragePercent: 100,
    cleanStreak: { count: CERTIFICATION_STABLE_RUNS, lastSha: 'sha-2' },
    criteria: {
      'AC-1': { tier: 'hard', status: 'pass', at: T0, sha: 'sha-2' },
    },
    updatedAt: T0,
    ...over,
  };
}

function proven(over: Partial<ScorecardSpec> = {}): MaturityEvidence {
  return { entry: entry(over) };
}

describe('assessMaturity — the ladder walk (L0→L3)', () => {
  it('L0: a probation spec derives `probation` with the probation-unclear blocker first', () => {
    const a = assessMaturity(spec({ status: 'draft', probation: { since: T0 } }), {});
    expect(a.level).toBe('probation');
    expect(a.blockers[0]?.kind).toBe('probation-unclear');
    // The backlog shows the WHOLE climb: freeze is listed too.
    expect(a.blockers.map((b) => b.kind)).toContain('not-frozen');
  });

  it('L1: a non-probation draft derives `dev`; the backlog lists freeze + verify', () => {
    const a = assessMaturity(spec({ status: 'draft', hash: undefined }), {});
    expect(a.level).toBe('dev');
    expect(a.blockers.map((b) => b.kind)).toEqual(['not-frozen', 'never-verified']);
  });

  it('L1: reviewed/approved statuses are still `dev` (richer lifecycle, same rung)', () => {
    for (const status of ['reviewed', 'approved'] as const) {
      expect(assessMaturity(spec({ status, hash: undefined }), {}).level).toBe('dev');
    }
  });

  it('L2: a frozen spec with no evidence yet is `team` (never-verified)', () => {
    const a = assessMaturity(spec(), {});
    expect(a.level).toBe('team');
    expect(a.blockers.map((b) => b.kind)).toEqual(['never-verified']);
  });

  it('L3: frozen + current all-pass evidence + a full clean streak is `certified` with NO blockers', () => {
    const a = assessMaturity(spec(), proven());
    expect(a.level).toBe('certified');
    expect(a.blockers).toEqual([]);
  });

  it('L3: a blocking SOFT criterion certifies through evidence (scored, fresh, untainted)', () => {
    const a = assessMaturity(
      spec({ criteria: [HARD, SOFT] }),
      proven({
        criteria: {
          'AC-1': { tier: 'hard', status: 'pass', at: T0, sha: 'sha-2' },
          'AC-2': { tier: 'soft', status: 'pass', at: T0, sha: 'sha-2', score: 0.9 },
        },
      }),
    );
    expect(a.level).toBe('certified');
    expect(a.blockers).toEqual([]);
  });
});

describe('assessMaturity — every blocker kind', () => {
  it('empty-gate: an all-advisory spec can NEVER certify (anti-Goodhart floor)', () => {
    const a = assessMaturity(
      spec({
        criteria: [
          { ...HARD, severity: 'advisory' },
          { ...SOFT, severity: 'advisory' },
        ],
      }),
      proven(),
    );
    expect(a.level).toBe('team');
    expect(a.blockers.map((b) => b.kind)).toEqual(['empty-gate']);
  });

  it('no-mechanical-anchor: an all-soft gate can NEVER certify, however well it scores', () => {
    const a = assessMaturity(
      spec({ criteria: [SOFT] }),
      proven({
        criteria: { 'AC-2': { tier: 'soft', status: 'pass', at: T0, sha: 'sha-2' } },
      }),
    );
    expect(a.level).toBe('team');
    expect(a.blockers.map((b) => b.kind)).toEqual(['no-mechanical-anchor']);
  });

  it('advisory soft criteria do not block certification (the anti-Goodhart valve)', () => {
    const a = assessMaturity(
      spec({ criteria: [HARD, { ...SOFT, severity: 'advisory' }] }),
      proven(),
    );
    expect(a.level).toBe('certified');
    expect(a.blockers).toEqual([]);
  });

  it('evidence-outdated: evidence for an older version pins the spec at team, without per-criterion noise', () => {
    const a = assessMaturity(spec({ version: 2 }), proven());
    expect(a.level).toBe('team');
    expect(a.blockers.map((b) => b.kind)).toEqual(['evidence-outdated']);
    expect(a.blockers[0]?.detail).toContain('v1');
    expect(a.blockers[0]?.detail).toContain('v2');
  });

  it('evidence-outdated: a content (hash) change is flagged even at the same version', () => {
    const a = assessMaturity(spec({ hash: 'hash-mat-2' }), proven());
    expect(a.blockers.map((b) => b.kind)).toEqual(['evidence-outdated']);
    expect(a.blockers[0]?.detail).toContain('content changed');
  });

  it('criterion-unproven: failing / unverifiable / unscored / missing gate criteria each block', () => {
    const cases: Array<[ScorecardSpec['criteria'], string]> = [
      [{ 'AC-1': { tier: 'hard', status: 'fail', at: T0 } }, 'failing'],
      [{ 'AC-1': { tier: 'hard', status: 'unverifiable', at: T0 } }, 'unverifiable'],
      [{}, 'no recorded verdict'],
    ];
    for (const [criteria, needle] of cases) {
      const a = assessMaturity(spec(), proven({ criteria }));
      expect(a.level).toBe('team');
      expect(a.blockers.map((b) => b.kind)).toEqual(['criterion-unproven']);
      expect(a.blockers[0]?.detail).toContain(needle);
    }
    const unscored = assessMaturity(
      spec({ criteria: [HARD, SOFT] }),
      proven({
        criteria: {
          'AC-1': { tier: 'hard', status: 'pass', at: T0 },
          'AC-2': { tier: 'soft', status: 'unscored', at: T0 },
        },
      }),
    );
    expect(unscored.blockers.map((b) => b.kind)).toEqual(['criterion-unproven']);
    expect(unscored.blockers[0]?.criterionId).toBe('AC-2');
  });

  it('criterion-unproven: a soft pass below its sign-off threshold blocks', () => {
    const a = assessMaturity(
      spec({ criteria: [HARD, { ...SOFT, softThreshold: 0.8 }] }),
      proven({
        criteria: {
          'AC-1': { tier: 'hard', status: 'pass', at: T0 },
          'AC-2': { tier: 'soft', status: 'pass', at: T0, score: 0.5, softThreshold: 0.8 },
        },
      }),
    );
    expect(a.blockers.map((b) => b.kind)).toEqual(['criterion-unproven']);
    expect(a.blockers[0]?.detail).toContain('below the sign-off threshold');
  });

  it('evidence-tainted: a pass propped up by a demoting taint can never certify', () => {
    const a = assessMaturity(
      spec(),
      proven({
        criteria: {
          'AC-1': { tier: 'hard', status: 'pass', at: T0, evidenceTaints: ['wrapper'] },
        },
      }),
    );
    expect(a.level).toBe('team');
    expect(a.blockers.map((b) => b.kind)).toEqual(['evidence-tainted']);
    expect(a.blockers[0]?.detail).toContain('wrapper');
  });

  it('evidence-tainted: a provenance-only taint (synthetic-data) does NOT block', () => {
    const a = assessMaturity(
      spec(),
      proven({
        criteria: {
          'AC-1': { tier: 'hard', status: 'pass', at: T0, evidenceTaints: ['synthetic-data'] },
        },
      }),
    );
    expect(a.level).toBe('certified');
  });

  it('soft-score-stale: a fresh-code-required soft score blocks until re-scored', () => {
    const a = assessMaturity(
      spec({ criteria: [HARD, SOFT] }),
      proven({
        criteria: {
          'AC-1': { tier: 'hard', status: 'pass', at: T0 },
          'AC-2': { tier: 'soft', status: 'pass', at: T0, stale: true },
        },
      }),
    );
    expect(a.level).toBe('team');
    expect(a.blockers.map((b) => b.kind)).toEqual(['soft-score-stale']);
    expect(a.blockers[0]?.criterionId).toBe('AC-2');
  });

  it('stability-pending: current all-pass evidence without the streak stays team', () => {
    for (const streak of [undefined, { count: 1, lastSha: 'sha-1' }]) {
      const a = assessMaturity(spec(), proven({ cleanStreak: streak }));
      expect(a.level).toBe('team');
      expect(a.blockers.map((b) => b.kind)).toEqual(['stability-pending']);
      expect(a.blockers[0]?.detail).toContain(`${streak?.count ?? 0}/${CERTIFICATION_STABLE_RUNS}`);
    }
  });

  it('stableRuns override moves the stability bar', () => {
    const a = assessMaturity(spec(), { ...proven(), stableRuns: 5 });
    expect(a.blockers.map((b) => b.kind)).toEqual(['stability-pending']);
    expect(assessMaturity(spec(), { ...proven(), stableRuns: 1 }).level).toBe('certified');
  });
});

describe('assessMaturity — predicate boundaries + ordering', () => {
  it('stability is deferred until it is the next actionable step', () => {
    // Unproven criterion ⇒ the streak complaint would be noise ⇒ not listed.
    const failing = assessMaturity(
      spec(),
      proven({
        criteria: { 'AC-1': { tier: 'hard', status: 'fail', at: T0 } },
        cleanStreak: undefined,
      }),
    );
    expect(failing.blockers.map((b) => b.kind)).toEqual(['criterion-unproven']);
    // Draft spec ⇒ not frozen ⇒ stability not listed either.
    const draft = assessMaturity(spec({ status: 'draft', hash: undefined }), {});
    expect(draft.blockers.map((b) => b.kind)).not.toContain('stability-pending');
  });

  it('the assessment never clears probation — even a fully-proven spec stays L0 while marked', () => {
    const a = assessMaturity(spec({ probation: { since: T0 } }), proven());
    expect(a.level).toBe('probation');
    expect(a.blockers[0]?.kind).toBe('probation-unclear');
  });

  it('a superseded spec derives dev with a superseded-specific not-frozen blocker', () => {
    const a = assessMaturity(spec({ status: 'superseded' }), proven());
    expect(a.level).toBe('dev');
    expect(a.blockers[0]?.kind).toBe('not-frozen');
    expect(a.blockers[0]?.detail).toContain('superseded');
  });

  it('blockers arrive in ladder order: probation → freeze → gate content → evidence', () => {
    const a = assessMaturity(
      spec({ status: 'draft', probation: { since: T0 }, criteria: [{ ...SOFT }] }),
      {},
    );
    expect(a.blockers.map((b) => b.kind)).toEqual([
      'probation-unclear',
      'not-frozen',
      'no-mechanical-anchor',
      'never-verified',
    ]);
  });
});

describe('exportGateSpec', () => {
  it('keeps blocking hard/property criteria, drops soft + advisory', () => {
    const s = spec({
      criteria: [
        HARD,
        SOFT,
        { ...HARD, id: 'AC-3', severity: 'advisory' },
        { id: 'AC-4', text: 'invariant', tier: 'property' },
      ],
    });
    expect(exportGateSpec(s).criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-4']);
    // Non-mutating: the source spec is untouched.
    expect(s.criteria).toHaveLength(4);
  });
});

describe('maturityDropSignal', () => {
  it('fires only on a DOWNWARD move, as a standalone resolved info row', () => {
    const sig = maturityDropSignal({
      specId: 'spec-mat',
      prev: 'certified',
      next: 'team',
      blockers: [{ kind: 'criterion-unproven', detail: 'AC-1 is failing' }],
      now: T1,
      sha: 'abc',
    });
    expect(sig).toMatchObject({
      id: 'maturity-drop:spec-mat:*',
      kind: 'maturity-drop',
      severity: 'info',
      status: 'resolved',
      resolvedAt: T1,
    });
    expect(sig?.detail).toContain('certified → team');
    expect(sig?.detail).toContain('AC-1 is failing');
  });

  it('holds and climbs are silent', () => {
    for (const [prev, next] of [
      ['team', 'team'],
      ['team', 'certified'],
      ['dev', 'team'],
    ] as const) {
      expect(maturityDropSignal({ specId: 's', prev, next, blockers: [], now: T1 })).toBeNull();
    }
  });
});

describe('applyMaturityToScorecard', () => {
  const baseCard = (): Scorecard => ({
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-mat': {
        specVersion: 1,
        verdict: 'pass',
        coveragePercent: 100,
        criteria: {},
        updatedAt: T0,
        maturity: { level: 'certified', blockersCount: 0, blockers: [] },
      },
    },
  });
  const teamAssessment: MaturityAssessment = {
    level: 'team',
    blockers: [{ kind: 'stability-pending', detail: '1/2 consecutive clean verifications' }],
  };

  it('stamps the cache and emits a drop signal when the level fell', () => {
    const { scorecard, signals } = applyMaturityToScorecard({
      scorecard: baseCard(),
      assessments: new Map([['spec-mat', teamAssessment]]),
      now: T1,
    });
    expect(scorecard.specs['spec-mat']?.maturity).toEqual({
      level: 'team',
      blockersCount: 1,
      blockers: [{ kind: 'stability-pending', detail: '1/2 consecutive clean verifications' }],
    });
    expect(signals.map((s) => s.kind)).toEqual(['maturity-drop']);
  });

  it('is quiet + identity-stable when nothing changed', () => {
    const card = baseCard();
    const { scorecard, signals } = applyMaturityToScorecard({
      scorecard: card,
      assessments: new Map([['spec-mat', { level: 'certified', blockers: [] }]]),
      now: T1,
    });
    expect(signals).toEqual([]);
    expect(scorecard).toBe(card); // no gratuitous rewrite of the committed file
  });

  it('a first-ever stamp emits no drop (no prior level to fall from)', () => {
    const card = baseCard();
    delete card.specs['spec-mat']!.maturity;
    const { signals } = applyMaturityToScorecard({
      scorecard: card,
      assessments: new Map([['spec-mat', teamAssessment]]),
      now: T1,
    });
    expect(signals).toEqual([]);
  });

  it('skips specs with no scorecard entry', () => {
    const { scorecard, signals } = applyMaturityToScorecard({
      scorecard: baseCard(),
      assessments: new Map([['spec-other', teamAssessment]]),
      now: T1,
    });
    expect(scorecard.specs['spec-other']).toBeUndefined();
    expect(signals).toEqual([]);
  });
});

describe('rank + tally helpers', () => {
  it('MATURITY_RANK orders the ladder', () => {
    expect(MATURITY_RANK.probation).toBeLessThan(MATURITY_RANK.dev);
    expect(MATURITY_RANK.dev).toBeLessThan(MATURITY_RANK.team);
    expect(MATURITY_RANK.team).toBeLessThan(MATURITY_RANK.certified);
  });

  it('tallyMaturity counts levels for the hero strip', () => {
    expect(tallyMaturity(['certified', 'team', 'team', 'dev'])).toEqual({
      probation: 0,
      dev: 1,
      team: 2,
      certified: 1,
    });
  });
});
