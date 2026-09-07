/**
 * RUN THE EXPORT — Maestro edition.
 *
 * Until agent-device 0.20.5, Validity's Maestro exporter had a hole its own
 * preview notice named out loud: "generated flows have no automated on-device
 * validation harness yet." Web closed the equivalent hole by having CI EXECUTE
 * a generated `.spec.ts` against a live page and requiring it to pass (and, on
 * a broken page, to fail) — `spec-export-run.e2e.test.ts`, the fix-or-kill gate
 * that graduated the Playwright export out of preview.
 *
 * 0.20.5 ships a real Maestro-subset ENGINE, so the same proof is finally
 * possible for native:
 *
 *     agent-device replay <flow.yaml> --maestro --json     (one flow)
 *     agent-device test   <dir>       --maestro --json     (the whole suite)
 *
 * It cannot live in CI the way Playwright's does — it needs a booted device —
 * so it is a USER-DRIVEN verb (`validity spec export <id> --run`) whose verdict
 * is recorded as durable provenance on the exports manifest
 * (`ExportRunRecord`), pinned to the artifact sha256s it executed. That pin is
 * the whole trust story: a run of different bytes reads as stale, and stale
 * reads as "not run".
 *
 * ---------------------------------------------------------------------------
 * WHAT MUST NEVER HAPPEN HERE
 * ---------------------------------------------------------------------------
 *   1. A missing run must never read as a pass. Four-valued status, with
 *      `not-run` inert on both sides (it neither blocks nor vouches).
 *   2. An unsupported-syntax refusal must never read as an environment
 *      problem. The 0.20.5 engine fails LOUDLY on out-of-subset syntax; that is
 *      a defect in the EXPORT (→ `unsupported`, which blocks the portable
 *      badge), not a device that happened to be missing.
 *   3. Our own bad argv must never be blamed on the flow. A refusal that names
 *      one of OUR flags lands on `not-run`, never on `unsupported` — otherwise
 *      a Validity bug would de-certify a user's perfectly good export.
 *   4. Nothing here needs a device to be TESTED. Every classifier is pure and
 *      fixture-driven; the engine invocation is behind an injectable runner.
 *
 * `--dry-run` is the no-device mode: it lints the flows on disk against the
 * 0.20.5 subset ({@link lintMaestroSubset}) and records NOTHING. A lint is not
 * a run, and writing a run record for one would be exactly the kind of
 * manufactured provenance rule 1 exists to prevent.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { hash } from '@validity.ai/verify-spec';
import {
  exportTargetDir,
  lintMaestroSubset,
  loadExportsManifest,
  recordExportRun,
  specExportsDir,
  type ExportRunRecord,
  type ExportWarning,
} from '@validity.ai/verify-web';
import { defaultRunner, type CommandRunner } from '@validity.ai/verify-native';

/** The verdict vocabulary. Mirrors {@link ExportRunRecord.status} exactly. */
export type MaestroRunStatus = ExportRunRecord['status'];

/** One flow file's outcome inside a suite run. */
export interface MaestroFlowOutcome {
  /** Path as the engine reported it. */
  file: string;
  status: 'passed' | 'failed' | 'skipped';
  message?: string;
}

export interface MaestroRunVerdict {
  status: MaestroRunStatus;
  /** One line, in the product's register, safe to print verbatim. */
  detail: string;
  /** agent-device's error code, when it failed. */
  errorCode?: string;
  counts?: { total: number; passed: number; failed: number; skipped: number; notRun: number };
  /** Per-flow outcomes, when the suite reported them. */
  flows?: MaestroFlowOutcome[];
}

/* ------------------------------------------------------------------ *
 * Envelope reading (agent-device `--json`).                            *
 * ------------------------------------------------------------------ */

