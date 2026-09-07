/**
 * Tests for the scorecard reducer — the heart of the continuous watcher. The
 * load-bearing invariants: a deterministic tick's `unscored` must never erase a
 * real soft score, undecided states never roll up to pass, and transitions emit
 * the right signals (and recoveries resolve them).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  appendScoreHistory,
  applySoftScores,
  computePerfDriftSignals,
  computeSignedOff,
  computeSpecScore,
  computeValidityScore,
  countTrackedSoftCriteria,
  coveragePercent,
  JUDGE_GAP_SIGNAL_ID,
  judgeGapSignals,
  judgeGapWarning,
  mergeSignals,
  pruneResolvedSignals,
  RESOLVED_SIGNAL_RETENTION,
  PERF_DRIFT_MIN_SAMPLES,
  readScoreHistory,
  reconcileScorecard,
  rollupScorecardVerdict,
  scoreHistoryPath,
  softThresholdMet,
  staleSignalReason,
  sweepStaleSignals,
  VALIDITY_SCORE_FORMULA,
  VALIDITY_SCORE_VERSION,
  type PerfHistoryEntry,
  type Scorecard,
  type ScorecardCriterion,
  type ScorecardStatus,
  type ScoreCriterionInput,
  type ScoreHistoryEntry,
  type Signal,
  type SpecObservation,
} from './scorecard.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

function obs(over: Partial<SpecObservation> & Pick<SpecObservation, 'criteria'>): SpecObservation {
  return { specId: 'spec-a', specVersion: 1, specHash: 'h1', ...over };
}

function crit(over: Partial<ScorecardCriterion> = {}): ScorecardCriterion {
  return { tier: 'hard', status: 'pass', at: T0, ...over };
}

describe('rollupScorecardVerdict', () => {
  it('fail when a hard criterion fails', () => {
    expect(rollupScorecardVerdict({ a: crit({ status: 'fail' }) })).toBe('fail');
  });
  it('partial when something is undecided (unscored/unverifiable)', () => {
    expect(
      rollupScorecardVerdict({ a: crit(), b: crit({ tier: 'soft', status: 'unscored' }) }),
    ).toBe('partial');
    expect(rollupScorecardVerdict({ a: crit({ status: 'unverifiable' }) })).toBe('partial');
  });
  it('partial (not fail) when only a SOFT criterion fails', () => {
    expect(rollupScorecardVerdict({ a: crit(), b: crit({ tier: 'soft', status: 'fail' }) })).toBe(
      'partial',
    );
  });
  it('pass only when every criterion is decided-pass', () => {
    expect(rollupScorecardVerdict({ a: crit(), b: crit({ tier: 'soft', status: 'pass' }) })).toBe(
      'pass',
    );
  });
});

describe('coveragePercent', () => {
  it('counts decided hard/property over total, ignoring soft', () => {
    expect(
      coveragePercent({
        a: crit({ status: 'pass' }),
        b: crit({ status: 'unverifiable' }),
        c: crit({ tier: 'soft', status: 'unscored' }),
      }),
    ).toBe(50);
  });
  it('null when there are no hard/property criteria', () => {
    expect(coveragePercent({ a: crit({ tier: 'soft', status: 'unscored' }) })).toBeNull();
  });
});

describe('reconcileScorecard — first tick', () => {
  it('seeds the scorecard and emits needs-scoring for soft, no false regressions', () => {
    const { scorecard, signals } = reconcileScorecard({
      prev: null,
      now: T0,
      sha: 'sha0',
      observations: [
        obs({
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'pass' },
            { id: 'AC-2', tier: 'soft', status: 'unscored' },
          ],
        }),
      ],
    });
    expect(scorecard.specs['spec-a']!.verdict).toBe('partial'); // soft unscored
    expect(scorecard.specs['spec-a']!.coveragePercent).toBe(100);
    expect(signals.map((s) => s.kind)).toEqual(['needs-scoring']);
    expect(signals.every((s) => s.kind !== 'regression')).toBe(true);
  });
});

describe('reconcileScorecard — transitions', () => {
  const prevWith = (status: ScorecardCriterion['status'], sha = 'sha0'): Scorecard => ({
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-a': {
        specVersion: 1,
        specHash: 'h1',
        verdict: 'pass',
        coveragePercent: 100,
        criteria: { 'AC-1': crit({ status, sha }) },
        updatedAt: T0,
      },
    },
  });

  it('pass → fail emits a regression (high)', () => {
    const { signals } = reconcileScorecard({
      prev: prevWith('pass'),
      now: T1,
      observations: [
        obs({ criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail', detail: 'no POST' }] }),
      ],
    });
    const reg = signals.find((s) => s.kind === 'regression');
    expect(reg).toBeDefined();
    expect(reg!.severity).toBe('high');
    expect(reg!.from).toBe('pass');
    expect(reg!.to).toBe('fail');
  });

  it('pass → unverifiable emits an unverifiable signal (spec rot)', () => {
    const { signals } = reconcileScorecard({
      prev: prevWith('pass'),
      now: T1,
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }] })],
    });
    expect(signals.find((s) => s.kind === 'unverifiable')).toBeDefined();
  });

  it('fail → pass emits a recovered signal (resolved)', () => {
    const { signals } = reconcileScorecard({
      prev: prevWith('fail'),
      now: T1,
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }] })],
    });
    const rec = signals.find((s) => s.kind === 'recovered');
    expect(rec).toBeDefined();
    expect(rec!.status).toBe('resolved');
  });

  it('emits coverage-drop when a passing hard criterion becomes unverifiable', () => {
    const prev: Scorecard = {
      version: 1,
      updatedAt: T0,
      specs: {
        'spec-a': {
          specVersion: 1,
          specHash: 'h1',
          verdict: 'pass',
          coveragePercent: 100,
          criteria: { 'AC-1': crit({ status: 'pass' }), 'AC-2': crit({ status: 'pass' }) },
          updatedAt: T0,
        },
      },
    };
    const { signals, scorecard } = reconcileScorecard({
      prev,
      now: T1,
      observations: [
        obs({
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'pass' },
            { id: 'AC-2', tier: 'hard', status: 'unverifiable' },
          ],
        }),
      ],
    });
    expect(scorecard.specs['spec-a']!.coveragePercent).toBe(50);
    expect(signals.find((s) => s.kind === 'coverage-drop')).toBeDefined();
  });

  it('spec-changed fires when the frozen hash moves', () => {
    const { signals } = reconcileScorecard({
      prev: prevWith('pass'),
      now: T1,
      observations: [
        obs({ specHash: 'h2', criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }] }),
      ],
    });
    expect(signals.find((s) => s.kind === 'spec-changed')).toBeDefined();
  });
});

describe('reconcileScorecard — soft-score preservation (gate integrity)', () => {
  const prevSoftPass: Scorecard = {
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-a': {
        specVersion: 1,
        specHash: 'h1',
        verdict: 'pass',
        coveragePercent: null,
        criteria: { 'AC-1': crit({ tier: 'soft', status: 'pass', sha: 'sha0' }) },
        updatedAt: T0,
      },
    },
  };

  it('a deterministic unscored tick does NOT erase a prior soft pass', () => {
    const { scorecard, signals } = reconcileScorecard({
      prev: prevSoftPass,
      now: T1,
      sha: 'sha0', // same commit — score is still fresh
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'soft', status: 'unscored' }] })],
    });
    expect(scorecard.specs['spec-a']!.criteria['AC-1']!.status).toBe('pass');
    expect(scorecard.specs['spec-a']!.criteria['AC-1']!.stale).toBeUndefined();
    expect(signals).toHaveLength(0);
  });

  it('flags the soft score stale + needs-rescoring when code moved', () => {
    const { scorecard, signals } = reconcileScorecard({
      prev: prevSoftPass,
      now: T1,
      sha: 'sha1', // code changed since the score was set
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'soft', status: 'unscored' }] })],
    });
    expect(scorecard.specs['spec-a']!.criteria['AC-1']!.status).toBe('pass');
    expect(scorecard.specs['spec-a']!.criteria['AC-1']!.stale).toBe(true);
    expect(signals.find((s) => s.kind === 'needs-rescoring')).toBeDefined();
  });

  it('#10 relevance overrides the sha-diff: codeChanged=false keeps a moved-HEAD score FRESH', () => {
    // HEAD moved (sha0 → sha1) but THIS spec's files didn't — must not stale.
    const { scorecard, signals } = reconcileScorecard({
      prev: prevSoftPass,
      now: T1,
      sha: 'sha1',
      observations: [
        obs({ codeChanged: false, criteria: [{ id: 'AC-1', tier: 'soft', status: 'unscored' }] }),
      ],
    });
    expect(scorecard.specs['spec-a']!.criteria['AC-1']!.stale).toBeUndefined();
    expect(signals.find((s) => s.kind === 'needs-rescoring')).toBeUndefined();
  });

  it('#10 relevance stales even with an unchanged HEAD: codeChanged=true on uncommitted edits', () => {
    // Same commit (a day of uncommitted edits), but the spec's files moved.
    const { scorecard, signals } = reconcileScorecard({
      prev: prevSoftPass,
      now: T1,
      sha: 'sha0',
      observations: [
        obs({ codeChanged: true, criteria: [{ id: 'AC-1', tier: 'soft', status: 'unscored' }] }),
      ],
    });
    expect(scorecard.specs['spec-a']!.criteria['AC-1']!.stale).toBe(true);
    expect(signals.find((s) => s.kind === 'needs-rescoring')).toBeDefined();
  });

  it('an explicit agent soft score DOES replace the prior status', () => {
    const { scorecard } = reconcileScorecard({
      prev: prevSoftPass,
      now: T1,
      sha: 'sha1',
      observations: [
        obs({ criteria: [{ id: 'AC-1', tier: 'soft', status: 'fail', detail: 'off-brand' }] }),
      ],
    });
    expect(scorecard.specs['spec-a']!.criteria['AC-1']!.status).toBe('fail');
  });

  it("CAN'T FALSE-GREEN (A1): a tick's wrapper taint is unioned into the carried-forward soft pass", () => {
    // Prior soft pass, code unchanged — but THIS tick observed a degraded
    // wrapper. The carried entry must pick up the taint so the sign-off guard
    // refuses it; carrying the clean prior entry would keep signing off work
    // whose current evidence is untrusted.
    const { scorecard } = reconcileScorecard({
      prev: prevSoftPass,
      now: T1,
      sha: 'sha0',
      observations: [
        obs({
          criteria: [{ id: 'AC-1', tier: 'soft', status: 'unscored', evidenceTaints: ['wrapper'] }],
        }),
      ],
    });
    const after = scorecard.specs['spec-a']!.criteria['AC-1']!;
    expect(after.status).toBe('pass'); // status carried (Rule 1)…
    expect(after.evidenceTaints).toEqual(['wrapper']); // …but the taint rides along
    expect(scorecard.specs['spec-a']!.signedOff).not.toBe(true);
  });

  it('a taint-free carry does not invent taints (no churn)', () => {
    const { scorecard } = reconcileScorecard({
      prev: prevSoftPass,
      now: T1,
      sha: 'sha0',
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'soft', status: 'unscored' }] })],
    });
    expect(scorecard.specs['spec-a']!.criteria['AC-1']!.evidenceTaints).toBeUndefined();
  });
});

describe('applySoftScores — agent soft-scoring loop', () => {
  const base = (softStatus: ScorecardCriterion['status'] = 'unscored'): Scorecard => ({
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-a': {
        specVersion: 1,
        specHash: 'h1',
        verdict: 'partial',
        coveragePercent: 100,
        criteria: {
          'AC-1': crit({ tier: 'hard', status: 'pass', sha: 'sha0' }),
          'AC-2': crit({ tier: 'soft', status: softStatus, sha: 'sha0' }),
        },
        updatedAt: T0,
      },
    },
  });

  it('folds a soft score in WITHOUT touching the mechanical hard verdict', () => {
    const { scorecard, applied } = applySoftScores({
      prev: base('unscored'),
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass', detail: 'on brand' }],
      now: T1,
      sha: 'sha1',
    });
    expect(applied).toEqual(['AC-2']);
    expect(scorecard.specs['spec-a']!.criteria['AC-2']!.status).toBe('pass');
    expect(scorecard.specs['spec-a']!.criteria['AC-1']!.status).toBe('pass'); // hard untouched
    expect(scorecard.specs['spec-a']!.verdict).toBe('pass'); // soft now scored pass
  });

  it('REJECTS a score targeting a hard/property criterion (mechanical is authoritative)', () => {
    const { scorecard, rejected, applied } = applySoftScores({
      prev: base(),
      specId: 'spec-a',
      scores: [{ id: 'AC-1', status: 'fail' }],
      now: T1,
    });
    expect(applied).toEqual([]);
    expect(rejected[0]).toMatchObject({ id: 'AC-1' });
    expect(scorecard.specs['spec-a']!.criteria['AC-1']!.status).toBe('pass'); // unchanged
  });

  it('rejects an unknown criterion id', () => {
    const { rejected } = applySoftScores({
      prev: base(),
      specId: 'spec-a',
      scores: [{ id: 'AC-99', status: 'pass' }],
      now: T1,
    });
    expect(rejected[0]).toMatchObject({ id: 'AC-99', reason: expect.stringMatching(/unknown/) });
  });

  it('emits a regression when a soft score goes pass → fail', () => {
    const { signals } = applySoftScores({
      prev: base('pass'),
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'fail', detail: 'off brand now' }],
      now: T1,
    });
    expect(signals.find((s) => s.kind === 'regression' && s.criterionId === 'AC-2')).toBeDefined();
  });

  it('emits a recovered (resolved) signal when a soft score goes fail → pass', () => {
    const { signals } = applySoftScores({
      prev: base('fail'),
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass' }],
      now: T1,
    });
    const rec = signals.find((s) => s.kind === 'recovered');
    expect(rec).toBeDefined();
    expect(rec!.status).toBe('resolved');
  });

  it('an omitted soft criterion is left untouched (omission never reads as pass)', () => {
    const prev = base('unscored');
    const { scorecard } = applySoftScores({
      prev,
      specId: 'spec-a',
      scores: [], // agent scored nothing
      now: T1,
    });
    expect(scorecard.specs['spec-a']!.criteria['AC-2']!.status).toBe('unscored');
  });

  it('throws when there is no prior scorecard entry (tick must run first)', () => {
    expect(() =>
      applySoftScores({
        prev: { version: 1, updatedAt: T0, specs: {} },
        specId: 'spec-a',
        scores: [{ id: 'AC-2', status: 'pass' }],
        now: T1,
      }),
    ).toThrow(/run a verify\/watch tick first/);
  });

  it('REJECTS an invalid status (no false-green via an unknown value)', () => {
    const { scorecard, applied, rejected } = applySoftScores({
      prev: base('unscored'),
      specId: 'spec-a',
      // @ts-expect-error — exercising untrusted/deserialized input
      scores: [{ id: 'AC-2', status: 'maybe' }],
      now: T1,
    });
    expect(applied).toEqual([]);
    expect(rejected[0]).toMatchObject({
      id: 'AC-2',
      reason: expect.stringMatching(/invalid status/),
    });
    expect(scorecard.specs['spec-a']!.criteria['AC-2']!.status).toBe('unscored'); // unchanged
    expect(scorecard.specs['spec-a']!.verdict).toBe('partial'); // never flips green
  });

  it('rejects duplicate ids (first applied, rest rejected — no spurious signals)', () => {
    const { applied, rejected, signals } = applySoftScores({
      prev: base('pass'),
      specId: 'spec-a',
      scores: [
        { id: 'AC-2', status: 'fail' },
        { id: 'AC-2', status: 'pass' },
      ],
      now: T1,
    });
    expect(applied).toEqual(['AC-2']);
    expect(rejected[0]).toMatchObject({ id: 'AC-2', reason: expect.stringMatching(/duplicate/) });
    // exactly one transition signal (the first: pass→fail), not a regression+recovered pair
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe('regression');
  });

  it('clears a stale flag when a fresh score lands', () => {
    const prev = base('pass');
    prev.specs['spec-a']!.criteria['AC-2']!.stale = true;
    const { scorecard } = applySoftScores({
      prev,
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass', detail: 're-scored' }],
      now: T1,
      sha: 'sha2',
    });
    expect(scorecard.specs['spec-a']!.criteria['AC-2']!.stale).toBeUndefined();
  });

  it('a softThreshold gates sign-off on the numeric score (pass-but-below-bar does NOT sign off)', () => {
    const prev = base('unscored');
    // The frozen spec set a 0.8 bar on the soft criterion.
    prev.specs['spec-a']!.criteria['AC-2']!.softThreshold = 0.8;

    // pass status but score under the bar → criterion persists the score, verdict
    // is green (status-wise) but the stop rule stays false.
    const below = applySoftScores({
      prev,
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass', detail: 'looks ok', score: 0.6 }],
      now: T1,
    });
    expect(below.scorecard.specs['spec-a']!.criteria['AC-2']!.score).toBe(0.6);
    expect(below.scorecard.specs['spec-a']!.criteria['AC-2']!.softThreshold).toBe(0.8);
    expect(below.scorecard.specs['spec-a']!.signedOff).toBe(false);

    // same status, score at/above the bar → signs off.
    const atBar = applySoftScores({
      prev,
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass', detail: 'strong', score: 0.85 }],
      now: T1,
    });
    expect(atBar.scorecard.specs['spec-a']!.signedOff).toBe(true);
  });
});

describe('signal-queue lifecycle — signals must close (W1 #1/#2/#3, W2 #6)', () => {
  const base = (softStatus: ScorecardCriterion['status'] = 'unscored'): Scorecard => ({
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-a': {
        specVersion: 1,
        specHash: 'h1',
        verdict: 'partial',
        coveragePercent: 100,
        criteria: {
          'AC-1': crit({ tier: 'hard', status: 'pass', sha: 'sha0' }),
          'AC-2': crit({ tier: 'soft', status: softStatus, sha: 'sha0' }),
        },
        updatedAt: T0,
      },
    },
  });

  it('#1 scoring an unscored soft criterion resolves its needs-scoring signal', () => {
    // A prior tick left a needs-scoring open; the agent now scores it.
    const open = mergeSignals(
      [],
      [
        {
          id: 'needs-scoring:spec-a:AC-2',
          kind: 'needs-scoring',
          severity: 'low',
          specId: 'spec-a',
          criterionId: 'AC-2',
          detail: 'no score yet',
          at: T0,
          status: 'open',
        },
      ],
    );
    const { signals } = applySoftScores({
      prev: base('unscored'),
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass' }],
      now: T1,
    });
    expect(signals.find((s) => s.id === 'needs-scoring:spec-a:AC-2')?.status).toBe('resolved');
    expect(signals.find((s) => s.id === 'needs-scoring:spec-a:AC-2')?.resolvedBy).toBe('pass');
    const merged = mergeSignals(open, signals);
    expect(merged.find((s) => s.id === 'needs-scoring:spec-a:AC-2')!.status).toBe('resolved');
    expect(merged.find((s) => s.id === 'needs-scoring:spec-a:AC-2')!.resolvedBy).toBe('pass');
    expect(merged.filter((s) => s.status === 'open')).toHaveLength(0);
  });

  it('#1 re-scoring a STALE soft criterion resolves its needs-rescoring signal', () => {
    const prev = base('pass');
    prev.specs['spec-a']!.criteria['AC-2']!.stale = true;
    const { signals } = applySoftScores({
      prev,
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass', detail: 're-scored' }],
      now: T1,
      sha: 'sha9',
    });
    expect(signals.find((s) => s.id === 'needs-rescoring:spec-a:AC-2')?.status).toBe('resolved');
  });

  it('#1 a plain re-score of a current criterion emits NO lifecycle markers', () => {
    const { signals } = applySoftScores({
      prev: base('pass'), // already scored, not stale
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass' }],
      now: T1,
    });
    expect(signals).toHaveLength(0);
  });

  it('#2 spec-changed is a resolved NOTICE, never an open task', () => {
    const prev = base('pass');
    const { signals } = reconcileScorecard({
      prev,
      now: T1,
      observations: [
        obs({
          specHash: 'h2', // re-frozen
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'pass' },
            { id: 'AC-2', tier: 'soft', status: 'unscored' },
          ],
        }),
      ],
    });
    const changed = signals.find((s) => s.kind === 'spec-changed');
    expect(changed).toBeDefined();
    expect(changed!.status).toBe('resolved');
    expect(changed!.resolvedBy).toBe('freeze');
    // merges in as a standalone notice; never counts as open
    const merged = mergeSignals([], signals);
    expect(merged.filter((s) => s.status === 'open' && s.kind === 'spec-changed')).toHaveLength(0);
  });

  it('#2 coverage-drop opens on a fall and resolves when coverage recovers', () => {
    const prev = base('pass');
    prev.specs['spec-a']!.coveragePercent = 100;
    // Tick 1: AC-1 becomes unverifiable → coverage 100 → 0 → opens coverage-drop.
    const dropped = reconcileScorecard({
      prev,
      now: T1,
      observations: [
        obs({
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'unverifiable' },
            { id: 'AC-2', tier: 'soft', status: 'unscored' },
          ],
        }),
      ],
    });
    expect(dropped.signals.find((s) => s.kind === 'coverage-drop')?.status).toBe('open');
    const store = mergeSignals([], dropped.signals);
    // Tick 2: AC-1 passes again → coverage 0 → 100 → resolves coverage-drop.
    const recovered = reconcileScorecard({
      prev: dropped.scorecard,
      now: T1,
      observations: [
        obs({
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'pass' },
            { id: 'AC-2', tier: 'soft', status: 'unscored' },
          ],
        }),
      ],
    });
    const merged = mergeSignals(store, recovered.signals);
    expect(merged.find((s) => s.kind === 'coverage-drop')!.status).toBe('resolved');
  });

  it('#6 a re-freeze that DROPS a failing criterion removes it and resolves its regression', () => {
    // Prev: AC-1 hard pass, AC-2 hard FAIL (open regression), specHash h1.
    const prev: Scorecard = {
      version: 1,
      updatedAt: T0,
      specs: {
        'spec-a': {
          specVersion: 1,
          specHash: 'h1',
          verdict: 'fail',
          coveragePercent: 50,
          criteria: {
            'AC-1': crit({ tier: 'hard', status: 'pass' }),
            'AC-2': crit({ tier: 'hard', status: 'fail' }),
          },
          updatedAt: T0,
        },
      },
    };
    const openRegression = mergeSignals(
      [],
      [
        {
          id: 'regression:spec-a:AC-2',
          kind: 'regression',
          severity: 'high',
          specId: 'spec-a',
          criterionId: 'AC-2',
          detail: 'AC-2 fails',
          at: T0,
          status: 'open',
        },
      ],
    );
    // Re-freeze (h2) that RENAMED AC-2 away → observation only has AC-1 (+ new AC-3).
    const { scorecard, signals } = reconcileScorecard({
      prev,
      now: T1,
      observations: [
        obs({
          specHash: 'h2',
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'pass' },
            { id: 'AC-3', tier: 'hard', status: 'pass' },
          ],
        }),
      ],
    });
    // Zombie AC-2 is gone from the criteria map.
    expect(scorecard.specs['spec-a']!.criteria['AC-2']).toBeUndefined();
    expect(scorecard.specs['spec-a']!.criteria['AC-3']!.status).toBe('pass');
    // Its regression resolves, so the queue drains and the spec can sign off.
    const merged = mergeSignals(openRegression, signals);
    expect(merged.find((s) => s.id === 'regression:spec-a:AC-2')!.status).toBe('resolved');
    expect(merged.find((s) => s.id === 'regression:spec-a:AC-2')!.resolvedBy).toBe('freeze');
    expect(merged.filter((s) => s.status === 'open')).toHaveLength(0);
    expect(scorecard.specs['spec-a']!.verdict).toBe('pass');
  });

  it('#3 mergeSignals preserves openedAt across a re-fire', () => {
    const first = mergeSignals(
      [],
      [
        {
          id: 'regression:spec-a:AC-2',
          kind: 'regression',
          severity: 'high',
          specId: 'spec-a',
          criterionId: 'AC-2',
          detail: 'first',
          at: T0,
          openedAt: T0,
          status: 'open',
        },
      ],
    );
    const refired = mergeSignals(first, [
      {
        id: 'regression:spec-a:AC-2',
        kind: 'regression',
        severity: 'high',
        specId: 'spec-a',
        criterionId: 'AC-2',
        detail: 'still failing',
        at: T1,
        openedAt: T1, // a re-fire would naively carry the new time
        status: 'open',
      },
    ]);
    const s = refired.find((x) => x.id === 'regression:spec-a:AC-2')!;
    expect(s.openedAt).toBe(T0); // original open time preserved
    expect(s.at).toBe(T1); // last-touched moves
    expect(s.detail).toBe('still failing');
  });

  it('#3 pruneResolvedSignals keeps all open + the most-recent N resolved', () => {
    const open: Signal[] = [
      {
        id: 'regression:spec-a:OPEN',
        kind: 'regression',
        severity: 'high',
        specId: 'spec-a',
        criterionId: 'OPEN',
        detail: 'open',
        at: T0,
        status: 'open',
      },
    ];
    const resolved: Signal[] = Array.from({ length: RESOLVED_SIGNAL_RETENTION + 25 }, (_, i) => ({
      id: `recovered:spec-a:R${i}`,
      kind: 'recovered' as const,
      severity: 'info' as const,
      specId: 'spec-a',
      criterionId: `R${i}`,
      detail: 'ok',
      // Ascending resolve times so the oldest are pruned.
      at: `2026-02-${String((i % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
      resolvedAt: `2026-02-${String((i % 27) + 1).padStart(2, '0')}T00:00:00.000Z`,
      status: 'resolved' as const,
    }));
    const pruned = pruneResolvedSignals([...open, ...resolved]);
    expect(pruned.filter((s) => s.status === 'open')).toHaveLength(1);
    expect(pruned.filter((s) => s.status === 'resolved')).toHaveLength(RESOLVED_SIGNAL_RETENTION);
  });
});

describe('applySoftScores — evidence-taint clamp (A3)', () => {
  const tainted = (softStatus: ScorecardCriterion['status'] = 'unverifiable'): Scorecard => ({
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-a': {
        specVersion: 1,
        specHash: 'h1',
        verdict: 'partial',
        coveragePercent: 100,
        criteria: {
          'AC-1': crit({ tier: 'hard', status: 'pass', sha: 'sha0' }),
          'AC-2': crit({
            tier: 'soft',
            status: softStatus,
            sha: 'sha0',
            evidenceTaints: ['unconfirmed-render'],
          }),
        },
        updatedAt: T0,
      },
    },
  });

  it("CAN'T FALSE-GREEN: an agent pass on a demoting-tainted entry is stored unverifiable, taints intact", () => {
    const { scorecard, signals, applied } = applySoftScores({
      prev: tainted('unverifiable'),
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass', detail: 'looks right on screen' }],
      now: T1,
    });
    const entry = scorecard.specs['spec-a']!.criteria['AC-2']!;
    expect(applied).toEqual(['AC-2']);
    expect(entry.status).toBe('unverifiable');
    expect(entry.detail).toMatch(/evidence tainted: unconfirmed-render — pass withheld/);
    // Taints are sticky — a score can never launder them off the entry.
    expect(entry.evidenceTaints).toEqual(['unconfirmed-render']);
    // The clamped status drives the signal comparison: no spurious `recovered`.
    expect(signals.find((s) => s.kind === 'recovered')).toBeUndefined();
    expect(scorecard.specs['spec-a']!.signedOff).toBe(false);
    expect(scorecard.specs['spec-a']!.verdict).not.toBe('pass');
  });

  it('a submitted fail on a tainted entry is accepted as fail (strictening allowed)', () => {
    const { scorecard } = applySoftScores({
      prev: tainted('unverifiable'),
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'fail', detail: 'broken even so' }],
      now: T1,
    });
    const entry = scorecard.specs['spec-a']!.criteria['AC-2']!;
    expect(entry.status).toBe('fail');
    expect(entry.detail).toBe('broken even so');
    expect(entry.evidenceTaints).toEqual(['unconfirmed-render']);
  });

  it('a synthetic-data-only taint does NOT clamp a pass (provenance-only)', () => {
    const prev = tainted('unscored');
    prev.specs['spec-a']!.criteria['AC-2']!.evidenceTaints = ['synthetic-data'];
    const { scorecard } = applySoftScores({
      prev,
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass', detail: 'layout is right' }],
      now: T1,
    });
    const entry = scorecard.specs['spec-a']!.criteria['AC-2']!;
    expect(entry.status).toBe('pass');
    expect(entry.detail).toBe('layout is right');
    expect(entry.evidenceTaints).toEqual(['synthetic-data']);
  });
});

describe('reconcileScorecard — evidence-taint carry (A3)', () => {
  it("threads an observation's taints onto the entry and never rolls a tainted pass green", () => {
    const { scorecard } = reconcileScorecard({
      prev: null,
      now: T1,
      observations: [
        obs({
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'pass', evidenceTaints: ['network'] },
            { id: 'AC-2', tier: 'hard', status: 'pass' },
          ],
        }),
      ],
    });
    const spec = scorecard.specs['spec-a']!;
    expect(spec.criteria['AC-1']!.evidenceTaints).toEqual(['network']);
    // Belt-and-braces rollup guard: the demoting-tainted pass keeps the spec
    // out of green even though its persisted status says pass.
    expect(spec.verdict).toBe('partial');
    expect(spec.signedOff).toBe(false);
  });

  const taintedPrev = (): Scorecard => ({
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-a': {
        specVersion: 1,
        specHash: 'h1',
        verdict: 'partial',
        coveragePercent: null,
        criteria: {
          'AC-2': crit({
            tier: 'soft',
            status: 'unverifiable',
            evidenceTaints: ['wrapper'],
          }),
        },
        updatedAt: T0,
      },
    },
  });

  it('the Rule-1 carry-forward keeps the prior soft score AND its taints while the capture stays degraded', () => {
    // A deterministic tick reports the soft criterion `unscored` and its own
    // capture is STILL degraded — the prior status carries forward, and the
    // taints union (a degraded capture can never launder an older taint away).
    const { scorecard } = reconcileScorecard({
      prev: taintedPrev(),
      now: T1,
      observations: [
        obs({
          criteria: [{ id: 'AC-2', tier: 'soft', status: 'unscored', evidenceTaints: ['wrapper'] }],
        }),
      ],
    });
    const entry = scorecard.specs['spec-a']!.criteria['AC-2']!;
    expect(entry.status).toBe('unverifiable');
    expect(entry.evidenceTaints).toEqual(['wrapper']);
  });

  it('TAINT RECOVERY: a genuinely clean tick re-originates the evidence and drops the carried taints', () => {
    // The wrapper was fixed — THIS tick's capture carries no demoting taint,
    // so the fresh observation replaces the carried taint set. The clamped
    // status stays put (only a fresh score can lift it); recovery clears the
    // taints, never the verdict.
    const { scorecard } = reconcileScorecard({
      prev: taintedPrev(),
      now: T1,
      observations: [obs({ criteria: [{ id: 'AC-2', tier: 'soft', status: 'unscored' }] })],
    });
    const entry = scorecard.specs['spec-a']!.criteria['AC-2']!;
    expect(entry.status).toBe('unverifiable');
    expect(entry.evidenceTaints).toBeUndefined();
  });
});

describe('taint recovery — sticky scorecard taints clear on a clean tick (regression)', () => {
  const scoredCleanPass = (): Scorecard => ({
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-a': {
        specVersion: 1,
        specHash: 'h1',
        verdict: 'pass',
        coveragePercent: null,
        criteria: { 'AC-1': crit({ tier: 'soft', status: 'pass', sha: 'sha0' }) },
        updatedAt: T0,
      },
    },
  });

  it('a single degraded-wrapper tick does not wedge a scored soft entry forever: clean tick → re-score → signs off', () => {
    // (1) A clean scored soft pass exists. (2) One tick runs under a degraded
    // wrapper — the taint is unioned in and sign-off is refused.
    const degraded = reconcileScorecard({
      prev: scoredCleanPass(),
      now: T1,
      sha: 'sha0',
      observations: [
        obs({
          criteria: [{ id: 'AC-1', tier: 'soft', status: 'unscored', evidenceTaints: ['wrapper'] }],
        }),
      ],
    }).scorecard;
    expect(degraded.specs['spec-a']!.criteria['AC-1']!.evidenceTaints).toEqual(['wrapper']);
    expect(degraded.specs['spec-a']!.signedOff).toBe(false);

    // (3) An agent pass while tainted stays clamped — recovery is never the
    // agent's say-so.
    const clamped = applySoftScores({
      prev: degraded,
      specId: 'spec-a',
      scores: [{ id: 'AC-1', status: 'pass' }],
      now: T1,
      sha: 'sha0',
    }).scorecard;
    expect(clamped.specs['spec-a']!.criteria['AC-1']!.status).toBe('unverifiable');
    expect(clamped.specs['spec-a']!.signedOff).toBe(false);

    // (4) The wrapper is fixed — the next CLEAN tick's capture re-originates
    // the evidence and drops the taint (previously it was carried forever).
    const cleaned = reconcileScorecard({
      prev: clamped,
      now: T1,
      sha: 'sha0',
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'soft', status: 'unscored' }] })],
    }).scorecard;
    expect(cleaned.specs['spec-a']!.criteria['AC-1']!.evidenceTaints).toBeUndefined();

    // (5) A fresh score against the clean capture persists as pass — the spec
    // can sign off again.
    const rescored = applySoftScores({
      prev: cleaned,
      specId: 'spec-a',
      scores: [{ id: 'AC-1', status: 'pass' }],
      now: T1,
      sha: 'sha0',
    }).scorecard;
    expect(rescored.specs['spec-a']!.criteria['AC-1']!.status).toBe('pass');
    expect(rescored.specs['spec-a']!.signedOff).toBe(true);
  });

  it("CAN'T FALSE-GREEN: a tick that is itself demoting-tainted unions — it never replaces older taints away", () => {
    const prev = scoredCleanPass();
    prev.specs['spec-a']!.criteria['AC-1']!.evidenceTaints = ['unconfirmed-render'];
    const { scorecard } = reconcileScorecard({
      prev,
      now: T1,
      sha: 'sha0',
      observations: [
        obs({
          criteria: [{ id: 'AC-1', tier: 'soft', status: 'unscored', evidenceTaints: ['wrapper'] }],
        }),
      ],
    });
    const entry = scorecard.specs['spec-a']!.criteria['AC-1']!;
    expect(entry.evidenceTaints).toEqual(['unconfirmed-render', 'wrapper']);
    expect(scorecard.specs['spec-a']!.signedOff).toBe(false);
  });
});

describe('reconcileScorecard — gate integrity hardening', () => {
  it('an incomplete observation does NOT drop prior criteria (no false-green)', () => {
    const prev: Scorecard = {
      version: 1,
      updatedAt: T0,
      specs: {
        'spec-a': {
          specVersion: 1,
          specHash: 'h1',
          verdict: 'fail',
          coveragePercent: 50,
          criteria: {
            'AC-1': crit({ tier: 'hard', status: 'fail' }),
            'AC-2': crit({ tier: 'hard', status: 'pass' }),
          },
          updatedAt: T0,
        },
      },
    };
    // Observation omits the failing AC-1.
    const { scorecard } = reconcileScorecard({
      prev,
      now: T1,
      observations: [obs({ criteria: [{ id: 'AC-2', tier: 'hard', status: 'pass' }] })],
    });
    // AC-1 carried forward → still fail → verdict stays fail (not falsely green).
    expect(scorecard.specs['spec-a']!.criteria['AC-1']).toBeDefined();
    expect(scorecard.specs['spec-a']!.verdict).toBe('fail');
  });
});

describe('rollupScorecardVerdict — defensive', () => {
  it('an unknown status never rolls up to pass', () => {
    expect(
      rollupScorecardVerdict({
        a: crit({ status: 'pass' }),
        // @ts-expect-error — deserialized junk status
        b: crit({ status: 'weird' }),
      }),
    ).toBe('partial');
  });
});

describe('mergeSignals', () => {
  it('replaces same-id signals and resolves the open one on recovery', () => {
    const reg = {
      id: 'regression:spec-a:AC-1',
      kind: 'regression' as const,
      severity: 'high' as const,
      specId: 'spec-a',
      criterionId: 'AC-1',
      detail: 'x',
      at: T0,
      status: 'open' as const,
    };
    const recovered = {
      id: 'recovered:spec-a:AC-1',
      kind: 'recovered' as const,
      severity: 'info' as const,
      specId: 'spec-a',
      criterionId: 'AC-1',
      detail: 'y',
      at: T1,
      status: 'resolved' as const,
    };
    const merged = mergeSignals([reg], [recovered]);
    const stillOpenRegression = merged.find((s) => s.id === 'regression:spec-a:AC-1');
    expect(stillOpenRegression!.status).toBe('resolved');
  });
});

describe('computePerfDriftSignals (D1 — advisory perf drift)', () => {
  /** Timeline row: same perf key ('K') per entry unless metrics is null. */
  const entry = (
    runId: string,
    metrics: Record<string, number> | null,
    key = 'K',
  ): PerfHistoryEntry => (metrics === null ? { runId } : { runId, perf: { [key]: metrics } });

  const detect = (history: PerfHistoryEntry[], existingSignals: Signal[] = []): Signal[] =>
    computePerfDriftSignals({ specId: 'spec-a', history, existingSignals, now: T1, sha: 'sha1' });

  const steady = (n: number, mountMs = 5): PerfHistoryEntry[] =>
    Array.from({ length: n }, (_, i) => entry(`run_${i}`, { mountMs }));

  it('fires when BOTH the relative factor and the absolute floor breach (mount 5 -> 12ms)', () => {
    const signals = detect([...steady(5), entry('run_new', { mountMs: 12 })]);
    expect(signals).toHaveLength(1);
    const [s] = signals;
    expect(s!.kind).toBe('perf-drift');
    expect(s!.severity).toBe('low');
    expect(s!.status).toBe('open');
    expect(s!.id).toBe('perf-drift:spec-a:K');
    expect(s!.perfKey).toBe('K');
    expect(s!.criterionId).toBeUndefined();
    expect(s!.detail).toContain('mountMs 5ms \u2192 12ms');
    expect(s!.detail).toContain('advisory, does not gate');
  });

  // harnessBootMs is the sandbox's own cold start — it swings ~1s purely on
  // whether Vite's cache was warm, so surfacing it as the APP's perf drift
  // would be the very false-red the metric split removed.
  it('harnessBootMs never drifts, however far it swings', () => {
    const history = Array.from({ length: 5 }, (_, i) => entry(`run_${i}`, { harnessBootMs: 90 }));
    expect(detect([...history, entry('run_new', { harnessBootMs: 1200 })])).toEqual([]);
  });

  it('a harness-boot swing does not mask a real readyMs drift alongside it', () => {
    const history = Array.from({ length: 5 }, (_, i) =>
      entry(`run_${i}`, { harnessBootMs: 90, readyMs: 80 }),
    );
    const signals = detect([...history, entry('run_new', { harnessBootMs: 1200, readyMs: 400 })]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.detail).toContain('readyMs 80ms → 400ms');
    expect(signals[0]!.detail).not.toContain('harnessBootMs');
  });

  it('noise floor: 2ms -> 3.5ms (+75% relative) stays silent', () => {
    expect(detect([...steady(5, 2), entry('run_new', { mountMs: 3.5 })])).toEqual([]);
  });

  it('relative guard: readyMs 100 -> 130ms (+30ms but <50%) stays silent', () => {
    const history = Array.from({ length: 5 }, (_, i) => entry(`run_${i}`, { readyMs: 100 }));
    expect(detect([...history, entry('run_new', { readyMs: 130 })])).toEqual([]);
  });

  it('needs PERF_DRIFT_MIN_SAMPLES prior same-key samples before trusting a median', () => {
    const short = steady(PERF_DRIFT_MIN_SAMPLES - 1);
    expect(detect([...short, entry('run_new', { mountMs: 50 })])).toEqual([]);
    expect(
      detect([...steady(PERF_DRIFT_MIN_SAMPLES), entry('run_new', { mountMs: 50 })]),
    ).toHaveLength(1);
  });

  it("dedupes by runId (last wins) so the scored re-append cannot seed the run's own baseline", () => {
    // Each run appears twice (verify append + submit_report re-append), and the
    // current run's twin carries the SAME degraded value — with dedupe the
    // baseline is the 3 prior runs at 5ms, so drift still fires.
    const twins = ['a', 'b', 'c'].flatMap((id) => [
      entry(`run_${id}`, { mountMs: 5 }),
      entry(`run_${id}`, { mountMs: 5 }),
    ]);
    const signals = detect([
      ...twins,
      entry('run_new', { mountMs: 20 }),
      entry('run_new', { mountMs: 20 }),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.detail).toContain('median of last 3');
  });

  it("a late re-append of an OLDER run never becomes 'latest' — rows order by createdAt, not file position (regression)", () => {
    const at = (runId: string, createdAt: string, mountMs: number): PerfHistoryEntry => ({
      runId,
      createdAt,
      perf: { K: { mountMs } },
    });
    // Verify A (slow) lands, then verify B (clean) — and only THEN does the
    // agent score run A, so submit_report re-appends A's twin after B.
    const history = [
      at('run_0', '2026-01-01T00:00:00Z', 5),
      at('run_1', '2026-01-02T00:00:00Z', 5),
      at('run_2', '2026-01-03T00:00:00Z', 5),
      at('run_a', '2026-01-04T00:00:00Z', 20),
      at('run_b', '2026-01-05T00:00:00Z', 5),
      at('run_a', '2026-01-04T00:00:00Z', 20), // scored twin, re-appended late
    ];
    // The stale slow run A must not open a drift signal — the actually-latest
    // run B is in range.
    expect(detect(history)).toEqual([]);
    // And B (measured, clean) RESOLVES a drift that run A had legitimately
    // opened before B landed.
    const open = detect(history.slice(0, 4)); // latest = run_a → fires
    expect(open).toHaveLength(1);
    const after = detect(history, open);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('resolved');
  });

  it('re-fires with a stable id so mergeSignals updates in place', () => {
    const first = detect([...steady(5), entry('run_new', { mountMs: 12 })]);
    const second = detect([...steady(5), entry('run_new2', { mountMs: 14 })]);
    expect(first[0]!.id).toBe(second[0]!.id);
    const merged = mergeSignals(mergeSignals([], first), second);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.detail).toContain('14ms');
  });

  it('recovery resolves the open signal in place; an unmeasured key stays open; a perf-less latest resolves nothing', () => {
    const open = detect([...steady(5), entry('run_new', { mountMs: 12 })]);
    // In-range latest for the same key -> same-id resolved signal.
    const recovered = detect([...steady(5), entry('run_ok', { mountMs: 5 })], open);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.id).toBe(open[0]!.id);
    expect(recovered[0]!.status).toBe('resolved');
    expect(recovered[0]!.detail).toContain('recovered');
    // Key absent from the latest run (variant removed / not rendered) -> open stays.
    const otherKey = [...steady(5), { runId: 'run_other', perf: { OTHER: { mountMs: 1 } } }];
    expect(detect(otherKey, open)).toEqual([]);
    // Latest row with NO perf (URL run / pre-feature row) -> nothing fires, nothing resolves.
    expect(detect([...steady(5), entry('run_url', null)], open)).toEqual([]);
  });

  it('commitCount: 3 -> 9 fires, 3 -> 5 stays silent (count floor of 3)', () => {
    const history = Array.from({ length: 5 }, (_, i) => entry(`run_${i}`, { commitCount: 3 }));
    expect(detect([...history, entry('run_bad', { commitCount: 9 })])).toHaveLength(1);
    expect(detect([...history, entry('run_ok', { commitCount: 5 })])).toEqual([]);
  });

  it('old histories (rows without perf) never fire', () => {
    const old: PerfHistoryEntry[] = Array.from({ length: 6 }, (_, i) => ({ runId: `run_${i}` }));
    expect(detect(old)).toEqual([]);
    expect(detect([])).toEqual([]);
  });

  it('an unknown metric name in a hand-edited row is ignored (no floor, no fire)', () => {
    const history = Array.from({ length: 5 }, (_, i) => entry(`run_${i}`, { bogusMs: 1 }));
    expect(detect([...history, entry('run_new', { bogusMs: 500 })])).toEqual([]);
  });
});

