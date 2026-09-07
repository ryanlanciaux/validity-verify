/**
 * Lean verify (C3) is PRESENTATION-ONLY: it may omit a screenshot (or a
 * source block) from the verify response, but only when dropping it provably
 * hides nothing — all mechanical verdicts pass, no soft criterion needs
 * scoring, and the pixels are byte-identical to the previous run's screenshot
 * (the exact image the last score's citations pointed at). It must NEVER
 * strip the image an agent needs to reach a non-pass or soft verdict, and it
 * must never present a carried-forward soft score as a fresh one — either
 * would be a false-green channel. These tests pin exactly those holes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentRender, CriterionVerdict, RunMeta, Spec } from '@validity.ai/verify-spec';
import {
  buildPrevRenderIndex,
  buildRenderIdentity,
  leanScreenshotDecision,
  partitionSoftCriteria,
  prevRunMatchesSpec,
  renderKeyFor,
  resolveVerifyDetail,
  screenshotsIdentical,
  urlModeDetailNotice,
  type PrevRenderIndex,
} from './lean-verify.js';
import { specScopedScoringInstructions } from './server.js';

/** The frozen content hash shared by the default spec + prev-run fixtures. */
const SPEC_HASH = 'sha-lean-v1';

function makeSpec(criteria: Array<Partial<Spec['criteria'][number]> & { id: string }>): Spec {
  return {
    id: 'spec-lean',
    version: 1,
    status: 'frozen',
    hash: SPEC_HASH,
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    criteria: criteria.map((c) => ({
      tier: 'soft',
      text: `criterion ${c.id}`,
      ...c,
    })),
  } as Spec;
}

function makeMeta(overrides: Partial<RunMeta>): RunMeta {
  return {
    runId: 'run_prev',
    createdAt: '2026-06-30T00:00:00.000Z',
    prompt: 'p',
    scenarios: [],
    specHash: SPEC_HASH,
    diff: { files: [] },
    report: { enabled: true, brand: 'validity' },
    ...overrides,
  };
}

function render(overrides: Partial<ComponentRender> & { id: string }): ComponentRender {
  return {
    filePath: `src/${overrides.id}.tsx`,
    screenshotPath: `/runs/x/screenshots/${overrides.id}__base.png`,
    ...overrides,
  } as ComponentRender;
}

describe('resolveVerifyDetail — default policy', () => {
  it("explicit detail:'full' beats lean:true (the escape hatch always wins)", () => {
    expect(
      resolveVerifyDetail({ detail: 'full', lean: true, hasSpec: true, hasPriorRun: true }),
    ).toEqual({ detail: 'full', autoSelected: false });
  });

  it("explicit detail:'lean' forces lean even on the first iteration", () => {
    expect(resolveVerifyDetail({ detail: 'lean', hasSpec: true, hasPriorRun: false })).toEqual({
      detail: 'lean',
      autoSelected: false,
    });
  });

  it('legacy lean:true alone still means lean (back-compat alias)', () => {
    expect(resolveVerifyDetail({ lean: true, hasSpec: false, hasPriorRun: false })).toEqual({
      detail: 'lean',
      autoSelected: false,
    });
  });

  it('auto: spec + prior run ⇒ lean, autoSelected', () => {
    expect(resolveVerifyDetail({ hasSpec: true, hasPriorRun: true })).toEqual({
      detail: 'lean',
      autoSelected: true,
    });
  });

  it('auto: first verify of a spec ⇒ full (the agent must see everything once)', () => {
    expect(resolveVerifyDetail({ hasSpec: true, hasPriorRun: false })).toEqual({
      detail: 'full',
      autoSelected: true,
    });
  });

  it('auto: no spec ⇒ full (no history or carry-forward provenance to drop against)', () => {
    expect(resolveVerifyDetail({ hasSpec: false, hasPriorRun: true })).toEqual({
      detail: 'full',
      autoSelected: true,
    });
  });
});

