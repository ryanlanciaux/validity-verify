/**
 * Smoke tests for `validity judge-pack <run-id>` at the JS function boundary
 * (mirrors export.test.ts conventions): synthetic project root + frozen spec +
 * run-meta, then assert the pack lands / the refusals are actionable.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpec, freezeSpec, runDir, type Spec } from '@validity.ai/verify-spec';
import { runJudgePack } from './judge-pack.js';

function makeProject(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-judge-pack-cli-'));
}

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

function seedRun(root: string, runId: string, spec?: Spec): void {
  const runRoot = runDir(root, runId);
  mkdirSync(resolve(runRoot, 'screenshots'), { recursive: true });
  const screenshotPath = resolve(runRoot, 'screenshots/login-form__base.png');
  writeFileSync(screenshotPath, 'png-bytes');
  const meta = {
    runId,
    createdAt: new Date().toISOString(),
    mode: 'isolation',
    prompt: 'Test the login form',
    scenarios: [],
    components: [{ id: 'login-form', filePath: 'src/LoginForm.tsx', screenshotPath }],
    componentSources: { 'login-form': '' },
    diff: { files: [] },
    report: { enabled: true, brand: 'validity' },
    ...(spec ? { specId: spec.id, specVersion: spec.version, specHash: spec.hash } : {}),
  };
  writeFileSync(resolve(runRoot, 'run-meta.json'), JSON.stringify(meta, null, 2));
}

describe('runJudgePack', () => {
  let root: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutBuf: string;
  let stderrBuf: string;

  beforeEach(() => {
    root = makeProject();
    stdoutBuf = '';
    stderrBuf = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutBuf += String(chunk);
      return true;
    }) as never;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrBuf += String(chunk);
      return true;
    }) as never;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('writes the pack and prints the hand-off framing', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_ok', spec);
    await runJudgePack('run_ok', { cwd: root });
    expect(stdoutBuf).toMatch(/Judge pack written: \.validity\/runs\/run_ok\/judge-pack\//);
    expect(stdoutBuf).toMatch(/1 soft criterion \(frozen spec spec-.* v1\)/);
    expect(stdoutBuf).toMatch(/no source,\nno diff, and no prompt history/);
    expect(stdoutBuf).toMatch(/validity__record_soft_scores/);
    const packDir = resolve(root, '.validity/runs/run_ok/judge-pack');
    expect(existsSync(resolve(packDir, 'rubric.json'))).toBe(true);
    expect(existsSync(resolve(packDir, 'SCORING.md'))).toBe(true);
    expect(existsSync(resolve(packDir, 'scores.schema.json'))).toBe(true);
    const rubric = JSON.parse(readFileSync(resolve(packDir, 'rubric.json'), 'utf-8'));
    expect(rubric.criteria.map((c: { id: string }) => c.id)).toEqual(['AC-1']);
  });

  it('errors with recent run ids when runId is unknown', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_known_1', spec);
    await expect(runJudgePack('run_does_not_exist', { cwd: root })).rejects.toThrow(/__exit:1/);
    expect(stderrBuf).toMatch(/no run-meta found for "run_does_not_exist"/);
    expect(stderrBuf).toMatch(/Recent run ids:/);
    expect(stderrBuf).toMatch(/run_known_1/);
  });

  it('refuses an unplanned run with the plan-first redirect', async () => {
    seedRun(root, 'run_unplanned');
    await expect(runJudgePack('run_unplanned', { cwd: root })).rejects.toThrow(/__exit:1/);
    expect(stderrBuf).toMatch(/has no frozen spec/);
    expect(stderrBuf).toMatch(/validity__plan/);
  });

  it('exits 0 with a "nothing to judge" message for a hard-only spec', async () => {
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [
        {
          id: 'AC-1',
          text: 'Submit posts',
          tier: 'hard',
          checks: [{ expect: { console: { errors: 0 } } }],
        },
      ],
    });
    const spec = freezeSpec({ projectRoot: root, specId }).spec;
    seedRun(root, 'run_hard_only', spec);
    await runJudgePack('run_hard_only', { cwd: root });
    expect(stdoutBuf).toMatch(/nothing to judge — all criteria are hard\/property/);
  });

  it('requires a runId (exit 2 + usage)', async () => {
    await expect(runJudgePack('', { cwd: root })).rejects.toThrow(/__exit:2/);
    expect(stderrBuf).toMatch(/a runId is required/);
  });

  it('honors --out', async () => {
    const spec = seedSpec(root);
    seedRun(root, 'run_out', spec);
    const out = resolve(root, 'handoff');
    await runJudgePack('run_out', { cwd: root, out });
    expect(existsSync(resolve(out, 'rubric.json'))).toBe(true);
  });
});