describe('perf drift is ADVISORY (gate integrity)', () => {
  const perfHistory = (latestMountMs: number): PerfHistoryEntry[] => [
    ...Array.from({ length: 5 }, (_, i) => ({
      runId: `run_${i}`,
      perf: { K: { mountMs: 5 } },
    })),
    { runId: 'run_new', perf: { K: { mountMs: latestMountMs } } },
  ];

  it('a screaming drift signal changes no verdict and no signedOff', () => {
    // A green, signed-off spec...
    const { scorecard } = reconcileScorecard({
      prev: null,
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }] })],
      now: T0,
    });
    expect(scorecard.specs['spec-a']!.verdict).toBe('pass');
    expect(scorecard.specs['spec-a']!.signedOff).toBe(true);
    // ...with a 100x perf regression in its timeline:
    const signals = computePerfDriftSignals({
      specId: 'spec-a',
      history: perfHistory(500),
      existingSignals: [],
      now: T1,
    });
    // Every emitted signal is advisory-low perf-drift...
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(s.kind).toBe('perf-drift');
      expect(s.severity).toBe('low');
    }
    // ...and the scorecard the reducer produced is untouched by the detector
    // (drift reads no scorecard and writes no verdict surface).
    expect(scorecard.specs['spec-a']!.verdict).toBe('pass');
    expect(scorecard.specs['spec-a']!.signedOff).toBe(true);
  });

  it('a perf recovery flips no criterion status and cannot sign off a failing spec', () => {
    const { scorecard } = reconcileScorecard({
      prev: null,
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail' }] })],
      now: T0,
    });
    const open = computePerfDriftSignals({
      specId: 'spec-a',
      history: perfHistory(500),
      existingSignals: [],
      now: T0,
    });
    const recovered = computePerfDriftSignals({
      specId: 'spec-a',
      history: perfHistory(5),
      existingSignals: open,
      now: T1,
    });
    expect(recovered[0]!.status).toBe('resolved');
    expect(scorecard.specs['spec-a']!.verdict).toBe('fail');
    expect(scorecard.specs['spec-a']!.signedOff).toBe(false);
    expect(scorecard.specs['spec-a']!.criteria['AC-1']!.status).toBe('fail');
  });
});