interface Envelope {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown; details?: Record<string, unknown> };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * Parse agent-device's `{success, data|error}` envelope. Tolerates a reporter
 * line or two ahead of the JSON (the suite command has human reporters that a
 * future release could keep enabled alongside `--json`) by falling back to the
 * last line that parses as an object. Never throws — an unreadable envelope is
 * evidence of "no verdict", which every caller already handles.
 */
export function parseAgentDeviceEnvelope(stdout: string): Envelope | undefined {
  const text = stdout?.trim();
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as Envelope;
  } catch {
    /* fall through to the line scan */
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') return parsed as Envelope;
    } catch {
      /* keep scanning upward */
    }
  }
  return undefined;
}

/**
 * agent-device error codes that describe THE ENVIRONMENT, not the flow: no
 * device, no app, no session, no tool, wrong platform. Kept in lockstep with
 * `replay-recording.ts`'s list — the same codes mean the same thing whichever
 * command produced them.
 */
const ENVIRONMENT_CODES = new Set([
  'DEVICE_NOT_FOUND',
  'DEVICE_IN_USE',
  'APP_NOT_INSTALLED',
  'SESSION_NOT_FOUND',
  'TOOL_MISSING',
  'UNSUPPORTED_PLATFORM',
  'UNSUPPORTED_OPERATION',
  'UNAUTHORIZED',
  'NOT_IMPLEMENTED',
]);

/**
 * Refusals that are about OUR invocation, not the user's flow. The engine
 * reports these as `INVALID_ARGS` exactly like an unsupported command, so
 * without this list a Validity argv bug would be recorded as "your export
 * cannot run" and would block the portable badge. Matched on the flag name,
 * which is the part that can only come from us.
 */
const OUR_ARGV_MARKERS = [
  '--platform',
  '--device',
  '--session',
  '--save-script',
  '--keep-session',
  '--maestro',
  '--from',
  '--plan-digest',
  'requires a path',
];

/**
 * Positive markers that a refusal is about the FLOW's syntax — the 0.20.5
 * engine's own vocabulary for "this is outside the subset". Deliberately an
 * allow-list: anything unrecognized falls through to `not-run` rather than
 * being blamed on the export.
 */
const FLOW_SYNTAX_MARKERS: RegExp[] = [
  /Maestro command "[^"]*" is not supported/i,
  /\bunsupported\b[^.]*\b(command|field|action|expression|value)\b/i,
  /^unsupported\b/i,
  /invalid [A-Za-z.]+ field/i,
  /\bMaestro [A-Za-z.]+ (requires|does not accept|must|cannot|output key)/i,
  /Maestro runFlow cycle/i,
  /supports maestro\.platform comparisons/i,
];

/** Details keys the engine attaches when it can point at a line in the flow. */
const SOURCE_CONTEXT_KEYS = ['scriptPath', 'sourcePath', 'line', 'unsupported', 'key'];

function hasSourceContext(details: Record<string, unknown> | undefined): boolean {
  if (!details) return false;
  return SOURCE_CONTEXT_KEYS.some((k) => details[k] !== undefined);
}

/** Find a `ReplaySuiteResult`-shaped object in `data` or in `error.details`. */
function findSuiteCounts(env: Envelope | undefined): MaestroRunVerdict['counts'] | undefined {
  for (const candidate of [env?.data, env?.error?.details]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const bag = candidate as Record<string, unknown>;
    const total = num(bag.total);
    const passed = num(bag.passed);
    const failed = num(bag.failed);
    if (total === undefined || passed === undefined || failed === undefined) continue;
    return {
      total,
      passed,
      failed,
      skipped: num(bag.skipped) ?? 0,
      notRun: num(bag.notRun) ?? Math.max(0, total - passed - failed),
    };
  }
  return undefined;
}