describe('leanScreenshotDecision — keeps (the FALSE-GREEN negatives)', () => {
  const base = {
    detail: 'lean' as const,
    identicalToPrev: true as const,
    anySoftOpen: false,
    specInScope: true,
  };

  it('full detail always keeps, regardless of everything else', () => {
    expect(
      leanScreenshotDecision({ ...base, detail: 'full', verdicts: [{ status: 'pass' }] }).keep,
    ).toBe(true);
  });

  it('K1: any fail/unverifiable verdict keeps the image', () => {
    expect(leanScreenshotDecision({ ...base, verdicts: [{ status: 'fail' }] }).keep).toBe(true);
    expect(leanScreenshotDecision({ ...base, verdicts: [{ status: 'unverifiable' }] }).keep).toBe(
      true,
    );
    expect(
      leanScreenshotDecision({
        ...base,
        verdicts: [{ status: 'pass' }, { status: 'fail' }],
      }).keep,
    ).toBe(true);
  });

  it('K2: an OPEN soft criterion keeps the image even when all-pass and pixel-identical', () => {
    expect(
      leanScreenshotDecision({
        ...base,
        verdicts: [{ status: 'pass' }],
        anySoftOpen: true,
      }).keep,
    ).toBe(true);
  });

  it("K3: not provably identical (changed OR 'unknown') keeps the image", () => {
    expect(
      leanScreenshotDecision({
        ...base,
        verdicts: [{ status: 'pass' }],
        identicalToPrev: false,
      }).keep,
    ).toBe(true);
    expect(
      leanScreenshotDecision({
        ...base,
        verdicts: [{ status: 'pass' }],
        identicalToPrev: 'unknown',
      }).keep,
    ).toBe(true);
  });

  it('K4: no spec + no verdicts ⇒ nothing was proven; keep', () => {
    expect(leanScreenshotDecision({ ...base, specInScope: false, verdicts: [] }).keep).toBe(true);
  });

  it('no-spec + all-pass verdicts drops (the shipped conservative rule)', () => {
    const d = leanScreenshotDecision({
      ...base,
      specInScope: false,
      verdicts: [{ status: 'pass' }],
    });
    expect(d.keep).toBe(false);
    expect(d.reason).toContain('mechanical checks passed');
  });
});

describe('leanScreenshotDecision — the ONLY drop', () => {
  it('lean ∧ spec ∧ all-pass ∧ no open soft ∧ byte-identical ⇒ drop, with a reason', () => {
    const d = leanScreenshotDecision({
      detail: 'lean',
      verdicts: [{ status: 'pass' }, { status: 'pass' }],
      identicalToPrev: true,
      anySoftOpen: false,
      specInScope: true,
    });
    expect(d.keep).toBe(false);
    expect(d.reason).toContain('byte-identical');
  });

  it('spec in scope with NO per-render verdicts still relies on K2/K3 only (variant renders)', () => {
    // First-execution-wins leaves scenario variants with empty verdicts — a
    // drop is allowed only when the pixels provably did not change AND no
    // soft criterion is open.
    expect(
      leanScreenshotDecision({
        detail: 'lean',
        verdicts: [],
        identicalToPrev: true,
        anySoftOpen: false,
        specInScope: true,
      }).keep,
    ).toBe(false);
    expect(
      leanScreenshotDecision({
        detail: 'lean',
        verdicts: [],
        identicalToPrev: false,
        anySoftOpen: false,
        specInScope: true,
      }).keep,
    ).toBe(true);
  });
});

