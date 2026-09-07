/**
 * Browse server lock file — small JSON record at
 * `node_modules/.validity/.browse.lock` so:
 *
 *   1. `validity browse` refuses to double-boot on top of itself (and
 *      tells the user where the live server is).
 *   2. `validity__verify` (or `renderComponents` directly) can detect a
 *      live browse server and reuse it instead of cold-starting Vite —
 *      shaving 2-3s off every verify the user runs while iterating.
 *
 * Liveness check: `process.kill(pid, 0)` — signal 0 is the POSIX "is
 * this pid alive?" probe. Throws ESRCH (no such process) when dead,
 * EPERM when alive but owned by another user (we treat EPERM as
 * "alive" — close enough; the user isn't going to share a `.validity/`
 * across UIDs in practice).
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validityDir } from '../paths.js';

export interface BrowseLock {
  pid: number;
  port: number;
  /** ISO timestamp; surfaced in CLI messages so the user can spot stale-looking locks. */
  startedAt: string;
}

export function browseLockPath(projectRoot: string): string {
  return resolve(validityDir(projectRoot), '.browse.lock');
}

export function readBrowseLock(projectRoot: string): BrowseLock | null {
  const path = browseLockPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BrowseLock>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.startedAt !== 'string'
    ) {
      return null;
    }
    return { pid: parsed.pid, port: parsed.port, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

export function writeBrowseLock(projectRoot: string, lock: BrowseLock): void {
  writeFileSync(browseLockPath(projectRoot), JSON.stringify(lock, null, 2));
}

export function deleteBrowseLock(projectRoot: string): void {
  const path = browseLockPath(projectRoot);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best-effort — a stale lock is recoverable next boot
    }
  }
}

/**
 * Probe the lock's pid. Returns the lock if the process is alive, null
 * otherwise. Side effect: deletes the lock file if the pid is dead — so
 * callers don't have to clean up after a previous crash.
 */
export function readLiveBrowseLock(projectRoot: string): BrowseLock | null {
  const lock = readBrowseLock(projectRoot);
  if (!lock) return null;
  try {
    process.kill(lock.pid, 0);
    return lock;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = process exists, owned by another user. Treat as alive.
    if (code === 'EPERM') return lock;
    // ESRCH = no such pid. Lock is stale; clean it up.
    deleteBrowseLock(projectRoot);
    return null;
  }
}
