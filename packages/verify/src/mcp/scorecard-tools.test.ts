/**
 * Scorer-provenance behavior of `record_soft_scores` (A3): the session
 * fingerprint is ALWAYS stamped on applied criteria, and `selfScored` fires on
 * either the legacy VALIDITY_BUILDER_MODEL match OR a fingerprint match with
 * the spec's latest verify run — a warning, never a block.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ensureRunDirectories,
  foldVerifyIntoScorecard,
  indexRunForSpec,
  loadScorecard,
  readScoreHistory,
  runMetaPathFor,
  saveScorecard,
  scoreHistoryPath,
  writeUrlRunMeta,
  type RunMeta,
  type Scorecard,
  type Spec,
} from '@validity.ai/verify-spec';
import { SESSION_FINGERPRINT } from './session-fingerprint.js';

import { handleRecordSoftScores } from './scorecard-tools.js';

const T0 = '2026-01-01T00:00:00.000Z';

/**
 * Seed a citable verify run for spec-a: a run-meta with one non-errored page
 * ('Home') registered in the spec's run history. record_soft_scores' citation
 * floor requires a soft `pass` to cite a real render id from the latest run, so
 * every fixture that records a pass needs one of these. Append-ordered history
 * means a run seeded later (e.g. a fingerprint-specific one) stays "latest".
 */
function seedCitableRun(
  projectRoot: string,
  opts?: { runId?: string; fingerprint?: string; specId?: string },
): void {
  const runId = opts?.runId ?? 'run_cite';
  ensureRunDirectories(projectRoot, runId);
  writeUrlRunMeta({
    projectRoot,
    runId,
    prompt: 'p',
    scenarios: [],
    pages: [
      {
        id: 'Home',
        pathId: 'home',
        url: 'http://localhost/',
        screenshotPath: `.validity/runs/${runId}/Home.png`,
      },
    ],
    reportConfig: { enabled: false, brand: 'none' },
    specId: opts?.specId ?? 'spec-a',
    sessionFingerprint: opts?.fingerprint,
  });
}

function seedScorecard(projectRoot: string): void {
  const scorecard: Scorecard = {
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-a': {
        specVersion: 1,
        specHash: 'h1',
        verdict: 'partial',
        coveragePercent: null,
        criteria: { 'AC-2': { tier: 'soft', status: 'unscored', at: T0 } },
        updatedAt: T0,
      },
    },
  };
  saveScorecard(projectRoot, scorecard);
}

