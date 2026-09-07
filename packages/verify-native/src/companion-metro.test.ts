import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureCompanionMetro,
  killCompanionMetro,
  metroLogLength,
  metroOwnerMarkerPath,
  readMetroOwnerMarker,
  waitForBundleServed,
  writeMetroContentMarker,
  type BundleWaitDeps,
  type KillDeps,
  type MetroDeps,
  type PortOwner,
} from './companion-metro.js';
import { startMetroStep } from './prepare-native-app.js';

/** The pid fakeDeps' spawn reports — port owners default to this (ownership confirmed). */
const SPAWN_PID = 4242;

/**
 * Recording fake deps. `upSequence` is consumed per isUp() call (then sticks at
 * the last). `owners` is what lsof attributes the port to once Metro answers —
 * defaults to the spawned pid so the happy paths confirm ownership; tests pass
 * an alien pid to model a surviving OLD Metro answering /status.
 */
function fakeDeps(
  upSequence: boolean[],
  over: { owners?: PortOwner[]; exitCode?: () => number | null } = {},
): MetroDeps & {
  spawns: Array<{ clearCache: boolean }>;
  kills: number;
  sleeps: number[];
} {
  const seq = [...upSequence];
  let last = false;
  return {
    spawns: [],
    kills: 0,
    sleeps: [],
    async isUp() {
      if (seq.length) last = seq.shift()!;
      return last;
    },
    async kill() {
      this.kills += 1;
      return { terminated: [], escalated: [], survivors: [] };
    },
    async spawn(_appDir: string, clearCache: boolean) {
      this.spawns.push({ clearCache });
      return {
        logPath: '/tmp/validity-native.log',
        pid: SPAWN_PID,
        exitCode: over.exitCode ?? (() => null),
      };
    },
    async portOwners() {
      return over.owners ?? [{ pid: SPAWN_PID, pgid: SPAWN_PID }];
    },
    async sleep(ms: number) {
      this.sleeps.push(ms);
    },
  };
}

const fast = { pollMs: 1, timeoutMs: 50 };

describe('ensureCompanionMetro — content-gated cache reset', () => {
  it('up + content unchanged → no-op (no spawn, no kill)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content');
    writeFileSync(marker, 'abc123');
    const deps = fakeDeps([true]);
    const res = await ensureCompanionMetro(
      dir,
      { contentHash: 'abc123', contentMarkerPath: marker, ...fast },
      deps,
    );
    expect(res).toMatchObject({ started: false, up: true });
    expect(deps.spawns).toHaveLength(0);
    expect(deps.kills).toBe(0);
  });

  it('up + content CHANGED → kills Metro and restarts with --clear, records new hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content');
    writeFileSync(marker, 'OLD');
    // up (initial probe) → up (after restart).
    const deps = fakeDeps([true, true]);
    const res = await ensureCompanionMetro(
      dir,
      { contentHash: 'NEW', contentMarkerPath: marker, ...fast },
      deps,
    );
    expect(res).toMatchObject({ started: true, up: true, restartedForContent: true });
    expect(deps.kills).toBe(1);
    expect(deps.spawns).toEqual([{ clearCache: true }]);
    expect(readFileSync(marker, 'utf-8')).toBe('NEW'); // marker advanced
  });

  it('down + content unchanged → starts WITHOUT --clear (cache still valid)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content');
    writeFileSync(marker, 'same');
    const deps = fakeDeps([false, true]); // down, then up after spawn
    const res = await ensureCompanionMetro(
      dir,
      { contentHash: 'same', contentMarkerPath: marker, ...fast },
      deps,
    );
    expect(res).toMatchObject({ started: true, up: true });
    expect(deps.kills).toBe(0);
    expect(deps.spawns).toEqual([{ clearCache: false }]);
  });

  it('down + no marker yet → starts WITH --clear (content unknown ⇒ assume changed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content'); // does not exist
    const deps = fakeDeps([false, true]);
    const res = await ensureCompanionMetro(
      dir,
      { contentHash: 'fresh', contentMarkerPath: marker, ...fast },
      deps,
    );
    expect(res).toMatchObject({ started: true, up: true, restartedForContent: true });
    expect(deps.spawns).toEqual([{ clearCache: true }]);
  });

  it('legacy: no contentHash → behaves as before (no-op when up, plain start when down)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const upDeps = fakeDeps([true]);
    expect(await ensureCompanionMetro(dir, fast, upDeps)).toMatchObject({
      started: false,
      up: true,
    });
    expect(upDeps.spawns).toHaveLength(0);

    const downDeps = fakeDeps([false, true]);
    await ensureCompanionMetro(dir, fast, downDeps);
    expect(downDeps.spawns).toEqual([{ clearCache: false }]); // never --clear without a hash
  });
});

