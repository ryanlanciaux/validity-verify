/**
 * `expect.command` execution (A5) — the run-level typecheck/test/lint verb.
 *
 * Command checks are RUN-LEVEL, not render-level: each named command referenced
 * by a spec's command criteria executes at most once per verify run (deduped by
 * the resolved shell string via `CommandCheckRunner`, which `verify --all`
 * shares across specs), with cwd = project root and a wall-clock budget. The
 * shell string never lives in the spec — a frozen spec carries only the NAME
 * (`run: 'typecheck'`), resolved against `.validity/config.ts` `commands` at
 * run time, so a spec file can never smuggle executable shell.
 *
 * GATE INTEGRITY:
 *   - an unconfigured name is `unverifiable` with a finding, NEVER pass;
 *   - a no-op resolution (`true`, `:`, `exit 0`) is `unverifiable` — it cannot
 *     prove anything;
 *   - a timeout is `fail` (a hung suite must demand attention, and fail can
 *     never launder to green);
 *   - the RESOLVED string is stamped into `CheckVerdict.command` + the detail,
 *     so a post-freeze edit of the config's command map is auditable (the spec
 *     hash does not cover config — the stamp is the audit surface);
 *   - `overlayCommandVerdicts` never upgrades a verdict on collision.
 */
import { spawn } from 'node:child_process';
import {
  foldCheckVerdicts,
  isExpectCheck,
  type Check,
  type CheckVerdict,
  type CriterionVerdict,
  type SpecCriterion,
} from './spec-schema.js';
import type { CommandsConfig } from './types.js';

/** Per-command wall-clock budget when `config.commandTimeoutMs` is unset. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;
/** How much output tail lands in a failing check's `detail`. */
export const COMMAND_OUTPUT_TAIL_CHARS = 1_200;
/** Ring-buffer cap for captured stdout+stderr (a command may print forever). */
const MAX_OUTPUT_CHARS = 64 * 1024;

/** A resolution that can exit 0 without proving anything (`true`, `:`, `exit 0`). */
const NO_OP_COMMAND_RE = /^\s*(?:true|:|exit\s+0)\s*$/;

/** Outcome of one real (or injected) command execution. */
export interface CommandExecResult {
  /** Process exit code; null when it never exited cleanly (killed / spawn error). */
  exitCode: number | null;
  /** Merged stdout+stderr, ring-buffered to the last `MAX_OUTPUT_CHARS`. */
  output: string;
  timedOut: boolean;
  /** Set when the process could not be spawned at all (shell missing, EACCES). */
  spawnError?: string;
  durationMs: number;
}

/** Injectable exec seam so tests never spawn a shell. */
export type CommandExec = (
  cmd: string,
  opts: { cwd: string; timeoutMs: number },
) => Promise<CommandExecResult>;

const defaultExec: CommandExec = (cmd, opts) =>
  new Promise((done) => {
    const start = Date.now();
    // `detached` puts the child in its own process group on POSIX so the
    // timeout kill reaches grandchildren (vitest workers, tsc --build forks).
    // Windows: plain child kill (cmd.exe grandchildren may linger — documented
    // limitation; the check still resolves `fail`, never hangs the verify).
    const detached = process.platform !== 'win32';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, {
        shell: true,
        cwd: opts.cwd,
        detached,
        // CI=1 makes well-behaved watch-mode tools (vitest, jest) run once.
        env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      });
    } catch (err) {
      done({
        exitCode: null,
        output: '',
        timedOut: false,
        spawnError: (err as Error).message,
        durationMs: Date.now() - start,
      });
      return;
    }
    let output = '';
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf-8');
      if (output.length > MAX_OUTPUT_CHARS) output = output.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let settled = false;
    let timedOut = false;
    const settle = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ exitCode, output, timedOut, spawnError, durationMs: Date.now() - start });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (detached && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Already gone — the close handler settles.
      }
      // Stop awaiting at the deadline even if the kill didn't take.
      settle(null);
    }, opts.timeoutMs);
    child.on('error', (err) => settle(null, err.message));
    child.on('close', (code) => settle(code));
  });

/**
 * Runs each RESOLVED command string at most once per runner lifetime. One
 * runner per verify invocation (`verify --all` shares one across specs; watch
 * mints a fresh one per cycle so a cached exit code is never stale relative to
 * the code under verdict).
 */
export class CommandCheckRunner {
  private cache = new Map<string, Promise<CommandExecResult>>();

  constructor(private exec: CommandExec = defaultExec) {}

  run(resolved: string, opts: { cwd: string; timeoutMs: number }): Promise<CommandExecResult> {
    const cached = this.cache.get(resolved);
    if (cached) return cached;
    const result = this.exec(resolved, opts);
    this.cache.set(resolved, result);
    return result;
  }
}