/* ------------------------------------------------------------------ *
 * The Validity Score (F1).                                            *
 * ------------------------------------------------------------------ */

function sc(over: Partial<ScoreCriterionInput> = {}): ScoreCriterionInput {
  return { tier: 'hard', status: 'pass', ...over };
}

describe('softThresholdMet', () => {
  it('met when no threshold, no numeric score, or score >= threshold', () => {
    expect(softThresholdMet({})).toBe(true);
    expect(softThresholdMet({ softThreshold: 0.8 })).toBe(true);
    expect(softThresholdMet({ score: 0.5 })).toBe(true);
    expect(softThresholdMet({ softThreshold: 0.8, score: 0.8 })).toBe(true);
    expect(softThresholdMet({ softThreshold: 0.8, score: 0.79 })).toBe(false);
  });
});

describe('computeSpecScore (F1 — credit model)', () => {
  it('weights hard/property 2 and soft 1: one hard fail among passes', () => {
    // 2 hard pass (2+2) + 1 soft pass (1) earned; 1 hard fail adds 2 possible.
    // earned 5 / possible 7 → round(71.43) = 71.
    const s = computeSpecScore([
      sc(),
      sc(),
      sc({ status: 'fail' }),
      sc({ tier: 'soft', status: 'pass' }),
    ]);
    expect(s).toEqual({ score: 71, earnedWeight: 5, possibleWeight: 7, staleSoftCount: 0 });
  });

  it('a stale soft pass earns HALF credit (freshness decay) and is counted', () => {
    const s = computeSpecScore([sc({ tier: 'soft', status: 'pass', stale: true })]);
    expect(s).toEqual({ score: 50, earnedWeight: 0.5, possibleWeight: 1, staleSoftCount: 1 });
  });

  it('a below-threshold soft pass earns ZERO (mirrors the stop rule), stale or not', () => {
    expect(
      computeSpecScore([sc({ tier: 'soft', status: 'pass', softThreshold: 0.8, score: 0.7 })])
        .earnedWeight,
    ).toBe(0);
    expect(
      computeSpecScore([
        sc({ tier: 'soft', status: 'pass', softThreshold: 0.8, score: 0.7, stale: true }),
      ]).earnedWeight,
    ).toBe(0);
  });

  it('advisory criteria are excluded from numerator AND denominator', () => {
    const s = computeSpecScore([
      sc(),
      sc({ status: 'fail', severity: 'advisory' }),
      sc({ tier: 'soft', status: 'pass', severity: 'advisory', stale: true }),
    ]);
    expect(s).toEqual({ score: 100, earnedWeight: 2, possibleWeight: 2, staleSoftCount: 0 });
  });

  it('an unknown status earns 0 credit but STAYS in the denominator (never laundered)', () => {
    const s = computeSpecScore([sc(), sc({ status: 'passed' as unknown as ScorecardStatus })]);
    expect(s.score).toBe(50);
  });

  it('an unknown tier weighs 1 (soft-like) and is never excluded', () => {
    const s = computeSpecScore([sc(), sc({ tier: 'visual' as never, status: 'fail' })]);
    // earned 2 / possible 3 → 67.
    expect(s).toEqual({ score: 67, earnedWeight: 2, possibleWeight: 3, staleSoftCount: 0 });
  });

  it('a demoting-tainted pass earns 0 — the score never reads healthier than the stop rule', () => {
    expect(computeSpecScore([sc({ evidenceTaints: ['wrapper'] })]).earnedWeight).toBe(0);
    // synthetic-data is provenance-only, not demoting: full credit.
    expect(computeSpecScore([sc({ evidenceTaints: ['synthetic-data'] })]).earnedWeight).toBe(2);
  });

  it('empty / advisory-only lists have NO score (null — never 0, never 100)', () => {
    expect(computeSpecScore([]).score).toBeNull();
    expect(computeSpecScore([sc({ severity: 'advisory' })]).score).toBeNull();
  });

  it('perfection clamp: 99 hard passes + 1 hard fail is 99, never rounds to 100', () => {
    const criteria = Array.from({ length: 99 }, () => sc());
    criteria.push(sc({ status: 'fail' }));
    expect(computeSpecScore(criteria).score).toBe(99);
    expect(computeSpecScore(criteria.slice(0, 99)).score).toBe(100);
  });
});

