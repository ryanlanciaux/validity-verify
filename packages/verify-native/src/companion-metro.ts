/**
 * Companion Metro lifecycle helper.
 *
 * The deep link only RENDERS if Metro is serving the bundle the installed
 * dev-client connects to. The companion's Metro is normally brought up (and
 * left running) by the CLI's `expo run` build; but a prior session's server can
 * be killed, leaving a fresh+installed app with no bundler. Both the CLI and the
 * MCP `native_browse` handler call this before firing the deep link.
 *
 * It ALSO owns the transform-cache freshness gate. Metro's transform/file-map
 * caches survive a restart, so when Validity regenerates a file (a fixed
 * polyfills body, a new view's registry entry) Metro can keep serving the OLD
 * transform — the file on disk is fixed but the bundle on the device isn't (the
 * "my edit never took effect" class of bug). We track the last-served
 * `contentHash` in a marker file and, when it differs, restart Metro with
 * `--clear`. An unchanged warm session is a fast no-op.
 *
 * The restart path is VERIFIED end-to-end, because every step used to be
 * fire-and-forget and each gap produced a confidently-wrong session:
 *   - the kill polls `kill(pid, 0)` until the old PID is actually gone
 *     (SIGKILL escalation after a grace) instead of a fixed 1s sleep — a
 *     SIGTERM-ignoring Metro used to survive and keep serving stale content;
 *   - the fresh spawn is monitored for an early exit (crash-on-boot — port
 *     still held, broken config) so the failure is reported immediately
 *     instead of polled for the full 120s;
 *   - the contentHash marker is persisted ONLY after lsof attributes the
 *     companion port to the Metro THIS call spawned. Without that, a surviving
 *     old Metro could answer `/status`, the fresh marker would be written over
 *     stale served content, and every future call would trust it — permanently
 *     masking the exact staleness bug the marker exists to catch.
 *
 * This is the one place in @validity.ai/verify-native that spawns a process — a small,
 * documented exception to the package's "pure emission + command builders"
 * rule, kept isolated here so the generator modules stay side-effect-free.
 */
import { openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COMPANION_METRO_PORT,
  isCompanionMetroUp,
  metroServeSpawnEnv,
  startMetroStep,
} from './prepare-native-app.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface EnsureMetroOptions {
  /** Max time to wait for Metro to answer /status. Default 120s. */
  timeoutMs?: number;
  /** Poll interval. Default 3s. */
  pollMs?: number;
  /**
   * Hash of the exact source Metro should be serving (from
   * `prepareNativeApp().contentHash`). When provided, Metro is (re)started with
   * `--clear` whenever this differs from the last-served value recorded in
   * {@link EnsureMetroOptions.contentMarkerPath}, defeating a stale transform
   * cache. Omit to preserve the legacy "bring Metro up if down" behavior with no
   * cache handling.
   */
  contentHash?: string;
  /** File the last-served contentHash is persisted to (from `prepareNativeApp().metroContentMarkerPath`). */
  contentMarkerPath?: string;
}

export interface EnsureMetroResult {
  /** True if this call spawned a new Metro (false if one was already up + fresh). */
  started: boolean;
  /** True if Metro is serving by the time we return. */
  up: boolean;
  /** True if Metro was restarted to pick up changed content (implies a --clear spawn). */
  restartedForContent?: boolean;
  /** Where the spawned Metro's output is tee'd (only when started). */
  logPath?: string;
  /**
   * Set when the freshly spawned Metro exited non-zero before answering
   * `/status` (crash-on-boot: port still held, broken config, missing expo).
   * `up` is false; the log at {@link EnsureMetroResult.logPath} has the cause.
   */
  earlyExitCode?: number;
  /**
   * True when `/status` answered but lsof could NOT attribute the companion
   * port to the Metro THIS call spawned — most likely a surviving OLD server
   * still serving stale content. The content marker is deliberately NOT
   * persisted in that state (the next call retries the --clear restart instead
   * of trusting an unverified bundle), and callers should warn that renders
   * may be stale.
   */
  ownershipUnconfirmed?: boolean;
}

