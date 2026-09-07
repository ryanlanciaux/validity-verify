import { describe, expect, it, vi } from 'vitest';
import {
  CLEAR_AGENT_DEVICE_STATE,
  DEFAULT_DECAY_THRESHOLDS,
  DEV_MENU_DIAGNOSIS_ANCHORS,
  agentDeviceClaimsDir,
  classifyDeviceClaim,
  daemonEpochStartMs,
  describeReleasedClaims,
  readDeviceClaims,
  releaseStaleDeviceClaims,
  detectBridgePlatformMismatch,
  detectAnrDialog,
  detectDevSurface,
  detectDeviceNotReady,
  detectForeignMetro,
  detectMetroDecay,
  detectPhantomClaim,
  detectSessionDecay,
  detectStaleAgentDevice,
  detectStaleDeviceClaim,
  diagnoseDaemon,
  detectNoNativeSession,
  diagnoseNativeEnvironment,
  diagnosePhantomClaimState,
  diagnoseUpstreamError,
  doctorFindings,
  formatDiagnosis,
  fullSessionResetCommand,
  MAX_ADVISORY_FINDINGS,
  parseAgentDeviceDoctorJson,
  parseAgentDeviceError,
  probeAgentDeviceDoctor,
  summarizeAgentDeviceDoctor,
  parseDaemonStartTime,
  parseInUseSessionName,
  probeAgentDeviceDaemon,
  probeMetroPortOwners,
  sessionCommandsAnswered,
  sessionListEmpty,
  sessionListHasSession,
  snapshotIsBlank,
  METRO_CONTENT_MARKER_NAME,
  type DeviceClaim,
  type DeviceClaimState,
  type DiagnosisFs,
} from './environment-diagnosis.js';
import { summarizeSessionHealth, type SessionHealth } from './session-metrics.js';
import { DEV_MENU_ANCHOR_LABELS, type ExecResult } from './agent-device-driver.js';

/** The verbatim text agent-device prints when a claim blocks an open. */
const IN_USE = `Error (COMMAND_FAILED): Device is already in use by session 'default'`;
const EMPTY_SESSIONS = `{\n  "sessions": []\n}`;

/** A fake filesystem over a plain map of path → contents / dir → entries. */
function fakeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): DiagnosisFs {
  return {
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return files[p]!;
    },
    readDir: (p) => {
      if (!(p in dirs)) throw new Error(`ENOENT ${p}`);
      return dirs[p]!;
    },
    // A directory "exists" when anything is registered at or under it.
    exists: (p) =>
      p in files ||
      p in dirs ||
      [...Object.keys(files), ...Object.keys(dirs)].some((k) => k.startsWith(`${p}/`)),
  };
}

const STATE = '/fake/.agent-device';
const health = (over: Partial<SessionHealth> = {}): SessionHealth => ({
  count: 0,
  consecutiveUnconfirmed: 0,
  openCallCount: 0,
  ...over,
});

describe('detectPhantomClaim', () => {
  it('names the phantom claim when open says "in use" and no session exists', () => {
    const d = detectPhantomClaim(IN_USE, EMPTY_SESSIONS)!;
    expect(d.cause).toBe('phantom-device-claim');
    expect(d.confidence).toBe('confirmed');
    // The symptom must quote what the developer saw, including the session name.
    expect(d.symptom).toContain("'default'");
    expect(d.symptom).toContain('session list');
    // The fix is the only thing that clears it: kill the daemon, drop the state.
    expect(d.fixCommand).toContain('daemon.json');
    expect(d.fixCommand).toContain('$HOME/.agent-device/sessions');
    expect(d.fixCommand).toContain('$HOME/.agent-device/device-claims');
  });

  it('does NOT fire when a session really does hold the device', () => {
    const list = `{"sessions":[{"id":"cwd:abc:default"}]}`;
    expect(detectPhantomClaim(IN_USE, list)).toBeUndefined();
  });

  it('does NOT fire when the session list is unreadable — unknown is not broken', () => {
    expect(detectPhantomClaim(IN_USE, 'agent-device: command not found')).toBeUndefined();
    expect(detectPhantomClaim(IN_USE, '')).toBeUndefined();
    expect(detectPhantomClaim(IN_USE, undefined)).toBeUndefined();
  });

  it('does NOT fire for an unrelated open failure', () => {
    expect(
      detectPhantomClaim('Error: /system/bin/sh: -p: inaccessible', EMPTY_SESSIONS),
    ).toBeUndefined();
  });

  it('matches the message whatever quoting or casing agent-device uses', () => {
    expect(
      detectPhantomClaim('Device is ALREADY IN USE BY SESSION "default"', EMPTY_SESSIONS),
    ).toBeDefined();
  });
});

describe('sessionListEmpty', () => {
  it('is true only for a parsed, empty sessions array', () => {
    expect(sessionListEmpty(EMPTY_SESSIONS)).toBe(true);
    expect(sessionListEmpty('{"sessions":[{}]}')).toBe(false);
    expect(sessionListEmpty('{}')).toBe(false);
    expect(sessionListEmpty('not json')).toBe(false);
    expect(sessionListEmpty(undefined)).toBe(false);
  });
});

/**
 * Claim-file classification. The whole reason this exists: `session list` reads
 * the daemon's MEMORY, so a daemon that exited since the last run answers
 * `{"sessions":[]}` while the claim file it wrote is still on disk. Pairing a
 * raw claim COUNT with that empty list therefore fires on a healthy machine —
 * once per native verify, by construction. Only the OWNER's liveness separates
 * a phantom from a claim that is simply between daemons.
 */
describe('classifyDeviceClaim', () => {
  const claimJson = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      schemaVersion: 1,
      deviceKey: 'local:ios:iphoneos:ABC',
      device: { platform: 'ios', id: 'ABC', name: 'iPhone 15', kind: 'simulator' },
      session: 'cwd:9c96d7bf5deaeb65:default',
      stateDir: '/fake/.agent-device/sessions/cwd_9c96d7bf5deaeb65_default',
      ownerPid: 4242,
      ownerStartTime: 'Wed Jul 29 10:25:02 2026',
      createdAtMs: 1,
      updatedAtMs: 1,
      ...over,
    });

  /** An fs where the session state dir the claim names is present. */
  const withStateDir: DiagnosisFs = {
    readFile: () => '',
    readDir: () => [],
    exists: () => true,
  };

  it('is LIVE when the owner pid answers', () => {
    const c = classifyDeviceClaim('/c/a.json', claimJson(), {
      fs: withStateDir,
      isPidAlive: () => true,
    });
    expect(c.state).toBe('live');
    expect(c.ownerPid).toBe(4242);
    expect(c.device).toBe('iPhone 15');
  });

  it('is STALE when the owner pid is gone, and names it', () => {
    const c = classifyDeviceClaim('/c/a.json', claimJson(), { isPidAlive: () => false });
    expect(c.state).toBe('stale');
    expect(c.reason).toBe('owner-process-dead');
    expect(c.ownerPid).toBe(4242);
  });

  it('is STALE when the session state dir the claim names is gone', () => {
    const c = classifyDeviceClaim('/c/a.json', claimJson(), {
      fs: { readFile: () => '', readDir: () => [], exists: () => false },
      isPidAlive: () => true,
    });
    expect(c.state).toBe('stale');
    expect(c.reason).toBe('owner-state-dir-gone');
  });

  it('is UNKNOWN for corrupt JSON, a non-object, or a missing owner pid', () => {
    expect(classifyDeviceClaim('/c/a.json', '{not json').state).toBe('unknown');
    expect(classifyDeviceClaim('/c/a.json', '"a string"').state).toBe('unknown');
    expect(classifyDeviceClaim('/c/a.json', claimJson({ ownerPid: 'nope' })).state).toBe('unknown');
    expect(classifyDeviceClaim('/c/a.json', undefined).state).toBe('unknown');
  });

  it('treats an unprobeable pid as LIVE — a broken probe must never delete a claim', () => {
    const c = classifyDeviceClaim('/c/a.json', claimJson(), {
      fs: withStateDir,
      isPidAlive: () => {
        throw new Error('EPERM');
      },
    });
    expect(c.state).toBe('live');
  });

  it('does not call a claim stale on an exists() that throws', () => {
    const c = classifyDeviceClaim('/c/a.json', claimJson(), {
      fs: {
        readFile: () => '',
        readDir: () => [],
        exists: () => {
          throw new Error('EACCES');
        },
      },
      isPidAlive: () => true,
    });
    expect(c.state).toBe('live');
  });

  it('falls back to deviceKey when the claim carries no device name', () => {
    const c = classifyDeviceClaim('/c/a.json', claimJson({ device: {} }), {
      fs: withStateDir,
      isPidAlive: () => true,
    });
    expect(c.device).toBe('local:ios:iphoneos:ABC');
  });
});

describe('readDeviceClaims', () => {
  const CLAIMS = `${STATE}/device-claims`;
  const claim = (pid: number): string => JSON.stringify({ ownerPid: pid, deviceKey: 'k' });

  it('reads and classifies every claim file, skipping dotfiles', () => {
    const claims = readDeviceClaims({
      stateDir: STATE,
      fs: fakeFs(
        { [`${CLAIMS}/a.json`]: claim(1), [`${CLAIMS}/b.json`]: claim(2) },
        { [CLAIMS]: ['a.json', 'b.json', '.DS_Store'] },
      ),
      isPidAlive: (pid) => pid === 1,
    });
    expect(claims.map((c) => c.state)).toEqual(['live', 'stale']);
    expect(claims[1]!.path).toBe(`${CLAIMS}/b.json`);
  });

  it('honors $AGENT_DEVICE_CLAIMS_DIR', () => {
    const elsewhere = '/elsewhere/claims';
    const claims = readDeviceClaims({
      stateDir: STATE,
      env: { AGENT_DEVICE_CLAIMS_DIR: elsewhere },
      fs: fakeFs({ [`${elsewhere}/a.json`]: claim(9) }, { [elsewhere]: ['a.json'] }),
      isPidAlive: () => false,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]!.path).toBe(`${elsewhere}/a.json`);
    expect(agentDeviceClaimsDir(STATE, { AGENT_DEVICE_CLAIMS_DIR: ` ${elsewhere} ` })).toBe(
      elsewhere,
    );
  });

  it('is an empty list when the directory cannot be read — never a diagnosis', () => {
    expect(readDeviceClaims({ stateDir: STATE, fs: fakeFs({}) })).toEqual([]);
  });

  it('reports a claim whose file cannot be read as unknown, not as absent', () => {
    const claims = readDeviceClaims({
      stateDir: STATE,
      fs: {
        readFile: () => {
          throw new Error('EACCES');
        },
        readDir: () => ['a.json'],
        exists: () => true,
      },
    });
    expect(claims.map((c) => c.state)).toEqual(['unknown']);
  });
});

