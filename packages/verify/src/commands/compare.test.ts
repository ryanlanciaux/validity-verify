/**
 * `validity compare` at the JS function boundary: fixture run-metas +
 * timelines → the resolution ladder (full × full, full × summary, miss ×
 * miss), missing-screenshot degrades, the different-specs warning path, and
 * the viewer-not-gate posture (all-fail content still exits 0).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDir, type RunMeta } from '@validity.ai/verify-spec';
import { runCompare } from './compare.js';

function makeProject(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-compare-cli-'));
}

interface SeedRunOpts {
  specId?: string;
  specVersion?: number;
  specHash?: string;
  verdict?: RunMeta['verdict'];
  statuses?: Record<string, 'pass' | 'fail' | 'unverifiable'>;
  screenshot?: boolean;
  screenshotSkipped?: boolean;
  performance?: { mountMs?: number };
}

function seedRun(root: string, runId: string, opts: SeedRunOpts = {}): void {
  const runRoot = runDir(root, runId);
  mkdirSync(resolve(runRoot, 'screenshots'), { recursive: true });
  const screenshotPath = resolve(runRoot, 'screenshots', 'login-form__base__base.png');
  if (opts.screenshot !== false && !opts.screenshotSkipped) {
    writeFileSync(screenshotPath, 'png-bytes');
  }
  const statuses = opts.statuses ?? { 'AC-1': 'pass' };
  const meta: RunMeta = {
    runId,
    createdAt: '2026-07-01T10:00:00.000Z',
    mode: 'isolation',
    prompt: 'Build the login form',
    scenarios: [],
    components: [
      {
        id: 'login-form',
        filePath: 'src/LoginForm.tsx',
        screenshotPath,
        screenshotSkipped: opts.screenshotSkipped,
        performance: opts.performance,
      },
    ],
    componentSources: { 'login-form': '' },
    diff: { files: [] },
    report: { enabled: false, brand: 'none' },
    specId: opts.specId,
    specVersion: opts.specVersion,
    specHash: opts.specHash,
    verdict: opts.verdict ?? 'pass',
    criterionVerdicts: Object.entries(statuses).map(([id, status]) => ({
      id,
      tier: 'hard',
      status,
    })),
  };
  writeFileSync(resolve(runRoot, 'run-meta.json'), JSON.stringify(meta, null, 2));
}

function seedTimelineRow(root: string, specId: string, runId: string, verdict = 'pass'): void {
  const dir = resolve(root, '.validity', 'specs', specId);
  mkdirSync(dir, { recursive: true });
  const row = {
    runId,
    createdAt: '2026-07-01T09:00:00.000Z',
    specVersion: 1,
    specHash: 'hash-1',
    verdict,
    counts: { pass: 1, fail: 0, unverifiable: 0 },
    criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
  };
  writeFileSync(resolve(dir, 'runs.jsonl'), JSON.stringify(row) + '\n', { flag: 'a' });
}

describe('runCompare', () => {
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

  const defaultOut = (a: string, b: string): string =>
    resolve(root, '.validity', 'reports', `compare-${a}--${b}.html`);

  it('full × full same spec: pairs screenshots by slug and renders criteria deltas', async () => {
    seedRun(root, 'run_a', { specId: 'spec-x', specHash: 'h1', specVersion: 1 });
    seedRun(root, 'run_b', {
      specId: 'spec-x',
      specHash: 'h1',
      specVersion: 1,
      statuses: { 'AC-1': 'unverifiable' },
      verdict: 'partial',
    });
    await runCompare('run_a', 'run_b', { cwd: root });
    expect(exitSpy).not.toHaveBeenCalled();
    const html = readFileSync(defaultOut('run_a', 'run_b'), 'utf-8');
    // One paired row (same slug on both sides) with inlined screenshots.
    expect(html.split('login-form__base__base').length - 1).toBeGreaterThanOrEqual(1);
    expect(html).toContain('data:image/png;base64,');
    // pass → unverifiable is a REGRESSION (lattice), never an improvement.
    expect(html).toContain('▼ regressed');
    expect(html).not.toContain('▲ improved');
    expect(stdoutBuf).toContain('Compare written:');
  });

  it('different specs: prints a warning, banners the page, and skips the delta table', async () => {
    seedRun(root, 'run_a', { specId: 'spec-x' });
    seedRun(root, 'run_b', { specId: 'spec-y' });
    await runCompare('run_a', 'run_b', { cwd: root });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stdoutBuf).toContain('different specs');
    const html = readFileSync(defaultOut('run_a', 'run_b'), 'utf-8');
    expect(html).toContain('DIFFERENT specs');
    expect(html).not.toContain('Criteria deltas');
  });

  it('missing screenshot file and screenshotSkipped degrade to labeled placeholders, never an <img>', async () => {
    seedRun(root, 'run_a', { specId: 'spec-x', screenshot: false });
    seedRun(root, 'run_b', { specId: 'spec-x', screenshotSkipped: true });
    await runCompare('run_a', 'run_b', { cwd: root });
    const html = readFileSync(defaultOut('run_a', 'run_b'), 'utf-8');
    expect(html).toContain('screenshot file no longer on disk');
    expect(html).toContain('screenshot skipped (definitively-red render)');
    // No SCREENSHOT image — missing shots degrade to labeled placeholders, never
    // a stale/blank <img>. (The inlined brand wordmark <img> header is expected.)
    expect(html).not.toContain('class="vp-shot"');
  });

  it('full × summary: a deleted run dir degrades to its indexed timeline row', async () => {
    seedRun(root, 'run_a', { specId: 'spec-x', specHash: 'hash-1', specVersion: 1 });
    seedTimelineRow(root, 'spec-x', 'run_gone');
    await runCompare('run_a', 'run_gone', { cwd: root });
    expect(exitSpy).not.toHaveBeenCalled();
    const html = readFileSync(defaultOut('run_a', 'run_gone'), 'utf-8');
    expect(html).toContain('indexed summary');
    // Criteria still compare (both sides carry the snapshot).
    expect(html).toContain('Criteria deltas');
  });

  it('miss × miss: exits 1 and suggests known run ids', async () => {
    seedTimelineRow(root, 'spec-x', 'run_known');
    await expect(runCompare('run_nope1', 'run_nope2', { cwd: root })).rejects.toThrow(/__exit:1/);
    expect(stderrBuf).toContain('run_nope1, run_nope2');
    expect(stderrBuf).toContain('run_known');
    expect(existsSync(defaultOut('run_nope1', 'run_nope2'))).toBe(false);
  });

  it('identical runIds error (exit 1)', async () => {
    seedRun(root, 'run_a', {});
    await expect(runCompare('run_a', 'run_a', { cwd: root })).rejects.toThrow(/__exit:1/);
    expect(stderrBuf).toContain('identical');
  });

  it('viewer, never a gate: an all-fail compare still exits 0 (and honors --out)', async () => {
    seedRun(root, 'run_a', {
      specId: 'spec-x',
      statuses: { 'AC-1': 'fail' },
      verdict: 'fail',
    });
    seedRun(root, 'run_b', {
      specId: 'spec-x',
      statuses: { 'AC-1': 'fail' },
      verdict: 'fail',
    });
    const out = resolve(root, 'my-compare.html');
    await runCompare('run_a', 'run_b', { cwd: root, out });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(existsSync(out)).toBe(true);
  });
});