/** Strip ANSI + control chars and keep the last `COMMAND_OUTPUT_TAIL_CHARS`. */
function outputTail(output: string): string {
  // ANSI escape sequences (\x1b[…]) and C0/C1 control characters are stripped
  // deliberately here — the control chars in these character classes ARE the
  // intended match set, so no-control-regex is a false positive.
  /* eslint-disable no-control-regex */
  const cleaned = output
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim();
  /* eslint-enable no-control-regex */
  return cleaned.slice(-COMMAND_OUTPUT_TAIL_CHARS);
}

/**
 * Pure verdict arithmetic for ONE command check — see the module doc's table.
 * `resolved` is the raw config value (undefined/blank ⇒ not configured);
 * `result` is undefined when the command was never spawned. Only an observed
 * exit code equal to the expectation can produce `pass`.
 */
export function commandCheckVerdict(
  check: Check,
  name: string,
  resolved: string | undefined,
  result: CommandExecResult | undefined,
): CheckVerdict {
  const expected =
    isExpectCheck(check) && check.expect.command ? (check.expect.command.exitCode ?? 0) : 0;
  if (resolved === undefined || resolved.trim().length === 0) {
    return {
      check,
      status: 'unverifiable',
      detail:
        `AC unverifiable: command '${name}' is not configured — ` +
        `add commands.${name} to .validity/config.ts`,
    };
  }
  if (NO_OP_COMMAND_RE.test(resolved)) {
    return {
      check,
      status: 'unverifiable',
      detail:
        `AC unverifiable: command '${name}' resolves to a no-op ("${resolved.trim()}") — ` +
        `a no-op cannot prove anything`,
    };
  }
  if (result === undefined || result.spawnError !== undefined) {
    return {
      check,
      status: 'unverifiable',
      detail: `AC unverifiable: could not spawn '${resolved}' — ${
        result?.spawnError ?? 'command did not execute'
      }`,
    };
  }
  const command = {
    resolved,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  };
  if (result.timedOut) {
    return {
      check,
      status: 'fail',
      detail:
        `command '${name}' ("${resolved}") timed out after ${result.durationMs}ms — ` +
        `a hung command can never sign off (raise commandTimeoutMs if the machine is slow)`,
      command,
    };
  }
  if (result.exitCode !== expected) {
    const tail = outputTail(result.output);
    return {
      check,
      status: 'fail',
      detail:
        `command '${name}' ("${resolved}") exited ${result.exitCode}, expected ${expected}` +
        (tail ? `\n${tail}` : ''),
      command,
    };
  }
  return {
    check,
    status: 'pass',
    detail: `command '${name}' ("${resolved}") exited ${result.exitCode} in ${result.durationMs}ms`,
    command,
  };
}

/**
 * Execute a spec's command criteria once per run. `criteria` is pre-filtered
 * by the caller via `criterionUsesCommandChecks`; two criteria referencing the
 * same name share one execution (and one `command` evidence block) through the
 * runner cache. Returns one CriterionVerdict per criterion, folded with the
 * same `foldCheckVerdicts` rule the render executors use.
 */
export async function executeCommandCriteria(args: {
  criteria: SpecCriterion[];
  commands: CommandsConfig | undefined;
  projectRoot: string;
  /** `config.commandTimeoutMs`; defaults to DEFAULT_COMMAND_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Shared by `verify --all` across specs; fresh per call otherwise. */
  runner?: CommandCheckRunner;
}): Promise<CriterionVerdict[]> {
  if (args.criteria.length === 0) return [];
  const runner = args.runner ?? new CommandCheckRunner();
  const timeoutMs = args.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const verdicts: CriterionVerdict[] = [];
  for (const criterion of args.criteria) {
    const checks: CheckVerdict[] = [];
    for (const check of criterion.checks ?? []) {
      if (!isExpectCheck(check) || check.expect.command === undefined) {
        // The no-mixing refine forbids page checks here; if one leaks through
        // anyway it is `unverifiable` (never executed), never a silent pass.
        checks.push({
          check,
          status: 'unverifiable',
          detail:
            'AC unverifiable: non-command check in a command criterion — ' +
            'not executed at the run level',
        });
        continue;
      }
      const name = check.expect.command.run;
      const resolved = args.commands?.[name];
      const runnable =
        typeof resolved === 'string' &&
        resolved.trim().length > 0 &&
        !NO_OP_COMMAND_RE.test(resolved);
      const result = runnable
        ? await runner.run(resolved, { cwd: args.projectRoot, timeoutMs })
        : undefined;
      checks.push(commandCheckVerdict(check, name, resolved, result));
    }
    verdicts.push({
      id: criterion.id,
      tier: criterion.tier,
      status: foldCheckVerdicts(checks),
      // The per-check details carry the resolved strings — join them so the
      // config-drift audit surface rides the criterion detail everywhere the
      // report/structuredContent shows one line per criterion.
      detail: checks
        .map((c) => c.detail)
        .filter(Boolean)
        .join('; '),
      checks,
    });
  }
  return verdicts;
}

/** fail ⊐ unverifiable ⊐ pass — lower rank is worse. */
const LATTICE_RANK = { fail: 0, unverifiable: 1, pass: 2 } as const;

