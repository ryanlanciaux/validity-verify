/**
 * Smoke tests for `validity export <run-id>`. We exercise the command at
 * the JS function boundary (not by spawning the CLI binary) — building a
 * synthetic project root with a minimal `.validity/config.ts` and
 * `run-meta.json`, then asserting the command writes specs / refuses
 * unsupported targets / handles missing runs gracefully.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runExport } from './export.js';

function makeProject(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-export-cli-'));
  mkdirSync(resolve(root, '.validity'), { recursive: true });
  writeFileSync(
    resolve(root, '.validity/config.ts'),
    `export default {
  renderMode: 'web',
  framework: 'auto',
  wrapper: './.validity/wrapper.gen.tsx',
  mockNetwork: { handlers: [{ url: '/api/me', json: { id: 1 } }] },
  scenarios: {
    'logged-in': {
      mockNetwork: { cookies: { session: 's1' } },
    },
  },
};
`,
  );
  return root;
}

function seedRun(root: string, runId: string) {
  const runRoot = resolve(root, '.validity/runs', runId);
  mkdirSync(resolve(runRoot, 'screenshots'), { recursive: true });
  const meta = {
    runId,
    createdAt: new Date().toISOString(),
    mode: 'isolation',
    prompt: 'Test the login form',
    scenarios: ['logged-in'],
    components: [
      {
        id: 'login-form',
        filePath: 'src/LoginForm.tsx',
        screenshotPath: resolve(runRoot, 'screenshots/login-form__logged-in.png'),
        scenarioId: 'logged-in',
      },
    ],
    componentSources: { 'login-form': '' },
    diff: { files: [] },
    report: { enabled: true, brand: 'validity' },
  };
  writeFileSync(resolve(runRoot, 'run-meta.json'), JSON.stringify(meta, null, 2));
}

describe('runExport', () => {
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

  it('refuses --target=cypress with a clear error', async () => {
    seedRun(root, 'run_unsup');
    await expect(runExport('run_unsup', { cwd: root, target: 'cypress' })).rejects.toThrow(
      /__exit:2/,
    );
    expect(stderrBuf).toMatch(/only --target=playwright is supported/);
    expect(stderrBuf).toMatch(/Cypress \/ Maestro/);
  });

  it('errors with recent run ids when runId is unknown', async () => {
    seedRun(root, 'run_known_1');
    seedRun(root, 'run_known_2');
    await expect(runExport('run_does_not_exist', { cwd: root })).rejects.toThrow(/__exit:1/);
    expect(stderrBuf).toMatch(/no run-meta found for "run_does_not_exist"/);
    expect(stderrBuf).toMatch(/Recent run ids:/);
    expect(stderrBuf).toMatch(/run_known_/);
  });

  it('writes a Playwright spec for the run', async () => {
    seedRun(root, 'run_ok');
    await runExport('run_ok', { cwd: root });
    const outDir = resolve(root, 'tests/e2e');
    const specs = readdirSync(outDir).filter((f) => f.endsWith('.spec.ts'));
    expect(specs).toHaveLength(1);
    const src = readFileSync(resolve(outDir, specs[0]!), 'utf-8');
    expect(src).toContain("import { test, expect } from '@playwright/test'");
    expect(src).toContain('logged-in');
    expect(stdoutBuf).toMatch(/Wrote 1 Playwright scaffold/);
    expect(stdoutBuf).toMatch(/SCAFFOLDS, not tests/);
  });

  it('persists report-meta.json criteria via the round-trip when present', async () => {
    seedRun(root, 'run_with_criteria');
    writeFileSync(
      resolve(root, '.validity/runs/run_with_criteria/report-meta.json'),
      JSON.stringify({
        runId: 'run_with_criteria',
        criteria: [
          {
            description: 'The form posts to /api/login when submitted',
            status: 'pass',
            reasoning: 'Saw the POST in the network panel.',
          },
        ],
      }),
    );
    await runExport('run_with_criteria', { cwd: root });
    const outDir = resolve(root, 'tests/e2e');
    const specs = readdirSync(outDir).filter((f) => f.endsWith('.spec.ts'));
    const src = readFileSync(resolve(outDir, specs[0]!), 'utf-8');
    expect(src).toContain('"TODO assertion: The form posts to /api/login when submitted"');
    expect(src).toContain('Saw the POST');
  });
});