/** Read the per-file `tests[]` array, when the suite reported one. */
function findFlowOutcomes(env: Envelope | undefined): MaestroFlowOutcome[] | undefined {
  for (const candidate of [env?.data, env?.error?.details]) {
    const tests = (candidate as Record<string, unknown> | undefined)?.tests;
    if (!Array.isArray(tests)) continue;
    const out: MaestroFlowOutcome[] = [];
    for (const t of tests) {
      if (!t || typeof t !== 'object') continue;
      const bag = t as Record<string, unknown>;
      const file = str(bag.file);
      const status = str(bag.status);
      if (!file || (status !== 'passed' && status !== 'failed' && status !== 'skipped')) continue;
      const err = bag.error as Record<string, unknown> | undefined;
      const message = str(err?.message) ?? str(bag.message);
      out.push({ file, status, ...(message ? { message } : {}) });
    }
    if (out.length > 0) return out;
  }
  return undefined;
}

/**
 * Classify a FAILURE envelope. Shared by the suite and single-flow paths so
 * "unsupported syntax" means the same thing in both.
 *
 * `stepFailureIsFailure` is true only for the single-flow (`replay --maestro`)
 * path, where an executed-but-unmet assertion IS the answer we asked for. In a
 * suite run the authoritative failure signal is the counts, so an unexplained
 * envelope there stays pessimistic.
 */
function classifyFailure(
  env: Envelope | undefined,
  res: { code: number; stdout: string; stderr: string },
  stepFailureIsFailure: boolean,
): MaestroRunVerdict {
  const code = str(env?.error?.code);
  const message = str(env?.error?.message) ?? `${res.stderr}\n${res.stdout}`.trim();
  const details = env?.error?.details;

  if (code && ENVIRONMENT_CODES.has(code)) {
    return {
      status: 'not-run',
      errorCode: code,
      detail:
        `the exported flow could not be executed here (${code}): ${message}. ` +
        `Nothing in this says the flow is wrong — it says it did not run.`,
    };
  }

  if (OUR_ARGV_MARKERS.some((m) => message.includes(m))) {
    return {
      status: 'not-run',
      ...(code ? { errorCode: code } : {}),
      detail:
        `agent-device refused Validity's own invocation, not the flow: ${message}. ` +
        `Recorded as not-run — an argv problem on our side must never read as a ` +
        `defect in your export.`,
    };
  }

  if (FLOW_SYNTAX_MARKERS.some((re) => re.test(message)) || hasSourceContext(details)) {
    return {
      status: 'unsupported',
      ...(code ? { errorCode: code } : {}),
      detail:
        `the agent-device 0.20.5 Maestro engine REFUSED the exported flow's syntax: ` +
        `${message}. Unsupported syntax fails loudly rather than being skipped, so the ` +
        `flow asserts nothing at all — this export cannot run and does not certify.`,
    };
  }

  if (stepFailureIsFailure) {
    const step = num(details?.step);
    return {
      status: 'failed',
      ...(code ? { errorCode: code } : {}),
      detail:
        `the exported flow ran and a step did not hold` +
        (step === undefined ? '' : ` (step ${step})`) +
        `: ${message}`,
    };
  }

  return {
    status: 'not-run',
    ...(code ? { errorCode: code } : {}),
    detail:
      `the exported flow did not run to a verdict${code ? ` (${code})` : ''}: ` +
      `${message || `agent-device exited ${res.code}`}. Not counted as a failure — ` +
      `nothing here attributes the outcome to the flow.`,
  };
}

/**
 * Classify one `agent-device test <path> --maestro --json` execution (the
 * suite form). PURE — every branch is fixture-driven and needs no device.
 *
 * Counts win wherever they appear: a suite that executed and reported failures
 * is `failed` whether the CLI wrapped that in a success or a failure envelope
 * (the process exits non-zero on failures, and which envelope carries the
 * summary is not something Validity should be brittle about).
 */