describe('computeValidityScore (F1 — pooled repo score)', () => {
  function card(specs: Scorecard['specs']): Scorecard {
    return { version: 1, updatedAt: T0, specs };
  }

  it('null on a null / empty / advisory-only scorecard — never 0, never 100', () => {
    expect(computeValidityScore(null)).toBeNull();
    expect(computeValidityScore(card({}))).toBeNull();
    expect(
      computeValidityScore(
        card({
          'spec-a': {
            specVersion: 1,
            verdict: 'pass',
            coveragePercent: null,
            criteria: { a: crit({ severity: 'advisory' }) },
            updatedAt: T0,
          },
        }),
      ),
    ).toBeNull();
  });

  it('POOLS criteria across specs (a 1-criterion spec does not weigh like a 4-criterion one)', () => {
    const vs = computeValidityScore(
      card({
        big: {
          specVersion: 1,
          verdict: 'pass',
          coveragePercent: 100,
          criteria: { a: crit(), b: crit(), c: crit(), d: crit() },
          updatedAt: T0,
        },
        small: {
          specVersion: 1,
          verdict: 'fail',
          coveragePercent: 100,
          criteria: { a: crit({ status: 'fail' }) },
          updatedAt: T0,
        },
      }),
    )!;
    // Pooled: earned 8 / possible 10 = 80 (a per-spec average would say 50).
    expect(vs.score).toBe(80);
    expect(vs.perSpec['big']!.score).toBe(100);
    expect(vs.perSpec['small']!.score).toBe(0);
    expect(vs.blockingCriteriaCount).toBe(5);
    expect(vs.advisoryExcludedCount).toBe(0);
    expect(vs.version).toBe(VALIDITY_SCORE_VERSION);
  });

  it('counts advisory-excluded and stale-soft criteria for the surfaces', () => {
    const vs = computeValidityScore(
      card({
        'spec-a': {
          specVersion: 1,
          verdict: 'partial',
          coveragePercent: null,
          criteria: {
            a: crit(),
            b: crit({ severity: 'advisory', status: 'fail' }),
            c: crit({ tier: 'soft', status: 'pass', stale: true }),
          },
          updatedAt: T0,
        },
      }),
    )!;
    expect(vs.advisoryExcludedCount).toBe(1);
    expect(vs.staleSoftCount).toBe(1);
    expect(vs.blockingCriteriaCount).toBe(2);
  });
});