describe('releaseStaleDeviceClaims', () => {
  const stale = (path: string): DeviceClaim => ({
    path,
    state: 'stale',
    reason: 'owner-process-dead',
    ownerPid: 77,
    device: 'iPhone 15',
  });

  it('deletes stale claim files ONE at a time and leaves live/unknown alone', () => {
    const removed: string[] = [];
    const fs: DiagnosisFs = {
      readFile: () => '',
      readDir: () => [],
      exists: () => true,
      removeFile: (p) => removed.push(p),
    };
    const out = releaseStaleDeviceClaims(
      [
        stale('/c/a.json'),
        { path: '/c/b.json', state: 'live' },
        { path: '/c/c.json', state: 'unknown' },
      ],
      fs,
    );
    expect(removed).toEqual(['/c/a.json']);
    expect(out.released.map((c) => c.path)).toEqual(['/c/a.json']);
    expect(out.failed).toEqual([]);
  });

  it('reports a delete that fails instead of throwing', () => {
    const fs: DiagnosisFs = {
      readFile: () => '',
      readDir: () => [],
      exists: () => true,
      removeFile: () => {
        throw new Error('EPERM');
      },
    };
    const out = releaseStaleDeviceClaims([stale('/c/a.json')], fs);
    expect(out.released).toEqual([]);
    expect(out.failed).toHaveLength(1);
  });

  it('releases nothing through an fs with no write seam', () => {
    const out = releaseStaleDeviceClaims([stale('/c/a.json')], fakeFs({}));
    expect(out.released).toEqual([]);
    expect(out.failed).toHaveLength(1);
  });

  it('names the owner in the note it produces', () => {
    expect(describeReleasedClaims([stale('/c/a.json')])).toContain('pid 77');
    expect(describeReleasedClaims([stale('/c/a.json')])).toContain('iPhone 15');
    expect(describeReleasedClaims([])).toBe('');
  });
});

describe('diagnosePhantomClaimState', () => {
  const claim = (state: DeviceClaimState, over: Partial<DeviceClaim> = {}): DeviceClaim => ({
    path: '/c/a.json',
    state,
    ...over,
  });

  it('fires when a claim with no live owner is held and no session is listed', () => {
    const d = diagnosePhantomClaimState(
      [claim('stale', { reason: 'owner-process-dead', ownerPid: 4242 })],
      EMPTY_SESSIONS,
    )!;
    expect(d.cause).toBe('phantom-device-claim');
    expect(d.symptom).toContain('4242');
  });

  it('fires for an UNREADABLE claim — diagnosed, since it cannot be auto-released', () => {
    expect(diagnosePhantomClaimState([claim('unknown')], EMPTY_SESSIONS)?.cause).toBe(
      'phantom-device-claim',
    );
  });

  it('stays SILENT for a live claim with an empty session list', () => {
    // The daemon-restart state Validity produces on every native run: the
    // session's daemon exited, so `session list` is empty, but the claim's
    // owner is alive. Nothing is wrong, and the open-time detector is the
    // backstop if it turns out something is.
    expect(
      diagnosePhantomClaimState([claim('live', { ownerPid: 7 })], EMPTY_SESSIONS),
    ).toBeUndefined();
  });

  it('stays silent with no claims, or with live sessions', () => {
    expect(diagnosePhantomClaimState([], EMPTY_SESSIONS)).toBeUndefined();
    expect(
      diagnosePhantomClaimState([claim('stale'), claim('unknown')], '{"sessions":[{"id":"x"}]}'),
    ).toBeUndefined();
  });
});

describe('detectStaleDeviceClaim', () => {
  // The state captured live on 2026-07-28: `close` printed `Closed: default`,
  // the next `open` was refused naming `default`, and `session list` still
  // listed a bare `default` session (state dir ~/.agent-device/sessions/default)
  // beside the cwd-scoped `cwd_<hash>_default` one the CLI was writing to.
  const STALE_LIST = `{"sessions":[
    {"name":"cwd_9c96d7bf5deaeb65_default","stateDir":"/Users/x/.agent-device/sessions/cwd_9c96d7bf5deaeb65_default"},
    {"name":"default","stateDir":"/Users/x/.agent-device/sessions/default"}
  ]}`;

  it('names the stale claim and fixes it with a close BY NAME — no daemon kill', () => {
    const d = detectStaleDeviceClaim(IN_USE, STALE_LIST)!;
    expect(d.cause).toBe('stale-device-claim');
    expect(d.confidence).toBe('confirmed');
    expect(d.symptom).toContain("'default'");
    expect(d.fixCommand).toBe('agent-device close --session default');
    // The heavier phantom remedy must not leak into this one.
    expect(d.fixCommand).not.toContain('kill');
    expect(d.fixCommand).not.toContain('rm -rf');
  });

  it('identifies the session by its state dir when the entry carries no name', () => {
    const list = `{"sessions":[{"stateDir":"/Users/x/.agent-device/sessions/default"}]}`;
    expect(detectStaleDeviceClaim(IN_USE, list)?.cause).toBe('stale-device-claim');
  });

  it('leaves an EMPTY session list to the phantom-claim probe', () => {
    // Empty list + in-use refusal is the daemon-kill state, not this one.
    expect(detectStaleDeviceClaim(IN_USE, EMPTY_SESSIONS)).toBeUndefined();
    expect(detectPhantomClaim(IN_USE, EMPTY_SESSIONS)?.cause).toBe('phantom-device-claim');
  });

  it('does NOT fire when only the cwd-scoped session is listed', () => {
    // `cwd_9c96d7bf5deaeb65_default` CONTAINS "default": a substring match here
    // would call every ordinary session a stale claim and send developers to
    // close the session they are working in.
    const list = `{"sessions":[{"name":"cwd_9c96d7bf5deaeb65_default"}]}`;
    expect(detectStaleDeviceClaim(IN_USE, list)).toBeUndefined();
  });

  it('says nothing when the list is unreadable — unknown is not broken', () => {
    expect(detectStaleDeviceClaim(IN_USE, 'agent-device: command not found')).toBeUndefined();
    expect(detectStaleDeviceClaim(IN_USE, '{}')).toBeUndefined();
    expect(detectStaleDeviceClaim(IN_USE, '')).toBeUndefined();
    expect(detectStaleDeviceClaim(IN_USE, undefined)).toBeUndefined();
  });

  it('says nothing for a refusal that names no session, or an unrelated failure', () => {
    expect(
      detectStaleDeviceClaim('Device is already in use by session', STALE_LIST),
    ).toBeUndefined();
    expect(
      detectStaleDeviceClaim('Error: /system/bin/sh: -p: inaccessible', STALE_LIST),
    ).toBeUndefined();
  });
});

describe('detectNoNativeSession', () => {
  // The captured 2026-07-29 signature: a COLD agent-device daemon at sweep
  // start (`doctor` said "Not running", `session list` empty) while the
  // companion app — and therefore Validity's control bridge — was still warm
  // from an earlier session. The bridge acked renders, no `agent-device open`
  // ever ran, and seven consecutive specs came back `cause: unknown`.
  const SESSION_NOT_FOUND = `Error (SESSION_NOT_FOUND): No active session. Run open first.`;

  it('fires on agent-device SESSION_NOT_FOUND, with a confirmed verdict', () => {
    const d = detectNoNativeSession(SESSION_NOT_FOUND);
    expect(d?.cause).toBe('no-native-session');
    expect(d?.confidence).toBe('confirmed');
    expect(d?.fixCommand).toContain('agent-device open');
  });

  it("fires on iOS's differently-worded refusal and on the bare code", () => {
    // Three phrasings ship in agent-device 0.20.1 for the same state.
    expect(
      detectNoNativeSession(
        'iOS snapshot requires an active app session on the target device. Run open first (for ' +
          'example: open --session sim --platform ios --device …)',
      )?.cause,
    ).toBe('no-native-session');
    expect(detectNoNativeSession('Error (SESSION_NOT_FOUND)')?.cause).toBe('no-native-session');
    expect(detectNoNativeSession('perf requires an active session. Run open first.')?.cause).toBe(
      'no-native-session',
    );
  });

  it('fires on the readiness gate alone — but only as a SUSPICION', () => {
    // CONTRACT CHANGE (2026-07-29). This assertion used to demand `confirmed`,
    // and that contract was wrong: `ready:false` only means "THIS process did
    // not get a 0 out of `agent-device open`". The `establishedSessions`
    // registry is process-wide, so a session opened by an earlier invocation in
    // the same cwd is invisible to it, and an `open` that merely timed out
    // against a live session is indistinguishable from one that never
    // happened. Measured: during the Metro-decay collapse this fired
    // `confirmed` for all ten specs of a sweep while `agent-device appstate`
    // and `agent-device snapshot -i` both exited 0 against that very session.
    // The cause is still worth naming; the certainty was not earned.
    const d = detectNoNativeSession(undefined, { sessionEstablished: false });
    expect(d?.cause).toBe('no-native-session');
    expect(d?.confidence).toBe('suspected');
  });

  it('is CONFIRMED once a second observation corroborates the gate', () => {
    // A cold daemon with no sessions on disk, or the device saying so itself.
    expect(
      detectNoNativeSession(undefined, {
        sessionEstablished: false,
        daemon: { state: 'not-running', claimCount: 0, sessionDirCount: 0 },
      })?.confidence,
    ).toBe('confirmed');
    expect(
      detectNoNativeSession(SESSION_NOT_FOUND, { sessionEstablished: false })?.confidence,
    ).toBe('confirmed');
  });

  // ---- 2026-07-29: the loudest wrong answer in the engine ------------------
  it('STAYS SILENT when a session-scoped command answered in the same pass', () => {
    // The Metro-decay collapse, exactly: the gate reported no session while the
    // snapshot came back normally. Telling the developer to run `agent-device
    // open` there is a fix that cannot help, printed as a verdict.
    expect(
      detectNoNativeSession(undefined, { sessionEstablished: false, sessionAnswered: true }),
    ).toBeUndefined();
    // …and it must not be rescued by the daemon looking cold, either.
    expect(
      detectNoNativeSession(undefined, {
        sessionEstablished: false,
        sessionAnswered: true,
        daemon: { state: 'not-running', claimCount: 0, sessionDirCount: 0 },
      }),
    ).toBeUndefined();
  });

  it('still names it when the DEVICE said so, but flags the contradiction', () => {
    // A device-reported SESSION_NOT_FOUND is machine-readable and survives; the
    // disagreement with the answering command is said out loud rather than
    // hidden.
    const d = detectNoNativeSession(SESSION_NOT_FOUND, { sessionAnswered: true });
    expect(d?.cause).toBe('no-native-session');
    expect(d?.symptom).toMatch(/disagree/);
  });

  it('no longer claims the condition is self-healing — that was falsified', () => {
    // The old detail asserted "the next capture re-opens the session, and the
    // whole sweep recovers once one `open` lands". Falsified live across three
    // consecutive sweeps / ~20 minutes during the Metro-decay collapse.
    const d = detectNoNativeSession(SESSION_NOT_FOUND)!;
    expect(d.detail).not.toMatch(/self-healing/i);
    expect(d.detail).toMatch(/metro-decayed/);
  });

  it('sharpens the symptom when the daemon was cold, without needing it', () => {
    const cold = detectNoNativeSession(undefined, {
      sessionEstablished: false,
      daemon: { state: 'not-running', claimCount: 0, sessionDirCount: 0 },
    });
    expect(cold?.symptom).toContain('cold at the start of this run');
    // Same cause, quieter symptom, when the daemon looks alive: the session was
    // lost rather than never taken, and the fix is identical either way.
    const warm = detectNoNativeSession(undefined, {
      sessionEstablished: false,
      daemon: { state: 'alive', pid: 1, claimCount: 0, sessionDirCount: 1 },
    });
    expect(warm?.cause).toBe('no-native-session');
    expect(warm?.symptom).not.toContain('cold at the start of this run');
  });

  it('says NOTHING when the gate proved a session, or was never run', () => {
    // `undefined` means "not measured" and must never be read as "no session":
    // flagging a working machine is the one outcome this module must not
    // produce. A cold daemon on its own is likewise normal — agent-device
    // starts it on demand.
    expect(detectNoNativeSession(undefined, { sessionEstablished: true })).toBeUndefined();
    expect(detectNoNativeSession(undefined)).toBeUndefined();
    expect(detectNoNativeSession('Screenshot failed (exit 1): some other error')).toBeUndefined();
    expect(
      detectNoNativeSession(undefined, {
        daemon: { state: 'not-running', claimCount: 0, sessionDirCount: 0 },
      }),
    ).toBeUndefined();
  });
});

