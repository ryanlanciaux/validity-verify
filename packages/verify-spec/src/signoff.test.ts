/**
 * Tests for the loop's single stop rule (`computeSignedOff`) and the verify-time
 * verdict rollup (`rollupCriterionVerdicts`). These are the gate-integrity
 * heart: a false green here would let the loop call un-finished work "done", so
 * the cases below pin the conservative defaults (empty ⇒ not done, unscored /
 * unverifiable never pass, advisory criteria never block).
 */
import { describe, expect, it } from 'vitest';
import {
  computeSignedOff,
  rollupCriterionVerdicts,
  selfScoredSignOffBlockers,
  type SignOffCriterion,
} from './scorecard.js';

function so(over: Partial<SignOffCriterion> = {}): SignOffCriterion {
  return { tier: 'hard', status: 'pass', ...over };
}

describe('computeSignedOff', () => {
  it('false for an empty list — nothing verified is never "done"', () => {
    expect(computeSignedOff([])).toBe(false);
  });

  it('true when every blocking criterion passes', () => {
    expect(computeSignedOff([so(), so({ tier: 'property' }), so({ tier: 'soft' })])).toBe(true);
  });

  it('false when a blocking hard criterion fails', () => {
    expect(computeSignedOff([so({ status: 'fail' }), so()])).toBe(false);
  });

  it('unscored never counts as pass (false-green impossible)', () => {
    expect(computeSignedOff([so({ tier: 'soft', status: 'unscored' })])).toBe(false);
  });

  it('unverifiable never counts as pass', () => {
    expect(computeSignedOff([so({ status: 'unverifiable' })])).toBe(false);
  });

  it('advisory criteria are ignored — they may fail without blocking sign-off', () => {
    expect(computeSignedOff([so(), so({ status: 'fail', severity: 'advisory' })])).toBe(true);
  });

  it('a list of ONLY advisory criteria still signs off (none block)', () => {
    expect(computeSignedOff([so({ status: 'fail', severity: 'advisory' })])).toBe(true);
  });

  it('blocking soft below its threshold fails even when status is pass', () => {
    expect(
      computeSignedOff([so({ tier: 'soft', status: 'pass', softThreshold: 0.8, score: 0.5 })]),
    ).toBe(false);
  });

  it('blocking soft at or above its threshold passes', () => {
    expect(
      computeSignedOff([so({ tier: 'soft', status: 'pass', softThreshold: 0.8, score: 0.8 })]),
    ).toBe(true);
  });

  it('soft threshold is ignored when no numeric score was supplied (status governs)', () => {
    expect(computeSignedOff([so({ tier: 'soft', status: 'pass', softThreshold: 0.8 })])).toBe(true);
  });

  it('an advisory soft below threshold does not block', () => {
    expect(
      computeSignedOff([
        so(),
        so({ tier: 'soft', status: 'pass', softThreshold: 0.9, score: 0.1, severity: 'advisory' }),
      ]),
    ).toBe(true);
  });

  describe('requireFreshJudge (A6/1.5, opt-in — default OFF)', () => {
    it('knob OFF (opts omitted): a selfScored soft pass signs off as before — regression guard', () => {
      expect(computeSignedOff([so({ tier: 'soft', status: 'pass', selfScored: true })])).toBe(true);
    });

    it('knob OFF explicitly ({ requireFreshJudge: false }): same as omitted', () => {
      expect(
        computeSignedOff([so({ tier: 'soft', status: 'pass', selfScored: true })], {
          requireFreshJudge: false,
        }),
      ).toBe(true);
    });

    it('knob ON + a blocking selfScored soft pass: does NOT sign off', () => {
      expect(
        computeSignedOff([so({ tier: 'soft', status: 'pass', selfScored: true })], {
          requireFreshJudge: true,
        }),
      ).toBe(false);
    });

    it('knob ON + a fresh/model-judged soft pass (selfScored: false): signs off', () => {
      expect(
        computeSignedOff([so({ tier: 'soft', status: 'pass', selfScored: false })], {
          requireFreshJudge: true,
        }),
      ).toBe(true);
    });

    it('knob ON + selfScored undefined (hard/property, or a soft criterion never stamped): signs off', () => {
      expect(
        computeSignedOff([so(), so({ tier: 'soft', status: 'pass' })], { requireFreshJudge: true }),
      ).toBe(true);
    });

    it('knob ON + an ADVISORY selfScored soft pass: still does not block (advisory never blocks)', () => {
      expect(
        computeSignedOff(
          [so(), so({ tier: 'soft', status: 'pass', selfScored: true, severity: 'advisory' })],
          { requireFreshJudge: true },
        ),
      ).toBe(true);
    });

    it('knob ON + a selfScored soft FAIL: still fails on status, same reason as always', () => {
      expect(
        computeSignedOff([so({ tier: 'soft', status: 'fail', selfScored: true })], {
          requireFreshJudge: true,
        }),
      ).toBe(false);
    });

    it('interaction with taint clamps: a demoting-tainted pass is refused before selfScored is even consulted', () => {
      expect(
        computeSignedOff(
          [
            so({
              tier: 'soft',
              status: 'pass',
              selfScored: false,
              evidenceTaints: ['wrapper'],
            }),
          ],
          { requireFreshJudge: true },
        ),
      ).toBe(false);
    });

    it('never mutates the input criteria — only the boolean answer changes', () => {
      const criteria = [so({ tier: 'soft', status: 'pass', selfScored: true })];
      const snapshot = JSON.stringify(criteria);
      computeSignedOff(criteria, { requireFreshJudge: true });
      expect(JSON.stringify(criteria)).toBe(snapshot);
    });
  });

  describe('selfScoredSignOffBlockers', () => {
    it('empty when nothing is selfScored', () => {
      expect(selfScoredSignOffBlockers([so(), so({ tier: 'soft', status: 'pass' })])).toEqual([]);
    });

    it('lists blocking soft PASSES that are selfScored', () => {
      const blocker = so({ tier: 'soft', status: 'pass', selfScored: true });
      expect(selfScoredSignOffBlockers([so(), blocker])).toEqual([blocker]);
    });

    it('excludes a selfScored soft FAIL (status already blocks for another reason)', () => {
      expect(
        selfScoredSignOffBlockers([so({ tier: 'soft', status: 'fail', selfScored: true })]),
      ).toEqual([]);
    });

    it('excludes an ADVISORY selfScored soft pass (never blocks)', () => {
      expect(
        selfScoredSignOffBlockers([
          so({ tier: 'soft', status: 'pass', selfScored: true, severity: 'advisory' }),
        ]),
      ).toEqual([]);
    });

    it('excludes hard/property criteria (selfScored is soft-only)', () => {
      expect(selfScoredSignOffBlockers([so({ selfScored: true })])).toEqual([]);
    });
  });
});