export function classifyMaestroSuiteRun(res: {
  code: number;
  stdout: string;
  stderr: string;
}): MaestroRunVerdict {
  const env = parseAgentDeviceEnvelope(res.stdout);
  const counts = findSuiteCounts(env);
  const flows = findFlowOutcomes(env);

  if (counts) {
    const executed = counts.passed + counts.failed;
    if (counts.failed > 0) {
      return {
        status: 'failed',
        counts,
        ...(flows ? { flows } : {}),
        detail:
          `${counts.failed} of ${counts.total} exported flow${counts.total === 1 ? '' : 's'} ` +
          `failed on the device — the export runs, but it does not hold.`,
      };
    }
    if (executed === 0) {
      return {
        status: 'not-run',
        counts,
        ...(flows ? { flows } : {}),
        detail:
          `the suite matched ${counts.total} flow${counts.total === 1 ? '' : 's'} but executed ` +
          `none of them — nothing was proven. Check the path and the device binding.`,
      };
    }
    return {
      status: 'passed',
      counts,
      ...(flows ? { flows } : {}),
      detail:
        `${counts.passed} exported flow${counts.passed === 1 ? '' : 's'} ran on the device and ` +
        `passed — the export is not just well-formed, it works.`,
    };
  }

  if (env?.success === true) {
    // Success with no readable summary: refuse to claim a pass we did not see.
    return {
      status: 'not-run',
      detail:
        `agent-device reported success but no suite summary Validity could read — ` +
        `recorded as not-run rather than inventing a pass.`,
    };
  }
  return classifyFailure(env, res, false);
}

/**
 * Classify one `agent-device replay <flow.yaml> --maestro --json` execution
 * (the single-flow form). PURE.
 */
export function classifyMaestroFlowRun(res: {
  code: number;
  stdout: string;
  stderr: string;
}): MaestroRunVerdict {
  const env = parseAgentDeviceEnvelope(res.stdout);
  if (env?.success === true) {
    const replayed = num(env.data?.replayed);
    return {
      status: 'passed',
      detail:
        `the exported flow ran on the device and every step held` +
        (replayed === undefined ? '' : ` (${replayed} step${replayed === 1 ? '' : 's'})`) +
        ` — the export is not just well-formed, it works.`,
    };
  }
  return classifyFailure(env, res, true);
}

/* ------------------------------------------------------------------ *
 * argv builders (pure — the exact commands, testable without a device) *
 * ------------------------------------------------------------------ */

export interface MaestroInvocationOptions {
  platform?: 'ios' | 'android';
  device?: string;
  /** `KEY=VALUE` pairs forwarded as repeatable `-e` flags. */
  env?: string[];
  /** Suite only: stop after the first failing flow. */
  failFast?: boolean;
  /** Per-attempt wall-clock bound handed to agent-device. */
  timeoutMs?: number;
}

/** `agent-device test <path> --maestro --json …` — the suite form. */
export function maestroSuiteArgs(path: string, opts: MaestroInvocationOptions = {}): string[] {
  const args = ['test', path, '--maestro', '--json'];
  if (opts.failFast) args.push('--fail-fast');
  return args.concat(commonArgs(opts));
}

/** `agent-device replay <flow.yaml> --maestro --json …` — the single form. */
export function maestroFlowArgs(path: string, opts: MaestroInvocationOptions = {}): string[] {
  return ['replay', path, '--maestro', '--json'].concat(commonArgs(opts));
}

/* ------------------------------------------------------------------ *
 * Target binding: CLI flags over config defaults (pure).               *
 * ------------------------------------------------------------------ */

/** Which layer supplied one field of the effective target binding. */
export type MaestroTargetSource = 'flag' | 'config' | 'unset';

export interface ResolvedMaestroTarget {
  platform?: 'ios' | 'android';
  device?: string;
  platformSource: MaestroTargetSource;
  deviceSource: MaestroTargetSource;
  /** Lines worth printing to the user (an ignored flag value). Never fatal. */
  notices: string[];
}

