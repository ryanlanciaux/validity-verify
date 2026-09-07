import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentDeviceDriver,
  ANDROID_DEV_MENU_LABELS,
  ANDROID_SNAPSHOT_ARGS,
  COMMAND_TIMEOUT_EXIT_CODE,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_DEV_MENU_LABELS,
  DEFAULT_SNAPSHOT_ARGS,
  defaultDevMenuLabelsFor,
  defaultRunner,
  defaultSnapshotArgsFor,
  DEV_MENU_ANCHOR_LABELS,
  DEV_MENU_GENERIC_ANCHORS,
  DEV_MENU_SPECIFIC_ANCHORS,
  capabilityMissing,
  closeEstablishedNativeSessions,
  nativeSessionEstablished,
  SESSION_CLOSE_TIMEOUT_MS,
  DEFAULT_ACTION_SETTLE_TIMEOUT_MS,
  DEFAULT_SETTLE_QUIET_MS,
  DEFAULT_TAP_ARGS,
  deviceShellQuote,
  findDismissRef,
  nativeRecordingFor,
  nativeSessionKey,
  openUrlCommand,
  parseAppstateJson,
  parseCapabilitiesJson,
  parseCommandCostMs,
  parseDiffSnapshotJson,
  parseSettleJson,
  parseWaitStableJson,
  pinRef,
  renderSettleAsSnapshotText,
  stripRefPin,
  resetNativeSessionRegistry,
  snapshotShowsDevMenu,
  type CommandRunner,
  type ExecResult,
  type RunOptions,
} from './agent-device-driver.js';

import { commandCostTotals, resetCommandCost } from './session-metrics.js';

const ok: ExecResult = { code: 0, stdout: '', stderr: '' };

/**
 * The flags every mutating command carries on 0.20.5: the settled-diff request
 * plus the `--json` that makes it parseable and the `--cost` that times it.
 * Spelled out once so a change to the defaults fails ONE constant instead of a
 * dozen array literals.
 */
const SETTLE_ARGS = [
  '--settle',
  '--settle-quiet',
  String(DEFAULT_SETTLE_QUIET_MS),
  '--timeout',
  String(DEFAULT_ACTION_SETTLE_TIMEOUT_MS),
  '--json',
  '--cost',
];

/** Verbs that TAP. `press` is the default; `click` remains a legal override. */
const TAP_VERBS = new Set(['press', 'click']);

