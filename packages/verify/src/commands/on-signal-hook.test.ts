/**
 * On-signal actuation hook (on-signal-hook.ts). Load-bearing invariants:
 * kind filtering (default: regression + needs-(re)scoring), serialization
 * (one process at a time), cooldown (launches spaced, mid-run signals
 * coalesce into ONE next launch), the env contract, and advisory-forever
 * (a spawn failure is a log line, never a throw).
 */
import { describe, expect, it } from 'vitest';
import type { Signal, WatchHookActivity } from '@validity.ai/verify-spec';
import { DEFAULT_HOOK_COOLDOWN_MS, OnSignalHook, type HookSpawn } from './on-signal-hook.js';

function sig(over: Partial<Signal>): Signal {
  return {
    id: 'regression:spec-1:AC-1',
    kind: 'regression',
    severity: 'high',
    specId: 'spec-1',
    criterionId: 'AC-1',
    detail: 'went red',
    at: '2026-01-01T00:00:00.000Z',
    status: 'open',
    ...over,
  };
}

/** Deterministic clock + timer + spawn harness. */
function harness(
  opts: {
    cooldownMs?: number;
    persist?: (h: WatchHookActivity) => void;
    throwPersist?: boolean;
  } = {},
) {
  let now = 0;
  const launches: Array<{ command: string; env: NodeJS.ProcessEnv; exit: () => void }> = [];
  const timers: Array<{ at: number; fn: () => void; canceled: boolean }> = [];
  const logs: string[] = [];
  const persisted: WatchHookActivity[] = [];

  const spawn: HookSpawn = (command, spawnOpts) => {
    const listeners: Array<() => void> = [];
    launches.push({
      command,
      env: spawnOpts.env,
      exit: () => listeners.forEach((l) => l()),
    });
    return { on: (_event, listener) => listeners.push(listener) };
  };

  const persist = opts.throwPersist
    ? (h: WatchHookActivity): void => {
        persisted.push(h);
        throw new Error('disk on fire');
      }
    : (opts.persist ??
      ((h: WatchHookActivity): void => {
        persisted.push(h);
      }));

  const hook = new OnSignalHook({
    projectRoot: '/project',
    command: 'echo drained',
    cooldownMs: opts.cooldownMs,
    spawn,
    now: () => now,
    schedule: (fn, ms) => {
      const t = { at: now + ms, fn, canceled: false };
      timers.push(t);
      return { cancel: () => (t.canceled = true) };
    },
    persist,
    log: (line) => logs.push(line),
  });

  const advance = (ms: number): void => {
    now += ms;
    for (const t of timers.splice(0)) {
      if (!t.canceled && t.at <= now) t.fn();
      else if (!t.canceled) timers.push(t);
    }
  };

  return { hook, launches, logs, persisted, advance, timeNow: () => now };
}