describe("the Validity Score can't false-green (F1 gate integrity)", () => {
  it('all-undecided blocking criteria score 0 while the verdict stays honestly partial', () => {
    const { scorecard } = reconcileScorecard({
      prev: null,
      now: T0,
      observations: [
        obs({
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'unverifiable' },
            { id: 'AC-2', tier: 'soft', status: 'unscored' },
          ],
        }),
      ],
    });
    const entry = scorecard.specs['spec-a']!;
    // Measurable contract, zero validation: 0 — distinct from null by design.
    expect(entry.validityScore).toBe(0);
    expect(scorecard.validityScore).toBe(0);
    expect(entry.verdict).toBe('partial');
    expect(entry.signedOff).toBe(false);
  });

  it('stamping is DERIVED, one-way: verdict/signedOff/criteria are exactly what the verdict fns say', () => {
    const { scorecard } = reconcileScorecard({
      prev: null,
      now: T0,
      sha: 'sha0',
      observations: [
        obs({
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'pass' },
            { id: 'AC-2', tier: 'soft', status: 'unscored' },
          ],
        }),
      ],
    });
    const entry = scorecard.specs['spec-a']!;
    expect(entry.verdict).toBe(rollupScorecardVerdict(entry.criteria));
    expect(entry.signedOff).toBe(computeSignedOff(Object.values(entry.criteria)));
    expect(entry.coveragePercent).toBe(coveragePercent(entry.criteria));
    // The stamp equals a fresh recompute — a display cache, not an input.
    expect(entry.validityScore).toBe(computeSpecScore(Object.values(entry.criteria)).score);
    expect(scorecard.validityScore).toBe(computeValidityScore(scorecard)!.score);
  });

  it('a hand-edited 0 score still signs off the moment criteria actually pass (score is never read)', () => {
    const prev: Scorecard = {
      version: 1,
      updatedAt: T0,
      validityScore: 0, // hand-edited lie
      specs: {
        'spec-a': {
          specVersion: 1,
          specHash: 'h1',
          verdict: 'fail',
          coveragePercent: 100,
          validityScore: 0, // hand-edited lie
          criteria: { 'AC-1': crit({ status: 'fail', at: T0 }) },
          updatedAt: T0,
        },
      },
    };
    const { scorecard } = reconcileScorecard({
      prev,
      now: T1,
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }] })],
    });
    const entry = scorecard.specs['spec-a']!;
    expect(entry.signedOff).toBe(true);
    expect(entry.verdict).toBe('pass');
    // …and the write re-stamps the cache, so the lie can't persist.
    expect(entry.validityScore).toBe(100);
    expect(scorecard.validityScore).toBe(100);
  });

  it('a 99-scoring scorecard with one blocking hard fail is still FAIL and never signed off', () => {
    const criteria: Record<string, ScorecardCriterion> = {};
    for (let i = 0; i < 99; i++) criteria[`AC-${i}`] = crit();
    criteria['AC-BAD'] = crit({ status: 'fail' });
    expect(computeSpecScore(Object.values(criteria)).score).toBe(99);
    expect(rollupScorecardVerdict(criteria)).toBe('fail');
    expect(computeSignedOff(Object.values(criteria))).toBe(false);
  });

  it('grid: ANY single blocking criterion the stop rule rejects earns credit < full', () => {
    const statuses = ['pass', 'fail', 'unverifiable', 'unscored'] as const;
    const tiers = ['hard', 'property', 'soft'] as const;
    for (const tier of tiers) {
      for (const status of statuses) {
        for (const stale of [false, true]) {
          for (const threshold of [undefined, { softThreshold: 0.8, score: 0.5 }]) {
            const c = { tier, status, stale: stale || undefined, ...threshold };
            if (computeSignedOff([c])) continue;
            const s = computeSpecScore([c]);
            expect(s.earnedWeight, JSON.stringify(c)).toBeLessThan(s.possibleWeight);
          }
        }
      }
    }
  });
});

describe('score history IO (F1 — .validity/history/score.jsonl)', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-score-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function entry(over: Partial<ScoreHistoryEntry> = {}): ScoreHistoryEntry {
    return {
      at: T0,
      sha: 'sha0',
      score: 80,
      perSpec: { 'spec-a': 80 },
      source: 'watch',
      scoreVersion: VALIDITY_SCORE_VERSION,
      ...over,
    };
  }

  it('scoreHistoryPath lives under .validity/history/', () => {
    expect(scoreHistoryPath(projectRoot)).toBe(
      resolve(projectRoot, '.validity', 'history', 'score.jsonl'),
    );
  });

  it('append + read round-trips, newest last', () => {
    appendScoreHistory(projectRoot, entry());
    appendScoreHistory(projectRoot, entry({ at: T1, score: 90, perSpec: { 'spec-a': 90 } }));
    const rows = readScoreHistory(projectRoot);
    expect(rows.map((r) => r.score)).toEqual([80, 90]);
  });

  it('dedupes consecutive identical entries (same score, sha, perSpec)', () => {
    appendScoreHistory(projectRoot, entry());
    appendScoreHistory(projectRoot, entry({ at: T1 })); // only the timestamp moved
    expect(readScoreHistory(projectRoot)).toHaveLength(1);
    // A moved sha is a new observation even at the same score.
    appendScoreHistory(projectRoot, entry({ at: T1, sha: 'sha1' }));
    expect(readScoreHistory(projectRoot)).toHaveLength(2);
  });

  it('ensures .validity/.gitattributes carries history/*.jsonl merge=union, exactly once', () => {
    appendScoreHistory(projectRoot, entry());
    appendScoreHistory(projectRoot, entry({ score: 90 }));
    const attrs = readFileSync(resolve(projectRoot, '.validity', '.gitattributes'), 'utf-8');
    expect(attrs.split('\n').filter((l) => l === 'history/*.jsonl merge=union')).toHaveLength(1);
  });

  it('readScoreHistory: [] on a missing file; malformed lines dropped', () => {
    expect(readScoreHistory(projectRoot)).toEqual([]);
    appendScoreHistory(projectRoot, entry());
    appendFileSync(scoreHistoryPath(projectRoot), 'not json\n');
    appendScoreHistory(projectRoot, entry({ score: 90 }));
    expect(readScoreHistory(projectRoot).map((r) => r.score)).toEqual([80, 90]);
  });
});