describe('parseInUseSessionName / sessionListHasSession', () => {
  it('reads the session name whatever quoting agent-device used', () => {
    expect(parseInUseSessionName(IN_USE)).toBe('default');
    expect(parseInUseSessionName('Device is already in use by session "ci-2".')).toBe('ci-2');
    // Unquoted, sentence-final: the period belongs to the sentence, not the name.
    expect(parseInUseSessionName('device is ALREADY IN USE BY SESSION default.')).toBe('default');
    expect(parseInUseSessionName('some other error')).toBeUndefined();
    expect(parseInUseSessionName(undefined)).toBeUndefined();
  });

  it('separates "not listed" from "could not tell"', () => {
    // false = read the list, the session is not in it; undefined = unreadable.
    expect(sessionListHasSession('{"sessions":[{"name":"default"}]}', 'default')).toBe(true);
    expect(sessionListHasSession(EMPTY_SESSIONS, 'default')).toBe(false);
    expect(sessionListHasSession('{"sessions":[{"name":"other"}]}', 'default')).toBe(false);
    expect(sessionListHasSession('not json', 'default')).toBeUndefined();
    expect(sessionListHasSession('{"sessions":"nope"}', 'default')).toBeUndefined();
    expect(sessionListHasSession(undefined, 'default')).toBeUndefined();
  });

  it('accepts plain-string entries and duplicated ones', () => {
    // agent-device printed the SAME stale entry twice in one array on the
    // machine where this was captured; a duplicate is still one session.
    expect(sessionListHasSession('{"sessions":["default","default"]}', 'default')).toBe(true);
  });
});

describe('probeAgentDeviceDaemon', () => {
  it('reads the pid and version out of daemon.json', () => {
    const probe = probeAgentDeviceDaemon({
      stateDir: STATE,
      fs: fakeFs(
        { [`${STATE}/daemon.json`]: JSON.stringify({ pid: 4242, version: '0.20.1' }) },
        { [`${STATE}/device-claims`]: ['a.json'], [`${STATE}/sessions`]: ['cwd_x_default'] },
      ),
      isPidAlive: () => true,
    });
    expect(probe).toMatchObject({ state: 'alive', pid: 4242, version: '0.20.1' });
    expect(probe.claimCount).toBe(1);
    expect(probe.sessionDirCount).toBe(1);
  });

  it('reports dead-pid when the recorded process is gone', () => {
    const probe = probeAgentDeviceDaemon({
      stateDir: STATE,
      fs: fakeFs(
        { [`${STATE}/daemon.json`]: JSON.stringify({ pid: 999999 }) },
        { [`${STATE}/device-claims`]: ['a.json'], [`${STATE}/sessions`]: [] },
      ),
      isPidAlive: () => false,
    });
    expect(probe.state).toBe('dead-pid');
  });

  it('degrades to unreadable on malformed JSON or a missing pid — never to "broken"', () => {
    const bad = probeAgentDeviceDaemon({
      stateDir: STATE,
      fs: fakeFs({ [`${STATE}/daemon.json`]: '{not json' }),
      isPidAlive: () => false,
    });
    expect(bad.state).toBe('unreadable');
    expect(diagnoseDaemon(bad)).toBeUndefined();

    const noPid = probeAgentDeviceDaemon({
      stateDir: STATE,
      fs: fakeFs({ [`${STATE}/daemon.json`]: '{"port":1}' }),
      isPidAlive: () => false,
    });
    expect(noPid.state).toBe('unreadable');
  });

  it('reports not-running when there is no daemon.json, and no-state-dir when nothing exists', () => {
    expect(
      probeAgentDeviceDaemon({ stateDir: STATE, fs: fakeFs({}, { [`${STATE}/sessions`]: [] }) })
        .state,
    ).toBe('not-running');
    expect(probeAgentDeviceDaemon({ stateDir: STATE, fs: fakeFs({}) }).state).toBe('no-state-dir');
  });

  it('treats an unprobeable pid as alive, so a broken probe cannot invent a dead daemon', () => {
    const probe = probeAgentDeviceDaemon({
      stateDir: STATE,
      fs: fakeFs(
        { [`${STATE}/daemon.json`]: '{"pid":1}' },
        { [`${STATE}/device-claims`]: ['a.json'] },
      ),
      isPidAlive: () => {
        throw new Error('EPERM');
      },
    });
    expect(probe.state).toBe('alive');
    expect(diagnoseDaemon(probe)).toBeUndefined();
  });

  it('ignores dotfiles when counting claims/sessions', () => {
    const probe = probeAgentDeviceDaemon({
      stateDir: STATE,
      fs: fakeFs(
        { [`${STATE}/daemon.json`]: '{"pid":1}' },
        { [`${STATE}/device-claims`]: ['.DS_Store'] },
      ),
      isPidAlive: () => false,
    });
    expect(probe.claimCount).toBe(0);
    expect(diagnoseDaemon(probe)).toBeUndefined(); // dead pid, but nothing left behind
  });
});

describe('diagnoseDaemon', () => {
  it('flags a dead daemon that left claims behind, and says how to clear them', () => {
    const d = diagnoseDaemon({ state: 'dead-pid', pid: 77, claimCount: 2, sessionDirCount: 1 })!;
    expect(d.cause).toBe('daemon-unresponsive');
    expect(d.symptom).toContain('77');
    expect(d.fixCommand).toBe(CLEAR_AGENT_DEVICE_STATE);
  });

  it('says nothing about a live daemon', () => {
    expect(
      diagnoseDaemon({ state: 'alive', pid: 5, claimCount: 3, sessionDirCount: 3 }),
    ).toBeUndefined();
  });
});

describe('detectForeignMetro', () => {
  const appDir = '/proj/.validity/native-app';

  it('flags a Metro Validity did not start, naming the pid and command line', () => {
    const d = detectForeignMetro({
      owners: [
        { pid: 321, pgid: 321, command: 'node /usr/bin/expo start --port 8082', cwd: '/proj' },
      ],
      ownerMarker: { pid: 100 },
      appDir,
    })!;
    expect(d.cause).toBe('foreign-metro');
    expect(d.confidence).toBe('confirmed');
    expect(d.symptom).toContain('321');
    expect(d.symptom).toContain('expo start --port 8082');
    expect(d.fixCommand).toContain('kill 321');
    expect(d.fixCommand).toMatch(/never run/i);
  });

  it('is silent when the marker matches by pid or by process group', () => {
    const owners = [{ pid: 555, pgid: 100, command: 'node metro', cwd: '/somewhere' }];
    expect(detectForeignMetro({ owners, ownerMarker: { pid: 100 }, appDir })).toBeUndefined();
    expect(
      detectForeignMetro({ owners: [{ pid: 100, cwd: '/x' }], ownerMarker: { pid: 100 }, appDir }),
    ).toBeUndefined();
  });

  it('is silent when the owner is running in the companion app dir (no marker needed)', () => {
    expect(
      detectForeignMetro({
        owners: [{ pid: 900, command: 'node expo start', cwd: appDir }],
        ownerMarker: null,
        appDir,
      }),
    ).toBeUndefined();
  });

  it('recognizes the companion dir through a symlinked/aliased path', () => {
    // macOS reports the same dir as /var/… and /private/var/…; a project reached
    // through a symlink reports a different absolute path than the one computed.
    expect(
      detectForeignMetro({
        owners: [{ pid: 900, command: 'node expo start', cwd: `/private${appDir}` }],
        ownerMarker: null,
        appDir,
      }),
    ).toBeUndefined();
  });

  it('ignores port holders that are not bundlers at all', () => {
    // Measured live: `lsof -ti tcp:8082` (without -sTCP:LISTEN) also lists the
    // adb fork-server and the emulator's qemu process. Diagnosing those as a
    // rogue Metro would tell the developer to kill their own emulator.
    expect(
      detectForeignMetro({
        owners: [
          { pid: 40503, command: 'adb -L tcp:5037 fork-server server', cwd: '/elsewhere' },
          {
            pid: 53783,
            command: 'qemu-system-aarch64 -avd Medium_Phone_API_35',
            cwd: '/elsewhere',
          },
        ],
        ownerMarker: { pid: 1 },
        appDir,
      }),
    ).toBeUndefined();
  });

  it('says nothing at all when no identity signal is available', () => {
    // No marker AND no readable cwd → unknown, never flagged.
    expect(
      detectForeignMetro({ owners: [{ pid: 4, command: 'node' }], ownerMarker: null, appDir }),
    ).toBeUndefined();
    expect(detectForeignMetro({ owners: [], ownerMarker: { pid: 1 }, appDir })).toBeUndefined();
  });

  it('degrades to "suspected" when the cwd could not be read', () => {
    const d = detectForeignMetro({
      owners: [{ pid: 7, command: 'node expo start' }],
      ownerMarker: { pid: 1 },
      appDir,
    })!;
    expect(d.confidence).toBe('suspected');
  });
});