describe('OnSignalHook', () => {
  it('launches immediately for a matching kind with the env contract', () => {
    const h = harness();
    h.hook.notify([sig({})], { score: 87 });
    expect(h.launches).toHaveLength(1);
    const env = h.launches[0]!.env;
    expect(env.VALIDITY_PROJECT_ROOT).toBe('/project');
    expect(env.VALIDITY_SIGNALS_PATH).toContain('signals.json');
    expect(env.VALIDITY_SCORE).toBe('87');
    expect(JSON.parse(env.VALIDITY_NEW_SIGNALS!)).toHaveLength(1);
  });

  it('filters kinds: perf-drift and recovered never launch by default', () => {
    const h = harness();
    h.hook.notify([
      sig({ id: 'perf-drift:spec-1:*', kind: 'perf-drift', severity: 'low' }),
      sig({ id: 'recovered:spec-1:AC-1', kind: 'recovered', severity: 'info' }),
    ]);
    expect(h.launches).toHaveLength(0);
    h.hook.notify([sig({ id: 'needs-scoring:spec-1:AC-2', kind: 'needs-scoring' })]);
    expect(h.launches).toHaveLength(1);
  });

  it('serializes: signals during a run coalesce into ONE next launch', () => {
    const h = harness({ cooldownMs: 0 });
    h.hook.notify([sig({})]);
    expect(h.launches).toHaveLength(1);
    // Two more ticks open signals while the hook is still running.
    h.hook.notify([
      sig({ id: 'needs-scoring:spec-2:AC-1', kind: 'needs-scoring', specId: 'spec-2' }),
    ]);
    h.hook.notify([
      sig({ id: 'needs-rescoring:spec-3:AC-1', kind: 'needs-rescoring', specId: 'spec-3' }),
    ]);
    expect(h.launches).toHaveLength(1); // still running — nothing new spawned
    h.launches[0]!.exit();
    expect(h.launches).toHaveLength(2); // one coalesced follow-up
    expect(JSON.parse(h.launches[1]!.env.VALIDITY_NEW_SIGNALS!)).toHaveLength(2);
  });

  it('cooldown spaces launches; the timer fires the deferred batch', () => {
    const h = harness({ cooldownMs: 10_000 });
    h.hook.notify([sig({})]);
    expect(h.launches).toHaveLength(1);
    h.launches[0]!.exit();
    // New signal 2s later: inside the cooldown window — deferred, not spawned.
    h.advance(2_000);
    h.hook.notify([sig({ id: 'regression:spec-9:AC-1', specId: 'spec-9' })]);
    expect(h.launches).toHaveLength(1);
    // At the 10s boundary the scheduled launch fires.
    h.advance(8_000);
    expect(h.launches).toHaveLength(2);
    expect(JSON.parse(h.launches[1]!.env.VALIDITY_NEW_SIGNALS!)[0].specId).toBe('spec-9');
  });

  it('dedupes the same signal id within a pending batch', () => {
    const h = harness({ cooldownMs: 0 });
    h.hook.notify([sig({})]);
    h.hook.notify([sig({ detail: 'refired while running' })]);
    h.hook.notify([sig({ detail: 'refired again' })]);
    h.launches[0]!.exit();
    expect(h.launches).toHaveLength(2);
    const batch = JSON.parse(h.launches[1]!.env.VALIDITY_NEW_SIGNALS!) as Signal[];
    expect(batch).toHaveLength(1);
    expect(batch[0]!.detail).toBe('refired again');
  });

  it('a spawn failure is a log line, never a throw, and does not wedge', () => {
    const now = 0;
    const logs: string[] = [];
    let calls = 0;
    const hook = new OnSignalHook({
      projectRoot: '/project',
      command: 'boom',
      cooldownMs: 0,
      spawn: () => {
        calls += 1;
        if (calls === 1) throw new Error('ENOENT');
        return { on: () => {} };
      },
      now: () => now,
      schedule: (fn) => {
        fn();
        return { cancel: () => {} };
      },
      log: (l) => logs.push(l),
    });
    expect(() => hook.notify([sig({})])).not.toThrow();
    expect(logs.some((l) => l.includes('failed to launch'))).toBe(true);
    // Not wedged: the next signal can still launch.
    hook.notify([sig({ id: 'regression:spec-2:AC-1', specId: 'spec-2' })]);
    expect(calls).toBe(2);
  });

  it('default cooldown is 5 minutes', () => {
    expect(DEFAULT_HOOK_COOLDOWN_MS).toBe(300_000);
  });

  it('persist is called exactly once per launch with batchSize + cooldownMs', () => {
    const h = harness({ cooldownMs: 7_500 });
    h.hook.notify([
      sig({ id: 'regression:spec-1:AC-1' }),
      sig({ id: 'needs-scoring:spec-2:AC-1', kind: 'needs-scoring', specId: 'spec-2' }),
    ]);
    expect(h.launches).toHaveLength(1);
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]!.batchSize).toBe(2);
    expect(h.persisted[0]!.cooldownMs).toBe(7_500);
    expect(typeof h.persisted[0]!.lastLaunchAt).toBe('string');
    // The exit-callback chain still triggers a follow-up launch; persist
    // fires once for that second launch too (exactly once per launch).
    h.launches[0]!.exit();
    // Inside the cooldown window — the follow-up is deferred, not spawned,
    // and persist has NOT been called a second time yet.
    h.hook.notify([sig({ id: 'regression:spec-3:AC-1', specId: 'spec-3' })]);
    expect(h.launches).toHaveLength(1);
    expect(h.persisted).toHaveLength(1);
    // Cooldown elapses → the scheduled launch fires (and records the second
    // activity).
    h.advance(7_500);
    expect(h.launches).toHaveLength(2);
    expect(h.persisted).toHaveLength(2);
    expect(h.persisted[1]!.batchSize).toBe(1);
  });

  it('persist is NOT called when notify matches no kinds', () => {
    const h = harness();
    h.hook.notify([
      sig({ id: 'perf-drift:spec-1:*', kind: 'perf-drift', severity: 'low' }),
      sig({ id: 'recovered:spec-1:AC-1', kind: 'recovered', severity: 'info' }),
    ]);
    expect(h.launches).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
  });

  it('a throwing persist does not prevent the launch or the exit-callback chain', () => {
    const h = harness({ cooldownMs: 0, throwPersist: true });
    expect(() => h.hook.notify([sig({})])).not.toThrow();
    expect(h.launches).toHaveLength(1);
    expect(h.persisted).toHaveLength(1); // it was invoked (and threw)
    expect(h.logs.some((l) => l.includes('failed to persist hook activity'))).toBe(true);
    // The exit-callback chain still fires the coalesced follow-up launch.
    h.hook.notify([sig({ id: 'regression:spec-2:AC-1', specId: 'spec-2' })]);
    h.launches[0]!.exit();
    expect(h.launches).toHaveLength(2);
    expect(h.persisted).toHaveLength(2);
  });
});