/**
 * Overlay run-level command verdicts onto the render-derived list. The base
 * entry for a command criterion is normally the "checks did not execute"
 * placeholder (command criteria are excluded from render attachment) — the
 * command verdict replaces it. NEVER upgrades: if both sides carry an EXECUTED
 * verdict for the same id (the no-mixing refine forbids it; this is defense in
 * depth) the lattice-WORSE status wins. Command verdicts with no base entry
 * are appended (the native path's render list only carries executed criteria).
 * Pure.
 */
export function overlayCommandVerdicts(
  base: CriterionVerdict[],
  command: CriterionVerdict[],
): CriterionVerdict[] {
  if (command.length === 0) return base;
  const byId = new Map(command.map((v) => [v.id, v]));
  const merged = base.map((b) => {
    const cmd = byId.get(b.id);
    if (!cmd) return b;
    byId.delete(b.id);
    // An un-executed base entry (no per-check breakdown) is the placeholder.
    if (!b.checks || b.checks.length === 0) return cmd;
    return LATTICE_RANK[b.status] < LATTICE_RANK[cmd.status] ? b : cmd;
  });
  return [...merged, ...byId.values()];
}

/** The auto-attached repo-level typecheck criterion's id. */
export const REPO_TYPECHECK_CRITERION_ID = 'repo-typecheck';

/**
 * Auto-attach candidate for `handlePlan`: a blocking `property` criterion that
 * runs the configured `typecheck` command. Returns undefined (attach nothing)
 * unless tsconfig.json exists AND config declares a non-blank
 * `commands.typecheck`, or when the plan's criteria already cover it (id
 * collision, or an existing `run: 'typecheck'` command check). Pure — the
 * caller supplies the filesystem fact.
 */
export function buildRepoTypecheckCriterion(args: {
  hasTsconfig: boolean;
  typecheckCommand: string | undefined;
  existingCriteria: SpecCriterion[];
}): SpecCriterion | undefined {
  if (!args.hasTsconfig) return undefined;
  if (typeof args.typecheckCommand !== 'string' || args.typecheckCommand.trim().length === 0) {
    return undefined;
  }
  if (args.existingCriteria.some((c) => c.id === REPO_TYPECHECK_CRITERION_ID)) return undefined;
  const alreadyChecked = args.existingCriteria.some((c) =>
    (c.checks ?? []).some((ch) => isExpectCheck(ch) && ch.expect.command?.run === 'typecheck'),
  );
  if (alreadyChecked) return undefined;
  // No `severity` — blocking by default (criterionIsBlocking): a failing or
  // unconfigured typecheck gates sign-off.
  return {
    id: REPO_TYPECHECK_CRITERION_ID,
    text: 'Repo typechecks: the configured `typecheck` command exits 0 after the change.',
    tier: 'property',
    checks: [{ expect: { command: { run: 'typecheck', exitCode: 0 } } }],
  };
}

/** The auto-attached critical-a11y gate criterion's id. */
export const REPO_A11Y_CRITERION_ID = 'repo-a11y-critical';

/**
 * Auto-attach candidate for `handlePlan`, the a11y sibling of
 * `buildRepoTypecheckCriterion`: a blocking `property` criterion asserting ZERO
 * critical-impact axe violations after the change, so a critical a11y regression
 * (an unlabeled control, an empty button, a contrast failure at `critical`) can
 * never sign off — the same posture the typecheck gate takes on a type error.
 *
 * Unlike typecheck this needs no tsconfig/config prerequisite: axe runs in the
 * web sandbox on every render and the native executor reads the a11y snapshot,
 * so the `expect.a11y` check is always executable. Under the fixtures-only
 * binding fix (`prepareVerification`) it attaches to every variant of the
 * target, giving per-variant critical-a11y gating.
 *
 * Returns undefined (attach nothing) when the plan already covers a11y — an id
 * collision, or ANY existing criterion already carrying an `expect.a11y` check
 * (the author's explicit a11y budget wins; we never double-gate). Pure — the
 * caller decides where to attach.
 */
export function buildRepoA11yCriterion(args: {
  existingCriteria: SpecCriterion[];
}): SpecCriterion | undefined {
  if (args.existingCriteria.some((c) => c.id === REPO_A11Y_CRITERION_ID)) return undefined;
  const alreadyChecked = args.existingCriteria.some((c) =>
    (c.checks ?? []).some((ch) => isExpectCheck(ch) && ch.expect.a11y !== undefined),
  );
  if (alreadyChecked) return undefined;
  // No `severity` — blocking by default (criterionIsBlocking): a critical a11y
  // violation gates sign-off.
  return {
    id: REPO_A11Y_CRITERION_ID,
    text: 'No critical accessibility violations: axe-core reports zero critical-impact violations after the change.',
    tier: 'property',
    checks: [{ expect: { a11y: { severity: 'critical', maxViolations: 0 } } }],
  };
}