describe('detectSessionDecay', () => {
  it('suspects decay after two consecutive unconfirmed renders', () => {
    const d = detectSessionDecay(health({ count: 12, consecutiveUnconfirmed: 2 }), {
      platform: 'android',
    })!;
    expect(d.cause).toBe('session-decay');
    // NEVER confirmed: which layer decays is not known.
    expect(d.confidence).toBe('suspected');
    expect(d.fixCommand).toContain('adb emu kill');
    expect(d.fixCommand).toContain('-no-snapshot-load');
    expect(d.fixCommand!.split('\n')).toHaveLength(4);
  });

  it('does not fire on a single unconfirmed render', () => {
    expect(detectSessionDecay(health({ count: 12, consecutiveUnconfirmed: 1 }))).toBeUndefined();
  });

  // ---- 2026-07-29 regression: a FRESH session is not a decayed one ---------
  // Observed twice in one session: decay was claimed on a four-minute-old
  // daemon with ONE `open`, and again on a freshly cold-booted emulator. Both
  // streaks were inherited from captures written BEFORE the reset. The epoch
  // scoping lives in summarizeSessionHealth; this floor is the second guard.
  it('never fires on a fresh epoch, however unconfirmed its handful of captures', () => {
    expect(
      detectSessionDecay(health({ count: 2, consecutiveUnconfirmed: 2, openCallCount: 1 })),
    ).toBeUndefined();
    expect(
      detectSessionDecay(
        health({
          count: DEFAULT_DECAY_THRESHOLDS.minCapturesForStreak - 1,
          consecutiveUnconfirmed: 3,
        }),
      ),
    ).toBeUndefined();
  });

  it('still fires once the epoch has enough captures to have aged', () => {
    expect(
      detectSessionDecay(
        health({
          count: DEFAULT_DECAY_THRESHOLDS.minCapturesForStreak,
          consecutiveUnconfirmed: 2,
        }),
      )?.cause,
    ).toBe('session-decay');
  });

  // ---- 2026-07-29 regression: never an Android remedy for an iOS session ---
  it('NEVER recommends `adb emu kill` for an iOS session', () => {
    const d = detectSessionDecay(health({ count: 12, consecutiveUnconfirmed: 2 }), {
      platform: 'ios',
      deviceName: 'iPhone 16 Pro',
    })!;
    expect(d.fixCommand).not.toContain('adb');
    expect(d.fixCommand).not.toContain('emulator -avd');
    expect(d.fixCommand).toContain('xcrun simctl shutdown iPhone 16 Pro');
    expect(d.fixCommand).toContain('xcrun simctl boot iPhone 16 Pro');
  });

  it('prints NEITHER device command when the platform is unknown', () => {
    const fix = detectSessionDecay(health({ count: 12, consecutiveUnconfirmed: 2 }))!.fixCommand!;
    // The daemon rungs are platform-independent and always present …
    expect(fix).toContain('daemon.json');
    expect(fix).toContain('device-claims');
    // … and the device rung degrades to a comment naming both, never a guess.
    expect(fix).not.toMatch(/^adb emu kill$/m);
    expect(fix).not.toMatch(/^xcrun simctl/m);
    expect(fix).toContain('#');
  });

  it('fires when snapshot p95 has grown materially over the session baseline', () => {
    const d = detectSessionDecay(
      health({ count: 30, openingP95SnapshotMs: 400, recentP95SnapshotMs: 2900 }),
    )!;
    expect(d.symptom).toContain('400ms');
    expect(d.symptom).toContain('2900ms');
  });

  it('ignores growth on too few captures', () => {
    expect(
      detectSessionDecay(
        health({
          count: DEFAULT_DECAY_THRESHOLDS.minCapturesForTrend - 1,
          openingP95SnapshotMs: 400,
          recentP95SnapshotMs: 2900,
        }),
      ),
    ).toBeUndefined();
  });

  it('ignores growth that stays under the absolute floor — a fast session is never flagged', () => {
    expect(
      detectSessionDecay(
        health({ count: 40, openingP95SnapshotMs: 100, recentP95SnapshotMs: 900 }),
      ),
    ).toBeUndefined();
  });

  it('ignores a session that is slow but flat (it was always slow)', () => {
    expect(
      detectSessionDecay(
        health({ count: 40, openingP95SnapshotMs: 2500, recentP95SnapshotMs: 2600 }),
      ),
    ).toBeUndefined();
  });

  it('quotes the AVD when known, and leaves a placeholder when not', () => {
    expect(
      fullSessionResetCommand({ platform: 'android', avdName: 'Medium_Phone_API_35' }),
    ).toContain('-avd Medium_Phone_API_35');
    expect(fullSessionResetCommand({ platform: 'android' })).toContain('-avd <avd>');
    expect(fullSessionResetCommand({ platform: 'ios' })).toContain('xcrun simctl boot booted');
  });
});

/**
 * The a11y snapshot captured VERBATIM on 2026-07-29 while the sweep was
 * collapsed (`agent-device snapshot -i`, exit 0). Note what it does NOT
 * contain: any labelled node the dev-launcher anchors could match. That is why
 * `dev-launcher-home` never fired for the state it describes.
 */
const DEGRADED_METRO_SNAPSHOT = [
  'Page: validity-ai-validity-playground://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082',
  'Snapshot: 0 nodes',
  'Interactive snapshot is empty after filtering 38 raw Android nodes.',
].join('\n');

describe('sessionCommandsAnswered / snapshotIsBlank', () => {
  it('reads a non-empty snapshot as proof the session answered', () => {
    // Exit-0 `snapshot` stdout — the whole point: this text is what disproves
    // "no agent-device session was open for this capture".
    expect(sessionCommandsAnswered(DEGRADED_METRO_SNAPSHOT)).toBe(true);
    expect(sessionCommandsAnswered('# @e1 [button] "Save"')).toBe(true);
  });

  it('is FALSE for no evidence, and for a snapshot that itself says no session', () => {
    expect(sessionCommandsAnswered(undefined)).toBe(false);
    expect(sessionCommandsAnswered('')).toBe(false);
    expect(sessionCommandsAnswered('   \n ')).toBe(false);
    expect(
      sessionCommandsAnswered('Error (SESSION_NOT_FOUND): No active session. Run open first.'),
    ).toBe(false);
  });

  it('separates "answered with nothing" from "did not answer"', () => {
    expect(snapshotIsBlank(DEGRADED_METRO_SNAPSHOT)).toBe(true);
    expect(snapshotIsBlank('# @e1 [button] "Save"')).toBe(false);
    // A missing snapshot is "cannot tell", never "blank".
    expect(snapshotIsBlank('')).toBe(false);
    expect(snapshotIsBlank(undefined)).toBe(false);
  });
});

describe('detectMetroDecay', () => {
  // The whole degraded pass, as logged: every probe healthy, the render acked
  // and never attached, ten specs' worth of unconfirmed captures behind it.
  const degraded = {
    renderStatus: 'unconfirmed' as const,
    a11ySnapshot: DEGRADED_METRO_SNAPSHOT,
    sessionAnswered: true,
    health: health({ count: 10, consecutiveUnconfirmed: 10, openCallCount: 30 }),
    appDir: '/proj/.validity/native-app',
  };

  it('names the isolated Metro layer, as a suspicion, with the managed restart', () => {
    const d = detectMetroDecay(degraded)!;
    expect(d.cause).toBe('metro-decayed');
    // The remedy is proven; the mechanism inside Metro is not.
    expect(d.confidence).toBe('suspected');
    expect(d.fixCommand).toContain(`/proj/.validity/native-app/${METRO_CONTENT_MARKER_NAME}`);
    // The two commands the experiment EXONERATED must be named as such, never
    // recommended: resetting agent-device recovered nothing across two sweeps,
    // and the emulator was never reset at all.
    expect(d.fixCommand).not.toMatch(/^\s*adb emu kill/m);
    expect(d.fixCommand).toMatch(/NOT `adb emu kill`/);
    expect(d.fixCommand).toMatch(/NOT `agent-device open`/);
    // Provenance survives in the shipped text, not only in the source comment.
    expect(d.detail).toContain('2026-07-29');
  });

  it('falls back to the project-relative marker path when the app dir is unknown', () => {
    const d = detectMetroDecay({ ...degraded, appDir: undefined })!;
    expect(d.fixCommand).toContain(`.validity/native-app/${METRO_CONTENT_MARKER_NAME}`);
  });

  it('does NOT depend on p95 growth — it cannot, and that is the point', () => {
    // Measured during both collapses: snapshots stayed FAST (~500ms) because
    // the snapshot succeeds; it is reading a blank launcher. A signature keyed
    // on slowing would be silent exactly when it is needed.
    const flat = health({
      count: 40,
      consecutiveUnconfirmed: 10,
      openCallCount: 30,
      openingP95SnapshotMs: 500,
      recentP95SnapshotMs: 500,
    });
    expect(detectMetroDecay({ ...degraded, health: flat })?.cause).toBe('metro-decayed');
    // …and the timing-based probe genuinely cannot see this state on its own.
    expect(
      detectSessionDecay(
        health({ count: 40, openingP95SnapshotMs: 500, recentP95SnapshotMs: 500 }),
      ),
    ).toBeUndefined();
  });

  it('requires a HEALTHY session — that is what separates it from no-native-session', () => {
    expect(detectMetroDecay({ ...degraded, sessionAnswered: false })).toBeUndefined();
    expect(detectMetroDecay({ ...degraded, sessionAnswered: undefined })).toBeUndefined();
  });

  it('requires an acked-but-never-attached render', () => {
    // A device-reported rejection is the companion refusing the target, which
    // is a different (already-named) thing; a confirmed render is not a failure.
    expect(detectMetroDecay({ ...degraded, renderStatus: 'failed' })).toBeUndefined();
    expect(detectMetroDecay({ ...degraded, renderStatus: 'confirmed' })).toBeUndefined();
    expect(detectMetroDecay({ ...degraded, renderStatus: undefined })).toBeUndefined();
  });

  it('never fires on a FRESH epoch — a first cold launch is not a decayed one', () => {
    // Without an aging signal the honest answer is `dev-launcher-home`, so this
    // probe must stand down rather than send someone to restart a bundler that
    // has served two captures.
    expect(
      detectMetroDecay({ ...degraded, health: health({ count: 2, consecutiveUnconfirmed: 2 }) }),
    ).toBeUndefined();
    expect(detectMetroDecay({ ...degraded, health: undefined })).toBeUndefined();
  });

  it('accepts a hard-driven bundler even without a streak', () => {
    expect(
      detectMetroDecay({
        ...degraded,
        health: health({ count: 3, consecutiveUnconfirmed: 0, openCallCount: 40 }),
      })?.cause,
    ).toBe('metro-decayed');
  });

  it('leaves an open dev MENU alone — an occlusion is not a dead bundle', () => {
    // The menu sits OVER an app that may be rendering perfectly; restarting
    // Metro would not move it.
    expect(detectMetroDecay({ ...degraded, a11ySnapshot: DEV_MENU_SNAPSHOT })).toBeUndefined();
  });

  it('leaves an ordinary rendered screen alone', () => {
    expect(
      detectMetroDecay({
        ...degraded,
        a11ySnapshot: '# @e1 [header] "Sign in"\n# @e2 [button] "Continue"',
      }),
    ).toBeUndefined();
    // No snapshot at all is "cannot tell", never decay.
    expect(detectMetroDecay({ ...degraded, a11ySnapshot: '' })).toBeUndefined();
  });
});