describe('deviceShellQuote', () => {
  // `adb shell` re-joins its argv into one line the DEVICE's `sh` parses again,
  // so the quoting has to survive that second parse. Verified live on an API 35
  // emulator: an unquoted `&`
  // backgrounds `am start` with the URL truncated at the `&`, which delivered a
  // Validity deep link without its token — the intent lands, the open exits 0,
  // and the render can never confirm.
  it('wraps a plain string in single quotes', () => {
    expect(deviceShellQuote('myapp://x')).toBe("'myapp://x'");
  });

  it('keeps `&` inside the quotes, where the device shell cannot split on it', () => {
    expect(deviceShellQuote('myapp://x?a=1&b=2')).toBe("'myapp://x?a=1&b=2'");
  });

  it("closes, escapes and reopens around an embedded single quote ('\\'')", () => {
    // The only character single quotes cannot contain: end the quote, emit an
    // escaped quote, start a new one.
    expect(deviceShellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(deviceShellQuote("''")).toBe(`''\\'''\\'''`);
  });

  it('quotes the empty string rather than vanishing into no argument at all', () => {
    expect(deviceShellQuote('')).toBe("''");
  });
});

describe('openUrlCommand', () => {
  it('builds an xcrun simctl openurl command for ios (booted by default)', () => {
    expect(openUrlCommand('myapp://validity?component=x', 'ios')).toEqual({
      bin: 'xcrun',
      args: ['simctl', 'openurl', 'booted', 'myapp://validity?component=x'],
    });
  });

  it('targets a specific udid when given', () => {
    expect(openUrlCommand('myapp://x', 'ios', 'ABC-123').args).toEqual([
      'simctl',
      'openurl',
      'ABC-123',
      'myapp://x',
    ]);
  });

  it('builds an adb VIEW intent for android as ONE device-side shell string', () => {
    // One argv entry after 'shell', with the URL single-quoted: `adb shell`
    // re-joins its argv into a line the device `sh` re-parses, so separate
    // argv entries would let a bare `&` in the query background `am start`
    // and truncate the URL (token lost, render never confirms).
    expect(openUrlCommand('myapp://x', 'android')).toEqual({
      bin: 'adb',
      args: ['shell', "am start -a android.intent.action.VIEW -d 'myapp://x'"],
    });
  });

  it('keeps a `&`-bearing deep link intact for the device shell', () => {
    const { args } = openUrlCommand('myapp://validity?component=x&token=r1', 'android');
    expect(args).toEqual([
      'shell',
      "am start -a android.intent.action.VIEW -d 'myapp://validity?component=x&token=r1'",
    ]);
  });

  it('escapes embedded single quotes for the device shell', () => {
    const { args } = openUrlCommand("myapp://x?q='v'", 'android');
    expect(args[1]).toBe(`am start -a android.intent.action.VIEW -d 'myapp://x?q='\\''v'\\'''`);
  });

  it('passes the URL to simctl RAW — iOS never goes through a device shell', () => {
    // simctl takes the URL as its own argv entry and execs no shell, so quoting
    // it here would deliver a deep link whose scheme is literally `'myapp`.
    // Asserted so a future change to the Android quoting cannot be applied to
    // both platforms "for symmetry".
    const url = 'myapp://validity?component=x&token=r1';
    expect(openUrlCommand(url, 'ios').args).toEqual(['simctl', 'openurl', 'booted', url]);
    expect(openUrlCommand(url, 'ios', 'ABC-123').args[3]).toBe(url);
    expect(openUrlCommand(url, 'ios').args.join(' ')).not.toContain("'");
  });

  it('passes -s <device> to adb when a device is given', () => {
    expect(openUrlCommand('myapp://x', 'android', 'emulator-5554').args.slice(0, 2)).toEqual([
      '-s',
      'emulator-5554',
    ]);
  });
});

describe('AgentDeviceDriver', () => {
  it('opens the deep-link target via `agent-device open` (session + deep link), pinned to the platform', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    await d.openTarget({ component: 'src/Button.tsx', fixture: 'primary' });
    expect(run).toHaveBeenCalledWith(
      'agent-device',
      ['open', 'myapp://validity?component=src%2FButton.tsx&fixture=primary'],
      { env: { AGENT_DEVICE_PLATFORM: 'ios' } },
    );
  });

  it('pins to a specific device udid when given', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'a', device: 'UDID-1', run });
    await d.screenshot('/tmp/s.png');
    expect(run).toHaveBeenCalledWith('agent-device', ['screenshot', '/tmp/s.png'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios', AGENT_DEVICE_ID: 'UDID-1' },
    });
  });

  it('captures a screenshot via agent-device with the path substituted', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.screenshot('/tmp/shot.png');
    expect(run).toHaveBeenCalledWith('agent-device', ['screenshot', '/tmp/shot.png'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });

  it('returns the a11y snapshot stdout from agent-device', async () => {
    const snap = '# @e1 [button] "Sign in"';
    const run = vi.fn(async () => ({ code: 0, stdout: snap, stderr: '' }));
    const d = new AgentDeviceDriver({ platform: 'android', run });
    expect(await d.snapshot()).toBe(snap);
    expect(run).toHaveBeenCalledWith('agent-device', ['snapshot', '--force-full'], {
      env: { AGENT_DEVICE_PLATFORM: 'android' },
    });
  });

  it('ANDROID snapshots WITHOUT -i — that flag hides every static <Text>', async () => {
    // `-i` is "interactive elements only". On Android the filter keeps only
    // hittable nodes, and an RN <Text> compiles to a plain, non-clickable
    // android.widget.TextView. Measured on the Ignite WelcomeScreen (API 35),
    // same frame: `snapshot -i` returned 3 nodes (two Buttons + a Button's own
    // label) while `snapshot` returned 27 including the heading and the
    // `validity-root:<token>` marker. Scoring a static-text presence criterion
    // against the interactive-only tree could only ever produce a false red.
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const android = new AgentDeviceDriver({ platform: 'android', run });
    expect(android.snapshotCommand().args).toEqual(['snapshot', '--force-full']);
    expect(android.snapshotCommand().args).not.toContain('-i');
    // Not `-c` either: compact prunes unlabeled nodes, which drops the screen's
    // ImageViews (the logo) and would just move the false red to any
    // image-presence criterion.
    expect(android.snapshotCommand().args).not.toContain('-c');
  });

  it('iOS keeps `snapshot -i` byte-identical — the passing sweep is not changed blind', async () => {
    // UIKit exposes static text as accessibility elements, so iOS's
    // interactive filter still carries headings (role `other`). Every green iOS
    // sweep on record used this argv; it is left exactly as it was.
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const ios = new AgentDeviceDriver({ platform: 'ios', run });
    expect(ios.snapshotCommand().args).toEqual(['snapshot', '-i']);
    expect(defaultSnapshotArgsFor('ios')).toEqual(DEFAULT_SNAPSHOT_ARGS);
    expect(defaultSnapshotArgsFor('android')).toEqual(ANDROID_SNAPSHOT_ARGS);
  });

  it('ANDROID passes --force-full — agent-device dedups repeat reads', async () => {
    // agent-device keeps a per-session baseline: the second read of an
    // unchanged screen returns "Snapshot unchanged since previous read 1.1s
    // ago." instead of the tree. Validity re-snapshots constantly (the settle
    // gate every 400ms, the check executor while resolving, the dev-menu
    // detector before each dismissal), so without this flag:
    //   - the settle gate compares two PLACEHOLDER STRINGS and "settles"
    //     without ever having looked at the UI (or never settles, when their
    //     elapsed-seconds text differs);
    //   - a check resolved against a placeholder finds no elements at all;
    //   - dev-menu detection reads no anchors and calls a live menu absent.
    // Measured on an API 35 emulator: with the flag, ten consecutive reads
    // 400ms apart are byte-identical; without it, read #2 onward are
    // placeholders.
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    expect(new AgentDeviceDriver({ platform: 'android', run }).snapshotCommand().args).toContain(
      '--force-full',
    );
    // NOT on iOS. The reasoning above is platform-independent and the flag looks
    // purely information-increasing, so it was tried on both — and a
    // like-for-like iOS control sweep (same machine, fixture and simulator)
    // went 33 pass / 0 fail / 7 unverifiable → 26 / 1 / 13, with one spec
    // rendering `unconfirmed` in the sweep that passes 3/3 alone. Unexplained
    // damage to the platform that works is not shipped on the strength of an
    // argument. See FORCE_FULL_FLAG.
    expect(new AgentDeviceDriver({ platform: 'ios', run }).snapshotCommand().args).not.toContain(
      '--force-full',
    );
  });

  // ---- deep-link open: native fallback --------------------------------------
  //
  // On Android only the FIRST `agent-device open` of a session works; every
  // later one exits 127 with "/system/bin/sh: -p: inaccessible or not found"
  // (reproduced on 0.20.1, fresh daemon, identical URL), while
  // `adb … VIEW -d <url>` succeeds every time. A verify sweep re-targets
  // constantly, so from the second capture onward the deep-link rung failed and
  // its spec reported "no mechanical verdict produced".

  it('falls back to the platform-native deep link when `agent-device open` fails', async () => {
    const calls: Array<[string, string[]]> = [];
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, args]);
      if (bin === 'agent-device' && args[0] === 'open')
        return { code: 127, stdout: '', stderr: '/system/bin/sh: -p: inaccessible or not found' };
      return ok;
    });
    const d = new AgentDeviceDriver({ platform: 'android', scheme: 'myapp', run, device: 'emu-1' });
    const res = await d.openTarget({ component: 'src/Button.tsx' });
    expect(res.code).toBe(0);
    // agent-device first (it is also what establishes the session), then adb.
    expect(calls[0]![0]).toBe('agent-device');
    expect(calls[1]).toEqual([
      'adb',
      [
        '-s',
        'emu-1',
        'shell',
        "am start -a android.intent.action.VIEW -d 'myapp://validity?component=src%2FButton.tsx'",
      ],
    ]);
  });

  it('does NOT fall back when `agent-device open` succeeds (no double-open)', async () => {
    // Failure-path only: a working open must keep doing exactly what it did,
    // and the deep link must never be delivered twice (a second VIEW intent is
    // a second navigation the run did not ask for).
    const run = vi.fn(async (): Promise<ExecResult> => ok);
    const d = new AgentDeviceDriver({ platform: 'android', scheme: 'myapp', run });
    expect((await d.openTarget({ component: 'src/Button.tsx' })).code).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe('agent-device');
  });

  it('falls back on iOS too, via simctl', async () => {
    // The fallback can only turn a hard error into a working open, so there is
    // no reason to withhold it from the platform that currently works.
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args[0] === 'open') return { code: 1, stdout: '', stderr: 'x' };
      return ok;
    });
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    expect((await d.openTarget({ component: 'src/A.tsx' })).code).toBe(0);
    expect(run).toHaveBeenLastCalledWith(
      'xcrun',
      ['simctl', 'openurl', 'booted', 'myapp://validity?component=src%2FA.tsx'],
      { env: { AGENT_DEVICE_PLATFORM: 'ios' } },
    );
  });

  // ---- deep-link open: stale device claim ------------------------------------
  //
  // Captured live on 2026-07-28: `agent-device close` printed `Closed: default`
  // and the very next `open` was refused with `Device is already in use by
  // session "default"`, while `session list` still showed a bare `default`
  // session beside the cwd-scoped one the CLI was writing to. Sessions are keyed
  // by CWD, so the unqualified close closed the wrong one and reported success.
  // `agent-device close --session default` released it; no daemon kill.

  const IN_USE: ExecResult = {
    code: 1,
    stdout: '',
    stderr: 'Error (DEVICE_IN_USE): Device is already in use by session "default".',
  };

  it('releases the named stale claim and retries the open once, keeping the session', async () => {
    // The retry rides `agent-device open` on purpose: the platform-CLI fallback
    // delivers the deep link but establishes NO session, so every later
    // snapshot/wait would report SESSION_NOT_FOUND.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[][] = [];
    let opens = 0;
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, ...args]);
      if (args[0] === 'open') return (opens += 1) === 1 ? IN_USE : ok;
      return ok;
    });
    const d = new AgentDeviceDriver({ platform: 'android', scheme: 'myapp', run });
    expect((await d.openTarget({ component: 'src/Button.tsx' })).code).toBe(0);
    expect(calls[1]).toEqual(['agent-device', 'close', '--session', 'default']);
    expect(calls[2]![1]).toBe('open');
    // Recovered in-band: adb was never needed.
    expect(calls.map((c) => c[0])).not.toContain('adb');
    // SILENT since the floor rose to 0.20.3, where upstream releases the claim
    // on close. The retry is defense-in-depth against a state that should no
    // longer happen, and a recovery that WORKED is not news; anyone actually
    // stuck on the un-GC'd behaviour is below the floor and gets told so by the
    // readiness checklist instead of by a warning mid-capture.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('retries EXACTLY once — a second refusal falls through to the fallback and the diagnosis', async () => {
    // A device genuinely held by a live session must not be closed out from
    // under its owner in a loop.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[][] = [];
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, ...args]);
      if (bin === 'agent-device' && args[0] === 'session')
        return { code: 0, stdout: '{"sessions":[{"name":"default"}]}', stderr: '' };
      if (bin === 'agent-device' && args[0] === 'open') return IN_USE;
      if (bin === 'agent-device') return ok;
      return { code: 1, stdout: '', stderr: 'adb: device offline' };
    });
    const d = new AgentDeviceDriver({ platform: 'android', scheme: 'myapp', run });
    const res = await d.openTarget({ component: 'src/Button.tsx' });
    expect(calls.filter((c) => c[1] === 'open')).toHaveLength(2);
    expect(calls.filter((c) => c[1] === 'close')).toHaveLength(1);
    // The failure is unchanged; the named-close fix comes back as the cause.
    expect(res.code).toBe(1);
    expect(res.diagnosis?.cause).toBe('stale-device-claim');
    expect(res.diagnosis?.fixCommand).toBe('agent-device close --session default');
    warn.mockRestore();
  });

  it('never closes a session for an open failure that is not an in-use refusal', async () => {
    // The exit-127 quoting bug names no session; closing one on that signature
    // would tear down a healthy session for an unrelated failure.
    const calls: string[][] = [];
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, ...args]);
      if (bin === 'agent-device' && args[0] === 'open')
        return { code: 127, stdout: '', stderr: '/system/bin/sh: -p: inaccessible or not found' };
      return ok;
    });
    const d = new AgentDeviceDriver({ platform: 'android', scheme: 'myapp', run });
    expect((await d.openTarget({ component: 'src/A.tsx' })).code).toBe(0);
    expect(calls.filter((c) => c[1] === 'close')).toHaveLength(0);
    expect(calls[1]![0]).toBe('adb');
  });

  it("surfaces agent-device's ORIGINAL error when the native fallback also fails", async () => {
    // The fallback is a recovery, not a way to lose the diagnosis: if neither
    // path works, the caller must still see why the first one didn't.
    const run = vi.fn(
      async (bin: string): Promise<ExecResult> =>
        bin === 'agent-device'
          ? { code: 127, stdout: '', stderr: 'the real reason' }
          : { code: 1, stdout: '', stderr: 'adb: no devices' },
    );
    const d = new AgentDeviceDriver({ platform: 'android', scheme: 'myapp', run });
    const res = await d.openTarget({ component: 'src/Button.tsx' });
    expect(res.code).toBe(127);
    expect(res.stderr).toBe('the real reason');
  });

  it('ATTACHES a cause when both opens fail — the alternative is silence', async () => {
    // This exact pairing was observed on a real machine: `open` insists the
    // device is claimed, `session list` says there are no sessions. Before
    // this, the run ended as "no mechanical verdict produced" for every
    // criterion, with nothing anywhere pointing at ~/.agent-device.
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args[0] === 'session')
        return { code: 0, stdout: '{"sessions": []}', stderr: '' };
      if (bin === 'agent-device')
        return {
          code: 1,
          stdout: '',
          stderr: "Error (COMMAND_FAILED): Device is already in use by session 'default'",
        };
      return { code: 1, stdout: '', stderr: 'adb: device offline' };
    });
    const d = new AgentDeviceDriver({ platform: 'android', scheme: 'myapp', run });
    const res = await d.openTarget({ component: 'src/Button.tsx' });
    // The failure itself is unchanged — the diagnosis is additive metadata.
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('already in use');
    expect(res.diagnosis?.cause).toBe('phantom-device-claim');
    expect(res.diagnosis?.fixCommand).toContain('rm -rf');
  });

  it('leaves a SUCCESSFUL open undiagnosed and unprobed', async () => {
    const run = vi.fn(async (): Promise<ExecResult> => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    const res = await d.openTarget({ component: 'src/Button.tsx' });
    expect(res.diagnosis).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('the CONTROL LINK never falls back — it is what establishes the session', async () => {
    // A control link delivered without an agent-device session leaves every
    // later snapshot/wait blind, so a "successful" native open here would be
    // worse than a clean failure.
    const run = vi.fn(async (): Promise<ExecResult> => ({ code: 1, stdout: '', stderr: 'nope' }));
    const d = new AgentDeviceDriver({ platform: 'android', scheme: 'myapp', run });
    expect((await d.openControlLink()).code).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('honors subcommand overrides (for CLI-surface drift)', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({
      platform: 'ios',
      run,
      bin: '/usr/local/bin/agent-device',
      commands: { screenshot: ['capture', '--out', '{path}'] },
    });
    await d.screenshot('/tmp/x.png');
    expect(run).toHaveBeenCalledWith(
      '/usr/local/bin/agent-device',
      ['capture', '--out', '/tmp/x.png'],
      { env: { AGENT_DEVICE_PLATFORM: 'ios' } },
    );
  });

  it('exposes the target URL for reporting', () => {
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp' });
    expect(d.targetUrl({ component: 'src/A.tsx' })).toBe('myapp://validity?component=src%2FA.tsx');
  });

  it('exposes the scheme', () => {
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp' });
    expect(d.scheme).toBe('myapp');
  });

  it('opens an arbitrary url via `agent-device open`', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    await d.openUrl('myapp://anything');
    expect(run).toHaveBeenCalledWith('agent-device', ['open', 'myapp://anything'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });

  it('opens the dev-client control link with the default companion metro port (8082)', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    await d.openControlLink();
    expect(run).toHaveBeenCalledWith(
      'agent-device',
      ['open', 'myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8082'],
      { env: { AGENT_DEVICE_PLATFORM: 'ios' } },
    );
  });

  it('honors a configured metroUrl, and lets the call arg override it', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      metroUrl: 'http://127.0.0.1:9001',
    });
    await d.openControlLink();
    expect(run).toHaveBeenLastCalledWith(
      'agent-device',
      ['open', 'myapp://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A9001'],
      { env: { AGENT_DEVICE_PLATFORM: 'ios' } },
    );
    await d.openControlLink('http://localhost:1234');
    expect(run).toHaveBeenLastCalledWith(
      'agent-device',
      ['open', 'myapp://expo-development-client/?url=http%3A%2F%2Flocalhost%3A1234'],
      { env: { AGENT_DEVICE_PLATFORM: 'ios' } },
    );
  });

  it('throws on a control link without a scheme', async () => {
    const d = new AgentDeviceDriver({ platform: 'ios' });
    await expect(d.openControlLink()).rejects.toThrow(/scheme/i);
  });

  it('dismisses the dev overlay, accepts alerts (with timeout), and waits for refs', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    await d.dismissOverlay();
    expect(run).toHaveBeenLastCalledWith('agent-device', ['react-native', 'dismiss-overlay'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
    await d.acceptAlert();
    expect(run).toHaveBeenLastCalledWith('agent-device', ['alert', 'accept', '2'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
    await d.acceptAlert(5);
    expect(run).toHaveBeenLastCalledWith('agent-device', ['alert', 'accept', '5'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
    await d.waitForRef('validity-root', 8000);
    expect(run).toHaveBeenLastCalledWith('agent-device', ['wait', 'validity-root', '8000'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });

  it('dismisses the Expo dev menu by ref-clicking a known button from the snapshot', async () => {
    // A real dev-menu snapshot co-presents several of its fixed action rows —
    // the anchors that prove this is the menu and not user UI.
    const snap = [
      '# @e1 [text] "Validity"',
      '# @e7 [button] "Continue"',
      '# @e8 [button] "Reload"',
      '# @e9 [button] "Go home"',
      '# @e10 [button] "Toggle performance monitor"',
    ].join('\n');
    const run = vi.fn(async (_bin: string, args: string[]) =>
      args[0] === 'snapshot' ? { code: 0, stdout: snap, stderr: '' } : ok,
    );
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    expect(await d.dismissDevMenu()).toBe(true);
    expect(run).toHaveBeenLastCalledWith('agent-device', ['press', '@e7', ...SETTLE_ARGS], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });

  it('returns false from dismissDevMenu when no dismiss button is present', async () => {
    const snap = '# @e1 [text] "Some component"\n# @e2 [button] "Submit"';
    const run = vi.fn(async (_bin: string, args: string[]) =>
      args[0] === 'snapshot' ? { code: 0, stdout: snap, stderr: '' } : ok,
    );
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    expect(await d.dismissDevMenu()).toBe(false);
    // Only the snapshot ran — no click.
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("NEVER clicks a rendered user modal's own 'Close' button (no dev-menu anchors → zero clicks)", async () => {
    // The corrupted-evidence bug: dismissDevMenu used to ref-click the FIRST
    // label matching continue/close/resume/dismiss/reload with no check that
    // the dev menu was actually present — so a user modal under verification
    // was dismissed right before the screenshot. With no dev-menu anchors in
    // the tree, the gate must produce ZERO clicks.
    const snap = [
      '# @e1 [text] "Delete account?"',
      '# @e2 [text] "This action cannot be undone."',
      '# @e3 [button] "Delete"',
      '# @e4 [button] "Close"',
    ].join('\n');
    const run = vi.fn(async (_bin: string, args: string[]) =>
      args[0] === 'snapshot' ? { code: 0, stdout: snap, stderr: '' } : ok,
    );
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    expect(await d.dismissDevMenu()).toBe(false);
    // Exactly one call (the snapshot) — no click ever reached the device.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.every(([, args]) => !TAP_VERBS.has((args as string[])[0]!))).toBe(true);
  });

  it("a single coincidental anchor ('Go home' on a 404 screen) is NOT enough to unlock clicking", async () => {
    const snap = [
      '# @e1 [text] "Page not found"',
      '# @e2 [button] "Go home"',
      '# @e3 [button] "Close"',
    ].join('\n');
    const run = vi.fn(async (_bin: string, args: string[]) =>
      args[0] === 'snapshot' ? { code: 0, stdout: snap, stderr: '' } : ok,
    );
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    expect(await d.dismissDevMenu()).toBe(false);
    expect(run).toHaveBeenCalledTimes(1); // snapshot only — no click
  });

  // ---- Android: 'Reload' is not a dismissal ---------------------------------
  //
  // From expo-dev-menu's source, not from the label: DevMenuFragment.onCreate
  // opens the menu whenever `showsAtLaunch || !isOnboardingFinished`, and
  // `isOnboardingFinished` defaults to false until a human taps through the
  // onboarding sheet — never, on an installer-provisioned companion. It hooks
  // that open onto a ReactInstanceEventListener, so EVERY new React context
  // re-opens the menu. Clicking 'Reload' builds exactly such a context.
  //
  // So on Android the label search must find nothing, and the driver must click
  // NOTHING. The dismissal that works is the companion closing its own menu
  // over the control bridge (see makeDevMenuDismisser).

  /** The SDK-55 Android dev-menu sheet, as agent-device serializes it. */
  const androidDevMenuSnapshot = [
    '# @e1 [text] "ValidityTestApp"',
    '# @e2 [text] "1.0.0"',
    '# @e3 [button] "Reload"',
    '# @e4 [button] "Go home"',
    '# @e5 [button] "Performance monitor"',
    '# @e6 [button] "Element inspector"',
    '# @e7 [button] "Open DevTools"',
  ].join('\n');

  it('ANDROID: detects the SDK-55 dev menu but clicks NOTHING (Reload would re-open it)', async () => {
    const run = vi.fn(async (_bin: string, args: string[]) =>
      args[0] === 'snapshot' ? { code: 0, stdout: androidDevMenuSnapshot, stderr: '' } : ok,
    );
    const d = new AgentDeviceDriver({ platform: 'android', scheme: 'myapp', run });
    // Detection still fires (three specific anchors are present) — the menu is
    // recognised, there is simply nothing on it that dismisses it.
    expect(snapshotShowsDevMenu(androidDevMenuSnapshot)).toBe(true);
    expect(await d.dismissDevMenu()).toBe(false);
    // Snapshot only. A click here would cost a bundle reload AND leave the menu
    // up, which is how the reload loop was reached.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.every(([, args]) => !TAP_VERBS.has((args as string[])[0]!))).toBe(true);
  });

  it('iOS keeps the legacy label list — the passing platform is not changed blind', async () => {
    // Same reasoning says 'Reload' is not a dismissal on iOS either, but that
    // path is load-bearing for the passing iOS sweep and nothing has been
    // OBSERVED wrong with it. The bridge rung now runs first on both platforms,
    // so this list is only ever a fallback.
    const run = vi.fn(async (_bin: string, args: string[]) =>
      args[0] === 'snapshot' ? { code: 0, stdout: androidDevMenuSnapshot, stderr: '' } : ok,
    );
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    expect(await d.dismissDevMenu()).toBe(true);
    expect(run).toHaveBeenLastCalledWith('agent-device', ['press', '@e3', ...SETTLE_ARGS], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });

  it('the platform label defaults differ ONLY by "reload"', () => {
    expect(DEFAULT_DEV_MENU_LABELS).toContain('reload');
    expect(ANDROID_DEV_MENU_LABELS).not.toContain('reload');
    expect(defaultDevMenuLabelsFor('android')).toEqual(ANDROID_DEV_MENU_LABELS);
    expect(defaultDevMenuLabelsFor('ios')).toEqual(DEFAULT_DEV_MENU_LABELS);
    // Nothing else was dropped — an over-eager filter would silently disable
    // the iOS-shaped fallbacks on Android too.
    expect(new Set(DEFAULT_DEV_MENU_LABELS).difference(new Set(ANDROID_DEV_MENU_LABELS))).toEqual(
      new Set(['reload']),
    );
  });

  it('an explicit devMenuLabels override still wins over the platform default', async () => {
    // The escape hatch has to survive the platform split: a custom harness that
    // knows its own sheet must be able to say so.
    const run = vi.fn(async (_bin: string, args: string[]) =>
      args[0] === 'snapshot' ? { code: 0, stdout: androidDevMenuSnapshot, stderr: '' } : ok,
    );
    const d = new AgentDeviceDriver({
      platform: 'android',
      scheme: 'myapp',
      run,
      devMenuLabels: ['go home'],
    });
    expect(await d.dismissDevMenu()).toBe(true);
    expect(run).toHaveBeenLastCalledWith('agent-device', ['press', '@e4', ...SETTLE_ARGS], {
      env: { AGENT_DEVICE_PLATFORM: 'android' },
    });
  });

  it('honors a devMenuAnchorLabels override', async () => {
    const snap = '# @e1 [text] "Custom Menu"\n# @e2 [text] "Custom Row"\n# @e3 [button] "Close"';
    const run = vi.fn(async (_bin: string, args: string[]) =>
      args[0] === 'snapshot' ? { code: 0, stdout: snap, stderr: '' } : ok,
    );
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      devMenuAnchorLabels: ['custom menu', 'custom row'],
    });
    expect(await d.dismissDevMenu()).toBe(true);
    expect(run).toHaveBeenLastCalledWith('agent-device', ['press', '@e3', ...SETTLE_ARGS], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });

  it('types text into a ref via the default `fill` verb (ref then text)', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    await d.inputText('@e3', 'a@b.com');
    expect(run).toHaveBeenLastCalledWith(
      'agent-device',
      ['fill', '@e3', 'a@b.com', ...SETTLE_ARGS],
      { env: { AGENT_DEVICE_PLATFORM: 'ios' } },
    );
  });

  it('honors a `type` command override (for CLI-surface drift)', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({
      platform: 'android',
      run,
      commands: { type: ['input-text', '--ref'] },
    });
    await d.inputText('@e5', 'hello');
    expect(run).toHaveBeenLastCalledWith('agent-device', ['input-text', '--ref', '@e5', 'hello'], {
      env: { AGENT_DEVICE_PLATFORM: 'android' },
    });
  });

  it('scrolls with the default verb and substitutes {direction}', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.scroll('down');
    expect(run).toHaveBeenLastCalledWith('agent-device', ['scroll', 'down'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });

  it('honors a `scroll` command override (for CLI-surface drift)', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({
      platform: 'ios',
      run,
      commands: { scroll: ['swipe', '--dir', '{direction}'] },
    });
    await d.scroll('up');
    expect(run).toHaveBeenLastCalledWith('agent-device', ['swipe', '--dir', 'up'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });

  it('honors overlay/alert/wait command overrides', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      commands: { dismissOverlay: ['rn', 'hide'], alert: ['popup', 'ok'], wait: ['await-el'] },
    });
    await d.dismissOverlay();
    expect(run).toHaveBeenLastCalledWith('agent-device', ['rn', 'hide'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
    await d.acceptAlert(3);
    expect(run).toHaveBeenLastCalledWith('agent-device', ['popup', 'ok', '3'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
    await d.waitForRef('x', 100);
    expect(run).toHaveBeenLastCalledWith('agent-device', ['await-el', 'x', '100'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });

  // ---- cwd pinning (agent-device sessions are keyed by CWD) -------------------
  //
  // `session list` shows a bare `default` beside a `cwd_<hash>_default`. With no
  // cwd pinned, the CLI (started in the project root) and the MCP server
  // (started wherever its host launched it) drive two different sessions against
  // one device, and the loser is refused with "Device is already in use".

  it('pins the configured cwd on EVERY command, including the fallback and the stale-claim close', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: Array<{ bin: string; opts?: RunOptions }> = [];
    let opens = 0;
    const run = vi.fn(async (bin: string, args: string[], opts?: RunOptions) => {
      seen.push({ bin, opts });
      // First open is refused by a stale claim (drives the recovery close +
      // retry), the retry fails too (drives the platform-CLI fallback), and the
      // fallback fails as well (drives the diagnosis probes) — one run that
      // walks every code path that spawns.
      if (bin === 'agent-device' && args[0] === 'open') {
        opens += 1;
        return {
          code: 1,
          stdout: '',
          stderr: 'Error (DEVICE_IN_USE): Device is already in use by session "default".',
        };
      }
      if (bin === 'agent-device') return ok;
      return { code: 1, stdout: '', stderr: 'adb: device offline' };
    });
    const d = new AgentDeviceDriver({
      platform: 'android',
      scheme: 'myapp',
      run,
      cwd: '/repo/my-app',
    });
    await d.openTarget({ component: 'src/A.tsx' });
    expect(opens).toBe(2);
    expect(seen.map((s) => s.bin)).toContain('adb');
    // Every spawn, no exceptions — the diagnosis probes included, since
    // `agent-device session list` is itself answered per-cwd.
    for (const s of seen) expect(s.opts?.cwd).toBe('/repo/my-app');
    warn.mockRestore();
  });

  it('passes NO cwd when none is configured (unchanged behavior)', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    await d.snapshot();
    expect(run).toHaveBeenLastCalledWith('agent-device', ['snapshot', '-i'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });

  it('lets a per-call cwd win over the configured one', async () => {
    // The driver never sets one today; asserting it so the wrapper stays an
    // override-able default rather than a clamp.
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', run, cwd: '/repo/a' });
    await d.snapshot();
    expect(run).toHaveBeenLastCalledWith('agent-device', ['snapshot', '-i'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
      cwd: '/repo/a',
    });
  });

  // ---- host-side command timeout ---------------------------------------------

  it('leaves ordinary waits on the default host bound, and widens it for a longer one', async () => {
    // The host bound must never be what ends a wait the CLI was told to make.
    // Every wait the capture path issues today (8s render wait, 3.5s warm wait,
    // 2s alert) is far inside the default, so it passes no timeoutMs at all.
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.waitForRef('validity-root', 8000);
    expect(run).toHaveBeenLastCalledWith('agent-device', ['wait', 'validity-root', '8000'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
    await d.acceptAlert(2);
    expect(run).toHaveBeenLastCalledWith('agent-device', ['alert', 'accept', '2'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
    // A caller asking for a wait longer than the host bound widens it instead of
    // racing it.
    await d.waitForRef('validity-root', 90_000);
    const opts = run.mock.calls.at(-1)![2] as RunOptions;
    expect(opts.timeoutMs).toBeGreaterThan(90_000);
  });
});

describe('AgentDeviceDriver.ensureSession (session readiness gate)', () => {
  // The bug, measured on iOS 2026-07-29: with the agent-device daemon COLD at
  // sweep start but the companion app still running, Validity's control bridge
  // (a WS to that app process) was connected, so `coldOpen`'s bridge fast-path
  // confirmed renders and never called the one thing that opens an agent-device
  // session. Every command that reads evidence then answered SESSION_NOT_FOUND
  // for 3m18s across seven consecutive specs.

  const NO_SESSION: ExecResult = {
    code: 1,
    stdout: '',
    stderr: 'Error (SESSION_NOT_FOUND): No active session. Run open first.',
  };
  const IN_USE: ExecResult = {
    code: 1,
    stdout: '',
    stderr: 'Error (DEVICE_IN_USE): Device is already in use by session "default".',
  };

  beforeEach(() => {
    // The registry is process-wide ON PURPOSE (see establishedSessions), so a
    // test that does not reset it inherits another test's session.
    resetNativeSessionRegistry();
  });

  it('opens the session once and no-ops for every later driver on the same device', async () => {
    // `verify --all` builds a FRESH driver per spec, so a per-instance flag
    // would re-open on every one of them — the per-capture cost the bridge
    // fast-path exists to avoid. The session is one shared resource; the record
    // has to be too.
    const run = vi.fn(async (): Promise<ExecResult> => ok);
    const opts = { platform: 'ios' as const, scheme: 'myapp', device: 'UDID-1', cwd: '/repo', run };

    const first = await new AgentDeviceDriver(opts).ensureSession('myapp://validity');
    expect(first).toEqual({ ready: true, via: 'opened' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]!.slice(0, 2)).toEqual(['agent-device', ['open', 'myapp://validity']]);

    const second = await new AgentDeviceDriver(opts).ensureSession('myapp://validity');
    expect(second).toEqual({ ready: true, via: 'already-open' });
    expect(run).toHaveBeenCalledTimes(1); // no second open
  });

  it('keys the record by platform + device + cwd, exactly as agent-device does', async () => {
    // Sessions are keyed by CWD (and pinned per device); a record shared across
    // those boundaries would assert readiness for a session that is not ours.
    const run = vi.fn(async (): Promise<ExecResult> => ok);
    await new AgentDeviceDriver({ platform: 'ios', device: 'A', cwd: '/repo', run }).ensureSession(
      'u',
    );
    await new AgentDeviceDriver({ platform: 'ios', device: 'B', cwd: '/repo', run }).ensureSession(
      'u',
    );
    await new AgentDeviceDriver({ platform: 'ios', device: 'A', cwd: '/other', run }).ensureSession(
      'u',
    );
    await new AgentDeviceDriver({
      platform: 'android',
      device: 'A',
      cwd: '/repo',
      run,
    }).ensureSession('u');
    expect(run).toHaveBeenCalledTimes(4);
    // …and the FIRST identity is still recorded, so it stays a no-op.
    await new AgentDeviceDriver({ platform: 'ios', device: 'A', cwd: '/repo', run }).ensureSession(
      'u',
    );
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('does NOT count the platform-CLI fallback as a session', async () => {
    // The heart of it. `xcrun simctl openurl` delivers the deep link and exits
    // 0, so the open "worked" — but agent-device opened no session, and every
    // later snapshot/wait/screenshot has nothing to talk to. Calling that ready
    // would rebuild the exact bug this gate closes.
    const agentFailed: ExecResult = { code: 127, stdout: '', stderr: 'agent-device exploded' };
    const run = vi.fn(
      async (bin: string): Promise<ExecResult> => (bin === 'xcrun' ? ok : agentFailed),
    );
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/repo', run });
    const res = await d.ensureSession('myapp://validity');
    expect(res.ready).toBe(false);
    expect(res.via).toBe('failed');
    expect(res.errorText).toContain('agent-device exploded');
    // The link still went out — degrading honestly, not refusing to run.
    expect(run.mock.calls.some((c) => c[0] === 'xcrun')).toBe(true);
  });

  it('explains itself even when the fallback succeeded silently', async () => {
    // The fallback can return code 0 with empty streams; an empty errorText
    // would reach the diagnosis as nothing to reason from — which is how this
    // arrived as `cause: unknown` in the first place.
    const run = vi.fn(
      async (bin: string): Promise<ExecResult> =>
        bin === 'agent-device' ? { code: 1, stdout: '', stderr: '' } : ok,
    );
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/repo', run });
    const res = await d.ensureSession('myapp://validity');
    expect(res.ready).toBe(false);
    expect(res.errorText).toContain('did not establish a session');
  });

  it('composes with the stale-claim recovery: a released claim yields a real session', async () => {
    // ff104b7's `close --session <name>` + single retry runs INSIDE the open
    // this gate rides, so a recovered open must come back `ready`, not merely
    // "the link was delivered".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let opens = 0;
    const calls: string[][] = [];
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, ...args]);
      if (args[0] === 'open') return (opens += 1) === 1 ? IN_USE : ok;
      return ok;
    });
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/repo', run });
    expect(await d.ensureSession('myapp://validity')).toEqual({ ready: true, via: 'opened' });
    expect(calls[1]).toEqual(['agent-device', 'close', '--session', 'default']);
    expect(calls.map((c) => c[0])).not.toContain('xcrun');
    warn.mockRestore();
  });

  it('re-opens after a session dies mid-sweep (SESSION_NOT_FOUND evicts the record)', async () => {
    // A registry that only grows would assert readiness for a session that is
    // gone, turning the gate into the silence it removes. Any command carrying
    // agent-device's no-session signature is proof, so the record is dropped.
    let snapFails = true;
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args[0] === 'snapshot' && snapFails) return NO_SESSION;
      return ok;
    });
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/repo', run });
    expect((await d.ensureSession('u')).via).toBe('opened');
    expect((await d.ensureSession('u')).via).toBe('already-open');

    await d.snapshot(); // the daemon died under us
    snapFails = false;
    expect((await d.ensureSession('u')).via).toBe('opened'); // re-established
  });

  it('evicts on a no-session answer that exits ZERO', async () => {
    // agent-device is free to report this in a `{ok:false}` body on exit 0;
    // gating eviction on a non-zero code would miss it.
    const run = vi.fn(
      async (bin: string, args: string[]): Promise<ExecResult> =>
        bin === 'agent-device' && args[0] === 'snapshot'
          ? { code: 0, stdout: '{"ok":false,"error":{"code":"SESSION_NOT_FOUND"}}', stderr: '' }
          : ok,
    );
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/repo', run });
    await d.ensureSession('u');
    await d.snapshot();
    expect((await d.ensureSession('u')).via).toBe('opened');
  });

  it('never lets an exploding runner become the failure', async () => {
    // The gate is additive: a throw here must degrade the run to an honest
    // unconfirmed, never replace it with a stack trace.
    const run = vi.fn(async (): Promise<ExecResult> => {
      throw new Error('spawn EACCES');
    });
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/repo', run });
    const res = await d.ensureSession('u');
    expect(res).toMatchObject({ ready: false, via: 'failed' });
    expect(res.errorText).toContain('spawn EACCES');
  });

  it('records the session established by an ordinary openTarget too', async () => {
    // The gate is not the only way a session is opened — a genuine cold ladder
    // opens one as a side effect, and re-opening on top of it would be waste.
    const run = vi.fn(async (): Promise<ExecResult> => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/repo', run });
    await d.openTarget({ component: 'src/A.tsx' });
    expect(run).toHaveBeenCalledTimes(1);
    expect((await d.ensureSession('u')).via).toBe('already-open');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('defaultRunner (host-side timeout)', () => {
  // Real child processes and real timers: the thing under test is that a
  // genuinely unresponsive child is killed, which a fake timer cannot prove.

  it('kills a child that never exits and resolves with a host-timeout result', async () => {
    // `echo $$` first so the killed process identifies itself through the
    // partial stdout the timeout path preserves — that pid is how the kill
    // itself is verified below.
    const started = Date.now();
    const res = await defaultRunner('sh', ['-c', 'echo $$; sleep 30'], { timeoutMs: 150 });
    // Resolved (never rejected) and back in well under the child's 30s.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.code).toBe(COMMAND_TIMEOUT_EXIT_CODE);
    // Self-explanatory: names the elapsed time, and that the bound
    // is Validity's own rather than a verdict about the UI.
    expect(res.stderr).toContain('host timeout');
    expect(res.stderr).not.toContain('sh -c echo $$; sleep 30');
    expect(res.stderr).toMatch(/after \d+ms/);
    expect(res.stderr).toContain('HOST');

    const pid = Number.parseInt(res.stdout.trim(), 10);
    expect(Number.isFinite(pid)).toBe(true);
    const gone = async (): Promise<boolean> => {
      for (let i = 0; i < 50; i += 1) {
        try {
          process.kill(pid, 0);
        } catch {
          return true;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    expect(await gone()).toBe(true);
  });

  it('does not touch a command that exits on its own', async () => {
    const res = await defaultRunner('sh', ['-c', 'echo hi']);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('hi');
    expect(res.stderr).not.toContain('host timeout');
  });

  it('does not fire on a slow-but-finishing command inside its bound', async () => {
    const res = await defaultRunner('sh', ['-c', 'sleep 0.2; echo done'], { timeoutMs: 5_000 });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('done');
  });

  it('treats timeoutMs: 0 as an explicit opt-out', async () => {
    const res = await defaultRunner('sh', ['-c', 'sleep 0.2; echo unbounded'], { timeoutMs: 0 });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe('unbounded');
  });

  it('bounds generously enough that a slow device cannot trip it', () => {
    // A false kill converts a working-but-decayed run into a red one. The
    // slowest routine command is the Android snapshot, whose worst measured p95
    // is ~2.9s (agent-device 0.20.1's own decay warning).
    expect(DEFAULT_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe('snapshotShowsDevMenu', () => {
  it('detects the Expo dev menu (several fixed action rows co-present)', () => {
    const snap = [
      '# @e1 [button] "Reload"',
      '# @e2 [button] "Go home"',
      '# @e3 [button] "Toggle performance monitor"',
      '# @e4 [button] "Open JS debugger"',
    ].join('\n');
    expect(snapshotShowsDevMenu(snap)).toBe(true);
  });

  // The SDK-55 SwiftUI dev menu, verbatim from the strings expo-dev-menu@55.0.30
  // ships: 'Toggle …' was dropped from two entries and 'Open JS debugger' /
  // 'Open React DevTools' were collapsed into 'Open DevTools'. The old anchor
  // list matched NONE of the renamed rows — it still fired only because
  // 'Go home' survived alongside them. This pins the current copy so the next
  // rename fails here rather than on a device.
  it('detects the SDK-55 dev menu after Expo renamed the tool rows', () => {
    const snap = [
      '# @e1 [button] "Reload"',
      '# @e2 [text] "TOOLS"',
      '# @e3 [button] "Performance monitor"',
      '# @e4 [button] "Element inspector"',
      '# @e5 [button] "Open DevTools"',
    ].join('\n');
    expect(snapshotShowsDevMenu(snap)).toBe(true);
    // Even with 'Go home' gone, the renamed rows alone are enough.
    expect(snap).not.toContain('Go home');
  });

  it('still detects an older dev-client whose rows carry the pre-55 names', () => {
    const snap = ['# @e1 [button] "Open JS debugger"', '# @e2 [button] "Open React DevTools"'].join(
      '\n',
    );
    expect(snapshotShowsDevMenu(snap)).toBe(true);
  });

  it('detects the dev launcher (server-picker strings co-present)', () => {
    const snap = [
      '# @e1 [text] "Development servers"',
      '# @e2 [button] "Fetch development servers"',
      '# @e3 [button] "Enter URL manually"',
    ].join('\n');
    expect(snapshotShowsDevMenu(snap)).toBe(true);
  });

  it('rejects user UI containing dismiss-style labels (Close/Continue/Reload)', () => {
    const snap = [
      '# @e1 [text] "Onboarding"',
      '# @e2 [button] "Continue"',
      '# @e3 [button] "Close"',
      '# @e4 [button] "Reload"',
    ].join('\n');
    expect(snapshotShowsDevMenu(snap)).toBe(false);
  });

  it('requires TWO distinct anchors — one plausible-in-user-UI anchor is not proof', () => {
    expect(snapshotShowsDevMenu('# @e1 [button] "Go home"')).toBe(false);
    // The same anchor repeated is still ONE distinct anchor.
    expect(snapshotShowsDevMenu('# @e1 [button] "Go home"\n# @e2 [button] "Go home"')).toBe(false);
  });

  // The tiering is what survives an Expo rename. SDK 55 renamed THREE of the
  // menu's five tool rows in one release; a flat two-anchor floor lived only
  // because 'Go home' happened to be untouched. Detection loss here is silent
  // (an unrecognized menu is byte-stable and marker-free, so the settle gate
  // settles on it and the heading-visible false red comes back), so every
  // specific anchor has to die in the same release before that can happen.
  it('a SINGLE specific anchor is conclusive — no second anchor needed', () => {
    for (const anchor of DEV_MENU_SPECIFIC_ANCHORS) {
      expect(snapshotShowsDevMenu(`# @e1 [button] "${anchor}"`)).toBe(true);
    }
  });

  it('generic anchors alone still need two — they are plausible product copy', () => {
    for (const anchor of DEV_MENU_GENERIC_ANCHORS) {
      expect(snapshotShowsDevMenu(`# @e1 [button] "${anchor}"`)).toBe(false);
    }
  });

  it('every anchor belongs to exactly one tier, and the tiers make up the list', () => {
    expect([...DEV_MENU_ANCHOR_LABELS].sort()).toEqual(
      [...DEV_MENU_GENERIC_ANCHORS, ...DEV_MENU_SPECIFIC_ANCHORS].sort(),
    );
    for (const a of DEV_MENU_GENERIC_ANCHORS) {
      expect(DEV_MENU_SPECIFIC_ANCHORS).not.toContain(a);
    }
    // Anchors are compared lowercased — a capitalized entry would silently
    // never match a label.
    for (const a of DEV_MENU_ANCHOR_LABELS) expect(a).toBe(a.toLowerCase());
  });

  it('matches case-insensitively against quoted labels and honors custom anchors', () => {
    const snap = '# @e1 [button] "GO HOME"\n# @e2 [button] "TOGGLE ELEMENT INSPECTOR"';
    expect(snapshotShowsDevMenu(snap)).toBe(true);
    expect(snapshotShowsDevMenu(snap, ['nothing', 'matches'])).toBe(false);
  });

  it('ships the documented default anchor set (dev-menu/launcher-only strings)', () => {
    expect(DEV_MENU_ANCHOR_LABELS).toContain('go home');
    expect(DEV_MENU_ANCHOR_LABELS).toContain('fetch development servers');
    // The dismiss labels must NOT double as anchors — they are user-UI common.
    for (const userish of ['close', 'continue', 'reload', 'dismiss', 'resume']) {
      expect(DEV_MENU_ANCHOR_LABELS).not.toContain(userish);
    }
  });
});

describe('findDismissRef', () => {
  const labels = ['continue', 'close', 'resume', 'dismiss', 'reload'];

  it('returns the first matching ref (case-insensitive substring)', () => {
    const snap = '# @e1 [text] "Title"\n# @e4 [button] "CONTINUE"\n# @e5 [button] "Close"';
    expect(findDismissRef(snap, labels)).toBe('@e4');
  });

  it('returns undefined when nothing matches', () => {
    expect(findDismissRef('# @e1 [button] "Submit"\n# @e2 [text] "Hi"', labels)).toBeUndefined();
  });

  it('ignores lines without a ref token', () => {
    expect(findDismissRef('[button] "Continue" (no ref)\n# @e9 [button] "Resume"', labels)).toBe(
      '@e9',
    );
  });
});
/* -------------------------------------------------------------------------- */
/* 0.20.3 primitives: wait stable / capabilities / appstate                    */
/* -------------------------------------------------------------------------- */

describe('parseWaitStableJson', () => {
  // VERBATIM from `agent-device wait stable --json` on emulator-5554 (0.20.3,
  // 2026-07-30). The nodeCount of 4 is the Android interactive-tree blind spot
  // itself: the Ignite WelcomeScreen's heading and body copy were on screen.
  const LIVE =
    '{"success":true,"data":{"waitedMs":568,"captures":3,"nodeCount":4,' +
    '"hint":"Settled on a nearly-empty tree — the app may still be loading. ' +
    'Wait for specific content (wait text ...) before interacting."}}';

  it('reads the capture stats upstream reports', () => {
    expect(parseWaitStableJson(LIVE)).toMatchObject({
      waitedMs: 568,
      captures: 3,
      nodeCount: 4,
    });
    expect(parseWaitStableJson(LIVE).hint).toContain('nearly-empty tree');
  });

  it('never decides `settled` — that comes from the exit code', () => {
    // A timed-out wait still prints a payload, so a parser that inferred
    // success from readable data would read a timeout as quiescence.
    expect('settled' in parseWaitStableJson(LIVE)).toBe(false);
  });

  it('degrades to empty stats on unreadable output rather than throwing', () => {
    expect(parseWaitStableJson('')).toEqual({});
    expect(parseWaitStableJson('not json')).toEqual({});
    expect(parseWaitStableJson('{"success":true}')).toEqual({});
  });
});

describe('parseCapabilitiesJson / capabilityMissing', () => {
  // VERBATIM shape from `agent-device capabilities --platform android --json`
  // (0.20.3, emulator-5554), abridged to the verbs under test.
  const LIVE = JSON.stringify({
    success: true,
    data: {
      device: {
        platform: 'android',
        id: 'emulator-5554',
        name: 'Medium Phone API 35',
        kind: 'emulator',
        booted: true,
      },
      availableCommands: ['open', 'snapshot', 'screenshot', 'wait', 'click', 'fill', 'type'],
    },
  });

  it('reads the supported verbs and the device identity', () => {
    const probe = parseCapabilitiesJson(LIVE)!;
    expect(probe.commands).toContain('fill');
    expect(probe.device).toMatchObject({
      platform: 'android',
      id: 'emulator-5554',
      booted: true,
    });
  });

  it('answers undefined — "cannot tell" — for anything unreadable', () => {
    expect(parseCapabilitiesJson('')).toBeUndefined();
    expect(parseCapabilitiesJson('{"success":true}')).toBeUndefined();
    expect(parseCapabilitiesJson('{"data":{"availableCommands":[]}}')).toBeUndefined();
  });

  it('capabilityMissing is THREE-valued: absent probe is never "unsupported"', () => {
    const probe = parseCapabilitiesJson(LIVE);
    expect(capabilityMissing(probe, 'scroll')).toBe(true); // asked, and absent
    expect(capabilityMissing(probe, 'fill')).toBe(false); // asked, and present
    // The one that matters: a probe we could not run must not make Validity
    // start withholding verdicts because it could not ask the question.
    expect(capabilityMissing(undefined, 'scroll')).toBeUndefined();
  });

  it('reports which VERBS exist, never which ARGV shapes they accept', () => {
    // 0.20.3 lists `type` as available while rejecting `type <ref> <text>` with
    // INVALID_ARGS — the fail-closed parsing change that forced the switch to
    // `fill`. Asserted so nobody later uses this probe as an argv-compat proxy.
    expect(capabilityMissing(parseCapabilitiesJson(LIVE), 'type')).toBe(false);
  });
});

describe('parseAppstateJson', () => {
  // VERBATIM from `agent-device appstate --platform android --json` (0.20.3).
  const LIVE =
    '{"success":true,"data":{"platform":"android","package":"ai.validity.playground",' +
    '"activity":"ai.validity.playground.MainActivity","cost":{"wallClockMs":320,"runnerRoundTrips":0}}}';

  it('normalizes to the same <package>/<activity> shape the dumpsys parser returns', () => {
    // Interchangeability is the point: activityIsDevLauncher and the
    // dev-launcher diagnosis both substring-match this one string.
    expect(parseAppstateJson(LIVE)).toBe(
      'ai.validity.playground/ai.validity.playground.MainActivity',
    );
  });

  it('does not double up a package that is already qualified', () => {
    expect(parseAppstateJson('{"data":{"package":"a.b","activity":"a.b/c.D"}}')).toBe('a.b/c.D');
  });

  it('requires BOTH halves — a package alone would widen every devlauncher test', () => {
    expect(parseAppstateJson('{"data":{"package":"a.b"}}')).toBeUndefined();
    expect(parseAppstateJson('{"data":{"activity":"c.D"}}')).toBeUndefined();
    expect(parseAppstateJson('nonsense')).toBeUndefined();
  });
});

describe('AgentDeviceDriver — 0.20.3 primitives', () => {
  it('builds `wait stable <quiet> <timeout> --json` (positionals before flags)', () => {
    const d = new AgentDeviceDriver({
      platform: 'android',
      run: vi.fn(async () => ok),
    });
    expect(d.waitStableCommand(500, 10000).args).toEqual([
      'wait',
      'stable',
      '500',
      '10000',
      '--json',
      '--cost',
    ]);
  });

  it('stamps `settled` from the EXIT CODE, not from the payload', async () => {
    const payload = '{"success":true,"data":{"waitedMs":900,"captures":2,"nodeCount":4}}';
    const timedOut = vi.fn(async () => ({
      code: 1,
      stdout: payload,
      stderr: 'timeout',
    }));
    const d = new AgentDeviceDriver({ platform: 'android', run: timedOut });
    const res = await d.waitStable(500, 1000);
    expect(res.settled).toBe(false);
    // Stats still surface — a timeout is evidence too.
    expect(res.captures).toBe(2);
  });

  it('foregroundActivity prefers `appstate`, and never runs adb when it answers', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, ...args]);
      if (bin === 'agent-device' && args[0] === 'appstate') {
        return {
          code: 0,
          stdout:
            '{"data":{"package":"ai.validity.playground","activity":"x.DevLauncherActivity"}}',
          stderr: '',
        };
      }
      return ok;
    });
    const d = new AgentDeviceDriver({ platform: 'android', run });
    expect(await d.foregroundActivity()).toBe('ai.validity.playground/x.DevLauncherActivity');
    expect(calls.map((c) => c[0])).not.toContain('adb');
  });

  it('falls back to the dumpsys scrape when appstate fails — the probe must outlive a broken session', async () => {
    // This is the whole reason the adb path was kept rather than deleted: a
    // phantom claim or a cold daemon is exactly the state this probe explains,
    // and a diagnosis that only runs when agent-device is healthy is useless.
    const dump =
      'topResumedActivity=ActivityRecord{870b9f3 u0 ai.validity.playground/expo.modules.devlauncher.launcher.DevLauncherActivity t74}';
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args[0] === 'appstate')
        return {
          code: 1,
          stdout: '',
          stderr: 'Error (SESSION_NOT_FOUND): no session',
        };
      if (bin === 'adb') return { code: 0, stdout: dump, stderr: '' };
      return ok;
    });
    const d = new AgentDeviceDriver({ platform: 'android', run });
    expect(await d.foregroundActivity()).toBe(
      'ai.validity.playground/expo.modules.devlauncher.launcher.DevLauncherActivity',
    );
  });

  it('stays Android-only even though appstate can answer on iOS', async () => {
    // deviceOnDevLauncherHome treats a non-undefined answer as authoritative in
    // BOTH directions and skips its a11y-copy rung. An iOS bundle id would
    // always parse as "not the dev launcher", silently disabling launcher
    // detection on the platform where the copy signature is the only evidence.
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    expect(await d.foregroundActivity()).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
});
/* ------------------------------------------------------------------ *
 * `.ad` replay recording — the driver half of the contract.           *
 * ------------------------------------------------------------------ */

describe('AgentDeviceDriver — `.ad` recording', () => {
  const AD = '/p/.validity/runs/run-1/replay.ad';

  beforeEach(() => {
    resetNativeSessionRegistry();
  });

  const recorder = (): { calls: string[][]; run: CommandRunner } => {
    const calls: string[][] = [];
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, ...args]);
      if (bin === 'agent-device' && args[0] === 'session') {
        return {
          code: 0,
          stdout: JSON.stringify({ success: true, data: {} }),
          stderr: '',
        };
      }
      return ok;
    });
    return { calls, run };
  };

  it('changes NOTHING when no recordingPath is configured', async () => {
    // Recording is additive. An unrecorded run must spawn byte-identical argv,
    // because that argv is what every other test in this file asserts.
    const { calls, run } = recorder();
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    await d.ensureSession('myapp://validity?component=x');
    await d.snapshot();
    await d.click('@e1');
    expect(calls[0]).toEqual(['agent-device', 'open', 'myapp://validity?component=x']);
    expect(calls.flat()).not.toContain('--no-record');
    expect(calls.flat()).not.toContain('--save-script');
    expect(d.recordingState()).toBeUndefined();
  });

  it('arms the SESSION-ESTABLISHING open, and only that one', async () => {
    const { calls, run } = recorder();
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      recordingPath: AD,
    });
    await d.ensureSession('myapp://validity?component=x&token=t1');
    // Upstream permits exactly ONE recorded open per session; a second one
    // aborts publication. So every later open must be excluded.
    await d.openTarget({ component: 'src/B.tsx' });
    const opens = calls.filter((c) => c[1] === 'open');
    expect(opens).toHaveLength(2);
    expect(opens[0]).toEqual([
      'agent-device',
      'open',
      'myapp://validity?component=x&token=t1',
      '--save-script',
      AD,
      '--force',
    ]);
    expect(opens[1]).toContain('--no-record');
    expect(opens[1]).not.toContain('--save-script');
  });

  it('retries UNARMED when arming is refused on a reused daemon session', async () => {
    // `establishedSessions` is per-process, but the daemon's session outlives a
    // failed run — so a RETRY's armed open meets an existing session and 0.20.3
    // refuses it with INVALID_ARGS. Before the unarmed retry existed, that open
    // fell through to the platform-CLI fallback, no session was recorded, and
    // every later snapshot/wait hit SESSION_NOT_FOUND: the retry a frustrated
    // user was already making is the run that silently degraded.
    const calls: string[][] = [];
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, ...args]);
      if (bin === 'agent-device' && args[0] === 'open' && args.includes('--save-script')) {
        return {
          code: 1,
          stdout: '',
          stderr:
            'Error (INVALID_ARGS): open --save-script can only arm a fresh session. ' +
            'Use the current session without --save-script, or close it and start a fresh session.',
        };
      }
      return ok;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const d = new AgentDeviceDriver({
        platform: 'ios',
        scheme: 'myapp',
        run,
        recordingPath: AD,
      });
      expect(await d.ensureSession('myapp://validity?component=x')).toEqual({
        ready: true,
        via: 'opened',
      });
      const opens = calls.filter((c) => c[1] === 'open');
      expect(opens).toHaveLength(2);
      expect(opens[0]).toContain('--save-script');
      expect(opens[1]).not.toContain('--save-script');
      // Nothing armed → nothing to publish, and no command gets suppressed.
      expect(d.recordingState()).toBeUndefined();
      await d.snapshot();
      expect(calls.at(-1)).not.toContain('--no-record');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('.ad` recording skipped'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT retry unarmed on other armed-open failures', async () => {
    // The unarmed retry is scoped to upstream's fresh-session refusal alone —
    // any other failure must keep riding the existing recovery ladder
    // (stale-claim release → platform-CLI fallback → diagnosis) unchanged.
    const calls: string[][] = [];
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, ...args]);
      if (bin === 'agent-device' && args[0] === 'open') {
        return { code: 127, stdout: '', stderr: 'boom' };
      }
      return ok;
    });
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      recordingPath: AD,
    });
    await d.ensureSession('myapp://validity?component=x');
    const opens = calls.filter((c) => c[0] === 'agent-device' && c[1] === 'open');
    expect(opens).toHaveLength(1);
  });

  it('excludes every other agent-device command from the recording', async () => {
    // Publication refuses a script containing a `close` or any @ref-targeted
    // step, and Validity issues both routinely. Suppression is central so no
    // command builder can forget.
    const { calls, run } = recorder();
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      recordingPath: AD,
    });
    await d.ensureSession('myapp://validity?component=x');
    await d.snapshot();
    await d.click('@e12');
    await d.inputText('@e13', 'hunter2');
    await d.screenshot('/tmp/a.png');
    await d.waitForRef('validity-root:t1', 1000);
    for (const c of calls.slice(1)) expect(c).toContain('--no-record');
  });

  it('never puts --no-record on adb/xcrun, which would reject the flag', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, ...args]);
      // Force the platform-CLI fallback on the SECOND open.
      if (bin === 'agent-device' && args[0] === 'open' && calls.length > 1) {
        return { code: 127, stdout: '', stderr: 'boom' };
      }
      return ok;
    });
    const d = new AgentDeviceDriver({
      platform: 'android',
      scheme: 'myapp',
      run,
      recordingPath: AD,
    });
    await d.ensureSession('myapp://validity?component=x');
    await d.openTarget({ component: 'src/B.tsx' });
    for (const c of calls.filter((x) => x[0] !== 'agent-device')) {
      expect(c).not.toContain('--no-record');
    }
  });

  it('records the destination guard as a selector wait, NOT suppressed', async () => {
    const { calls, run } = recorder();
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      recordingPath: AD,
    });
    await d.ensureSession('myapp://validity?component=x');
    expect(await d.recordDestinationGuard('validity-root:t1', 2500)).toBe(true);
    const guard = calls.at(-1)!;
    expect(guard).toEqual(['agent-device', 'wait', 'id="validity-root:t1"', '2500']);
    expect(guard).not.toContain('--no-record');
  });

  it('refuses to record a guard when nothing was armed', async () => {
    const { calls, run } = recorder();
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    await d.ensureSession('myapp://validity?component=x');
    expect(await d.recordDestinationGuard('validity-root:t1', 2500)).toBe(false);
    expect(calls.filter((c) => c[1] === 'wait')).toHaveLength(0);
  });

  it('publishes with `session save-script`, never with `close`', async () => {
    const { calls, run } = recorder();
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      recordingPath: AD,
    });
    await d.ensureSession('myapp://validity?component=x');
    const res = await d.publishRecording();
    expect(res).toEqual({ published: true, path: AD });
    expect(calls.at(-1)!.slice(0, 5)).toEqual([
      'agent-device',
      'session',
      'save-script',
      AD,
      '--force',
    ]);
    expect(calls.flat()).not.toContain('close');
  });

  it('is idempotent: a second publish does not re-run save-script', async () => {
    const { calls, run } = recorder();
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      recordingPath: AD,
    });
    await d.ensureSession('myapp://validity?component=x');
    await d.publishRecording();
    await d.publishRecording();
    expect(calls.filter((c) => c[1] === 'session')).toHaveLength(1);
  });

  it('reports a refusal instead of claiming a file that was never written', async () => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args[0] === 'session') {
        return {
          code: 1,
          stdout: JSON.stringify({
            success: false,
            error: {
              code: 'COMMAND_FAILED',
              message: 'no portable destination guard',
            },
          }),
          stderr: '',
        };
      }
      return ok;
    });
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      recordingPath: AD,
    });
    await d.ensureSession('myapp://validity?component=x');
    const res = await d.publishRecording();
    expect(res.published).toBe(false);
    expect(res.reason).toContain('destination guard');
  });

  it('arms once per SESSION even though verify --all builds a driver per spec', async () => {
    // The registry is the interlock for upstream's one-recorded-open rule.
    const { calls, run } = recorder();
    const opts = { platform: 'ios' as const, scheme: 'myapp', run, cwd: '/p' };
    const first = new AgentDeviceDriver({
      ...opts,
      recordingPath: '/runs/r1/replay.ad',
    });
    await first.ensureSession('myapp://validity?component=a');
    const second = new AgentDeviceDriver({
      ...opts,
      recordingPath: '/runs/r2/replay.ad',
    });
    await second.ensureSession('myapp://validity?component=b');
    expect(calls.filter((c) => c.includes('--save-script'))).toHaveLength(1);
    expect(calls.filter((c) => c.includes('/runs/r2/replay.ad'))).toHaveLength(0);
    expect(second.recordingState()?.path).toBe('/runs/r1/replay.ad');
  });

  it('does not register a recording when the arming open failed outright', async () => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args[0] === 'open') {
        return { code: 127, stdout: '', stderr: 'boom' };
      }
      return { code: 1, stdout: '', stderr: 'adb offline' };
    });
    const d = new AgentDeviceDriver({
      platform: 'android',
      scheme: 'myapp',
      run,
      recordingPath: AD,
    });
    await d.ensureSession('myapp://validity?component=x');
    expect(d.recordingState()).toBeUndefined();
    expect(nativeRecordingFor(nativeSessionKey({ platform: 'android' }))).toBeUndefined();
  });

  it('re-arms the retry after a stale-claim release — that open is still the first', async () => {
    const calls: string[][] = [];
    let opens = 0;
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, ...args]);
      if (bin === 'agent-device' && args[0] === 'open') {
        return (opens += 1) === 1
          ? {
              code: 1,
              stdout: '',
              stderr: 'Device is already in use by session "default"',
            }
          : ok;
      }
      return ok;
    });
    const d = new AgentDeviceDriver({
      platform: 'android',
      scheme: 'myapp',
      run,
      recordingPath: AD,
    });
    await d.ensureSession('myapp://validity?component=x');
    const armed = calls.filter((c) => c.includes('--save-script'));
    expect(armed).toHaveLength(2); // the refused attempt + the recovered retry
    expect(d.recordingState()).toEqual({ path: AD, published: false });
  });

  it('sends a secret fill live but publishes the placeholder — never both flags', async () => {
    const { calls, run } = recorder();
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      recordingPath: AD,
    });
    await d.ensureSession('myapp://validity?component=x');
    await d.inputText('id="password"', 'hunter2', {
      recordAs: 'login password',
    });
    const fill = calls.at(-1)!;
    expect(fill).toEqual([
      'agent-device',
      'fill',
      'id="password"',
      'hunter2',
      '--record-as',
      'LOGIN_PASSWORD',
      ...SETTLE_ARGS,
    ]);
    expect(fill).not.toContain('--no-record');
  });

  it('replays a recording through `agent-device replay --json`', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, ...args]);
      return {
        code: 0,
        stdout: JSON.stringify({
          success: true,
          data: { replayed: 2, session: 's' },
        }),
        stderr: '',
      };
    });
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run });
    const res = await d.replayRecording(AD);
    expect(calls[0]).toEqual(['agent-device', 'replay', AD, '--json']);
    expect(res.outcome).toBe('reproduced');
  });
});

