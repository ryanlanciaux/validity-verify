/**
 * Verify → scorecard fold (scorecard-fold.ts). The load-bearing invariants:
 * soft criteria land `unscored` (NEVER verify's `unverifiable` placeholder, so
 * Rule 1 protects a real prior agent score), hard/property verdicts map 1:1,
 * taints flow through normalized, and — WATCH PARITY — the fold feeds
 * reconcileScorecard the exact observation shape a `validity watch` tick does,
 * so the two soft-scoring paths converge on identical scorecard entries.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  foldVerifyIntoScorecard,
  observationConfirmsProbationClear,
  observationFromVerdicts,
} from './scorecard-fold.js';
import {
  applySoftScores,
  loadScorecard,
  loadSignals,
  reconcileScorecard,
  saveScorecard,
  scorecardPath,
  signalsPath,
  type SpecObservation,
} from './scorecard.js';
import {
  evidenceTaintsOf,
  type CriterionVerdict,
  type EvidenceTaint,
  type Spec,
} from './spec-schema.js';
import { readSpec, writeSpec } from './specs.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';

/** Frozen spec with one criterion per tier; soft carries sign-off weights. */
function spec(over: Partial<Spec> = {}): Spec {
  return {
    id: 'spec-fold',
    version: 3,
    status: 'frozen',
    hash: 'hash-fold-1',
    source: { prompt: 'build the widget', createdBy: 'agent' },
    criteria: [
      {
        id: 'AC-1',
        text: 'renders without console errors',
        tier: 'hard',
        checks: [{ expect: { console: { errors: 0 } } }],
      },
      {
        id: 'AC-2',
        text: 'looks polished',
        tier: 'soft',
        severity: 'advisory',
        softThreshold: 0.8,
      },
      { id: 'AC-3', text: 'list order is stable', tier: 'property' },
    ],
    createdAt: T0,
    ...over,
  };
}

describe('observationFromVerdicts (pure)', () => {
  it('echoes specId/specVersion/specHash from the frozen spec', () => {
    const obs = observationFromVerdicts(spec(), []);
    expect(obs.specId).toBe('spec-fold');
    expect(obs.specVersion).toBe(3);
    expect(obs.specHash).toBe('hash-fold-1');
  });

  it("maps a soft verdict's `unverifiable` PLACEHOLDER to `unscored`, carrying its taints + the frozen weights", () => {
    const verdicts: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      {
        id: 'AC-2',
        tier: 'soft',
        status: 'unverifiable', // run.ts soft placeholder — must NOT flow through
        evidenceTaints: ['wrapper'],
      },
      { id: 'AC-3', tier: 'property', status: 'pass' },
    ];
    const soft = observationFromVerdicts(spec(), verdicts).criteria.find((c) => c.id === 'AC-2')!;
    expect(soft.status).toBe('unscored');
    expect(soft.severity).toBe('advisory');
    expect(soft.softThreshold).toBe(0.8);
    expect(soft.evidenceTaints).toEqual(['wrapper']);
  });

  it('an untainted soft placeholder carries NO evidenceTaints key (watch parity)', () => {
    const verdicts: CriterionVerdict[] = [{ id: 'AC-2', tier: 'soft', status: 'unverifiable' }];
    const soft = observationFromVerdicts(spec(), verdicts).criteria.find((c) => c.id === 'AC-2')!;
    expect('evidenceTaints' in soft).toBe(false);
  });

  it('hard/property statuses map 1:1 with detail', () => {
    for (const status of ['pass', 'fail', 'unverifiable'] as const) {
      const obs = observationFromVerdicts(spec(), [
        { id: 'AC-1', tier: 'hard', status, detail: `d-${status}` },
      ]);
      const hard = obs.criteria.find((c) => c.id === 'AC-1')!;
      expect(hard.status).toBe(status);
      expect(hard.detail).toBe(`d-${status}`);
      expect(hard.tier).toBe('hard');
    }
  });

  it("normalizes a legacy networkTainted-only verdict to evidenceTaints ['network']", () => {
    const obs = observationFromVerdicts(spec(), [
      { id: 'AC-1', tier: 'hard', status: 'unverifiable', networkTainted: true },
    ]);
    expect(obs.criteria.find((c) => c.id === 'AC-1')!.evidenceTaints).toEqual(['network']);
  });

  it("a criterion with no verdict is `unverifiable` — 'no mechanical verdict produced' (never silently dropped)", () => {
    const obs = observationFromVerdicts(spec(), [{ id: 'AC-1', tier: 'hard', status: 'pass' }]);
    const prop = obs.criteria.find((c) => c.id === 'AC-3')!;
    expect(prop.status).toBe('unverifiable');
    expect(prop.detail).toBe('no mechanical verdict produced');
    // The whole frozen contract is observed, in spec order.
    expect(obs.criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3']);
  });
});

