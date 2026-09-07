/**
 * CI device-boot — the Android Emulator lifecycle behind a headless
 * `validity verify --all`. It boots an emulator, installs the companion APK,
 * lets the caller run the on-device mechanical checks, and tears the emulator
 * down at the end. Linux-friendly: the Android Emulator runs on a CI runner;
 * iOS Simulator needs a Mac and is out of scope for this CI path.
 *
 * Lifecycle:
 *   1. `bootAndroidEmulator({ avdName, port })` — spawns `emulator -avd <name>
 *      -no-window -no-audio -no-snapshot -no-boot-anim -port <port>`, then
 *      waits for `adb wait-for-device` + `getprop sys.boot_completed === '1'`
 *      under `bootTimeoutSec`.
 *   2. `installCompanion({ apkPath, deviceId })` — `adb install -r <apk>`.
 *   3. … the caller verifies native specs against the booted device …
 *   4. `teardownEmulator(handle)` — `adb -s emulator-<port> emu kill`, then
 *      SIGTERMs the child.
 *
 * GATE INTEGRITY: every step throws a CLEAR, actionable error on a missing
 * binary / missing APK / boot timeout — never a silent skip and never a raw
 * crash. The caller turns a thrown error into a build-FAILING result rather
 * than a silent green.
 *
 * Binary detection scans `$ANDROID_HOME` then the directories on `$PATH` for
 * the real `emulator`/`adb` executable. It deliberately does NOT shell out to
 * `command -v` — `command` is a shell BUILTIN, not an executable, so running it
 * via execFile (no shell) always ENOENTs and would falsely report the tool as
 * missing on a runner that has it on PATH but no `$ANDROID_HOME`.
 */
import { spawn, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

/** A booted emulator handle — pass it to `teardownEmulator` to kill it. */
export interface BootedEmulator {
  /** The `emulator-<port>` device id used by `adb -s`. */
  deviceId: string;
  /** The console port (e.g. 5554 → deviceId `emulator-5554`). */
  port: number;
  /** The emulator child process, SIGTERM'd by teardown if `adb emu kill`
   * doesn't take. */
  child: ChildProcess;
}

export interface BootOptions {
  /** AVD name to boot (e.g. `validity_companion`). Required. */
  avdName: string;
  /** Console port; defaults to 5554 (the first emulator port). */
  port?: number;
  /**
   * Max seconds to wait for `sys.boot_completed` to flip to `1`. Default 120.
   * CI emulators boot slowly; this bounds a stuck boot so it can't hang the
   * verify run forever.
   */
  bootTimeoutSec?: number;
  /** Optional sink for the emulator child's stdout/stderr lines. */
  onLog?: (line: string) => void;
}

/**
 * Resolve an executable by scanning `$ANDROID_HOME/<subdir>` (when set) then
 * every directory on `$PATH`. Returns the absolute path, or `undefined` if it
 * isn't found anywhere — the callers turn `undefined` into a clear throw.
 *
 * NOTE: this is the fix for the `command -v` bug — `command` is a shell
 * builtin, so `execFile('command', ['-v', …])` always ENOENTs and wrongly
 * reports "not found" whenever `$ANDROID_HOME` is unset, even with the tool on
 * PATH. Scanning PATH dirs directly finds it.
 */
function findBinary(name: string, androidSubdir: string): string | undefined {
  const home = process.env.ANDROID_HOME;
  if (home) {
    const candidate = join(home, androidSubdir, name);
    if (isExecutable(candidate)) return candidate;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** Is `path` an existing file we can execute? */
function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The `emulator` binary, or a clear throw if it can't be found. */
function emulatorBinary(): string {
  const found = findBinary('emulator', 'emulator');
  if (found) return found;
  throw new Error(
    'emulator binary not found — install the Android SDK and put `emulator` on PATH, ' +
      'or set $ANDROID_HOME (the binary is expected at $ANDROID_HOME/emulator/emulator).',
  );
}

/** The `adb` binary, or a clear throw if it can't be found. */
function adbBinary(): string {
  const found = findBinary('adb', 'platform-tools');
  if (found) return found;
  throw new Error(
    'adb binary not found — install the Android platform-tools and put `adb` on PATH, ' +
      'or set $ANDROID_HOME (the binary is expected at $ANDROID_HOME/platform-tools/adb).',
  );
}

/**
 * Boot an Android Emulator and wait for it to be ready, returning a handle the
 * caller passes to `teardownEmulator`. A missing binary, a failed boot, or a
 * boot timeout all surface as a clear thrown error — never a silent skip.
 */
export async function bootAndroidEmulator(opts: BootOptions): Promise<BootedEmulator> {
  const emulator = emulatorBinary();
  const adb = adbBinary();
  const port = opts.port ?? 5554;
  const bootTimeoutSec = opts.bootTimeoutSec ?? 120;

  const args = [
    '-avd',
    opts.avdName,
    '-no-window',
    '-no-audio',
    '-no-snapshot',
    '-no-boot-anim',
    '-port',
    String(port),
  ];
  const child = spawn(emulator, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (chunk) => emitLines(chunk, '[emulator]', opts.onLog));
  child.stderr?.on('data', (chunk) => emitLines(chunk, '[emulator:err]', opts.onLog));

  const deviceId = `emulator-${port}`;
  const deadline = Date.now() + bootTimeoutSec * 1000;
  try {
    await waitForDevice(adb, deviceId, deadline);
    await waitForBootCompleted(adb, deviceId, deadline);
  } catch (err) {
    // A boot that never completed leaves a zombie emulator — kill it before
    // re-throwing so the timeout error isn't followed by a leaked process.
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    throw err;
  }

  return { deviceId, port, child };
}

function emitLines(chunk: Buffer, prefix: string, onLog?: (line: string) => void): void {
  if (!onLog) return;
  for (const line of chunk.toString().split('\n')) {
    const trimmed = line.trim();
    if (trimmed) onLog(`${prefix} ${trimmed}`);
  }
}

/** Run an adb command, normalizing a thrown error / non-zero exit into a
 * `{ code, stdout, stderr }` result (never throws). */
function runAdb(
  adb: string,
  args: string[],
  timeoutMs: number,
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(adb, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message: string };
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message,
    };
  }
}

/** Poll `adb wait-for-device` until the emulator registers or the deadline
 * passes. A stuck boot throws a clear timeout error instead of hanging CI. */
async function waitForDevice(adb: string, deviceId: string, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const res = runAdb(adb, ['-s', deviceId, 'wait-for-device'], Math.min(remaining, 30_000));
    if (res.code === 0) return;
    // wait-for-device can exit non-zero on transient states during boot —
    // retry until the deadline.
    await sleep(1000);
  }
  throw new Error(
    `adb wait-for-device timed out for ${deviceId} — the emulator did not register within the boot timeout.`,
  );
}