/* -------------------------------------------------------------------------- */
/* 0.20.5: press, settled diffs, ref generations, cost, remote profiles        */
/* -------------------------------------------------------------------------- */

/** A `--settle --json` press response, shaped like the 0.20.5 contract. */
function settleResponse(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    success: true,
    data: {
      targetKind: 'ref',
      ref: '@e7',
      settle: {
        settled: true,
        waitedMs: 612,
        captures: 3,
        quietMs: 500,
        timeoutMs: 5000,
        refsGeneration: 4,
        diff: {
          summary: { additions: 2, removals: 1, unchanged: 9 },
          lines: [
            { kind: 'added', text: '@e21 [button] "Checkout"', ref: 'e21' },
            { kind: 'added', text: '@e22 [text] "Added to cart"', ref: 'e22' },
            { kind: 'removed', text: '@e9 [button] "Add to cart"' },
          ],
        },
        tail: [{ ref: 'e3', role: 'button', label: 'Close' }],
        ...over,
      },
      cost: { wallClockMs: 812, runnerRoundTrips: 2 },
    },
  });
}

describe('parseSettleJson', () => {
  it('reads the settled diff, its refs generation and its unchanged tail', () => {
    const s = parseSettleJson(settleResponse())!;
    expect(s.settled).toBe(true);
    expect(s.refsGeneration).toBe(4);
    expect(s.waitedMs).toBe(612);
    expect(s.summary).toEqual({ additions: 2, removals: 1, unchanged: 9 });
    expect(s.lines.map((l) => l.kind)).toEqual(['added', 'added', 'removed']);
    expect(s.lines[0]!.ref).toBe('e21');
    // Removed lines name the REPLACED tree, so upstream mints no ref for them.
    expect(s.lines[2]!.ref).toBeUndefined();
    expect(s.tail).toEqual([{ ref: 'e3', role: 'button', label: 'Close' }]);
  });

  it('answers undefined when the response carries no settle block at all', () => {
    expect(
      parseSettleJson(JSON.stringify({ success: true, data: { ref: '@e1' } })),
    ).toBeUndefined();
    expect(parseSettleJson('Pressed @e7')).toBeUndefined();
    expect(parseSettleJson('')).toBeUndefined();
  });

  it('tolerates every field being absent — absence is "could not tell", not "no change"', () => {
    const s = parseSettleJson(JSON.stringify({ success: true, data: { settle: {} } }))!;
    expect(s.settled).toBe(false);
    expect(s.refsGeneration).toBeUndefined();
    expect(s.lines).toEqual([]);
    expect(s.tail).toEqual([]);
  });

  it('never reports settled:true unless upstream said so', () => {
    const notSettled = JSON.stringify({
      success: true,
      data: { settle: { settled: false, waitedMs: 5000, hint: 'still moving' } },
    });
    const s = parseSettleJson(notSettled)!;
    expect(s.settled).toBe(false);
    expect(s.hint).toBe('still moving');
  });

  it('drops malformed diff/tail entries instead of throwing', () => {
    const messy = JSON.stringify({
      success: true,
      data: {
        settle: {
          settled: true,
          diff: { lines: [null, 3, { kind: 'sideways', text: 'x' }, { kind: 'added' }] },
          tail: [{ role: 'button' }, 'nope'],
        },
      },
    });
    const s = parseSettleJson(messy)!;
    expect(s.lines).toEqual([{ kind: 'added', text: '' }]);
    expect(s.tail).toEqual([]);
  });
});