describe('handleRecordSoftScores — provenance + selfScored (A3)', () => {
  let projectRoot: string;
  const envBefore = process.env.VALIDITY_BUILDER_MODEL;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-sct-'));
    delete process.env.VALIDITY_BUILDER_MODEL;
    seedScorecard(projectRoot);
    seedCitableRun(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.VALIDITY_BUILDER_MODEL;
    else process.env.VALIDITY_BUILDER_MODEL = envBefore;
  });

  it('record_soft_scores succeeds', async () => {
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [{ id: 'AC-2', status: 'fail', reasoning: 'missing entirely' }],
    });
    expect(result.isError).toBeUndefined();
  });

  it('P2 REGRESSION: a verify-seeded scorecard (foldVerifyIntoScorecard) satisfies the tick requirement — no "no scorecard entry" error', async () => {
    // Fresh root: NO manual seed, no watch tick — only the fold MCP verify runs.
    const root = mkdtempSync(resolve(tmpdir(), 'validity-sct-seed-'));
    try {
      const spec: Spec = {
        id: 'spec-a',
        version: 1,
        status: 'frozen',
        source: { prompt: 'p', createdBy: 'agent' },
        criteria: [{ id: 'AC-2', text: 'looks polished', tier: 'soft' }],
        createdAt: T0,
      };
      foldVerifyIntoScorecard(root, {
        spec,
        verdicts: [{ id: 'AC-2', tier: 'soft', status: 'unverifiable' }],
      });
      seedCitableRun(root);
      const result = await handleRecordSoftScores({
        specId: 'spec-a',
        projectRoot: root,
        scores: [
          {
            id: 'AC-2',
            status: 'pass',
            reasoning: 'screenshot shows clean spacing',
            screenshotIds: ['Home'],
          },
        ],
      });
      expect(result.isError).toBeUndefined();
      const text = (result.content as Array<{ text?: string }>)[0]!.text!;
      expect(text).not.toMatch(/no scorecard entry/);
      expect(loadScorecard(root)!.specs['spec-a']!.criteria['AC-2']!.status).toBe('pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CITATION FLOOR: a soft pass WITHOUT screenshotIds is rejected, not applied (can't back-door an unbacked pass)", async () => {
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [{ id: 'AC-2', status: 'pass', reasoning: 'looks good' }],
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/missing screenshotIds/);
    // The criterion stayed unscored — the pass never landed on the scorecard.
    expect(loadScorecard(projectRoot)!.specs['spec-a']!.criteria['AC-2']!.status).toBe('unscored');
  });

  it('CITATION FLOOR: a soft pass citing an UNKNOWN render id is rejected', async () => {
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [
        { id: 'AC-2', status: 'pass', reasoning: 'looks good', screenshotIds: ['NotARealId'] },
      ],
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/unknown render id/);
    expect(loadScorecard(projectRoot)!.specs['spec-a']!.criteria['AC-2']!.status).toBe('unscored');
  });

  it('CITATION FLOOR: a soft FAIL needs only reasoning (no citation required)', async () => {
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [{ id: 'AC-2', status: 'fail', reasoning: 'spacing is broken' }],
    });
    expect(result.isError).toBeUndefined();
    expect(loadScorecard(projectRoot)!.specs['spec-a']!.criteria['AC-2']!.status).toBe('fail');
  });

  it('ALWAYS stamps scoredBySession on applied criteria (even without a scoredBy model id)', async () => {
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'screenshot shows clean spacing',
          screenshotIds: ['Home'],
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    const crit = loadScorecard(projectRoot)!.specs['spec-a']!.criteria['AC-2']!;
    expect(crit.scoredBySession).toBe(SESSION_FINGERPRINT);
    expect(crit.scoredBy).toBeUndefined();
  });

  it('selfScored fires on the latest-run fingerprint match WITHOUT any env var', async () => {
    // The spec's latest verify run was performed by THIS MCP session.
    seedCitableRun(projectRoot, { runId: 'run_sfp_1', fingerprint: SESSION_FINGERPRINT });
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'evidence in screenshot',
          screenshotIds: ['Home'],
        },
      ],
    });
    const sc = result.structuredContent as { selfScored: boolean };
    expect(sc.selfScored).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/WARNING: this session also ran the spec's latest verify/);
    // A warning, never a block — the scores still applied.
    expect(text).toMatch(/Recorded 1 soft score/);
  });

  it('selfScored stays false when the latest run came from a DIFFERENT session (fresh-context judge)', async () => {
    seedCitableRun(projectRoot, { runId: 'run_sfp_2', fingerprint: 'sfp-someoneelse' });
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'evidence in screenshot',
          screenshotIds: ['Home'],
        },
      ],
    });
    const sc = result.structuredContent as { selfScored: boolean };
    expect(sc.selfScored).toBe(false);
  });

  it('the legacy VALIDITY_BUILDER_MODEL contract still fires (env + matching scoredBy)', async () => {
    process.env.VALIDITY_BUILDER_MODEL = 'builder-model-1';
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scoredBy: 'builder-model-1',
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'evidence in screenshot',
          screenshotIds: ['Home'],
        },
      ],
    });
    const sc = result.structuredContent as { selfScored: boolean };
    expect(sc.selfScored).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/matches VALIDITY_BUILDER_MODEL/);
    // The model id landed on the criterion alongside the session.
    const crit = loadScorecard(projectRoot)!.specs['spec-a']!.criteria['AC-2']!;
    expect(crit.scoredBy).toBe('builder-model-1');
    expect(crit.scoredBySession).toBe(SESSION_FINGERPRINT);
  });
});

/* ------------------------------------------------------------------ *
 * Judge-mode affordances (A6): config knob → guidance/warnings/badges *
 * ------------------------------------------------------------------ */