describe('Validity Score backward compatibility', () => {
  it('a pre-F1 scorecard (no severity / validityScore fields) scores fine and gets stamped on write', () => {
    // Shaped like a scorecard.json written before F1 — parsed via JSON, no new fields.
    const preF1 = JSON.parse(
      JSON.stringify({
        version: 1,
        updatedAt: T0,
        specs: {
          'spec-a': {
            specVersion: 1,
            specHash: 'h1',
            verdict: 'pass',
            coveragePercent: 100,
            criteria: {
              'AC-1': { tier: 'hard', status: 'pass', at: T0 },
              'AC-2': { tier: 'soft', status: 'pass', at: T0 },
            },
            updatedAt: T0,
          },
        },
      }),
    ) as Scorecard;
    // Absent severity reads as blocking; absent stale as fresh.
    expect(computeValidityScore(preF1)!.score).toBe(100);
    const { scorecard } = reconcileScorecard({
      prev: preF1,
      now: T1,
      observations: [
        obs({
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'pass' },
            { id: 'AC-2', tier: 'soft', status: 'unscored' },
          ],
        }),
      ],
    });
    expect(scorecard.specs['spec-a']!.validityScore).toBe(100);
    expect(scorecard.validityScore).toBe(100);
  });

  it('the published formula is one non-empty paragraph naming the informational posture', () => {
    expect(VALIDITY_SCORE_FORMULA).toContain('never gates');
    expect(VALIDITY_SCORE_FORMULA).not.toContain('\n');
  });
});

describe('reconcileScorecard — probation downgrade (Phase C — needs-review signal)', () => {
  // A spec on probation: bulk-created, unconfirmed. A pass→fail must open
  // needs-review (low), never regression (high), so a wrong bulk spec can't
  // poison the inbox before a human confirms it.
  const prevPass: Scorecard = {
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-a': {
        specVersion: 1,
        specHash: 'h1',
        verdict: 'pass',
        coveragePercent: 100,
        criteria: { 'AC-1': crit({ status: 'pass', sha: 'sha0' }) },
        updatedAt: T0,
      },
    },
  };

  it('probation pass→fail opens needs-review (low) and does NOT open regression', () => {
    const { signals } = reconcileScorecard({
      prev: prevPass,
      now: T1,
      observations: [
        obs({
          probation: true,
          criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail', detail: 'no POST' }],
        }),
      ],
    });
    const nr = signals.find((s) => s.kind === 'needs-review');
    expect(nr).toBeDefined();
    expect(nr!.severity).toBe('low');
    expect(nr!.status).toBe('open');
    expect(nr!.from).toBe('pass');
    expect(nr!.to).toBe('fail');
    expect(nr!.criterionId).toBe('AC-1');
    // No regression fired.
    expect(signals.find((s) => s.kind === 'regression')).toBeUndefined();
  });

  it('non-probation pass→fail still opens regression (unchanged behaviour)', () => {
    const { signals } = reconcileScorecard({
      prev: prevPass,
      now: T1,
      observations: [
        obs({
          probation: false,
          criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail', detail: 'no POST' }],
        }),
      ],
    });
    const reg = signals.find((s) => s.kind === 'regression');
    expect(reg).toBeDefined();
    expect(reg!.severity).toBe('high');
    expect(signals.find((s) => s.kind === 'needs-review')).toBeUndefined();
  });

  it('omitted probation (legacy callers) behaves exactly as before — regression (high)', () => {
    const { signals } = reconcileScorecard({
      prev: prevPass,
      now: T1,
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail' }] })],
    });
    expect(signals.find((s) => s.kind === 'regression')).toBeDefined();
    expect(signals.find((s) => s.kind === 'needs-review')).toBeUndefined();
  });

  it('a reconcile over a probation observation NEVER yields an open severity-high signal (exhaustive)', () => {
    // Exercise every transition branch + spec-changed + coverage-drop under
    // probation. None may emit an open high-severity signal.
    const prev: Scorecard = {
      version: 1,
      updatedAt: T0,
      specs: {
        'spec-a': {
          specVersion: 1,
          specHash: 'h1',
          verdict: 'pass',
          coveragePercent: 100,
          criteria: {
            'AC-1': crit({ status: 'pass', sha: 'sha0' }),
            'AC-2': crit({ status: 'pass', sha: 'sha0' }),
            'AC-3': crit({ tier: 'soft', status: 'pass', sha: 'sha0' }),
            'AC-4': crit({ tier: 'soft', status: 'unscored', sha: 'sha0' }),
          },
          updatedAt: T0,
        },
      },
    };

    // pass→fail (the only branch that downgrades under probation)
    const failTick = reconcileScorecard({
      prev,
      now: T1,
      observations: [
        obs({
          probation: true,
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'broke' },
            { id: 'AC-2', tier: 'hard', status: 'pass' },
            { id: 'AC-3', tier: 'soft', status: 'unscored' },
            { id: 'AC-4', tier: 'soft', status: 'unscored' },
          ],
        }),
      ],
    });
    expect(failTick.signals.filter((s) => s.status === 'open' && s.severity === 'high')).toEqual(
      [],
    );

    // pass→unverifiable (unchanged severity, but assert no high)
    const unvTick = reconcileScorecard({
      prev,
      now: T1,
      observations: [
        obs({
          probation: true,
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'unverifiable' },
            { id: 'AC-2', tier: 'hard', status: 'pass' },
          ],
        }),
      ],
    });
    expect(unvTick.signals.filter((s) => s.status === 'open' && s.severity === 'high')).toEqual([]);

    // spec-changed (re-freeze) under probation
    const refreeze = reconcileScorecard({
      prev,
      now: T1,
      observations: [
        obs({
          probation: true,
          specHash: 'h2',
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'pass' },
            { id: 'AC-2', tier: 'hard', status: 'pass' },
          ],
        }),
      ],
    });
    expect(refreeze.signals.filter((s) => s.status === 'open' && s.severity === 'high')).toEqual(
      [],
    );

    // coverage-drop under probation (medium, not high)
    const covDrop = reconcileScorecard({
      prev: {
        version: 1,
        updatedAt: T0,
        specs: {
          'spec-a': {
            specVersion: 1,
            specHash: 'h1',
            verdict: 'pass',
            coveragePercent: 100,
            criteria: {
              'AC-1': crit({ status: 'pass' }),
              'AC-2': crit({ status: 'pass' }),
            },
            updatedAt: T0,
          },
        },
      },
      now: T1,
      observations: [
        obs({
          probation: true,
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'unverifiable' },
            { id: 'AC-2', tier: 'hard', status: 'pass' },
          ],
        }),
      ],
    });
    expect(covDrop.signals.filter((s) => s.status === 'open' && s.severity === 'high')).toEqual([]);

    // Aggregate: every signal across all probation ticks is non-high when open.
    const allSignals = [
      ...failTick.signals,
      ...unvTick.signals,
      ...refreeze.signals,
      ...covDrop.signals,
    ];
    for (const s of allSignals) {
      if (s.status === 'open') {
        expect(s.severity, `${s.kind} must not be high under probation`).not.toBe('high');
      }
    }
  });

  it('needs-review resolves when the criterion recovers (fail → pass)', () => {
    // Tick 1: probation pass→fail opens needs-review.
    const tick1 = reconcileScorecard({
      prev: prevPass,
      now: T0,
      observations: [
        obs({
          probation: true,
          criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail', detail: 'broke' }],
        }),
      ],
    });
    const open = mergeSignals([], tick1.signals);
    expect(open.find((s) => s.id === 'needs-review:spec-a:AC-1')!.status).toBe('open');

    // Tick 2: criterion recovers (fail → pass). The recovered signal fires and
    // mergeSignals auto-resolves the open needs-review alongside the regression
    // it would have closed.
    const tick2 = reconcileScorecard({
      prev: tick1.scorecard,
      now: T1,
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }] })],
    });
    const merged = mergeSignals(open, tick2.signals);
    const nr = merged.find((s) => s.id === 'needs-review:spec-a:AC-1');
    expect(nr).toBeDefined();
    expect(nr!.status).toBe('resolved');
    // No open signals remain.
    expect(merged.filter((s) => s.status === 'open')).toHaveLength(0);
  });

  it('needs-review resolves when the criterion departs in a re-freeze', () => {
    // Tick 1: probation pass→fail opens needs-review.
    const tick1 = reconcileScorecard({
      prev: prevPass,
      now: T0,
      observations: [
        obs({
          probation: true,
          criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail', detail: 'broke' }],
        }),
      ],
    });
    const open = mergeSignals([], tick1.signals);
    expect(open.find((s) => s.id === 'needs-review:spec-a:AC-1')!.status).toBe('open');

    // Tick 2: re-freeze that drops AC-1 entirely.
    const tick2 = reconcileScorecard({
      prev: tick1.scorecard,
      now: T1,
      observations: [
        obs({
          specHash: 'h2',
          criteria: [{ id: 'AC-NEW', tier: 'hard', status: 'pass' }],
        }),
      ],
    });
    const merged = mergeSignals(open, tick2.signals);
    const nr = merged.find((s) => s.id === 'needs-review:spec-a:AC-1');
    expect(nr).toBeDefined();
    expect(nr!.status).toBe('resolved');
  });

  it('shouldFailOnSignals is not tripped by an open needs-review (advisory end-to-end)', () => {
    // The --fail-on-signal predicate: only an OPEN, HIGH-severity signal flips
    // the exit code. needs-review is low, so it can never fail a CI run — the
    // same advisory posture as perf-drift. Inlined here (not imported from the
    // CLI package) so the core package stays self-contained.
    const shouldFailOnSignals = (signals: Signal[]): boolean =>
      signals.some((s) => s.status === 'open' && s.severity === 'high');

    const { signals } = reconcileScorecard({
      prev: prevPass,
      now: T1,
      observations: [
        obs({
          probation: true,
          criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail', detail: 'broke' }],
        }),
      ],
    });
    expect(signals.find((s) => s.kind === 'needs-review' && s.status === 'open')).toBeDefined();
    expect(shouldFailOnSignals(signals)).toBe(false);
  });
});