describe('foldVerifyIntoScorecard (IO shell)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-fold-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const VERDICTS: CriterionVerdict[] = [
    { id: 'AC-1', tier: 'hard', status: 'pass', detail: '0 console errors' },
    { id: 'AC-2', tier: 'soft', status: 'unverifiable' },
    { id: 'AC-3', tier: 'property', status: 'fail', detail: 'order flipped' },
  ];

  it('creates scorecard.json matching reconcileScorecard, and persists needs-scoring signals', () => {
    const result = foldVerifyIntoScorecard(projectRoot, {
      spec: spec(),
      verdicts: VERDICTS,
      sha: 'sha-1',
      now: T1,
    });
    expect(result).toBeDefined();
    expect(existsSync(scorecardPath(projectRoot))).toBe(true);

    // What landed on disk must be byte-for-byte what the reducer computed.
    const expected = reconcileScorecard({
      prev: null,
      observations: [observationFromVerdicts(spec(), VERDICTS)],
      now: T1,
      sha: 'sha-1',
    });
    const onDisk = JSON.parse(readFileSync(scorecardPath(projectRoot), 'utf-8'));
    expect(onDisk).toEqual(expected.scorecard);

    const entry = onDisk.specs['spec-fold'];
    expect(entry.verdict).toBe('fail'); // AC-3 (property) failed mechanically
    expect(entry.signedOff).toBe(false);
    expect(entry.coveragePercent).toBe(100); // both hard/property decided
    expect(entry.validityScore).toBe(expected.scorecard.specs['spec-fold']!.validityScore);
    expect(entry.criteria['AC-2'].status).toBe('unscored');

    // The needs-scoring signal for the unscored soft criterion reached signals.json.
    expect(existsSync(signalsPath(projectRoot))).toBe(true);
    const signals = loadSignals(projectRoot);
    expect(signals.some((s) => s.kind === 'needs-scoring' && s.criterionId === 'AC-2')).toBe(true);
  });

  it("RULE-1 GUARD: a re-fold's soft placeholder never stomps a prior agent score; sha movement flags stale", () => {
    foldVerifyIntoScorecard(projectRoot, {
      spec: spec(),
      verdicts: VERDICTS,
      sha: 'sha-1',
      now: T0,
    });

    // Agent scores the soft criterion.
    const scored = applySoftScores({
      prev: loadScorecard(projectRoot)!,
      specId: 'spec-fold',
      scores: [{ id: 'AC-2', status: 'pass', detail: 'looks great', score: 0.9 }],
      now: T1,
      sha: 'sha-1',
    });
    saveScorecard(projectRoot, scored.scorecard);

    // Re-fold at the SAME sha: the pass survives, not stale.
    foldVerifyIntoScorecard(projectRoot, {
      spec: spec(),
      verdicts: VERDICTS,
      sha: 'sha-1',
      now: T1,
    });
    let soft = loadScorecard(projectRoot)!.specs['spec-fold']!.criteria['AC-2']!;
    expect(soft.status).toBe('pass');
    expect(soft.score).toBe(0.9);
    expect(soft.stale).toBeUndefined();

    // Re-fold after the code MOVED: score carried, flagged stale.
    foldVerifyIntoScorecard(projectRoot, {
      spec: spec(),
      verdicts: VERDICTS,
      sha: 'sha-2',
      now: T2,
    });
    soft = loadScorecard(projectRoot)!.specs['spec-fold']!.criteria['AC-2']!;
    expect(soft.status).toBe('pass');
    expect(soft.stale).toBe(true);
    expect(
      loadSignals(projectRoot).some(
        (s) => s.kind === 'needs-rescoring' && s.criterionId === 'AC-2' && s.status === 'open',
      ),
    ).toBe(true);
  });

  it('#5 does NOT fold a DRAFT spec (drafts stay out of the durable scorecard)', () => {
    const before = loadScorecard(projectRoot);
    const result = foldVerifyIntoScorecard(projectRoot, {
      spec: spec({ status: 'draft', hash: undefined }),
      verdicts: VERDICTS,
    });
    // The receipt says so out loud (B1) instead of returning a silent undefined.
    expect(result.written).toBe(false);
    expect(result.reason).toBe('draft-spec');
    expect(result.scorecard).toBeUndefined();
    // Scorecard on disk is untouched — no hashless, signed-off draft entry.
    expect(loadScorecard(projectRoot)).toEqual(before);
  });

  it('stamps the maturity cache when an assessment is injected, and emits maturity-drop on a fall', () => {
    foldVerifyIntoScorecard(projectRoot, {
      spec: spec(),
      verdicts: VERDICTS,
      now: T0,
      assessMaturity: () => ({ level: 'certified', blockers: [] }),
    });
    expect(loadScorecard(projectRoot)!.specs['spec-fold']!.maturity).toEqual({
      level: 'certified',
      blockersCount: 0,
      blockers: [],
    });

    // A later fold that derives lower stamps the new level + records the drop.
    foldVerifyIntoScorecard(projectRoot, {
      spec: spec(),
      verdicts: VERDICTS,
      now: T1,
      assessMaturity: () => ({
        level: 'team',
        blockers: [{ kind: 'stability-pending', detail: '1/2 consecutive clean verifications' }],
      }),
    });
    expect(loadScorecard(projectRoot)!.specs['spec-fold']!.maturity?.level).toBe('team');
    const drop = loadSignals(projectRoot).find((s) => s.kind === 'maturity-drop');
    expect(drop).toMatchObject({ status: 'resolved', specId: 'spec-fold' });
    expect(drop?.detail).toContain('certified → team');

    // A fold WITHOUT an assessment carries the cache forward untouched.
    foldVerifyIntoScorecard(projectRoot, { spec: spec(), verdicts: VERDICTS, now: T2 });
    expect(loadScorecard(projectRoot)!.specs['spec-fold']!.maturity?.level).toBe('team');
  });

  it('a same-fold probation clear assesses the LIFTED spec (no one-tick level lag)', () => {
    // All-blocking-hard spec on probation, passing clean — the fold both
    // clears probation AND must stamp the post-clear level in the same call.
    const probSpec = spec({
      runtime: 'web',
      probation: { since: T0 },
      criteria: [
        {
          id: 'AC-1',
          text: 'renders without console errors',
          tier: 'hard',
          checks: [{ expect: { console: { errors: 0 } } }],
        },
      ],
    });
    writeSpec(projectRoot, probSpec);
    const seen: Array<boolean> = [];
    foldVerifyIntoScorecard(projectRoot, {
      spec: probSpec,
      verdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
      now: T1,
      assessMaturity: (s) => {
        seen.push(Boolean(s.probation));
        return s.probation
          ? { level: 'probation', blockers: [{ kind: 'probation-unclear', detail: 'x' }] }
          : { level: 'team', blockers: [{ kind: 'never-verified', detail: 'verify' }] };
      },
    });
    // The callback saw the spec WITHOUT the probation marker…
    expect(seen).toEqual([false]);
    // …the marker is genuinely cleared on disk…
    expect(readSpec(projectRoot, probSpec.id)?.probation).toBeUndefined();
    // …and the stamped cache reflects the lifted level immediately.
    expect(loadScorecard(projectRoot)!.specs[probSpec.id]!.maturity?.level).toBe('team');
  });

  it('never throws on an unwritable root — verify must not fail on a scorecard write failure', () => {
    // A "projectRoot" that is a regular FILE: mkdir of .validity under it
    // fails with ENOTDIR, so the fold's IO shell must swallow the throw and
    // report it as an unwritten receipt instead of failing the verify handler.
    const blocker = resolve(projectRoot, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const result = foldVerifyIntoScorecard(blocker, { spec: spec(), verdicts: VERDICTS });
    expect(result.written).toBe(false);
    expect(result.reason).toBe('io-error');
    expect(result.error).toBeTruthy();
  });
});

