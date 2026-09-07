/**
 * Native environment diagnosis — turning "no mechanical verdict produced for
 * this criterion" back into a cause.
 *
 * That one sentence was the output for FIVE different situations in a single
 * dogfooding session (handoff-2026-07-28): a four-minors-stale agent-device, a
 * phantom device claim, a hand-started Metro on the companion port, an emulator
 * session that had decayed with age, and a genuine render failure. All honest,
 * all indistinguishable — and a developer who cannot tell them apart concludes
 * the tool is flaky and stops using it. Silence is the failure mode being
 * killed here, not the unverifiable verdict itself.
 *
 * The shape is copied deliberately from the agent-device VERSION gate (d129e7c):
 *
 *   - the SYMPTOM names what was actually observed, in the words the developer
 *     saw ("`open` says the device is in use by session 'default', while
 *     `session list` reports none");
 *   - the FIX is an exact command, not advice;
 *   - degradation is SAFE. Every probe fails open: an unreadable file, an
 *     absent `lsof`, an unparseable JSON answer all mean "cannot tell", never
 *     "broken". A diagnosis that flags a working setup is worse than the
 *     silence it replaces, because it sends the developer to reset an
 *     environment that was fine.
 *
 * Nothing in here changes a verdict. Diagnosis is additive metadata attached to
 * failure paths; the never-false-green invariant is untouched.
 */
import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { COMPANION_BRIDGE_PORT, COMPANION_METRO_PORT } from './prepare-native-app.js';
import {
  readSessionMetrics,
  summarizeSessionHealth,
  WARN_P95_MS,
  type SessionHealth,
} from './session-metrics.js';
// Type-only: the default runner is pulled in lazily (see resolveRunner) so this
// module never participates in an import cycle with the driver, which attaches
// diagnoses of its own.
import type { CommandRunner } from './agent-device-driver.js';

export type NativeBlockCause =
  | 'stale-agent-device'
  | 'agent-device-error'
  | 'phantom-device-claim'
  | 'stale-device-claim'
  | 'no-native-session'
  | 'bridge-platform-mismatch'
  | 'foreign-metro'
  | 'dev-menu-open'
  | 'dev-launcher-home'
  | 'anr-dialog'
  | 'session-decay'
  | 'metro-decayed'
  | 'daemon-unresponsive'
  | 'device-not-ready'
  | 'render-failure'
  | 'unknown';

/**
 * A machine-readable error agent-device itself reported, parsed off its output.
 *
 * The CLI prints (see `renderError` in its dist, and `RunnerTests+CommandExecution.swift`
 * for where the runner-side codes are minted):
 *
 *     Error (RUNNER_WEDGED): The iOS runner main thread has been stuck …
 *     Hint: The runner session will be restarted. …
 *     Diagnostic ID: 1a2b3c-deadbeef
 *     Diagnostics Log: /Users/…/…ndjson
 */
export interface UpstreamAgentDeviceError {
  /** e.g. `RUNNER_WEDGED`, `SESSION_NOT_FOUND`, `DEVICE_IN_USE`. */
  code: string;
  /** The upstream message, VERBATIM — never paraphrased. */
  message: string;
  /** Upstream's own `Hint:` line, when it printed one. */
  hint?: string;
  /** `Diagnostic ID:` — the handle upstream needs to look the failure up. */
  diagnosticId?: string;
  /** `Diagnostics Log:` path. */
  logPath?: string;
}

export interface EnvironmentDiagnosis {
  cause: NativeBlockCause;
  /** What was observed, concretely — the developer should recognize it. */
  symptom: string;
  /** One short paragraph: what it means, and why verdicts were withheld. */
  detail: string;
  /** Exact shell command(s), newline-separated. */
  fixCommand?: string;
  /**
   * 'confirmed' — the observation is the signature itself, not an inference.
   * 'suspected' — consistent with the evidence, but another cause is possible.
   *               Reported as a lead, never as a gate.
   */
  confidence: 'confirmed' | 'suspected';
  /**
   * The upstream error this diagnosis PASSES THROUGH, when the tool below us
   * already named the cause in machine-readable form. Present on
   * `agent-device-error`; also attached to the specialized causes that were
   * derived from the same error text, so a consumer always has the raw code.
   */
  upstream?: UpstreamAgentDeviceError;
  /**
   * What Validity ALREADY DID about this, unprompted, and how it went.
   *
   * Set by the verify loop when it acted on the diagnosis itself — today only
   * the automatic companion-Metro restart (see `metro-heal.ts`). It exists so
   * an auto-heal can never be silent in either direction: a `fixCommand` telling
   * someone to run the very restart that just ran and did not help is worse than
   * no fix at all, and a restart that DID help must still appear in the record
   * or the run reads as having flaked and recovered on its own.
   *
   * Purely additive prose. It never changes a verdict, never replaces the
   * symptom, and an absent value means nothing was attempted.
   */
  autoRemediation?: string;
  /**
   * What `agent-device doctor` said, when Validity asked (see
   * {@link summarizeAgentDeviceDoctor}).
   *
   * ADVISORY, in the strict sense this codebase uses the word: it never sets or
   * changes `cause`, never sets `confidence`, and is only ever attached to a
   * diagnosis that was ALREADY going to be weak — `unknown`, or the
   * `render-failure` that means "every probe came back clean". Upstream's
   * doctor knows things Validity's probes do not (RN/Expo toolchain readiness,
   * Metro reachability inferred from cwd, iOS runner cache state), and a
   * warn/fail row from it is exactly the lead a developer needs when Validity
   * has nothing. It is NOT evidence a verdict may be derived from — the tool
   * that answers "your Metro host looks unreachable" has not looked at the
   * component under test.
   */
  advisory?: string;
}

/* -------------------------------------------------------------------------- */
/* injectable seams                                                            */
/* -------------------------------------------------------------------------- */

/** Filesystem reads the probes need. Every method MAY throw; callers catch. */
export interface DiagnosisFs {
  readFile: (path: string) => string;
  readDir: (path: string) => string[];
  exists: (path: string) => boolean;
  /**
   * Delete ONE file. Optional because every other probe here is read-only and
   * an injected fake must not have to grow a write seam to keep compiling — an
   * fs without it simply cannot auto-heal (see {@link releaseStaleDeviceClaims}),
   * which degrades to the diagnosis that was already being produced.
   */
  removeFile?: (path: string) => void;
}

export const realDiagnosisFs: DiagnosisFs = {
  readFile: (p) => readFileSync(p, 'utf-8'),
  readDir: (p) => readdirSync(p),
  exists: (p) => existsSync(p),
  removeFile: (p) => rmSync(p, { force: true }),
};

/**
 * Liveness probe. `kill(pid, 0)` signals nothing — the kernel only checks that
 * the process exists and that we may signal it. ESRCH means gone; EPERM means
 * it EXISTS but belongs to another user, which is still ALIVE (treating it as
 * dead would fabricate a "dead daemon" diagnosis for a daemon that is running
 * under another account).
 */
export function realIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/* -------------------------------------------------------------------------- */
/* fix recipes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The daemon kill. Written against `$HOME` (not a resolved absolute path) so it
 * is copy-pasteable and obviously safe to read; python3 is used because the pid
 * lives in JSON and every macOS dev box has it.
 */
export const KILL_AGENT_DEVICE_DAEMON = `kill $(python3 -c "import json;print(json.load(open('$HOME/.agent-device/daemon.json'))['pid'])")`;

/** Clear the two state dirs that hold sessions + device claims. */
export const CLEAR_AGENT_DEVICE_STATE = `rm -rf "$HOME/.agent-device/sessions" "$HOME/.agent-device/device-claims"`;

/**
 * The file `prepareNativeApp` records the last-served contentHash in (see
 * `metroContentMarkerPath`). Deleting it is the SANCTIONED way to force the
 * managed Metro restart: `ensureCompanionMetro` reads it, sees "already up +
 * content CHANGED", kills the bundler it owns (verified) and respawns it with
 * `--clear`. Nothing is hand-started, and Validity keeps ownership of the port.
 */
export const METRO_CONTENT_MARKER_NAME = '.validity-metro-content';

/** Where the marker lives when the companion app dir is not known concretely. */
export const METRO_CONTENT_MARKER_REL = `.validity/native-app/${METRO_CONTENT_MARKER_NAME}`;

/**
 * The managed Metro restart, spelled out.
 *
 * Provenance (do not weaken this to a generic "restart things"): the decay
 * isolation experiment of 2026-07-29 ran 18 consecutive sweeps of the same 13
 * specs against one continuously-running emulator. Metro was reset three times
 * — via exactly this marker deletion — and EVERY reset was followed immediately
 * by full recovery (4/0/36 → 37/0/3, twice). Resetting agent-device alone
 * (daemon killed, `sessions` + `device-claims` removed) mid-collapse changed
 * nothing across two further sweeps, and the emulator was never reset at all
 * while the system went healthy → collapsed → recovered → collapsed →
 * recovered. So the two commands a developer would otherwise reach for are
 * named here as the things NOT to run: they were measured, and they do not
 * work on this failure.
 */
export function metroManagedRestartCommand(appDir?: string): string {
  const marker = appDir
    ? `${appDir.replace(/\/+$/, '')}/${METRO_CONTENT_MARKER_NAME}`
    : METRO_CONTENT_MARKER_REL;
  return (
    `rm -f "${marker}"   # then re-run verify: Validity kills its own Metro and respawns it with \`--clear\`\n` +
    '# NOT `adb emu kill` and NOT `agent-device open` — the emulator and the agent-device session\n' +
    '# were both exonerated for this signature by the 2026-07-29 isolation experiment'
  );
}

export interface SessionResetOptions {
  /**
   * Which device the session is on. LOAD-BEARING: the device rung of the reset
   * is platform-specific, and `adb emu kill` handed to someone driving an iOS
   * simulator (observed 2026-07-29) is worse than no fix at all — it is a
   * command that cannot work, printed with the confidence of one that can, and
   * it tells the reader the tool does not know what it is looking at.
   */
  platform?: 'ios' | 'android';
  /** AVD name for the Android rung; `<avd>` when unknown. */
  avdName?: string;
  /** Simulator name/UDID for the iOS rung; `booted` when unknown. */
  deviceName?: string;
}

/**
 * The full reset that recovers a decayed device session — the ONLY remedy
 * found for it, and it works every time. Which of the three layers actually
 * decays is still unknown (they were always reset together), which is exactly
 * why this resets all three rather than pretending to know.
 *
 * The first two rungs (daemon + state dirs) are platform-independent. The third
 * is not, so an UNKNOWN platform prints neither device command: a comment naming
 * both is honest, and a guess is the bug this signature exists to prevent.
 */
export function fullSessionResetCommand(opts: SessionResetOptions = {}): string {
  const lines = [KILL_AGENT_DEVICE_DAEMON, CLEAR_AGENT_DEVICE_STATE];
  if (opts.platform === 'android') {
    lines.push('adb emu kill');
    lines.push(
      `~/Library/Android/sdk/emulator/emulator -avd ${opts.avdName ?? '<avd>'} -no-snapshot-load &`,
    );
  } else if (opts.platform === 'ios') {
    const device = opts.deviceName ?? 'booted';
    lines.push(`xcrun simctl shutdown ${device}`);
    lines.push(`xcrun simctl boot ${device}`);
  } else {
    lines.push(
      '# then cold-restart the device: `xcrun simctl shutdown booted && xcrun simctl boot booted`' +
        ' (iOS) or `adb emu kill` + relaunch the AVD with -no-snapshot-load (Android)',
    );
  }
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* advisory: `agent-device doctor --json` (0.20.5)                             */
/* -------------------------------------------------------------------------- */

/** One row of `agent-device doctor --json` (`DoctorCheck` in its own typings). */
export interface AgentDeviceDoctorCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  summary: string;
  hint?: string;
  /** Upstream's own suggested command for this row, when it printed one. */
  command?: string;
}

/**
 * `agent-device doctor --json`, reduced to what Validity reports.
 *
 * Shape read off the installed 0.20.5 package's `DoctorCommandResult`
 * (`dist/src/index.d.ts`): `{status, summary, kind, platform?, target?,
 * targetApp?, metro?, checks[]}`. Fields Validity does not surface are
 * deliberately dropped rather than mirrored — this is an advisory relay, not a
 * second contract to keep in sync.
 */
export interface AgentDeviceDoctorReport {
  status?: 'pass' | 'warn' | 'fail' | 'info';
  summary?: string;
  /** `auto` | `react-native` | `expo` | `repack` — upstream's project classification. */
  kind?: string;
  checks: AgentDeviceDoctorCheck[];
}

const DOCTOR_STATUSES = new Set(['pass', 'warn', 'fail', 'info']);

/**
 * Parse `agent-device doctor --json`. PURE and TOTAL: unreadable output, a
 * missing `checks` array, or rows of the wrong shape all degrade to
 * `undefined`/fewer rows rather than throwing. A doctor Validity could not read
 * must look exactly like a doctor Validity never ran.
 */
export function parseAgentDeviceDoctorJson(
  stdout: string | undefined,
): AgentDeviceDoctorReport | undefined {
  if (!stdout || stdout.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const data = (parsed as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const rawChecks = Array.isArray(d.checks) ? d.checks : [];
  const checks: AgentDeviceDoctorCheck[] = [];
  for (const row of rawChecks) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.summary !== 'string') continue;
    if (typeof r.status !== 'string' || !DOCTOR_STATUSES.has(r.status)) continue;
    checks.push({
      id: r.id,
      status: r.status as AgentDeviceDoctorCheck['status'],
      summary: r.summary,
      ...(typeof r.hint === 'string' ? { hint: r.hint } : {}),
      ...(typeof r.command === 'string' ? { command: r.command } : {}),
    });
  }
  const status =
    typeof d.status === 'string' && DOCTOR_STATUSES.has(d.status) ? d.status : undefined;
  if (status === undefined && checks.length === 0) return undefined;
  return {
    ...(status ? { status: status as AgentDeviceDoctorReport['status'] } : {}),
    ...(typeof d.summary === 'string' ? { summary: d.summary } : {}),
    ...(typeof d.kind === 'string' ? { kind: d.kind } : {}),
    checks,
  };
}

/** Rows worth repeating to a human: upstream's own warn/fail findings. */
export function doctorFindings(report: AgentDeviceDoctorReport): AgentDeviceDoctorCheck[] {
  return report.checks.filter((c) => c.status === 'warn' || c.status === 'fail');
}

/** How many findings a single advisory line names before it says "+N more". */
export const MAX_ADVISORY_FINDINGS = 3;

/**
 * One line summarizing what upstream's doctor found, or undefined when it found
 * nothing worth saying.
 *
 * `undefined` for a clean doctor is deliberate: "agent-device doctor is happy"
 * is not evidence that the environment is fine (it never looked at the
 * component, the companion, or the bridge), so printing it beside a failure
 * would read as reassurance nobody earned.
 */