import { RUBRIC_VERSION, createSpec, freezeSpec, readRunMeta } from '@validity.ai/verify-spec';
import { handleScoreSoftCriteria } from './scorecard-tools.js';

function writeConfig(projectRoot: string, judge?: 'self' | 'fresh-context' | 'human'): void {
  mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
  writeFileSync(
    resolve(projectRoot, '.validity/config.ts'),
    `export default {
  renderMode: 'web',
  framework: 'auto',
  wrapper: './.validity/wrapper.gen.tsx',
  ${judge ? `scoring: { judge: '${judge}' },` : ''}
};
`,
  );
}

/** Frozen spec whose id is forced to 'spec-a' so it lines up with seedScorecard. */
function seedSpecA(projectRoot: string): void {
  createSpec({
    projectRoot,
    specId: 'spec-a',
    prompt: 'Build the card',
    criteria: [{ id: 'AC-2', text: 'Card looks polished', tier: 'soft' }],
  });
  freezeSpec({ projectRoot, specId: 'spec-a' });
}

describe('handleScoreSoftCriteria — fresh-context guidance (A6)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-sct-a6-'));
    delete process.env.VALIDITY_BUILDER_MODEL;
    seedScorecard(projectRoot);
    seedSpecA(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function firstText(result: Awaited<ReturnType<typeof handleScoreSoftCriteria>>): string {
    return (result.content as Array<{ text?: string }>)[0]!.text!;
  }

  it("context:'fresh' prepends the blind-judging block (no config needed)", async () => {
    const result = await handleScoreSoftCriteria({
      specId: 'spec-a',
      projectRoot,
      context: 'fresh',
    });
    const text = firstText(result);
    expect(text).toMatch(/FRESH-CONTEXT JUDGING MODE/);
    expect(text).toMatch(/Do NOT read the component source/);
  });

  it("default judge mode 'self' without context stays guidance-free", async () => {
    writeConfig(projectRoot);
    const result = await handleScoreSoftCriteria({ specId: 'spec-a', projectRoot });
    const text = firstText(result);
    expect(text).not.toMatch(/FRESH-CONTEXT JUDGING MODE/);
    expect(text).not.toMatch(/judge-pack/);
  });

  it("config judge 'fresh-context' without context adds the guidance AND the judge-pack nudge", async () => {
    writeConfig(projectRoot, 'fresh-context');
    const result = await handleScoreSoftCriteria({ specId: 'spec-a', projectRoot });
    const text = firstText(result);
    expect(text).toMatch(/FRESH-CONTEXT JUDGING MODE/);
    expect(text).toMatch(/scoring\.judge = 'fresh-context'/);
    expect(text).toMatch(/validity judge-pack/);
  });
});