/**
 * Resolve the `--run` target binding from the command line and
 * `export.maestro.run`. PURE — the precedence rule is a testable function
 * rather than a `??` buried in a command handler.
 *
 * THE RULE, per field: an explicit flag WINS; config fills only what the flag
 * left unset; neither set leaves the flag off the argv entirely, which hands
 * agent-device its documented "use the active session" default instead of a
 * Validity guess.
 *
 * `platform` and `device` resolve INDEPENDENTLY on purpose. The CI shape this
 * exists for is a fixed `platform` in committed config with the runner passing
 * the udid of whichever device it just booted; an all-or-nothing rule would
 * make that one `--device` silently drop the configured platform.
 *
 * An UNRECOGNIZED `--platform` value is not treated as an explicit choice: it
 * is reported as ignored and the config default still applies. The value could
 * never have bound a target, so honouring it as "the user said something" would
 * only turn a typo into a second, quieter failure.
 */
export function resolveMaestroTarget(args: {
  flags?: { platform?: string; device?: string };
  config?: { platform?: 'ios' | 'android'; device?: string };
}): ResolvedMaestroTarget {
  const notices: string[] = [];
  const raw = args.flags?.platform;
  const normalized = raw?.toLowerCase();
  let flagPlatform: 'ios' | 'android' | undefined;
  if (normalized === 'ios' || normalized === 'android') {
    flagPlatform = normalized;
  } else if (raw !== undefined && raw !== '') {
    notices.push(
      `ignoring --platform "${raw}" — expected \`ios\` or \`android\`` +
        (args.config?.platform
          ? `; using export.maestro.run.platform (${args.config.platform}) instead`
          : ''),
    );
  }

  const flagDevice = args.flags?.device;
  const platform = flagPlatform ?? args.config?.platform;
  const device = flagDevice ?? args.config?.device;
  return {
    ...(platform ? { platform } : {}),
    ...(device ? { device } : {}),
    platformSource: flagPlatform ? 'flag' : args.config?.platform ? 'config' : 'unset',
    deviceSource: flagDevice ? 'flag' : args.config?.device ? 'config' : 'unset',
    notices,
  };
}

function commonArgs(opts: MaestroInvocationOptions): string[] {
  const args: string[] = [];
  // The target binding lives on the replay/test command itself (0.20.5 `help
  // maestro`: "Bind an iOS or Android target with --platform or an existing
  // session"). Omitted entirely when unset — agent-device then uses the active
  // session, which is the documented default, not a Validity guess.
  if (opts.platform) args.push('--platform', opts.platform);
  if (opts.device) args.push('--device', opts.device);
  if (opts.timeoutMs !== undefined) args.push('--timeout', String(opts.timeoutMs));
  for (const pair of opts.env ?? []) args.push('-e', pair);
  return args;
}

/* ------------------------------------------------------------------ *
 * Orchestration.                                                       *
 * ------------------------------------------------------------------ */

/** One exported flow on disk, with its subset lint. */
export interface MaestroFlowLint {
  specId: string;
  /** Absolute path. */
  path: string;
  /** Path relative to `.validity/exports/` (manifest vocabulary). */
  relPath: string;
  warnings: ExportWarning[];
  /** sha256 of the bytes on disk at lint/run time. */
  sha256: string;
}

export interface RunMaestroExportArgs extends MaestroInvocationOptions {
  projectRoot: string;
  /**
   * Run exactly this spec's flow (`replay` form). Omitted, the whole
   * `.validity/exports/maestro/` directory runs as a suite (`test` form).
   */
  specId?: string;
  /** Lint the flows against the 0.20.5 subset and stop. No device, no record. */
  dryRun?: boolean;
  /** agent-device binary name/path. Default `agent-device`. */
  bin?: string;
  deps?: { run?: CommandRunner; now?: () => string; version?: string };
}

export interface RunMaestroExportReport {
  mode: 'dry-run' | 'device';
  /** Every flow considered, with its subset findings. */
  flows: MaestroFlowLint[];
  /** The argv that ran (device mode) or would run (dry-run) — reproducibility. */
  command: { bin: string; args: string[] };
  /** Device mode only. */
  verdict?: MaestroRunVerdict;
  /** Spec ids whose manifest row received a run record. */
  recorded: string[];
  /** Non-fatal problems worth printing (missing flows, unrecorded specs). */
  notices: string[];
  /** The command achieved what it set out to. Drives the CLI's exit code. */
  ok: boolean;
}