describe('renderSettleAsSnapshotText', () => {
  it('keeps added lines and the tail, and DROPS removed ones', () => {
    const s = parseSettleJson(settleResponse())!;
    const text = renderSettleAsSnapshotText(s);
    expect(text).toContain('@e21 [button] "Checkout"');
    expect(text).toContain('@e3 [button] "Close"');
    // A removed element must never be matchable — a presence check resolving
    // against it would pass on something that just left the screen.
    expect(text).not.toContain('Add to cart');
  });
});

describe('parseDiffSnapshotJson', () => {
  const envelope = (data: unknown): string => JSON.stringify({ success: true, data });

  it('keeps added and unchanged lines (both describe the CURRENT tree)', () => {
    const text = parseDiffSnapshotJson(
      envelope({
        mode: 'snapshot',
        baselineInitialized: false,
        summary: { additions: 1, removals: 1, unchanged: 1 },
        lines: [
          { kind: 'added', text: '@e21 [button] "Checkout"' },
          { kind: 'removed', text: '@e9 [button] "Add to cart"' },
          { kind: 'unchanged', text: '@e1 [text] "Cart"' },
        ],
      }),
    );
    expect(text).toBe('@e21 [button] "Checkout"\n@e1 [text] "Cart"');
  });

  it('answers undefined for a freshly initialized baseline (no diff exists yet)', () => {
    expect(
      parseDiffSnapshotJson(envelope({ mode: 'snapshot', baselineInitialized: true, lines: [] })),
    ).toBeUndefined();
  });

  it('answers undefined on an unreadable envelope rather than an empty tree', () => {
    expect(parseDiffSnapshotJson('not json')).toBeUndefined();
    expect(parseDiffSnapshotJson(envelope({ mode: 'snapshot' }))).toBeUndefined();
  });
});

