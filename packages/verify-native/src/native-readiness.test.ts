import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  checkNativeReadiness,
  checkPackageInternalPaths,
  compareVersions,
  MIN_AGENT_DEVICE_VERSION,
  parseAgentDeviceVersion,
  defaultCompanionApkRoots,
  findNewestApk,
  listBootedDevices,
} from './native-readiness.js';
import { writeBuildMarker, EXPO_ROUTER_STORE_SPECIFIER } from './prepare-native-app.js';
import {
  EXPO_ROUTER_ROUTE_SPECIFIER,
  RN_INITIALIZE_CORE_SPECIFIER,
  RN_LAZY_GLOBAL_CANARY_SPECIFIER,
} from './prepare-native.js';
import type { CommandRunner, ExecResult } from './agent-device-driver.js';
import type { DiagnosisFs } from './environment-diagnosis.js';

/**
 * The daemon/claim probes read agent-device's state dir. Point every readiness
 * test at a path that does not exist, so the checklist is a function of its
 * inputs and never of whatever the developer's machine happens to have claimed.
 */
const ISOLATED_STATE_DIR = join(tmpdir(), 'validity-no-such-agent-device-state');

const dirs: string[] = [];
function project(pkg: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-readiness-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Write a file (creating parent dirs) inside a fake node_modules tree. */
function file(root: string, rel: string, content = ''): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A fake installed tree where every version-coupled internal path resolves. */
function installFakePackages(root: string, opts: { expoRouter?: boolean } = {}): void {
  file(root, 'node_modules/react-native/package.json', JSON.stringify({ version: '0.81.0' }));
  file(root, 'node_modules/react-native/Libraries/Core/InitializeCore.js');
  file(root, 'node_modules/react-native/Libraries/Network/FormData.js');
  if (opts.expoRouter) {
    file(root, 'node_modules/expo-router/package.json', JSON.stringify({ version: '4.0.0' }));
    file(root, 'node_modules/expo-router/build/global-state/router-store.js');
    file(root, 'node_modules/expo-router/build/Route.js');
  }
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const fail = (): ExecResult => ({ code: 1, stdout: '', stderr: '' });

// A runner that answers each tool the way a fully-ready iOS machine would.
function readyRunner() {
  return vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
    if (bin === 'agent-device') return ok('1.0.0');
    if (bin === 'xcrun' && args.includes('list')) return ok('iPhone 15 (ABC) (Booted)');
    if (bin === 'xcrun' && args.includes('get_app_container')) return ok('/path/to/app');
    return ok();
  });
}

const fullPkg = {
  dependencies: { expo: '51', 'react-native': '0.74' },
  devDependencies: {
    msw: '2',
    'react-native-url-polyfill': '2',
    'fast-text-encoding': '1',
    '@react-native-async-storage/async-storage': '1',
  },
};

