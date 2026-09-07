/**
 * The on-signal actuation hook.
 *
 * When a watch tick OPENS signals, run a user-configured command — the one
 * composition point through which drift-response gets delegated outward:
 * a desktop notifier, a webhook curl. Validity grows no sink integrations;
 * this hook is the entire actuation surface.
 *
 * Invariants (all load-bearing for trust):
 *   - ADVISORY FOREVER: hook exit codes / output never touch verdicts, the
 *     scorecard, signals, or `--fail-on-signal`. A crash is a log line.
 *   - SERIALIZED: at most one hook process alive at a time.
 *   - COOLED DOWN: launches at least `cooldownMs` apart; signals that open
 *     during a run or cooldown COALESCE into one next launch (the hook is
 *     expected to read the full current queue, so batching is natural).
 *   - TRANSITIONS ONLY: callers pass newly-opened signals (from
 *     `diffSignalTransitions`), so steady-state re-fires never launch it.
 *
 * Env contract (stable):
 *   VALIDITY_PROJECT_ROOT   absolute project root
 *   VALIDITY_SIGNALS_PATH   path to signals.json (the full current queue)
 *   VALIDITY_NEW_SIGNALS    JSON array of the signals that triggered this launch
 *   VALIDITY_SCORE          current Validity Score, or empty when unscored
 */
import { spawn as nodeSpawn } from 'node:child_process';
import pc from 'picocolors';
import {
  recordHookActivity,
  signalsPath,
  type Signal,
  type SignalKind,
  type WatchHookActivity,
} from '@validity.ai/verify-spec';

/** Kinds that launch the hook when the config doesn't say otherwise. */
export const DEFAULT_HOOK_KINDS: readonly SignalKind[] = [
  'regression',
  'needs-scoring',
  'needs-rescoring',
];

export const DEFAULT_HOOK_COOLDOWN_MS = 300_000;

/** The slice of `child_process.spawn` the hook needs — injectable for tests. */
export type HookSpawn = (
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
) => {
  on: (event: 'exit' | 'error', listener: () => void) => void;
};

export interface OnSignalHookOptions {
  projectRoot: string;
  command: string;
  kinds?: readonly SignalKind[];
  cooldownMs?: number;
  /** Injectable spawn (default: `child_process.spawn` via a shell). */
  spawn?: HookSpawn;
  /** Injectable clock (default: `Date.now`). */
  now?: () => number;
  /** Injectable timer (default: `setTimeout`). Must return a cancelable handle. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  /**
   * Injectable persistence sink for hook activity (default:
   * `recordHookActivity(projectRoot, …)`). The dashboard's watcher-status view
   * reads this to show "last launch / cooldown". Advisory forever: a thrown
   * error here is swallowed into `log` and must never affect launching.
   */
  persist?: (hook: WatchHookActivity) => void;
  /** Injectable log sink (default: prefixed stderr). */
  log?: (line: string) => void;
}

function defaultSpawn(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): {
  on: (event: 'exit' | 'error', listener: () => void) => void;
} {
  const child = nodeSpawn(command, {
    cwd: opts.cwd,
    env: opts.env,
    shell: true,
    // The hook's output is surfaced (prefixed) but must never interleave with
    // the dashboard on stdout.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const forward = (chunk: Buffer): void => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim().length > 0) process.stderr.write(pc.dim(`[on-signal] ${line}\n`));
    }
  };
  child.stdout?.on('data', forward);
  child.stderr?.on('data', forward);
  return child;
}

function defaultSchedule(fn: () => void, ms: number): { cancel: () => void } {
  const t = setTimeout(fn, ms);
  // The pending-launch timer must not pin the process open past SIGINT.
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
}

/**
 * The scheduler. `notify()` after each tick with that tick's newly-opened
 * signals; everything else (filtering, batching, cooldown, serialization)
 * happens here. Pure enough to unit-test via the injectable spawn/clock.
 */
