/**
 * Best-effort end-to-end test for the LLM-driven loop.
 *
 * Spawns `claude --dangerously-skip-permissions -p "<prompt>"` inside the
 * fixture project and asserts it discovered the Validity skill and invoked
 * `validity validate` (which writes a run record to .validity/runs/).
 *
 * Why "best-effort":
 *   - Depends on the Claude Code binary being installed and authed.
 *   - Depends on the Validity skill being installed at ~/.claude/skills/validity.
 *   - The model's tool-call decision is non-deterministic, so this test may
 *     occasionally fail despite the skill working. If it goes flaky, drop it
 *     from CI and run it by hand before a release.
 *
 * Gated behind VALIDITY_E2E=1 + VALIDITY_E2E_CLAUDE=1 so even the regular
 * e2e run doesn't require Claude Code to be installed.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);

const E2E_ENABLED = process.env.VALIDITY_E2E === '1' && process.env.VALIDITY_E2E_CLAUDE === '1';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const fixtureSrc = resolve(repoRoot, 'examples/basic-vite-app');

const describeE2E = E2E_ENABLED ? describe : describe.skip;

describeE2E('claude-driven validity loop (manual / pre-release)', () => {
  let workdir: string;

  beforeAll(async () => {
    if (!E2E_ENABLED) return;

    // Sanity: Claude Code must be on PATH and the skill must be installed.
    try {
      await execFileP('claude', ['--version'], { timeout: 10_000 });
    } catch (err) {
      throw new Error(
        `Claude Code not on PATH (try: pnpm install:local first):\n${(err as Error).message}`,
      );
    }
    const skillPath = resolve(process.env.HOME ?? '', '.claude/skills/validity/SKILL.md');
    if (!existsSync(skillPath)) {
      throw new Error(`Validity skill not installed at ${skillPath}. Run: pnpm install:local`);
    }

    workdir = mkdtempSync(resolve(tmpdir(), 'validity-claude-e2e-'));
    cpSync(fixtureSrc, workdir, {
      recursive: true,
      filter: (src) => !src.includes('node_modules'),
    });
  }, 30_000);

  afterAll(() => {
    if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
  });

  it('invokes validity validate when asked to verify acceptance criteria', async () => {
    const prompt =
      'This project has a Card component (src/components/Card.tsx). ' +
      'Verify it shows a title and body of text. Use validity to check.';

    // We don't assert the model's exact behavior — only that running this
    // prompt with the skill present causes validity to be invoked at some
    // point (which writes .validity/runs/<id>/). If validity is never run,
    // the skill is broken or the agent didn't pick it up.
    const { stdout, stderr } = await execFileP(
      'claude',
      ['--dangerously-skip-permissions', '-p', prompt],
      { cwd: workdir, maxBuffer: 32 * 1024 * 1024, timeout: 600_000 },
    );

    const runsDir = resolve(workdir, '.validity', 'runs');
    const ranValidity = existsSync(runsDir) && readdirSync(runsDir).length > 0;
    const mentionedCli = /validity\s+(validate|lock)/i.test(stdout + stderr);

    expect(
      ranValidity || mentionedCli,
      `Expected Claude Code to invoke validity (runs dir empty, no validity command in output).\n` +
        `STDOUT (first 2KB):\n${stdout.slice(0, 2000)}`,
    ).toBe(true);
  }, 600_000);
});
