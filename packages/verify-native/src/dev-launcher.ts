/**
 * Is the companion parked on the expo-dev-launcher HOME screen (the "pick a
 * development server" list) instead of running our bundle?
 *
 * This is a distinct state from the Expo dev MENU that
 * {@link snapshotShowsDevMenu} detects, and it needs a different remedy. The
 * menu is a modal sheet ON TOP of a running bundle — closing it reveals the
 * render underneath. The launcher HOME means no bundle is loaded at all: the
 * dev-client process is up, but its React root is expo-dev-launcher's own UI,
 * so a `validity://` deep link cannot reach our JS no matter how many times it
 * is delivered. The only way out is the dev-client CONTROL link
 * (`<scheme>://expo-development-client/?url=<metro>`), which tells the launcher
 * which bundle to load.
 *
 * Measured on an API 35 emulator, 2026-07-29 (the failure this module exists
 * for): `validity verify` on an attached Android device force-stopped the
 * companion, the deep link cold-started `MainActivity`, and expo-dev-launcher
 * immediately redirected to its own activity:
 *
 *     I/ActivityTaskManager: START u0 {act=android.intent.action.VIEW
 *       dat=validity-ai-validity-playground://validity/… cmp=…/.MainActivity}
 *       … from uid 2000
 *     I/ActivityTaskManager: START u0 {cmp=ai.validity.playground/
 *       expo.modules.devlauncher.launcher.DevLauncherActivity}
 *       … from uid 10209   ← the app redirecting itself
 *
 * Every rung of the open ladder then timed out against that screen and the
 * spec reported `unconfirmed`, which is honest but useless.
 *
 * Detection is deliberately two-tier, strongest first:
 *
 *   1. The Android FOREGROUND ACTIVITY. `expo.modules.devlauncher.launcher.
 *      DevLauncherActivity` is a package/class name, not user-facing copy, so
 *      it cannot drift with an Expo release the way label text does — and it is
 *      unambiguous in a way a11y anchors are not.
 *   2. The a11y COPY signature, for platforms/drivers with no activity probe
 *      (iOS renders the launcher inside the same process, so there is no
 *      activity to read).
 *
 * The a11y tier is a real gap-filler, not a duplicate: the SDK-55 launcher home
 * matches NONE of {@link DEV_MENU_ANCHOR_LABELS}. The two launcher anchors on
 * that list ('fetch development servers', 'enter url manually') are older copy
 * that the observed SDK-55 screen no longer renders — it shows
 * 'DEVELOPMENT SERVERS', 'RECENTLY OPENED' and 'New development server'
 * instead. So the pre-existing detector answers false on the exact screen that
 * blocks every capture.
 */
import type { NativeDriver } from './agent-device-driver.js';

/**
 * The activity class expo-dev-launcher presents its home screen from. Matched
 * as a case-insensitive substring of `<package>/<activity>` so a package
 * rename (`expo.modules.devlauncher.*`) or an activity rename alone still
 * matches — both carry the `devlauncher` token.
 */
export const DEV_LAUNCHER_ACTIVITY_TOKEN = 'devlauncher';

/**
 * a11y-copy anchors for the dev-launcher HOME screen, as rendered by
 * expo-dev-launcher@55.0.36 (observed) plus the older copy that
 * {@link DEV_MENU_SPECIFIC_ANCHORS} was written against. Lowercase; matched as
 * substrings of a node's quoted label.
 *
 * None of these is conclusive alone — 'development build' could plausibly
 * appear in a product's own about screen — so detection needs
 * {@link DEV_LAUNCHER_ANCHOR_THRESHOLD} DISTINCT anchors. That is the same
 * anti-false-positive posture the dev-menu detector takes, and it matters more
 * here: a false positive sends the open down the cold control-link rung, which
 * reloads the bundle under a perfectly good warm render.
 */
export const DEV_LAUNCHER_HOME_ANCHORS = [
  'development servers',
  'recently opened',
  'new development server',
  'fetch development servers',
  'enter url manually',
  'development build',
];

/** Distinct {@link DEV_LAUNCHER_HOME_ANCHORS} needed to call it the launcher home. */
export const DEV_LAUNCHER_ANCHOR_THRESHOLD = 2;

/**
 * True when `activity` names expo-dev-launcher's own activity. PURE —
 * unit-tested without a device. `undefined` (no probe, or the probe failed) is
 * NOT evidence either way and answers false.
 */
export function activityIsDevLauncher(activity: string | undefined): boolean {
  return (
    typeof activity === 'string' && activity.toLowerCase().includes(DEV_LAUNCHER_ACTIVITY_TOKEN)
  );
}