describe('handleRecordSoftScores — judge-mode warnings + RunMeta.scoring stamp (A6)', () => {
  let projectRoot: string;
  const envBefore = process.env.VALIDITY_BUILDER_MODEL;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-sct-a6r-'));
    delete process.env.VALIDITY_BUILDER_MODEL;
    seedScorecard(projectRoot);
    seedCitableRun(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.VALIDITY_BUILDER_MODEL;
    else process.env.VALIDITY_BUILDER_MODEL = envBefore;
  });

  function seedRunWithFingerprint(runId: string, fingerprint: string): void {
    seedCitableRun(projectRoot, { runId, fingerprint });
  }

  it('fresh-context + builder-fingerprint match → strong posture warning, selfScored true, judgeMode surfaced', async () => {
    writeConfig(projectRoot, 'fresh-context');
    seedRunWithFingerprint('run_a6_1', SESSION_FINGERPRINT);
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scoredBy: 'the-builder-itself',
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'screenshot shows a polished card',
          screenshotIds: ['Home'],
        },
      ],
    });
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/scoring\.judge is 'fresh-context'/);
    expect(text).toMatch(/does\s+NOT satisfy the configured posture/);
    expect(text).toMatch(/validity judge-pack run_a6_1/);
    // A warning, never a block.
    expect(text).toMatch(/Recorded 1 soft score/);
    const sc = result.structuredContent as { selfScored: boolean; judgeMode: string };
    expect(sc.selfScored).toBe(true);
    expect(sc.judgeMode).toBe('fresh-context');
  });

  it('fresh-context WITHOUT scoredBy → unrecorded-judge warning, badged self-scored (deny-by-default)', async () => {
    writeConfig(projectRoot, 'fresh-context');
    seedRunWithFingerprint('run_a6_2', 'sfp-someoneelse');
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'screenshot shows a polished card',
          screenshotIds: ['Home'],
        },
      ],
    });
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/judge identity\s+is unrecorded/);
    expect(text).toMatch(/Treating as self-scored for\s+badging/);
    const sc = result.structuredContent as { selfScored: boolean; judgeMode: string };
    expect(sc.selfScored).toBe(true);
    expect(sc.judgeMode).toBe('fresh-context');
  });

  it('fresh-context + DISTINCT recorded judge → clean (selfScored false), scoring stamped on the latest run-meta', async () => {
    writeConfig(projectRoot, 'fresh-context');
    seedRunWithFingerprint('run_a6_3', 'sfp-someoneelse');
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scoredBy: 'judge-model-9',
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'screenshot shows a polished card',
          screenshotIds: ['Home'],
        },
      ],
    });
    const sc = result.structuredContent as { selfScored: boolean; judgeMode: string };
    expect(sc.selfScored).toBe(false);
    expect(sc.judgeMode).toBe('fresh-context');
    const meta = readRunMeta(projectRoot, 'run_a6_3')!;
    expect(meta.scoring).toEqual({
      judge: 'fresh-context',
      scoredBy: 'judge-model-9',
      selfScored: false,
      // E2.2: no rubricVersion in the call, so the current one is stamped ASSUMED.
      rubricVersion: RUBRIC_VERSION,
      rubricVersionAssumed: true,
    });
  });

  it("CAN'T FALSE-GREEN: judge mode never changes verdict / signedOff / criterion statuses", async () => {
    // Same scores recorded under 'self' vs 'fresh-context' in fresh fixtures —
    // the persisted gate outputs must be identical; only badges/warnings move.
    const outcomes: Array<{ verdict: string; signedOff: boolean; statuses: unknown }> = [];
    for (const judge of ['self', 'fresh-context'] as const) {
      const root = mkdtempSync(resolve(tmpdir(), `validity-sct-a6-cfg-${judge}-`));
      try {
        seedScorecard(root);
        writeConfig(root, judge);
        seedCitableRun(root);
        await handleRecordSoftScores({
          specId: 'spec-a',
          projectRoot: root,
          scores: [
            {
              id: 'AC-2',
              status: 'pass',
              reasoning: 'screenshot evidence quoted',
              screenshotIds: ['Home'],
            },
          ],
        });
        const spec = loadScorecard(root)!.specs['spec-a']!;
        outcomes.push({
          verdict: spec.verdict,
          signedOff: spec.signedOff ?? false,
          statuses: Object.fromEntries(
            Object.entries(spec.criteria).map(([id, c]) => [id, c.status]),
          ),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it('FRESH-CLAIM LAUNDERING is visible: posture + matching fingerprint + all-pass still flags selfScored', async () => {
    writeConfig(projectRoot, 'fresh-context');
    seedRunWithFingerprint('run_a6_4', SESSION_FINGERPRINT);
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'screenshot shows a polished card',
          screenshotIds: ['Home'],
        },
      ],
    });
    const sc = result.structuredContent as { selfScored: boolean; verdict: string };
    // The deception is VISIBLE (selfScored true + warning), never silently clean.
    expect(sc.selfScored).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/WARNING/);
    const meta = readRunMeta(projectRoot, 'run_a6_4')!;
    expect(meta.scoring?.selfScored).toBe(true);
  });

  it("judge mode 'human' without a recorded identity also badges self-scored (no humanity heuristics)", async () => {
    writeConfig(projectRoot, 'human');
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'screenshot shows a polished card',
          screenshotIds: ['Home'],
        },
      ],
    });
    const sc = result.structuredContent as { selfScored: boolean; judgeMode: string };
    expect(sc.selfScored).toBe(true);
    expect(sc.judgeMode).toBe('human');
  });

  it('broken/missing config resolves to the default judge mode, never an error', async () => {
    // No config file at all in this fixture.
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'screenshot shows a polished card',
          screenshotIds: ['Home'],
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { judgeMode: string };
    expect(sc.judgeMode).toBe('self');
  });
});

