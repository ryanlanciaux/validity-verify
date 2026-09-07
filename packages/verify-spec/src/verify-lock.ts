/**
 * Cross-process verify lock (W4 #12): two overlapping verifies (or a watch
 * tick and an MCP verify) must not interleave the shared sandbox files in
 * `node_modules/.validity/` (entry.tsx, index.html, .vite-cache) or race the
 * load→reconcile→save fold over scorecard.json. Atomic writes can't fix a
 * lost-update — only serialization can.
 *
 * Create is `link(2)` of a pre-written temp file (exclusive, contents atomic;
 * O_EXCL fallback on link-less filesystems) so exactly one process wins, even
 * under simultaneous contention. A lock whose holder died (kill -9) is stolen:
 * `process.kill(pid, 0)` throwing ESRCH proves the pid is gone. EPERM counts as
 * alive (a foreign-owned process still exists). An unparseable lock file older
 * than 10 minutes is also treated as stale.
 */
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { resolve } from 'node:path';

/**
 * Where the lock lives: `<root>/node_modules/.validity/.verify.lock` — the
 * SHARED SANDBOX dir (the thing two verifies collide on: entry.tsx,
 * index.html, .vite-cache), NOT core's `<root>/.validity` state dir. Core has
 * no existing helper for the sandbox dir, so the path is computed here (same
 * shape as `@validity.ai/verify-web`'s `validityDir`).
 */
export function verifyLockPath(projectRoot: string): string {
  return resolve(projectRoot, 'node_modules', '.validity', '.verify.lock');
}

export interface VerifyLockHolder {
  pid: number;
  owner: string;
  startedAt: string;
}

export class VerifyLockHeldError extends Error {
  readonly holder: VerifyLockHolder;