/** Read the persisted last-served contentHash, or null if absent/unreadable. */
function readContentMarker(path: string | undefined): string | null {
  if (!path) return null;
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
}

/** Record the contentHash Metro is now serving (best-effort). */
export function writeMetroContentMarker(path: string, contentHash: string): void {
  try {
    writeFileSync(path, contentHash);
  } catch {
    /* non-fatal — worst case we pay one extra --clear next time */
  }
}

/** Who Validity believes owns the companion port, recorded when lsof confirmed it. */
export interface MetroOwnerMarker {
  /** PID of the detached spawn (its own process-group leader). */
  pid: number;
  /** PID of the process actually bound to the port, when it differs. */
  boundPid?: number;
  startedAt: string;
}

/**
 * Where the owner marker lives. Sits beside the content marker in the generated
 * companion app dir, so it is regenerated/cleaned with everything else.
 */
export function metroOwnerMarkerPath(appDir: string): string {
  return resolve(appDir, '.validity-metro-owner');
}

/**
 * Record that THIS process's spawn owns the companion port — the identity a
 * later run needs to tell a Validity-managed Metro from a hand-started `expo
 * start` on the same port. Written ONLY after lsof attributed the port to our
 * spawn (see ensureCompanionMetro), for the same reason the content marker is:
 * an unverified attribution is worse than none, because the foreign-Metro
 * diagnosis would then wave a stranger's bundler through.
 */
export function writeMetroOwnerMarker(appDir: string, owner: MetroOwnerMarker): void {
  try {
    writeFileSync(metroOwnerMarkerPath(appDir), JSON.stringify(owner));
  } catch {
    /* best-effort: absent marker degrades the diagnosis to "unknown", never to a false claim */
  }
}