describe('handleRecordSoftScores — Validity Score surface + history posture (F1)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-sct-f1-'));
    delete process.env.VALIDITY_BUILDER_MODEL;
    seedScorecard(projectRoot);
    seedCitableRun(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeHistoryConfig(root: string, historyCommitted: boolean): void {
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    writeFileSync(
      resolve(root, '.validity/config.ts'),
      `export default {
  renderMode: 'web',
  framework: 'auto',
  wrapper: './.validity/wrapper.gen.tsx',
  historyCommitted: ${historyCommitted},
};
`,
    );
  }

  it('surfaces the recomputed score in the text + structuredContent, beside (never instead of) verdict/signedOff', async () => {
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [
        {
          id: 'AC-2',
          status: 'pass',
          reasoning: 'screenshot shows the card',
          screenshotIds: ['Home'],
        },
      ],
    });
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    // seedScorecard tracks a single blocking soft criterion — a pass is 100.
    expect(text).toContain('Validity score: 100 (informational).');
    const sc = result.structuredContent as {
      verdict: string;
      signedOff: boolean;
      validityScore: number | null;
    };
    expect(sc.validityScore).toBe(100);
    expect(sc.verdict).toBe('pass');
    expect(sc.signedOff).toBe(true);
  });

  it('a FAIL score still reports honestly: low score line, verdict partial, signedOff false', async () => {
    const result = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [{ id: 'AC-2', status: 'fail', reasoning: 'screenshot shows broken spacing' }],
    });
    const sc = result.structuredContent as {
      verdict: string;
      signedOff: boolean;
      validityScore: number | null;
    };
    expect(sc.validityScore).toBe(0);
    expect(sc.verdict).toBe('partial'); // soft fail never becomes a hard FAIL rollup
    expect(sc.signedOff).toBe(false);
  });

  it('does NOT write score history by default (§9.4 — history is opt-in)', async () => {
    writeHistoryConfig(projectRoot, false);
    await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [{ id: 'AC-2', status: 'pass', reasoning: 'evidence', screenshotIds: ['Home'] }],
    });
    expect(existsSync(scoreHistoryPath(projectRoot))).toBe(false);
  });

  it('appends a soft-scores history row (+ merge=union gitattribute) when historyCommitted: true', async () => {
    writeHistoryConfig(projectRoot, true);
    await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      sha: 'sha-judge',
      scores: [{ id: 'AC-2', status: 'pass', reasoning: 'evidence', screenshotIds: ['Home'] }],
    });
    const rows = readScoreHistory(projectRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'soft-scores',
      sha: 'sha-judge',
      score: 100,
      perSpec: { 'spec-a': 100 },
    });
    const attrs = readFileSync(resolve(projectRoot, '.validity', '.gitattributes'), 'utf-8');
    expect(attrs).toContain('history/*.jsonl merge=union');
  });
});

/* ------------------------------------------------------------------ *
 * Citation relevance (Finding 1) + stale-capture sha (Finding 2).     *
 * ------------------------------------------------------------------ */