describe('screenshotsIdentical / renderKeyFor / buildPrevRenderIndex', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'validity-lean-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('identical files ⇒ true; differing ⇒ false; missing ⇒ unknown', () => {
    const a = resolve(dir, 'a.png');
    const b = resolve(dir, 'b.png');
    const c = resolve(dir, 'c.png');
    writeFileSync(a, Buffer.from([1, 2, 3]));
    writeFileSync(b, Buffer.from([1, 2, 3]));
    writeFileSync(c, Buffer.from([1, 2, 4]));
    expect(screenshotsIdentical(a, b)).toBe(true);
    expect(screenshotsIdentical(a, c)).toBe(false);
    expect(screenshotsIdentical(a, resolve(dir, 'missing.png'))).toBe('unknown');
  });

  it('renderKeys keep scenario/fixture/viewport/theme variants distinct', () => {
    const keys = [
      'Card__base.png',
      'Card__logged-in.png',
      'Card__logged-in__primary.png',
      'Card__base__mobile.png',
      'Card__base__dark.png',
      'Card__base__data-empty.png',
    ].map((f) => renderKeyFor({ screenshotPath: `/x/${f}` }));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('buildPrevRenderIndex excludes errored / skipped / unconfirmed renders from shots', () => {
    const meta = makeMeta({
      components: [
        render({ id: 'A', screenshotPath: '/p/A__base.png' }),
        render({ id: 'B', screenshotPath: '/p/B__base.png', renderError: 'boom' }),
        render({ id: 'C', screenshotPath: '/p/C__base.png', screenshotSkipped: true }),
        render({ id: 'D', screenshotPath: '/p/D__base.png', renderConfirmation: 'unconfirmed' }),
      ],
      criterionVerdicts: [{ id: 'AC-1', tier: 'soft', status: 'pass' }],
    });
    const idx = buildPrevRenderIndex(meta, { hash: SPEC_HASH })!;
    expect(idx.runId).toBe('run_prev');
    expect([...idx.shots.keys()]).toEqual(['A__base']);
    expect(idx.verdicts).toHaveLength(1);
    expect(buildPrevRenderIndex(undefined, { hash: SPEC_HASH })).toBeUndefined();
  });

  it('buildPrevRenderIndex yields NO index across a re-freeze or unprovable provenance (carry-forward is hash/version keyed)', () => {
    const meta = makeMeta({
      components: [render({ id: 'A', screenshotPath: '/p/A__base.png' })],
      criterionVerdicts: [{ id: 'AC-1', tier: 'soft', status: 'pass' }],
    });
    // Re-frozen spec (different hash) ⇒ the previous run proves nothing.
    expect(buildPrevRenderIndex(meta, { hash: 'sha-lean-v2', version: 2 })).toBeUndefined();
    // Unprovable on either side ⇒ no index (the safe direction).
    expect(buildPrevRenderIndex(meta, undefined)).toBeUndefined();
    expect(
      buildPrevRenderIndex(makeMeta({ specHash: undefined }), { hash: SPEC_HASH, version: 1 }),
    ).toBeUndefined();
  });
});

describe('prevRunMatchesSpec — the auto-lean / carry-forward re-freeze guard', () => {
  it('hash rules: both present ⇒ must match; a mismatch is never rescued by version', () => {
    expect(prevRunMatchesSpec({ specHash: SPEC_HASH }, { hash: SPEC_HASH })).toBe(true);
    expect(prevRunMatchesSpec({ specHash: SPEC_HASH }, { hash: 'sha-lean-v2' })).toBe(false);
    expect(
      prevRunMatchesSpec(
        { specHash: SPEC_HASH, specVersion: 1 },
        { hash: 'sha-lean-v2', version: 1 },
      ),
    ).toBe(false);
    expect(prevRunMatchesSpec(undefined, { hash: SPEC_HASH })).toBe(false);
    expect(prevRunMatchesSpec({ specHash: SPEC_HASH }, undefined)).toBe(false);
  });

  it('hash-less (pre-hash) provenance falls back to the immutable frozen VERSION', () => {
    // Back-compat: an old run-meta / hand-written frozen spec without a hash
    // still binds when the version matches — frozen versions never mutate.
    expect(prevRunMatchesSpec({ specVersion: 1 }, { version: 1 })).toBe(true);
    expect(prevRunMatchesSpec({ specHash: SPEC_HASH, specVersion: 1 }, { version: 1 })).toBe(true);
    // A re-freeze mints v+1 ⇒ never a match.
    expect(prevRunMatchesSpec({ specVersion: 1 }, { version: 2 })).toBe(false);
    // Nothing provable on either axis ⇒ false.
    expect(prevRunMatchesSpec({}, { version: 1 })).toBe(false);
    expect(prevRunMatchesSpec({ specVersion: 1 }, {})).toBe(false);
  });

  it('a re-frozen spec resolves auto detail FULL (first verify of the new contract sees everything)', () => {
    // The server computes hasPriorRun via prevRunMatchesSpec — a v1-scored
    // prior run must not count as history for the re-frozen v2.
    const hasPriorRun = prevRunMatchesSpec(
      { specHash: SPEC_HASH, specVersion: 1 },
      { hash: 'sha-lean-v2', version: 2 },
    );
    expect(resolveVerifyDetail({ hasSpec: true, hasPriorRun })).toEqual({
      detail: 'full',
      autoSelected: true,
    });
  });
});