export class OnSignalHook {
  private readonly opts: Required<
    Pick<OnSignalHookOptions, 'projectRoot' | 'command' | 'cooldownMs'>
  > & {
    kinds: ReadonlySet<SignalKind>;
    spawn: HookSpawn;
    now: () => number;
    schedule: (fn: () => void, ms: number) => { cancel: () => void };
    persist: (hook: WatchHookActivity) => void;
    log: (line: string) => void;
  };
  /** Coalesced signals waiting for the next launch, keyed by signal id. */
  private pending = new Map<string, Signal>();
  private running = false;
  private lastLaunchAt = Number.NEGATIVE_INFINITY;
  private timer: { cancel: () => void } | null = null;
  /** Current Validity Score, refreshed on every notify (for the env contract). */
  private score: number | null = null;

  constructor(options: OnSignalHookOptions) {
    this.opts = {
      projectRoot: options.projectRoot,
      command: options.command,
      cooldownMs: options.cooldownMs ?? DEFAULT_HOOK_COOLDOWN_MS,
      kinds: new Set(options.kinds ?? DEFAULT_HOOK_KINDS),
      spawn: options.spawn ?? defaultSpawn,
      now: options.now ?? Date.now,
      schedule: options.schedule ?? defaultSchedule,
      persist:
        options.persist ??
        ((hook: WatchHookActivity) => recordHookActivity(options.projectRoot, hook)),
      log: options.log ?? ((line: string) => process.stderr.write(pc.dim(`[on-signal] ${line}\n`))),
    };
  }

  /** Feed one tick's newly-opened signals. Cheap no-op when nothing matches. */
  notify(opened: Signal[], ctx?: { score?: number | null }): void {
    if (ctx && ctx.score !== undefined) this.score = ctx.score;
    for (const s of opened) {
      if (this.opts.kinds.has(s.kind)) this.pending.set(s.id, s);
    }
    this.maybeLaunch();
  }

  private maybeLaunch(): void {
    if (this.pending.size === 0 || this.running || this.timer) return;
    const wait = this.lastLaunchAt + this.opts.cooldownMs - this.opts.now();
    if (wait > 0) {
      this.timer = this.opts.schedule(() => {
        this.timer = null;
        this.maybeLaunch();
      }, wait);
      return;
    }
    this.launch();
  }

  private launch(): void {
    const batch = Array.from(this.pending.values());
    this.pending.clear();
    this.running = true;
    this.lastLaunchAt = this.opts.now();
    this.opts.log(
      `launching for ${batch.length} signal${batch.length === 1 ? '' : 's'}: ${batch
        .map((s) => s.id)
        .join(', ')}`,
    );
    let child: ReturnType<HookSpawn>;
    try {
      child = this.opts.spawn(this.opts.command, {
        cwd: this.opts.projectRoot,
        env: {
          ...process.env,
          VALIDITY_PROJECT_ROOT: this.opts.projectRoot,
          VALIDITY_SIGNALS_PATH: signalsPath(this.opts.projectRoot),
          VALIDITY_NEW_SIGNALS: JSON.stringify(batch),
          VALIDITY_SCORE: this.score == null ? '' : String(this.score),
        },
      });
    } catch (err) {
      // Advisory forever: a hook that can't even spawn is a log line.
      this.opts.log(`failed to launch: ${(err as Error).message}`);
      this.running = false;
      return;
    }
    // Spawn succeeded — record activity for the dashboard's watcher-status
    // view. Advisory forever: persistence never affects launching. Swallow
    // any error into a log line so the dashboard simply shows a stale "last
    // launch" until the next successful record.
    try {
      this.opts.persist({
        lastLaunchAt: new Date(this.opts.now()).toISOString(),
        batchSize: batch.length,
        cooldownMs: this.opts.cooldownMs,
      });
    } catch (err) {
      this.opts.log(`failed to persist hook activity: ${(err as Error).message}`);
    }
    const done = (): void => {
      if (!this.running) return; // 'error' + 'exit' can both fire
      this.running = false;
      // Signals that opened mid-run coalesced into `pending` — chain the
      // next launch through the same cooldown gate.
      this.maybeLaunch();
    };
    child.on('exit', done);
    child.on('error', done);
  }
}