/** Read the recorded owner, or null when absent/unreadable/malformed. */
export function readMetroOwnerMarker(appDir: string): MetroOwnerMarker | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(metroOwnerMarkerPath(appDir), 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const m = parsed as Partial<MetroOwnerMarker>;
    if (typeof m.pid !== 'number') return null;
    return {
      pid: m.pid,
      boundPid: typeof m.boundPid === 'number' ? m.boundPid : undefined,
      startedAt: typeof m.startedAt === 'string' ? m.startedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * Injectable primitives for {@link killCompanionMetro}, so the
 * SIGTERM→verify→SIGKILL escalation ladder is unit-testable against a fake
 * process table (a real SIGTERM-ignoring process can't be faked in-suite).
 */
export interface KillDeps {
  /** PIDs currently bound to the port (`lsof -ti tcp:<port>`). */
  listPids: (port: number) => Promise<number[]>;
  /** Command line for a pid (`ps -p <pid> -o command=`); '' when unknown/gone. */
  commandFor: (pid: number) => Promise<string>;
  /**
   * Send a signal. `0` probes liveness without signalling (the kernel checks
   * existence/permission only). MUST throw (ESRCH) once the process is gone —
   * that throw is the positive "it actually died" confirmation the verified
   * kill is built on.
   */
  signal: (pid: number, sig: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
}

export interface KillCompanionMetroOptions {
  /** How long to wait for SIGTERM to land before escalating. Default 3s. */
  termGraceMs?: number;
  /** How long to wait after SIGKILL before giving up. Default 2s. */
  killGraceMs?: number;
  /** Liveness re-probe interval. Default 150ms. */
  pollMs?: number;
}

export interface KillCompanionMetroResult {
  /** PIDs that exited within the SIGTERM grace window. */
  terminated: number[];
  /** PIDs that ignored SIGTERM and had to be SIGKILLed (confirmed dead after). */
  escalated: number[];
  /**
   * PIDs still alive after SIGKILL + grace (pathological — uninterruptible
   * sleep). The port may still be held; ensureCompanionMetro's ownership check
   * keeps the content marker honest in that case.
   */
  survivors: number[];
}

/** Run an execFile, resolving its stdout ('' on any failure). Never throws. */
async function execStdout(bin: string, args: string[]): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((res) => {
    try {
      execFile(bin, args, { timeout: 4000 }, (_err, stdout) => res(stdout || ''));
    } catch {
      res('');
    }
  });
}

const realKillDeps: KillDeps = {
  listPids: async (port) => {
    const out = await execStdout('lsof', ['-ti', `tcp:${port}`]);
    return out
      .split(/\s+/)
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  },
  commandFor: (pid) => execStdout('ps', ['-p', String(pid), '-o', 'command=']),
  signal: (pid, sig) => {
    process.kill(pid, sig);
  },
  sleep,
};

/**
 * VERIFIED kill of whatever Metro/expo/node process is holding the companion
 * port, so a restart can rebind it with a fresh cache. Guarded: we only kill a
 * PID whose command line looks like Metro/Expo/Node (never an unrelated process
 * that happens to bind the port). Never throws.
 *
 * SIGTERM first, then poll `kill(pid, 0)` until the PID is actually gone;
 * escalate to SIGKILL after {@link KillCompanionMetroOptions.termGraceMs}. The
 * old fixed 1s sleep let a busy/ignoring Metro outlive the "kill" — the fresh
 * spawn then failed to bind the port while the OLD server kept answering
 * `/status` with stale content.
 */
export async function killCompanionMetro(
  port: number,
  deps: KillDeps = realKillDeps,
  opts: KillCompanionMetroOptions = {},
): Promise<KillCompanionMetroResult> {
  const termGraceMs = opts.termGraceMs ?? 3_000;
  const killGraceMs = opts.killGraceMs ?? 2_000;
  const pollMs = opts.pollMs ?? 150;

  const pids = await deps.listPids(port);
  const targets: number[] = [];
  for (const pid of pids) {
    // Verify identity before killing — a dedicated dev port is unlikely to be
    // shared, but a stale lsof / reused port shouldn't take down something else.
    const cmd = (await deps.commandFor(pid)).toLowerCase();
    if (!/expo|metro|node/.test(cmd)) continue;
    targets.push(pid);
    try {
      deps.signal(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (targets.length === 0) return { terminated: [], escalated: [], survivors: [] };

  const alive = (pid: number): boolean => {
    try {
      deps.signal(pid, 0);
      return true;
    } catch {
      return false; // ESRCH — the process is confirmed gone
    }
  };
  const waitUntilGone = async (candidates: number[], graceMs: number): Promise<number[]> => {
    const deadline = Date.now() + graceMs;
    let remaining = candidates.filter(alive);
    while (remaining.length > 0 && Date.now() < deadline) {
      await deps.sleep(pollMs);
      remaining = remaining.filter(alive);
    }
    return remaining;
  };

  const stubborn = await waitUntilGone(targets, termGraceMs);
  const terminated = targets.filter((p) => !stubborn.includes(p));
  if (stubborn.length === 0) return { terminated, escalated: [], survivors: [] };

  // Escalate: these ignored (or are still draining after) SIGTERM. SIGKILL is
  // uncatchable, so anything that survives the second grace is in a state no
  // signal can fix — surface it as a survivor instead of pretending it died.
  for (const pid of stubborn) {
    try {
      deps.signal(pid, 'SIGKILL');
    } catch {
      /* died between probes */
    }
  }
  const survivors = await waitUntilGone(stubborn, killGraceMs);
  return { terminated, escalated: stubborn.filter((p) => !survivors.includes(p)), survivors };
}

/** Handle to a freshly spawned Metro: where its output goes, who it is, and whether it died. */
export interface SpawnedMetro {
  /** Where the spawned Metro's output is tee'd. */
  logPath: string;
  /**
   * PID of the detached spawn. Because the spawn is detached (its own process
   * group, pgid === pid), descendants like the `expo`/`metro` node process that
   * actually binds the port share this as their pgid — which is how port
   * ownership is attributed back to THIS spawn. Undefined if the spawn failed.
   */
  pid?: number;
  /** Exit code if the process has already exited; null while it's still running. */
  exitCode: () => number | null;
}

/** A process currently bound to the companion port, with its process group. */
export interface PortOwner {
  pid: number;
  pgid: number;
}

/** Spawn `expo start` DETACHED (keeps running after we return) and tee its output. */
async function spawnMetro(appDir: string, clearCache: boolean): Promise<SpawnedMetro> {
  const step = startMetroStep(appDir, { clearCache });
  const logPath = resolve(appDir, 'validity-native.log');
  const fd = openSync(logPath, 'a');
  const { spawn } = await import('node:child_process');
  const child = spawn(step.bin, step.args, {
    cwd: step.cwd,
    detached: true,
    stdio: ['ignore', fd, fd],
    // Serve-step env: METRO_SERVE_ENV over the parent's, with the inherited CI
    // flags STRIPPED — an agent harness exporting CI=1 would otherwise disable
    // Metro's file watcher and kill Fast Refresh (see metroServeSpawnEnv).
    env: metroServeSpawnEnv(process.env, step.env),
  });
  // Track an early death WITHOUT keeping the event loop alive — `exit` still
  // fires on an unref'd child as long as our process is running, which is the
  // exact window ensureCompanionMetro polls in.
  let exit: number | null = null;
  child.on('exit', (code) => {
    exit = code ?? 0;
  });
  child.on('error', () => {
    // Spawn failure (bin missing) — same convention as the CLI's runInherited.
    exit = exit ?? 127;
  });
  child.unref();
  return { logPath, pid: child.pid, exitCode: () => exit };
}

/** lsof + ps: who holds the port, and in which process group. */
async function portOwners(port: number): Promise<PortOwner[]> {
  const pids = await realKillDeps.listPids(port);
  const owners: PortOwner[] = [];
  for (const pid of pids) {
    const out = await execStdout('ps', ['-p', String(pid), '-o', 'pgid=']);
    const pgid = Number.parseInt(out.trim(), 10);
    owners.push({ pid, pgid: Number.isInteger(pgid) ? pgid : -1 });
  }
  return owners;
}

/**
 * Injectable side effects so the restart-decision logic is unit-testable without
 * actually probing/killing/spawning Metro. Production uses the real ones.
 */
export interface MetroDeps {
  /** Is Metro answering on its port? */
  isUp: (port: number) => Promise<boolean>;
  /** VERIFIED kill of whatever holds the companion port (so a restart can rebind it). */
  kill: (port: number) => Promise<KillCompanionMetroResult>;
  /** Spawn `expo start [--clear]` detached; resolve a monitorable handle. */
  spawn: (appDir: string, clearCache: boolean) => Promise<SpawnedMetro>;
  /** Who currently holds the companion port (pid + process group, via lsof/ps). */
  portOwners: (port: number) => Promise<PortOwner[]>;
  /** Injectable so tests can assert probe-then-sleep ordering without real time. */
  sleep: (ms: number) => Promise<void>;
}

const realDeps: MetroDeps = {
  isUp: (port) => isCompanionMetroUp(port),
  kill: (port) => killCompanionMetro(port),
  spawn: (appDir, clearCache) => spawnMetro(appDir, clearCache),
  portOwners: (port) => portOwners(port),
  sleep,
};

/**
 * Ensure the companion Metro is serving on {@link COMPANION_METRO_PORT} with the
 * CURRENT generated content, WITHOUT a native rebuild.
 *
 *   - Already up + content unchanged → fast no-op.
 *   - Already up + content CHANGED   → kill it (verified), restart with `--clear`, repoll.
 *   - Down + content unchanged       → start (no --clear; the cache is still valid).
 *   - Down + content changed/unknown → start with `--clear`.
 *
 * After Metro answers `/status` we persist the served contentHash so the next
 * call can tell whether a restart is needed — but ONLY once lsof confirms the
 * port is owned by the Metro this call spawned. `/status` alone can't tell a
 * fresh server from a surviving old one, and persisting on the old server's
 * answer would mark stale content as fresh forever. With no `contentHash`
 * supplied this degrades to the legacy "bring it up if down" behavior (no cache
 * handling, no ownership check).
 */
export async function ensureCompanionMetro(
  appDir: string,
  opts: EnsureMetroOptions = {},
  deps: MetroDeps = realDeps,
): Promise<EnsureMetroResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 3_000;
  const marker = readContentMarker(opts.contentMarkerPath);
  // contentChanged is only meaningful when the caller opted into hashing.
  const contentChanged = opts.contentHash !== undefined && marker !== opts.contentHash;

  const persist = (): void => {
    if (opts.contentHash && opts.contentMarkerPath) {
      writeMetroContentMarker(opts.contentMarkerPath, opts.contentHash);
    }
  };

  const waitUntilUp = async (
    spawned: SpawnedMetro,
    restarted: boolean,
  ): Promise<EnsureMetroResult> => {
    const base = { started: true, restartedForContent: restarted, logPath: spawned.logPath };
    // Ownership only matters when a wrong attribution could poison the marker.
    const needsOwnership = Boolean(opts.contentHash && opts.contentMarkerPath);
    const start = Date.now();
    // `/status` answered but the port couldn't be attributed to OUR spawn —
    // remembered so a timeout still reports "something is serving" honestly.
    let sawUpWithoutOwnership = false;
    // Probe-then-sleep: an instantly-up Metro must not pay a guaranteed
    // first-poll floor (the old sleep-first loop cost 3s on every spawn).
    for (;;) {
      // Crash-on-boot (port still held, broken config, missing expo): report
      // the exit immediately instead of polling out the full timeout. An exit
      // of 0 is ambiguous while detached — keep polling like the CLI does.
      const exit = spawned.exitCode();
      if (exit !== null && exit !== 0) {
        return { ...base, up: false, earlyExitCode: exit };
      }
      if (await deps.isUp(COMPANION_METRO_PORT)) {
        if (!needsOwnership) return { ...base, up: true };
        const owners = await deps.portOwners(COMPANION_METRO_PORT);
        // The detached spawn is its own process-group leader, so the node
        // process that actually binds the port (a descendant of `npx expo`)
        // carries pgid === spawned.pid even though its pid differs.
        const owned =
          spawned.pid !== undefined &&
          owners.some((o) => o.pid === spawned.pid || o.pgid === spawned.pid);
        if (owned) {
          persist();
          // Same evidence, second consumer: record WHICH process is ours so a
          // later run can tell this Metro from a hand-started one on the same
          // port (see detectForeignMetro).
          writeMetroOwnerMarker(appDir, {
            pid: spawned.pid!,
            boundPid: owners.find((o) => o.pgid === spawned.pid)?.pid,
            startedAt: new Date().toISOString(),
          });
          return { ...base, up: true };
        }
        // Someone ELSE is answering /status — likely the old Metro surviving
        // the kill, or lsof racing the new bind. Keep polling: if our spawn
        // takes over, ownership confirms on a later probe; if not, time out
        // WITHOUT persisting the marker so the next call retries the restart.
        sawUpWithoutOwnership = true;
      }
      if (Date.now() - start >= timeoutMs) break;
      await deps.sleep(pollMs);
    }
    return {
      ...base,
      up: sawUpWithoutOwnership,
      ownershipUnconfirmed: sawUpWithoutOwnership || undefined,
    };
  };

  const alreadyUp = await deps.isUp(COMPANION_METRO_PORT);

  if (alreadyUp && !contentChanged) {
    // Up and serving the current content — nothing to do. (If the caller didn't
    // pass a hash we also land here: legacy no-op when up.) Re-persisting is a
    // no-op write of the value the marker already holds.
    persist();
    return { started: false, up: true };
  }

  if (alreadyUp && contentChanged) {
    // Serving a STALE bundle — restart with a clean cache so the regenerated
    // files actually reach the device. The kill is verified (SIGTERM → poll →
    // SIGKILL), so by the time we spawn, the port is genuinely free unless a
    // survivor is reported — which the ownership check above then catches.
    await deps.kill(COMPANION_METRO_PORT);
    const spawned = await deps.spawn(appDir, /* clearCache */ true);
    return waitUntilUp(spawned, /* restarted */ true);
  }

  // Down: start it. Clear the cache only if the content changed (or we can't
  // tell) — a clean restart of unchanged content would just be slow for nothing.
  const spawned = await deps.spawn(appDir, /* clearCache */ contentChanged);
  return waitUntilUp(spawned, /* restarted */ contentChanged);
}

/**
 * Injectable side effects for {@link waitForBundleServed} — log tailing is a
 * filesystem read + sleep loop, faked in tests.
 */
export interface BundleWaitDeps {
  /** Current contents of the Metro log ('' when missing/unreadable). */
  readLog: (path: string) => string;
  sleep: (ms: number) => Promise<void>;
}

const realBundleWaitDeps: BundleWaitDeps = {
  readLog: (path) => {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return '';
    }
  },
  sleep,
};

export interface BundleWaitOptions {
  /** The companion Metro log (validity-native.log) to tail. */
  logPath: string;
  /**
   * Scan only log content appended AFTER this offset (in decoded characters —
   * capture it with {@link metroLogLength} BEFORE triggering the bundle load,
   * so a previous session's "Bundled" line can't satisfy the wait).
   */
  sinceOffset?: number;
  /** Generous cap — a post---clear first bundle routinely takes 30-90s. Default 120s. */
  capMs?: number;
  /** Poll interval. Default 500ms. */
  pollMs?: number;
}

/** Metro's bundle-complete / bundle-failed log markers (expo CLI output). */
const BUNDLE_DONE_RE = /\bBundled\b/;
const BUNDLE_FAILED_RE = /Bundling failed/;

/** Character offset of the Metro log right now (0 when missing) — pass as `sinceOffset`. */
export function metroLogLength(logPath: string, deps: BundleWaitDeps = realBundleWaitDeps): number {
  return deps.readLog(logPath).length;
}

/**
 * Observable cold-open readiness: wait until Metro reports the bundle SERVED
 * by tailing its log for the `Bundled`/`Bundling failed` markers, instead of
 * the old fixed 4s sleep — which a post---clear first bundle (30-90s) blows
 * straight past, leaving every confirmation rung to time out against the dev
 * launcher. Resolves true when a bundle completed, false when bundling failed
 * or nothing was observed within the cap (the caller's render-confirmation
 * machinery then reports the failure truthfully — this gate just stops the
 * ack wait from starting before there is anything to ack).
 */
export async function waitForBundleServed(
  opts: BundleWaitOptions,
  deps: BundleWaitDeps = realBundleWaitDeps,
): Promise<boolean> {
  const capMs = opts.capMs ?? 120_000;
  const pollMs = opts.pollMs ?? 500;
  const since = opts.sinceOffset ?? 0;
  const deadline = Date.now() + capMs;
  // Probe-then-sleep: a warm Metro that already served the bundle (its line is
  // in the appended region) resolves on the first read.
  for (;;) {
    const appended = deps.readLog(opts.logPath).slice(since);
    if (BUNDLE_DONE_RE.test(appended)) return true;
    if (BUNDLE_FAILED_RE.test(appended)) return false;
    if (Date.now() >= deadline) return false;
    await deps.sleep(pollMs);
  }
}
