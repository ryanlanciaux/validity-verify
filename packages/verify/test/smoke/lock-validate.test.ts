/**
 * End-to-end smoke: drive the real `validity` CLI against the example Vite
 * app. Gated behind VALIDITY_E2E=1 so `pnpm test` stays fast in CI.
 *
 * The CLI binary is packages/verify/dist/cli.js. Run `pnpm build` first.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);

const E2E_ENABLED = process.env.VALIDITY_E2E === '1';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const cliBin = resolve(repoRoot, 'packages/verify/dist/cli.js');
const fixtureSrc = resolve(repoRoot, 'examples/basic-vite-app');

const describeE2E = E2E_ENABLED ? describe : describe.skip;

describeE2E('validity CLI end-to-end', () => {
  let workdir: string;

  beforeAll(() => {
    if (!E2E_ENABLED) return;
    if (!existsSync(cliBin)) {
      throw new Error(`CLI binary missing at ${cliBin}. Run 'pnpm build' first.`);
    }

    workdir = mkdtempSync(resolve(tmpdir(), 'validity-e2e-'));
    cpSync(fixtureSrc, workdir, {
      recursive: true,
      filter: (src) => !src.includes('node_modules'),
    });
  }, 30_000);

  afterAll(() => {
    if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
  });

  it('verify --all runs frozen hard checks on the example app', async () => {
    const { stdout, exitCode } = await runCli(['verify', '--all'], workdir, { allowNonZero: true });
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  }, 300_000);
});

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  args: string[],
  cwd: string,
  opts: { allowNonZero?: boolean } = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileP('node', [cliBin, ...args], {
      cwd,
      env: { ...process.env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    if (!opts.allowNonZero) {
      throw new Error(
        `CLI exited non-zero (${e.code ?? 'unknown'}):\nSTDOUT:\n${e.stdout}\nSTDERR:\n${e.stderr}`,
      );
    }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}