describe('checkNativeReadiness', () => {
  it('reports ready when every prerequisite is met', async () => {
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project(fullPkg),
      platform: 'ios',
      scheme: 'myapp',
      run: readyRunner(),
    });
    expect(r.ready).toBe(true);
    expect(r.nextAction).toBeUndefined();
    expect(r.steps.every((s) => s.status === 'ok')).toBe(true);
  });

  it('adds an Android Metro-reachability (adb reverse) step on android with a booted device', async () => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device') return ok('1.0.0');
      if (bin === 'adb' && args[0] === 'devices') return ok('emulator-5554\tdevice');
      if (bin === 'adb' && args[0] === 'reverse') return ok();
      if (bin === 'adb' && args.includes('list')) return ok('package:ai.validity.playground');
      return ok();
    });
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project({ ...fullPkg, dependencies: { 'react-native': '0.74' } }),
      platform: 'android',
      scheme: 'myapp',
      run,
    });
    const step = r.steps.find((s) => s.id === 'android-reverse');
    expect(step?.status).toBe('ok');
    expect(run).toHaveBeenCalledWith('adb', ['reverse', 'tcp:8082', 'tcp:8082']);
  });

  it('pins the device-touching probes (companion-installed, adb reverse) to the pinned device', async () => {
    // With >1 booted device an unpinned `simctl … booted` / bare `adb shell`
    // is ambiguous, so an unpinned probe can answer for the WRONG device and
    // the checklist then demands a rebuild for a device the companion IS
    // installed on. The pinned udid/serial must ride every device-touching
    // probe command.
    const calls: Array<[string, string[]]> = [];
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      calls.push([bin, args]);
      if (bin === 'agent-device') return ok('1.0.0');
      if (bin === 'adb' && args[0] === 'devices') return ok('emulator-5554\tdevice');
      if (bin === 'adb') return ok('package:ai.validity.playground');
      return ok();
    });
    await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project({ ...fullPkg, dependencies: { 'react-native': '0.74' } }),
      platform: 'android',
      scheme: 'myapp',
      device: 'emulator-5554',
      run,
    });
    expect(run).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'reverse',
      'tcp:8082',
      'tcp:8082',
    ]);
    expect(run).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'shell',
      'pm',
      'list',
      'packages',
      'ai.validity.playground',
    ]);
    // No device-touching adb command ran unpinned (the device-list probe
    // itself has nothing to pin on).
    for (const [bin, args] of calls) {
      if (bin === 'adb' && args[0] !== 'devices')
        expect(args.slice(0, 2)).toEqual(['-s', 'emulator-5554']);
    }
  });

  it('flags adb reverse as todo when it fails on android', async () => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device') return ok('1.0.0');
      if (bin === 'adb' && args[0] === 'devices') return ok('emulator-5554\tdevice');
      if (bin === 'adb' && args[0] === 'reverse') return fail();
      return ok();
    });
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project({ dependencies: { 'react-native': '0.74' } }),
      platform: 'android',
      scheme: 'myapp',
      run,
    });
    expect(r.steps.find((s) => s.id === 'android-reverse')?.status).toBe('todo');
  });

  it('omits the android-reverse step on iOS', async () => {
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project(fullPkg),
      platform: 'ios',
      scheme: 'myapp',
      run: readyRunner(),
    });
    expect(r.steps.find((s) => s.id === 'android-reverse')).toBeUndefined();
  });

  it('flags missing mock deps with an install command', async () => {
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project({ dependencies: { expo: '51', 'react-native': '0.74' } }),
      platform: 'ios',
      scheme: 'myapp',
      run: readyRunner(),
    });
    const step = r.steps.find((s) => s.id === 'mock-deps')!;
    expect(step.status).toBe('todo');
    expect(step.action).toMatch(/npm i -D .*msw/);
  });

  it('flags a missing scheme', async () => {
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project(fullPkg),
      platform: 'ios',
      run: readyRunner(),
    });
    expect(r.steps.find((s) => s.id === 'scheme')!.status).toBe('todo');
  });

  it('flags a missing agent-device CLI', async () => {
    const run = vi.fn(async (bin: string): Promise<ExecResult> => {
      if (bin === 'agent-device') return fail();
      if (bin === 'xcrun') return ok('iPhone 15 (Booted)');
      return ok();
    });
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project(fullPkg),
      platform: 'ios',
      scheme: 'a',
      run,
    });
    const step = r.steps.find((s) => s.id === 'agent-device')!;
    expect(step.status).toBe('todo');
    expect(step.action).toBe('npm i -g agent-device');
  });

  // ---- agent-device VERSION floor ------------------------------------------
  //
  // Presence was the only thing checked, and that is how a four-minors-stale
  // install went unnoticed: on 0.16.4 `agent-device open` cannot open a Validity
  // deep link on Android at all (exits 127, "/system/bin/sh: -p: inaccessible or
  // not found") while raw `adb … VIEW -d` works on the same URL. Every spec that
  // has to deep-link then reports "no mechanical verdict produced" — an entire
  // sweep of silence with nothing pointing at the tool.

  const agentDeviceStep = async (versionOut: string) => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device') return ok(versionOut);
      if (bin === 'xcrun' && args.includes('list')) return ok('iPhone 15 (ABC) (Booted)');
      return ok();
    });
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project(fullPkg),
      platform: 'ios',
      scheme: 'a',
      run,
    });
    return { step: r.steps.find((s) => s.id === 'agent-device')!, ready: r.ready };
  };

  it('flags an agent-device older than the verified floor, and says what breaks', async () => {
    const { step, ready } = await agentDeviceStep('0.16.4');
    expect(step.status).toBe('todo');
    expect(step.detail).toContain('0.16.4');
    expect(step.detail).toContain(MIN_AGENT_DEVICE_VERSION);
    // The message has to name the SYMPTOM, or the next person debugs a sweep of
    // unverifiables instead of running one upgrade.
    expect(step.detail).toMatch(/deep link/i);
    expect(step.action).toMatch(/npm i -g agent-device/);
    expect(ready).toBe(false);
  });

  it('holds the floor at 0.20.5 — the release whose behaviours the driver ISSUES', async () => {
    // Pinned as a literal on purpose: every other assertion here reads the
    // constant, so a raise/lower would otherwise be invisible in review. 0.20.5
    // is the release the driver's argv was VERIFIED against — `press`,
    // `--settle` + settled diffs, versioned refs, `diff snapshot`, `--cost` and
    // `--remote-config` — and none of those was bisected backwards, so the
    // floor is where the evidence is, not where a guess is.
    expect(MIN_AGENT_DEVICE_VERSION).toBe('0.20.5');
    // The previous floor is now BELOW it and must be flagged as such.
    const { step, ready } = await agentDeviceStep('0.20.3');
    expect(step.status).toBe('todo');
    expect(ready).toBe(false);
  });

  it('accepts exactly the floor, and anything newer', async () => {
    expect((await agentDeviceStep(MIN_AGENT_DEVICE_VERSION)).step.status).toBe('ok');
    expect((await agentDeviceStep('0.21.0')).step.status).toBe('ok');
    expect((await agentDeviceStep('1.0.0')).step.status).toBe('ok');
    // Reported back, so a bug report carries the version without another command.
    expect((await agentDeviceStep('0.21.0')).step.detail).toContain('0.21.0');
  });

  it('does NOT fail a working install whose --version output it cannot parse', async () => {
    // The floor exists to explain one specific broken behavior. Refusing to call
    // a working CLI ready because its banner changed shape would be a worse
    // failure than the one being prevented.
    const { step } = await agentDeviceStep('agent-device (build abc123)');
    expect(step.status).toBe('ok');
    expect(step.detail).toMatch(/version not reported/i);
  });

  it('compareVersions orders numerically, not lexically', () => {
    // The bug this prevents: '0.9.0' > '0.20.1' under string compare, so a
    // genuinely stale install would sail through the gate.
    expect(compareVersions('0.9.0', '0.20.1')).toBeLessThan(0);
    expect(compareVersions('0.16.4', '0.20.1')).toBeLessThan(0);
    expect(compareVersions('0.20.1', '0.20.1')).toBe(0);
    expect(compareVersions('1.0.0', '0.20.1')).toBeGreaterThan(0);
    expect(compareVersions('v0.20.2', '0.20.1')).toBeGreaterThan(0);
    // A prerelease of the required version counts as that version rather than
    // being rejected on punctuation.
    expect(compareVersions('0.20.1-beta.2', '0.20.1')).toBe(0);
  });

  it('parseAgentDeviceVersion pulls the version out of banner-ish output', () => {
    expect(parseAgentDeviceVersion('0.20.1')).toBe('0.20.1');
    expect(parseAgentDeviceVersion('agent-device v0.20.1\n')).toBe('0.20.1');
    expect(parseAgentDeviceVersion('no version here')).toBeUndefined();
  });

  it('flags no booted device and reports the companion app as not installed', async () => {
    const run = vi.fn(async (bin: string): Promise<ExecResult> => {
      if (bin === 'agent-device') return ok('1.0.0');
      if (bin === 'xcrun') return ok(''); // no "(Booted)"
      return ok();
    });
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project(fullPkg),
      platform: 'ios',
      scheme: 'a',
      run,
    });
    expect(r.steps.find((s) => s.id === 'device')!.status).toBe('todo');
    expect(r.steps.find((s) => s.id === 'companion-app')!.status).toBe('todo');
    expect(r.ready).toBe(false);
    // nextAction is the first todo — the device boot.
    expect(r.nextAction?.id).toBe('device');
  });

  it('flags an installed-but-STALE companion app for rebuild (buildHash mismatch)', async () => {
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project(fullPkg),
      platform: 'ios',
      scheme: 'a',
      run: readyRunner(), // app reports installed
      buildHash: 'newhash',
      buildMarkerPath: '/tmp/does-not-exist-marker', // no marker → stale
    });
    const step = r.steps.find((s) => s.id === 'companion-app')!;
    expect(step.status).toBe('todo');
    expect(step.detail).toMatch(/STALE/);
    expect(r.ready).toBe(false);
  });

  it('explains a REVISION-driven rebuild (splash removed + unique scheme) instead of the generic STALE message', async () => {
    // The splash strip + companion-unique-scheme changes flip buildHash for
    // every pre-revision install. The marker those installs carry is the
    // legacy bare-hash format (revision 1), and the checklist must say WHY the
    // rebuild is needed — an unexplained rebuild prompt right after upgrading
    // Validity reads like the old flakiness returning. The reason names BOTH
    // shipped revision changes (a rev-1 install jumps past both at once).
    const dir = project(fullPkg);
    const markerPath = join(dir, '.validity-build');
    writeFileSync(markerPath, 'legacy-bare-hash'); // pre-revision marker
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: dir,
      platform: 'ios',
      scheme: 'a',
      run: readyRunner(), // app reports installed
      buildHash: 'newhash',
      buildMarkerPath: markerPath,
    });
    const step = r.steps.find((s) => s.id === 'companion-app')!;
    expect(step.status).toBe('todo');
    expect(step.detail).toContain('splash screen removed for reliable reloads');
    expect(step.detail).toContain('unique URL scheme');
    expect(step.detail).toContain('rebuild once');
    expect(step.action).toContain('validity browse --native');
  });

  it('a stale build at the CURRENT revision with an inputs-less marker gets the generic rebuild-once message', async () => {
    // Markers written by older Validity ({hash, rev} or bare hash) carry no
    // build inputs, so the cause of the mismatch can't be named — the user
    // pays one generic-reason rebuild, after which the rewritten marker
    // persists inputs and future mismatches get a named diff.
    const dir = project(fullPkg);
    const markerPath = join(dir, '.validity-build');
    writeBuildMarker(markerPath, 'oldhash'); // current-revision marker, old hash, NO inputs
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: dir,
      platform: 'ios',
      scheme: 'a',
      run: readyRunner(),
      buildHash: 'newhash',
      buildMarkerPath: markerPath,
      buildInputs: { nativeDeps: {}, expoConfig: { plugins: [] } },
    });
    const step = r.steps.find((s) => s.id === 'companion-app')!;
    expect(step.status).toBe('todo');
    expect(step.detail).toMatch(/STALE/);
    expect(step.detail).toContain('Rebuild once');
    expect(step.detail).not.toContain('splash');
  });

  it('NAMES the flipped input when the marker persisted its build inputs (dep version diff)', async () => {
    // The whole point of persisting inputs: "rebuild" prompts must say WHY —
    // an unexplained one right after a dep upgrade reads like flakiness.
    const dir = project(fullPkg);
    const markerPath = join(dir, '.validity-build');
    writeBuildMarker(markerPath, 'oldhash', {
      nativeDeps: { 'expo-router': '3.4.0' },
      expoConfig: { plugins: [], newArchEnabled: false },
    });
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: dir,
      platform: 'ios',
      scheme: 'a',
      run: readyRunner(),
      buildHash: 'newhash',
      buildMarkerPath: markerPath,
      buildInputs: {
        nativeDeps: { 'expo-router': '4.0.0' },
        expoConfig: { plugins: [], newArchEnabled: true },
      },
    });
    const step = r.steps.find((s) => s.id === 'companion-app')!;
    expect(step.status).toBe('todo');
    expect(step.detail).toContain('native deps changed: expo-router 3.4.0→4.0.0');
    expect(step.detail).toContain('expo config changed: newArchEnabled false→true');
    expect(step.detail).toContain('rebuild needed');
    expect(step.action).toContain('validity browse --native');
  });

  it('first todo is surfaced as nextAction', async () => {
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project({ dependencies: { lodash: '4' } }), // not even native
      platform: 'ios',
      run: vi.fn(async () => ok()),
    });
    expect(r.nextAction?.id).toBe('native-project');
  });

  it('skips the internal-paths probe when the host packages are not installed (no node_modules)', async () => {
    // Every other test in this file builds package.json-only projects — the
    // preflight must not fail those (or freshly-cloned, not-yet-installed
    // projects): "install your deps" is owned elsewhere.
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: project(fullPkg),
      platform: 'ios',
      scheme: 'myapp',
      run: readyRunner(),
    });
    const step = r.steps.find((s) => s.id === 'internal-paths')!;
    expect(step.status).toBe('ok');
    expect(step.detail).toContain('not probed');
  });

  it('flags a moved package internal as a NAMED todo (renamed router-store after an expo-router bump)', async () => {
    const dir = project({
      ...fullPkg,
      dependencies: { ...fullPkg.dependencies, 'expo-router': '4' },
    });
    installFakePackages(dir, { expoRouter: true });
    // Simulate the version-coupling break: an expo-router release renamed the
    // store module the generated metro redirect matches.
    rmSync(join(dir, 'node_modules/expo-router/build/global-state/router-store.js'));
    file(dir, 'node_modules/expo-router/build/global-state/routing-store.js');
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: dir,
      platform: 'ios',
      scheme: 'myapp',
      run: readyRunner(),
    });
    const step = r.steps.find((s) => s.id === 'internal-paths')!;
    expect(step.status).toBe('todo');
    // The todo names the EXACT unresolved specifier + the installed version —
    // the whole point: this used to be a silent runtime degradation that
    // resurfaced as an unexplained null-navigationRef crash.
    expect(step.detail).toContain(`"${EXPO_ROUTER_STORE_SPECIFIER}"`);
    expect(step.detail).toContain('expo-router@4.0.0');
    expect(step.action).toContain('Update Validity');
    expect(r.ready).toBe(false);
  });

  it('passes (ok, all probed) when every version-coupled internal resolves', async () => {
    const dir = project({
      ...fullPkg,
      dependencies: { ...fullPkg.dependencies, 'expo-router': '4' },
    });
    installFakePackages(dir, { expoRouter: true });
    const r = await checkNativeReadiness({
      stateDir: ISOLATED_STATE_DIR,
      projectRoot: dir,
      platform: 'ios',
      scheme: 'myapp',
      run: readyRunner(),
    });
    const step = r.steps.find((s) => s.id === 'internal-paths')!;
    expect(step.status).toBe('ok');
    expect(step.detail).toContain('All 4');
    expect(r.ready).toBe(true);
  });
});