describe('ensureCompanionMetro — verified restart lifecycle', () => {
  it('probe-then-sleep: an instantly-up Metro pays NO poll sleep at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content');
    writeFileSync(marker, 'same');
    const deps = fakeDeps([false, true]); // down → up on the FIRST post-spawn probe
    const res = await ensureCompanionMetro(
      dir,
      { contentHash: 'same', contentMarkerPath: marker, ...fast },
      deps,
    );
    expect(res.up).toBe(true);
    // The old loop slept pollMs BEFORE the first probe (a guaranteed 3s floor
    // per spawn in production); now the first probe runs immediately.
    expect(deps.sleeps).toEqual([]);
  });

  it('reports a crash-on-boot (early non-zero exit) immediately instead of polling out the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content');
    const deps = fakeDeps([false, false], { exitCode: () => 1 });
    const res = await ensureCompanionMetro(
      dir,
      { contentHash: 'x', contentMarkerPath: marker, ...fast },
      deps,
    );
    expect(res).toMatchObject({ started: true, up: false, earlyExitCode: 1 });
    expect(deps.sleeps).toEqual([]); // exit checked before the first sleep
    // The crash means nothing fresh is serving — the marker must not advance.
    expect(() => readFileSync(marker, 'utf-8')).toThrow();
  });

  it('does NOT persist the marker when /status answers but the port is owned by an ALIEN pid', async () => {
    // The "my edit never took effect" masking bug: old Metro survives the kill,
    // answers /status with STALE content, and the fresh marker used to be
    // written over it — telling every future call the content was delivered.
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content');
    writeFileSync(marker, 'OLD');
    const deps = fakeDeps([true, true], { owners: [{ pid: 999, pgid: 999 }] });
    const res = await ensureCompanionMetro(
      dir,
      { contentHash: 'NEW', contentMarkerPath: marker, ...fast },
      deps,
    );
    expect(deps.kills).toBe(1);
    expect(res).toMatchObject({ started: true, up: true, ownershipUnconfirmed: true });
    // Marker NOT advanced — the next call retries the --clear restart.
    expect(readFileSync(marker, 'utf-8')).toBe('OLD');
  });

  it('records WHICH process is ours, so a later run can spot a hand-started Metro', async () => {
    // A `expo start` launched by hand on 8082 serves the host app's bundle to
    // the companion dev-client: blank screen, every render unconfirmed, looks
    // exactly like a code bug. Telling them apart needs an identity, and the
    // only moment one can be recorded honestly is when lsof has just confirmed
    // the port belongs to THIS spawn.
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content');
    writeFileSync(marker, 'OLD');
    const deps = fakeDeps([true, true], { owners: [{ pid: 7777, pgid: SPAWN_PID }] });
    await ensureCompanionMetro(
      dir,
      { contentHash: 'NEW', contentMarkerPath: marker, ...fast },
      deps,
    );

    const owner = readMetroOwnerMarker(dir)!;
    expect(owner.pid).toBe(SPAWN_PID);
    expect(owner.boundPid).toBe(7777);
    expect(Date.parse(owner.startedAt)).not.toBeNaN();
  });

  it('records NO owner when ownership could not be attributed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content');
    writeFileSync(marker, 'OLD');
    const deps = fakeDeps([true, true], { owners: [{ pid: 999, pgid: 999 }] });
    await ensureCompanionMetro(
      dir,
      { contentHash: 'NEW', contentMarkerPath: marker, ...fast },
      deps,
    );
    expect(readMetroOwnerMarker(dir)).toBeNull();
  });

  it('reads back null for a malformed owner marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    writeFileSync(metroOwnerMarkerPath(dir), '{not json');
    expect(readMetroOwnerMarker(dir)).toBeNull();
  });

  it('confirms ownership via the process GROUP (npx descendant binds the port, not the spawn pid)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content');
    writeFileSync(marker, 'OLD');
    // The detached `npx expo start` spawn is the group leader; the node process
    // that actually binds 8082 is a descendant with pgid === spawn pid.
    const deps = fakeDeps([true, true], { owners: [{ pid: 7777, pgid: SPAWN_PID }] });
    const res = await ensureCompanionMetro(
      dir,
      { contentHash: 'NEW', contentMarkerPath: marker, ...fast },
      deps,
    );
    expect(res).toMatchObject({ started: true, up: true });
    expect(res.ownershipUnconfirmed).toBeUndefined();
    expect(readFileSync(marker, 'utf-8')).toBe('NEW');
  });

  it('keeps polling past an unattributed /status and persists once OUR spawn takes the port over', async () => {
    // lsof can race the new bind (or the old Metro can take a beat to die): the
    // first post-spawn probe sees an alien owner, but the NEXT probe attributes
    // the port to our spawn — ownership confirms late and the marker advances.
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content');
    writeFileSync(marker, 'OLD');
    const deps = fakeDeps([true, true]);
    const ownerSequence: PortOwner[][] = [
      [{ pid: 999, pgid: 999 }], // old Metro still holds the port
      [{ pid: 7777, pgid: SPAWN_PID }], // our spawn's descendant took over
    ];
    deps.portOwners = async () => ownerSequence.shift() ?? [{ pid: 7777, pgid: SPAWN_PID }];
    const res = await ensureCompanionMetro(
      dir,
      { contentHash: 'NEW', contentMarkerPath: marker, ...fast },
      deps,
    );
    expect(res).toMatchObject({ started: true, up: true, restartedForContent: true });
    expect(res.ownershipUnconfirmed).toBeUndefined();
    expect(deps.sleeps.length).toBeGreaterThan(0); // it DID keep polling
    expect(readFileSync(marker, 'utf-8')).toBe('NEW');
  });

  it('legacy (no contentHash) skips the ownership probe entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const deps = fakeDeps([false, true], { owners: [{ pid: 999, pgid: 999 }] });
    let ownerProbes = 0;
    const origOwners = deps.portOwners.bind(deps);
    deps.portOwners = async (port) => {
      ownerProbes += 1;
      return origOwners(port);
    };
    const res = await ensureCompanionMetro(dir, fast, deps);
    expect(res.up).toBe(true);
    expect(ownerProbes).toBe(0); // nothing to persist ⇒ nothing to poison
  });
});

