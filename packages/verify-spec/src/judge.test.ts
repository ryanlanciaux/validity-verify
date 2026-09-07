/**
 * Tests for the core `runJudge` engine: a synthetic project (frozen spec +
 * run-meta + seeded scorecard), a mocked provider fetch, and assertions on the
 * pack→score round trip, the shared citation gate, the schema retry, provenance
 * stamping, the single-target throw contract, and every failure→skipped path.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JudgeError, runJudge } from './judge.js';
import { createSpec, freezeSpec } from './specs.js';
import { runDir } from './runs.js';
import { indexRunForSpec } from './run.js';
import { loadScorecard, reconcileScorecard, saveScorecard } from './scorecard.js';
import { observationFromVerdicts } from './scorecard-fold.js';
import type { CriterionVerdict, Spec } from './spec-schema.js';
import type { RunMeta } from './run.js';
import type { ValidityConfig } from './types.js';

const NOW = '2026-07-20T00:00:00.000Z';
const now = () => NOW;

function makeProject(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-judge-'));
}

/** Frozen spec: one soft criterion (judge's job) + one hard (mechanical). */
function seedSpec(root: string): Spec {
  const { specId } = createSpec({
    projectRoot: root,
    prompt: 'Build the login form',
    criteria: [
      { id: 'AC-1', text: 'Form looks polished', tier: 'soft' },
      {
        id: 'AC-2',
        text: 'Submit posts the form',
        tier: 'hard',
        checks: [{ expect: { network: { method: 'POST', url: '/api/login', status: '2xx' } } }],
      },
    ],
  });
  return freezeSpec({ projectRoot: root, specId }).spec;
}