describe('detectStaleAgentDevice / detectDeviceNotReady', () => {
  it('confirms staleness only when the caller already read the version', () => {
    const d = detectStaleAgentDevice('anything', {
      version: '0.16.4',
      outdated: true,
      minVersion: '0.20.1',
    })!;
    expect(d.cause).toBe('stale-agent-device');
    expect(d.confidence).toBe('confirmed');
    expect(d.symptom).toContain('0.16.4');
  });

  it('only suspects staleness from the exit-127 signature alone', () => {
    const d = detectStaleAgentDevice(
      'Error (COMMAND_FAILED): /system/bin/sh: -p: inaccessible or not found',
    )!;
    expect(d.confidence).toBe('suspected');
    expect(d.fixCommand).toContain('agent-device --version');
  });

  it('says nothing about a current install with an unrelated error', () => {
    expect(detectStaleAgentDevice('some other failure', { version: '0.20.1' })).toBeUndefined();
    expect(detectStaleAgentDevice(undefined)).toBeUndefined();
  });

  it('names a session bound to the other platform, and where to close it', () => {
    const d = detectDeviceNotReady('INVALID_ARGS: Session "default" is bound to ios device ABC')!;
    expect(d.cause).toBe('device-not-ready');
    expect(d.fixCommand).toContain('agent-device close');
    expect(d.detail).toMatch(/project root/i);
  });

  it('names a missing device', () => {
    expect(detectDeviceNotReady('Error: no booted device found', 'ios')?.fixCommand).toContain(
      'simctl boot',
    );
  });

  it('ignores errors it does not recognize', () => {
    expect(detectDeviceNotReady('boom')).toBeUndefined();
  });
});

describe('probeMetroPortOwners', () => {
  it('collects pid, pgid, command and cwd through the injected runner', async () => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'lsof' && args[0] === '-ti') return { code: 0, stdout: '4242\n', stderr: '' };
      if (bin === 'ps' && args.includes('pgid=')) return { code: 0, stdout: ' 4200\n', stderr: '' };
      if (bin === 'ps') return { code: 0, stdout: 'node expo start\n', stderr: '' };
      if (bin === 'lsof')
        return { code: 0, stdout: 'p4242\nn/proj/.validity/native-app\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });
    const owners = await probeMetroPortOwners(run, 8082);
    expect(owners).toEqual([
      { pid: 4242, pgid: 4200, command: 'node expo start', cwd: '/proj/.validity/native-app' },
    ]);
  });

  it('fails open when lsof is unavailable', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn lsof ENOENT');
    });
    await expect(probeMetroPortOwners(run as never, 8082)).resolves.toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2026-07-29: the upstream code beats every heuristic                         */
/* -------------------------------------------------------------------------- */

/**
 * VERBATIM. Message text from agent-device 0.20.1's iOS runner
 * (`RunnerTests+CommandExecution.swift`, `runnerWedgedResponse`); the surrounding
 * lines are `renderError`'s stderr format. 246s is the number observed on the
 * machine where Validity answered `render-failure` — "most likely the component
 * itself" — while the runner's main thread was wedged.
 */
const RUNNER_WEDGED_TEXT = [
  'Error (RUNNER_WEDGED): The iOS runner main thread has been stuck in abandoned work for 246 seconds and cannot recover on its own.',
  'Hint: The runner session will be restarted. Retry the command after the restart; if this screen keeps wedging captures, use screenshot as visual truth and interact by coordinates.',
  'Diagnostic ID: mfk3l9zq-7c1a4b2e',
  'Diagnostics Log: /Users/dev/.agent-device/logs/default/2026-07-29/2026-07-29T18-11-02-mfk3l9zq.ndjson',
].join('\n');

describe('parseAgentDeviceError', () => {
  it('reads the code, message, hint and diagnostic id out of a real RUNNER_WEDGED failure', () => {
    const u = parseAgentDeviceError(RUNNER_WEDGED_TEXT)!;
    expect(u.code).toBe('RUNNER_WEDGED');
    expect(u.message).toBe(
      'The iOS runner main thread has been stuck in abandoned work for 246 seconds and cannot recover on its own.',
    );
    expect(u.hint).toContain('runner session will be restarted');
    expect(u.diagnosticId).toBe('mfk3l9zq-7c1a4b2e');
    expect(u.logPath).toContain('.ndjson');
  });

  it('accepts the bare `CODE: message` form only for codes upstream actually mints', () => {
    expect(parseAgentDeviceError('SESSION_NOT_FOUND: no session for cwd')?.code).toBe(
      'SESSION_NOT_FOUND',
    );
    // A shouty sentence is not an error code.
    expect(parseAgentDeviceError('WARNING: this is fine')).toBeUndefined();
    expect(parseAgentDeviceError('TODO: something')).toBeUndefined();
  });

  it('takes the FIRST wrapped error — the agent-device one, not the CLI fallback that followed', () => {
    const both = `${RUNNER_WEDGED_TEXT}\nError (COMMAND_FAILED): xcrun simctl openurl exited 1`;
    expect(parseAgentDeviceError(both)?.code).toBe('RUNNER_WEDGED');
  });

  it('says nothing about text that carries no code', () => {
    expect(parseAgentDeviceError('something went wrong')).toBeUndefined();
    expect(parseAgentDeviceError('')).toBeUndefined();
    expect(parseAgentDeviceError(undefined)).toBeUndefined();
  });

  it('passes an UNKNOWN code through — the list is for the bare form only', () => {
    // agent-device's own AppErrorCode is `KnownAppErrorCode | (string & {})`;
    // a new subsystem code must not have to wait for this file to be updated.
    expect(parseAgentDeviceError('Error (BRAND_NEW_CODE): a thing broke')?.code).toBe(
      'BRAND_NEW_CODE',
    );
  });
});