export function summarizeAgentDeviceDoctor(
  report: AgentDeviceDoctorReport | undefined,
): string | undefined {
  if (!report) return undefined;
  const findings = doctorFindings(report);
  if (findings.length === 0) return undefined;
  const shown = findings.slice(0, MAX_ADVISORY_FINDINGS);
  const more = findings.length - shown.length;
  const rows = shown.map((c) => `${c.id} (${c.status}): ${c.summary}`);
  return (
    '`agent-device doctor` also reports ' +
    `${findings.length} finding${findings.length === 1 ? '' : 's'} — ` +
    rows.join('; ') +
    (more > 0 ? `; +${more} more (run \`agent-device doctor\`)` : '') +
    '. Advisory only: upstream is describing the DEVICE TOOLCHAIN, not the component under test.'
  );
}

/**
 * Run `agent-device doctor --json` through the injected runner. Never throws;
 * a non-zero exit is still PARSED, because upstream exits non-zero precisely
 * when it has findings — and those findings are the whole point.
 *
 * NOT quite side-effect-free, and it is worth knowing which: `doctor --help`
 * says that on iOS simulators it "warms the XCTest runner build cache in the
 * background when missing". Nothing on the device under test is touched — no
 * session is opened, no app is launched, no state dir is written — so this is
 * safe on a failure path, but it is why the probe is reserved for the
 * weak-diagnosis case rather than run speculatively.
 */