describe('killCompanionMetro — verified SIGTERM → SIGKILL escalation', () => {
  /** A fake process table: liveness (signal 0) tracks what signals landed. */
  function killFakes(opts: { ignoresSigterm: boolean; command?: string }) {
    const signals: Array<{ pid: number; sig: NodeJS.Signals | 0 }> = [];
    let dead = false;
    const deps: KillDeps = {
      listPids: async () => [111],
      commandFor: async () => opts.command ?? 'node /x/node_modules/.bin/expo start',
      signal: (pid, sig) => {
        signals.push({ pid, sig });
        if (sig === 0) {
          if (dead) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
          return;
        }
        if (sig === 'SIGKILL') dead = true;
        if (sig === 'SIGTERM' && !opts.ignoresSigterm) dead = true;
      },
      sleep: async () => {},
    };
    return { deps, signals };
  }
  const fastKill = { termGraceMs: 20, killGraceMs: 20, pollMs: 1 };

  it('a compliant Metro dies on SIGTERM — confirmed via kill(pid, 0), no SIGKILL sent', async () => {
    const { deps, signals } = killFakes({ ignoresSigterm: false });
    const res = await killCompanionMetro(8082, deps, fastKill);
    expect(res).toEqual({ terminated: [111], escalated: [], survivors: [] });
    expect(signals.some((s) => s.sig === 'SIGKILL')).toBe(false);
    // Death was VERIFIED with a liveness probe, not assumed after a sleep.
    expect(signals.some((s) => s.sig === 0)).toBe(true);
  });

  it('a SIGTERM-ignoring Metro is escalated to SIGKILL and confirmed dead', async () => {
    const { deps, signals } = killFakes({ ignoresSigterm: true });
    const res = await killCompanionMetro(8082, deps, fastKill);
    expect(res).toEqual({ terminated: [], escalated: [111], survivors: [] });
    expect(signals.filter((s) => s.sig === 'SIGTERM')).toHaveLength(1);
    expect(signals.filter((s) => s.sig === 'SIGKILL')).toHaveLength(1);
  });

  it('an unkillable pid (survives SIGKILL) is reported as a survivor, never pretended dead', async () => {
    const signals: Array<NodeJS.Signals | 0> = [];
    const deps: KillDeps = {
      listPids: async () => [111],
      commandFor: async () => 'node metro',
      signal: (_pid, sig) => {
        signals.push(sig); // nothing ever dies — signal 0 always succeeds
      },
      sleep: async () => {},
    };
    const res = await killCompanionMetro(8082, deps, fastKill);
    expect(res).toEqual({ terminated: [], escalated: [], survivors: [111] });
    expect(signals).toContain('SIGKILL');
  });

  it('never signals a pid whose command line is not Metro/Expo/Node', async () => {
    const { deps, signals } = killFakes({ ignoresSigterm: false, command: 'com.docker.backend' });
    const res = await killCompanionMetro(8082, deps, fastKill);
    expect(res).toEqual({ terminated: [], escalated: [], survivors: [] });
    expect(signals).toHaveLength(0);
  });
});