describe('diagnoseUpstreamError', () => {
  it('is CONFIRMED, quotes upstream verbatim, and carries the raw payload', () => {
    const d = diagnoseUpstreamError(parseAgentDeviceError(RUNNER_WEDGED_TEXT))!;
    expect(d.cause).toBe('agent-device-error');
    expect(d.confidence).toBe('confirmed');
    expect(d.symptom).toContain('RUNNER_WEDGED');
    expect(d.symptom).toContain('stuck in abandoned work for 246 seconds');
    expect(d.symptom).toContain('mfk3l9zq-7c1a4b2e');
    expect(d.upstream?.code).toBe('RUNNER_WEDGED');
    // It must NOT read as a component problem.
    expect(d.detail).not.toMatch(/component itself/i);
  });

  it('yields nothing without an upstream error', () => {
    expect(diagnoseUpstreamError(undefined)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 2026-07-29: an Expo dev surface is neither decay nor a broken component      */
/* -------------------------------------------------------------------------- */

/** The SDK-55 dev menu as agent-device renders it, over a real app. */
const DEV_MENU_SNAPSHOT = [
  '# @e1 [other] "Validity"',
  '# @e2 [button] "Reload"',
  '# @e3 [button] "Go home"',
  '# @e4 [button] "Performance monitor"',
  '# @e5 [button] "Element inspector"',
  '# @e6 [button] "Open DevTools"',
].join('\n');

/** The dev-LAUNCHER home screen (server picker) — no bundle loaded at all. */
const DEV_LAUNCHER_SNAPSHOT = [
  '# @e1 [other] "Development servers"',
  '# @e2 [button] "Fetch development servers"',
  '# @e3 [button] "Enter URL manually"',
].join('\n');

describe('detectDevSurface', () => {
  it('names an open dev menu — CONFIRMED, and explicitly not the component', () => {
    const d = detectDevSurface({ snapshot: DEV_MENU_SNAPSHOT })!;
    expect(d.cause).toBe('dev-menu-open');
    expect(d.confidence).toBe('confirmed');
    expect(d.symptom).toContain('performance monitor');
    expect(d.detail).toMatch(/occlusion/i);
    // The remedy must not be a device reset — that was the misattribution.
    expect(d.fixCommand).not.toContain('adb emu kill');
    expect(d.fixCommand).not.toContain('simctl shutdown');
  });

  it('names the dev-launcher home screen, and outranks the menu when both could match', () => {
    const d = detectDevSurface({
      snapshot: `${DEV_LAUNCHER_SNAPSHOT}\n# @e9 [button] "Performance monitor"`,
    })!;
    expect(d.cause).toBe('dev-launcher-home');
    expect(d.detail).toMatch(/never (loaded|on screen)|server picker/i);
  });

  it('reads the dev launcher off the Android foreground activity too', () => {
    const d = detectDevSurface({
      foregroundActivity: 'expo.modules.devlauncher.launcher.DevLauncherActivity',
      platform: 'android',
    })!;
    expect(d.cause).toBe('dev-launcher-home');
  });

  // ---- 2026-07-29: the launcher with NO labels to match --------------------
  it('reads the label-less launcher off the snapshot page line', () => {
    // Bug #4 from the decay experiment: the device sat on the dev-client
    // launcher for a whole collapse and this probe never fired, because a
    // 0-node snapshot has no labelled node for the anchors to match.
    const d = detectDevSurface({ snapshot: DEGRADED_METRO_SNAPSHOT })!;
    expect(d.cause).toBe('dev-launcher-home');
    expect(d.confidence).toBe('confirmed');
    expect(d.symptom).toContain('expo-development-client');
  });

  it('never convicts on the page line alone — a rendered tree wins', () => {
    // The page line can legitimately still name the dev-client control URL on a
    // device that went on to render the target, so the URL must be paired with
    // an empty tree before it means anything.
    const rendered = `${DEGRADED_METRO_SNAPSHOT}\n# @e1 [header] "Sign in"`;
    expect(detectDevSurface({ snapshot: rendered })).toBeUndefined();
  });

  it('says NOTHING about an ordinary app screen', () => {
    const app = ['# @e1 [header] "Sign in"', '# @e2 [button] "Go home"'].join('\n');
    expect(detectDevSurface({ snapshot: app })).toBeUndefined();
    expect(detectDevSurface({})).toBeUndefined();
    expect(detectDevSurface({ snapshot: '' })).toBeUndefined();
  });

  it('keeps its anchors a SUBSET of the driver list they were copied from', () => {
    // The duplication exists to avoid an import cycle; this pins the coupling
    // so the two lists cannot drift apart in silence.
    for (const anchor of DEV_MENU_DIAGNOSIS_ANCHORS) {
      expect(DEV_MENU_ANCHOR_LABELS).toContain(anchor);
    }
    for (const anchor of ['fetch development servers', 'enter url manually']) {
      expect(DEV_MENU_ANCHOR_LABELS).toContain(anchor);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2026-07-30: an ANR dialog over a rendered app is not the component           */
/* -------------------------------------------------------------------------- */

/** The dialog observed live: Pixel Launcher ANR over a fully rendered app. */
const ANR_SNAPSHOT = [
  '# @e1 [other] "Pixel Launcher isn\'t responding"',
  '# @e2 [button] "Close app"',
  '# @e3 [button] "Wait"',
].join('\n');

describe('detectAnrDialog', () => {
  it('names the ANR dialog — CONFIRMED, reboot fix, explicitly not the component', () => {
    const d = detectAnrDialog({ snapshot: ANR_SNAPSHOT, platform: 'android' })!;
    expect(d.cause).toBe('anr-dialog');
    expect(d.confidence).toBe('confirmed');
    expect(d.symptom).toContain("isn't responding");
    expect(d.detail).toMatch(/occlusion/i);
    expect(d.detail).toMatch(/not.*component|component.*not/i);
    expect(d.fixCommand).toContain('adb reboot');
  });

  it('accepts the uncontracted OEM copy too', () => {
    const d = detectAnrDialog({
      snapshot: '# @e1 [other] "System UI is not responding"\n# @e2 [button] "Wait"',
    })!;
    expect(d.cause).toBe('anr-dialog');
  });

  it('requires a title AND a button — neither convicts alone', () => {
    // "wait" is ordinary product copy; a headline about responding is too.
    expect(
      detectAnrDialog({ snapshot: '# @e1 [button] "Wait"\n# @e2 [button] "Close app"' }),
    ).toBeUndefined();
    expect(
      detectAnrDialog({ snapshot: '# @e1 [header] "Your team isn\'t responding to invites"' }),
    ).toBeUndefined();
  });

  it('never fires on iOS or without a snapshot', () => {
    expect(detectAnrDialog({ snapshot: ANR_SNAPSHOT, platform: 'ios' })).toBeUndefined();
    expect(detectAnrDialog({ platform: 'android' })).toBeUndefined();
    expect(detectAnrDialog({ snapshot: '', platform: 'android' })).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* 2026-07-29: the bridge was pointed at the other platform's device            */
/* -------------------------------------------------------------------------- */

describe('detectBridgePlatformMismatch', () => {
  it('names a stale cross-platform bridge holder — CONFIRMED', () => {
    const d = detectBridgePlatformMismatch({
      expected: 'ios',
      actual: 'android',
      deviceId: 'emulator-5554',
      source: 'delegated-status',
      port: 8083,
    })!;
    expect(d.cause).toBe('bridge-platform-mismatch');
    expect(d.confidence).toBe('confirmed');
    expect(d.symptom).toContain('ios');
    expect(d.symptom).toContain('android');
    expect(d.symptom).toContain('emulator-5554');
    expect(d.fixCommand).toContain('lsof -ti tcp:8083');
  });

  it('is silent when the platforms agree, or when either side is unknown', () => {
    expect(
      detectBridgePlatformMismatch({ expected: 'ios', actual: 'ios', source: 'hello', port: 8083 }),
    ).toBeUndefined();
    expect(
      detectBridgePlatformMismatch({ expected: 'ios', actual: '', source: 'hello', port: 8083 }),
    ).toBeUndefined();
    expect(detectBridgePlatformMismatch(undefined)).toBeUndefined();
    expect(detectBridgePlatformMismatch(null)).toBeUndefined();
  });
});

describe('parseDaemonStartTime / daemonEpochStartMs', () => {
  it("reads agent-device's own processStartTime format", () => {
    const t = parseDaemonStartTime('Wed Jul 29 10:25:02 2026', Date.parse('2026-07-29T18:00:00Z'))!;
    expect(new Date(t).getFullYear()).toBe(2026);
  });

  it('refuses garbage and future timestamps rather than fabricating an epoch', () => {
    const now = Date.parse('2026-07-29T18:00:00Z');
    expect(parseDaemonStartTime('not a date', now)).toBeUndefined();
    expect(parseDaemonStartTime('', now)).toBeUndefined();
    expect(parseDaemonStartTime(undefined, now)).toBeUndefined();
    expect(parseDaemonStartTime('Wed Jul 30 10:25:02 2027', now)).toBeUndefined();
  });

  it('only a LIVE daemon defines an epoch', () => {
    expect(
      daemonEpochStartMs({
        state: 'alive',
        processStartMs: 1234,
        claimCount: 0,
        sessionDirCount: 0,
      }),
    ).toBe(1234);
    expect(
      daemonEpochStartMs({
        state: 'dead-pid',
        processStartMs: 1234,
        claimCount: 0,
        sessionDirCount: 0,
      }),
    ).toBeUndefined();
  });

  it('probeAgentDeviceDaemon lifts processStartTime off daemon.json', () => {
    const probe = probeAgentDeviceDaemon({
      stateDir: STATE,
      fs: fakeFs({
        [`${STATE}/daemon.json`]:
          '{"pid":4242,"version":"0.20.1","processStartTime":"Wed Jul 29 10:25:02 2026"}',
      }),
      isPidAlive: () => true,
    });
    expect(probe.state).toBe('alive');
    expect(probe.processStartMs).toBe(Date.parse('Wed Jul 29 10:25:02 2026'));
  });
});

describe('diagnoseNativeEnvironment', () => {
  const noCommands = { skipCommands: true, fs: fakeFs({}), stateDir: STATE };

  it('reports the phantom claim ahead of everything else', async () => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args.join(' ') === 'session list')
        return { code: 0, stdout: EMPTY_SESSIONS, stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });
    const d = await diagnoseNativeEnvironment({
      run,
      openErrorText: IN_USE,
      fs: fakeFs({}),
      stateDir: STATE,
      renderStatus: 'unconfirmed',
    });
    expect(d.cause).toBe('phantom-device-claim');
  });

  it('reports the stale claim when the session list still names the refused session', async () => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args.join(' ') === 'session list')
        return { code: 0, stdout: `{"sessions":[{"name":"default"}]}`, stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });
    const d = await diagnoseNativeEnvironment({
      run,
      openErrorText: IN_USE,
      fs: fakeFs({}),
      stateDir: STATE,
      renderStatus: 'unconfirmed',
    });
    expect(d.cause).toBe('stale-device-claim');
    expect(d.fixCommand).toBe('agent-device close --session default');
  });

  // ---- 2026-07-29 regression: never out-guess a machine-readable answer ----
  it('passes RUNNER_WEDGED through as the cause — NOT render-failure', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      platform: 'ios',
      openErrorText: RUNNER_WEDGED_TEXT,
      renderStatus: 'unconfirmed',
      // The exact heuristic that won last time, at full strength.
      health: health({ count: 40, consecutiveUnconfirmed: 9, openCallCount: 30 }),
    });
    expect(d.cause).toBe('agent-device-error');
    expect(d.cause).not.toBe('render-failure');
    expect(d.upstream?.code).toBe('RUNNER_WEDGED');
    expect(d.symptom).toContain('246 seconds');
    expect(d.detail).not.toMatch(/component itself/i);
  });

  it('outranks session decay for every non-deferred upstream code', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      openErrorText: 'Error (SESSION_NOT_FOUND): no session named "default" for this cwd',
      renderStatus: 'unconfirmed',
      health: health({ count: 40, consecutiveUnconfirmed: 9 }),
    });
    expect(d.cause).toBe('agent-device-error');
    expect(d.upstream?.code).toBe('SESSION_NOT_FOUND');
  });

  it('still prefers the more specific probe for a DEFERRED code (DEVICE_IN_USE)', async () => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args.join(' ') === 'session list')
        return { code: 0, stdout: EMPTY_SESSIONS, stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });
    const d = await diagnoseNativeEnvironment({
      run,
      openErrorText: `Error (DEVICE_IN_USE): Device is already in use by session 'default'`,
      fs: fakeFs({}),
      stateDir: STATE,
      renderStatus: 'unconfirmed',
    });
    expect(d.cause).toBe('phantom-device-claim');
    // …and the raw code is still carried, never lost on the way.
    expect(d.upstream?.code).toBe('DEVICE_IN_USE');
  });

  it('falls back to the passthrough when a deferred code matches no specific probe', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      openErrorText: 'Error (COMMAND_FAILED): adb: device offline while starting the activity',
      renderStatus: 'unconfirmed',
      health: health({ count: 40, consecutiveUnconfirmed: 9 }),
    });
    expect(d.cause).toBe('agent-device-error');
    expect(d.upstream?.code).toBe('COMMAND_FAILED');
  });

  // ---- 2026-07-29 regression: a dev surface is not decay / not the component
  it('names an open dev menu instead of blaming the session (was: session-decay)', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      platform: 'android',
      renderStatus: 'unconfirmed',
      a11ySnapshot: DEV_MENU_SNAPSHOT,
      health: health({ count: 40, consecutiveUnconfirmed: 9, openCallCount: 30 }),
    });
    expect(d.cause).toBe('dev-menu-open');
    expect(d.fixCommand).not.toContain('adb emu kill');
  });

  it('names the dev-launcher home screen instead of the component (was: render-failure)', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      renderStatus: 'unconfirmed',
      a11ySnapshot: DEV_LAUNCHER_SNAPSHOT,
    });
    expect(d.cause).toBe('dev-launcher-home');
  });

  // ---- 2026-07-29 decay experiment: the misdiagnosis that started this ------
  //
  // Reproduces the degraded pass exactly as captured: the readiness gate says
  // no session, the snapshot answers with the dev-client launcher and zero
  // interactive nodes, the render was acked and never attached, and every other
  // probe is clean (daemon alive, no claims, no foreign Metro). The CLI printed,
  // for all ten native specs:
  //
  //   likely cause (confirmed): No agent-device session was open for this
  //   capture: `agent-device open` never established one.
  //   cause: no-native-session — fix: agent-device open <scheme>://
  //
  // …while `agent-device appstate` and `agent-device snapshot -i` both exited 0
  // against that very session.
  describe('the Metro-decay degraded state', () => {
    const degradedPass = {
      skipCommands: true as const,
      fs: fakeFs({}),
      stateDir: STATE,
      platform: 'android' as const,
      projectRoot: '/proj',
      renderStatus: 'unconfirmed' as const,
      // The gate's answer during the collapse — an inference, and a wrong one.
      sessionEstablished: false,
      a11ySnapshot: DEGRADED_METRO_SNAPSHOT,
      health: health({ count: 10, consecutiveUnconfirmed: 10, openCallCount: 30 }),
    };

    it('never lands on no-native-session, and never at `confirmed`', async () => {
      const d = await diagnoseNativeEnvironment(degradedPass);
      expect(d.cause).not.toBe('no-native-session');
      expect(d.fixCommand ?? '').not.toMatch(/^agent-device open/m);
      expect(['dev-launcher-home', 'metro-decayed']).toContain(d.cause);
    });

    it('names metro-decayed and hands over the managed restart', async () => {
      const d = await diagnoseNativeEnvironment(degradedPass);
      expect(d.cause).toBe('metro-decayed');
      expect(d.confidence).toBe('suspected');
      expect(d.fixCommand).toContain(`/proj/.validity/native-app/${METRO_CONTENT_MARKER_NAME}`);
      expect(d.fixCommand).not.toMatch(/^\s*adb emu kill/m);
    });

    it('gives the SAME verdict whether the daemon is aged or freshly restarted', async () => {
      // Bug #3 from the experiment: the same physical failure was diagnosed
      // `no-native-session` (confirmed) on an aged daemon and `session-decay` +
      // `render-failure` after the daemon was reset. A cause that changes when
      // you restart an exonerated component is keying on the wrong evidence.
      const aged = await diagnoseNativeEnvironment({
        ...degradedPass,
        fs: fakeFs(
          { [`${STATE}/daemon.json`]: '{"pid":68139,"version":"0.20.1"}' },
          { [`${STATE}/device-claims`]: [], [`${STATE}/sessions`]: ['cwd_abc_default'] },
        ),
        isPidAlive: () => true,
      });
      const fresh = await diagnoseNativeEnvironment({
        ...degradedPass,
        fs: fakeFs({}, { [`${STATE}/device-claims`]: [], [`${STATE}/sessions`]: [] }),
      });
      expect(aged.cause).toBe('metro-decayed');
      expect(fresh.cause).toBe(aged.cause);
      expect(fresh.fixCommand).toBe(aged.fixCommand);
    });

    it('falls back to dev-launcher-home when the session has not aged yet', async () => {
      // Same screen, fresh epoch: the honest answer is the observation, not the
      // decay suspicion — and it is still not `no-native-session`.
      const d = await diagnoseNativeEnvironment({
        ...degradedPass,
        health: health({ count: 2, consecutiveUnconfirmed: 2, openCallCount: 2 }),
      });
      expect(d.cause).toBe('dev-launcher-home');
    });
  });

  it('an ordinary app snapshot leaves the ranking exactly as it was', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      renderStatus: 'unconfirmed',
      a11ySnapshot: '# @e1 [header] "Sign in"\n# @e2 [button] "Continue"',
    });
    expect(d.cause).toBe('render-failure');
  });

  // ---- 2026-07-29 regression: the stale cross-platform bridge holder --------
  it('reports a cross-platform bridge holder above every heuristic', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      platform: 'ios',
      renderStatus: 'unconfirmed',
      bridgePlatformMismatch: {
        expected: 'ios',
        actual: 'android',
        source: 'delegated-status',
        port: 8083,
      },
      health: health({ count: 40, consecutiveUnconfirmed: 9 }),
    });
    expect(d.cause).toBe('bridge-platform-mismatch');
  });

  // ---- 2026-07-29 regression: decay is scoped to the CURRENT epoch ---------
  it('does NOT claim decay from captures written before the daemon was restarted', async () => {
    // A daemon that started 4 minutes ago, and a log whose unconfirmed streak
    // is entirely PRE-reset (and written by a previous process — note the
    // openCallCount regression on the post-reset rows).
    const started = Date.now() - 4 * 60_000;
    const at = (offsetMs: number): string => new Date(started + offsetMs).toISOString();
    const before = (offsetMs: number): string => new Date(started - offsetMs).toISOString();
    const log = [
      ...[9, 8, 7, 6, 5, 4].map((i) => ({
        ts: before(i * 30_000),
        platform: 'ios' as const,
        openMs: 100,
        snapshotMs: 300,
        renderStatus: 'unconfirmed' as const,
        openCallCount: 20 + i,
      })),
      ...[0, 1].map((i) => ({
        ts: at(i * 20_000),
        platform: 'ios' as const,
        openMs: 100,
        snapshotMs: 300,
        renderStatus: 'unconfirmed' as const,
        openCallCount: i + 1,
      })),
    ];
    const epochHealth = summarizeSessionHealth(log, {
      epochStartMs: daemonEpochStartMs({
        state: 'alive',
        processStartMs: started,
        claimCount: 0,
        sessionDirCount: 0,
      }),
    });
    expect(epochHealth.count).toBe(2); // only the post-reset rows survive
    expect(detectSessionDecay(epochHealth, { platform: 'ios' })).toBeUndefined();

    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      platform: 'ios',
      renderStatus: 'unconfirmed',
      health: epochHealth,
    });
    expect(d.cause).not.toBe('session-decay');
    expect(d.fixCommand ?? '').not.toContain('adb emu kill');
  });

  it('prefers a confirmed stale CLI over anything downstream', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      agentDeviceVersion: '0.16.4',
      agentDeviceOutdated: true,
      minAgentDeviceVersion: '0.20.1',
      openErrorText: 'whatever',
    });
    expect(d.cause).toBe('stale-agent-device');
  });

  it('reports a dead daemon that left state behind', async () => {
    const d = await diagnoseNativeEnvironment({
      skipCommands: true,
      stateDir: STATE,
      fs: fakeFs(
        { [`${STATE}/daemon.json`]: '{"pid":31337}' },
        { [`${STATE}/device-claims`]: ['a.json'], [`${STATE}/sessions`]: ['s'] },
      ),
      isPidAlive: () => false,
    });
    expect(d.cause).toBe('daemon-unresponsive');
  });

  it('falls through to session decay when the environment looks intact', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      renderStatus: 'unconfirmed',
      health: health({ count: 20, consecutiveUnconfirmed: 3 }),
    });
    expect(d.cause).toBe('session-decay');
    expect(d.confidence).toBe('suspected');
  });

  it('only blames the component once every environment probe came back clean', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      renderStatus: 'unconfirmed',
      health: health({ count: 5, consecutiveUnconfirmed: 1 }),
    });
    expect(d.cause).toBe('render-failure');
    expect(d.confidence).toBe('suspected');
    expect(d.detail).toMatch(/withheld/);
  });

  it('treats a device-reported render rejection as a confirmed render failure', async () => {
    const d = await diagnoseNativeEnvironment({ ...noCommands, renderStatus: 'failed' });
    expect(d).toMatchObject({ cause: 'render-failure', confidence: 'confirmed' });
  });

  // ---- no agent-device session (the 2026-07-29 cold-daemon sweep) -----------

  it('names the missing session for the EXACT text that used to come back "unknown"', async () => {
    // Verbatim shape of what `verify --all` fed into openErrorText for all
    // seven blocked specs: captureNative's screenshot throw. Before the probe
    // existed, no rule matched it and every spec reported `cause: unknown`.
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      openErrorText:
        'Screenshot failed (exit 1): Error (SESSION_NOT_FOUND): No active session. Run open first.',
    });
    expect(d.cause).toBe('no-native-session');
    expect(d.confidence).toBe('confirmed');
    expect(d.detail).toMatch(/outlives the agent-device/);
  });

  it('names it from the readiness gate before the render is even scored', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      renderStatus: 'unconfirmed',
      sessionEstablished: false,
    });
    expect(d.cause).toBe('no-native-session');
  });

  it('does NOT outrank a device claim, a dead daemon or a missing device', async () => {
    // Each of those is WHY the session is missing, and each has a different
    // fix — a SESSION_NOT_FOUND riding along must not bury them.
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args.join(' ') === 'session list')
        return { code: 0, stdout: EMPTY_SESSIONS, stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    });
    const claim = await diagnoseNativeEnvironment({
      run,
      fs: fakeFs({}),
      stateDir: STATE,
      openErrorText: `${IN_USE}\nError (SESSION_NOT_FOUND): No active session.`,
      sessionEstablished: false,
    });
    expect(claim.cause).toBe('phantom-device-claim');

    const dead = await diagnoseNativeEnvironment({
      skipCommands: true,
      stateDir: STATE,
      fs: fakeFs(
        { [`${STATE}/daemon.json`]: '{"pid":31337}' },
        { [`${STATE}/device-claims`]: ['a.json'], [`${STATE}/sessions`]: ['s'] },
      ),
      isPidAlive: () => false,
      sessionEstablished: false,
    });
    expect(dead.cause).toBe('daemon-unresponsive');

    const noDevice = await diagnoseNativeEnvironment({
      ...noCommands,
      openErrorText: 'Error (NO_DEVICE): no booted device',
      sessionEstablished: false,
    });
    expect(noDevice.cause).toBe('device-not-ready');
  });

  it('outranks session decay — a session that never existed cannot have decayed', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      renderStatus: 'unconfirmed',
      sessionEstablished: false,
      health: health({ count: 20, consecutiveUnconfirmed: 3 }),
    });
    expect(d.cause).toBe('no-native-session');
  });

  it('is still the answer for the REAL cold-daemon sweep it was written for', async () => {
    // The 2026-07-29 cold-daemon state, unchanged by the decay work: a cold
    // daemon with nothing on disk, the gate reporting no session, and NO
    // session-liveness evidence anywhere in the pass (the screenshot threw
    // before a snapshot could be read, so `a11ySnapshot` never arrives).
    const d = await diagnoseNativeEnvironment({
      skipCommands: true,
      stateDir: STATE,
      fs: fakeFs({}, { [`${STATE}/device-claims`]: [], [`${STATE}/sessions`]: [] }),
      platform: 'ios',
      renderStatus: 'unconfirmed',
      sessionEstablished: false,
      openErrorText:
        'Screenshot failed (exit 1): Error (SESSION_NOT_FOUND): No active session. Run open first.',
      health: health({ count: 10, consecutiveUnconfirmed: 7, openCallCount: 30 }),
    });
    expect(d.cause).toBe('no-native-session');
    expect(d.confidence).toBe('confirmed');
    expect(d.fixCommand).toContain('agent-device open');
  });

  it('is outranked by a dev surface — an observation beats an inference', async () => {
    // Both signals present at once. The a11y tree is a direct reading of the
    // screen the evidence came from; the gate is an inference from one `open`
    // that did not return 0.
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      renderStatus: 'unconfirmed',
      sessionEstablished: false,
      a11ySnapshot: DEV_LAUNCHER_SNAPSHOT,
    });
    expect(d.cause).toBe('dev-launcher-home');
  });

  it('stays out of the way when the gate proved a session was open', async () => {
    const d = await diagnoseNativeEnvironment({
      ...noCommands,
      renderStatus: 'unconfirmed',
      sessionEstablished: true,
      health: health({ count: 5, consecutiveUnconfirmed: 1 }),
    });
    expect(d.cause).toBe('render-failure');
  });

  it('returns "unknown" rather than guessing, and never throws', async () => {
    const exploding: DiagnosisFs = {
      readFile: () => {
        throw new Error('boom');
      },
      readDir: () => {
        throw new Error('boom');
      },
      exists: () => {
        throw new Error('boom');
      },
    };
    const d = await diagnoseNativeEnvironment({ skipCommands: true, fs: exploding });
    expect(d.cause).toBe('unknown');
    expect(d.detail).toContain('native-session-metrics.jsonl');
  });
});