describe('listBootedDevices', () => {
  it('parses simctl -j output and returns only Booted devices with udid + name', async () => {
    const payload = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [
          { udid: 'UDID-PHONE', name: 'iPhone 15', state: 'Booted' },
          { udid: 'UDID-OFF', name: 'iPhone SE', state: 'Shutdown' },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
          { udid: 'UDID-PAD', name: 'iPad Pro', state: 'Booted' },
        ],
      },
    });
    const run = vi.fn(async (bin: string, args: string[]) => {
      expect(bin).toBe('xcrun');
      expect(args).toEqual(['simctl', 'list', 'devices', 'booted', '-j']);
      return ok(payload);
    });
    const devices = await listBootedDevices('ios', run);
    // osVersion comes from the simctl runtime KEY each device is listed under —
    // run-meta provenance, so a native screenshot records the OS that drew it.
    expect(devices).toEqual([
      { id: 'UDID-PHONE', name: 'iPhone 15', osVersion: 'iOS 17.5' },
      { id: 'UDID-PAD', name: 'iPad Pro', osVersion: 'iOS 18.0' },
    ]);
  });

  it('omits osVersion when the runtime key is unrecognized (never a wrong version)', async () => {
    const run = vi.fn(async () =>
      ok(
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SomethingNew': [
              { udid: 'UDID-X', name: 'iPhone 99', state: 'Booted' },
            ],
          },
        }),
      ),
    );
    expect(await listBootedDevices('ios', run)).toEqual([{ id: 'UDID-X', name: 'iPhone 99' }]);
  });

  it('parses `adb devices -l`, skipping the header and offline/unauthorized devices', async () => {
    const stdout = [
      'List of devices attached',
      'emulator-5554          device product:sdk_gphone64_arm64 model:Pixel_7 device:emu64a',
      'emulator-5556          offline',
      'R5CT123ABC             unauthorized',
      '',
    ].join('\n');
    const run = vi.fn(async (bin: string, args: string[]) => {
      expect(bin).toBe('adb');
      if (args[0] === 'devices') {
        expect(args).toEqual(['devices', '-l']);
        return ok(stdout);
      }
      // Second round-trip: the OS version, which `adb devices -l` omits.
      expect(args).toEqual(['-s', 'emulator-5554', 'shell', 'getprop', 'ro.build.version.release']);
      return ok('14\n');
    });
    const devices = await listBootedDevices('android', run);
    expect(devices).toEqual([{ id: 'emulator-5554', name: 'Pixel 7', osVersion: 'Android 14' }]);
    // Only the driveable device is probed — no getprop for offline/unauthorized.
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('falls back to the serial when adb reports no model', async () => {
    const run = vi.fn(async (_bin: string, args: string[]) =>
      args[0] === 'devices' ? ok('emulator-5554\tdevice\n') : ok('13'),
    );
    expect(await listBootedDevices('android', run)).toEqual([
      { id: 'emulator-5554', name: 'emulator-5554', osVersion: 'Android 13' },
    ]);
  });

  // Android runs used to ship with no osVersion at all, so their run-meta was
  // quietly weaker than iOS's. The probe is additive: it must never cost a
  // device its place in the list, and must never invent a version.
  it('omits osVersion when the getprop probe fails, without dropping the device', async () => {
    const devicesOut = ok('emulator-5554\tdevice\n');
    const bad = [
      fail(), // adb exited non-zero
      ok('error: device offline'), // adb printed an error into stdout
      ok(''), // property absent
      ok('REL'), // a preview build's non-numeric codename
    ];
    for (const probe of bad) {
      const run = vi.fn(async (_bin: string, args: string[]) =>
        args[0] === 'devices' ? devicesOut : probe,
      );
      expect(await listBootedDevices('android', run)).toEqual([
        { id: 'emulator-5554', name: 'emulator-5554' },
      ]);
    }
  });

  it('probes each booted device independently — one failure does not blank the others', async () => {
    const stdout = [
      'List of devices attached',
      'emulator-5554   device model:Pixel_7',
      'emulator-5556   device model:Pixel_9',
      '',
    ].join('\n');
    const run = vi.fn(async (_bin: string, args: string[]) => {
      if (args[0] === 'devices') return ok(stdout);
      return args[1] === 'emulator-5554' ? ok('14') : fail();
    });
    expect(await listBootedDevices('android', run)).toEqual([
      { id: 'emulator-5554', name: 'Pixel 7', osVersion: 'Android 14' },
      { id: 'emulator-5556', name: 'Pixel 9' },
    ]);
  });

  it('degrades to [] on spawn failure or unparseable output (callers fall back to unpinned)', async () => {
    expect(
      await listBootedDevices(
        'ios',
        vi.fn(async () => fail()),
      ),
    ).toEqual([]);
    expect(
      await listBootedDevices(
        'ios',
        vi.fn(async () => ok('not json')),
      ),
    ).toEqual([]);
    expect(
      await listBootedDevices(
        'ios',
        vi.fn(async () => {
          throw new Error('no xcrun');
        }),
      ),
    ).toEqual([]);
    expect(
      await listBootedDevices(
        'android',
        vi.fn(async () => fail()),
      ),
    ).toEqual([]);
  });
});