describe('waitForBundleServed — observable cold-open readiness', () => {
  function bundleFakes(initial: string) {
    let log = initial;
    const sleeps: number[] = [];
    const deps: BundleWaitDeps = {
      readLog: () => log,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };
    return { deps, sleeps, append: (s: string) => (log += s) };
  }

  it('resolves true as soon as a "Bundled" line lands after the offset', async () => {
    const { deps, sleeps, append } = bundleFakes('boot noise\n');
    const offset = 'boot noise\n'.length;
    // The line appears on the THIRD poll — the wait keeps tailing until then.
    const origSleep = deps.sleep;
    deps.sleep = async (ms) => {
      await origSleep(ms);
      if (sleeps.length === 3) {
        append('iOS Bundled 6243ms node_modules/expo/AppEntry.js (657 modules)\n');
      }
    };
    const ok = await waitForBundleServed(
      { logPath: '/x/validity-native.log', sinceOffset: offset, capMs: 2_000, pollMs: 1 },
      deps,
    );
    expect(ok).toBe(true);
    expect(sleeps).toHaveLength(3);
  });

  it('a PREVIOUS session\'s "Bundled" line (before the offset) cannot satisfy the wait', async () => {
    const stale = 'iOS Bundled 100ms (old session)\n';
    const { deps } = bundleFakes(stale);
    const ok = await waitForBundleServed(
      { logPath: '/x/log', sinceOffset: stale.length, capMs: 20, pollMs: 1 },
      deps,
    );
    expect(ok).toBe(false); // capped out — nothing NEW was bundled
  });

  it('probe-then-sleep: an already-served bundle resolves on the first read, zero sleeps', async () => {
    const { deps, sleeps } = bundleFakes('Android Bundled 900ms index.js (12 modules)\n');
    const ok = await waitForBundleServed({ logPath: '/x/log', capMs: 2_000, pollMs: 50 }, deps);
    expect(ok).toBe(true);
    expect(sleeps).toEqual([]);
  });

  it('returns false immediately on "Bundling failed" (the render machinery reports the rest)', async () => {
    const { deps, sleeps } = bundleFakes('iOS Bundling failed 412ms\n');
    const ok = await waitForBundleServed({ logPath: '/x/log', capMs: 2_000, pollMs: 50 }, deps);
    expect(ok).toBe(false);
    expect(sleeps).toEqual([]);
  });

  it('metroLogLength returns the current offset (0 for a missing log)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const log = join(dir, 'validity-native.log');
    expect(metroLogLength(log)).toBe(0); // missing
    writeFileSync(log, 'hello\n');
    expect(metroLogLength(log)).toBe('hello\n'.length);
  });
});

describe('startMetroStep / writeMetroContentMarker', () => {
  it('startMetroStep appends --clear only when clearCache is set', () => {
    expect(startMetroStep('/app').args).not.toContain('--clear');
    expect(startMetroStep('/app', { clearCache: true }).args).toContain('--clear');
  });

  it('writeMetroContentMarker round-trips and never throws on a bad path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-'));
    const marker = join(dir, '.validity-metro-content');
    writeMetroContentMarker(marker, 'deadbeef');
    expect(readFileSync(marker, 'utf-8')).toBe('deadbeef');
    expect(() => writeMetroContentMarker('/no/such/dir/marker', 'x')).not.toThrow();
  });
});