describe('WATCH PARITY — verify fold and watch tick produce identical spec entries', () => {
  it('same spec + equivalent mechanical results through both shapes → deep-equal entries', () => {
    const s = spec();
    const mechanical = [
      {
        id: 'AC-1',
        status: 'pass' as const,
        detail: '0 console errors',
        evidenceTaints: undefined,
        networkTainted: undefined,
      },
      {
        id: 'AC-3',
        status: 'unverifiable' as const,
        detail: 'selector had no usable field',
        evidenceTaints: ['network' as const],
        networkTainted: undefined,
      },
    ];

    // The watch shape — field-for-field what observeOnce builds (watch.ts).
    const byId = new Map(mechanical.map((m) => [m.id, m]));
    const wrapperDegraded = true;
    const watchObs: SpecObservation = {
      specId: s.id,
      specVersion: s.version,
      specHash: s.hash,
      criteria: s.criteria.map((c) => {
        if (c.tier === 'soft') {
          return {
            id: c.id,
            tier: c.tier,
            status: 'unscored' as const,
            severity: c.severity,
            softThreshold: c.softThreshold,
            ...(wrapperDegraded ? { evidenceTaints: ['wrapper' as const] } : {}),
          };
        }
        const m = byId.get(c.id);
        if (!m) {
          return {
            id: c.id,
            tier: c.tier,
            status: 'unverifiable' as const,
            detail: 'no mechanical verdict produced',
            severity: c.severity,
            softThreshold: c.softThreshold,
          };
        }
        return {
          id: c.id,
          tier: c.tier,
          status: m.status,
          detail: m.detail,
          severity: c.severity,
          softThreshold: c.softThreshold,
          evidenceTaints: evidenceTaintsOf(m),
        };
      }),
    };

    // The verify shape — the same mechanical results as CriterionVerdicts,
    // soft as run.ts's tainted `unverifiable` placeholder (degraded wrapper).
    const verdicts: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'pass', detail: '0 console errors' },
      { id: 'AC-2', tier: 'soft', status: 'unverifiable', evidenceTaints: ['wrapper'] },
      {
        id: 'AC-3',
        tier: 'property',
        status: 'unverifiable',
        detail: 'selector had no usable field',
        evidenceTaints: ['network'],
      },
    ];
    const verifyObs = observationFromVerdicts(s, verdicts);

    const fromWatch = reconcileScorecard({
      prev: null,
      observations: [watchObs],
      now: T1,
      sha: 'sha-x',
    });
    const fromVerify = reconcileScorecard({
      prev: null,
      observations: [verifyObs],
      now: T1,
      sha: 'sha-x',
    });
    expect(fromVerify.scorecard.specs['spec-fold']).toEqual(fromWatch.scorecard.specs['spec-fold']);
    expect(fromVerify.signals).toEqual(fromWatch.signals);
  });
});