describe('parseCommandCostMs', () => {
  it('reads the daemon-measured wall clock out of a --cost response', () => {
    expect(parseCommandCostMs(settleResponse())).toBe(812);
  });

  it('answers undefined when no cost was reported — never 0', () => {
    // "Nothing reported" and "the command was free" are different claims, and
    // a 0 would quietly pull a session's cost total down.
    expect(parseCommandCostMs(JSON.stringify({ success: true, data: {} }))).toBeUndefined();
    expect(
      parseCommandCostMs(
        JSON.stringify({ success: true, data: { cost: { runnerRoundTrips: 2 } } }),
      ),
    ).toBeUndefined();
    expect(parseCommandCostMs('Pressed @e7')).toBeUndefined();
  });
});

describe('pinRef / stripRefPin', () => {
  it('pins a bare ref to its generation', () => {
    expect(pinRef('@e12', 4)).toBe('@e12~s4');
  });

  it('leaves a ref alone when the generation is unknown — a guessed pin is rejected by iOS', () => {
    expect(pinRef('@e12', undefined)).toBe('@e12');
    expect(pinRef('@e12', Number.NaN)).toBe('@e12');
  });

  it('never pins a selector or an already-pinned ref', () => {
    expect(pinRef('label="Send"', 4)).toBe('label="Send"');
    expect(pinRef('@e12~s3', 4)).toBe('@e12~s3');
  });

  it('strips a pin back to the bare ref', () => {
    expect(stripRefPin('@e12~s4')).toBe('@e12');
    expect(stripRefPin('@e12')).toBe('@e12');
  });
});