describe('findNewestApk', () => {
  /** Write an .apk (creating parents) and stamp its mtime to `mtimeSec` epoch seconds. */
  function apk(root: string, rel: string, mtimeSec: number): string {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'PK');
    utimesSync(abs, mtimeSec, mtimeSec);
    return abs;
  }

  it('defaults to the COMPANION app gradle output, not the host app', () => {
    const root = mkdtempSync(join(tmpdir(), 'validity-apk-'));
    dirs.push(root);
    // Host app's own APK — newer, but the WRONG binary (different bundle id).
    apk(root, 'android/app/build/outputs/apk/debug/app-debug.apk', 2000);
    // Companion APK — the one installCompanion actually needs.
    const companion = apk(
      root,
      '.validity/native-app/android/app/build/outputs/apk/debug/app-debug.apk',
      1000,
    );
    expect(defaultCompanionApkRoots(root)[0]).toContain(
      join('.validity', 'native-app', 'android', 'app', 'build', 'outputs', 'apk'),
    );
    expect(findNewestApk(root)?.path).toBe(companion);
  });

  it('returns the newest .apk by mtime when several exist under the companion output', () => {
    const root = mkdtempSync(join(tmpdir(), 'validity-apk-'));
    dirs.push(root);
    const base = '.validity/native-app/android/app/build/outputs/apk';
    apk(root, `${base}/debug/app-debug.apk`, 1000);
    const newest = apk(root, `${base}/release/app-release.apk`, 3000);
    apk(root, `${base}/staging/app-staging.apk`, 2000);
    const found = findNewestApk(root);
    expect(found?.path).toBe(newest);
    expect(found?.mtimeMs).toBe(3000 * 1000);
  });

  it('returns undefined when no APK exists (nothing built yet)', () => {
    const root = mkdtempSync(join(tmpdir(), 'validity-apk-'));
    dirs.push(root);
    expect(findNewestApk(root)).toBeUndefined();
  });

  it('honors explicit candidate roots over the default', () => {
    const root = mkdtempSync(join(tmpdir(), 'validity-apk-'));
    dirs.push(root);
    const custom = apk(root, 'custom/out/app.apk', 1234);
    // The default companion root is empty, so only the explicit candidate hits.
    expect(findNewestApk(root)).toBeUndefined();
    expect(findNewestApk(root, [join(root, 'custom')])?.path).toBe(custom);
  });
});