describe('formatDiagnosis', () => {
  it('renders one line with the cause, symptom and first fix command', () => {
    const line = formatDiagnosis(detectPhantomClaim(IN_USE, EMPTY_SESSIONS)!);
    expect(line.startsWith('phantom-device-claim:')).toBe(true);
    // The FIRST fix line is now the targeted release, not the daemon kill:
    // agent-device 0.20.2+ frees the claim on close, so leading with "kill your
    // daemon" would be a heavier fix than the situation calls for. The kill
    // survives as a later line in the same ladder for below-floor installs.
    expect(line).toContain('fix: agent-device close --session default');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('marks a suspicion as such', () => {
    expect(
      formatDiagnosis(detectSessionDecay(health({ count: 12, consecutiveUnconfirmed: 2 }))!),
    ).toContain('(suspected)');
  });
});

/* -------------------------------------------------------------------------- */
/* `agent-device doctor` — ADVISORY only                                       */
/* -------------------------------------------------------------------------- */

const doctorJson = (checks: unknown[], status = 'warn'): string =>
  JSON.stringify({
    success: true,
    data: { status, summary: 'Some checks need attention', kind: 'expo', checks },
  });

describe('parseAgentDeviceDoctorJson', () => {
  it('reads upstream’s status + checks', () => {
    const report = parseAgentDeviceDoctorJson(
      doctorJson([
        { id: 'metro', status: 'warn', summary: 'Metro not reachable', hint: 'start it' },
        { id: 'adb', status: 'pass', summary: 'adb on PATH' },
      ]),
    )!;
    expect(report.status).toBe('warn');
    expect(report.kind).toBe('expo');
    expect(report.checks).toHaveLength(2);
    expect(report.checks[0]!.hint).toBe('start it');
  });

  it('doctorFindings keeps only what upstream flagged', () => {
    const report = parseAgentDeviceDoctorJson(
      doctorJson([
        { id: 'metro', status: 'warn', summary: 'w' },
        { id: 'adb', status: 'pass', summary: 'p' },
        { id: 'xcode', status: 'info', summary: 'i' },
        { id: 'runner', status: 'fail', summary: 'f' },
      ]),
    )!;
    expect(doctorFindings(report).map((c) => c.id)).toEqual(['metro', 'runner']);
  });

  it('drops rows of the wrong shape rather than throwing', () => {
    const report = parseAgentDeviceDoctorJson(
      doctorJson([null, { id: 'x' }, { id: 'y', status: 'sideways', summary: 's' }, 7]),
    )!;
    expect(report.checks).toEqual([]);
  });

  it('answers undefined for unreadable output — never a fabricated clean bill', () => {
    expect(parseAgentDeviceDoctorJson('')).toBeUndefined();
    expect(parseAgentDeviceDoctorJson('Doctor: everything is fine')).toBeUndefined();
    expect(parseAgentDeviceDoctorJson(JSON.stringify({ success: true }))).toBeUndefined();
  });
});

describe('summarizeAgentDeviceDoctor', () => {
  it('names warn/fail findings and says out loud that it is advisory', () => {
    const line = summarizeAgentDeviceDoctor(
      parseAgentDeviceDoctorJson(
        doctorJson([
          { id: 'metro', status: 'warn', summary: 'Metro not reachable' },
          { id: 'runner', status: 'fail', summary: 'Runner missing' },
          { id: 'adb', status: 'pass', summary: 'fine' },
        ]),
      ),
    )!;
    expect(line).toContain('2 findings');
    expect(line).toContain('metro (warn)');
    expect(line).toContain('runner (fail)');
    expect(line).not.toContain('adb');
    expect(line).toMatch(/advisory/i);
  });

  it('caps the list and points at the full command', () => {
    const many = Array.from({ length: MAX_ADVISORY_FINDINGS + 2 }, (_, i) => ({
      id: `c${i}`,
      status: 'warn',
      summary: 's',
    }));
    const line = summarizeAgentDeviceDoctor(parseAgentDeviceDoctorJson(doctorJson(many)))!;
    expect(line).toContain('+2 more');
    expect(line).toContain('agent-device doctor');
  });

  it('says NOTHING when upstream is clean — a happy doctor is not a guarantee', () => {
    expect(
      summarizeAgentDeviceDoctor(
        parseAgentDeviceDoctorJson(doctorJson([{ id: 'adb', status: 'pass', summary: 'fine' }])),
      ),
    ).toBeUndefined();
    expect(summarizeAgentDeviceDoctor(undefined)).toBeUndefined();
  });
});

describe('probeAgentDeviceDoctor', () => {
  it('asks for JSON, scoped to the platform', async () => {
    const run = vi.fn(
      async (): Promise<ExecResult> => ({ code: 0, stdout: doctorJson([]), stderr: '' }),
    );
    await probeAgentDeviceDoctor({ run, platform: 'android' });
    expect(run).toHaveBeenCalledWith('agent-device', ['doctor', '--json', '--platform', 'android']);
  });

  it('parses a NON-ZERO exit too — upstream exits non-zero exactly when it has findings', async () => {
    const run = vi.fn(
      async (): Promise<ExecResult> => ({
        code: 1,
        stdout: doctorJson([{ id: 'metro', status: 'fail', summary: 'unreachable' }], 'fail'),
        stderr: '',
      }),
    );
    const report = await probeAgentDeviceDoctor({ run });
    expect(report?.checks[0]!.id).toBe('metro');
  });

  it('answers undefined when the binary is missing or the runner throws', async () => {
    expect(
      await probeAgentDeviceDoctor({
        run: async () => {
          throw new Error('ENOENT');
        },
      }),
    ).toBeUndefined();
  });
});

describe('diagnoseNativeEnvironment — advisory attachment', () => {
  /** A runner that answers nothing useful, so every Validity probe declines. */
  const quietRunner =
    (doctorStdout: string) =>
    async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args[0] === 'doctor') {
        return { code: 1, stdout: doctorStdout, stderr: '' };
      }
      return { code: 1, stdout: '', stderr: '' };
    };

  const fs: DiagnosisFs = {
    readFile: () => {
      throw new Error('nope');
    },
    readDir: () => [],
    exists: () => false,
  };

  it('attaches upstream findings to the WEAK answers, without touching cause or confidence', async () => {
    const d = await diagnoseNativeEnvironment({
      renderStatus: 'unconfirmed',
      platform: 'ios',
      fs,
      run: quietRunner(doctorJson([{ id: 'metro', status: 'warn', summary: 'Metro unreachable' }])),
    });
    expect(d.cause).toBe('render-failure');
    expect(d.confidence).toBe('suspected');
    expect(d.advisory).toContain('metro (warn)');
    // The advisory is prose ALONGSIDE the diagnosis, never part of its claim.
    expect(d.symptom).not.toContain('metro (warn)');
  });

  it('attaches nothing when upstream has no findings', async () => {
    const d = await diagnoseNativeEnvironment({
      renderStatus: 'unconfirmed',
      platform: 'ios',
      fs,
      run: quietRunner(doctorJson([{ id: 'adb', status: 'pass', summary: 'fine' }])),
    });
    expect(d.advisory).toBeUndefined();
  });

  it('never runs the probe when a stronger cause already won', async () => {
    let doctorCalls = 0;
    const run = async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args[0] === 'doctor') doctorCalls += 1;
      return { code: 1, stdout: '', stderr: '' };
    };
    const d = await diagnoseNativeEnvironment({
      // A machine-readable upstream error outranks everything below it.
      openErrorText: 'Error (RUNNER_WEDGED): the iOS runner main thread is stuck',
      renderStatus: 'unconfirmed',
      platform: 'ios',
      fs,
      run,
    });
    expect(d.cause).toBe('agent-device-error');
    expect(doctorCalls).toBe(0);
  });

  it('honors skipCommands — a cheap diagnosis stays cheap', async () => {
    let doctorCalls = 0;
    const run = async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args[0] === 'doctor') doctorCalls += 1;
      return { code: 1, stdout: '', stderr: '' };
    };
    const d = await diagnoseNativeEnvironment({
      renderStatus: 'unconfirmed',
      platform: 'ios',
      fs,
      run,
      skipCommands: true,
    });
    expect(doctorCalls).toBe(0);
    expect(d.advisory).toBeUndefined();
  });
});