describe('AgentDeviceDriver — 0.20.5 alignment', () => {
  beforeEach(() => {
    resetNativeSessionRegistry();
    resetCommandCost();
  });

  it('taps with `press`, the canonical 0.20.5 verb', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.click('label="Submit"');
    expect(DEFAULT_TAP_ARGS).toEqual(['press']);
    expect(run).toHaveBeenLastCalledWith(
      'agent-device',
      ['press', 'label="Submit"', ...SETTLE_ARGS],
      { env: { AGENT_DEVICE_PLATFORM: 'ios' } },
    );
  });

  it('settle:false restores the pre-0.20.5 argv exactly', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', run, settle: false, cost: false });
    await d.click('@e1');
    expect(run).toHaveBeenLastCalledWith('agent-device', ['press', '@e1'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });

  it('attaches the settled diff to the ExecResult and exposes it as lastSettle()', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: settleResponse(), stderr: '' }));
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    const res = await d.click('@e7');
    expect(res.settle?.settled).toBe(true);
    expect(res.settle?.refsGeneration).toBe(4);
    expect(d.lastSettle()?.lines).toHaveLength(3);
  });

  it('clears the previous settle when the next action returns none', async () => {
    let stdout = settleResponse();
    const run = vi.fn(async () => ({ code: 0, stdout, stderr: '' }));
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.click('@e7');
    expect(d.lastSettle()).toBeDefined();
    stdout = 'Pressed @e8';
    await d.click('@e8');
    // A stale diff read as "what THIS tap changed" would be fabricated evidence.
    expect(d.lastSettle()).toBeUndefined();
  });

  it('pins a ref the settled diff minted, and only that ref', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_bin: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: settleResponse(), stderr: '' };
    });
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.click('@e7');
    // @e21 came off the settled diff's added lines → pinned at generation 4.
    await d.click('@e21');
    expect(calls.at(-1)![1]).toBe('@e21~s4');
    // @e99 was never minted by that tree, so nothing here can vouch for it.
    await d.click('@e99');
    expect(calls.at(-1)![1]).toBe('@e99');
  });

  it('pins the unchanged-interactive tail too (upstream calls it actionable)', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_bin: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: settleResponse(), stderr: '' };
    });
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.click('@e7');
    await d.inputText('@e3', 'hello');
    expect(calls.at(-1)!.slice(0, 3)).toEqual(['fill', '@e3~s4', 'hello']);
  });

  it('pins nothing before any settled diff has been seen (the pre-0.20.5 path)', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_bin: string, args: string[]) => {
      calls.push(args);
      return ok;
    });
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.click('@e5');
    expect(calls.at(-1)![1]).toBe('@e5');
  });

  it('folds the daemon-reported cost into the session-metrics accumulator', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: settleResponse(), stderr: '' }));
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    const res = await d.click('@e7');
    expect(res.costMs).toBe(812);
    expect(commandCostTotals()).toEqual({ totalMs: 812, samples: 1 });
  });

  it('appends the remote profile to EVERY agent-device command, and to no other bin', async () => {
    const calls: [string, string[]][] = [];
    const run = vi.fn(async (bin: string, args: string[]) => {
      calls.push([bin, args]);
      return bin === 'agent-device' ? { code: 1, stdout: '', stderr: 'nope' } : ok;
    });
    const d = new AgentDeviceDriver({
      platform: 'android',
      scheme: 'myapp',
      run,
      remoteConfigPath: './remote-config.json',
    });
    await d.openUrl('myapp://x');
    await d.snapshot();
    const agentCalls = calls.filter(([bin]) => bin === 'agent-device');
    expect(agentCalls.length).toBeGreaterThan(0);
    for (const [, args] of agentCalls) {
      expect(args.slice(-2)).toEqual(['--remote-config', './remote-config.json']);
    }
    // The platform-CLI fallback must never see the flag — adb rejects it.
    for (const [bin, args] of calls.filter(([b]) => b !== 'agent-device')) {
      expect(args, bin).not.toContain('--remote-config');
    }
  });

  it('leaves argv byte-identical when no remote profile is configured', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.snapshot();
    expect(run).toHaveBeenLastCalledWith('agent-device', DEFAULT_SNAPSHOT_ARGS, {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });
});