describe('checkPackageInternalPaths', () => {
  it('resolves all probes against an intact fake node_modules tree (with versions)', () => {
    const dir = project({});
    installFakePackages(dir, { expoRouter: true });
    const checks = checkPackageInternalPaths(dir, { expoRouter: true });
    expect(checks.map((c) => c.probe.specifier).sort()).toEqual(
      [
        EXPO_ROUTER_ROUTE_SPECIFIER,
        EXPO_ROUTER_STORE_SPECIFIER,
        RN_INITIALIZE_CORE_SPECIFIER,
        RN_LAZY_GLOBAL_CANARY_SPECIFIER,
      ].sort(),
    );
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(checks.find((c) => c.probe.pkg === 'react-native')?.installedVersion).toBe('0.81.0');
    expect(checks.find((c) => c.probe.pkg === 'expo-router')?.installedVersion).toBe('4.0.0');
  });

  it('reports a renamed router-store as missing while the sibling Route probe stays ok', () => {
    const dir = project({});
    installFakePackages(dir, { expoRouter: true });
    rmSync(join(dir, 'node_modules/expo-router/build/global-state/router-store.js'));
    const checks = checkPackageInternalPaths(dir, { expoRouter: true });
    const store = checks.find((c) => c.probe.specifier === EXPO_ROUTER_STORE_SPECIFIER)!;
    expect(store.status).toBe('missing');
    expect(store.installedVersion).toBe('4.0.0');
    const route = checks.find((c) => c.probe.specifier === EXPO_ROUTER_ROUTE_SPECIFIER)!;
    expect(route.status).toBe('ok');
  });

  it('resolves extensionless specifiers to <path>.js (the generated require() behavior)', () => {
    // RN_INITIALIZE_CORE_SPECIFIER has no extension; the installed file is
    // InitializeCore.js — the probe must accept that, like Metro/node do.
    const dir = project({});
    installFakePackages(dir);
    const core = checkPackageInternalPaths(dir, { expoRouter: false }).find(
      (c) => c.probe.specifier === RN_INITIALIZE_CORE_SPECIFIER,
    )!;
    expect(core.status).toBe('ok');
  });

  it('omits the expo-router probes for non-expo-router projects', () => {
    const dir = project({});
    installFakePackages(dir);
    const checks = checkPackageInternalPaths(dir, { expoRouter: false });
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.probe.pkg === 'react-native')).toBe(true);
  });

  it('reports package-absent (not missing) when the package is not installed at all', () => {
    const dir = project({});
    const checks = checkPackageInternalPaths(dir, { expoRouter: true });
    expect(checks.every((c) => c.status === 'package-absent')).toBe(true);
  });

  it('walks UP to a hoisted node_modules (monorepo workspace layout)', () => {
    const repoRoot = project({});
    installFakePackages(repoRoot);
    const appDir = join(repoRoot, 'apps', 'mobile');
    mkdirSync(appDir, { recursive: true });
    const checks = checkPackageInternalPaths(appDir, { expoRouter: false });
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
  });
});