describe('staleSignalReason / sweepStaleSignals — reconciling the inbox against current state', () => {
  const NOW = '2026-07-06T00:00:00.000Z';

  function openSignal(overrides: Partial<Signal>): Signal {
    return {
      id: 'needs-scoring:spec-a:AC-1',
      kind: 'needs-scoring',
      severity: 'low',
      specId: 'spec-a',
      criterionId: 'AC-1',
      detail: 'soft criterion "AC-1" has no agent score yet',
      at: T0,
      openedAt: T0,
      status: 'open',
      ...overrides,
    };
  }

  function scorecardWith(
    criteria: Record<
      string,
      Partial<ScorecardCriterion> & { tier: ScorecardCriterion['tier']; status: ScorecardStatus }
    >,
  ): Scorecard {
    const full: Record<string, ScorecardCriterion> = {};
    for (const [id, c] of Object.entries(criteria)) full[id] = { at: T0, ...c };
    return {
      version: 1,
      updatedAt: T0,
      specs: {
        'spec-a': {
          specVersion: 6,
          verdict: 'partial',
          coveragePercent: null,
          criteria: full,
          updatedAt: T0,
        },
      },
    };
  }

  const specA = (criteria: Array<{ id: string; tier: 'hard' | 'property' | 'soft' }>) => ({
    id: 'spec-a',
    version: 6,
    criteria,
  });

  it('needs-scoring with a recorded decided status is stale ("already scored")', () => {
    const ctx = {
      scorecard: scorecardWith({ 'AC-1': { tier: 'soft', status: 'pass', score: 0.9 } }),
      specs: [specA([{ id: 'AC-1', tier: 'soft' }])],
    };
    expect(staleSignalReason(openSignal({}), ctx)).toContain('already scored');
  });

  it('needs-scoring still unscored in the scorecard AND soft in the spec stays open', () => {
    const ctx = {
      scorecard: scorecardWith({ 'AC-1': { tier: 'soft', status: 'unscored' } }),
      specs: [specA([{ id: 'AC-1', tier: 'soft' }])],
    };
    expect(staleSignalReason(openSignal({}), ctx)).toBeNull();
  });

  it('needs-scoring whose criterion is HARD in the current spec version is stale (the spec-e221/AC-2 case)', () => {
    const ctx = {
      scorecard: scorecardWith({ 'AC-1': { tier: 'soft', status: 'unscored' } }),
      specs: [specA([{ id: 'AC-1', tier: 'hard' }])],
    };
    expect(staleSignalReason(openSignal({}), ctx)).toContain('machine-checked');
  });

  it('any criterion-scoped signal whose criterion left the current spec is stale', () => {
    const ctx = {
      scorecard: scorecardWith({ 'AC-1': { tier: 'soft', status: 'unscored' } }),
      specs: [specA([{ id: 'AC-9', tier: 'soft' }])],
    };
    expect(staleSignalReason(openSignal({}), ctx)).toContain(
      'no longer exists in the current spec',
    );
    expect(
      staleSignalReason(
        openSignal({ id: 'regression:spec-a:AC-1', kind: 'regression', severity: 'high' }),
        ctx,
      ),
    ).toContain('no longer exists in the current spec');
  });

  it('needs-rescoring is stale once the recorded score is fresh (not flagged stale)', () => {
    const fresh = {
      scorecard: scorecardWith({ 'AC-1': { tier: 'soft', status: 'pass' } }),
      specs: [specA([{ id: 'AC-1', tier: 'soft' }])],
    };
    const stillStale = {
      scorecard: scorecardWith({ 'AC-1': { tier: 'soft', status: 'pass', stale: true } }),
      specs: [specA([{ id: 'AC-1', tier: 'soft' }])],
    };
    const sig = openSignal({ id: 'needs-rescoring:spec-a:AC-1', kind: 'needs-rescoring' });
    expect(staleSignalReason(sig, fresh)).toContain('re-scored');
    expect(staleSignalReason(sig, stillStale)).toBeNull();
  });

  it('regression/needs-review/unverifiable are stale only when the criterion currently passes', () => {
    const passing = {
      scorecard: scorecardWith({ 'AC-1': { tier: 'hard', status: 'pass' } }),
      specs: [specA([{ id: 'AC-1', tier: 'hard' }])],
    };
    const failing = {
      scorecard: scorecardWith({ 'AC-1': { tier: 'hard', status: 'fail' } }),
      specs: [specA([{ id: 'AC-1', tier: 'hard' }])],
    };
    for (const kind of ['regression', 'needs-review', 'unverifiable'] as const) {
      const sig = openSignal({ id: `${kind}:spec-a:AC-1`, kind });
      expect(staleSignalReason(sig, passing)).toContain('recovered');
      expect(staleSignalReason(sig, failing)).toBeNull();
    }
  });

  it('unverifiable with a current FAIL stays open (verified-failing is still work)', () => {
    const ctx = {
      scorecard: scorecardWith({ 'AC-1': { tier: 'hard', status: 'fail' } }),
      specs: [specA([{ id: 'AC-1', tier: 'hard' }])],
    };
    const sig = openSignal({ id: 'unverifiable:spec-a:AC-1', kind: 'unverifiable' });
    expect(staleSignalReason(sig, ctx)).toBeNull();
  });

  it('a signal for a spec in neither the scorecard nor specs/ is stale', () => {
    const ctx = { scorecard: null, specs: [] };
    expect(staleSignalReason(openSignal({}), ctx)).toBe('spec no longer exists');
  });

  it('resolved signals and unknown kinds are never swept', () => {
    const ctx = {
      scorecard: scorecardWith({ 'AC-1': { tier: 'soft', status: 'pass' } }),
      specs: [specA([{ id: 'AC-1', tier: 'soft' }])],
    };
    expect(staleSignalReason(openSignal({ status: 'resolved' }), ctx)).toBeNull();
    expect(
      staleSignalReason(
        openSignal({ kind: 'future-kind' as Signal['kind'], id: 'future-kind:spec-a:AC-1' }),
        ctx,
      ),
    ).toBeNull();
  });

  it('sweepStaleSignals markers close stale opens through mergeSignals and leave live ones', () => {
    const ctx = {
      scorecard: scorecardWith({
        'AC-1': { tier: 'soft', status: 'pass', score: 0.8 }, // answers the needs-scoring
        'AC-2': { tier: 'soft', status: 'unscored' }, // genuinely open
      }),
      specs: [
        specA([
          { id: 'AC-1', tier: 'soft' },
          { id: 'AC-2', tier: 'soft' },
        ]),
      ],
    };
    const stored: Signal[] = [
      openSignal({}),
      openSignal({ id: 'needs-scoring:spec-a:AC-2', criterionId: 'AC-2' }),
    ];
    const markers = sweepStaleSignals(stored, ctx, NOW, 'headsha');
    expect(markers).toHaveLength(1);
    expect(markers[0]!.id).toBe('needs-scoring:spec-a:AC-1');
    expect(markers[0]!.detail).toContain('auto-resolved');

    const merged = mergeSignals(stored, markers);
    const byId = new Map(merged.map((s) => [s.id, s]));
    expect(byId.get('needs-scoring:spec-a:AC-1')!.status).toBe('resolved');
    expect(byId.get('needs-scoring:spec-a:AC-1')!.resolvedAt).toBe(NOW);
    expect(byId.get('needs-scoring:spec-a:AC-2')!.status).toBe('open');
  });
});

describe('computeValidityScore — maturity weighting (v2)', () => {
  const entry = (
    level: 'probation' | 'dev' | 'team' | 'certified' | undefined,
    status: 'pass' | 'fail',
  ): ScorecardSpec => ({
    specVersion: 1,
    verdict: status === 'pass' ? 'pass' : 'fail',
    coveragePercent: 100,
    criteria: { 'AC-1': { tier: 'hard', status, at: T0 } },
    updatedAt: T0,
    ...(level ? { maturity: { level, blockersCount: 0 } } : {}),
  });
  const card = (specs: Record<string, ScorecardSpec>): Scorecard => ({
    version: 1,
    updatedAt: T0,
    specs,
  });

  it('same-rung repos score identically to v1 (the multiplier cancels)', () => {
    const uniform = computeValidityScore(
      card({ a: entry('team', 'pass'), b: entry('team', 'fail') }),
    );
    expect(uniform?.score).toBe(50);
  });

  it('a certified pass outweighs a dev fail (1.0 vs 0.6)', () => {
    const score = computeValidityScore(
      card({ a: entry('certified', 'pass'), b: entry('dev', 'fail') }),
    );
    // earned = 1.0×2; possible = 1.0×2 + 0.6×2 = 3.2 → 2/3.2 = 62.5 → 63.
    expect(score?.score).toBe(63);
  });

  it('probation specs contribute ZERO in either direction', () => {
    const withProbationFail = computeValidityScore(
      card({ a: entry('team', 'pass'), b: entry('probation', 'fail') }),
    );
    expect(withProbationFail?.score).toBe(100);
    const onlyProbation = computeValidityScore(card({ b: entry('probation', 'fail') }));
    expect(onlyProbation).toBeNull(); // zero possible weight ⇒ unmeasured
  });

  it('an uncached entry floors at team weight (never reads as certified)', () => {
    const a = computeValidityScore(card({ a: entry(undefined, 'pass'), b: entry('team', 'fail') }));
    expect(a?.score).toBe(50); // 0.9 vs 0.9 — symmetric with team
  });

  it('per-spec sub-scores stay unweighted (the pooled number carries the trust split)', () => {
    const score = computeValidityScore(card({ a: entry('dev', 'pass') }));
    expect(score?.perSpec['a']?.score).toBe(100);
  });
});

describe('reconcileScorecard — cleanStreak (certification stability input)', () => {
  const CLEAN = [{ id: 'AC-1', tier: 'hard' as const, status: 'pass' as const }];

  function tick(prev: Scorecard | null, sha: string, over: Partial<SpecObservation> = {}) {
    return reconcileScorecard({
      prev,
      now: T1,
      sha,
      observations: [obs({ criteria: CLEAN, ...over })],
    }).scorecard.specs['spec-a']!;
  }

  it('a first clean tick starts the streak at 1', () => {
    expect(tick(null, 'sha0').cleanStreak).toEqual({ count: 1, lastSha: 'sha0' });
  });

  it('increments once per DISTINCT commit, carries at the same sha', () => {
    const first = reconcileScorecard({
      prev: null,
      now: T0,
      sha: 'sha0',
      observations: [obs({ criteria: CLEAN })],
    }).scorecard;
    // Same sha, no relevant code change — an idle watcher re-tick carries.
    const idle = tick(first, 'sha0');
    expect(idle.cleanStreak).toEqual({ count: 1, lastSha: 'sha0' });
    // New sha — a real second verification counts.
    const moved = reconcileScorecard({
      prev: first,
      now: T1,
      sha: 'sha1',
      observations: [obs({ criteria: CLEAN })],
    }).scorecard.specs['spec-a']!;
    expect(moved.cleanStreak).toEqual({ count: 2, lastSha: 'sha1' });
  });

  it('same sha WITH a relevance-scoped code change still increments (uncommitted edits)', () => {
    const first = reconcileScorecard({
      prev: null,
      now: T0,
      sha: 'sha0',
      observations: [obs({ criteria: CLEAN })],
    }).scorecard;
    const edited = tick(first, 'sha0', { codeChanged: true });
    expect(edited.cleanStreak).toEqual({ count: 2, lastSha: 'sha0' });
  });

  it('any unclean tick resets the streak to nothing', () => {
    const first = reconcileScorecard({
      prev: null,
      now: T0,
      sha: 'sha0',
      observations: [obs({ criteria: CLEAN })],
    }).scorecard;
    const failed = tick(first, 'sha1', {
      criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail' }],
    });
    expect(failed.cleanStreak).toBeUndefined();
  });

  it('a tainted pass never counts as clean (signedOff refuses it)', () => {
    const entry = tick(null, 'sha0', {
      criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass', evidenceTaints: ['wrapper'] }],
    });
    expect(entry.cleanStreak).toBeUndefined();
  });

  it('a stale blocking soft score blocks the streak (freshness clause)', () => {
    // Seed a real soft pass, then a deterministic tick with moved code stales
    // it (Rule-1 carry) — signedOff still true, but the streak must not build
    // on stale evidence.
    const seeded = reconcileScorecard({
      prev: null,
      now: T0,
      sha: 'sha0',
      observations: [
        obs({
          criteria: [
            { id: 'AC-1', tier: 'hard', status: 'pass' },
            { id: 'AC-2', tier: 'soft', status: 'pass' },
          ],
        }),
      ],
    }).scorecard;
    const staled = tick(seeded, 'sha1', {
      criteria: [
        { id: 'AC-1', tier: 'hard', status: 'pass' },
        { id: 'AC-2', tier: 'soft', status: 'unscored' }, // deterministic tick can't score
      ],
    });
    expect(staled.criteria['AC-2']!.stale).toBe(true);
    expect(staled.cleanStreak).toBeUndefined();
  });

  it('an advisory criterion failing does not break the streak (it never gated)', () => {
    const entry = tick(null, 'sha0', {
      criteria: [
        { id: 'AC-1', tier: 'hard', status: 'pass' },
        { id: 'AC-2', tier: 'soft', status: 'fail', severity: 'advisory' },
      ],
    });
    expect(entry.cleanStreak).toEqual({ count: 1, lastSha: 'sha0' });
  });

  it('a re-freeze (hash change) restarts the streak at 1, never spans contracts', () => {
    let card = reconcileScorecard({
      prev: null,
      now: T0,
      sha: 'sha0',
      observations: [obs({ criteria: CLEAN })],
    }).scorecard;
    card = reconcileScorecard({
      prev: card,
      now: T0,
      sha: 'sha1',
      observations: [obs({ criteria: CLEAN })],
    }).scorecard;
    expect(card.specs['spec-a']!.cleanStreak?.count).toBe(2);
    const refrozen = tick(card, 'sha2', { specVersion: 2, specHash: 'h2' });
    expect(refrozen.cleanStreak).toEqual({ count: 1, lastSha: 'sha2' });
  });
});