describe('handleRecordSoftScores — citation relevance + stale-capture sha (hardening)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-sct-rel-'));
    delete process.env.VALIDITY_BUILDER_MODEL;
    seedScorecard(projectRoot); // spec-a, AC-2 soft unscored
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Seed a COMPONENT-render run (not a URL page) so looksEmpty/filePath/git.sha are set. */
  function seedComponentRun(opts: {
    runId: string;
    sha?: string;
    looksEmpty?: boolean;
    filePath?: string;
    componentId?: string;
  }): void {
    const runId = opts.runId;
    ensureRunDirectories(projectRoot, runId);
    const componentId = opts.componentId ?? 'Card';
    const meta = {
      runId,
      specId: 'spec-a',
      specVersion: 1,
      specHash: 'h1',
      createdAt: `2026-02-01T00:00:0${runId.slice(-1)}Z`,
      prompt: 'p',
      scenarios: [],
      components: [
        {
          id: componentId,
          filePath: opts.filePath ?? 'src/Card.tsx',
          screenshotPath: `.validity/runs/${runId}/${componentId}.png`,
          looksEmpty: opts.looksEmpty ?? false,
        },
      ],
      ...(opts.sha ? { git: { sha: opts.sha } } : {}),
    } as unknown as RunMeta;
    writeFileSync(runMetaPathFor(projectRoot, runId), JSON.stringify(meta));
    indexRunForSpec(projectRoot, meta);
  }

  function firstText(res: Awaited<ReturnType<typeof handleRecordSoftScores>>): string {
    return (res.content as Array<{ text?: string }>)[0]!.text!;
  }

  it('REJECTS a soft PASS sourced only from an empty (blank) component render', async () => {
    seedComponentRun({ runId: 'run_empty1', looksEmpty: true });
    const res = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [{ id: 'AC-2', status: 'pass', reasoning: 'looks good', screenshotIds: ['Card'] }],
    });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toMatch(/empty \(blank\) render/i);
    // Never landed — the criterion stays unscored.
    expect(loadScorecard(projectRoot)!.specs['spec-a']!.criteria['AC-2']!.status).toBe('unscored');
  });

  it('ACCEPTS a soft FAIL citing nothing (empty render still needs only reasoning)', async () => {
    seedComponentRun({ runId: 'run_empty2', looksEmpty: true });
    const res = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [{ id: 'AC-2', status: 'fail', reasoning: 'blank — nothing rendered' }],
    });
    expect(res.isError).toBeUndefined();
    expect(loadScorecard(projectRoot)!.specs['spec-a']!.criteria['AC-2']!.status).toBe('fail');
  });

  it('stamps the recorded score with the CITED RUN capture sha, NOT HEAD (staleness fires honestly)', async () => {
    seedComponentRun({ runId: 'run_old3', sha: 'oldsha123' });
    const res = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [
        { id: 'AC-2', status: 'pass', reasoning: 'evidence in shot', screenshotIds: ['Card'] },
      ],
    });
    expect(res.isError).toBeUndefined();
    // The temp dir is not a git repo, so HEAD (collectGitInfo) is undefined; only
    // the capture sha from run-meta could produce this value.
    expect(loadScorecard(projectRoot)!.specs['spec-a']!.criteria['AC-2']!.sha).toBe('oldsha123');
  });

  it('an explicit args.sha still overrides the capture sha (replay contract preserved)', async () => {
    seedComponentRun({ runId: 'run_ovr4', sha: 'capturesha' });
    await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      sha: 'override-sha',
      scores: [{ id: 'AC-2', status: 'pass', reasoning: 'evidence', screenshotIds: ['Card'] }],
    });
    expect(loadScorecard(projectRoot)!.specs['spec-a']!.criteria['AC-2']!.sha).toBe('override-sha');
  });

  it('surfaces a cross-component citation warning (advisory) but STILL applies the score', async () => {
    // spec.yaml declares a DIFFERENT target than the cited render's component.
    createSpec({
      projectRoot,
      specId: 'spec-a',
      prompt: 'p',
      criteria: [{ id: 'AC-2', text: 'Card looks polished', tier: 'soft' }],
      targets: { components: ['src/LoginForm.tsx'] },
    });
    freezeSpec({ projectRoot, specId: 'spec-a' });
    seedComponentRun({ runId: 'run_xc5', filePath: 'src/Card.tsx', componentId: 'Card' });
    const res = await handleRecordSoftScores({
      specId: 'spec-a',
      projectRoot,
      scores: [{ id: 'AC-2', status: 'pass', reasoning: 'evidence', screenshotIds: ['Card'] }],
    });
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toMatch(/outside this spec's targets/);
    const sc = res.structuredContent as { citationWarnings?: string[] };
    expect(sc.citationWarnings).toHaveLength(1);
    // Advisory — the pass still landed.
    expect(loadScorecard(projectRoot)!.specs['spec-a']!.criteria['AC-2']!.status).toBe('pass');
  });
});