  constructor(holder: VerifyLockHolder) {
    super(
      `A verify is already running (pid ${holder.pid}, started by ${holder.owner} at ` +
        `${holder.startedAt}). Wait for it to finish or, if it is dead, delete ` +
        `node_modules/.validity/.verify.lock.`,
    );
    this.name = 'VerifyLockHeldError';
    this.holder = holder;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process → dead. EPERM = exists but we can't signal it →
    // treat as alive (conservative: never steal a live holder's lock).
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const UNPARSEABLE_STALE_MS = 10 * 60 * 1000;

export interface AcquireVerifyLockOptions {
  /** Who holds it — surfaced to the loser in the error message. */
  owner: string;
  /**
   * How long to wait for the holder to release before giving up. Default 0 =
   * fail fast. The watch tick passes a few seconds and skips on loss instead
   * of failing; MCP/CLI verifies fail fast.
   */
  timeoutMs?: number;
}

export interface VerifyLock {
  release(): void;
}

/**
 * Test-only: runs after a lock is judged stale, before the steal rename.
 * Lets a unit test inject a competing acquirer in the TOCTOU window.
 */
let beforeStealHook: (() => void) | undefined;
/** @internal */
export function _setBeforeStealHook(fn: (() => void) | undefined): void {
  beforeStealHook = fn;
}

export function acquireVerifyLock(projectRoot: string, opts: AcquireVerifyLockOptions): VerifyLock {
  mkdirSync(resolve(projectRoot, 'node_modules', '.validity'), { recursive: true });
  const path = verifyLockPath(projectRoot);
  const deadline = Date.now() + (opts.timeoutMs ?? 0);

  const contents = (): string =>
    JSON.stringify({
      pid: process.pid,
      owner: opts.owner,
      startedAt: new Date().toISOString(),
    });

  // Create the lock WITH its contents already in place. `openSync('wx')` +
  // `writeSync` leaves a window where the file exists but is empty, and a
  // concurrent loser reading it in that window sees an unparseable holder
  // (pid 0) — seen on CI's slower filesystem. `link(2)` of a fully-written
  // temp file onto the lock path is atomic and exclusive (EEXIST when the
  // lock exists), so readers only ever observe a complete record. Filesystems
  // without hard links fall back to the O_EXCL create.
  const tryCreate = (): boolean => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, contents());
    try {
      linkSync(tmp, path);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw err;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
    }
    // Fallback: O_EXCL create, then write (non-atomic contents).
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return false;
    }
    try {
      writeSync(fd, contents());
    } finally {
      closeSync(fd);
    }
    return true;
  };

  const stealIfStale = (): void => {
    let raw: string | undefined;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return; // vanished between EEXIST and read — just retry the create
    }
    let holder: VerifyLockHolder | undefined;
    try {
      const parsed = JSON.parse(raw) as VerifyLockHolder;
      if (typeof parsed?.pid === 'number') holder = parsed;
    } catch {
      // unparseable below
    }
    if (holder) {
      if (alive(holder.pid)) return;
    } else {
      // Unparseable: only steal when it's old enough that no live writer could
      // be mid-create (the file content is written immediately after O_EXCL).
      let mtime = Date.now();
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        return;
      }
      if (Date.now() - mtime < UNPARSEABLE_STALE_MS) return;
    }
    // Steal by RENAME, not unlink. Two watchers that both saw a dead pid must
    // not both unlink-then-wx: the loser would unlink the winner's FRESH lock
    // and both would hold. rename(2) of the same source is exclusive — exactly
    // one process moves it aside (`${path}.stale.<pid>`); the other gets ENOENT
    // and falls through to tryCreate.
    //
    // After the rename, re-read the stolen bytes: if a live holder created
    // between our read and the rename, we accidentally moved THEIR lock —
    // put it back and abort the steal.
    beforeStealHook?.();
    const stale = `${path}.stale.${process.pid}`;
    try {
      renameSync(path, stale);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    let stolenLive = false;
    try {
      const stolen = JSON.parse(readFileSync(stale, 'utf-8')) as VerifyLockHolder;
      stolenLive = typeof stolen?.pid === 'number' && alive(stolen.pid);
    } catch {
      /* unparseable — we already decided it was old enough to steal */
    }
    if (stolenLive) {
      try {
        renameSync(stale, path);
      } catch {
        /* path already recreated — leave the stale copy */
      }
      return;
    }
    try {
      unlinkSync(stale);
    } catch {
      /* leftover stale sibling is inert */
    }
  };

  const fail = (): never => {
    let holder: VerifyLockHolder = { pid: 0, owner: 'unknown', startedAt: '' };
    // A holder mid-steal (rename-restore window) can be briefly unreadable;
    // retry a few times before reporting zeros rather than crashing.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as VerifyLockHolder;
        if (typeof parsed?.pid === 'number' && parsed.pid > 0) {
          holder = parsed;
          break;
        }
      } catch {
        /* unreadable this instant — retry below */
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    throw new VerifyLockHeldError(holder);
  };

  for (;;) {
    if (tryCreate()) break;
    stealIfStale();
    if (tryCreate()) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) fail();
    // Blocks this thread (the watch tick's event loop when timeoutMs is 3s)
    // by design: better to stall one debounce than to skip a save. If we
    // still lose, the watcher re-queues the skipped paths for the next debounce.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(250, remaining));
  }

  const ours = (): boolean => {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as VerifyLockHolder;
      return parsed.pid === process.pid;
    } catch {
      return false;
    }
  };

  const onExit = (): void => {
    try {
      if (ours()) unlinkSync(path);
    } catch {
      /* best-effort */
    }
  };
  process.once('exit', onExit);

  return {
    release(): void {
      process.removeListener('exit', onExit);
      // Only unlink while the file still names OUR pid — never delete a
      // successor's lock. The read-then-unlink vs a successor is only
      // reachable if OUR pid is already dead (another process stole and
      // rewrote the file); a live holder never observes a foreign pid here.
      try {
        if (ours()) unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
  };
}