describe('partitionSoftCriteria', () => {
  const spec = makeSpec([{ id: 'AC-1' }, { id: 'AC-2', tier: 'hard', text: 'hard one' }]);
  const identityAllTrue = new Map<string, boolean | 'unknown'>([['A__base', true]]);
  const idsToKeys = new Map<string, string[]>([['A', ['A__base']]]);

  function prevWith(v: Partial<CriterionVerdict>): PrevRenderIndex {
    return {
      runId: 'run_prev',
      createdAt: '2026-06-30T00:00:00.000Z',
      shots: new Map([['A__base', '/prev/A__base.png']]),
      verdicts: [{ id: 'AC-1', tier: 'soft', status: 'pass', ...v } as CriterionVerdict],
    };
  }

  it('carries forward a cited pass whose evidence is byte-identical (and skips non-soft tiers)', () => {
    const { carryForward, open } = partitionSoftCriteria({
      spec,
      prev: prevWith({ screenshotCitations: ['A'], detail: 'looks right' }),
      identity: identityAllTrue,
      currentIdsToKeys: idsToKeys,
    });
    expect(open).toEqual([]);
    expect(carryForward).toEqual([
      {
        id: 'AC-1',
        status: 'pass',
        detail: 'looks right',
        screenshotCitations: ['A'],
        scoredInRunId: 'run_prev',
      },
    ]);
  });

  it('a carried-forward FAIL stays a fail (it can only hold the gate red)', () => {
    const { carryForward } = partitionSoftCriteria({
      spec,
      prev: prevWith({ status: 'fail', screenshotCitations: ['A'] }),
      identity: identityAllTrue,
      currentIdsToKeys: idsToKeys,
    });
    expect(carryForward[0]?.status).toBe('fail');
  });

  it('OPEN when: no prev run / prev unverifiable / citation-less (old meta)', () => {
    for (const prev of [
      undefined,
      prevWith({ status: 'unverifiable', screenshotCitations: ['A'] }),
      prevWith({ screenshotCitations: undefined }),
      prevWith({ screenshotCitations: [] }),
    ]) {
      const { carryForward, open } = partitionSoftCriteria({
        spec,
        prev,
        identity: identityAllTrue,
        currentIdsToKeys: idsToKeys,
      });
      expect(carryForward).toEqual([]);
      expect(open).toEqual(['AC-1']);
    }
  });

  it('OPEN when the cited id is absent from the current run', () => {
    const { open } = partitionSoftCriteria({
      spec,
      prev: prevWith({ screenshotCitations: ['GONE'] }),
      identity: identityAllTrue,
      currentIdsToKeys: idsToKeys,
    });
    expect(open).toEqual(['AC-1']);
  });

  it("OPEN when any variant under the cited id changed or reads 'unknown'", () => {
    for (const verdict of [false, 'unknown'] as const) {
      const { open, carryForward } = partitionSoftCriteria({
        spec,
        prev: prevWith({ screenshotCitations: ['A'] }),
        identity: new Map<string, boolean | 'unknown'>([
          ['A__base', true],
          ['A__logged-in', verdict],
        ]),
        currentIdsToKeys: new Map([['A', ['A__base', 'A__logged-in']]]),
      });
      expect(carryForward).toEqual([]);
      expect(open).toEqual(['AC-1']);
    }
  });

  it('a demoting-tainted prev PASS is never carry-forwardable (belt-and-braces)', () => {
    const { open, carryForward } = partitionSoftCriteria({
      spec,
      prev: prevWith({ screenshotCitations: ['A'], evidenceTaints: ['wrapper'] }),
      identity: identityAllTrue,
      currentIdsToKeys: idsToKeys,
    });
    expect(carryForward).toEqual([]);
    expect(open).toEqual(['AC-1']);
  });
});

