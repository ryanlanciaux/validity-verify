/**
 * Durable watch high-water mark — `.validity/watch-state.json`.
 *
 * Per-machine DERIVED state (gitignored, like scorecard.json/signals.json):
 * records the last commit a watch tick actually observed, so the watcher can
 * catch up on everything that landed while it wasn't looking (restart, pull,
 * rebase, laptop-was-closed) instead of only seeing live chokidar events.
 *
 * Contract:
 *   - the mark advances ONLY after a tick completes successfully — a skipped
 *     tick (corrupt scorecard guard) leaves the commits "unobserved" so
 *     they're retried on the next tick;
 *   - a missing/corrupt file means "no mark" and the caller falls back to a
 *     full tick — tolerant reads, best-effort writes, never a throw.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureDir, validityDir } from './runs.js';
import { writeFileAtomic } from './util.js';

export interface WatchState {
  version: 1;
  /** Git HEAD sha as of the last successfully completed watch tick. */
  lastObservedSha?: string;
  /** ISO timestamp of that tick. */
  lastTickAt?: string;
  /** Most recent on-signal hook launch. */
  hook?: WatchHookActivity;
}

/**
 * Persisted activity for the on-signal hook, so a later `verify --all`
 * can show last launch / cooldown without IPC to a previous process.
 */
export interface WatchHookActivity {
  /** ISO timestamp of the last hook launch (when spawn succeeded). */
  lastLaunchAt: string;
  /** Number of signals in that launch's batch (signals that crossed the gate). */
  batchSize: number;
  /** Configured cooldown in ms, so a viewer can compute cooling-down vs idle. */
  cooldownMs: number;
}

export function watchStatePath(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'watch-state.json');
}

/** Tolerant read: missing, unparsable, or wrong-shaped file ⇒ null. */
export function loadWatchState(projectRoot: string): WatchState | null {
  const path = watchStatePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as WatchState;
    if (parsed?.version !== 1) return null;
    if (parsed.lastObservedSha !== undefined && typeof parsed.lastObservedSha !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Best-effort write — the mark is a convenience, never a source of truth.
 *
 * `watch.ts` stamps the high-water mark each tick with a fresh
 * `{version, lastObservedSha, lastTickAt}` object and must not erase hook
 * activity recorded by `recordHookActivity`; when `state.hook` is undefined
 * we therefore carry forward the `hook` field from the existing on-disk file
 * (tolerant read — a missing/corrupt file means "no hook to carry").
 */
export function saveWatchState(projectRoot: string, state: WatchState): void {
  try {
    ensureDir(validityDir(projectRoot));
    const existing = loadWatchState(projectRoot);
    const merged: WatchState = { ...state, hook: state.hook ?? existing?.hook };
    writeFileAtomic(watchStatePath(projectRoot), JSON.stringify(merged, null, 2) + '\n');
  } catch {
    // Non-fatal: next tick simply re-observes a wider range.
  }
}

/**
 * Record an on-signal hook launch so the dashboard can show "last launch /
 * cooldown". Tolerant reads + best-effort writes, never throws (the hook is
 * advisory forever and persistence must not affect launching). Preserves the
 * existing high-water mark (lastObservedSha/lastTickAt) and any prior hook.
 */
export function recordHookActivity(projectRoot: string, hook: WatchHookActivity): void {
  try {
    const existing = loadWatchState(projectRoot);
    const state: WatchState = existing ?? { version: 1 };
    state.hook = hook;
    saveWatchState(projectRoot, state);
  } catch {
    // Non-fatal: dashboard simply shows a stale "last launch" until the next one.
  }
}