describe('rollupCriterionVerdicts', () => {
  it('unverifiable for an empty list (nothing decided)', () => {
    expect(rollupCriterionVerdicts([])).toBe('unverifiable');
  });

  it('pass only when every verdict passes', () => {
    expect(
      rollupCriterionVerdicts([
        { tier: 'hard', status: 'pass' },
        { tier: 'soft', status: 'pass' },
      ]),
    ).toBe('pass');
  });

  it('fail dominates when a hard/property verdict fails', () => {
    expect(
      rollupCriterionVerdicts([
        { tier: 'hard', status: 'fail' },
        { tier: 'soft', status: 'pass' },
      ]),
    ).toBe('fail');
  });

  it('a SOFT fail does not force fail — it rolls up to partial', () => {
    expect(
      rollupCriterionVerdicts([
        { tier: 'hard', status: 'pass' },
        { tier: 'soft', status: 'fail' },
      ]),
    ).toBe('partial');
  });

  it('unverifiable when every verdict is unverifiable', () => {
    expect(
      rollupCriterionVerdicts([
        { tier: 'hard', status: 'unverifiable' },
        { tier: 'property', status: 'unverifiable' },
      ]),
    ).toBe('unverifiable');
  });

  it('partial for a mix of pass and unverifiable with no hard fail', () => {
    expect(
      rollupCriterionVerdicts([
        { tier: 'hard', status: 'pass' },
        { tier: 'soft', status: 'unverifiable' },
      ]),
    ).toBe('partial');
  });
});
