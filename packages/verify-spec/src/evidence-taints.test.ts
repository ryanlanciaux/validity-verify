/**
 * Evidence-taint truth tables + the belt-and-braces sign-off/rollup guards
 * (A3). These are gate-integrity heart: a false green here would let a tainted
 * pass (network/wrapper/unconfirmed-render) launder up to `pass`/signed-off. The
 * one PROVENANCE-ONLY taint, `synthetic-data`, must NEVER demote — every case
 * below pins that boundary.
 */
import { describe, expect, it } from 'vitest';
import {
  DEMOTING_EVIDENCE_TAINTS,
  applyEvidenceTaints,
  demotingTaintsOf,
  evidenceTaintSchema,
  evidenceTaintsOf,
  isCatchAllPattern,
  rollupNetworkProvenance,
  withEvidenceTaint,
  type NetworkEvidence,
} from './spec-schema.js';
import {
  computeSignedOff,
  rollupCriterionVerdicts,
  rollupScorecardVerdict,
  type ScorecardCriterion,
} from './scorecard.js';

describe('DEMOTING_EVIDENCE_TAINTS', () => {
  it('demotes network/wrapper/unconfirmed-render/dep-scan/data-state but NOT synthetic-data', () => {
    expect(DEMOTING_EVIDENCE_TAINTS.has('network')).toBe(true);
    expect(DEMOTING_EVIDENCE_TAINTS.has('wrapper')).toBe(true);
    expect(DEMOTING_EVIDENCE_TAINTS.has('unconfirmed-render')).toBe(true);
    expect(DEMOTING_EVIDENCE_TAINTS.has('dep-scan')).toBe(true);
    expect(DEMOTING_EVIDENCE_TAINTS.has('data-state')).toBe(true);
    expect(DEMOTING_EVIDENCE_TAINTS.has('synthetic-data')).toBe(false);
  });

  it('every taint but synthetic-data demotes — a new kind is demoting unless argued otherwise', () => {
    for (const taint of evidenceTaintSchema.options) {
      expect(DEMOTING_EVIDENCE_TAINTS.has(taint)).toBe(taint !== 'synthetic-data');
    }
  });
});

describe('evidenceTaintsOf', () => {
  it('empty for a bare verdict', () => {
    expect(evidenceTaintsOf({})).toEqual([]);
  });

  it('normalizes the legacy networkTainted boolean to network', () => {
    expect(evidenceTaintsOf({ networkTainted: true })).toEqual(['network']);
  });

  it('passes the list through', () => {
    expect(evidenceTaintsOf({ evidenceTaints: ['wrapper'] })).toEqual(['wrapper']);
  });

  it('dedupes the legacy boolean against an explicit network entry', () => {
    expect(evidenceTaintsOf({ evidenceTaints: ['network'], networkTainted: true })).toEqual([
      'network',
    ]);
  });

  it('dedupes repeats within the list', () => {
    expect(evidenceTaintsOf({ evidenceTaints: ['wrapper', 'wrapper'] })).toEqual(['wrapper']);
  });

  it('appends the legacy boolean after the list entries', () => {
    expect(evidenceTaintsOf({ evidenceTaints: ['wrapper'], networkTainted: true })).toEqual([
      'wrapper',
      'network',
    ]);
  });
});

describe('demotingTaintsOf', () => {
  it('drops synthetic-data (provenance-only)', () => {
    expect(demotingTaintsOf({ evidenceTaints: ['synthetic-data'] })).toEqual([]);
  });

  it('keeps only the demoting subset', () => {
    expect(demotingTaintsOf({ evidenceTaints: ['synthetic-data', 'wrapper'] })).toEqual([
      'wrapper',
    ]);
  });

  it('reads the legacy boolean as network', () => {
    expect(demotingTaintsOf({ networkTainted: true })).toEqual(['network']);
  });
});

describe('applyEvidenceTaints — the one lattice clamp', () => {
  it('fail stays fail regardless of taints', () => {
    expect(applyEvidenceTaints('fail', ['wrapper'])).toBe('fail');
    expect(applyEvidenceTaints('fail', [])).toBe('fail');
  });

  it('a clean pass stays pass', () => {
    expect(applyEvidenceTaints('pass', [])).toBe('pass');
  });

  it('pass + synthetic-data stays pass (PROVENANCE-ONLY)', () => {
    expect(applyEvidenceTaints('pass', ['synthetic-data'])).toBe('pass');
  });

  it('pass + any demoting taint becomes unverifiable', () => {
    expect(applyEvidenceTaints('pass', ['wrapper'])).toBe('unverifiable');
    expect(applyEvidenceTaints('pass', ['network'])).toBe('unverifiable');
    expect(applyEvidenceTaints('pass', ['unconfirmed-render'])).toBe('unverifiable');
    expect(applyEvidenceTaints('pass', ['synthetic-data', 'wrapper'])).toBe('unverifiable');
  });

  it('unverifiable stays unverifiable', () => {
    expect(applyEvidenceTaints('unverifiable', ['wrapper'])).toBe('unverifiable');
    expect(applyEvidenceTaints('unverifiable', [])).toBe('unverifiable');
  });
});