describe("CAN'T-FALSE-GREEN: lean never hides changed evidence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'validity-lean-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a soft pass scored on image A is OPEN — and the replacement screenshot attached — when the render now produces image B', () => {
    // Previous run: screenshot A, soft criterion scored pass citing render
    // 'Card'. Current run: same render key (same basename), ONE byte flipped.
    const prevShotSameKey = resolve(dir, 'prev', 'Card__base.png');
    const currShotSameKey = resolve(dir, 'curr', 'Card__base.png');
    for (const [path, bytes] of [
      [prevShotSameKey, Buffer.from([137, 80, 78, 71, 0, 0, 0, 1])],
      [currShotSameKey, Buffer.from([137, 80, 78, 71, 0, 0, 0, 2])],
    ] as const) {
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(path, bytes);
    }
    const prevMeta = makeMeta({
      components: [render({ id: 'Card', screenshotPath: prevShotSameKey })],
      criterionVerdicts: [
        { id: 'AC-1', tier: 'soft', status: 'pass', screenshotCitations: ['Card'] },
      ],
    });

    const spec = makeSpec([{ id: 'AC-1' }]);
    const prevIndex = buildPrevRenderIndex(prevMeta, spec)!;
    const current = [render({ id: 'Card', screenshotPath: currShotSameKey })];
    const { identity, idsToKeys } = buildRenderIdentity(current, prevIndex);

    // The changed pixel makes the criterion OPEN…
    const { carryForward, open } = partitionSoftCriteria({
      spec,
      prev: prevIndex,
      identity,
      currentIdsToKeys: idsToKeys,
    });
    expect(open).toEqual(['AC-1']);
    expect(carryForward).toEqual([]);

    // …the replacement screenshot is attached (K2 AND K3 both keep it)…
    const decision = leanScreenshotDecision({
      detail: 'lean',
      verdicts: [],
      identicalToPrev: identity.get('Card__base') ?? 'unknown',
      anySoftOpen: open.length > 0,
      specInScope: true,
    });
    expect(decision.keep).toBe(true);

    // …and the scoring instructions present it as FRESH work, not carry-forward.
    const instructions = specScopedScoringInstructions(spec, carryForward);
    expect(instructions).toContain('AC-1: criterion AC-1');
    expect(instructions).not.toContain('CARRIED FORWARD');
  });

  it("REGRESSION (carry-forward laundering): a re-freeze with changed criterion text ⇒ the carried pass EVAPORATES even when the pixels are byte-identical — and auto detail is 'full'", () => {
    // Previous run: soft AC-1 scored PASS against spec v1 ("empty state looks
    // polished"), citations byte-identical. The spec is then re-frozen as v2
    // with the SAME criterion id but tightened text (new hash). The v1 score
    // is not evidence for the v2 contract — matching by id alone would let
    // signedOff go green against text no judge ever scored.
    const prevShot = resolve(dir, 'prev', 'Card__base.png');
    const currShot = resolve(dir, 'curr', 'Card__base.png');
    const bytes = Buffer.from([137, 80, 78, 71, 5, 5, 5, 5]);
    for (const p of [prevShot, currShot]) {
      mkdirSync(resolve(p, '..'), { recursive: true });
      writeFileSync(p, bytes);
    }
    const prevMeta = makeMeta({
      specHash: SPEC_HASH, // scored against v1's frozen content
      components: [render({ id: 'Card', screenshotPath: prevShot })],
      criterionVerdicts: [
        { id: 'AC-1', tier: 'soft', status: 'pass', screenshotCitations: ['Card'] },
      ],
    });
    const specV2 = {
      ...makeSpec([{ id: 'AC-1', text: 'empty state must include a CTA button' }]),
      version: 2,
      hash: 'sha-lean-v2',
    } as Spec;

    // The re-frozen spec has no same-hash history ⇒ auto detail is FULL…
    expect(
      resolveVerifyDetail({
        hasSpec: true,
        hasPriorRun: prevRunMatchesSpec(prevMeta, specV2),
      }),
    ).toEqual({ detail: 'full', autoSelected: true });

    // …and even under an EXPLICIT lean request the carry-forward evaporates.
    const prevIndex = buildPrevRenderIndex(prevMeta, specV2);
    expect(prevIndex).toBeUndefined();
    const current = [render({ id: 'Card', screenshotPath: currShot })];
    const { identity, idsToKeys } = buildRenderIdentity(current, prevIndex);
    const { carryForward, open } = partitionSoftCriteria({
      spec: specV2,
      prev: prevIndex,
      identity,
      currentIdsToKeys: idsToKeys,
    });
    expect(carryForward).toEqual([]);
    expect(open).toEqual(['AC-1']);

    // The screenshot stays attached (K2: the open criterion needs evidence)…
    expect(
      leanScreenshotDecision({
        detail: 'lean',
        verdicts: [],
        identicalToPrev: identity.get('Card__base') ?? 'unknown',
        anySoftOpen: open.length > 0,
        specInScope: true,
      }).keep,
    ).toBe(true);

    // …and the instructions demand a FRESH score of the v2 text.
    const instructions = specScopedScoringInstructions(specV2, carryForward);
    expect(instructions).toContain('AC-1: empty state must include a CTA button');
    expect(instructions).not.toContain('CARRIED FORWARD');
  });

  it('control: with byte-identical evidence the same criterion IS carried forward and the drop fires', () => {
    const prevShot = resolve(dir, 'prev', 'Card__base.png');
    const currShot = resolve(dir, 'curr', 'Card__base.png');
    const bytes = Buffer.from([137, 80, 78, 71, 9, 9, 9, 9]);
    for (const p of [prevShot, currShot]) {
      mkdirSync(resolve(p, '..'), { recursive: true });
      writeFileSync(p, bytes);
    }
    const prevMeta = makeMeta({
      components: [render({ id: 'Card', screenshotPath: prevShot })],
      criterionVerdicts: [
        { id: 'AC-1', tier: 'soft', status: 'pass', screenshotCitations: ['Card'] },
      ],
    });
    const spec = makeSpec([{ id: 'AC-1' }]);
    const prevIndex = buildPrevRenderIndex(prevMeta, spec)!;
    const current = [render({ id: 'Card', screenshotPath: currShot })];
    const { identity, idsToKeys } = buildRenderIdentity(current, prevIndex);
    const { carryForward, open } = partitionSoftCriteria({
      spec,
      prev: prevIndex,
      identity,
      currentIdsToKeys: idsToKeys,
    });
    expect(open).toEqual([]);
    expect(carryForward.map((c) => c.id)).toEqual(['AC-1']);
    expect(
      leanScreenshotDecision({
        detail: 'lean',
        verdicts: [{ status: 'pass' }],
        identicalToPrev: identity.get('Card__base')!,
        anySoftOpen: false,
        specInScope: true,
      }).keep,
    ).toBe(false);
  });
});