describe('AgentDeviceDriver.postActionView — the 0.20.5 ladder', () => {
  beforeEach(() => resetNativeSessionRegistry());

  it('rung 1: continues from the settled diff the mutation already returned', async () => {
    const calls: string[][] = [];
    const run = vi.fn(async (_bin: string, args: string[]) => {
      calls.push(args);
      return { code: 0, stdout: settleResponse(), stderr: '' };
    });
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.click('@e7');
    const view = await d.postActionView();
    expect(view.source).toBe('settled-diff');
    expect(view.refsGeneration).toBe(4);
    expect(view.text).toContain('@e21 [button] "Checkout"');
    // A change view is NEVER complete — an absence assertion must refuse it.
    expect(view.complete).toBe(false);
    // No extra device round trip was spent.
    expect(calls.filter((a) => a[0] === 'diff')).toHaveLength(0);
  });

  it('rung 2: falls back to `diff snapshot -i` when no settled diff is held', async () => {
    const run = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'diff') {
        return {
          code: 0,
          stdout: JSON.stringify({
            success: true,
            data: {
              mode: 'snapshot',
              baselineInitialized: false,
              lines: [{ kind: 'added', text: '@e5 [button] "Retry"' }],
            },
          }),
          stderr: '',
        };
      }
      return ok;
    });
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    const view = await d.postActionView();
    expect(view.source).toBe('diff-snapshot');
    expect(view.text).toBe('@e5 [button] "Retry"');
    expect(view.complete).toBe(false);
    expect(run).toHaveBeenCalledWith(
      'agent-device',
      ['diff', 'snapshot', '-i', '--json', '--cost'],
      { env: { AGENT_DEVICE_PLATFORM: 'ios' } },
    );
  });

  it('rung 3: a full snapshot is the only COMPLETE view', async () => {
    const run = vi.fn(async (_bin: string, args: string[]) =>
      args[0] === 'snapshot'
        ? { code: 0, stdout: '@e1 [text] "Hello"', stderr: '' }
        : { code: 1, stdout: '', stderr: 'diff unsupported' },
    );
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    const view = await d.postActionView();
    expect(view.source).toBe('full-snapshot');
    expect(view.complete).toBe(true);
    expect(view.text).toBe('@e1 [text] "Hello"');
  });

  it('skips a settle that did not settle rather than reporting an empty screen', async () => {
    const run = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'press') {
        return {
          code: 0,
          stdout: JSON.stringify({
            success: true,
            data: { settle: { settled: false, waitedMs: 5000 } },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'diff') return { code: 1, stdout: '', stderr: 'no baseline' };
      return { code: 0, stdout: '@e1 [text] "Still here"', stderr: '' };
    });
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.click('@e7');
    const view = await d.postActionView();
    expect(view.source).toBe('full-snapshot');
    expect(view.text).toBe('@e1 [text] "Still here"');
  });
});

