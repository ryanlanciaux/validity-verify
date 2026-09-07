/**
 * Watch high-water mark (watch-state.ts). Load-bearing behaviors: tolerant
 * reads (missing/corrupt/wrong-version ⇒ null, never a throw), roundtrip,
 * and best-effort writes that create `.validity/` on demand.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadWatchState,
  recordHookActivity,
  saveWatchState,
  watchStatePath,
} from './watch-state.js';
import type { WatchHookActivity } from './watch-state.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'validity-watch-state-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('loadWatchState', () => {
  it('returns null when the file is missing', () => {
    expect(loadWatchState(root)).toBeNull();
  });

  it('returns null on corrupt JSON', () => {
    mkdirSync(join(root, '.validity'), { recursive: true });
    writeFileSync(watchStatePath(root), '{ not json');
    expect(loadWatchState(root)).toBeNull();
  });

  it('returns null on a wrong version or wrong-typed sha', () => {
    mkdirSync(join(root, '.validity'), { recursive: true });
    writeFileSync(watchStatePath(root), JSON.stringify({ version: 2, lastObservedSha: 'abc' }));
    expect(loadWatchState(root)).toBeNull();
    writeFileSync(watchStatePath(root), JSON.stringify({ version: 1, lastObservedSha: 42 }));
    expect(loadWatchState(root)).toBeNull();
  });
});

describe('saveWatchState', () => {
  it('roundtrips and creates .validity/ on demand', () => {
    saveWatchState(root, {
      version: 1,
      lastObservedSha: 'deadbeef',
      lastTickAt: '2026-01-01T00:00:00.000Z',
    });
    expect(loadWatchState(root)).toEqual({
      version: 1,
      lastObservedSha: 'deadbeef',
      lastTickAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('overwrites a prior mark', () => {
    saveWatchState(root, { version: 1, lastObservedSha: 'aaa' });
    saveWatchState(root, { version: 1, lastObservedSha: 'bbb' });
    expect(loadWatchState(root)?.lastObservedSha).toBe('bbb');
    // The file is real JSON on disk, not an in-memory artifact.
    expect(readFileSync(watchStatePath(root), 'utf-8')).toContain('bbb');
  });

  it('preserves a previously recorded hook when the state has no hook field', () => {
    const hook: WatchHookActivity = {
      lastLaunchAt: '2026-07-04T12:00:00.000Z',
      batchSize: 3,
      cooldownMs: 300_000,
    };
    recordHookActivity(root, hook);
    // watch.ts stamps a fresh high-water mark each tick with no `hook` field —
    // the hook activity recorded by the on-signal hook must survive it.
    saveWatchState(root, {
      version: 1,
      lastObservedSha: 'deadbeef',
      lastTickAt: '2026-07-04T12:01:00.000Z',
    });
    expect(loadWatchState(root)).toEqual({
      version: 1,
      lastObservedSha: 'deadbeef',
      lastTickAt: '2026-07-04T12:01:00.000Z',
      hook,
    });
  });

  it('an explicit hook on saveWatchState overwrites the prior one', () => {
    recordHookActivity(root, {
      lastLaunchAt: '2026-07-04T12:00:00.000Z',
      batchSize: 1,
      cooldownMs: 300_000,
    });
    const next: WatchHookActivity = {
      lastLaunchAt: '2026-07-04T13:00:00.000Z',
      batchSize: 9,
      cooldownMs: 60_000,
    };
    saveWatchState(root, { version: 1, lastObservedSha: 'sha', hook: next });
    expect(loadWatchState(root)?.hook).toEqual(next);
  });
});

describe('recordHookActivity', () => {
  it('creates state with version 1 and does not clobber the high-water mark', () => {
    saveWatchState(root, {
      version: 1,
      lastObservedSha: 'cafe',
      lastTickAt: '2026-07-04T11:00:00.000Z',
    });
    recordHookActivity(root, {
      lastLaunchAt: '2026-07-04T12:00:00.000Z',
      batchSize: 2,
      cooldownMs: 300_000,
    });
    const state = loadWatchState(root);
    expect(state?.version).toBe(1);
    expect(state?.lastObservedSha).toBe('cafe');
    expect(state?.lastTickAt).toBe('2026-07-04T11:00:00.000Z');
    expect(state?.hook).toEqual({
      lastLaunchAt: '2026-07-04T12:00:00.000Z',
      batchSize: 2,
      cooldownMs: 300_000,
    });
  });

  it('on a missing file creates state with version 1 and no mark clobber', () => {
    recordHookActivity(root, {
      lastLaunchAt: '2026-07-04T12:00:00.000Z',
      batchSize: 4,
      cooldownMs: 120_000,
    });
    const state = loadWatchState(root);
    expect(state?.version).toBe(1);
    // No high-water mark invented out of thin air.
    expect(state?.lastObservedSha).toBeUndefined();
    expect(state?.lastTickAt).toBeUndefined();
    expect(state?.hook?.batchSize).toBe(4);
  });

  it('never throws on a corrupt file', () => {
    mkdirSync(join(root, '.validity'), { recursive: true });
    writeFileSync(watchStatePath(root), '{ not json');
    expect(() =>
      recordHookActivity(root, {
        lastLaunchAt: '2026-07-04T12:00:00.000Z',
        batchSize: 1,
        cooldownMs: 300_000,
      }),
    ).not.toThrow();
    // A fresh state is written over the corrupt file, version 1 + the hook.
    expect(loadWatchState(root)?.hook?.batchSize).toBe(1);
  });
});
