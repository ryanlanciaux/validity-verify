/**
 * Detecting the expo-dev-launcher HOME screen — the state where the companion
 * process is up but no bundle is loaded, so deep links can never reach our JS.
 *
 * The two tiers are tested separately and then together, because their failure
 * modes are opposite: the activity probe is precise but frequently absent (iOS,
 * minimal drivers, a dead adb), and the a11y signature is always available but
 * matches on drifting English copy. The composed helper has to prefer the first
 * and survive the loss of either.
 */
import { describe, expect, it } from 'vitest';
import {
  activityIsDevLauncher,
  countDevLauncherAnchors,
  deviceOnDevLauncherHome,
  devServerRowRef,
  snapshotShowsDevLauncherHome,
} from './dev-launcher.js';
import { parseTopResumedActivity, snapshotShowsDevMenu } from './agent-device-driver.js';
import type { NativeDriver } from './agent-device-driver.js';

const okResult = { code: 0, stdout: '', stderr: '' };

/**
 * The launcher home as agent-device 0.20.1 rendered it on an API 35 emulator,
 * 2026-07-29 — captured verbatim from the failing run rather than written from
 * the Expo source, so the anchors are tested against what a device actually
 * emits (label casing, the collapsed-helper preamble, the URL rows).
 */
const LAUNCHER_HOME_SNAPSHOT = `Page: validity-ai-validity-playground://validity?component=app%2Fcomponents%2FButton.tsx
App: ai.validity.playground
Snapshot: 57 visible nodes (67 total)
@e19 [image] "App Icon"
@e20 [text] "Validity"
@e21 [text] "Development Build"
@e26 [scroll-area] [scrollable]
@e27 [text] "DEVELOPMENT SERVERS"
@e28 [text] "INFO"
@e30 [group] "http://10.0.2.2:8083"
@e35 [group] "http://10.0.2.2:8082"
@e40 [group] "New development server"
@e44 [text] "RECENTLY OPENED"
@e45 [text] "RESET"
@e47 [group] "Validity, http://192.168.68.65:8082"
@e59 [group] "Home" [disabled]`;

/** A rendered component — what a healthy warm re-target looks like. */
const RENDERED_SNAPSHOT = `Page: validity-ai-validity-playground://validity?component=app%2Fcomponents%2FButton.tsx
App: ai.validity.playground
@e18 [button] "Back to dashboard"
@e20 [group] "validity-root:nav-ms66jfx6-1"
@e23 [button] "Continue"`;

/** dumpsys output, trimmed to the line the parser reads. */
const DUMPSYS_LAUNCHER = `    mResumedActivity: null
    topResumedActivity=ActivityRecord{870b9f3 u0 ai.validity.playground/expo.modules.devlauncher.launcher.DevLauncherActivity t74}`;

const DUMPSYS_APP = `    topResumedActivity=ActivityRecord{e270d75 u0 ai.validity.playground/.MainActivity t73}`;

function fakeDriver(
  opts: {
    activity?: string | undefined;
    noActivityProbe?: boolean;
    activityThrows?: boolean;
    snapshot?: string;
    snapshotThrows?: boolean;
  } = {},
): { driver: NativeDriver; snapshots: () => number } {
  let snapshots = 0;
  const driver: NativeDriver = {
    platform: 'android',
    targetUrl: () => 'x://y',
    openTarget: async () => okResult,
    openUrl: async () => okResult,
    openControlLink: async () => okResult,
    dismissOverlay: async () => okResult,
    dismissDevMenu: async () => false,
    click: async () => okResult,
    inputText: async () => okResult,
    acceptAlert: async () => okResult,
    waitForRef: async () => okResult,
    screenshot: async () => okResult,
    async snapshot(): Promise<string> {
      snapshots += 1;
      if (opts.snapshotThrows) throw new Error('SESSION_NOT_FOUND');
      return opts.snapshot ?? '';
    },
    ...(opts.noActivityProbe
      ? {}
      : {
          async foregroundActivity(): Promise<string | undefined> {
            if (opts.activityThrows) throw new Error('adb: device offline');
            return opts.activity;
          },
        }),
  };
  return { driver, snapshots: () => snapshots };
}

describe('parseTopResumedActivity', () => {
  it('pulls the package/activity out of a dumpsys dump', () => {
    expect(parseTopResumedActivity(DUMPSYS_LAUNCHER)).toBe(
      'ai.validity.playground/expo.modules.devlauncher.launcher.DevLauncherActivity',
    );
    expect(parseTopResumedActivity(DUMPSYS_APP)).toBe('ai.validity.playground/.MainActivity');
  });

  it('accepts the older mResumedActivity spelling', () => {
    expect(
      parseTopResumedActivity(
        '  mResumedActivity=ActivityRecord{abc u0 com.example/.MainActivity}',
      ),
    ).toBe('com.example/.MainActivity');
  });

  it('answers undefined — not a guess — when the dump has no resumed activity', () => {
    // "no answer" and "nothing is foreground" must not collapse: the caller
    // falls back to screen content on undefined, and would wrongly conclude
    // "not the launcher" if this invented a value.
    expect(parseTopResumedActivity('mResumedActivity: null')).toBeUndefined();
    expect(parseTopResumedActivity('')).toBeUndefined();
  });
});