describe('specScopedScoringInstructions — carry-forward presentation', () => {
  const spec = makeSpec([{ id: 'AC-1' }, { id: 'AC-2' }]);

  it('empty carry-forward ⇒ byte-identical output to the plain call (regression pin)', () => {
    expect(specScopedScoringInstructions(spec, [])).toBe(specScopedScoringInstructions(spec));
  });

  it('splits OPEN vs CARRIED FORWARD and never presents carried scores as fresh', () => {
    const out = specScopedScoringInstructions(spec, [
      {
        id: 'AC-2',
        status: 'pass',
        screenshotCitations: ['Card'],
        scoredInRunId: 'run_prev',
      },
    ]);
    // AC-1 is fresh work under the scoring rubric…
    expect(out).toContain('AC-1: criterion AC-1');
    // …AC-2 is ONLY in the carried block, with its recorded status + citation.
    expect(out).toContain('CARRIED FORWARD (lean)');
    expect(out).toContain('run run_prev');
    expect(out).toContain('AC-2 — pass (cite: Card)');
    expect(out).not.toContain('AC-2: criterion AC-2');
    expect(out).toContain('Do NOT re-judge them from memory');
    expect(out).toContain("detail:'full'");
    expect(out).toContain('carried forward:');
  });

  it('all-carried ⇒ the soft section says so instead of asking for fresh scores', () => {
    const out = specScopedScoringInstructions(spec, [
      { id: 'AC-1', status: 'pass', screenshotCitations: ['A'], scoredInRunId: 'r' },
      { id: 'AC-2', status: 'fail', screenshotCitations: ['A'], scoredInRunId: 'r' },
    ]);
    expect(out).toContain('every soft criterion carried forward');
    expect(out).not.toContain('QUALITY FLOOR');
    expect(out).toContain('AC-2 — fail (cite: A)');
  });
});