/* ------------------------------------------------------------------ *
 * Probation (Phase C — bulk onboarding).
 *                                                                    *
 * `observationFromVerdicts` threads the spec's probation marker onto   *
 * the observation (so the reducer downgrades pass→fail to needs-review *
 * low). `observationConfirmsProbationClear` is THE single predicate   *
 * for clearing it. `foldVerifyIntoScorecard` (the ATTENDED MCP verify  *
 * fold) calls clearSpecProbation on a clean confirmed pass; watch     *
 * never does.                                                          *
 * ------------------------------------------------------------------ */

/** A criterion entry shape the predicate reads. */
function obsCrit(over: {
  id: string;
  tier: 'hard' | 'property' | 'soft';
  status: 'pass' | 'fail' | 'unverifiable' | 'unscored';
  severity?: 'advisory' | 'blocking';
  evidenceTaints?: EvidenceTaint[];
}): SpecObservation['criteria'][number] {
  return over;
}

function obs(
  criteria: SpecObservation['criteria'],
  over: Partial<SpecObservation> = {},
): SpecObservation {
  return { specId: 'spec-fold', specVersion: 1, specHash: 'h', criteria, ...over };
}

describe('observationConfirmsProbationClear — the first-clean-confirmed-pass predicate (Phase C)', () => {
  it('TRUE: one blocking hard pass, no fails, no taints', () => {
    expect(
      observationConfirmsProbationClear(
        obs([
          obsCrit({ id: 'AC-1', tier: 'hard', status: 'pass' }),
          obsCrit({ id: 'AC-2', tier: 'soft', status: 'unscored', severity: 'advisory' }),
        ]),
      ),
    ).toBe(true);
  });

  it('FALSE: zero hard/property criteria (only soft) — nothing blocking to confirm', () => {
    expect(
      observationConfirmsProbationClear(
        obs([obsCrit({ id: 'AC-1', tier: 'soft', status: 'pass', severity: 'advisory' })]),
      ),
    ).toBe(false);
  });

  it('FALSE: a blocking hard criterion is unverifiable (not a clean pass)', () => {
    expect(
      observationConfirmsProbationClear(
        obs([obsCrit({ id: 'AC-1', tier: 'hard', status: 'unverifiable' })]),
      ),
    ).toBe(false);
  });

  it('FALSE: a hard criterion is failing', () => {
    expect(
      observationConfirmsProbationClear(
        obs([
          obsCrit({ id: 'AC-1', tier: 'hard', status: 'pass' }),
          obsCrit({ id: 'AC-2', tier: 'hard', status: 'fail' }),
        ]),
      ),
    ).toBe(false);
  });

  it('TRUE: an advisory hard fail does NOT block clearing (advisory-soft failures either)', () => {
    // A soft criterion with status 'fail' and severity 'advisory' is excluded
    // from the hard/property fail clause — it must not block clearing.
    expect(
      observationConfirmsProbationClear(
        obs([
          obsCrit({ id: 'AC-1', tier: 'hard', status: 'pass' }),
          obsCrit({ id: 'AC-2', tier: 'soft', status: 'fail', severity: 'advisory' }),
        ]),
      ),
    ).toBe(true);
  });

  it('FALSE: a criterion carries a demoting evidence taint (network)', () => {
    expect(
      observationConfirmsProbationClear(
        obs([
          obsCrit({ id: 'AC-1', tier: 'hard', status: 'pass' }),
          obsCrit({ id: 'AC-2', tier: 'property', status: 'pass', evidenceTaints: ['network'] }),
        ]),
      ),
    ).toBe(false);
  });

  it('FALSE: a soft criterion carries a demoting wrapper taint (degraded render)', () => {
    expect(
      observationConfirmsProbationClear(
        obs([
          obsCrit({ id: 'AC-1', tier: 'hard', status: 'pass' }),
          obsCrit({
            id: 'AC-2',
            tier: 'soft',
            status: 'unscored',
            severity: 'advisory',
            evidenceTaints: ['wrapper'],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it('TRUE: a non-demoting taint (synthetic-data) does NOT block clearing', () => {
    expect(
      observationConfirmsProbationClear(
        obs([
          obsCrit({ id: 'AC-1', tier: 'hard', status: 'pass', evidenceTaints: ['synthetic-data'] }),
        ]),
      ),
    ).toBe(true);
  });

  it('TRUE: an advisory hard/property pass with no blocking criterion present still clears', () => {
    // Literal contract: at least one hard/property; every BLOCKING one passes
    // (vacuous — none are blocking); no hard/property is failing; no taint.
    expect(
      observationConfirmsProbationClear(
        obs([obsCrit({ id: 'AC-1', tier: 'hard', status: 'pass', severity: 'advisory' })]),
      ),
    ).toBe(true);
  });
});

describe('foldVerifyIntoScorecard — probation clearing on the attended MCP verify fold', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-fold-probation-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Frozen spec with a single hard criterion + a soft criterion. */
  function onboardingSpec(over: Partial<Spec> = {}): Spec {
    return spec({
      id: 'spec-fold-prob',
      runtime: 'web',
      probation: { since: T0 },
      criteria: [
        {
          id: 'AC-1',
          text: 'renders without console errors',
          tier: 'hard',
          checks: [{ expect: { console: { errors: 0 } } }],
        },
        {
          id: 'AC-2',
          text: 'looks polished',
          tier: 'soft',
          severity: 'advisory',
          softThreshold: 0.8,
        },
      ],
      ...over,
    });
  }

  it('CLEARS probation on a clean confirmed pass (hard pass, soft unscored, no taints)', () => {
    const s = onboardingSpec();
    writeSpec(projectRoot, s);
    const verdicts: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      { id: 'AC-2', tier: 'soft', status: 'unverifiable' },
    ];
    foldVerifyIntoScorecard(projectRoot, { spec: s, verdicts, now: T1 });
    const after = readSpec(projectRoot, s.id);
    expect(after?.probation).toBeUndefined();
  });

  it('LEAVES probation in place when a hard criterion is failing', () => {
    const s = onboardingSpec();
    writeSpec(projectRoot, s);
    const verdicts: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'console errored' },
      { id: 'AC-2', tier: 'soft', status: 'unverifiable' },
    ];
    foldVerifyIntoScorecard(projectRoot, { spec: s, verdicts, now: T1 });
    const after = readSpec(projectRoot, s.id);
    expect(after?.probation).toBeDefined();
  });

  it('LEAVES probation in place when a passing verdict carries a demoting taint', () => {
    const s = onboardingSpec();
    writeSpec(projectRoot, s);
    // A pass carrying a network taint is not a confirmed pass.
    const verdicts: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'pass', evidenceTaints: ['network'] },
      { id: 'AC-2', tier: 'soft', status: 'unverifiable', evidenceTaints: ['wrapper'] },
    ];
    foldVerifyIntoScorecard(projectRoot, { spec: s, verdicts, now: T1 });
    const after = readSpec(projectRoot, s.id);
    expect(after?.probation).toBeDefined();
  });

  it('LEAVES probation in place on a non-probation spec (clear is a no-op; no marker to lift)', () => {
    const s = onboardingSpec({ probation: undefined });
    writeSpec(projectRoot, s);
    const verdicts: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      { id: 'AC-2', tier: 'soft', status: 'unverifiable' },
    ];
    const out = foldVerifyIntoScorecard(projectRoot, { spec: s, verdicts, now: T1 });
    expect(out.written).toBe(true);
    const after = readSpec(projectRoot, s.id);
    expect(after?.probation).toBeUndefined();
  });
});