export async function probeAgentDeviceDoctor(opts: {
  run: CommandRunner;
  platform?: 'ios' | 'android';
  /** Verify a specific installed app without opening a session (`--app`). */
  app?: string;
}): Promise<AgentDeviceDoctorReport | undefined> {
  const args = ['doctor', '--json'];
  if (opts.platform) args.push('--platform', opts.platform);
  if (opts.app) args.push('--app', opts.app);
  try {
    const res = await opts.run('agent-device', args);
    return (
      parseAgentDeviceDoctorJson(`${res.stdout}`) ?? parseAgentDeviceDoctorJson(`${res.stderr}`)
    );
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* probe: upstream machine-readable error (RANKS ABOVE EVERY HEURISTIC)        */
/* -------------------------------------------------------------------------- */

/**
 * Error codes agent-device can emit, read off its own installed source.
 *
 * Re-read against **0.20.5** on 2026-08-06 (previously 0.20.3): the installed
 * package's `KNOWN_APP_ERROR_CODES` is byte-identical to the list below (16
 * codes, INVALID_ARGS … UNKNOWN), and RUNNER_WEDGED / IOS_AX_SNAPSHOT_FAILED /
 * XCTEST_RECORDED_FAILURE are all still minted by the bundled iOS runner
 * (`dist/apple/runner/…/RunnerTests+CommandExecution.swift`) and its client.
 * Nothing added, nothing removed — this list needed no edit for the upgrade.
 *
 * The 0.20.3 read it inherits from (2026-07-30, previously 0.20.1):
 *
 *  - `KNOWN_APP_ERROR_CODES` in `dist/src/sdk-contracts.d.ts` enumerates the
 *    kernel codes (INVALID_ARGS … UNKNOWN). Compared literally against 0.20.3:
 *    **unchanged, all 16 still present, none added.** The doc comment there now
 *    states the type is derived from the array, so a new kernel code cannot
 *    appear without entering that enumeration.
 *  - The type is `KnownAppErrorCode | (string & {})`, i.e. OPEN — subsystems
 *    mint their own. RUNNER_WEDGED / IOS_AX_SNAPSHOT_FAILED /
 *    XCTEST_RECORDED_FAILURE come from the iOS runner
 *    (`dist/apple/runner/.../RunnerTests+CommandExecution.swift`); all three
 *    confirmed still present in 0.20.3.
 *  - NEW in the 0.20.3 read: a boot/CI *diagnostic classification* taxonomy
 *    (`IOS_BOOT_TIMEOUT`, `IOS_RUNNER_CONNECT_TIMEOUT`, `IOS_TOOL_MISSING`,
 *    `ANDROID_BOOT_TIMEOUT`, `ADB_TRANSPORT_UNAVAILABLE`,
 *    `CI_RESOURCE_STARVATION_SUSPECTED`, `BOOT_COMMAND_FAILED`). These are a
 *    SEPARATE axis from the kernel codes — they classify a boot failure's cause
 *    (a `TOOL_MISSING` on Android is reported as `ADB_TRANSPORT_UNAVAILABLE`)
 *    rather than replacing the wrapped `Error (CODE)` a command prints. They
 *    are listed here only so the bare `CODE: message` form stays parseable if
 *    one is ever surfaced that way; nothing keys behaviour off them.
 *
 * This list exists ONLY to make the bare `CODE: message` form (no `Error (…)`
 * wrapper) safe to parse — an unknown code in that shape could be any shouty
 * sentence. The wrapped form is accepted for ANY code, so a new upstream code
 * is passed through the day it ships rather than the day this list is updated.
 * That is deliberate: the failure mode being killed is Validity out-guessing a
 * tool that already answered.
 */
export const AGENT_DEVICE_ERROR_CODES = [
  // kernel (KnownAppErrorCode) — verified byte-identical on 0.20.3 and 0.20.5
  'INVALID_ARGS',
  'DEVICE_NOT_FOUND',
  'DEVICE_IN_USE',
  'TOOL_MISSING',
  'APP_NOT_INSTALLED',
  'UNSUPPORTED_PLATFORM',
  'UNSUPPORTED_OPERATION',
  'NOT_IMPLEMENTED',
  'COMMAND_FAILED',
  'SESSION_NOT_FOUND',
  'UNAUTHORIZED',
  'AMBIGUOUS_MATCH',
  'REPLAY_DIVERGENCE',
  'REPAIR_SESSION_EXPIRED',
  'REPAIR_COMMIT_FAILED',
  'UNKNOWN',
  // iOS runner — all three still present in 0.20.3 and 0.20.5
  'RUNNER_WEDGED',
  'IOS_AX_SNAPSHOT_FAILED',
  'XCTEST_RECORDED_FAILURE',
  // boot/CI diagnostic classification (new in the 0.20.3 read; still present on 0.20.5)
  'IOS_BOOT_TIMEOUT',
  'IOS_RUNNER_CONNECT_TIMEOUT',
  'IOS_TOOL_MISSING',
  'ANDROID_BOOT_TIMEOUT',
  'ADB_TRANSPORT_UNAVAILABLE',
  'CI_RESOURCE_STARVATION_SUSPECTED',
  'BOOT_COMMAND_FAILED',
] as const;

/**
 * Codes for which Validity holds a STRICTLY more specific read of the very same
 * error text — a better symptom and a narrower fix, derived mechanically rather
 * than guessed. Those probes run first and the passthrough becomes their
 * fallback; every other code passes through immediately, above all heuristics.
 *
 * Nothing here is a heuristic: each entry names a probe that pairs the error
 * text with a second machine-readable observation (the session list, the
 * daemon's own version).
 */
export const UPSTREAM_CODES_WITH_SPECIFIC_PROBE = new Set<string>([
  'DEVICE_IN_USE', // → phantom-device-claim / stale-device-claim (pairs with `session list`)
  'DEVICE_NOT_FOUND', // → device-not-ready
  'NO_DEVICE', // → device-not-ready (NO_DEVICE_RE reads this very token)
  'INVALID_ARGS', // → device-not-ready ("session … is bound to <platform> device")
  'COMMAND_FAILED', // → stale-agent-device (the exit-127 `-p: inaccessible` signature)
]);

/** `Error (CODE): message` — the shape `renderError` prints for every failure. */
const WRAPPED_ERROR_RE = /^\s*Error \(([A-Z][A-Z0-9_]*)\):[ \t]*(.*)$/m;
/** Bare `CODE: message`, accepted only for codes we know upstream mints. */
const BARE_ERROR_RE = /^\s*([A-Z][A-Z0-9_]{3,}):[ \t]*(.*)$/m;

const HINT_RE = /^\s*Hint:[ \t]*(.+)$/m;
const DIAGNOSTIC_ID_RE = /^\s*Diagnostic ID:[ \t]*(\S+)/m;
const DIAGNOSTICS_LOG_RE = /^\s*Diagnostics Log:[ \t]*(\S+)/m;

/**
 * Parse the machine-readable error agent-device already reported, if any.
 *
 * PURE, and conservative in exactly one direction: it would rather return
 * `undefined` (no upstream cause, Validity's own probes decide) than invent a
 * code. Returns the FIRST wrapped error in the text — the driver concatenates
 * the agent-device failure with the platform-CLI fallback's, and the
 * agent-device one is the specific of the two (see openUrlWithNativeFallback).
 */
export function parseAgentDeviceError(
  text: string | undefined,
): UpstreamAgentDeviceError | undefined {
  if (!text || text.trim() === '') return undefined;
  let code: string | undefined;
  let message = '';
  const wrapped = text.match(WRAPPED_ERROR_RE);
  if (wrapped) {
    code = wrapped[1];
    message = (wrapped[2] ?? '').trim();
  } else {
    const bare = text.match(BARE_ERROR_RE);
    if (bare && (AGENT_DEVICE_ERROR_CODES as readonly string[]).includes(bare[1]!)) {
      code = bare[1];
      message = (bare[2] ?? '').trim();
    }
  }
  if (!code) return undefined;
  return {
    code,
    // Verbatim, only trimmed + length-bounded. A cause the developer cannot
    // match against what they saw in their terminal is not a passthrough.
    message: message.slice(0, 400),
    hint: text.match(HINT_RE)?.[1]?.trim().slice(0, 400) || undefined,
    diagnosticId: text.match(DIAGNOSTIC_ID_RE)?.[1],
    logPath: text.match(DIAGNOSTICS_LOG_RE)?.[1],
  };
}

/**
 * Per-code context: what the code MEANS for a Validity run, and what to do.
 * Deliberately additive to (never a replacement for) upstream's own message and
 * hint — those are reproduced verbatim in the symptom.
 */
function upstreamGuidance(code: string): { detail: string; fix?: string } {
  switch (code) {
    case 'RUNNER_WEDGED':
      return {
        detail:
          "agent-device's on-device runner reported its own main thread stuck in work it cannot " +
          'cancel, so it stopped answering commands and asked to be recycled. Nothing the ' +
          'component does can cause or fix this — the snapshot/screenshot never came back from ' +
          'the runner, so verdicts are withheld. The runner restarts itself; retry the spec, and ' +
          'if the SAME screen wedges repeatedly, report it upstream with the diagnostic ID.',
        fix: 'agent-device session list   # then retry; if it recurs, file the Diagnostic ID upstream',
      };
    case 'SESSION_NOT_FOUND':
      return {
        detail:
          'The agent-device session this run was driving no longer exists, so every follow-up ' +
          'command (snapshot, screenshot, wait) addressed a session that is gone. This is the ' +
          'shape left behind when a deep link had to be opened through the platform CLI instead ' +
          'of agent-device (no session is created on that path) or when the daemon was restarted ' +
          'mid-run. Re-running from the project root re-opens a session.',
        fix: 'agent-device close   # run from the project root, then re-run the verify',
      };
    case 'TOOL_MISSING':
      return {
        detail:
          'agent-device could not find a host tool it needs (adb / xcrun / simctl). Nothing ' +
          'reached the device, so no criterion could be scored.',
        fix: 'agent-device doctor   # install the missing tool it names',
      };
    case 'APP_NOT_INSTALLED':
      return {
        detail:
          'The Validity companion app is not installed on the device under test, so the deep ' +
          'link had nothing to open. Verdicts are withheld rather than scored against whatever ' +
          'was on screen.',
        fix: 'validity install-wizard --non-interactive   # rebuilds + installs the companion',
      };
    default:
      return {
        detail:
          'agent-device reported this failure itself, in machine-readable form, so it is ' +
          'reproduced above verbatim rather than re-guessed from symptoms. The command never ' +
          'produced usable device output, so every criterion for this spec is withheld as ' +
          'unverifiable rather than scored against a screen that was never observed.',
      };
  }
}

/**
 * Pass an upstream error through AS THE CAUSE.
 *
 * The bug this closes (observed 2026-07-29, iOS): agent-device answered
 * `Error (RUNNER_WEDGED): The iOS runner main thread has been stuck in
 * abandoned work for 246 seconds and cannot recover on its own.` — with a
 * Diagnostic ID — and Validity reported `render-failure`, "the most likely
 * remaining cause is the component itself". A tool that out-guesses a
 * machine-readable answer from the layer below it is not diagnosing, it is
 * fabricating; and the fabrication pointed the developer at their own code
 * while the runner was wedged.
 *
 * CONFIRMED, always: the code was not inferred, it was reported.
 */
export function diagnoseUpstreamError(
  upstream: UpstreamAgentDeviceError | undefined,
): EnvironmentDiagnosis | undefined {
  if (!upstream) return undefined;
  const { detail, fix } = upstreamGuidance(upstream.code);
  const trail = [
    upstream.hint ? `upstream hint: ${upstream.hint}` : undefined,
    upstream.diagnosticId ? `Diagnostic ID ${upstream.diagnosticId}` : undefined,
    upstream.logPath ? `log ${upstream.logPath}` : undefined,
  ].filter(Boolean);
  return {
    cause: 'agent-device-error',
    symptom:
      `agent-device reported \`${upstream.code}\`: ${upstream.message}` +
      (trail.length ? ` (${trail.join('; ')})` : ''),
    detail,
    fixCommand: fix,
    confidence: 'confirmed',
    upstream,
  };
}

/* -------------------------------------------------------------------------- */
/* probe: phantom device claim                                                 */
/* -------------------------------------------------------------------------- */

/** `agent-device open` refusing because the device is claimed by a session. */
const IN_USE_RE = /already in use by session/i;

/**
 * The signature observed on a live machine: `agent-device open` insists
 *
 *     Device is already in use by session 'default'
 *
 * while `agent-device session list` answers `{"sessions": []}`. The claim
 * outlived the session that took it, `agent-device close` does not clear it,
 * and only killing the daemon does.
 *
 * PURE — both inputs are text the caller already has. Returns undefined for
 * anything less than the exact pairing: a non-empty session list is a REAL
 * conflict (a session genuinely holds the device), and an unparseable list is
 * "cannot tell". Both degrade to no diagnosis rather than a wrong one.
 */
export function detectPhantomClaim(
  openErrorText: string | undefined,
  sessionListStdout: string | undefined,
): EnvironmentDiagnosis | undefined {
  if (!openErrorText || !IN_USE_RE.test(openErrorText)) return undefined;
  if (!sessionListEmpty(sessionListStdout)) return undefined;
  const session = openErrorText.match(/session ['"]([^'"]+)['"]/i)?.[1];
  return {
    cause: 'phantom-device-claim',
    symptom:
      `agent-device refuses to open the deep link — "device is already in use by session` +
      `${session ? ` '${session}'` : ''}" — while \`agent-device session list\` reports no sessions at all.`,
    detail:
      'The device claim outlived the session that took it, so every open is rejected by a session ' +
      'that no longer exists. Until it is released no deep link lands, so nothing renders and ' +
      'every criterion for this spec is withheld as unverifiable rather than scored against a ' +
      'screen that was never navigated. ' +
      PHANTOM_CLAIM_FIX_NOTE,
    fixCommand: phantomClaimFixCommand(session),
    confidence: 'confirmed',
  };
}

/**
 * Why the fix is a LADDER rather than a daemon kill.
 *
 * When this probe was written (agent-device 0.20.1) a phantom claim genuinely
 * survived `close`, so killing the daemon and clearing its state dirs was the
 * only thing that worked. Upstream fixed claim GC in 0.20.2 — verified live on
 * 0.20.3 (2026-07-30) by watching `~/.agent-device/device-claims/` go from one
 * file to zero across a single `agent-device close`, where on 0.20.1 the file
 * survived the identical sequence.
 *
 * The version compare that used to live in this text is GONE (2026-08-06): with
 * the readiness floor at 0.20.5 (see MIN_AGENT_DEVICE_VERSION), "you might be
 * on a build older than 0.20.2" is not a state worth spending a line of a fix
 * recipe on — an install that old is already reported by its own readiness row,
 * with an upgrade command, and repeating the version arithmetic here just made
 * the fix harder to read.
 *
 * The escalation stays, because the state it recovers does not depend on a
 * version at all: a claim file with no owning session is exactly what a
 * hard-killed daemon leaves behind on ANY build. Cheap targeted release first,
 * daemon reset second.
 */
const PHANTOM_CLAIM_FIX_NOTE =
  'A targeted `close` releases the claim, so try that first; only if the claim survives it (the ' +
  'signature of a daemon that was hard-killed rather than closed) is the daemon reset below ' +
  'actually needed.';

/** Targeted release first, daemon reset as the escalation. */
function phantomClaimFixCommand(session: string | undefined): string {
  return [
    closeSessionCommand(session ?? 'default'),
    '# if the claim survives that (a daemon that was killed rather than closed):',
    KILL_AGENT_DEVICE_DAEMON,
    CLEAR_AGENT_DEVICE_STATE,
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* device claims: who owns them                                               */
/* -------------------------------------------------------------------------- */

/**
 * What a claim file says about the process that took it.
 *
 *   'live'    — the recorded owner pid answers `kill(pid, 0)`. The claim is
 *               someone's, and nothing here may touch it.
 *   'stale'   — the owner is provably gone: its pid is dead, or the session
 *               state dir it names is not on disk any more.
 *   'unknown' — the file could not be read or does not carry an owner pid.
 *               Diagnosed, NEVER deleted: "I cannot read it" is not evidence.
 */
export type DeviceClaimState = 'live' | 'stale' | 'unknown';

/** Which of the two provable-death signatures made a claim stale. */
export type StaleClaimReason = 'owner-process-dead' | 'owner-state-dir-gone';

/** One claim file under `device-claims`, classified by its owner's liveness. */
export interface DeviceClaim {
  /** Absolute path — what a release deletes, one file at a time. */
  path: string;
  state: DeviceClaimState;
  reason?: StaleClaimReason;
  /** The daemon pid that took the claim, when the file named one. */
  ownerPid?: number;
  /** The device the claim is against (`deviceKey`), for the message. */
  device?: string;
  /** The session holding it, when the file named one. */
  session?: string;
}

/**
 * Where agent-device keeps its device claims.
 *
 * `$AGENT_DEVICE_CLAIMS_DIR` wins when set (trimmed, then resolved — upstream's
 * own rule, read off the 0.20.5 dist): a probe that ignored it would read an
 * EMPTY default directory on a machine whose claims live elsewhere and conclude
 * the environment is clean.
 *
 * Absent the override, upstream builds the path from `homedir()` rather than
 * from its state dir. This derives it from `stateDir` instead, which is the
 * same path in production and keeps the one injection seam the probes already
 * have — an injected state dir must be able to place claim files.
 */
export function agentDeviceClaimsDir(
  stateDir: string = agentDeviceStateDir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.AGENT_DEVICE_CLAIMS_DIR;
  return override && override.trim() !== ''
    ? resolve(override.trim())
    : resolve(stateDir, 'device-claims');
}

/**
 * Classify ONE claim file from its raw JSON.
 *
 * Deliberately conservative in one direction only: a live-looking owner is
 * 'live' even though a recycled pid could fake it, because the cost of a wrong
 * 'stale' is deleting a claim a running daemon depends on, while the cost of a
 * wrong 'live' is that the readiness pass stays quiet and the open-time
 * {@link detectPhantomClaim} — which has the refusal text in hand — names it a
 * moment later. The ownerStartTime upstream also records is NOT consulted for
 * the same reason: it can only ever turn a 'live' into a 'stale'.
 *
 * The state-dir check fires only on a POSITIVE absence: `exists` returning
 * false for a path the claim itself names. An `exists` that throws leaves the
 * claim exactly as its pid classified it.
 */
export function classifyDeviceClaim(
  path: string,
  raw: string | undefined,
  opts: { fs?: DiagnosisFs; isPidAlive?: (pid: number) => boolean } = {},
): DeviceClaim {
  const fs = opts.fs ?? realDiagnosisFs;
  const isAlive = opts.isPidAlive ?? realIsPidAlive;
  if (raw === undefined) return { path, state: 'unknown' };
  let parsed: {
    ownerPid?: unknown;
    stateDir?: unknown;
    deviceKey?: unknown;
    device?: unknown;
    session?: unknown;
  };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { path, state: 'unknown' };
    parsed = value as typeof parsed;
  } catch {
    return { path, state: 'unknown' };
  }
  // `device.name` is the human one ("iPhone 15"); `deviceKey` is the
  // `local:<platform>:<os>:<id>` the file is hashed from. Either identifies the
  // claim in a message; neither is required for the classification.
  const deviceName =
    parsed.device && typeof parsed.device === 'object'
      ? (parsed.device as { name?: unknown }).name
      : undefined;
  const device =
    typeof deviceName === 'string'
      ? deviceName
      : typeof parsed.deviceKey === 'string'
        ? parsed.deviceKey
        : undefined;
  const session = typeof parsed.session === 'string' ? parsed.session : undefined;
  const named = {
    ...(device === undefined ? {} : { device }),
    ...(session === undefined ? {} : { session }),
  };
  if (typeof parsed.ownerPid !== 'number' || !Number.isFinite(parsed.ownerPid)) {
    return { path, state: 'unknown', ...named };
  }
  const ownerPid = parsed.ownerPid;
  let alive: boolean;
  try {
    alive = isAlive(ownerPid);
  } catch {
    // Cannot probe → assume alive, so an unprobeable host never deletes.
    alive = true;
  }
  if (!alive) {
    return { path, state: 'stale', reason: 'owner-process-dead', ownerPid, ...named };
  }
  if (typeof parsed.stateDir === 'string' && parsed.stateDir !== '') {
    let missing = false;
    try {
      missing = !fs.exists(parsed.stateDir);
    } catch {
      missing = false;
    }
    if (missing) {
      return { path, state: 'stale', reason: 'owner-state-dir-gone', ownerPid, ...named };
    }
  }
  return { path, state: 'live', ownerPid, ...named };
}

/**
 * Read and classify every claim file in `claimsDir`. NEVER throws: an
 * unreadable directory is an empty list, because "I could not look" must
 * produce no diagnosis and no deletion.
 */
export function readDeviceClaims(
  opts: {
    claimsDir?: string;
    stateDir?: string;
    fs?: DiagnosisFs;
    isPidAlive?: (pid: number) => boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): DeviceClaim[] {
  const fs = opts.fs ?? realDiagnosisFs;
  const dir = opts.claimsDir ?? agentDeviceClaimsDir(opts.stateDir, opts.env);
  let entries: string[];
  try {
    entries = fs.readDir(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
  return entries.map((name) => {
    const path = resolve(dir, name);
    let raw: string | undefined;
    try {
      raw = fs.readFile(path);
    } catch {
      raw = undefined;
    }
    return classifyDeviceClaim(path, raw, {
      fs,
      ...(opts.isPidAlive ? { isPidAlive: opts.isPidAlive } : {}),
    });
  });
}

/** What a release attempt did. Both lists are claims, so both can be named. */
export interface ClaimReleaseOutcome {
  released: DeviceClaim[];
  /** Stale claims a delete refused (permissions, a read-only fs seam). */
  failed: DeviceClaim[];
}

/**
 * Delete the claim files whose owner is provably dead — one file at a time,
 * never the directory.
 *
 * This is the auto-heal the documented remedy already sanctions, minus the
 * collateral: the ladder ends in `rm -rf …/device-claims`, which takes LIVE
 * claims with it. Only 'stale' is touched; 'live' and 'unknown' are left for
 * the diagnosis to talk about.
 */
export function releaseStaleDeviceClaims(
  claims: DeviceClaim[],
  fs: DiagnosisFs = realDiagnosisFs,
): ClaimReleaseOutcome {
  const outcome: ClaimReleaseOutcome = { released: [], failed: [] };
  for (const claim of claims) {
    if (claim.state !== 'stale') continue;
    if (!fs.removeFile) {
      outcome.failed.push(claim);
      continue;
    }
    try {
      fs.removeFile(claim.path);
      outcome.released.push(claim);
    } catch {
      outcome.failed.push(claim);
    }
  }
  return outcome;
}

/** One line naming what was released and whose it was. */
export function describeReleasedClaims(released: DeviceClaim[]): string {
  if (released.length === 0) return '';
  const each = released
    .map((c) => {
      const who = c.reason === 'owner-state-dir-gone' ? 'whose session state dir is gone' : 'dead';
      const pid = c.ownerPid === undefined ? '' : ` pid ${c.ownerPid}`;
      const device = c.device ? `, device ${c.device}` : '';
      return `${who} agent-device daemon${pid}${device}`;
    })
    .join('; ');
  return `Released ${released.length} stale device claim(s) left by a ${each}.`;
}

/**
 * The same phantom claim, detected from STATE instead of from a failed open —
 * so the readiness checklist can name it BEFORE a device is driven, without
 * having to provoke the error.
 *
 * Requires the exact pairing observed live: claim files on disk while
 * `agent-device session list` answers an empty array. A non-empty list, an
 * unparseable list, or no claim files all yield nothing — the checklist must
 * never send someone to reset a working daemon.
 *
 * OWNER-AWARE since 2026-08-24. The pairing alone is producible on a perfectly
 * healthy machine: `session list` reads the daemon's MEMORY, so a daemon that
 * exited since the last run answers `{"sessions":[]}` while the claim file of
 * the session it was holding is still on disk. Validity's own native verify
 * produces exactly that state once per run, which is why this fired every time
 * and the remediation "worked" only until the next verify. A claim whose owner
 * is ALIVE is therefore not evidence of anything here — the open-time
 * {@link detectPhantomClaim} is the backstop for a live-looking claim that
 * really is wedged.
 */
export function diagnosePhantomClaimState(
  claims: DeviceClaim[],
  sessionListStdout: string | undefined,
): EnvironmentDiagnosis | undefined {
  const suspect = claims.filter((c) => c.state !== 'live');
  if (suspect.length === 0) return undefined;
  if (!sessionListEmpty(sessionListStdout)) return undefined;
  const stale = suspect.filter((c) => c.state === 'stale');
  const owners = stale
    .map((c) => c.ownerPid)
    .filter((pid): pid is number => pid !== undefined)
    .join(', ');
  return {
    cause: 'phantom-device-claim',
    symptom:
      `${suspect.length} device claim file(s) with no live owner are held under ` +
      `${AGENT_DEVICE_CLAIMS_DIR_LABEL}${owners ? ` (dead owner pid ${owners})` : ''} while ` +
      '`agent-device session list` reports no sessions at all.',
    detail:
      'A claim outlived the session that took it. Every `agent-device open` will be rejected with ' +
      '"device is already in use by session …" naming a session that no longer exists, so no deep ' +
      'link lands, nothing renders, and every criterion comes back with no verdict. ' +
      PHANTOM_CLAIM_FIX_NOTE,
    fixCommand: phantomClaimFixCommand(stale[0]?.session),
    confidence: 'confirmed',
  };
}

/** How the claims dir is spelled in prose (the fix recipes use `$HOME`). */
const AGENT_DEVICE_CLAIMS_DIR_LABEL = '~/.agent-device/device-claims';

/**
 * The session agent-device NAMES in a DEVICE_IN_USE refusal:
 *
 *     Error (DEVICE_IN_USE): Device is already in use by session "default".
 *
 * Quoting is not guaranteed (the same message has been seen with single quotes,
 * double quotes and bare), so the quote is optional and the capture runs to the
 * first quote or whitespace; a trailing sentence period is trimmed because the
 * message ends in one and a session called `default.` does not exist.
 */
const IN_USE_SESSION_RE = /already in use by session\s+['"]?([^'"\s]+)/i;

/** The refused-session name, or undefined when the text names none. */
export function parseInUseSessionName(openErrorText: string | undefined): string | undefined {
  if (!openErrorText) return undefined;
  const raw = openErrorText.match(IN_USE_SESSION_RE)?.[1];
  const name = raw?.replace(/[.,;:]+$/, '');
  return name ? name : undefined;
}

/**
 * Does `agent-device session list` name the session `name`?
 *
 * `undefined` means the answer could not be read (unparseable JSON, no
 * `sessions` array) — never `false`, because "I could not tell" and "that
 * session is not there" lead to opposite diagnoses.
 *
 * Matching is on WHOLE values, not substrings, and that is the whole difficulty:
 * the live capture (2026-07-28) showed a stale `default` entry alongside the
 * cwd-scoped `cwd_9c96d7bf5deaeb65_default` session the CLI was actually
 * writing to, and the latter CONTAINS the former. A substring test would call
 * every ordinary cwd-scoped session a stale claim. An entry's state dir counts
 * by its last path segment (`~/.agent-device/sessions/default`), which is how
 * the session was identified on the machine where this was observed.
 */
export function sessionListHasSession(
  stdout: string | undefined,
  name: string,
): boolean | undefined {
  if (!stdout || stdout.trim() === '' || !name) return undefined;
  let sessions: unknown;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object') return undefined;
    sessions = (parsed as { sessions?: unknown }).sessions;
  } catch {
    return undefined;
  }
  if (!Array.isArray(sessions)) return undefined;
  const matches = (value: string): boolean =>
    value === name || value.replace(/\/+$/, '').split('/').pop() === name;
  for (const entry of sessions) {
    if (typeof entry === 'string' && matches(entry)) return true;
    if (entry && typeof entry === 'object') {
      for (const value of Object.values(entry as Record<string, unknown>)) {
        if (typeof value === 'string' && matches(value)) return true;
      }
    }
  }
  return false;
}

/** Release one named claim — the recovery that worked, without touching the daemon. */
export function closeSessionCommand(session: string): string {
  return `agent-device close --session ${session}`;
}

/**
 * The claim that survives its own `close` — a DIFFERENT state from the phantom
 * claim above, and the one actually captured on 2026-07-28.
 *
 * `agent-device close` printed `Closed: default`, and the very next `open` was
 * refused with `Device is already in use by session "default"` — while
 * `session list` was NOT empty: it listed a stale `default` session (state dir
 * `~/.agent-device/sessions/default`, once printed twice in the same array),
 * distinct from the cwd-scoped `cwd_<hash>_default` session the CLI was writing
 * to. So the unqualified `close` reported success against the cwd-scoped
 * session while the device stayed claimed by the bare one.
 *
 * That distinction is the whole point of a separate cause: the phantom claim
 * needs the daemon killed and its state dirs removed, and this one is released
 * by a single targeted `close` — telling someone to kill their daemon here
 * would be a heavier fix than the situation calls for.
 *
 * PURE. Requires the exact pairing: an in-use refusal that NAMES a session, and
 * a readable session list that CONTAINS it. An empty list is the phantom claim
 * (left to {@link detectPhantomClaim}), an unreadable list is "cannot tell", and
 * a named session absent from a readable list is a state nobody has seen — all
 * three yield nothing rather than a guess.
 */
export function detectStaleDeviceClaim(
  openErrorText: string | undefined,
  sessionListStdout: string | undefined,
): EnvironmentDiagnosis | undefined {
  if (!openErrorText || !IN_USE_RE.test(openErrorText)) return undefined;
  const session = parseInUseSessionName(openErrorText);
  if (!session) return undefined;
  if (sessionListHasSession(sessionListStdout, session) !== true) return undefined;
  return {
    cause: 'stale-device-claim',
    symptom:
      `agent-device refuses to open the deep link — "device is already in use by session ` +
      `'${session}'" — and \`agent-device session list\` still shows that session, even though ` +
      'this run had already closed it.',
    detail:
      'Sessions are keyed by CWD, so an unqualified `agent-device close` closes the cwd-scoped ' +
      'session (`cwd_<hash>_<name>`) and reports success while the device claim stays held by the ' +
      `bare \`${session}\` session that took it. Every open is refused until that specific session ` +
      'is closed by name, so no deep link lands, nothing renders, and every criterion for this spec ' +
      'is withheld as unverifiable rather than scored against a screen that was never navigated. ' +
      'Unlike a phantom claim this does NOT need the daemon killed — the named close releases it.',
    fixCommand: closeSessionCommand(session),
    confidence: 'confirmed',
  };
}

/* -------------------------------------------------------------------------- */
/* probe: no agent-device session (cold daemon)                                */
/* -------------------------------------------------------------------------- */

/**
 * agent-device's own "you never ran `open`" signature. Read off 0.20.1's error
 * strings, not guessed: the code is `SESSION_NOT_FOUND` and the messages are
 * `No active session. Run open first.`, `iOS <cmd> requires an active app
 * session on the target device. Run open first (…)`, and `perf requires an
 * active session. Run open first.`
 *
 * Re-checked against the installed 0.20.5 package on 2026-08-06: both the
 * `SESSION_NOT_FOUND` code and the `Run open first` phrasing are still emitted
 * (`dist/src/snapshot2.js` mints the iOS variant verbatim), so this pattern
 * needed no edit.
 */
export const NO_SESSION_SIGNATURE = /SESSION_NOT_FOUND|no active session|run open first/i;

/**
 * A capture that ran its whole ladder with NO agent-device session behind it.
 *
 * Measured on iOS 2026-07-29 from a cold daemon (`validity doctor`: "daemon
 * state: Not running", `session list` empty) with the companion app still
 * running from an earlier session. Validity's control bridge is a WS to that
 * COMPANION PROCESS, which outlives the daemon — so the bridge was connected,
 * the bridge fast-path acked a render, and `coldOpen` returned without ever
 * issuing `agent-device open` (the only call that opens a session). The
 * per-spec commands went out anyway: `react-native dismiss-overlay` →
 * SESSION_NOT_FOUND, `wait` → COMMAND_FAILED, `snapshot`/`screenshot` →
 * SESSION_NOT_FOUND, for 3m18s across SEVEN consecutive specs — every one of
 * them reported as blocked with `cause: unknown`, because the thrown
 * `Screenshot failed …` text matched no probe. The first `open` fired at
 * T+3m40s and every later spec worked.
 *
 * Two independent triggers, both conclusive:
 *   - `sessionEstablished === false` — the readiness gate ran and reported that
 *     no session was opened. Structural, not textual.
 *   - the error text carries {@link NO_SESSION_SIGNATURE} — the device itself
 *     said so, which also covers callers with no gate (an MCP capture, a
 *     thrown screenshot) and sessions that died mid-sweep.
 *
 * `undefined` for everything else. In particular a cold daemon ALONE is not a
 * diagnosis: agent-device starts it on demand and that is the normal first-run
 * state — flagging it would send developers to fix a machine that was fine.
 *
 * THE 2026-07-29 CORRECTION — why this used to be the loudest wrong answer in
 * the engine. During the Metro-decay collapse it fired for all ten native specs
 * at `confirmed`, telling the developer to run `agent-device open`, while
 * `agent-device appstate` AND `agent-device snapshot -i` both exited 0 against
 * that very session. Two separate defects, both closed here:
 *
 *  1. THE GATE IS AN INFERENCE, NOT AN OBSERVATION. `ready:false` means "this
 *     process did not get a 0 out of `agent-device open`" — nothing more. The
 *     `establishedSessions` registry is process-wide, so a session opened by an
 *     earlier CLI/MCP invocation in the same cwd is invisible to it, and an
 *     `open` that merely TIMED OUT against a live session looks identical to
 *     one that never happened. So the gate alone is now `suspected`; only a
 *     corroborating second observation (a cold daemon with no sessions on disk,
 *     or the device saying SESSION_NOT_FOUND itself) earns `confirmed`.
 *  2. CONTRADICTED EVIDENCE OUTRANKS IT. When the SAME diagnosis pass holds
 *     proof that a session-scoped command answered (see
 *     {@link sessionCommandsAnswered}), the gate's inference is disproven and
 *     this probe stays silent rather than sending the developer to a command
 *     that is already working. The device's own SESSION_NOT_FOUND still fires —
 *     but at `suspected`, saying out loud that the two observations disagree.
 */
export function detectNoNativeSession(
  openErrorText: string | undefined,
  opts: {
    sessionEstablished?: boolean;
    daemon?: DaemonProbe;
    /**
     * Did a session-scoped agent-device command ANSWER during this same pass?
     * `true` is disproof of the gate's inference; `false`/undefined mean "no
     * such evidence", which is the pre-existing behavior.
     */
    sessionAnswered?: boolean;
  } = {},
): EnvironmentDiagnosis | undefined {
  const answered = opts.sessionAnswered === true;
  const byGate = opts.sessionEstablished === false;
  const byText = Boolean(openErrorText && NO_SESSION_SIGNATURE.test(openErrorText));
  if (!byGate && !byText) return undefined;
  // The gate said "no session", the session answered. The gate is wrong, and
  // saying so anyway is the bug this branch exists to prevent.
  if (answered && !byText) return undefined;

  // A daemon with no sessions on disk corroborates the cold-start story; a
  // daemon that looks alive means the session was lost rather than never taken.
  // It also decides the CONFIDENCE of the gate-only trigger (see above).
  const cold =
    opts.daemon !== undefined &&
    (opts.daemon.state === 'not-running' || opts.daemon.state === 'no-state-dir') &&
    opts.daemon.sessionDirCount === 0;

  return {
    cause: 'no-native-session',
    symptom: byGate
      ? 'No agent-device session was open for this capture: `agent-device open` never established ' +
        `one${cold ? ', and the daemon has no sessions on disk (it was cold at the start of this run)' : ''}.`
      : `agent-device answered with no active session: ${firstLine(openErrorText!)}` +
        (answered
          ? ' — though another session-scoped command in this same capture DID answer, so the two ' +
            'observations disagree'
          : ''),
    detail:
      'agent-device requires an `open` before `snapshot`, `screenshot`, `wait` or any other ' +
      'session-scoped command ("Run open first"). Validity drives the device over its OWN control ' +
      'bridge — a WebSocket to the companion app — and that app process outlives the agent-device ' +
      'daemon, so a warm bridge is NOT evidence of a warm session. When the daemon is cold at the ' +
      'start of a sweep, the bridge can confirm a render while every command that reads EVIDENCE ' +
      '(the a11y snapshot, the screenshot, the paint cross-check) answers SESSION_NOT_FOUND. Nothing ' +
      'is scored against that, so criteria are withheld rather than judged on a screen no one could ' +
      'read. Recovery needs an `open` that actually SUCCEEDS: if `agent-device open` keeps failing ' +
      'while `snapshot`/`appstate` still answer, the session is not the problem and re-opening it ' +
      'will not help — check the `metro-decayed` signature instead.',
    fixCommand:
      'agent-device open <your-app-scheme>://   # run from the PROJECT ROOT (sessions are keyed by cwd)',
    // CONFIRMED only when something other than the gate says so: the device's
    // own no-session error, or a daemon that is demonstrably cold. A bare
    // `ready:false` is an inference about a registry this process owns, and it
    // has been observed false against a session that was answering.
    confidence: byText || cold ? 'confirmed' : 'suspected',
  };
}

/**
 * Did a session-scoped agent-device command ANSWER during this capture?
 *
 * The only session-liveness evidence the diagnosis already receives is the
 * a11y snapshot the capture read (`capture-native` passes it as `a11ySnapshot`
 * for the dev-surface probes). `AgentDeviceDriver.snapshot()` returns the
 * command's STDOUT, and agent-device prints its errors — SESSION_NOT_FOUND
 * included — on stderr, so non-empty stdout means the `snapshot` command
 * reached a session and came back. In `captureNative` it is strictly stronger
 * than that: the screenshot runs FIRST and throws on a non-zero exit, so a
 * capture that got as far as a snapshot answer had two session-scoped commands
 * succeed.
 *
 * Fails CLOSED in both directions that matter: an empty snapshot (the capture
 * swallows a throw into `''`) and a snapshot that itself carries the no-session
 * signature both mean "no evidence", which leaves every downstream probe
 * exactly as it was.
 */
export function sessionCommandsAnswered(a11ySnapshot: string | undefined): boolean {
  const snap = a11ySnapshot ?? '';
  if (snap.trim() === '') return false;
  if (NO_SESSION_SIGNATURE.test(snap)) return false;
  return true;
}

/** True only when the JSON answer parses AND carries an empty `sessions` array. */
export function sessionListEmpty(stdout: string | undefined): boolean {
  if (!stdout || stdout.trim() === '') return false;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object') return false;
    const sessions = (parsed as { sessions?: unknown }).sessions;
    return Array.isArray(sessions) && sessions.length === 0;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* probe: daemon health                                                        */
/* -------------------------------------------------------------------------- */

export type DaemonState = 'no-state-dir' | 'not-running' | 'unreadable' | 'dead-pid' | 'alive';

export interface DaemonProbe {
  state: DaemonState;
  pid?: number;
  version?: string;
  /**
   * Epoch-ms the RUNNING daemon started, from `daemon.json`'s `processStartTime`
   * (agent-device 0.20.1 writes e.g. `"Wed Jul 29 10:25:02 2026"`; 0.20.5 still
   * writes the field into `daemon.json` — re-checked 2026-08-06 — though its
   * exact formatting was not re-observed without a running daemon, which is
   * safe: an unparseable value is `undefined`, never a guess). This is the
   * session epoch every history-based heuristic must be scoped to: killing the
   * daemon is the first rung of the documented reset, so a daemon that started
   * four minutes ago means every capture logged before then belongs to a
   * different session. Absent when the field is missing or unparseable — in
   * which case the heuristics fall back to the log's own session split rather
   * than to a fabricated epoch.
   */
  processStartMs?: number;
  /** Claim files present under device-claims (they outlive a dead daemon). */
  claimCount: number;
  /**
   * Those same claim files, classified by their OWNER's liveness. Optional so a
   * hand-built probe literal (tests, callers that only care about the daemon
   * row) stays valid; absent is read as "not classified", never as "none".
   */
  claims?: DeviceClaim[];
  /** Session dirs present under sessions. */
  sessionDirCount: number;
}

/**
 * Parse `daemon.json`'s `processStartTime` into epoch-ms. agent-device writes
 * `Date.prototype.toString()`-ish text (`"Wed Jul 29 10:25:02 2026"`), which
 * `Date.parse` accepts; anything it does not is `undefined`, never a guess. A
 * FUTURE timestamp is rejected too: a clock skew that put the epoch ahead of
 * every row would silently empty the evidence base.
 */
export function parseDaemonStartTime(raw: unknown, now = Date.now()): number | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t > now) return undefined;
  return t;
}

/**
 * The session epoch to scope history-based heuristics to: the running daemon's
 * start time, or `undefined` when it cannot be read (no daemon, dead pid,
 * unparseable file). Only a LIVE daemon defines an epoch — a dead one is not
 * driving anything, and its start time would scope the evidence to a session
 * that has already ended.
 */
export function daemonEpochStartMs(probe: DaemonProbe): number | undefined {
  return probe.state === 'alive' ? probe.processStartMs : undefined;
}

export interface DaemonProbeOptions {
  /** Default `$HOME/.agent-device`. */
  stateDir?: string;
  fs?: DiagnosisFs;
  isPidAlive?: (pid: number) => boolean;
  /** Env the claims dir is resolved against (`$AGENT_DEVICE_CLAIMS_DIR`). */
  env?: NodeJS.ProcessEnv;
}

export function agentDeviceStateDir(home = homedir()): string {
  return resolve(home, '.agent-device');
}

/**
 * Read `daemon.json` + the two state dirs. NEVER throws: every unreadable path
 * lands on a state that produces no diagnosis, because "I could not read the
 * daemon file" is not evidence that anything is wrong.
 */
export function probeAgentDeviceDaemon(opts: DaemonProbeOptions = {}): DaemonProbe {
  const fs = opts.fs ?? realDiagnosisFs;
  const dir = opts.stateDir ?? agentDeviceStateDir();
  const isAlive = opts.isPidAlive ?? realIsPidAlive;
  const count = (sub: string): number => {
    try {
      return fs.readDir(resolve(dir, sub)).filter((n) => !n.startsWith('.')).length;
    } catch {
      return 0;
    }
  };

  // Claims are read (not counted) so every consumer sees WHOSE they are. Read
  // before the state-dir check because `$AGENT_DEVICE_CLAIMS_DIR` can point
  // them outside the state dir entirely, and a claim held there is still held.
  const claims = readDeviceClaims({
    stateDir: dir,
    fs,
    ...(opts.isPidAlive ? { isPidAlive: opts.isPidAlive } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  const claimCount = claims.length;

  let exists = false;
  try {
    exists = fs.exists(dir);
  } catch {
    exists = false;
  }
  if (!exists) {
    return { state: 'no-state-dir', claimCount, claims, sessionDirCount: 0 };
  }
  const sessionDirCount = count('sessions');

  let raw: string;
  try {
    raw = fs.readFile(resolve(dir, 'daemon.json'));
  } catch {
    // No daemon.json at all: the daemon simply is not running. Normal — it is
    // started on demand by the next agent-device call.
    return { state: 'not-running', claimCount, claims, sessionDirCount };
  }
  let pid: number | undefined;
  let version: string | undefined;
  let processStartMs: number | undefined;
  try {
    const parsed = JSON.parse(raw) as {
      pid?: unknown;
      version?: unknown;
      processStartTime?: unknown;
    };
    if (typeof parsed.pid === 'number') pid = parsed.pid;
    if (typeof parsed.version === 'string') version = parsed.version;
    processStartMs = parseDaemonStartTime(parsed.processStartTime);
  } catch {
    return { state: 'unreadable', claimCount, claims, sessionDirCount };
  }
  if (pid === undefined) {
    return { state: 'unreadable', version, processStartMs, claimCount, claims, sessionDirCount };
  }
  let alive = false;
  try {
    alive = isAlive(pid);
  } catch {
    // Cannot probe → assume alive, so an unprobeable host produces no diagnosis.
    alive = true;
  }
  return {
    state: alive ? 'alive' : 'dead-pid',
    pid,
    version,
    processStartMs,
    claimCount,
    claims,
    sessionDirCount,
  };
}

/**
 * A daemon that recorded a pid which is GONE, while its session/claim state is
 * still on disk. The next agent-device call restarts the daemon on top of that
 * orphaned state — which is how a phantom claim is born. Anything else (no
 * daemon.json, no leftover state, a live daemon) produces NO diagnosis.
 */
export function diagnoseDaemon(probe: DaemonProbe): EnvironmentDiagnosis | undefined {
  if (probe.state !== 'dead-pid') return undefined;
  if (probe.claimCount === 0 && probe.sessionDirCount === 0) return undefined;
  return {
    cause: 'daemon-unresponsive',
    symptom:
      `~/.agent-device/daemon.json points at pid ${probe.pid}, which is no longer running, but ` +
      `${probe.claimCount} device claim(s) and ${probe.sessionDirCount} session dir(s) are still on disk.`,
    detail:
      'The agent-device daemon died (or was killed) without releasing its state. The next call ' +
      'starts a fresh daemon on top of those orphaned claims, which then reject every `open` as ' +
      '"device already in use" by a session nothing owns — the deep link never lands, no render is ' +
      'confirmed, and every criterion is withheld. Clearing the state costs nothing: it is ' +
      'per-session scratch, rebuilt on the next open.',
    fixCommand: CLEAR_AGENT_DEVICE_STATE,
    confidence: 'confirmed',
  };
}

/* -------------------------------------------------------------------------- */
/* probe: foreign Metro on the companion port                                  */
/* -------------------------------------------------------------------------- */

/** A process holding the companion Metro port, as far as lsof/ps could see. */
export interface MetroPortOwner {
  pid: number;
  /** Process group — a Validity spawn is its own group leader (see SpawnedMetro). */
  pgid?: number;
  /** `ps -p <pid> -o command=` output, when readable. */
  command?: string;
  /** Working directory (`lsof -a -p <pid> -d cwd`), when readable. */
  cwd?: string;
}

export interface ForeignMetroInput {
  owners: MetroPortOwner[];
  /** pid/pgid Validity recorded for the Metro IT spawned (see readMetroOwnerMarker). */
  ownerMarker?: { pid: number; pgid?: number } | null;
  /** The companion app dir Validity's Metro is spawned in (its cwd). */
  appDir?: string;
  port?: number;
}

/**
 * Is the companion port held by a Metro that Validity did NOT start?
 *
 * A hand-started `expo start` on 8082 serves the USER's app bundle to the
 * companion dev-client: the app comes up blank, every render goes unconfirmed,
 * and it looks exactly like a code bug (this cost a full debugging session).
 *
 * Two independent identification signals, either of which means "ours":
 *   - the recorded owner marker matches by pid or process group;
 *   - the process's cwd is the companion appDir (Validity spawns Metro there;
 *     a hand-started one runs from the project root).
 *
 * When NEITHER signal is available the answer is `undefined` — unknown, never
 * flagged. When the cwd could not be read the verdict degrades to 'suspected',
 * because a marker alone can be stale (a Metro started by an older Validity, or
 * on the legacy no-contentHash path, records nothing).
 */
/**
 * Command lines that could plausibly BE a JS bundler. A port holder that is not
 * one of these is not a "foreign Metro" — it is something else entirely, and
 * telling a developer to kill it would be worse than saying nothing.
 */
const BUNDLER_COMMAND_RE = /\b(node|expo|metro|bun|deno|npx|yarn|pnpm)\b/i;

export function detectForeignMetro(input: ForeignMetroInput): EnvironmentDiagnosis | undefined {
  const port = input.port ?? COMPANION_METRO_PORT;
  // A readable command line that is clearly not a bundler disqualifies the
  // owner; an unreadable one is kept (unknown, judged by the identity signals
  // below).
  const owners = input.owners.filter((o) => !o.command || BUNDLER_COMMAND_RE.test(o.command));
  if (owners.length === 0) return undefined;

  const marker = input.ownerMarker ?? null;
  const appDir = input.appDir;
  const cwdReadable = owners.some((o) => typeof o.cwd === 'string' && o.cwd !== '');
  if (!marker && (!appDir || !cwdReadable)) return undefined; // no signal → no claim

  const ours = owners.some((o) => {
    if (marker && (o.pid === marker.pid || (o.pgid !== undefined && o.pgid === marker.pid)))
      return true;
    if (appDir && o.cwd && sameDir(o.cwd, appDir)) return true;
    return false;
  });
  if (ours) return undefined;

  const who = owners
    .map(
      (o) =>
        `pid ${o.pid}${o.command ? ` (${o.command.trim()})` : ''}${o.cwd ? ` [cwd ${o.cwd}]` : ''}`,
    )
    .join('; ');
  return {
    cause: 'foreign-metro',
    symptom: `Port ${port} — the companion Metro port — is held by a process Validity did not start: ${who}.`,
    detail:
      'Validity owns the companion bundler: it spawns Metro in the generated companion app dir, ' +
      'gates it on a contentHash so a stale transform cache cannot survive, and strips CI flags so ' +
      'the file watcher stays on. A Metro started by hand on this port serves a DIFFERENT bundle to ' +
      'the companion dev-client — typically the host app, which has no Validity registry in it — so ' +
      'the app comes up blank, no render is ever confirmed, and the result is indistinguishable from ' +
      'a broken component. Verdicts are withheld rather than scored against that screen.',
    fixCommand:
      `kill ${owners.map((o) => o.pid).join(' ')}   # then re-run; Validity restarts Metro itself\n` +
      `# never run \`expo start\` by hand on port ${port} — the companion Metro is Validity-managed`,
    confidence: cwdReadable ? 'confirmed' : 'suspected',
  };
}

/**
 * Is `cwd` the companion app dir? Deliberately NOT a strict string compare: on
 * macOS the same directory is reachable as both `/var/…` and `/private/var/…`,
 * and a project reached through a symlink reports a different absolute path
 * than the one Validity computed (the exact class of bug that once made Vite
 * serve entry.tsx raw). A trailing-segment match on `.validity/native-app` is
 * symlink-immune and specific enough: no bundler but Validity's runs there —
 * and being WRONG here would flag a working setup, the one outcome this module
 * must never produce.
 */
function sameDir(cwd: string, appDir: string): boolean {
  const norm = (s: string): string => s.replace(/\/+$/, '');
  if (norm(cwd) === norm(appDir)) return true;
  const tail = norm(appDir).split('/').slice(-2).join('/');
  return tail.length > 0 && norm(cwd).endsWith(`/${tail}`);
}

/* -------------------------------------------------------------------------- */
/* probe: an Expo dev surface is what the camera saw                           */
/* -------------------------------------------------------------------------- */

/**
 * Dev-menu anchors, duplicated here on purpose.
 *
 * The authoritative list is `DEV_MENU_ANCHOR_LABELS` in agent-device-driver,
 * and importing it would close an import CYCLE (the driver imports this module
 * to attach diagnoses). The drift that duplication risks is pinned by a test
 * asserting this set stays a subset of the driver's — the coupling is to Expo's
 * copy either way, and a silent divergence between the two lists would be worse
 * than the duplication.
 *
 * SPECIFIC anchors only: developer-tooling copy no product screen renders. The
 * driver's generic tier ('Go home') is deliberately absent, because here a
 * false positive would name the WRONG cause on a working app, and one specific
 * anchor is already conclusive.
 */
export const DEV_MENU_DIAGNOSIS_ANCHORS = [
  'performance monitor',
  'element inspector',
  'open devtools',
  'open js debugger',
  'open react devtools',
  'open react native dev menu',
];

/**
 * Dev-LAUNCHER anchors — the server-picker home screen, a different state from
 * the menu: the app is running but no Validity bundle was ever loaded, so there
 * is nothing to render, not something covering what rendered.
 */
export const DEV_LAUNCHER_DIAGNOSIS_ANCHORS = [
  'fetch development servers',
  'enter url manually',
  'development servers',
  'recently opened',
];

/**
 * Android foreground-activity signatures for the dev-launcher home screen —
 * available where the a11y labels are not (an `adb shell dumpsys activity`
 * read, or agent-device's own status output).
 */
export const DEV_LAUNCHER_ACTIVITY_RE =
  /DevLauncher(Activity)?|expo\.modules\.devlauncher|expo\.modules\.devmenu\.DevMenuActivity/i;

/**
 * The dev-launcher signature that has NO a11y labels to match — the one the
 * probe was missing on 2026-07-29.
 *
 * `agent-device snapshot -i` prefixes its answer with the page it read, and
 * during the whole Metro-decay collapse that line was
 *
 *     Page: <scheme>://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082
 *     Snapshot: 0 nodes
 *     Interactive snapshot is empty after filtering 38 raw Android nodes.
 *
 * i.e. the dev-client's own control URL with an empty interactive tree. None of
 * {@link DEV_LAUNCHER_DIAGNOSIS_ANCHORS} can match that (there are no labelled
 * nodes to match), which is exactly why `dev-launcher-home` never fired for the
 * state it describes.
 */
export const DEV_LAUNCHER_PAGE_RE = /^\s*Page:[ \t]*\S*expo-development-client\b/im;

/**
 * Interactive-node shape agent-device prints (`@e12 [button] "Save"`). Same
 * regex `captureNative`'s blind-evidence demotion uses, deliberately: the two
 * must agree on what "the tree was empty" means.
 */
const INTERACTIVE_NODE_RE = /@e\d+\s*\[[^\]]*\]/;

/**
 * A snapshot that ANSWERED but described nothing interactive. Distinct from a
 * missing snapshot (`''`), which is "cannot tell" and yields false.
 */
export function snapshotIsBlank(snapshot: string | undefined): boolean {
  const snap = snapshot ?? '';
  if (snap.trim() === '') return false;
  return !INTERACTIVE_NODE_RE.test(snap);
}

/** Which of `anchors` the snapshot's quoted node labels match. */
function matchAnchors(snapshot: string, anchors: string[]): string[] {
  const wanted = anchors.map((a) => a.toLowerCase());
  const present = new Set<string>();
  for (const line of snapshot.split('\n')) {
    const labelMatch = line.match(/"((?:[^"\\]|\\.)*)"/);
    const label = (labelMatch?.[1] ?? '').replace(/\\(.)/g, '$1').toLowerCase();
    if (!label) continue;
    for (const a of wanted) if (label.includes(a)) present.add(a);
  }
  return [...present];
}

export interface DevSurfaceInput {
  /** The a11y snapshot the capture actually read. */
  snapshot?: string;
  /** Foreground activity/component, when the caller has one (Android). */
  foregroundActivity?: string;
  platform?: 'ios' | 'android';
}

/**
 * Was the screen under the camera an Expo DEV SURFACE rather than the app?
 *
 * Two states, both observed on 2026-07-29 and both previously misattributed:
 *
 *  - a modal dev MENU covering a perfectly good render was diagnosed
 *    `session-decay`, and the fix printed was a full emulator reset;
 *  - the dev-LAUNCHER home screen (no bundle loaded at all) was diagnosed
 *    `render-failure`, pointing at the component.
 *
 * Both are structurally visible in evidence the diagnosis already receives, and
 * neither has anything to do with the component or the session's age. The
 * launcher is checked FIRST: its anchors are unambiguous, and when a launcher
 * screen is up the menu question is moot.
 *
 * PURE and CONFIRMED — an anchor match is the signature itself. No snapshot, or
 * a snapshot with none of the anchors, yields nothing.
 */
export function detectDevSurface(input: DevSurfaceInput): EnvironmentDiagnosis | undefined {
  const snapshot = input.snapshot ?? '';
  const activity = input.foregroundActivity ?? '';
  const launcherLabels = snapshot ? matchAnchors(snapshot, DEV_LAUNCHER_DIAGNOSIS_ANCHORS) : [];
  const launcherActivity = activity !== '' && DEV_LAUNCHER_ACTIVITY_RE.test(activity);
  // The label-less launcher (see DEV_LAUNCHER_PAGE_RE). PAIRED with an empty
  // interactive tree on purpose: the page line can legitimately still name the
  // dev-client control URL on a device that went on to render the target, so
  // the URL alone must never convict. No nodes AND the dev-client page is the
  // state that was captured live, and it cannot describe a painted screen.
  const launcherPage = DEV_LAUNCHER_PAGE_RE.test(snapshot) && snapshotIsBlank(snapshot);
  if (launcherLabels.length > 0 || launcherActivity || launcherPage) {
    const evidence = launcherLabels.length
      ? `the a11y tree shows the dev-launcher home screen (${launcherLabels.map((l) => `"${l}"`).join(', ')})`
      : launcherActivity
        ? `the foreground activity is the dev launcher (${activity.trim().slice(0, 120)})`
        : 'the snapshot reports the expo-development-client page with no interactive nodes at all';
    return {
      cause: 'dev-launcher-home',
      symptom: `${evidence} — the Validity bundle was never loaded on this device.`,
      detail:
        'The companion is an expo-dev-client build, and this is its SERVER PICKER, not the app: ' +
        'nothing of the target was ever on screen. Whatever was captured is the launcher, so no ' +
        'criterion could be resolved against the component and none was — this is not evidence ' +
        'the component is wrong. It happens when the dev-client control link never landed (the ' +
        'deep link was swallowed, or Metro was not serving the companion bundle when it did).',
      fixCommand:
        'validity browse --native   # re-issues the dev-client control link, then re-run verify\n' +
        '# never start Metro by hand on the companion port — Validity manages that bundler',
      confidence: 'confirmed',
    };
  }
  const menuLabels = snapshot ? matchAnchors(snapshot, DEV_MENU_DIAGNOSIS_ANCHORS) : [];
  if (menuLabels.length > 0) {
    return {
      cause: 'dev-menu-open',
      symptom:
        `the Expo dev menu was open over the app when this capture was taken — the a11y tree ` +
        `contains ${menuLabels.map((l) => `"${l}"`).join(', ')}.`,
      detail:
        'expo-dev-menu opens itself on EVERY React-context init while `isOnboardingFinished` is ' +
        'false, which on an installer-provisioned companion it always is (no human ever taps ' +
        'through the onboarding sheet). It is a MODAL bottom sheet, so it takes the accessibility ' +
        'tree with it: the per-navigation render marker is not visible underneath it and neither ' +
        'is any of the app, which is why the render came back unconfirmed. The app itself may be ' +
        'rendering perfectly — this is an occlusion, not a decayed session and not a broken ' +
        'component, and resetting the device would not change it.',
      fixCommand:
        '# tap through the expo-dev-menu onboarding sheet ONCE on the device (it then stops auto-opening)\n' +
        'validity install-wizard --non-interactive   # or rebuild the companion if it predates the bridge dismissal',
      confidence: 'confirmed',
    };
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* probe: an Android ANR dialog is covering the app                            */
/* -------------------------------------------------------------------------- */

/**
 * The ANR dialog's title copy. Android has shipped both contractions across
 * versions/OEM skins ("isn't responding" on AOSP/Pixel, "is not responding" on
 * some others); the a11y label carries the app name in front ("Pixel Launcher
 * isn't responding"), so this is matched as a substring.
 */
export const ANR_TITLE_ANCHORS = ["isn't responding", 'is not responding'];

/**
 * The dialog's buttons, as corroboration. "wait" alone would false-positive on
 * product copy ("Waiting for…"), which is why detection requires a TITLE anchor
 * AND a button anchor, not a count of either.
 */
export const ANR_BUTTON_ANCHORS = ['close app', 'wait'];

/**
 * Was an Android "app isn't responding" (ANR) system dialog what the camera
 * saw?
 *
 * Observed 2026-07-30 on a long-lived emulator: "Pixel Launcher isn't
 * responding" sat modally OVER a successfully rendered app. Like the dev menu,
 * the dialog takes the accessibility tree with it — the render marker is not
 * visible underneath, the render never confirms, and (before this probe) the
 * diagnosis fell through to render-failure's "every probe came back clean,
 * suspect the component", which points the user at exactly the wrong thing.
 * The ANR'd process is usually not even the app under test (a launcher or
 * System UI wedged by a starved emulator), and `adb reboot` was the measured
 * heal.
 *
 * PURE and CONFIRMED, same posture as {@link detectDevSurface}: requires a
 * title anchor AND a button anchor in the same snapshot, so neither product
 * copy containing "wait" nor a headline containing "responding" can convict
 * alone. Android-only by construction — iOS has no ANR dialog, so a platform
 * known to be 'ios' answers nothing.
 */
export function detectAnrDialog(input: DevSurfaceInput): EnvironmentDiagnosis | undefined {
  if (input.platform === 'ios') return undefined;
  const snapshot = input.snapshot ?? '';
  if (!snapshot) return undefined;
  const title = matchAnchors(snapshot, ANR_TITLE_ANCHORS);
  if (title.length === 0) return undefined;
  const buttons = matchAnchors(snapshot, ANR_BUTTON_ANCHORS);
  if (buttons.length === 0) return undefined;
  return {
    cause: 'anr-dialog',
    symptom:
      `an Android "isn't responding" (ANR) system dialog was on screen when this capture was ` +
      `taken — the a11y tree contains ${[...title, ...buttons].map((l) => `"${l}"`).join(', ')}.`,
    detail:
      'The ANR dialog is MODAL, so it owns the accessibility tree: the render marker is not ' +
      'visible underneath it and neither is the app, which is why the render came back ' +
      'unconfirmed. The app itself may have rendered perfectly, and the process that ANRed is ' +
      'often not the app at all (a launcher or System UI on a long-lived, resource-starved ' +
      'emulator). This is an occlusion by the OS, not a broken component — do not debug the ' +
      'component for this.',
    fixCommand:
      'adb reboot   # reboot the emulator; the dialog does not stay dismissed on a wedged device\n' +
      '# then re-run the verify',
    confidence: 'confirmed',
  };
}

/* -------------------------------------------------------------------------- */
/* probe: bridge bound to the wrong platform's device                          */
/* -------------------------------------------------------------------------- */

/** What the bridge observed about the identity of the device on the other end. */
export interface BridgePlatformMismatch {
  /** The platform THIS run is driving. */
  expected: 'ios' | 'android';
  /** The platform the connected device (or the port holder's device) reported. */
  actual: string;
  /** The device's stable id, when it announced one. */
  deviceId?: string;
  /** 'hello' — a device attached to us; 'delegated-status' — the process holding the port. */
  source: 'hello' | 'delegated-status';
  /** The bridge port involved. */
  port?: number;
}

/**
 * The bridge is talking to a device on the OTHER platform.
 *
 * Observed 2026-07-29: a validity-mcp process left over from a previous day
 * still held bridge port 8083 with an ANDROID device attached. An iOS run
 * delegated its navigations through it, the Android companion acked every one
 * of them, and the iOS simulator under test never attached a thing. Every
 * criterion came back unverifiable and every probe read clean, because from the
 * host's point of view the bridge was healthy — it was simply pointed at
 * another device.
 *
 * PURE and CONFIRMED: both platform strings are self-reported identity, not an
 * inference. Nothing is returned when either side is unknown.
 */
export function detectBridgePlatformMismatch(
  mismatch: BridgePlatformMismatch | undefined | null,
): EnvironmentDiagnosis | undefined {
  if (!mismatch) return undefined;
  const actual = mismatch.actual.trim().toLowerCase();
  if (actual === '' || actual === mismatch.expected) return undefined;
  const port = mismatch.port ?? COMPANION_BRIDGE_PORT;
  const who =
    mismatch.source === 'delegated-status'
      ? `the process holding bridge port ${port}`
      : 'the companion connected to this bridge';
  return {
    cause: 'bridge-platform-mismatch',
    symptom:
      `This run drives ${mismatch.expected}, but ${who} reports a ${actual} device` +
      `${mismatch.deviceId ? ` (${mismatch.deviceId})` : ''}.`,
    detail:
      `Port ${port} is a single-bind resource shared by the CLI and the MCP server, so a Validity ` +
      'process left running from an earlier session — even one from another day, on another ' +
      'platform — keeps answering on it. Navigations then hop through THAT bridge and are acked by ' +
      'THAT device: the renders look confirmed on the wire while the device under test never ' +
      'attaches anything. Verdicts are withheld because the screen that answered is not the screen ' +
      'being verified.',
    fixCommand:
      `lsof -ti tcp:${port} -sTCP:LISTEN   # then kill the stale validity CLI/MCP holding it, and re-run\n` +
      '# restart your MCP host afterwards so it reconnects on a clean bridge',
    confidence: 'confirmed',
  };
}

/* -------------------------------------------------------------------------- */
/* probe: session decay                                                        */
/* -------------------------------------------------------------------------- */

export interface DecayThresholds {
  /** Unconfirmed renders in a row before the session itself is suspected. */
  minConsecutiveUnconfirmed: number;
  /**
   * Captures the CURRENT epoch must contain before a trailing unconfirmed
   * streak may be read as decay at all.
   *
   * Decay is a property of AGE. A session that has taken four captures has not
   * aged into anything, so its two unconfirmed renders are a cold-start problem
   * (or a wedged runner, or a dev menu, all of which have their own probes) —
   * never "your emulator has degraded, reset it". On 2026-07-29 this fired on a
   * four-minute-old daemon with a single `open`, and on a freshly cold-booted
   * emulator: in both the streak was inherited from rows written BEFORE the
   * reset, which epoch scoping now excludes; this floor is the second guard, so
   * a genuinely fresh epoch cannot be called decayed either.
   *
   * Cheap to satisfy for the real thing: the decayed sweeps that motivated this
   * probe run 13 specs and dozens of captures.
   */
  minCapturesForStreak: number;
  /** Captures needed before the p95 trend is allowed to mean anything. */
  minCapturesForTrend: number;
  /** Recent p95 must exceed this AND the growth factor — a fast session is never flagged. */
  p95FloorMs: number;
  /** How much slower than the session's opening baseline counts as "materially". */
  p95GrowthFactor: number;
}

export const DEFAULT_DECAY_THRESHOLDS: DecayThresholds = {
  // TWO in a row, not one: a single unconfirmed render is ordinary (a slow
  // paint, one bad route) and flagging it would send developers to reset a
  // working emulator. The decay signature is that they never come back.
  minConsecutiveUnconfirmed: 2,
  minCapturesForStreak: 4,
  minCapturesForTrend: 20,
  p95FloorMs: WARN_P95_MS,
  p95GrowthFactor: 1.5,
};

/**
 * Session-age decay, from the metrics log — always 'suspected', never
 * 'confirmed'.
 *
 * That is not hedging. Which layer decays is genuinely unknown: the same build
 * and specs score 33 pass on a cold emulator and, after ~2h, ack every bridge
 * navigate while the RN root never attaches — with nothing in logcat. The
 * daemon, the emulator's RN surface and Metro were always reset together, so no
 * one has isolated it. Claiming a confirmed cause here would be the false-green
 * of diagnosis.
 *
 * ONE LAYER HAS SINCE BEEN ISOLATED, and it is handled ABOVE this probe rather
 * than inside it: when the session commands are demonstrably healthy and the
 * screen is the dev-client launcher, the decaying layer is the companion METRO
 * — see {@link detectMetroDecay} for the experiment and for the cheap remedy
 * (a Validity-managed bundler restart, not an emulator cold boot). This probe
 * stays as written for every OTHER shape of age-related failure, where the
 * layer is still unknown and the full reset is still the only known remedy.
 *
 * ALSO LEARNED THERE: `slowing` cannot catch the Metro layer. Across both
 * collapses snapshot p95 stayed in its healthy band (~500ms) because the
 * snapshot succeeds — it is reading a blank launcher fast. p95 growth is a real
 * signal for a wedged/loaded device, but it is NOT a general decay detector,
 * and the `streak` half is what fires on the failures seen so far.
 *
 * THE HEALTH PASSED IN MUST BE EPOCH-SCOPED. `summarizeSessionHealth` already
 * splits on idle gaps and host-process restarts; supply its `epochStartMs` with
 * the daemon's start time (see {@link daemonEpochStartMs}) so a reset that
 * happened minutes ago also zeroes it. Counting pre-reset captures is how this
 * probe came to recommend a reset that had just been performed.
 */
export function detectSessionDecay(
  health: SessionHealth,
  opts: {
    platform?: 'ios' | 'android';
    avdName?: string;
    deviceName?: string;
    thresholds?: Partial<DecayThresholds>;
  } = {},
): EnvironmentDiagnosis | undefined {
  const t = { ...DEFAULT_DECAY_THRESHOLDS, ...opts.thresholds };
  const streak =
    health.consecutiveUnconfirmed >= t.minConsecutiveUnconfirmed &&
    health.count >= t.minCapturesForStreak;
  const baseline = health.openingP95SnapshotMs;
  const recent = health.recentP95SnapshotMs;
  const slowing =
    health.count >= t.minCapturesForTrend &&
    baseline !== undefined &&
    baseline > 0 &&
    recent !== undefined &&
    recent > t.p95FloorMs &&
    recent >= baseline * t.p95GrowthFactor;
  if (!streak && !slowing) return undefined;

  const parts: string[] = [];
  if (streak) {
    parts.push(
      `the last ${health.consecutiveUnconfirmed} captures in this session all rendered ` +
        'unconfirmed (the device acked the navigate, the view never attached)',
    );
  }
  if (slowing) {
    parts.push(
      `snapshot p95 has grown from ${baseline}ms at the start of this session to ${recent}ms ` +
        `over ${health.count} captures`,
    );
  }
  return {
    cause: 'session-decay',
    symptom: `${parts.join('; ')}${health.openCallCount ? ` (${health.openCallCount} device opens so far this session)` : ''}${health.firstCaptureTs ? `, measured over captures since ${health.firstCaptureTs}` : ''}.`,
    detail:
      'This is the signature of device-session decay: with the same build and the same specs, a ' +
      'cold emulator verifies fine and an aged session stops attaching the RN root while still ' +
      'acking every navigate — nothing appears in logcat. WHICH layer decays (the agent-device ' +
      'daemon, the emulator, or Metro) is not yet known, so this is a suspicion, not a verdict; the ' +
      'reset below is the one remedy that has worked every time. Verdicts are withheld while it ' +
      'lasts because the screen under the camera is not the component that was requested.',
    fixCommand: fullSessionResetCommand({
      platform: opts.platform,
      avdName: opts.avdName,
      deviceName: opts.deviceName,
    }),
    confidence: 'suspected',
  };
}

/* -------------------------------------------------------------------------- */
/* probe: the companion Metro has decayed (the isolated decay layer)           */
/* -------------------------------------------------------------------------- */

export interface MetroDecayThresholds {
  /** Trailing unconfirmed renders before an aged session is suspected. */
  minConsecutiveUnconfirmed: number;
  /** Captures the epoch must hold before that streak may mean "aged". */
  minCaptures: number;
  /**
   * Accumulated device opens that on their own count as "this Metro has been
   * driven hard". The collapses were measured at roughly 40-50 opens past a
   * restart, and the degraded sweeps themselves burn ~30 opens (three tries per
   * spec), so this is a corroborating signal, never the only one.
   */
  minOpenCalls: number;
}

export const DEFAULT_METRO_DECAY_THRESHOLDS: MetroDecayThresholds = {
  minConsecutiveUnconfirmed: DEFAULT_DECAY_THRESHOLDS.minConsecutiveUnconfirmed,
  minCaptures: DEFAULT_DECAY_THRESHOLDS.minCapturesForStreak,
  minOpenCalls: 25,
};

export interface MetroDecayInput {
  /** The render confirmation this capture got. */
  renderStatus?: 'confirmed' | 'unconfirmed' | 'failed';
  /** The a11y snapshot the capture actually read. */
  a11ySnapshot?: string;
  /** Foreground activity/component (Android), when the caller has one. */
  foregroundActivity?: string;
  /** Proof that a session-scoped command answered — see {@link sessionCommandsAnswered}. */
  sessionAnswered?: boolean;
  /** Epoch-scoped session health, for the accumulated-driving corroboration. */
  health?: SessionHealth;
  /** Companion app dir, so the fix names the real marker path. */
  appDir?: string;
  thresholds?: Partial<MetroDecayThresholds>;
}

/**
 * The companion Metro has aged into serving nothing — the decay layer, isolated.
 *
 * PROVENANCE (2026-07-29 decay-isolation experiment, 18 sweeps of 13 specs
 * against one continuously-running emulator):
 *
 *   healthy 37,38,37,37 → COLLAPSE 4/0/36 → agent-device reset alone: still 4
 *   → Metro reset alone: 37 → healthy 37,38,37,38 → partial 27 → COLLAPSE 4
 *   → Metro reset alone: 38 → 36.
 *
 * Metro was the ONLY layer whose reset ever recovered the sweep, and it
 * recovered it twice, immediately and completely. Killing the agent-device
 * daemon and wiping `sessions` + `device-claims` mid-collapse changed nothing
 * across two further sweeps. The emulator was never reset at all and spanned
 * both states, so it cannot be the variable. Metro RSS SHRANK across a full
 * cycle (45.0MB → 40.4MB): whatever accumulates is state, not heap.
 *
 * THE SIGNATURE, all of it captured live while degraded:
 *   - the deep link is acked and the RN root never attaches (`unconfirmed`);
 *   - the screen is the dev-client launcher / a tree with no interactive nodes
 *     (`Page: …expo-development-client…`, `Snapshot: 0 nodes`, 38 raw);
 *   - every session-scoped command is HEALTHY — `appstate` and `snapshot -i`
 *     both exit 0, the app process and MainActivity are foreground, and Metro's
 *     own `/status` answers 200. Nothing looks broken from the host.
 *
 * WHAT IS DELIBERATELY NOT IN THE SIGNATURE: snapshot p95 growth. During the
 * collapse snapshots stayed FAST (~500ms) because the snapshot succeeds — it is
 * just reading a blank launcher. {@link detectSessionDecay}'s `slowing` probe
 * therefore cannot see this state, and keying on p95 here would make the probe
 * silent exactly when it is needed.
 *
 * 'suspected', not 'confirmed': the remedy is proven, the mechanism inside
 * Metro is not. The remedy is also cheap and non-destructive — one bundler
 * restart — which is what makes a suspicion an acceptable thing to act on here,
 * unlike the emulator cold-boot {@link detectSessionDecay} recommends.
 *
 * PURE. Requires an aging signal from the metrics log: without one, a first
 * cold launch that parks on the launcher would be called decay, and the honest
 * answer for that is `dev-launcher-home`.
 */
export function detectMetroDecay(input: MetroDecayInput): EnvironmentDiagnosis | undefined {
  const t = { ...DEFAULT_METRO_DECAY_THRESHOLDS, ...input.thresholds };
  // ACKED, NEVER ATTACHED. A device-reported `failed` ack is the companion
  // rejecting the target, which is a different (and already-named) thing.
  if (input.renderStatus !== 'unconfirmed') return undefined;
  // The session must be demonstrably HEALTHY — that is what separates this from
  // no-native-session, and it is the observation the old ranking threw away.
  if (input.sessionAnswered !== true) return undefined;

  const snapshot = input.a11ySnapshot ?? '';
  if (snapshot.trim() === '') return undefined;
  // A modal dev MENU is an occlusion over an app that may be rendering fine;
  // restarting Metro would not move it. That state has its own cause.
  if (matchAnchors(snapshot, DEV_MENU_DIAGNOSIS_ANCHORS).length > 0) return undefined;

  const launcher =
    matchAnchors(snapshot, DEV_LAUNCHER_DIAGNOSIS_ANCHORS).length > 0 ||
    DEV_LAUNCHER_PAGE_RE.test(snapshot) ||
    (input.foregroundActivity !== undefined &&
      input.foregroundActivity !== '' &&
      DEV_LAUNCHER_ACTIVITY_RE.test(input.foregroundActivity));
  const blank = snapshotIsBlank(snapshot);
  if (!launcher && !blank) return undefined;

  const health = input.health;
  if (!health) return undefined;
  const streak =
    health.consecutiveUnconfirmed >= t.minConsecutiveUnconfirmed && health.count >= t.minCaptures;
  const driven = health.openCallCount >= t.minOpenCalls;
  if (!streak && !driven) return undefined;

  const surface = launcher
    ? 'the screen under the camera is the expo-dev-client launcher, not the target'
    : 'the accessibility tree answered with no interactive nodes at all';
  const aging = [
    streak
      ? `the last ${health.consecutiveUnconfirmed} of ${health.count} captures in this session all ` +
        'went unconfirmed'
      : undefined,
    driven ? `${health.openCallCount} device opens have accumulated on this bundler` : undefined,
  ].filter(Boolean);

  return {
    cause: 'metro-decayed',
    symptom:
      `The navigate was acked and the React Native root never attached: ${surface}, while ` +
      'agent-device itself is answering normally (the snapshot came back) — ' +
      `${aging.join('; ')}${health.firstCaptureTs ? `, measured over captures since ${health.firstCaptureTs}` : ''}.`,
    detail:
      'This is the isolated signature of a DECAYED COMPANION METRO. An 18-sweep isolation run on ' +
      '2026-07-29 held the emulator and the agent-device daemon constant and reset one layer at a ' +
      'time: killing the daemon and wiping its sessions/claims mid-collapse recovered nothing across ' +
      'two further sweeps, while restarting Metro recovered the sweep immediately and completely — ' +
      'twice (4/0/36 back to 37/0/3 each time). Metro keeps serving /status 200 and the app keeps ' +
      'running; it simply stops delivering a bundle the dev-client will attach, so every navigate is ' +
      'acked and nothing paints. Note that snapshot p95 does NOT grow while this lasts (the snapshot ' +
      'succeeds — it is reading a blank launcher), which is why the timing-based decay probe cannot ' +
      'see it. Verdicts are withheld because the screen under the camera is the launcher, not the ' +
      'component. Validity RESTARTS the bundler itself when it sees this — once per run, and once ' +
      'per collapse episode — and retries the spec; when that restart is what you are reading ' +
      'about, the `already attempted` line above says so and the command below has already been ' +
      'run on your behalf.',
    fixCommand: metroManagedRestartCommand(input.appDir),
    confidence: 'suspected',
  };
}

/* -------------------------------------------------------------------------- */
/* probe: stale agent-device / device availability, from error text            */
/* -------------------------------------------------------------------------- */

/** The exit-127 signature of an agent-device too old to open a deep link. */
export const STALE_OPEN_SIGNATURE = /\/system\/bin\/sh: -p: inaccessible/i;

const NO_DEVICE_RE = /no (booted |connected |available )?device|device not found|NO_DEVICE/i;
const BOUND_SESSION_RE = /session "?([^"]*)"? is bound to (ios|android) device/i;

/**
 * Device-side reasons an open cannot land, read off the error text the CLI
 * already returned. Text-only and conservative: an unrecognized error yields
 * nothing.
 */
export function detectDeviceNotReady(
  openErrorText: string | undefined,
  platform?: 'ios' | 'android',
): EnvironmentDiagnosis | undefined {
  if (!openErrorText) return undefined;
  const bound = openErrorText.match(BOUND_SESSION_RE);
  if (bound) {
    return {
      cause: 'device-not-ready',
      symptom: `agent-device rejected the open: the session is still bound to a ${bound[2]} device.`,
      detail:
        'Sessions are keyed by CWD and stay bound to the platform they were opened against, so ' +
        'switching platforms mid-session leaves every open addressed to the wrong device. Nothing ' +
        'renders on the device under test, so no criterion can be scored. Close the session from the ' +
        'PROJECT ROOT — closing from another directory closes a different session.',
      fixCommand: 'agent-device close   # run from the project root',
      confidence: 'confirmed',
    };
  }
  if (NO_DEVICE_RE.test(openErrorText)) {
    return {
      cause: 'device-not-ready',
      symptom: `agent-device could not find a device to open on: ${firstLine(openErrorText)}`,
      detail:
        'No booted simulator/emulator was reachable, so the deep link had nowhere to land and no ' +
        'render could be confirmed. Every criterion for this spec is withheld rather than scored ' +
        'against a screen that does not exist.',
      fixCommand:
        platform === 'ios'
          ? 'xcrun simctl boot <device>   # or open a Simulator in Xcode'
          : 'emulator -avd <avd>   # or start one from Android Studio; then `adb devices`',
      confidence: 'confirmed',
    };
  }
  return undefined;
}

/**
 * A stale agent-device, either from a version the caller already probed
 * (confirmed) or from the exit-127 signature alone (suspected).
 *
 * The signature stays SUSPECTED, and the reason was re-established on 0.20.3
 * (2026-07-30) rather than inherited: that exact `-p: inaccessible or not
 * found` text is ALSO what a current, perfectly up-to-date agent-device prints
 * whenever the opened URL contains an `&`, because the device-side shell splits
 * the line there (re-verified byte-identical on 0.20.3; NOT re-run on 0.20.5, which needs a
 * device — re-verify on a 0.20.5 device run, and note that the conclusion here
 * is unaffected either way, since it only ever downgrades this to a
 * suspicion). Validity already routes around that
 * with `deviceShellQuote`, so seeing the signature after the fallback ALSO
 * failed is evidence about the install — but on its own it is at least as
 * likely to be the still-open upstream quoting bug as a stale binary, and
 * `confidence: 'confirmed'` would be a lie. Only a version READ below the floor
 * upgrades this to confirmed.
 */
export function detectStaleAgentDevice(
  openErrorText: string | undefined,
  opts: { version?: string; outdated?: boolean; minVersion?: string } = {},
): EnvironmentDiagnosis | undefined {
  const floor = opts.minVersion ?? 'the version Validity requires';
  if (opts.outdated) {
    return {
      cause: 'stale-agent-device',
      symptom: `agent-device v${opts.version ?? '?'} is older than ${floor}, and the open failed.`,
      detail:
        'Old enough (0.16.x) and agent-device cannot open a Validity deep link on Android at all ' +
        '(`open` exits 127 with "/system/bin/sh: -p: inaccessible or not found"), so every spec ' +
        'that deep-links reports no verdict — a whole sweep of silence with nothing pointing at ' +
        'the tool. Nearer the floor the same staleness shows up as a leaked device claim: before ' +
        '0.20.2 `close` did not release the claim, so the next run is refused with "device is ' +
        'already in use" by a session that no longer exists.',
      fixCommand: 'npm i -g agent-device@latest   # asdf users: asdf reshim nodejs',
      confidence: 'confirmed',
    };
  }
  if (openErrorText && STALE_OPEN_SIGNATURE.test(openErrorText) && opts.version === undefined) {
    return {
      cause: 'stale-agent-device',
      symptom: `agent-device exited 127 opening the deep link: ${firstLine(openErrorText)}`,
      detail:
        'That error is produced both by an agent-device too old to open Validity deep links and by ' +
        'a still-open upstream bug in CURRENT versions (re-verified on 0.20.3) where any URL ' +
        'containing an `&` is split by the device-side shell. Validity already routes around the ' +
        'second case by quoting the URL for the device shell, so seeing it after that ALSO failed ' +
        'points at the install. Confirm the version before acting on this.',
      fixCommand: 'agent-device --version   # then, if it is behind: npm i -g agent-device@latest',
      confidence: 'suspected',
    };
  }
  return undefined;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]!.slice(0, 200);
}

/* -------------------------------------------------------------------------- */
/* orchestration                                                               */
/* -------------------------------------------------------------------------- */

export interface DiagnoseEnvironmentOptions {
  /** Project root — used for the metrics log and the companion app dir. */
  projectRoot?: string;
  platform?: 'ios' | 'android';
  /** Command runner (injectable for tests). Defaults to the driver's spawner. */
  run?: CommandRunner;
  /** stdout+stderr of the `open` that failed, when the caller has one. */
  openErrorText?: string;
  /** The render confirmation observed, when diagnosing a capture. */
  renderStatus?: 'confirmed' | 'unconfirmed' | 'failed';
  /**
   * Did the capture's readiness gate prove an agent-device session was open
   * (see `NativeDriver.ensureSession`)? `false` is conclusive evidence for
   * {@link detectNoNativeSession}; omit it when no gate ran — `undefined` must
   * never be read as "no session", only as "not measured".
   */
  sessionEstablished?: boolean;
  /** Pre-computed session health; read from the metrics log when omitted. */
  health?: SessionHealth;
  /**
   * The a11y snapshot this capture actually read. Feeds the dev-surface probe:
   * a modal dev menu / dev-launcher home screen is visible IN the evidence, and
   * without it those states get attributed to the session or the component.
   */
  a11ySnapshot?: string;
  /** Foreground activity/component (Android), for the dev-launcher signature. */
  foregroundActivity?: string;
  /**
   * A platform identity conflict the bridge observed (see
   * {@link BridgePlatformMismatch}) — e.g. a stale process holding the bridge
   * port with the OTHER platform's device attached.
   */
  bridgePlatformMismatch?: BridgePlatformMismatch | null;
  /** agent-device version the caller already probed, and whether it is below the floor. */
  agentDeviceVersion?: string;
  agentDeviceOutdated?: boolean;
  minAgentDeviceVersion?: string;
  /** Companion app dir (Metro's cwd). Default `<projectRoot>/.validity/native-app`. */
  appDir?: string;
  /** Recorded pid of the Metro Validity spawned (see readMetroOwnerMarker). */
  metroOwner?: { pid: number; pgid?: number } | null;
  metroPort?: number;
  /** AVD name for the reset recipe; left as `<avd>` when unknown. */
  avdName?: string;
  /** Simulator name/UDID for the iOS reset recipe; `booted` when unknown. */
  deviceName?: string;
  /** agent-device state dir. Default `$HOME/.agent-device`. */
  stateDir?: string;
  fs?: DiagnosisFs;
  isPidAlive?: (pid: number) => boolean;
  /**
   * Skip probes that spawn processes (`agent-device session list`, lsof/ps).
   * Used where a diagnosis must stay cheap.
   */
  skipCommands?: boolean;
}

async function resolveRunner(run: CommandRunner | undefined): Promise<CommandRunner> {
  if (run) return run;
  const mod = await import('./agent-device-driver.js');
  return mod.defaultRunner;
}

/** Run a command, returning '' on any failure. Never throws. */
async function tryRun(run: CommandRunner, bin: string, args: string[]): Promise<string> {
  try {
    const res = await run(bin, args);
    return `${res.stdout}\n${res.stderr}`;
  } catch {
    return '';
  }
}

/**
 * Collect who holds the companion port, with enough identity to tell a
 * Validity-spawned Metro from a hand-started one. Every step fails open: no
 * lsof (or a sandbox that blocks it) yields an empty list, which produces no
 * diagnosis.
 */
export async function probeMetroPortOwners(
  run: CommandRunner,
  port = COMPANION_METRO_PORT,
): Promise<MetroPortOwner[]> {
  // `-sTCP:LISTEN` is load-bearing, not a nicety. A bare `lsof -ti tcp:8082`
  // also lists every process CONNECTED to the port — measured on a live
  // session: the adb fork-server and the emulator's qemu process both showed
  // up alongside Metro. Without the filter, a session where Metro had exited
  // but a client socket lingered would be diagnosed as a "foreign Metro" and
  // the fix would tell the developer to kill their emulator.
  const listed = await tryRun(run, 'lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
  const pids = listed
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  const unique = [...new Set(pids)];
  const owners: MetroPortOwner[] = [];
  for (const pid of unique) {
    const pgidOut = await tryRun(run, 'ps', ['-p', String(pid), '-o', 'pgid=']);
    const command = (await tryRun(run, 'ps', ['-p', String(pid), '-o', 'command='])).trim();
    // `lsof -a -p <pid> -d cwd -Fn` prints `p<pid>` then `n<path>`.
    const cwdOut = await tryRun(run, 'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const cwd = cwdOut
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('n'))
      ?.slice(1);
    const pgid = Number.parseInt(pgidOut.trim(), 10);
    owners.push({
      pid,
      pgid: Number.isInteger(pgid) ? pgid : undefined,
      command: command || undefined,
      cwd: cwd || undefined,
    });
  }
  return owners;
}

/**
 * Diagnose why the native path produced nothing usable.
 *
 * RANKING — machine-readable ▸ structural ▸ OBSERVED ▸ inferred ▸ heuristic,
 * and the FIRST cause wins (a phantom claim explains an unconfirmed render, so
 * reporting both would just be noise):
 *
 *   1. a version comparison proving the CLI is too old — confirmed, and a
 *      prerequisite for everything below it;
 *   2. an error agent-device REPORTED, with a code, passed through verbatim.
 *      A handful of codes (see {@link UPSTREAM_CODES_WITH_SPECIFIC_PROBE}) are
 *      deferred to Validity probes that read the SAME text more precisely, and
 *      fall back to the passthrough at step 10 if none of those matches. No
 *      heuristic may ever outrank this — that inversion is what produced
 *      "most likely the component itself" over a wedged iOS runner;
 *   3-6. structural facts about the environment: device identity, claim state,
 *      daemon liveness, and whether a device could be opened at all;
 *   7-8. WHAT THE CAMERA SAW — the companion port's owner, then the Expo dev
 *      surface that was actually on screen (and, when the same screen comes
 *      with an aged bundler and a healthy session, `metro-decayed`);
 *   9. no-native-session — an INFERENCE from a failed `open`, and therefore
 *      ranked below every direct observation above it (see below);
 *   10. the deferred upstream passthrough;
 *   11+. heuristics — session decay, then the component itself.
 *
 * WHY THE DEV SURFACE MOVED ABOVE no-native-session (2026-07-29). The ordering
 * used to put `no-native-session` at step 7, above the dev-surface probes. It
 * then won — at `confirmed`, for all ten specs of a sweep — over a device that
 * was sitting on the expo-dev-client launcher with a session that answered
 * every command it was given, and its fix told the developer to run the command
 * that was already working. `dev-launcher-home` and `dev-menu-open` are DIRECT
 * a11y observations of the screen the evidence was read from; `no-native-session`
 * is an inference from one `agent-device open` not returning 0. An observation
 * outranks an inference about the same failure — always, and especially when
 * the two disagree.
 *
 * `render-failure` is only reached once every one of the above came back clean,
 * which is the whole point: it is the one cause that says "look at your
 * component", and it must not be said while something else is broken.
 *
 * Always resolves — never throws, never rejects. The worst case is
 * `cause: 'unknown'`, which is exactly today's behavior with the reasoning
 * shown.
 */
export async function diagnoseNativeEnvironment(
  opts: DiagnoseEnvironmentOptions = {},
): Promise<EnvironmentDiagnosis> {
  try {
    return await diagnoseInner(opts);
  } catch {
    return unknownDiagnosis(opts.renderStatus);
  }
}

async function diagnoseInner(opts: DiagnoseEnvironmentOptions): Promise<EnvironmentDiagnosis> {
  const { openErrorText, platform } = opts;

  // 1. A stale CLI explains everything downstream, and the caller usually
  //    already knows the version (the readiness gate probed it). This is a
  //    version COMPARISON, not a guess, which is why it outranks even the
  //    upstream code: on an install below the floor, every code below is a
  //    consequence of it.
  const stale = detectStaleAgentDevice(openErrorText, {
    version: opts.agentDeviceVersion,
    outdated: opts.agentDeviceOutdated,
    minVersion: opts.minAgentDeviceVersion,
  });
  if (stale?.confidence === 'confirmed') return stale;

  // 2. THE UPSTREAM ANSWER. agent-device names its own failures with a code;
  //    when it has, Validity's job is to relay it, not to re-derive a cause
  //    from symptoms. Only the codes Validity reads more precisely (via a
  //    SECOND machine-readable observation — the session list, the version)
  //    are deferred, and they come back at step 8 if no such probe matches.
  const upstream = parseAgentDeviceError(openErrorText);
  if (upstream && !UPSTREAM_CODES_WITH_SPECIFIC_PROBE.has(upstream.code)) {
    const passthrough = diagnoseUpstreamError(upstream);
    if (passthrough) return passthrough;
  }

  // 3. The bridge is pointed at the other platform's device — a self-reported
  //    identity conflict, so it is fact, not inference, and it invalidates
  //    every observation the run made through that bridge.
  const crossPlatform = detectBridgePlatformMismatch(opts.bridgePlatformMismatch);
  if (crossPlatform) return crossPlatform;

  // 4. Phantom claim — the pairing needs a session list, so it costs one
  //    read-only command.
  if (openErrorText && IN_USE_RE.test(openErrorText) && !opts.skipCommands) {
    const run = await resolveRunner(opts.run);
    const list = await tryRun(run, 'agent-device', ['session', 'list']);
    const phantom = detectPhantomClaim(openErrorText, list);
    if (phantom) return withUpstream(phantom, upstream);
    // The same refusal with a NON-empty list naming the session: a claim that
    // outlived an unqualified `close`, released by closing it by name.
    const staleClaim = detectStaleDeviceClaim(openErrorText, list);
    if (staleClaim) return withUpstream(staleClaim, upstream);
  }

  // 5. Daemon state on disk (pure file reads).
  const daemon = probeAgentDeviceDaemon({
    stateDir: opts.stateDir,
    fs: opts.fs,
    isPidAlive: opts.isPidAlive,
  });
  const daemonDiag = diagnoseDaemon(daemon);
  if (daemonDiag) return withUpstream(daemonDiag, upstream);

  // 6. A device that cannot be opened at all. Ranked ABOVE the no-session probe
  //    because no booted device is WHY there is no session, and its fix is the
  //    one that helps.
  const notReady = detectDeviceNotReady(openErrorText, platform);
  if (notReady) return withUpstream(notReady, upstream);

  // Epoch-scoped session health, computed once and used by BOTH age-based
  // probes below. The daemon's own start time bounds the evidence, so captures
  // written before a reset cannot produce a streak that recommends the reset
  // that just happened.
  const health =
    opts.health ??
    (opts.projectRoot
      ? summarizeSessionHealth(readSessionMetrics(opts.projectRoot), {
          epochStartMs: daemonEpochStartMs(daemon),
        })
      : undefined);
  // Did a session-scoped command ANSWER in this same pass? Read off the
  // snapshot the capture already handed us — no new plumbing, and it is the
  // observation that disproves `no-native-session` at step 9.
  const sessionAnswered = sessionCommandsAnswered(opts.a11ySnapshot);
  const appDir = opts.appDir ?? defaultAppDir(opts.projectRoot);

  // 7. Foreign Metro on the companion port. A hand-started bundler is the
  //    DEEPER cause of an app that never loaded, so it runs before the surface
  //    observation it would otherwise be described by.
  if (!opts.skipCommands) {
    const run = await resolveRunner(opts.run);
    const owners = await probeMetroPortOwners(run, opts.metroPort);
    const foreign = detectForeignMetro({
      owners,
      ownerMarker: opts.metroOwner,
      appDir,
      port: opts.metroPort,
    });
    if (foreign) return foreign;
  }

  // 8. WHAT THE CAMERA SAW. `metro-decayed` first: it is a strictly MORE
  //    SPECIFIC reading of the very same dev-launcher/blank screen the probe
  //    below names — same observation, plus a healthy session and an aged
  //    bundler — and its remedy is the one that was measured to work. This
  //    mirrors how UPSTREAM_CODES_WITH_SPECIFIC_PROBE defers a general answer
  //    to a narrower probe over identical evidence. When the corroboration is
  //    absent, `dev-launcher-home`/`dev-menu-open` fire as before.
  const metroDecay = detectMetroDecay({
    renderStatus: opts.renderStatus,
    a11ySnapshot: opts.a11ySnapshot,
    foregroundActivity: opts.foregroundActivity,
    sessionAnswered,
    health,
    appDir,
  });
  if (metroDecay) return metroDecay;
  const devSurface = detectDevSurface({
    snapshot: opts.a11ySnapshot,
    foregroundActivity: opts.foregroundActivity,
    platform,
  });
  if (devSurface) return devSurface;
  // Same rank, same kind of evidence: a DIRECT a11y observation of a system
  // dialog covering the screen. Disjoint anchors from the dev surfaces, so
  // order between them is cosmetic.
  const anr = detectAnrDialog({ snapshot: opts.a11ySnapshot, platform });
  if (anr) return anr;

  // 9. No agent-device session behind the capture — the cold-daemon case, where
  //    Validity's own control bridge is warm (it talks to the companion app,
  //    which outlives the daemon) and every evidence-reading command answers
  //    SESSION_NOT_FOUND. Below the claim/daemon/device probes because each of
  //    those is a deeper reason the session is missing, and below the dev
  //    surface because that is an OBSERVATION of the screen while this is an
  //    INFERENCE from a failed `open` (see the ranking note above). It still
  //    outranks the DEFERRED passthrough at step 10 on purpose: the cold-daemon
  //    signature arrives as a vague COMMAND_FAILED, and "no session was open"
  //    is the more useful reading of the same text — withUpstream keeps the
  //    machine-readable code attached either way.
  const noSession = detectNoNativeSession(openErrorText, {
    sessionEstablished: opts.sessionEstablished,
    daemon,
    sessionAnswered,
  });
  if (noSession) return withUpstream(noSession, upstream);

  // 10. The deferred upstream code, now that its more specific probes have all
  //     passed. Still ABOVE every heuristic — a reported code beats a guess.
  if (upstream) {
    const passthrough = diagnoseUpstreamError(upstream);
    if (passthrough) return passthrough;
  }

  // 11. Session decay — the leading SUSPICION once the environment looks intact
  //     and the Metro-specific signature above did not match.
  if (health) {
    const decay = detectSessionDecay(health, {
      platform,
      avdName: opts.avdName,
      deviceName: opts.deviceName,
    });
    if (decay) return decay;
  }

  // 11. Nothing environmental — a suspected stale install is still better than
  //     silence, then the component itself.
  if (stale) return stale;

  // ADVISORY, and ONLY from here down. Every probe above answered "no", so this
  // pass is about to hand back either `render-failure` ("look at your
  // component") or `unknown` ("no idea") — the two answers a developer can do
  // least with. `agent-device doctor` knows things Validity's probes do not
  // (RN/Expo toolchain readiness, Metro reachability inferred from cwd, iOS
  // runner cache state), so it is worth one bounded command HERE and nowhere
  // else: above this line a stronger, Validity-owned observation already won,
  // and paying for a second opinion would only slow the failure path down.
  //
  // It cannot change the cause, the confidence or the fix — it is prose
  // attached to whichever of the two answers below is returned.
  const advisory = opts.skipCommands
    ? undefined
    : summarizeAgentDeviceDoctor(
        await probeAgentDeviceDoctor({
          run: await resolveRunner(opts.run),
          ...(platform ? { platform } : {}),
        }),
      );
  const withAdvisory = (d: EnvironmentDiagnosis): EnvironmentDiagnosis =>
    advisory ? { ...d, advisory } : d;

  if (opts.renderStatus === 'failed') {
    return withAdvisory({
      cause: 'render-failure',
      symptom: 'The device looked the target up and answered that it could not render it.',
      detail:
        'The companion received the navigate and rejected it — the component is not in the ' +
        'registry it was built with, or it threw while rendering. The environment probes (device ' +
        'claim, daemon, companion Metro, session health) all came back clean, so this points at the ' +
        'component or its registration rather than the device.',
      confidence: 'confirmed',
    });
  }
  if (opts.renderStatus === 'unconfirmed') {
    return withAdvisory({
      cause: 'render-failure',
      symptom: 'The render was never confirmed, and every environment probe came back clean.',
      detail:
        'No phantom device claim, no dead daemon, a live agent-device session, no foreign Metro on ' +
        'the companion port, and this ' +
        'session shows no decay signature — so the most likely remaining cause is the component ' +
        'itself: a slow/blocked first paint, a provider that never resolves, or a throw swallowed by ' +
        'the harness. Verdicts are withheld because the screen was never proven to be the requested ' +
        'target, not because the component is known to be wrong.',
      confidence: 'suspected',
    });
  }
  return withAdvisory(unknownDiagnosis(opts.renderStatus));
}

function defaultAppDir(projectRoot: string | undefined): string | undefined {
  return projectRoot ? resolve(projectRoot, '.validity', 'native-app') : undefined;
}

/**
 * Attach the raw upstream error to a Validity-derived cause. The specialized
 * probes produce a better symptom and a narrower fix, but the machine-readable
 * code must not be LOST on the way — a consumer (MCP verdict payload, CI
 * annotation) should always be able to read what the tool below actually said.
 */
function withUpstream(
  d: EnvironmentDiagnosis,
  upstream: UpstreamAgentDeviceError | undefined,
): EnvironmentDiagnosis {
  return upstream ? { ...d, upstream } : d;
}

function unknownDiagnosis(renderStatus?: string): EnvironmentDiagnosis {
  return {
    cause: 'unknown',
    symptom:
      renderStatus === undefined
        ? 'The native path produced no verdicts and no probe matched a known cause.'
        : `The render came back "${renderStatus}" and no probe matched a known cause.`,
    detail:
      'None of the known environmental failures (stale agent-device, phantom device claim, dead ' +
      'daemon, no agent-device session, foreign Metro, session decay) could be confirmed, and no ' +
      'cause could be established. ' +
      'Verdicts are withheld rather than guessed. The per-capture metrics log ' +
      '(.validity/runs/native-session-metrics.jsonl) records what each capture cost, which is the ' +
      'fastest way to see whether this session is degrading.',
    confidence: 'suspected',
  };
}

/** One-line rendering for logs/CLI output. */
export function formatDiagnosis(d: EnvironmentDiagnosis): string {
  const conf = d.confidence === 'suspected' ? ' (suspected)' : '';
  return `${d.cause}${conf}: ${d.symptom}${d.fixCommand ? ` — fix: ${d.fixCommand.split('\n')[0]}` : ''}`;
}