/** Poll `getprop sys.boot_completed` until it reports `1` or the deadline
 * passes (then throw a clear timeout error). */
async function waitForBootCompleted(
  adb: string,
  deviceId: string,
  deadline: number,
): Promise<void> {
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const res = runAdb(
      adb,
      ['-s', deviceId, 'shell', 'getprop', 'sys.boot_completed'],
      Math.min(remaining, 5_000),
    );
    if (res.code === 0 && res.stdout.trim() === '1') return;
    await sleep(2000);
  }
  throw new Error(
    `emulator ${deviceId} did not finish booting within the timeout — sys.boot_completed never reached 1.`,
  );
}

/**
 * Install / reinstall the companion APK on the booted emulator. The APK is
 * checked FIRST so a missing-file error (the actionable "build the APK" hint)
 * surfaces before the less-actionable "adb not found" — a CI without the SDK
 * still gets the right message.
 */
export async function installCompanion(args: {
  apkPath: string;
  deviceId?: string;
}): Promise<void> {
  if (!existsSync(args.apkPath)) {
    throw new Error(
      `companion APK not found at ${args.apkPath} — build it first ` +
        '(e.g. `expo run:android --variant release` or `eas build --local`).',
    );
  }
  const adb = adbBinary();
  const deviceArgs = args.deviceId ? ['-s', args.deviceId] : [];
  const res = runAdb(adb, [...deviceArgs, 'install', '-r', args.apkPath], 120_000);
  if (res.code !== 0) {
    throw new Error(
      `adb install failed (exit ${res.code}) for ${args.apkPath}:\n${res.stderr || res.stdout}`,
    );
  }
}

/**
 * Kill the emulator and clean up. Safe to call with `undefined` (a boot that
 * failed before returning a handle) and idempotent. Best-effort: it swallows
 * adb errors (device already gone) so a teardown in a `finally` never masks the
 * real failure with a cleanup error.
 */
export async function teardownEmulator(emulator: BootedEmulator | undefined): Promise<void> {
  if (!emulator) return;
  // Graceful kill first via `adb emu kill`; if adb is missing OR the device is
  // already gone, fall through to SIGTERMing the child.
  try {
    const adb = adbBinary();
    runAdb(adb, ['-s', emulator.deviceId, 'emu', 'kill'], 10_000);
  } catch {
    /* adb missing / device already gone → SIGTERM the child below */
  }
  try {
    emulator.child.kill('SIGTERM');
  } catch {
    /* already exited */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