describe('AgentDeviceDriver.runInSession — the evidence seam', () => {
  beforeEach(() => resetNativeSessionRegistry());

  it('runs an arbitrary verb through this driver’s bin, env and plumbing', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({
      platform: 'android',
      device: 'emulator-5554',
      run,
      remoteConfigPath: '/tmp/remote.json',
    });
    await d.runInSession(['perf', 'metrics', '--json']);
    expect(run).toHaveBeenLastCalledWith(
      'agent-device',
      ['perf', 'metrics', '--json', '--remote-config', '/tmp/remote.json'],
      { env: { AGENT_DEVICE_PLATFORM: 'android', AGENT_DEVICE_ID: 'emulator-5554' } },
    );
  });

  it('honors a caller timeout, and omits it otherwise', async () => {
    const run = vi.fn(async () => ok);
    const d = new AgentDeviceDriver({ platform: 'ios', run });
    await d.runInSession(['network', 'dump', '--json'], { timeoutMs: 90_000 });
    expect(run).toHaveBeenLastCalledWith('agent-device', ['network', 'dump', '--json'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
      timeoutMs: 90_000,
    });
    await d.runInSession(['events', '--json']);
    expect(run).toHaveBeenLastCalledWith('agent-device', ['events', '--json'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios' },
    });
  });
});

describe('AgentDeviceDriver — abandoning a recording (fail-closed publication)', () => {
  const AD_PATH = '/runs/r1/replay.ad';

  beforeEach(() => resetNativeSessionRegistry());

  /** Arm a recording the way a real session-establishing open does. */
  async function armed(run: CommandRunner): Promise<AgentDeviceDriver> {
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      run,
      recordingPath: AD_PATH,
    });
    await d.ensureSession('myapp://validity?component=x');
    return d;
  }

  it('refuses to publish once abandoned, and reports the REASON', async () => {
    const calls: string[][] = [];
    const d = await armed(async (_bin: string, args: string[]) => {
      calls.push(args);
      return ok;
    });
    d.abandonRecording('a secret would have been written to the script literally');
    const res = await d.publishRecording();
    expect(res.published).toBe(false);
    expect(res.reason).toContain('secret');
    expect(res.path).toBe(AD_PATH);
    // Fail-closed means the publish command never ran at all.
    expect(calls.some((a) => a[0] === 'session')).toBe(false);
  });

  it('keeps the FIRST reason — a later, vaguer one must not overwrite it', async () => {
    const d = await armed(async () => ok);
    d.abandonRecording('first: unresolved ${PASSWORD}');
    d.abandonRecording('second: something went wrong');
    expect((await d.publishRecording()).reason).toContain('first');
  });

  it('is a no-op when nothing was armed — it must not invent a recording', async () => {
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', run: async () => ok });
    d.abandonRecording('nothing to abandon');
    expect(d.recordingState()).toBeUndefined();
    expect((await d.publishRecording()).reason).toContain('no recording was armed');
  });
});

describe('AgentDeviceDriver.replayRecording — 0.20.5 invocation options', () => {
  const AD_PATH = '/runs/r1/replay.ad';
  const replayOk: ExecResult = {
    code: 0,
    stdout: JSON.stringify({ success: true, data: { replayed: 3, session: 's' } }),
    stderr: '',
  };

  beforeEach(() => resetNativeSessionRegistry());

  it('is BYTE-IDENTICAL to the pre-0.20.5 argv when no options are passed', async () => {
    const calls: string[][] = [];
    const d = new AgentDeviceDriver({
      platform: 'ios',
      run: async (_bin, args) => {
        calls.push(args);
        return replayOk;
      },
    });
    await d.replayRecording(AD_PATH);
    expect(calls[0]).toEqual(['replay', AD_PATH, '--json']);
  });

  it('passes env pairs then --keep-session, in that fixed order', async () => {
    const calls: string[][] = [];
    const d = new AgentDeviceDriver({
      platform: 'ios',
      run: async (_bin, args) => {
        calls.push(args);
        return replayOk;
      },
    });
    const res = await d.replayRecording(AD_PATH, {
      keepSession: true,
      env: [
        { name: 'PASSWORD', value: 'hunter2' },
        { name: 'TOKEN', value: 'abc' },
      ],
    });
    expect(calls[0]).toEqual([
      'replay',
      AD_PATH,
      '--json',
      '-e',
      'PASSWORD=hunter2',
      '-e',
      'TOKEN=abc',
      '--keep-session',
    ]);
    expect(res.outcome).toBe('reproduced');
  });
});

/* ------------------------------------------------------------------ *
 * Process-end session close-out — the device-claim lifecycle.         *
 * ------------------------------------------------------------------ */

describe('closeEstablishedNativeSessions', () => {
  beforeEach(() => {
    resetNativeSessionRegistry();
  });

  /** Records the FULL call, options included — the cwd is half of what is asserted. */
  const spy = (): {
    calls: { bin: string; args: string[]; opts?: RunOptions }[];
    run: CommandRunner;
  } => {
    const calls: { bin: string; args: string[]; opts?: RunOptions }[] = [];
    const run = vi.fn(
      async (bin: string, args: string[], opts?: RunOptions): Promise<ExecResult> => {
        calls.push({ bin, args, ...(opts ? { opts } : {}) });
        return ok;
      },
    );
    return { calls, run };
  };

  it('closes each established session with the cwd it was opened against', async () => {
    const { calls, run } = spy();
    const d = new AgentDeviceDriver({
      platform: 'ios',
      scheme: 'myapp',
      device: 'ABC',
      cwd: '/p',
      run,
    });
    await d.ensureSession('myapp://validity?component=x');
    expect(
      nativeSessionEstablished(nativeSessionKey({ platform: 'ios', device: 'ABC', cwd: '/p' })),
    ).toBe(true);

    const summary = await closeEstablishedNativeSessions();

    const close = calls.at(-1)!;
    expect(close.bin).toBe('agent-device');
    // UNQUALIFIED, like the `open` that established it: `--session` would turn
    // OFF upstream's cwd scoping and address the global `default` session.
    expect(close.args).toEqual(['close']);
    expect(close.opts?.cwd).toBe('/p');
    expect(close.opts?.env).toMatchObject({ AGENT_DEVICE_PLATFORM: 'ios', AGENT_DEVICE_ID: 'ABC' });
    // Bounded far below the normal command budget — teardown must not hang a
    // run that has already produced its verdict.
    expect(close.opts?.timeoutMs).toBe(SESSION_CLOSE_TIMEOUT_MS);
    expect(close.opts!.timeoutMs!).toBeLessThan(DEFAULT_COMMAND_TIMEOUT_MS);
    expect(summary).toEqual({ closed: 1, failed: 0 });
  });

  it('carries the remote profile, so a cloud session is not closed against the local daemon', async () => {
    const { calls, run } = spy();
    const d = new AgentDeviceDriver({
      platform: 'android',
      scheme: 'myapp',
      cwd: '/p',
      remoteConfigPath: '/p/remote.json',
      run,
    });
    await d.ensureSession('myapp://validity?component=x');
    await closeEstablishedNativeSessions();
    expect(calls.at(-1)!.args).toEqual(['close', '--remote-config', '/p/remote.json']);
  });

  it('is idempotent: a second call closes nothing', async () => {
    const { calls, run } = spy();
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/p', run });
    await d.ensureSession('myapp://validity?component=x');
    await closeEstablishedNativeSessions();
    const after = calls.length;
    const second = await closeEstablishedNativeSessions();
    expect(calls.length).toBe(after);
    expect(second).toEqual({ closed: 0, failed: 0 });
  });

  it('never throws, and one wedged close does not block the others', async () => {
    const closed: string[] = [];
    const failing: CommandRunner = async (_bin, args) => {
      if (args[0] === 'close') throw new Error('daemon is gone');
      return ok;
    };
    const working: CommandRunner = async (_bin, args, opts) => {
      if (args[0] === 'close') closed.push(String(opts?.cwd));
      return ok;
    };
    const a = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/a', run: failing });
    const b = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/b', run: working });
    await a.ensureSession('myapp://validity?component=x');
    await b.ensureSession('myapp://validity?component=x');

    const summary = await closeEstablishedNativeSessions();

    expect(summary).toEqual({ closed: 1, failed: 1 });
    expect(closed).toEqual(['/b']);
    // The registry is cleared either way: a session that could not be closed at
    // teardown will not be closable a second later, and a retry would trade a
    // finished run for a hang.
    expect(nativeSessionEstablished(nativeSessionKey({ platform: 'ios', cwd: '/a' }))).toBe(false);
    expect(nativeSessionEstablished(nativeSessionKey({ platform: 'ios', cwd: '/b' }))).toBe(false);
  });

  it('counts a non-zero close as failed rather than throwing', async () => {
    const run: CommandRunner = async (_bin, args) =>
      args[0] === 'close' ? { code: 1, stdout: '', stderr: 'SESSION_NOT_FOUND' } : ok;
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/p', run });
    await d.ensureSession('myapp://validity?component=x');
    expect(await closeEstablishedNativeSessions()).toEqual({ closed: 0, failed: 1 });
  });

  it('closes nothing when the open never established a session', async () => {
    // The platform-CLI fallback delivers the deep link without a session; a
    // close for it would be addressed at a session that does not exist.
    const calls: string[][] = [];
    const run: CommandRunner = async (bin, args) => {
      calls.push([bin, ...args]);
      return bin === 'agent-device' ? { code: 1, stdout: '', stderr: 'no device' } : ok;
    };
    const d = new AgentDeviceDriver({ platform: 'ios', scheme: 'myapp', cwd: '/p', run });
    await d.ensureSession('myapp://validity?component=x');
    expect(await closeEstablishedNativeSessions()).toEqual({ closed: 0, failed: 0 });
    expect(calls.some((c) => c[1] === 'close')).toBe(false);
  });
});