describe('reconcileScorecard — renderUnchanged (byte-identical render staleness override)', () => {
  const SOFT_GATED = [
    { id: 'AC-1', tier: 'hard' as const, status: 'pass' as const },
    { id: 'AC-2', tier: 'soft' as const, status: 'pass' as const },
  ];
  const DETERMINISTIC_TICK = [
    { id: 'AC-1', tier: 'hard' as const, status: 'pass' as const },
    { id: 'AC-2', tier: 'soft' as const, status: 'unscored' as const },
  ];

  function seed(): Scorecard {
    return reconcileScorecard({
      prev: null,
      now: T0,
      sha: 'sha0',
      observations: [obs({ criteria: SOFT_GATED })],
    }).scorecard;
  }

  it('a byte-identical render at a NEW sha does not stale the soft score and advances the streak', () => {
    // The certification path for soft-gated specs: without this, every
    // distinct commit stales the blocking soft score (streak reset) and the
    // streak can never reach CERTIFICATION_STABLE_RUNS.
    const ticked = reconcileScorecard({
      prev: seed(),
      now: T1,
      sha: 'sha1',
      observations: [obs({ criteria: DETERMINISTIC_TICK, renderUnchanged: true })],
    }).scorecard.specs['spec-a']!;
    expect(ticked.criteria['AC-2']!.stale).toBeUndefined();
    expect(ticked.criteria['AC-2']!.status).toBe('pass'); // carried, fresh
    expect(ticked.cleanStreak).toEqual({ count: 2, lastSha: 'sha1' });
  });

  it('renderUnchanged wins over codeChanged=true (proof beats the file-level heuristic)', () => {
    const ticked = reconcileScorecard({
      prev: seed(),
      now: T1,
      sha: 'sha1',
      observations: [
        obs({ criteria: DETERMINISTIC_TICK, codeChanged: true, renderUnchanged: true }),
      ],
    }).scorecard.specs['spec-a']!;
    expect(ticked.criteria['AC-2']!.stale).toBeUndefined();
    expect(ticked.cleanStreak).toEqual({ count: 2, lastSha: 'sha1' });
  });

  it('renderUnchanged does NOT launder an already-stale score (cumulative rule holds)', () => {
    // Stale it first with a real code move…
    const staled = reconcileScorecard({
      prev: seed(),
      now: T1,
      sha: 'sha1',
      observations: [obs({ criteria: DETERMINISTIC_TICK, codeChanged: true })],
    }).scorecard;
    expect(staled.specs['spec-a']!.criteria['AC-2']!.stale).toBe(true);
    // …then a byte-identical tick must keep it stale until a re-score clears it.
    const after = reconcileScorecard({
      prev: staled,
      now: T1,
      sha: 'sha1',
      observations: [obs({ criteria: DETERMINISTIC_TICK, renderUnchanged: true })],
    }).scorecard.specs['spec-a']!;
    expect(after.criteria['AC-2']!.stale).toBe(true);
  });
});

describe('reconcileScorecard — Rule-1 tier guard (hard→soft re-freeze refreshes the tier)', () => {
  it('a criterion whose tier changed hard→soft is rebuilt fresh, not carried as mechanical', () => {
    // v1: AC-1 is a hard pass.
    const v1 = reconcileScorecard({
      prev: null,
      now: T0,
      sha: 'sha0',
      observations: [obs({ criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }] })],
    }).scorecard;
    // v2 re-freeze: same id, now soft. The deterministic tick emits `unscored`;
    // Rule 1 must NOT protect the prior hard entry (it is a mechanical verdict,
    // not a soft score) — the entry rebuilds with the fresh tier.
    const { scorecard, signals } = reconcileScorecard({
      prev: v1,
      now: T1,
      sha: 'sha1',
      observations: [
        obs({
          specVersion: 2,
          specHash: 'h2',
          criteria: [{ id: 'AC-1', tier: 'soft', status: 'unscored' }],
        }),
      ],
    });
    const entry = scorecard.specs['spec-a']!.criteria['AC-1']!;
    expect(entry.tier).toBe('soft');
    expect(entry.status).toBe('unscored');
    // …and the now-soft criterion is flagged as needing its first agent score.
    expect(
      signals.find((s) => s.kind === 'needs-scoring' && s.criterionId === 'AC-1'),
    ).toBeDefined();
    // The stale hard tier previously wedged applySoftScores — a valid soft
    // score must now be accepted.
    const scored = applySoftScores({
      prev: scorecard,
      specId: 'spec-a',
      scores: [{ id: 'AC-1', status: 'pass' }],
      now: T1,
      sha: 'sha1',
    });
    expect(scored.applied).toEqual(['AC-1']);
    expect(scored.rejected).toEqual([]);
  });
});

describe('applySoftScores — cleanStreak fold (certification stability)', () => {
  const entryWith = (streak?: { count: number; lastSha?: string }): Scorecard => ({
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-a': {
        specVersion: 1,
        specHash: 'h1',
        verdict: 'partial',
        coveragePercent: 100,
        ...(streak ? { cleanStreak: streak } : {}),
        criteria: {
          'AC-1': crit({ tier: 'hard', status: 'pass', sha: 'sha0' }),
          'AC-2': crit({ tier: 'soft', status: 'unscored', sha: 'sha0' }),
        },
        updatedAt: T0,
      },
    },
  });

  it('a fresh score that makes the spec clean starts the streak at 1', () => {
    const { scorecard } = applySoftScores({
      prev: entryWith(undefined),
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass' }],
      now: T1,
      sha: 'sha1',
    });
    expect(scorecard.specs['spec-a']!.cleanStreak).toEqual({ count: 1, lastSha: 'sha1' });
  });

  it('advances the streak at a DISTINCT sha, carries at the same sha', () => {
    const advanced = applySoftScores({
      prev: entryWith({ count: 1, lastSha: 'sha0' }),
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass' }],
      now: T1,
      sha: 'sha1',
    });
    expect(advanced.scorecard.specs['spec-a']!.cleanStreak).toEqual({
      count: 2,
      lastSha: 'sha1',
    });
    const carried = applySoftScores({
      prev: entryWith({ count: 1, lastSha: 'sha0' }),
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'pass' }],
      now: T1,
      sha: 'sha0',
    });
    expect(carried.scorecard.specs['spec-a']!.cleanStreak).toEqual({
      count: 1,
      lastSha: 'sha0',
    });
  });

  it('a failing score resets the streak', () => {
    const { scorecard } = applySoftScores({
      prev: entryWith({ count: 2, lastSha: 'sha0' }),
      specId: 'spec-a',
      scores: [{ id: 'AC-2', status: 'fail' }],
      now: T1,
      sha: 'sha1',
    });
    expect(scorecard.specs['spec-a']!.cleanStreak).toBeUndefined();
  });
});

// Issue #17: soft criteria with no scoring.judgeModel accumulate
// needs-(re)scoring signals that can NEVER drain — the gap must be a
// first-class standing signal, not a silence.
describe('judge-gap standing signal (issue #17)', () => {
  const specs = [
    {
      status: 'frozen',
      criteria: [{ tier: 'soft' }, { tier: 'soft' }, { tier: 'hard' }],
    },
    { status: 'frozen', criteria: [{ tier: 'soft' }] },
    // Draft specs are untracked — their soft criteria don't count.
    { status: 'draft', criteria: [{ tier: 'soft' }] },
  ];

  it('countTrackedSoftCriteria counts soft criteria across FROZEN specs only', () => {
    expect(countTrackedSoftCriteria(specs)).toBe(3);
    expect(countTrackedSoftCriteria([])).toBe(0);
  });

  it('judgeGapWarning names the count and the one-line fix', () => {
    expect(judgeGapWarning(24)).toBe(
      'no judge configured — 24 soft criteria can never re-score; add scoring.judgeModel to .validity/config.ts',
    );
    expect(judgeGapWarning(1)).toContain('1 soft criterion can never re-score');
  });

  it('opens the standing signal when soft criteria exist and no judge is configured', () => {
    const fresh = judgeGapSignals({
      existing: [],
      judgeConfigured: false,
      softCriteria: 3,
      now: '2026-07-22T10:00:00.000Z',
      sha: 'abc1234',
    });
    expect(fresh).toHaveLength(1);
    const s = fresh[0]!;
    expect(s.id).toBe(JUDGE_GAP_SIGNAL_ID);
    expect(s.kind).toBe('judge-gap');
    expect(s.severity).toBe('medium');
    expect(s.specId).toBe('*');
    expect(s.status).toBe('open');
    expect(s.detail).toBe(judgeGapWarning(3));
  });

  it('re-fires update in place and preserve openedAt through mergeSignals', () => {
    const first = judgeGapSignals({
      existing: [],
      judgeConfigured: false,
      softCriteria: 2,
      now: '2026-07-22T10:00:00.000Z',
    });
    const ledger = mergeSignals([], first);
    const second = judgeGapSignals({
      existing: ledger,
      judgeConfigured: false,
      softCriteria: 5,
      now: '2026-07-22T11:00:00.000Z',
    });
    const merged = mergeSignals(ledger, second);
    const open = merged.filter((s) => s.id === JUDGE_GAP_SIGNAL_ID);
    expect(open).toHaveLength(1);
    expect(open[0]!.openedAt).toBe('2026-07-22T10:00:00.000Z');
    expect(open[0]!.detail).toBe(judgeGapWarning(5));
  });

  it('resolves the open signal once a judge is configured', () => {
    const ledger = mergeSignals(
      [],
      judgeGapSignals({
        existing: [],
        judgeConfigured: false,
        softCriteria: 3,
        now: '2026-07-22T10:00:00.000Z',
      }),
    );
    const fresh = judgeGapSignals({
      existing: ledger,
      judgeConfigured: true,
      softCriteria: 3,
      now: '2026-07-22T12:00:00.000Z',
    });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.status).toBe('resolved');
    expect(fresh[0]!.resolvedAt).toBe('2026-07-22T12:00:00.000Z');
    const merged = mergeSignals(ledger, fresh);
    expect(merged.find((s) => s.id === JUDGE_GAP_SIGNAL_ID)!.status).toBe('resolved');
  });

  it('emits nothing when there is no gap and nothing open (steady state)', () => {
    expect(
      judgeGapSignals({
        existing: [],
        judgeConfigured: true,
        softCriteria: 3,
        now: '2026-07-22T10:00:00.000Z',
      }),
    ).toEqual([]);
    // No soft criteria tracked = no gap either, judge or not.
    expect(
      judgeGapSignals({
        existing: [],
        judgeConfigured: false,
        softCriteria: 0,
        now: '2026-07-22T10:00:00.000Z',
      }),
    ).toEqual([]);
  });

  it('staleSignalReason NEVER auto-closes it (the "*" specId matches no spec)', () => {
    const [open] = judgeGapSignals({
      existing: [],
      judgeConfigured: false,
      softCriteria: 3,
      now: '2026-07-22T10:00:00.000Z',
    });
    // Empty context: any spec-keyed signal would be "spec no longer exists".
    expect(staleSignalReason(open!, { scorecard: null, specs: [] })).toBeNull();
    expect(
      sweepStaleSignals([open!], { scorecard: null, specs: [] }, '2026-07-22T10:01:00.000Z'),
    ).toEqual([]);
  });
});