/**
 * The environment steps exist for ONE failure mode: a setup that used to work
 * starts answering "no mechanical verdict produced for this criterion" and the
 * developer has no way to tell a phantom device claim from a dead daemon from a
 * hand-started Metro from a genuine render bug. They follow the version gate's
 * degradation rule exactly — anything unknown is `ok` with a dim note, because
 * sending someone to reset a WORKING environment is worse than the silence.
 */
describe('checkNativeReadiness — environment steps', () => {
  const daemonState = (json: string, entries: Record<string, string[]> = {}): DiagnosisFs => ({
    readFile: (p) => {
      if (p.endsWith('daemon.json')) return json;
      throw new Error(`ENOENT ${p}`);
    },
    readDir: (p) => {
      const key = Object.keys(entries).find((k) => p.endsWith(k));
      if (!key) throw new Error(`ENOENT ${p}`);
      return entries[key]!;
    },
    exists: () => true,
  });

  const base = (
    run: ReturnType<typeof readyRunner>,
  ): { projectRoot: string; platform: 'ios'; scheme: string; run: CommandRunner } => ({
    projectRoot: project(fullPkg),
    platform: 'ios',
    scheme: 'myapp',
    run,
  });

  it('flags a dead daemon that left session/claim state behind', async () => {
    const r = await checkNativeReadiness({
      ...base(readyRunner()),
      diagnosisFs: daemonState('{"pid":424242}', { 'device-claims': ['a.json'], sessions: ['s'] }),
      isPidAlive: () => false,
    });
    const step = r.steps.find((s) => s.id === 'agent-device-daemon')!;
    expect(step.status).toBe('todo');
    expect(step.detail).toContain('424242');
    expect(step.action).toContain('rm -rf');
    expect(r.ready).toBe(false);
  });

  it('reports a live daemon as ok, with its pid and version', async () => {
    const r = await checkNativeReadiness({
      ...base(readyRunner()),
      diagnosisFs: daemonState('{"pid":7,"version":"0.20.1"}', {
        'device-claims': [],
        sessions: [],
      }),
      isPidAlive: () => true,
    });
    const step = r.steps.find((s) => s.id === 'agent-device-daemon')!;
    expect(step.status).toBe('ok');
    expect(step.detail).toContain('pid 7');
    expect(step.detail).toContain('0.20.1');
  });

  it('DEGRADES to ok when the daemon state cannot be read at all', async () => {
    const exploding: DiagnosisFs = {
      readFile: () => {
        throw new Error('EACCES');
      },
      readDir: () => {
        throw new Error('EACCES');
      },
      exists: () => {
        throw new Error('EACCES');
      },
    };
    const r = await checkNativeReadiness({ ...base(readyRunner()), diagnosisFs: exploding });
    expect(r.steps.find((s) => s.id === 'agent-device-daemon')?.status).toBe('ok');
    expect(r.ready).toBe(true);
  });

  it('names a phantom device claim: claims held while no session is listed', async () => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args.join(' ') === 'session list')
        return ok('{"sessions": []}');
      if (bin === 'agent-device') return ok(MIN_AGENT_DEVICE_VERSION);
      if (bin === 'xcrun' && args.includes('list')) return ok('iPhone 15 (ABC) (Booted)');
      if (bin === 'xcrun' && args.includes('get_app_container')) return ok('/path/to/app');
      return ok();
    });
    const r = await checkNativeReadiness({
      ...base(run),
      diagnosisFs: daemonState('{"pid":7}', { 'device-claims': ['a.json'], sessions: [] }),
      isPidAlive: () => true,
    });
    const step = r.steps.find((s) => s.id === 'device-claim')!;
    expect(step.status).toBe('todo');
    expect(step.detail).toMatch(/already in use/i);
    expect(step.action).toContain('daemon.json');
  });

  it('leaves the claim step ok when agent-device lists live sessions', async () => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args.join(' ') === 'session list')
        return ok('{"sessions":[{"id":"cwd:abc:default"}]}');
      if (bin === 'agent-device') return ok(MIN_AGENT_DEVICE_VERSION);
      if (bin === 'xcrun' && args.includes('list')) return ok('iPhone 15 (ABC) (Booted)');
      if (bin === 'xcrun' && args.includes('get_app_container')) return ok('/path/to/app');
      return ok();
    });
    const r = await checkNativeReadiness({
      ...base(run),
      diagnosisFs: daemonState('{"pid":7}', { 'device-claims': ['a.json'], sessions: ['s'] }),
      isPidAlive: () => true,
    });
    expect(r.steps.find((s) => s.id === 'device-claim')?.status).toBe('ok');
    expect(r.ready).toBe(true);
  });

  /**
   * Auto-heal. The claim step used to fire after EVERY native verify: Validity
   * never closed its session, the daemon that held it exited later, and the
   * leftover file paired with an empty `session list` reads as a phantom. The
   * remedy it printed ended in `rm -rf …/device-claims`, so deleting the ONE
   * file whose owner is provably dead is strictly gentler than the instruction
   * it replaces — and unlike that instruction, it does not come back next run.
   */
  describe('stale-claim auto-heal', () => {
    const claimsRunner = (sessions: string): ReturnType<typeof vi.fn> =>
      vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
        if (bin === 'agent-device' && args.join(' ') === 'session list') return ok(sessions);
        if (bin === 'agent-device') return ok(MIN_AGENT_DEVICE_VERSION);
        if (bin === 'xcrun' && args.includes('list')) return ok('iPhone 15 (ABC) (Booted)');
        if (bin === 'xcrun' && args.includes('get_app_container')) return ok('/path/to/app');
        return ok();
      });

    /** A daemon-state fs that also SERVES claim files and records deletes. */
    const claimFs = (
      claims: Record<string, string>,
      removed: string[],
    ): DiagnosisFs & { removeFile: (p: string) => void } => ({
      readFile: (p) => {
        if (p.endsWith('daemon.json')) return '{"pid":7}';
        const name = Object.keys(claims).find((n) => p.endsWith(n));
        if (!name) throw new Error(`ENOENT ${p}`);
        return claims[name]!;
      },
      readDir: (p) => {
        if (p.endsWith('device-claims')) return Object.keys(claims);
        if (p.endsWith('sessions')) return [];
        throw new Error(`ENOENT ${p}`);
      },
      exists: (p) => !p.includes('/sessions/'),
      removeFile: (p) => removed.push(p),
    });

    const claimJson = (over: Record<string, unknown> = {}): string =>
      JSON.stringify({
        ownerPid: 424242,
        deviceKey: 'local:ios:iphoneos:ABC',
        device: { name: 'iPhone 15' },
        ...over,
      });

    it('releases a claim whose owner is dead, says so, and passes the step', async () => {
      const removed: string[] = [];
      const run = claimsRunner('{"sessions": []}');
      const r = await checkNativeReadiness({
        ...base(run as never),
        diagnosisFs: claimFs({ 'a.json': claimJson() }, removed),
        // The realistic shape: a LIVE daemon (pid 7) running on top of a claim
        // whose own daemon (424242) is long gone.
        isPidAlive: (pid) => pid !== 424242,
      });
      const step = r.steps.find((s) => s.id === 'device-claim')!;
      expect(removed).toHaveLength(1);
      expect(removed[0]).toContain('a.json');
      expect(step.status).toBe('ok');
      expect(step.detail).toContain('Released');
      expect(step.detail).toContain('424242');
      expect(step.detail).toContain('iPhone 15');
      expect(r.ready).toBe(true);
      // Nothing is left to be phantom about, so the list is not even asked for.
      expect(
        (run.mock.calls as [string, string[]][]).some((c) => c[1].join(' ') === 'session list'),
      ).toBe(false);
    });

    it('leaves a LIVE claim alone and produces no diagnosis on an empty session list', async () => {
      // The state every native run used to end in: the daemon that answered
      // `session list` is a NEW one, so the list is empty while the claim's
      // owner is alive. Nothing to fix, nothing to delete.
      const removed: string[] = [];
      const r = await checkNativeReadiness({
        ...base(claimsRunner('{"sessions": []}') as never),
        diagnosisFs: claimFs({ 'a.json': claimJson({ ownerPid: 7 }) }, removed),
        isPidAlive: () => true,
      });
      const step = r.steps.find((s) => s.id === 'device-claim')!;
      expect(removed).toEqual([]);
      expect(step.status).toBe('ok');
      expect(step.detail).not.toContain('Released');
      expect(r.ready).toBe(true);
    });

    it('diagnoses an UNREADABLE claim without deleting it', async () => {
      const removed: string[] = [];
      const r = await checkNativeReadiness({
        ...base(claimsRunner('{"sessions": []}') as never),
        diagnosisFs: claimFs({ 'a.json': '{not json' }, removed),
        isPidAlive: () => true,
      });
      const step = r.steps.find((s) => s.id === 'device-claim')!;
      expect(removed).toEqual([]);
      expect(step.status).toBe('todo');
      expect(step.action).toContain('daemon.json');
      expect(r.ready).toBe(false);
    });

    it('releases the dead one and still names what it could not classify', async () => {
      const removed: string[] = [];
      const r = await checkNativeReadiness({
        ...base(claimsRunner('{"sessions": []}') as never),
        diagnosisFs: claimFs({ 'a.json': claimJson(), 'b.json': '{not json' }, removed),
        isPidAlive: (pid) => pid !== 424242,
      });
      const step = r.steps.find((s) => s.id === 'device-claim')!;
      expect(removed.map((p) => p.split('/').pop())).toEqual(['a.json']);
      expect(step.status).toBe('todo');
      expect(step.detail).toContain('Released');
      expect(step.detail).toMatch(/already in use/i);
    });
  });

  it('flags a Metro on the companion port that Validity did not start', async () => {
    const run = vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device') return ok(MIN_AGENT_DEVICE_VERSION);
      if (bin === 'xcrun' && args.includes('list')) return ok('iPhone 15 (ABC) (Booted)');
      if (bin === 'xcrun' && args.includes('get_app_container')) return ok('/path/to/app');
      if (bin === 'lsof' && args[0] === '-ti') return ok('8181\n');
      if (bin === 'lsof') return ok('p8181\nn/Users/dev/my-app\n');
      if (bin === 'ps' && args.includes('pgid=')) return ok('8181\n');
      if (bin === 'ps') return ok('node /usr/local/bin/expo start --port 8082');
      return ok();
    });
    const r = await checkNativeReadiness({
      ...base(run),
      diagnosisFs: daemonState('{"pid":7}', { 'device-claims': [], sessions: [] }),
      isPidAlive: () => true,
    });
    const step = r.steps.find((s) => s.id === 'companion-metro-owner')!;
    expect(step.status).toBe('todo');
    expect(step.detail).toContain('8181');
    expect(step.detail).toContain('expo start --port 8082');
    expect(step.action).toContain('kill 8181');
  });

  it('omits the Metro step entirely when nothing holds the port (or lsof is unavailable)', async () => {
    const r = await checkNativeReadiness({
      ...base(readyRunner()),
      diagnosisFs: daemonState('{"pid":7}', { 'device-claims': [], sessions: [] }),
      isPidAlive: () => true,
    });
    expect(r.steps.find((s) => s.id === 'companion-metro-owner')).toBeUndefined();
    expect(r.ready).toBe(true);
  });

  it('runs no environment probes at all when they are skipped', async () => {
    const r = await checkNativeReadiness({
      ...base(readyRunner()),
      stateDir: ISOLATED_STATE_DIR,
      skipEnvironmentProbes: true,
    });
    expect(r.steps.some((s) => s.id === 'agent-device-daemon')).toBe(false);
    expect(r.ready).toBe(true);
  });
});
describe('checkNativeReadiness — agent-device capabilities row', () => {
  // stateDir is pinned at a path that does not exist so the daemon/claim probes
  // stay a function of these inputs rather than of whatever the developer's
  // machine has currently claimed.
  const caseBase = (
    run: CommandRunner,
  ): {
    stateDir: string;
    projectRoot: string;
    platform: 'ios';
    scheme: string;
    run: CommandRunner;
  } => ({
    stateDir: ISOLATED_STATE_DIR,
    projectRoot: project(fullPkg),
    platform: 'ios',
    scheme: 'myapp',
    run,
  });

  /** A ready environment whose `capabilities` answers with `commands`. */
  function runnerWithCaps(commands: string[] | null) {
    return vi.fn(async (bin: string, args: string[]): Promise<ExecResult> => {
      if (bin === 'agent-device' && args[0] === 'capabilities') {
        if (commands === null) return { code: 1, stdout: '', stderr: 'boom' };
        return ok(
          JSON.stringify({
            success: true,
            data: {
              device: { platform: 'ios', booted: true },
              availableCommands: commands,
            },
          }),
        );
      }
      if (bin === 'agent-device' && args.join(' ') === 'session list')
        return ok('{"sessions":[{"id":"cwd:abc:default"}]}');
      if (bin === 'agent-device') return ok(MIN_AGENT_DEVICE_VERSION);
      if (bin === 'xcrun' && args.includes('list')) return ok('iPhone 15 (ABC) (Booted)');
      if (bin === 'xcrun' && args.includes('get_app_container')) return ok('/path/to/app');
      return ok();
    });
  }

  // The verbs a 0.20.5 capture issues — `press` is the tap (see
  // DEFAULT_TAP_ARGS) and `diff` is rung 2 of the post-action ladder.
  const ALL = ['open', 'snapshot', 'screenshot', 'wait', 'press', 'fill', 'scroll', 'diff'];

  it('is ok when the device supports every verb a capture needs', async () => {
    const r = await checkNativeReadiness({
      ...caseBase(runnerWithCaps([...ALL, 'click', 'type'])),
    });
    const step = r.steps.find((s) => s.id === 'agent-device-capabilities')!;
    expect(step.status).toBe('ok');
    expect(step.detail).toContain('10 verbs supported');
  });

  it('names the MISSING verb and what it costs, rather than letting a run infer it', async () => {
    const r = await checkNativeReadiness({
      ...caseBase(runnerWithCaps(ALL.filter((v) => v !== 'scroll'))),
    });
    const step = r.steps.find((s) => s.id === 'agent-device-capabilities')!;
    expect(step.status).toBe('todo');
    expect(step.detail).toContain('scroll');
    expect(step.detail).toMatch(/unverifiable/);
  });

  it('an unreadable probe is "cannot tell" — never a blocked run', async () => {
    // The posture that matters: failing to ask the question must not be able to
    // turn a working environment into a not-ready one.
    const r = await checkNativeReadiness({ ...caseBase(runnerWithCaps(null)) });
    const step = r.steps.find((s) => s.id === 'agent-device-capabilities')!;
    expect(step.status).toBe('ok');
    expect(step.detail).toContain('Not reported');
    expect(r.ready).toBe(true);
  });
});