/**
 * How many DISTINCT {@link DEV_LAUNCHER_HOME_ANCHORS} the snapshot's quoted
 * node labels match. PURE — unit-tested without a device.
 */
export function countDevLauncherAnchors(
  snapshot: string,
  anchors: string[] = DEV_LAUNCHER_HOME_ANCHORS,
): number {
  const wanted = anchors.map((a) => a.toLowerCase());
  const present = new Set<string>();
  for (const line of snapshot.split('\n')) {
    // Escape-aware, matching findDismissRef: a label carrying an embedded `\"`
    // must not be truncated at the inner quote.
    const labelMatch = line.match(/"((?:[^"\\]|\\.)*)"/);
    const label = (labelMatch?.[1] ?? '').replace(/\\(.)/g, '$1').toLowerCase();
    if (!label) continue;
    for (const a of wanted) {
      if (label.includes(a)) present.add(a);
    }
  }
  return present.size;
}

/**
 * Positive dev-launcher-HOME presence check over an agent-device a11y snapshot.
 * PURE — unit-tested without a device.
 */
export function snapshotShowsDevLauncherHome(
  snapshot: string,
  anchors: string[] = DEV_LAUNCHER_HOME_ANCHORS,
): boolean {
  return countDevLauncherAnchors(snapshot, anchors) >= DEV_LAUNCHER_ANCHOR_THRESHOLD;
}

/**
 * Ask the DEVICE whether it is sitting on the dev-launcher home.
 *
 * Activity first (conclusive when the driver can answer), a11y copy second.
 * Both rungs are best-effort: a driver/transport error means "no evidence of
 * the launcher", never a claim that it IS there — a false positive here costs
 * a needless bundle reload under a working render, so silence must degrade to
 * "not the launcher".
 *
 * Bounded by construction: one activity probe plus at most one snapshot, no
 * retries, no waiting. Callers run it only on a path that is already about to
 * give up, so the cost is paid on failures and never on the happy path.
 */
export async function deviceOnDevLauncherHome(driver: NativeDriver): Promise<boolean> {
  try {
    const activity = await driver.foregroundActivity?.();
    // A probe that ANSWERED is authoritative in both directions: if the
    // foreground activity is our MainActivity, the launcher is not up, and
    // paying for a snapshot to second-guess a package/class name with drifting
    // English copy would only add false positives.
    if (activity !== undefined) return activityIsDevLauncher(activity);
  } catch {
    /* fall through to the copy signature */
  }
  try {
    return snapshotShowsDevLauncherHome(await driver.snapshot());
  } catch {
    return false;
  }
}

/**
 * Hosts under which the launcher can list OUR companion Metro. `10.0.2.2` is
 * the Android emulator's alias for the host's loopback; Validity itself keeps
 * localhost semantics via `adb reverse`, but the launcher's list renders
 * whichever form the dev client discovered the server under, and both have
 * been observed for the same bundler.
 */
const DEV_SERVER_ROW_HOSTS = ['localhost', '127.0.0.1', '10.0.2.2'];

/**
 * Find the launcher row for OUR Metro server in an a11y snapshot — the
 * `@eNN` ref of the node whose label names the companion port on a loopback
 * host.
 *
 * This is the tap a human performed on 2026-07-30 to un-wedge an Android
 * verify after an emulator reboot: the deep link was swallowed by the
 * launcher (upstream task #24), `validity browse --native` re-delivered the
 * control link, and one tap on the `10.0.2.2:8082` row loaded the bundle.
 *
 * STRICT on purpose: the row must carry `<loopback-host>:<our port>`. The
 * launcher list can contain other machines' servers (LAN discovery), and
 * tapping a stranger's row would load a stranger's bundle — worse than
 * giving up. PURE — unit-tested without a device.
 */
export function devServerRowRef(snapshot: string, metroUrl: string): string | undefined {
  const port = metroUrl.match(/:(\d+)/)?.[1];
  if (!port) return undefined;
  const needles = DEV_SERVER_ROW_HOSTS.map((h) => `${h}:${port}`);
  for (const line of snapshot.split('\n')) {
    const ref = line.match(/@e\d+/)?.[0];
    if (!ref) continue;
    const labelMatch = line.match(/"((?:[^"\\]|\\.)*)"/);
    const label = (labelMatch?.[1] ?? '').replace(/\\(.)/g, '$1').toLowerCase();
    if (needles.some((n) => label.includes(n))) return ref;
  }
  return undefined;
}