function seedRun(root: string, runId: string, spec: Spec): void {
  const runRoot = runDir(root, runId);
  mkdirSync(resolve(runRoot, 'screenshots'), { recursive: true });
  const screenshotPath = resolve(runRoot, 'screenshots/login-form__base.png');
  writeFileSync(
    screenshotPath,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const meta = {
    runId,
    createdAt: NOW,
    mode: 'isolation',
    prompt: 'Test the login form',
    scenarios: [],
    components: [{ id: 'login-form', filePath: 'src/LoginForm.tsx', screenshotPath }],
    componentSources: { 'login-form': '' },
    diff: { files: [] },
    report: { enabled: true, brand: 'validity' },
    specId: spec.id,
    specVersion: spec.version,
    specHash: spec.hash,
    // Soft placeholder verdict the judge overwrites (mirrors submit_report).
    criterionVerdicts: [
      { id: 'AC-1', tier: 'soft', status: 'unverifiable' },
      { id: 'AC-2', tier: 'hard', status: 'pass' },
    ],
  };
  writeFileSync(resolve(runRoot, 'run-meta.json'), JSON.stringify(meta, null, 2));
  indexRunForSpec(root, meta as unknown as RunMeta);
}

function seedScorecard(root: string, spec: Spec, verdicts: CriterionVerdict[] = []): void {
  const obs = observationFromVerdicts(spec, verdicts);
  const { scorecard } = reconcileScorecard({ prev: null, observations: [obs], now: NOW });
  saveScorecard(root, scorecard);
}

function judgeConfig(overrides: Partial<ValidityConfig> = {}): ValidityConfig {
  return {
    renderMode: 'web',
    framework: 'auto',
    wrapper: './.validity/wrapper.gen.tsx',
    components: {},
    scoring: { judgeModel: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' } },
    ...overrides,
  } as ValidityConfig;
}

/** A fetch double returning a queued list of Anthropic-shaped responses. */
function queuedFetch(
  responses: Array<{ ok?: boolean; status?: number; text: string } | { throwAbort: true }>,
) {
  let i = 0;
  const fn = (async () => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    if ('throwAbort' in r) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => ({ content: [{ type: 'text', text: r.text }] }),
      text: async () => r.text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, count: () => i };
}

const validReply = (opts: { id?: string; status?: string; shot?: string } = {}) =>
  JSON.stringify({
    scores: [
      {
        id: opts.id ?? 'AC-1',
        status: opts.status ?? 'pass',
        reasoning: 'the form is polished, aligned, and legible',
        screenshotIds: [opts.shot ?? 'login-form'],
      },
    ],
    scoredBy: 'anthropic/claude',
  });

describe('runJudge', () => {
  let root: string;
  beforeEach(() => {
    root = makeProject();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('never sends symlink screenshot bytes to the judge', async () => {
    const outside = makeProject();
    try {
      const spec = seedSpec(root);
      seedRun(root, 'run_symlink', spec);
      const path = resolve(runDir(root, 'run_symlink'), 'screenshots/login-form__base.png');
      const target = resolve(outside, 'dummy-secret.txt');
      writeFileSync(target, 'OUTSIDE_PRIVATE_SENTINEL');
      rmSync(path);
      symlinkSync(target, path);
      const { fn, count } = queuedFetch([{ text: validReply() }]);
      await runJudge({
        projectRoot: root,
        runId: 'run_symlink',
        config: judgeConfig(),
        apiKey: 'fake-test-key',
        fetchImpl: fn,
        now,
        onFailure: 'return',
      });
      expect(count()).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('pack→score round trip: folds a valid judged pass + stamps model provenance', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_ok', spec);
    seedScorecard(root, spec);
    const { fn } = queuedFetch([{ text: validReply() }]);

    const { outcomes } = await runJudge({
      projectRoot: root,
      runId: 'run_ok',
      config: judgeConfig(),
      apiKey: 'sk-test',
      fetchImpl: fn,
      now,
    });

    expect(outcomes).toHaveLength(1);
    const o = outcomes[0]!;
    expect(o.status).toBe('judged');
    expect(o.applied).toEqual(['AC-1']);
    expect(o.scoredBy).toBe('anthropic/claude-3-5-sonnet-latest');

    const sc = loadScorecard(root)!;
    const crit = sc.specs[spec.id]!.criteria['AC-1']!;
    expect(crit.status).toBe('pass');
    expect(crit.scoredBy).toBe('anthropic/claude-3-5-sonnet-latest');

    // Run-meta: scoring stamped model + the soft criterionVerdict overwritten.
    const meta = JSON.parse(readFileSync(resolve(runDir(root, 'run_ok'), 'run-meta.json'), 'utf8'));
    expect(meta.scoring.judge).toBe('model');
    expect(meta.scoring.selfScored).toBe(false);
    expect(meta.scoring.judgeModel).toBe('anthropic/claude-3-5-sonnet-latest');
    const softVerdict = meta.criterionVerdicts.find((v: { id: string }) => v.id === 'AC-1');
    expect(softVerdict.status).toBe('pass');
    expect(softVerdict.scoredBy.model).toBe('anthropic/claude-3-5-sonnet-latest');
  });

  it('citation gate: a judged pass citing an unknown render id is rejected (never false green)', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_bad_cite', spec);
    seedScorecard(root, spec);
    const { fn } = queuedFetch([{ text: validReply({ shot: 'ghost-render' }) }]);

    const { outcomes } = await runJudge({
      projectRoot: root,
      runId: 'run_bad_cite',
      config: judgeConfig(),
      apiKey: 'sk-test',
      fetchImpl: fn,
      now,
      onFailure: 'return',
    });
    const o = outcomes[0]!;
    expect(o.status).toBe('skipped');
    expect(o.reason).toMatch(/unknown render id/);
    expect(loadScorecard(root)!.specs[spec.id]!.criteria['AC-1']!.status).toBe('unscored');
  });

  it('schema retry: recovers on a second, valid reply', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_retry', spec);
    seedScorecard(root, spec);
    const { fn, count } = queuedFetch([{ text: 'I am not JSON' }, { text: validReply() }]);

    const { outcomes } = await runJudge({
      projectRoot: root,
      runId: 'run_retry',
      config: judgeConfig(),
      apiKey: 'sk-test',
      fetchImpl: fn,
      now,
    });
    expect(count()).toBe(2);
    expect(outcomes[0]!.status).toBe('judged');
    expect(outcomes[0]!.applied).toEqual(['AC-1']);
  });

  it('schema-invalid twice → skipped with reason (never a pass)', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_bad_schema', spec);
    seedScorecard(root, spec);
    const { fn } = queuedFetch([{ text: 'nope' }, { text: 'still nope' }]);

    const { outcomes } = await runJudge({
      projectRoot: root,
      runId: 'run_bad_schema',
      config: judgeConfig(),
      apiKey: 'sk-test',
      fetchImpl: fn,
      now,
      onFailure: 'return',
    });
    expect(outcomes[0]!.status).toBe('skipped');
    expect(outcomes[0]!.reason).toMatch(/failed the schema twice/);
    expect(loadScorecard(root)!.specs[spec.id]!.criteria['AC-1']!.status).toBe('unscored');
  });

  it('provider error → skipped with the HTTP status (no pass)', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_429', spec);
    seedScorecard(root, spec);
    const { fn } = queuedFetch([{ ok: false, status: 429, text: 'rate limited' }]);

    const { outcomes } = await runJudge({
      projectRoot: root,
      runId: 'run_429',
      config: judgeConfig(),
      apiKey: 'sk-test',
      fetchImpl: fn,
      now,
      onFailure: 'return',
    });
    expect(outcomes[0]!.status).toBe('skipped');
    expect(outcomes[0]!.reason).toMatch(/judge model error/);
    expect(outcomes[0]!.reason).toMatch(/429/);
  });

  it('missing API key → skipped with the env var name (never dropped)', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_nokey', spec);
    seedScorecard(root, spec);
    const { outcomes } = await runJudge({
      projectRoot: root,
      runId: 'run_nokey',
      config: judgeConfig({
        scoring: {
          judgeModel: { provider: 'openai', model: 'gpt-4o', apiKeyEnv: 'DEFINITELY_UNSET_XYZ' },
        },
      }),
      now,
      onFailure: 'return',
    });
    expect(outcomes[0]!.status).toBe('skipped');
    expect(outcomes[0]!.reason).toMatch(/DEFINITELY_UNSET_XYZ is not set/);
  });

  it('no judgeModel configured → skipped', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_nomodel', spec);
    seedScorecard(root, spec);
    const { outcomes } = await runJudge({
      projectRoot: root,
      runId: 'run_nomodel',
      config: judgeConfig({ scoring: {} }),
      now,
      onFailure: 'return',
    });
    expect(outcomes[0]!.status).toBe('skipped');
    expect(outcomes[0]!.reason).toMatch(/no scoring.judgeModel configured/);
  });

  it('no prior deterministic tick (no scorecard entry) → skipped', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_noseed', spec);
    const { fn } = queuedFetch([{ text: validReply() }]);
    const { outcomes } = await runJudge({
      projectRoot: root,
      runId: 'run_noseed',
      config: judgeConfig(),
      apiKey: 'sk-test',
      fetchImpl: fn,
      now,
      onFailure: 'return',
    });
    expect(outcomes[0]!.status).toBe('skipped');
    expect(outcomes[0]!.reason).toMatch(/no scorecard entry/);
  });

  it('single-target failure THROWS a JudgeError by default (watch-loop contract)', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_throw', spec);
    seedScorecard(root, spec);
    const { fn } = queuedFetch([{ ok: false, status: 500, text: 'boom' }]);

    // No onFailure → default throw for a single target.
    await expect(
      runJudge({
        projectRoot: root,
        specId: spec.id,
        config: judgeConfig(),
        apiKey: 'sk-test',
        fetchImpl: fn,
        now,
      }),
    ).rejects.toBeInstanceOf(JudgeError);
    // The soft criterion never landed.
    expect(loadScorecard(root)!.specs[spec.id]!.criteria['AC-1']!.status).toBe('unscored');
  });

  it('routes via signal.specId when no explicit selector is given', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_signal', spec);
    seedScorecard(root, spec);
    const { fn } = queuedFetch([{ text: validReply() }]);
    const { outcomes } = await runJudge({
      projectRoot: root,
      config: judgeConfig(),
      apiKey: 'sk-test',
      fetchImpl: fn,
      now,
      // The watch loop passes its driving Signal; specId is read off it.
      signal: { specId: spec.id } as never,
    });
    expect(outcomes[0]!.specId).toBe(spec.id);
    expect(outcomes[0]!.status).toBe('judged');
  });

  it('--all judges only frozen specs whose soft criteria are open', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_all', spec);
    seedScorecard(root, spec);
    const { fn } = queuedFetch([{ text: validReply() }]);
    const { outcomes } = await runJudge({
      projectRoot: root,
      all: true,
      config: judgeConfig(),
      apiKey: 'sk-test',
      fetchImpl: fn,
      now,
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.specId).toBe(spec.id);
    expect(outcomes[0]!.status).toBe('judged');
  });
});
