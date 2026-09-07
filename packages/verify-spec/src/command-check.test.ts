/**
 * `expect.command` runner + verdict arithmetic (A5). The load-bearing
 * invariants: an unconfigured/no-op/unspawnable command can NEVER pass, a
 * timeout is a fail (never green, never a coverage gap), the resolved shell
 * string is stamped into the verdict as the post-freeze config-drift audit
 * surface, the runner dedupes by resolved string, and the overlay never
 * upgrades a verdict on collision.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COMMAND_OUTPUT_TAIL_CHARS,
  CommandCheckRunner,
  buildRepoA11yCriterion,
  buildRepoTypecheckCriterion,
  commandCheckVerdict,
  executeCommandCriteria,
  overlayCommandVerdicts,
  type CommandExec,
  type CommandExecResult,
} from './command-check.js';
import {
  criterionIsBlocking,
  type Check,
  type CriterionVerdict,
  type SpecCriterion,
} from './spec-schema.js';

const CHECK: Check = { expect: { command: { run: 'typecheck', exitCode: 0 } } };

function execResult(over: Partial<CommandExecResult> = {}): CommandExecResult {
  return { exitCode: 0, output: '', timedOut: false, durationMs: 42, ...over };
}

function commandCriterion(over: Partial<SpecCriterion> = {}): SpecCriterion {
  return {
    id: 'AC-cmd',
    text: 'repo typechecks',
    tier: 'property',
    checks: [{ expect: { command: { run: 'typecheck', exitCode: 0 } } }],
    ...over,
  };
}

describe('commandCheckVerdict', () => {
  it('unconfigured name → unverifiable with an actionable finding, never pass', () => {
    const v = commandCheckVerdict(CHECK, 'typecheck', undefined, undefined);
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toContain("command 'typecheck' is not configured");
    expect(v.detail).toContain('add commands.typecheck to .validity/config.ts');
    expect(v.command).toBeUndefined();
  });

  it('blank value → unverifiable (not configured)', () => {
    const v = commandCheckVerdict(CHECK, 'typecheck', '   ', undefined);
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toContain('not configured');
  });

  it.each(['true', ':', 'exit 0', '  true  ', ' exit  0 '])(
    'no-op resolution %j → unverifiable (a no-op cannot prove anything)',
    (resolved) => {
      const v = commandCheckVerdict(CHECK, 'typecheck', resolved, undefined);
      expect(v.status).toBe('unverifiable');
      expect(v.detail).toContain('resolves to a no-op');
      expect(v.command).toBeUndefined();
    },
  );

  it('spawn error → unverifiable, never pass', () => {
    const v = commandCheckVerdict(
      CHECK,
      'typecheck',
      'tsc --noEmit',
      execResult({ exitCode: null, spawnError: 'EACCES' }),
    );
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toContain("could not spawn 'tsc --noEmit'");
    expect(v.detail).toContain('EACCES');
  });

  it('timeout → FAIL with timedOut stamped (a hung command can never sign off)', () => {
    const v = commandCheckVerdict(
      CHECK,
      'typecheck',
      'tsc --noEmit',
      execResult({ exitCode: null, timedOut: true, durationMs: 180_000 }),
    );
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('timed out');
    expect(v.command).toEqual({
      resolved: 'tsc --noEmit',
      exitCode: null,
      durationMs: 180_000,
      timedOut: true,
    });
  });

  it('exit 1 vs expected 0 → fail with the resolved string + output tail', () => {
    const v = commandCheckVerdict(
      CHECK,
      'typecheck',
      'tsc --noEmit',
      execResult({ exitCode: 1, output: "src/App.tsx(3,1): error TS2322: Type 'x'..." }),
    );
    expect(v.status).toBe('fail');
    expect(v.detail).toContain(`command 'typecheck' ("tsc --noEmit") exited 1, expected 0`);
    expect(v.detail).toContain('error TS2322');
    expect(v.command).toMatchObject({ resolved: 'tsc --noEmit', exitCode: 1, timedOut: false });
  });

  it('matches a non-zero expected exit code', () => {
    const check: Check = { expect: { command: { run: 'grep-clean', exitCode: 2 } } };
    const v = commandCheckVerdict(
      check,
      'grep-clean',
      'grep -r TODO src',
      execResult({ exitCode: 2 }),
    );
    expect(v.status).toBe('pass');
    expect(v.command?.exitCode).toBe(2);
  });

  it('pass stamps the resolved string + exit code + duration (config-drift audit)', () => {
    const v = commandCheckVerdict(CHECK, 'typecheck', 'echo ok-ish', execResult({ exitCode: 0 }));
    expect(v.status).toBe('pass');
    expect(v.detail).toContain(`command 'typecheck' ("echo ok-ish") exited 0`);
    expect(v.command).toEqual({
      resolved: 'echo ok-ish',
      exitCode: 0,
      durationMs: 42,
      timedOut: false,
    });
  });

  it('truncates the output tail to COMMAND_OUTPUT_TAIL_CHARS and strips ANSI', () => {
    const noise = '\x1b[31mE\x1b[0m'.repeat(10) + 'x'.repeat(COMMAND_OUTPUT_TAIL_CHARS + 500);
    const v = commandCheckVerdict(
      CHECK,
      'typecheck',
      'tsc',
      execResult({ exitCode: 1, output: noise }),
    );
    expect(v.detail).not.toContain('\x1b');
    // detail = one summary line + newline + tail
    const tail = v.detail!.split('\n')[1]!;
    expect(tail.length).toBeLessThanOrEqual(COMMAND_OUTPUT_TAIL_CHARS);
  });
});

describe('CommandCheckRunner (dedupe by resolved string)', () => {
  it('runs one resolved string once and re-runs distinct strings', async () => {
    const exec = vi.fn<CommandExec>(async () => execResult());
    const runner = new CommandCheckRunner(exec);
    await runner.run('tsc --noEmit', { cwd: '/p', timeoutMs: 1000 });
    await runner.run('tsc --noEmit', { cwd: '/p', timeoutMs: 1000 });
    await runner.run('vitest run', { cwd: '/p', timeoutMs: 1000 });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('a fresh runner re-executes (no cross-cycle staleness)', async () => {
    const exec = vi.fn<CommandExec>(async () => execResult());
    await new CommandCheckRunner(exec).run('tsc --noEmit', { cwd: '/p', timeoutMs: 1000 });
    await new CommandCheckRunner(exec).run('tsc --noEmit', { cwd: '/p', timeoutMs: 1000 });
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('executeCommandCriteria', () => {
  it('two criteria referencing the same name share ONE execution + evidence', async () => {
    const exec = vi.fn<CommandExec>(async () => execResult({ exitCode: 0 }));
    const verdicts = await executeCommandCriteria({
      criteria: [commandCriterion({ id: 'AC-1' }), commandCriterion({ id: 'AC-2' })],
      commands: { typecheck: 'tsc --noEmit' },
      projectRoot: '/p',
      runner: new CommandCheckRunner(exec),
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(verdicts.map((v) => v.status)).toEqual(['pass', 'pass']);
    expect(verdicts[0]!.checks?.[0]?.command?.resolved).toBe('tsc --noEmit');
  });

  it('passes cwd = projectRoot and the configured timeout to the exec seam', async () => {
    const exec = vi.fn<CommandExec>(async () => execResult());
    await executeCommandCriteria({
      criteria: [commandCriterion()],
      commands: { typecheck: 'tsc --noEmit' },
      projectRoot: '/my/project',
      timeoutMs: 9_000,
      runner: new CommandCheckRunner(exec),
    });
    expect(exec).toHaveBeenCalledWith('tsc --noEmit', { cwd: '/my/project', timeoutMs: 9_000 });
  });

  it("CAN'T-FALSE-GREEN: `commands` map absent → unverifiable, nothing spawned", async () => {
    const exec = vi.fn<CommandExec>(async () => execResult());
    const verdicts = await executeCommandCriteria({
      criteria: [commandCriterion()],
      commands: undefined,
      projectRoot: '/p',
      runner: new CommandCheckRunner(exec),
    });
    expect(exec).not.toHaveBeenCalled();
    expect(verdicts[0]!.status).toBe('unverifiable');
    expect(verdicts[0]!.detail).toContain('not configured');
  });

  it("CAN'T-FALSE-GREEN: a name not in the config never executes (runner refuses)", async () => {
    const exec = vi.fn<CommandExec>(async () => execResult());
    const verdicts = await executeCommandCriteria({
      criteria: [
        commandCriterion({
          id: 'AC-evil',
          checks: [{ expect: { command: { run: 'not-declared' } } }],
        }),
      ],
      commands: { typecheck: 'tsc --noEmit' },
      projectRoot: '/p',
      runner: new CommandCheckRunner(exec),
    });
    expect(exec).not.toHaveBeenCalled();
    expect(verdicts[0]!.status).toBe('unverifiable');
  });

  it('a leaked non-command check is unverifiable, never a silent pass', async () => {
    const verdicts = await executeCommandCriteria({
      criteria: [
        commandCriterion({
          checks: [
            { expect: { command: { run: 'typecheck' } } },
            { expect: { element: { role: 'button', name: 'Send' } } },
          ],
        }),
      ],
      commands: { typecheck: 'tsc --noEmit' },
      projectRoot: '/p',
      runner: new CommandCheckRunner(async () => execResult()),
    });
    // fold: pass + unverifiable → unverifiable
    expect(verdicts[0]!.status).toBe('unverifiable');
  });

  it('multiple command checks in one criterion fold mechanically', async () => {
    const exec = vi.fn<CommandExec>(async (cmd) =>
      execResult({ exitCode: cmd.includes('lint') ? 1 : 0 }),
    );
    const verdicts = await executeCommandCriteria({
      criteria: [
        commandCriterion({
          checks: [
            { expect: { command: { run: 'typecheck' } } },
            { expect: { command: { run: 'lint' } } },
          ],
        }),
      ],
      commands: { typecheck: 'tsc --noEmit', lint: 'eslint .' },
      projectRoot: '/p',
      runner: new CommandCheckRunner(exec),
    });
    expect(verdicts[0]!.status).toBe('fail');
    expect(verdicts[0]!.checks).toHaveLength(2);
  });

  it('real spawn smoke test: exit 0 passes, exit 3 fails (no shell tricks)', async () => {
    const criteria = [
      commandCriterion({ id: 'AC-ok', checks: [{ expect: { command: { run: 'ok' } } }] }),
      commandCriterion({ id: 'AC-bad', checks: [{ expect: { command: { run: 'bad' } } }] }),
    ];
    const verdicts = await executeCommandCriteria({
      criteria,
      commands: {
        ok: `node -e "process.exit(0)"`,
        bad: `node -e "process.exit(3)"`,
      },
      projectRoot: process.cwd(),
    });
    expect(verdicts.find((v) => v.id === 'AC-ok')!.status).toBe('pass');
    const bad = verdicts.find((v) => v.id === 'AC-bad')!;
    expect(bad.status).toBe('fail');
    expect(bad.checks?.[0]?.command?.exitCode).toBe(3);
  });
});

describe('overlayCommandVerdicts', () => {
  const placeholder = (id: string): CriterionVerdict => ({
    id,
    tier: 'property',
    status: 'unverifiable',
    detail: 'checks did not execute (target component not among the rendered set)',
  });
  const executed = (id: string, status: CriterionVerdict['status']): CriterionVerdict => ({
    id,
    tier: 'property',
    status,
    checks: [{ check: CHECK, status }],
  });

  it('replaces the "did not execute" placeholder with the command verdict', () => {
    const merged = overlayCommandVerdicts([placeholder('AC-cmd')], [executed('AC-cmd', 'pass')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe('pass');
    expect(merged[0]!.checks).toBeDefined();
  });

  it("CAN'T-FALSE-GREEN: never upgrades — base fail + command pass stays fail", () => {
    const merged = overlayCommandVerdicts(
      [executed('AC-cmd', 'fail')],
      [executed('AC-cmd', 'pass')],
    );
    expect(merged[0]!.status).toBe('fail');
  });

  it('base pass + command fail becomes fail', () => {
    const merged = overlayCommandVerdicts(
      [executed('AC-cmd', 'pass')],
      [executed('AC-cmd', 'fail')],
    );
    expect(merged[0]!.status).toBe('fail');
  });

  it('appends command verdicts with no base entry (native executed-only list)', () => {
    const merged = overlayCommandVerdicts(
      [executed('AC-ui', 'pass')],
      [executed('AC-cmd', 'fail')],
    );
    expect(merged.map((v) => v.id)).toEqual(['AC-ui', 'AC-cmd']);
  });

  it('leaves untouched base verdicts alone and is a no-op with no command verdicts', () => {
    const base = [executed('AC-ui', 'pass')];
    expect(overlayCommandVerdicts(base, [])).toBe(base);
  });
});

describe('buildRepoTypecheckCriterion', () => {
  it('attaches a blocking property criterion when tsconfig + command exist', () => {
    const c = buildRepoTypecheckCriterion({
      hasTsconfig: true,
      typecheckCommand: 'tsc --noEmit',
      existingCriteria: [],
    });
    expect(c).toBeDefined();
    expect(c!.id).toBe('repo-typecheck');
    expect(c!.tier).toBe('property');
    expect(criterionIsBlocking(c!)).toBe(true);
    expect(c!.checks).toEqual([{ expect: { command: { run: 'typecheck', exitCode: 0 } } }]);
  });

  it('skips without tsconfig, without a command, or with a blank command', () => {
    expect(
      buildRepoTypecheckCriterion({
        hasTsconfig: false,
        typecheckCommand: 'tsc --noEmit',
        existingCriteria: [],
      }),
    ).toBeUndefined();
    expect(
      buildRepoTypecheckCriterion({
        hasTsconfig: true,
        typecheckCommand: undefined,
        existingCriteria: [],
      }),
    ).toBeUndefined();
    expect(
      buildRepoTypecheckCriterion({
        hasTsconfig: true,
        typecheckCommand: '  ',
        existingCriteria: [],
      }),
    ).toBeUndefined();
  });

  it('skips on id collision', () => {
    expect(
      buildRepoTypecheckCriterion({
        hasTsconfig: true,
        typecheckCommand: 'tsc --noEmit',
        existingCriteria: [{ id: 'repo-typecheck', text: 'taken', tier: 'soft' }],
      }),
    ).toBeUndefined();
  });

  it("skips when a run:'typecheck' command check already exists", () => {
    expect(
      buildRepoTypecheckCriterion({
        hasTsconfig: true,
        typecheckCommand: 'tsc --noEmit',
        existingCriteria: [
          {
            id: 'AC-1',
            text: 'typechecks',
            tier: 'hard',
            checks: [{ expect: { command: { run: 'typecheck' } } }],
          },
        ],
      }),
    ).toBeUndefined();
  });
});

describe('buildRepoA11yCriterion', () => {
  it('attaches a blocking property criterion gating critical axe violations (no config prerequisite)', () => {
    const c = buildRepoA11yCriterion({ existingCriteria: [] });
    expect(c).toBeDefined();
    expect(c!.id).toBe('repo-a11y-critical');
    expect(c!.tier).toBe('property');
    // No severity → blocking by default: a critical a11y violation gates sign-off.
    expect(criterionIsBlocking(c!)).toBe(true);
    expect(c!.checks).toEqual([{ expect: { a11y: { severity: 'critical', maxViolations: 0 } } }]);
  });

  it('skips on id collision', () => {
    expect(
      buildRepoA11yCriterion({
        existingCriteria: [{ id: 'repo-a11y-critical', text: 'taken', tier: 'soft' }],
      }),
    ).toBeUndefined();
  });

  it('skips when ANY existing criterion already carries an expect.a11y check (author budget wins)', () => {
    expect(
      buildRepoA11yCriterion({
        existingCriteria: [
          {
            id: 'AC-1',
            text: 'accessible',
            tier: 'hard',
            // A different severity/budget than the auto-gate — still dedups, so
            // the author's explicit budget is never double-gated.
            checks: [{ expect: { a11y: { severity: 'serious', maxViolations: 2 } } }],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it('attaches alongside non-a11y criteria (an element/command check does not dedup it)', () => {
    const c = buildRepoA11yCriterion({
      existingCriteria: [
        {
          id: 'AC-1',
          text: 'submit works',
          tier: 'hard',
          checks: [{ expect: { element: { role: 'button', state: 'visible' } } }],
        },
      ],
    });
    expect(c).toBeDefined();
    expect(c!.id).toBe('repo-a11y-critical');
  });
});