describe('withEvidenceTaint', () => {
  it('seeds a list from undefined', () => {
    expect(withEvidenceTaint(undefined, 'wrapper')).toEqual(['wrapper']);
  });

  it('appends a new taint', () => {
    expect(withEvidenceTaint(['wrapper'], 'network')).toEqual(['wrapper', 'network']);
  });

  it('is idempotent — never adds a duplicate', () => {
    expect(withEvidenceTaint(['wrapper'], 'wrapper')).toEqual(['wrapper']);
  });

  it('does not mutate its input', () => {
    const input: Array<'wrapper'> = ['wrapper'];
    withEvidenceTaint(input, 'wrapper');
    expect(input).toEqual(['wrapper']);
  });
});

describe('isCatchAllPattern', () => {
  it('true for pure wildcards', () => {
    expect(isCatchAllPattern('*')).toBe(true);
    expect(isCatchAllPattern('/*')).toBe(true);
    expect(isCatchAllPattern('**')).toBe(true);
    expect(isCatchAllPattern('http://*')).toBe(true);
    expect(isCatchAllPattern('https://*')).toBe(true);
  });

  it('false for endpoint-specific patterns', () => {
    expect(isCatchAllPattern('/api/*')).toBe(false);
    expect(isCatchAllPattern('/api/users')).toBe(false);
    expect(isCatchAllPattern('http://example.test/api')).toBe(false);
    expect(isCatchAllPattern('https://*.example.com')).toBe(false);
  });

  it('false for an empty pattern', () => {
    expect(isCatchAllPattern('')).toBe(false);
    expect(isCatchAllPattern('   ')).toBe(false);
  });
});

describe('rollupNetworkProvenance (A4)', () => {
  const ev = (provenance: NetworkEvidence['provenance']): NetworkEvidence => ({
    provenance,
    method: 'GET',
    url: '/api/x',
    status: 200,
  });

  it('undefined for an empty list (no network expects)', () => {
    expect(rollupNetworkProvenance([])).toBeUndefined();
  });

  it('all declared → declared; all live → live; declared+live → mixed', () => {
    expect(rollupNetworkProvenance([ev('declared'), ev('declared')])).toBe('declared');
    expect(rollupNetworkProvenance([ev('live'), ev('live')])).toBe('live');
    expect(rollupNetworkProvenance([ev('declared'), ev('live')])).toBe('mixed');
  });

  it('any fabricated wins outright — even next to declared or a missing entry', () => {
    expect(rollupNetworkProvenance([ev('declared'), ev('fabricated')])).toBe('fabricated');
    expect(rollupNetworkProvenance([undefined, ev('fabricated')])).toBe('fabricated');
  });

  it("CAN'T FALSE-GREEN: a missing entry blocks every positive claim (old data never reads declared)", () => {
    expect(rollupNetworkProvenance([ev('declared'), undefined])).toBeUndefined();
    expect(rollupNetworkProvenance([undefined])).toBeUndefined();
  });
});

describe('taint guards — cannot false-green', () => {
  it('computeSignedOff: a blocking pass with a demoting taint does NOT sign off', () => {
    expect(computeSignedOff([{ tier: 'hard', status: 'pass', evidenceTaints: ['wrapper'] }])).toBe(
      false,
    );
  });

  it('computeSignedOff: a blocking pass with synthetic-data alone still signs off', () => {
    expect(
      computeSignedOff([{ tier: 'hard', status: 'pass', evidenceTaints: ['synthetic-data'] }]),
    ).toBe(true);
  });

  it('computeSignedOff: an advisory taint never blocks', () => {
    expect(
      computeSignedOff([
        { tier: 'hard', status: 'pass', severity: 'advisory', evidenceTaints: ['wrapper'] },
      ]),
    ).toBe(true);
  });

  it('rollupCriterionVerdicts: a demoting-tainted pass rolls up to partial, not pass', () => {
    expect(
      rollupCriterionVerdicts([{ tier: 'hard', status: 'pass', evidenceTaints: ['wrapper'] }]),
    ).toBe('partial');
  });

  it('rollupCriterionVerdicts: the legacy networkTainted boolean also blocks green', () => {
    expect(rollupCriterionVerdicts([{ tier: 'hard', status: 'pass', networkTainted: true }])).toBe(
      'partial',
    );
  });

  it('rollupCriterionVerdicts: synthetic-data alone still rolls up to pass', () => {
    expect(
      rollupCriterionVerdicts([
        { tier: 'hard', status: 'pass', evidenceTaints: ['synthetic-data'] },
      ]),
    ).toBe('pass');
  });

  it('rollupScorecardVerdict: a demoting-tainted pass is not green', () => {
    const crit: ScorecardCriterion = {
      tier: 'hard',
      status: 'pass',
      at: '2026-07-01T00:00:00.000Z',
      evidenceTaints: ['wrapper'],
    };
    expect(rollupScorecardVerdict({ a: crit })).toBe('partial');
  });

  it('rollupScorecardVerdict: synthetic-data alone is still green', () => {
    const crit: ScorecardCriterion = {
      tier: 'hard',
      status: 'pass',
      at: '2026-07-01T00:00:00.000Z',
      evidenceTaints: ['synthetic-data'],
    };
    expect(rollupScorecardVerdict({ a: crit })).toBe('pass');
  });
});