const FLOW_FILE_RE = /^(spec-[A-Za-z0-9_-]+)\.v\d+\.flow\.yaml$/;

/** `spec-x.v2.flow.yaml` → `spec-x`. Null when it isn't one of ours. */
export function specIdFromFlowFile(file: string): string | null {
  return FLOW_FILE_RE.exec(basename(file))?.[1] ?? null;
}

/** Collect the exported Maestro flows on disk, linted. */
function collectFlows(projectRoot: string, specId?: string): MaestroFlowLint[] {
  const root = specExportsDir(projectRoot);
  const dir = resolve(root, exportTargetDir('native'));
  if (!existsSync(dir)) return [];
  const flows: MaestroFlowLint[] = [];
  for (const base of readdirSync(dir).sort()) {
    const owner = specIdFromFlowFile(base);
    if (!owner) continue;
    if (specId && owner !== specId) continue;
    const abs = resolve(dir, base);
    let contents: string;
    try {
      contents = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    flows.push({
      specId: owner,
      path: abs,
      relPath: `${exportTargetDir('native')}/${base}`,
      warnings: lintMaestroSubset(contents),
      sha256: hash(contents),
    });
  }
  return flows;
}

/**
 * Execute (or, with `dryRun`, statically validate) the exported Maestro flows.
 *
 * The engine invocation is fully behind `deps.run`, so this whole function is
 * exercisable from recorded envelope fixtures on a box with no device — which
 * is the only way a run-the-export harness for native could have been landed
 * at all.
 */
export async function runMaestroExport(
  args: RunMaestroExportArgs,
): Promise<RunMaestroExportReport> {
  const { projectRoot, specId } = args;
  const bin = args.bin ?? 'agent-device';
  const flows = collectFlows(projectRoot, specId);
  const notices: string[] = [];

  const dir = resolve(specExportsDir(projectRoot), exportTargetDir('native'));
  const target = specId ? (flows[0]?.path ?? dir) : dir;
  const invocation: MaestroInvocationOptions = {
    platform: args.platform,
    device: args.device,
    env: args.env,
    failFast: args.failFast,
    timeoutMs: args.timeoutMs,
  };
  const cmd = {
    bin,
    args: specId ? maestroFlowArgs(target, invocation) : maestroSuiteArgs(target, invocation),
  };

  if (flows.length === 0) {
    notices.push(
      specId
        ? `no exported Maestro flow for ${specId} under .validity/exports/maestro/ — run \`validity spec export ${specId}\` first`
        : 'no exported Maestro flows under .validity/exports/maestro/ — nothing to run. ' +
            '(This verb runs MAESTRO flows only; web specs export to Playwright, which you ' +
            'run with `npx playwright test .validity/exports/playwright/`.)',
    );
    return {
      mode: args.dryRun ? 'dry-run' : 'device',
      flows,
      command: cmd,
      recorded: [],
      notices,
      ok: false,
    };
  }

  if (args.dryRun) {
    const clean = flows.every((f) => f.warnings.length === 0);
    return { mode: 'dry-run', flows, command: cmd, recorded: [], notices, ok: clean };
  }

  const run = args.deps?.run ?? defaultRunner;
  let verdict: MaestroRunVerdict;
  try {
    const res = await run(bin, cmd.args, { cwd: projectRoot, timeoutMs: args.timeoutMs });
    verdict = specId ? classifyMaestroFlowRun(res) : classifyMaestroSuiteRun(res);
  } catch (err) {
    verdict = {
      status: 'not-run',
      detail:
        `the exported flow could not be handed to agent-device: ${(err as Error).message}. ` +
        `Recorded as not-run — it says nothing about the flow.`,
    };
  }

  const recorded = recordVerdict({ projectRoot, flows, verdict, args, notices });
  return {
    mode: 'device',
    flows,
    command: cmd,
    verdict,
    recorded,
    notices,
    ok: verdict.status === 'passed',
  };
}

/**
 * Stamp the verdict onto each flow's manifest row.
 *
 * Per-flow outcomes win when the suite reported them: in a mixed suite, the
 * spec whose flow passed must not inherit its neighbour's failure, and the one
 * that failed must not inherit the suite's overall shape either. A flow the
 * suite never mentioned is recorded `not-run` — explicitly, because silence
 * about a flow is exactly the thing that must not read as a pass.
 */
function recordVerdict(ctx: {
  projectRoot: string;
  flows: MaestroFlowLint[];
  verdict: MaestroRunVerdict;
  args: RunMaestroExportArgs;
  notices: string[];
}): string[] {
  const { projectRoot, flows, verdict, args, notices } = ctx;
  const at = args.deps?.now?.() ?? new Date().toISOString();
  const entries = loadExportsManifest(projectRoot).entries;
  const byBase = new Map<string, MaestroFlowOutcome>();
  for (const outcome of verdict.flows ?? []) byBase.set(basename(outcome.file), outcome);

  const recorded: string[] = [];
  for (const flow of flows) {
    if (!entries[flow.specId]) {
      notices.push(
        `${flow.specId}: the run happened but no manifest row exists to record it against — ` +
          `re-run \`validity spec export ${flow.specId}\` so the verdict has a home`,
      );
      continue;
    }
    const outcome = byBase.get(basename(flow.path));
    const perFile = perFlowVerdict(verdict, outcome);
    const record: ExportRunRecord = {
      target: 'maestro',
      status: perFile.status,
      at,
      detail: perFile.detail,
      // The bytes ACTUALLY on disk at run time — not the manifest's copy. A
      // hand-edited flow that got run is recorded honestly and then reads as
      // stale against the manifest, which is the correct answer.
      files: [{ path: flow.relPath, sha256: flow.sha256 }],
      tool: {
        name: 'agent-device',
        command: args.specId ? 'replay --maestro' : 'test --maestro',
        ...(args.deps?.version ? { version: args.deps.version } : {}),
      },
      ...(args.platform || args.device
        ? {
            device: {
              ...(args.platform ? { platform: args.platform } : {}),
              ...(args.device ? { id: args.device } : {}),
            },
          }
        : {}),
      ...(verdict.counts && !outcome ? { counts: verdict.counts } : {}),
    };
    if (recordExportRun(projectRoot, flow.specId, record)) recorded.push(flow.specId);
  }
  return recorded;
}

/** The verdict for ONE flow, given the suite-level verdict and its own row. */
function perFlowVerdict(
  verdict: MaestroRunVerdict,
  outcome: MaestroFlowOutcome | undefined,
): { status: MaestroRunStatus; detail: string } {
  // A parse-time refusal aborts the WHOLE run before any flow executes, so it
  // applies to every flow regardless of what the per-file rows say.
  if (verdict.status === 'unsupported' || verdict.status === 'not-run') {
    return { status: verdict.status, detail: verdict.detail };
  }
  if (!outcome) {
    return verdict.flows === undefined
      ? { status: verdict.status, detail: verdict.detail }
      : {
          status: 'not-run',
          detail: 'the suite ran but never reported this flow — recorded as not run',
        };
  }
  if (outcome.status === 'passed') {
    return { status: 'passed', detail: 'ran on the device and every step held' };
  }
  if (outcome.status === 'failed') {
    return {
      status: 'failed',
      detail: `ran on the device and a step did not hold${outcome.message ? `: ${outcome.message}` : ''}`,
    };
  }
  return {
    status: 'not-run',
    detail: `the suite skipped this flow${outcome.message ? `: ${outcome.message}` : ''}`,
  };
}