describe('activityIsDevLauncher', () => {
  it('matches expo-dev-launcher regardless of case', () => {
    expect(
      activityIsDevLauncher(
        'ai.validity.playground/expo.modules.devlauncher.launcher.DevLauncherActivity',
      ),
    ).toBe(true);
    expect(activityIsDevLauncher('com.example/expo.modules.DevLauncherActivity')).toBe(true);
  });

  it('does not match the app itself, and treats no-answer as no evidence', () => {
    expect(activityIsDevLauncher('ai.validity.playground/.MainActivity')).toBe(false);
    expect(activityIsDevLauncher(undefined)).toBe(false);
  });
});

describe('snapshotShowsDevLauncherHome', () => {
  it('fires on the real SDK-55 launcher home', () => {
    expect(snapshotShowsDevLauncherHome(LAUNCHER_HOME_SNAPSHOT)).toBe(true);
  });

  it('is the gap-filler it claims to be: the dev-MENU detector misses that screen', () => {
    // The reason this module exists rather than reusing snapshotShowsDevMenu.
    // If a future Expo release makes the menu anchors match the launcher home
    // too, this assertion flips and the duplication becomes removable — that is
    // exactly when someone should be told.
    expect(snapshotShowsDevMenu(LAUNCHER_HOME_SNAPSHOT)).toBe(false);
  });

  it('does not fire on a rendered component', () => {
    expect(snapshotShowsDevLauncherHome(RENDERED_SNAPSHOT)).toBe(false);
  });

  it('needs two distinct anchors, so one plausible product string is not enough', () => {
    // A false positive here reloads the bundle under a healthy warm render, so
    // the threshold is load-bearing, not decoration.
    const oneAnchor = '@e1 [text] "Development Build"';
    expect(countDevLauncherAnchors(oneAnchor)).toBe(1);
    expect(snapshotShowsDevLauncherHome(oneAnchor)).toBe(false);
  });

  it('counts each anchor once however many nodes carry it', () => {
    const repeated = ['@e1 [text] "RECENTLY OPENED"', '@e2 [text] "Recently opened"'].join('\n');
    expect(countDevLauncherAnchors(repeated)).toBe(1);
    expect(snapshotShowsDevLauncherHome(repeated)).toBe(false);
  });

  it('still matches the older expo-dev-launcher copy', () => {
    const legacy = [
      '@e1 [button] "Fetch development servers"',
      '@e2 [button] "Enter URL manually"',
    ].join('\n');
    expect(snapshotShowsDevLauncherHome(legacy)).toBe(true);
  });
});

describe('deviceOnDevLauncherHome', () => {
  it('trusts the activity probe and never snapshots when it answers', async () => {
    const { driver, snapshots } = fakeDriver({
      activity: 'ai.validity.playground/expo.modules.devlauncher.launcher.DevLauncherActivity',
      // Deliberately contradictory: if the snapshot were consulted it would say
      // "not the launcher" and the assertion below would fail.
      snapshot: RENDERED_SNAPSHOT,
    });
    expect(await deviceOnDevLauncherHome(driver)).toBe(true);
    expect(snapshots()).toBe(0);
  });

  it('is authoritative in the negative direction too', async () => {
    const { driver, snapshots } = fakeDriver({
      activity: 'ai.validity.playground/.MainActivity',
      snapshot: LAUNCHER_HOME_SNAPSHOT,
    });
    expect(await deviceOnDevLauncherHome(driver)).toBe(false);
    expect(snapshots()).toBe(0);
  });

  it('falls back to screen content when the driver has no activity probe (iOS)', async () => {
    const { driver, snapshots } = fakeDriver({
      noActivityProbe: true,
      snapshot: LAUNCHER_HOME_SNAPSHOT,
    });
    expect(await deviceOnDevLauncherHome(driver)).toBe(true);
    expect(snapshots()).toBe(1);
  });

  it('falls back to screen content when the probe answers undefined', async () => {
    const { driver } = fakeDriver({ activity: undefined, snapshot: LAUNCHER_HOME_SNAPSHOT });
    expect(await deviceOnDevLauncherHome(driver)).toBe(true);
  });

  it('falls back to screen content when the probe throws', async () => {
    const { driver } = fakeDriver({ activityThrows: true, snapshot: LAUNCHER_HOME_SNAPSHOT });
    expect(await deviceOnDevLauncherHome(driver)).toBe(true);
  });

  it('answers false — not true — when neither rung can report', async () => {
    // Silence must never be read as "the launcher is up": that would send a
    // working warm session down a cold bundle reload on every transport hiccup.
    const { driver } = fakeDriver({ activityThrows: true, snapshotThrows: true });
    expect(await deviceOnDevLauncherHome(driver)).toBe(false);
  });
});

describe('devServerRowRef', () => {
  it('finds OUR server row in the verbatim launcher snapshot', () => {
    // @e30 is the BRIDGE port (8083) and @e47 is a LAN machine that also
    // serves 8082 — both must lose to the emulator-loopback companion row.
    expect(devServerRowRef(LAUNCHER_HOME_SNAPSHOT, 'http://localhost:8082')).toBe('@e35');
  });

  it('matches localhost-form rows too (adb reverse keeps localhost semantics)', () => {
    const snap = '@e12 [group] "http://localhost:8082"';
    expect(devServerRowRef(snap, 'http://localhost:8082')).toBe('@e12');
  });

  it('never taps a foreign machine or the wrong port', () => {
    const foreign = [
      '@e5 [group] "http://192.168.1.44:8082"',
      '@e6 [group] "http://10.0.2.2:8083"',
    ].join('\n');
    expect(devServerRowRef(foreign, 'http://localhost:8082')).toBeUndefined();
  });

  it('answers nothing when the metro URL carries no port', () => {
    expect(devServerRowRef(LAUNCHER_HOME_SNAPSHOT, 'http://localhost')).toBeUndefined();
  });
});