describe('urlModeDetailNotice — URL mode is always full', () => {
  it("notices an explicit detail:'lean' or legacy lean:true", () => {
    expect(urlModeDetailNotice({ detail: 'lean' })).toContain('no effect in URL mode');
    expect(urlModeDetailNotice({ lean: true })).toContain('no effect in URL mode');
  });

  it("silent when full (default, explicit, or detail:'full' overriding lean:true)", () => {
    expect(urlModeDetailNotice({})).toBeNull();
    expect(urlModeDetailNotice({ detail: 'full' })).toBeNull();
    expect(urlModeDetailNotice({ detail: 'full', lean: true })).toBeNull();
  });
});

/**
 * INTERPLAY (C3 §3.5): the soft-scoring loop can never be starved by lean.
 * `score_soft_criteria` reads screenshots FROM DISK via run-meta paths — lean
 * shapes only the verify RESPONSE and never skips writing a screenshot file —
 * so even a criterion whose verify-response image was dropped gets its full
 * latest-run image set from the scorecard loop.
 */
describe('score_soft_criteria interplay — lean cannot starve the soft-scoring loop', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-lean-interplay-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('surfaces the latest-run screenshot from disk even when a lean verify response would have dropped it', async () => {
    const { createSpec, freezeSpec, ensureRunDirectories, indexRunForSpec, runMetaPathFor } =
      await import('@validity.ai/verify-spec');
    const { handleScoreSoftCriteria } = await import('./scorecard-tools.js');

    // A frozen spec with one soft criterion.
    const { specId } = createSpec({
      projectRoot,
      prompt: 'p',
      criteria: [{ id: 'AC-1', tier: 'soft', text: 'looks polished' }],
    });
    freezeSpec({ projectRoot, specId });

    // A verify run whose render would be DROPPED by lean (all-pass + identical
    // is irrelevant here — what matters is that the PNG is on disk in run-meta).
    const { screenshotsDir } = ensureRunDirectories(projectRoot, 'run_1');
    const shot = resolve(screenshotsDir, 'Card__base.png');
    mkdirSync(resolve(shot, '..'), { recursive: true });
    writeFileSync(shot, Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]));
    const meta = makeMeta({
      runId: 'run_1',
      specId,
      components: [render({ id: 'Card', screenshotPath: shot })],
      criterionVerdicts: [{ id: 'AC-1', tier: 'soft', status: 'unverifiable' }],
    });
    writeFileSync(runMetaPathFor(projectRoot, 'run_1'), JSON.stringify(meta, null, 2));
    indexRunForSpec(projectRoot, meta);

    const result = await handleScoreSoftCriteria({ specId, projectRoot });
    expect(result.isError).toBeUndefined();
    const content = result.content as Array<{ type: string; text?: string }>;
    // The rubric names the criterion AND the image block is attached from disk.
    expect(content.some((c) => c.type === 'text' && c.text?.includes('AC-1'))).toBe(true);
    expect(content.some((c) => c.type === 'image')).toBe(true);
  });
});
