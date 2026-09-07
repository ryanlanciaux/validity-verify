// @validity-generated-template — React Native playground root.
//
// Shipped RAW (never compiled by @validity.ai/verify-native's tsc — it imports
// react-native). prepareNative() copies it into node_modules/.validity-native/
// and the generated native-entry registers it as the app root.
//
// Responsibilities:
//   1. Read the target (component/fixture/scenario/overrides) from the initial
//      deep link (Linking.getInitialURL) and from live deep links (Linking
//      'url' events) — the SAME ?component= contract as web. (Cold-launch +
//      backward-compatible fallback path.)
//   2. Connect to the Validity control bridge (a WebSocket the host owns) for
//      live, IN-PLACE re-targeting + prop overrides without relaunching — the
//      native analog of the web browse bridge. This is the PRIMARY navigation
//      path: "show me Button" then "show me Dropdown" swaps the active view in
//      place (no reload → the splash is never re-presented). Each `navigate`
//      carries a TOKEN, and once the new target paints we post
//      `{type:'rendered', token, ok}` back so the host knows the NEW target —
//      not a stale previous render — is on screen. Our `hello` announces the
//      contentHash this bundle was generated from (validity-content-hash, baked
//      at prepare time) plus a stable device identity and our protocol caps,
//      so the host can detect a STALE bundle after a content Metro restart and
//      correlate this socket with the device it is screenshotting. On a stale
//      bundle the host pushes `{type:'reload'}` and we DevSettings.reload() in
//      place (the companion ships no expo-splash-screen, so a reload can no
//      longer strand behind a re-presented launch screen) — the fresh session
//      reconnects and the host navigates it. The host replays its last drive
//      command tagged `replay: true` on every (re)connect; we apply a replay
//      ONLY while this JS session has not navigated yet (a reload reset us to
//      home — self-heal back), and ignore it otherwise so a replay racing an
//      in-flight newer navigate (or an on-device/deep-link navigation) can
//      never yank the screen back to an older target.
//   3. Look the component/view up in the generated static registry and mount it
//      inside the MockProviderShell (mocked navigation), passing fixture /
//      override props — all within the device's safe area.
/* eslint-disable */
// @ts-nocheck
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  Linking,
  Platform,
  StyleSheet,
  DevSettings,
  Appearance,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ComponentType } from 'react';
import { MockProviderShell } from './mock-provider-shell';
// Generated per-project: dismisses the native launch screen when the host ships
// expo-splash-screen, a no-op otherwise. The companion never runs the host
// startup that would auto-hide the splash, so the root owns that lifecycle —
// otherwise the launch storyboard stays painted over every rendered target and
// the capture flow screenshots the splash instead of the content.
import { hideSplash } from './validity-native-splash';
// Generated AFTER the content hash is computed (and excluded from it): the
// exact contentHash of the generated source this bundle was built from. Sent
// in the bridge `hello` so the host can prove the running bundle is stale.
import { VALIDITY_CONTENT_HASH } from './validity-content-hash';
// Generated per-project: stable device identity (expo-application vendor /
// android id when the host ships it, else a persisted installation id, else a
// per-session id). Sent in the bridge `hello` for device↔socket correlation.
import { getDeviceIdentity } from './validity-native-identity';
// Re-apply a fresher mock-network DATA payload (boot fetch / inline navigate)
// without a rebuild. The STATIC mock runtime starts from the baked data; this
// overlays the host's fresher handlers — see the network-native module header.
// setBridgePassthrough exempts the bridge's loopback origin from msw so the
// boot fetch below isn't swallowed by the permissive catch-all.
// getMockStatus reports whether msw is actually intercepting (vs degraded to
// "no mocking") so the host's hello — and a native verify's response — can warn
// the agent before it scores real-network data against fixture criteria.
// getUnmatchedUrls/resetUnmatched expose the un-mocked URLs the permissive
// catch-all answered: reset at the start of each navigation, then snapshotted
// into the 'rendered' ack so a native verify lists them like web does.
// getMatchedRequests/resetMatched expose the network responses the screen
// OBSERVED ({method,url,status}); same lifecycle — reset per navigation,
// snapshotted into the ack so the host can evaluate expect.network on device.
import {
  applyMockNetwork,
  setBridgePassthrough,
  getMockStatus,
  getUnmatchedUrls,
  resetUnmatched,
  getMatchedRequests,
  resetMatched,
} from './validity-native-mocks';

export interface NativeTarget {
  component?: string;
  view?: string;
  /**
   * Per-navigation token from the host (bridge `navigate` message or deep-link
   * `token=` param). Echoed as the render-marker testID
   * (`validity-root:<token>`) so the host's deep-link fallback can wait for
   * THIS navigation specifically — a stale previous render carries the
   * previous token (or none) and can no longer satisfy the wait. Absent
   * (legacy deep link, on-device navigation) → the shared `validity-root`
   * marker is rendered instead, keeping old hosts working.
   */
  token?: string;
  /**
   * Resolved view items shipped INLINE with the target (over the bridge or the
   * deep-link `items=` param). When present they're rendered directly, so a
   * newly-created/edited view shows without it being baked into the bundle.
   * Absent → fall back to the bundled `views[view]` map.
   */
  viewItems?: ViewItem[];
  fixture?: string;
  scenario?: string;
  /**
   * Scenario context seed in wire format shipped INLINE with the navigation
   * (bridge `navigate.scenarioSeed`). When present it wins over the baked
   * `scenarios[scenario]` map, so a scenario edit overlays the auto-mocked
   * context proxy with no rebuild. Absent → look `scenario` up in the baked map.
   */
  scenarioSeed?: ScenarioSeedWire;
  overrides?: Record<string, unknown>;
  /**
   * Color scheme (theme) to force for this target via Appearance.setColorScheme
   * (and pass to the wrapper). Set by the verify run's color-scheme axis; absent
   * → the device/system default theme.
   */
  colorScheme?: 'light' | 'dark';
}

interface ViewItem {
  path: string;
  label: string;
  props: Record<string, unknown>;
}

/**
 * Scenario context seed in WIRE format — `context` is the JSON-safe seed,
 * `undefinedKeys` lists keys whose value is a literal `undefined` (JSON drops
 * them, so they travel by name and are re-materialized below). Decoded by
 * {@link materializeScenarioSeed} into the flat object the context proxy reads.
 */
interface ScenarioSeedWire {
  context?: Record<string, unknown>;
  undefinedKeys?: string[];
}

/**
 * Re-materialize a wire-format scenario seed into the flat overlay the
 * auto-mocked context proxy reads: spread `context`, then re-add every
 * `undefinedKeys` entry as an OWN property with value `undefined` (the proxy's
 * seed lookup uses hasOwnProperty, so a cleared key like `authToken` must exist
 * as an own-property to override the heuristic default). Null for an empty seed.
 */
function materializeScenarioSeed(wire?: ScenarioSeedWire | null): Record<string, unknown> | null {
  if (!wire || typeof wire !== 'object') return null;
  const out: Record<string, unknown> = { ...(wire.context || {}) };
  for (const k of wire.undefinedKeys || []) out[k] = undefined;
  return out;
}

/**
 * The DATA payload the bridge serves at GET /data (boot fetch) — the freshest
 * views/scenarios/mock/asyncStorage when a host is driving, degrading to the
 * baked props when the fetch is unreachable (offline / genuinely cold).
 */
interface NativeData {
  views?: Record<string, ViewItem[]>;
  scenarios?: Record<string, ScenarioSeedWire>;
  mockNetwork?: unknown;
  asyncStorage?: Array<[string, string]>;
}

interface Props {
  registry: Record<string, ComponentType<any>>;
  /**
   * Baked views map — the OFFLINE FALLBACK. The home listing + cold view lookup
   * prefer the host's fresher boot-fetched copy (GET /data) when reachable; this
   * is what shows when no host is driving. Per-navigation the bridge ships the
   * resolved items inline (`navigate.items`), which wins over both.
   */
  views?: Record<string, ViewItem[]>;
  /**
   * Baked scenario → wire-seed map (built-in logged-in/logged-out + config) —
   * the OFFLINE FALLBACK. When a target carries a `scenario` (and no inline
   * `scenarioSeed`), the matching seed is materialized and published on
   * globalThis so the auto-mocked context proxy overlays it — e.g.
   * useAuth().isAuthenticated reflects 'logged-in' vs 'logged-out'. The host's
   * boot-fetched copy refreshes this so a scenario edit applies after a reload.
   */
  scenarios?: Record<string, ScenarioSeedWire>;
  /** Baked AsyncStorage seed pairs (offline fallback; boot fetch refreshes). */
  asyncStorageSeed?: Array<[string, string]>;
  /** Seeds AsyncStorage with the given pairs before the first mount. */
  seedAsyncStorage?: (seed: Array<[string, string]>) => Promise<void>;
  /**
   * Registers the host's custom fonts (the native analog of web's @font-face)
   * before the first mount, so isolated components render with the design
   * system's typography instead of the system fallback.
   */
  loadFonts?: () => Promise<void>;
  bridgeUrl?: string;
  router?: 'expo-router' | 'react-navigation' | 'none';
}

/** Max wait for fonts before rendering anyway — a bad asset path can't hang the playground. */
const FONT_LOAD_TIMEOUT_MS = 4000;

/** Decode a base64-encoded JSON param (overrides / view items). */
function decodeBase64Json<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    // global.atob is provided by react-native-url-polyfill / the JS runtime.
    const json =
      typeof atob === 'function' ? atob(raw) : Buffer.from(raw, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/** Parse `<scheme>://validity?component=…` or `exp://host/--/validity?component=…`. */
export function parseTargetFromUrl(url: string | null): NativeTarget {
  if (!url) return {};
  const q = url.indexOf('?');
  if (q === -1) return {};
  const params = new URLSearchParams(url.slice(q + 1));
  const component = params.get('component') ?? undefined;
  const view = params.get('view') ?? undefined;
  if (!component && !view) return {};
  const items = decodeBase64Json<ViewItem[]>(params.get('items'));
  return {
    component,
    view,
    viewItems: Array.isArray(items) ? items : undefined,
    fixture: params.get('fixture') ?? undefined,
    scenario: params.get('scenario') ?? undefined,
    overrides: decodeBase64Json<Record<string, unknown>>(params.get('overrides')),
    colorScheme: themeParam(params.get('theme')),
    token: params.get('token') ?? undefined,
  };
}

/** Narrow a raw `?theme=` param to the supported color schemes (else undefined). */
function themeParam(raw: string | null): 'light' | 'dark' | undefined {
  return raw === 'light' || raw === 'dark' ? raw : undefined;
}

/**
 * Render-marker testID for the active target (contract with the host's
 * deep-link fallback — see DEFAULT_RENDER_MARKER in capture-native.ts). With a
 * host-minted token the marker is per-navigation (`validity-root:<token>`);
 * without one (legacy host, on-device navigation) it degrades to the shared
 * `validity-root` marker.
 */
function renderMarkerId(token?: string): string {
  return token ? `validity-root:${token}` : 'validity-root';
}

/**
 * Clear the un-mocked-URL tracker at the START of a navigation so each capture
 * only reports the URLs THAT target hit (not a cumulative pile from earlier
 * targets in the warm session). Guarded so an older mocks module without the
 * export degrades to "no reset", never a crashed navigation.
 */
function resetUnmatchedSafe(): void {
  try {
    if (typeof resetUnmatched === 'function') resetUnmatched();
  } catch {
    /* old mocks module — ignore */
  }
}

/** Snapshot the un-mocked URLs for the 'rendered' ack (guarded like above). */
function getUnmatchedSafe(): string[] {
  try {
    return typeof getUnmatchedUrls === 'function' ? getUnmatchedUrls() : [];
  } catch {
    return [];
  }
}

/** Clear the observed-network tracker at the START of a navigation (guarded). */
function resetMatchedSafe(): void {
  try {
    if (typeof resetMatched === 'function') resetMatched();
  } catch {
    /* old mocks module — ignore */
  }
}

/**
 * Snapshot the observed network responses for the 'rendered' ack. Guarded +
 * shape-validated so an older mocks module (no getMatchedRequests export) or a
 * malformed entry degrades to "no observations" — the host then reads the
 * network channel as unavailable (expect.network → unverifiable), never a crash.
 */
function getMatchedSafe(): Array<{ method: string; url: string; status: number }> {
  try {
    const raw = typeof getMatchedRequests === 'function' ? getMatchedRequests() : [];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && typeof r.method === 'string' && typeof r.url === 'string')
      .map((r) => ({ method: r.method, url: r.url, status: Number(r.status) || 0 }));
  } catch {
    return [];
  }
}

// ---- console.error observation channel ------------------------------------
// Count console.error calls during the capture window so expect.console
// (error-budget) criteria can be evaluated on device — the native analog of the
// web executor's page.on('console') error counter. The counter is reset at the
// START of each navigation (next to resetUnmatched/resetMatched) and snapshotted
// into the 'rendered' ack. ADDITIVE + defensive: patched ONCE behind a guard,
// the original console.error behaviour is preserved, and the whole patch is
// wrapped in try/catch so it can never break a render.
let __validityConsoleErrorCount = 0;
let __validityConsoleErrorPatched = false;

/** Patch console.error to increment the counter (once; original behaviour kept). */
function patchConsoleErrorOnce(): void {
  try {
    if (__validityConsoleErrorPatched) return;
    if (typeof console === 'undefined' || typeof console.error !== 'function') return;
    const original = console.error.bind(console);
    console.error = function validityCountingError(...args: unknown[]) {
      __validityConsoleErrorCount += 1;
      return original(...args);
    };
    __validityConsoleErrorPatched = true;
  } catch {
    /* leave console.error untouched — the console channel just stays at 0 */
  }
}

/** Reset the console-error counter at the START of a navigation. */
function resetConsoleErrorsSafe(): void {
  __validityConsoleErrorCount = 0;
}

/** Current console-error count for the 'rendered' ack. */
function getConsoleErrorCount(): number {
  return __validityConsoleErrorCount;
}

// ---- render-performance observation channel -------------------------------
// Measure the rendered target's timing ON DEVICE so expect.performance (ready /
// mount / update budgets) can be evaluated natively — the analog of the web
// executor's Navigation/Paint Timing reads. The numbers ride the EXISTING
// 'rendered' ack (same WebSocket the console/network channels use); the
// agent-device driver is not involved. Sources:
//   - readyMs : navStart (stamped when a HOST navigation is accepted) → the
//               two-frame paint-confirm that builds the ack (monotonic clock).
//   - mountMs : React.Profiler 'mount' actualDuration for <validity-target>.
//   - updateMs: worst React.Profiler 'update' actualDuration (re-render + play).
//   - commitCount: total Profiler commits (mount + every update) — observational.
// Reset at the START of each navigation (inside resetNavObservations) so each
// capture reports only THAT target. A NEW companion ALWAYS emits a perf object
// in the ack; an OLD companion emits no perf field at all (host degrades that to
// unverifiable). ADDITIVE + defensive — perf measurement can never break a
// render or an ack.

/** Monotonic clock: performance.now() when available, else Date.now() (ms). */
const perfNow = () =>
  typeof global !== 'undefined' && global.performance && global.performance.now
    ? global.performance.now()
    : Date.now();

// mount actualDuration (ms), worst update actualDuration (ms), total commits,
// and the navStart timestamp for the host navigation we still owe an ack for.
let __perfMount: number | undefined;
let __perfWorstUpdate: number | undefined;
let __perfCommits = 0;
let __perfNavStart: number | null = null;

/** Reset the perf collectors at the START of a navigation. */
function resetPerf(): void {
  __perfMount = undefined;
  __perfWorstUpdate = undefined;
  __perfCommits = 0;
  // navStart is stamped by the navigation handler itself (host nav only), so it
  // is NOT cleared here — clearing it would erase the stamp the bridge handler
  // just set immediately before calling resetNavObservations.
}

/** Stamp navStart for the host navigation about to be applied (paint timing origin). */
function stampPerfNavStart(): void {
  try {
    __perfNavStart = perfNow();
  } catch {
    __perfNavStart = null;
  }
}

/**
 * React.Profiler onRender — increment the commit count and record the mount
 * duration (phase 'mount', fires once per target since the screen remounts) vs
 * the worst update duration (phase 'update', across the render + any play).
 * Fully guarded so a profiler quirk can never break the render tree.
 */
function onProfileRender(_id: unknown, phase: unknown, actualDuration: unknown): void {
  try {
    __perfCommits += 1;
    const ms = typeof actualDuration === 'number' ? Math.round(actualDuration) : undefined;
    if (ms == null) return;
    if (phase === 'mount') {
      __perfMount = ms;
    } else if (phase === 'update') {
      __perfWorstUpdate = __perfWorstUpdate == null ? ms : Math.max(__perfWorstUpdate, ms);
    }
  } catch {
    /* ignore — perf measurement must never break a render */
  }
}

/**
 * Snapshot the per-render perf object for the 'rendered' ack. readyMs is the
 * navStart→paint-confirm delta (undefined when no host navStart was stamped, e.g.
 * a local/deep-link nav owes no ack). updateMs is omitted (undefined) when no
 * update commit fired — JSON.stringify drops undefined sub-fields, matching the
 * web executor's "<metric> not measured on this render" parity. A NEW companion
 * ALWAYS sends this object; the host reads its ABSENCE as the old-companion case.
 */
function getPerfSnapshot(): {
  readyMs?: number;
  mountMs?: number;
  updateMs?: number;
  commitCount?: number;
} {
  let readyMs: number | undefined;
  try {
    readyMs = __perfNavStart != null ? Math.round(perfNow() - __perfNavStart) : undefined;
  } catch {
    readyMs = undefined;
  }
  return {
    readyMs,
    mountMs: __perfMount,
    updateMs: __perfWorstUpdate,
    commitCount: __perfCommits,
  };
}

/**
 * Reset ALL per-navigation observation channels at once (un-mocked URLs,
 * observed network responses, console-error count, render-perf collectors) —
 * called wherever a new navigation begins so each capture's ack reports only
 * what THAT target did.
 */
function resetNavObservations(): void {
  resetUnmatchedSafe();
  resetMatchedSafe();
  resetConsoleErrorsSafe();
  resetPerf();
}

// ---- Expo dev-menu suppression -------------------------------------------
//
// WHY THIS EXISTS — from expo-dev-menu's own source, not from reasoning about
// it. `DevMenuFragment.onCreate` (android/src/debug/.../DevMenuFragment.kt):
//
//     val shouldShowAtLaunch =
//       preferences.showsAtLaunch || !preferences.isOnboardingFinished
//     if (shouldShowAtLaunch) showMenuAtLaunch()
//
// and `isOnboardingFinished` defaults to FALSE (DevMenuPreferences.kt), flipping
// to true ONLY when a human taps through the onboarding sheet. The Validity
// companion is installed by the installer and never hand-driven, so that
// preference stays false forever and the dev menu AUTO-OPENS on every React
// context init — i.e. every launch AND every reload, because showMenuAtLaunch
// re-opens it from a ReactInstanceEventListener.
//
// That also explains the observed "dismissing it via its Reload row just brings
// the menu back": Reload builds a new React context, which re-fires the
// listener. Reload was never a dismissal — on either platform.
//
// The menu is a MODAL bottom sheet, so it takes the accessibility tree with it.
// While it is up the host cannot see the per-navigation render marker
// (`validity-root:<token>`) underneath, the paint cross-check misses, and a
// perfectly good render is demoted to `unconfirmed` — which is exactly the
// "every Android criterion unverifiable" symptom.
//
// THE DISMISSAL: expo-dev-menu's own JS-facing native module, verified present
// under the SAME module name on BOTH platforms in 55.0.30:
//   android .../modules/DevMenuModule.kt   AsyncFunction("closeMenu")
//                                          → DevMenuAction.Close → isOpen=false,
//                                            whose LaunchedEffect animates the
//                                            sheet to Hidden and clears the
//                                            onboarding page
//   ios     .../Modules/DevMenuModule.swift AsyncFunction("closeMenu")
//                                          → DevMenuManager.shared.closeMenu()
//
// No BACK press, no coordinate tap, no label matching. It therefore cannot exit
// the app to the launcher (the failure mode that got the BACK approach
// reverted) and cannot click a button belonging to the component under
// verification (the failure mode that earned the warm rungs their
// no-dismissals rule).
//
// RESOLVED WITH ZERO IMPORTS, and that is deliberate. The obvious spelling —
// `import { requireOptionalNativeModule } from 'expo'` — bundles fine against a
// WARM Metro cache and then takes the ENTIRE companion down on the next
// `--clear` rebuild:
//
//   [runtime not ready]: TypeError: Cannot read property 'EventEmitter' of
//   undefined … registerExportsForReactRefresh … metroRequire
//
// `expo`'s entry re-exports EventEmitter / SharedObject / requireNativeModule
// from `expo-modules-core`, which pnpm does NOT hoist. In the generated
// companion's node_modules that re-export can resolve to undefined, and the
// module graph dies before any screen renders — observed as a redbox where the
// app used to be. A dev-menu dismissal helper must never be able to do that.
//
// `requireOptionalNativeModule` reads `globalThis.expo?.modules?.[name]` FIRST
// (expo-modules-core/src/requireNativeModule.ts), and expo-modules-core installs
// that registry at startup — long before this is ever called, since it only runs
// at navigate/ack time. So the registry is read directly: no import, no
// module-graph edge, nothing that can fail at bundle time. A release build, or
// any binary without expo-dev-menu linked, simply yields undefined and every
// call below becomes a silent no-op.
let __devMenuModule: any = null;
let __devMenuResolved = false;

function getDevMenuModule(): any {
  if (__devMenuResolved) return __devMenuModule;
  __devMenuResolved = true;
  try {
    __devMenuModule = (globalThis as any)?.expo?.modules?.ExpoDevMenu ?? null;
  } catch {
    __devMenuModule = null;
  }
  return __devMenuModule;
}

/**
 * Close the Expo dev menu if it is up. Resolves TRUE only when the native close
 * actually resolved — `false` means "nothing was dismissed" (no dev-menu module
 * in this binary, or the native call rejected), which is honest for the host's
 * ack: it must never read a no-op as a dismissal.
 *
 * Safe to call when the menu is already closed: Close is an idempotent state
 * write (`isOpen = false`), and the sheet's LaunchedEffect skips the animation
 * when it is already Hidden.
 */
async function closeDevMenu(): Promise<boolean> {
  const mod = getDevMenuModule();
  if (!mod) return false;
  const fn =
    typeof mod.closeMenu === 'function'
      ? mod.closeMenu
      : typeof mod.hideMenu === 'function'
        ? mod.hideMenu
        : null;
  if (!fn) return false;
  try {
    await fn.call(mod);
    return true;
  } catch {
    // Android throws IllegalStateException('Dev Menu is not initialized') when
    // no menu has been attached to the activity — i.e. there is nothing to
    // close. Not an error worth surfacing; report "dismissed nothing".
    return false;
  }
}

/** Fire-and-forget close for hot paths that must not await (navigate handling). */
function closeDevMenuSoon(): void {
  void closeDevMenu().catch(() => false);
}

/**
 * How long the render ack will wait on the dev-menu close before sending
 * anyway. The close is a trivial native state write (single-digit ms), so this
 * bound only exists so a wedged native call can never hold the ack hostage —
 * the ack is the host's PRIMARY render confirmation and losing it costs a whole
 * capture, which is strictly worse than acking with the menu still up (the host
 * still has its own observed, retrying dismissal for that case).
 */
const DEV_MENU_CLOSE_ACK_BUDGET_MS = 400;

/** closeDevMenu() with the ack budget above; never rejects, never hangs. */
function closeDevMenuBounded(): Promise<boolean> {
  return Promise.race([
    closeDevMenu().catch(() => false),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), DEV_MENU_CLOSE_ACK_BUDGET_MS),
    ),
  ]);
}

// Install the console.error counter at module load — before any screen mounts —
// so an error logged during the very first render is observed. Idempotent +
// self-guarded; a failure leaves console.error untouched (channel stays at 0).
patchConsoleErrorOnce();

export function ValidityNativeRoot({
  registry,
  views: bakedViews = {},
  scenarios: bakedScenarios = {},
  asyncStorageSeed: bakedAsyncStorageSeed = [],
  seedAsyncStorage,
  loadFonts,
  bridgeUrl,
}: Props) {
  const [target, setTarget] = useState<NativeTarget>({});

  // Color-scheme (theme) override from the verify run's color-scheme axis.
  // Appearance.setColorScheme forces RN's `useColorScheme()` globally, so a
  // theme system built on it (Ignite, most RN apps) flips WITHOUT the app
  // needing to read a prop — the highest-leverage native theming hook. Re-runs
  // per navigation.
  //
  // ANDROID: `setColorScheme(null)` — the documented "restore the system
  // default" call, and the value used on EVERY navigation that doesn't force a
  // theme, i.e. almost all of them — throws
  //   java.lang.NullPointerException: Parameter specified as non-null is null
  //   at com.facebook.react.modules.appearance.AppearanceModule.setColorScheme
  // because the Kotlin signature is non-null. The throw happens on the native
  // module queue (com.facebook.jni.NativeRunnable.run), NOT synchronously in
  // JS, so the try/catch below cannot catch it: it kills the React instance and
  // expo-dev-launcher shows "There was a problem loading the project."
  //
  // That is why Android NEVER rendered a component while iOS was fine on the
  // same tree — iOS's implementation accepts null. Skipping the reset on
  // Android is safe: the only state to restore is "no override", which is
  // already true unless a previous navigation forced one, and re-forcing a
  // concrete scheme still works. Verified on an API 35 emulator.
  useEffect(() => {
    const scheme = target.colorScheme;
    const forced = scheme === 'light' || scheme === 'dark' ? scheme : null;
    if (forced === null && Platform.OS === 'android') return;
    try {
      Appearance.setColorScheme(forced);
    } catch {
      /* older RN without setColorScheme — theme axis degrades to a single theme */
    }
  }, [target.colorScheme]);

  const [seeded, setSeeded] = useState(!seedAsyncStorage);
  const [fontsReady, setFontsReady] = useState(!loadFonts);
  const [bridgeConnected, setBridgeConnected] = useState(false);

  // Host-pushed DATA (GET /data boot fetch) wins over the baked props: a
  // reloaded/cold session picks up fresh views + scenario + mock state with no
  // rebuild. Null until (and unless) the fetch succeeds → baked fallback.
  const [hostData, setHostData] = useState<NativeData | null>(null);
  const views = hostData?.views ?? bakedViews;
  const scenarios = hostData?.scenarios ?? bakedScenarios;

  // Publish the active scenario's context seed (logged-in/logged-out/custom)
  // BEFORE the screen renders, so the auto-mocked context proxy overlays it when
  // a consumer reads useAuth().isAuthenticated etc. Set synchronously in render
  // (this parent runs before its children) and re-read each navigation. Priority:
  // the seed shipped INLINE with this navigation (bridge navigate.scenarioSeed)
  // wins over the (host-fetched, else baked) map; null when no scenario → the
  // proxy's heuristic defaults apply (effectively logged-out). Wire format is
  // re-materialized so literal-`undefined` keys (e.g. cleared authToken) exist.
  globalThis.__VALIDITY_CONTEXT_SEED__ = materializeScenarioSeed(
    target.scenarioSeed ?? (target.scenario ? scenarios[target.scenario] : null),
  );

  // Live socket + the token of the navigation we still owe a `rendered` ack for.
  const wsRef = useRef<WebSocket | null>(null);
  const pendingTokenRef = useRef<string | null>(null);

  // Has ANY navigation been applied in this JS session (host navigate/home,
  // deep link, or on-device tap)? Replays — the host's automatic re-send of its
  // last drive command on (re)connect, tagged `replay: true` — are applied only
  // while this is false: a fresh session after a reload self-heals back to the
  // host's target, but a session that already navigated must not be yanked back
  // to an older one by a replay racing a newer navigate or a socket-only
  // reconnect (the host process restarted while we kept rendering).
  const hasNavigatedRef = useRef(false);

  // Stable device identity for the bridge hello — resolved once, best-effort.
  // Null until (and unless) it resolves; the hello degrades to platform-only.
  const deviceIdentityRef = useRef<string | null>(null);

  // Announce who we are + what we run: the host compares `contentHash` against
  // its freshly-prepared one to catch a stale bundle, uses `device` to
  // correlate this socket with the simulator/emulator it drives, and gates
  // protocol extras on `caps` — 'reload' tells it this bundle handles the
  // in-place `reload` message, so a stale bundle is refreshed without the
  // terminate+cold-launch ladder, and 'dismiss-dev-menu' tells it this bundle
  // can close the Expo dev menu from the inside (see closeDevMenu) so the host
  // never has to press BACK or click a labelled row to clear it, and
  // 'deep-link-ack' tells it this bundle ALSO acks a TOKENIZED DEEP LINK (not
  // just a bridge `navigate`), so a render confirmed on the deep-link rung
  // still carries the observation channels — perf above all (see the Linking
  // effect below). Old hosts simply ignore the extra fields (their hello
  // handling is type-only), and a host that sees a capability MISSING skips
  // that message entirely rather than pushing one an old binary would silently
  // drop (or, for 'deep-link-ack', waiting for an ack that can never come).
  const sendHello = useCallback((ws: WebSocket) => {
    try {
      // Mock-network state is established at module load (startMockNetwork runs
      // in native-entry before the bridge connects), so it's already settled by
      // the time we say hello. Guard the call so a missing/old mocks module
      // (no getMockStatus export) degrades to "no signal", never a crashed hello.
      let mock: { active: boolean; reason?: string } | undefined;
      try {
        mock = typeof getMockStatus === 'function' ? getMockStatus() : undefined;
      } catch {
        mock = undefined;
      }
      ws.send(
        JSON.stringify({
          type: 'hello',
          contentHash:
            typeof VALIDITY_CONTENT_HASH === 'string' ? VALIDITY_CONTENT_HASH : undefined,
          device: {
            id: deviceIdentityRef.current ?? undefined,
            platform: Platform.OS,
          },
          mock,
          caps: ['reload', 'dismiss-dev-menu', 'deep-link-ack'],
        }),
      );
    } catch {
      /* ignore */
    }
  }, []);

  // Resolve the device identity once; if the socket connected before it
  // resolved, re-announce so the host still learns it.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => getDeviceIdentity())
      .then((id: unknown) => {
        if (cancelled || typeof id !== 'string' || !id) return;
        deviceIdentityRef.current = id;
        const ws = wsRef.current;
        if (ws && ws.readyState === 1 /* OPEN */) sendHello(ws);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sendHello]);

  // ON-DEVICE navigation (tapping a row on the dashboard, or the back chip) uses
  // the SAME target construct the host drives over the bridge — it just calls
  // setTarget directly. A manual nav owes no host `rendered` ack, so we clear any
  // pending token first; otherwise the render-ack effect would post a stale
  // token for a target the host never asked for.
  const navigateLocal = useCallback((t: NativeTarget) => {
    pendingTokenRef.current = null;
    hasNavigatedRef.current = true;
    resetNavObservations();
    setTarget(t);
  }, []);

  // Load the host's custom fonts once before the first mount — but time-boxed,
  // so a missing/slow font asset degrades to the system font instead of leaving
  // the playground stuck on a blank screen.
  useEffect(() => {
    if (!loadFonts) return;
    let cancelled = false;
    const timeout = new Promise<void>((r) => setTimeout(r, FONT_LOAD_TIMEOUT_MS));
    Promise.race([loadFonts().catch(() => {}), timeout]).finally(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loadFonts]);

  // Dismiss the native launch screen once the gates have passed — i.e. once the
  // target content (or the playground home) is actually committed, never during
  // the "Loading fonts…"/"Seeding…" states. hideSplash() is generated per
  // project (real expo-splash-screen call or a no-op) and is idempotent, so
  // this is safe to fire whenever `ready` flips and across re-navigations.
  //
  // NOTE: companion BINARIES built at COMPANION_BUILD_REVISION >= 2 ship with
  // the expo-splash-screen plugin stripped (see prepare-native-app's
  // appConfigJs), so reloads — including the host-pushed `reload` handled in
  // the bridge effect below — cannot re-present a launch screen and this hide
  // is a cheap cold-launch nicety. On OLD binaries (built before the strip) it
  // is still load-bearing, and there a mid-session reload re-presents a splash
  // JS can never dismiss (RCTReload → SplashScreenManager.showSplashScreen
  // against the stale launch rootView) — which is why the host pushes `reload`
  // only to bundles announcing the 'reload' capability and keeps ordinary warm
  // switches IN-PLACE (see openViaBridge()/reloadViaBridge() in capture-native.ts).
  const ready = fontsReady && seeded;
  useEffect(() => {
    if (ready) hideSplash();
  }, [ready]);

  // Seed AsyncStorage once before the first mount, from the BAKED pairs (always
  // available, offline-safe). The boot fetch below re-seeds the host's fresher
  // pairs as a best-effort overlay; we never block the first mount on the
  // network, so a missing/slow bridge can't hang the playground.
  useEffect(() => {
    let cancelled = false;
    if (seedAsyncStorage) {
      seedAsyncStorage(bakedAsyncStorageSeed)
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setSeeded(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [seedAsyncStorage]);

  // BOOT FETCH: pull the freshest DATA payload from the bridge's GET /data and
  // apply it with PRIORITY over the baked fallback — the cold/reload path's
  // analog of the inline navigate slices. Same port as the WS bridge (just
  // ws→http), so Android's existing `adb reverse` for the bridge already covers
  // it. Best-effort: any failure (offline, no host, non-Validity holder) leaves
  // the baked fallback in place. Re-run whenever a NEW bridge connection is
  // established (bridgeConnected flips true) so a host that started after the
  // app, or a reconnect carrying newer data, refreshes us.
  useEffect(() => {
    if (!bridgeUrl || typeof fetch !== 'function' || !bridgeConnected) return;
    let cancelled = false;
    const httpBase = bridgeUrl.replace(/^ws/i, 'http').replace(/\/$/, '');
    // Exempt the bridge origin from msw FIRST, else the permissive catch-all
    // answers this fetch with {} and the host data never loads.
    setBridgePassthrough(httpBase);
    fetch(httpBase + '/data')
      .then((r) => (r && r.ok ? r.json() : null))
      .then((body: any) => {
        if (cancelled || !body || body.validityNativeBridge !== true) return;
        const data = body.data as NativeData | null;
        if (!data || typeof data !== 'object') return;
        // Apply mock-network FIRST (before any re-render mounts a screen that
        // fetches), then publish the fresher views/scenarios for the home
        // listing + scenario overlay, then re-seed AsyncStorage best-effort.
        if (data.mockNetwork) {
          try {
            applyMockNetwork(data.mockNetwork);
          } catch {
            /* ignore — mocking stays at its baked state */
          }
        }
        setHostData(data);
        if (seedAsyncStorage && Array.isArray(data.asyncStorage) && data.asyncStorage.length > 0) {
          seedAsyncStorage(data.asyncStorage).catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [bridgeUrl, bridgeConnected, seedAsyncStorage]);

  // Initial + live deep links — the cold-launch + bridge-less fallback path.
  // Deep-link navigations count as session navigation (hasNavigatedRef) so a
  // later bridge replay can't override what a deep link just selected.
  //
  // A TOKENIZED deep link is a HOST navigation too. The host mints the token,
  // puts it in the URL, and confirms the render by waiting for the tokenized
  // marker (`validity-root:<token>`) in the a11y tree — the rung it falls to
  // whenever a bridge `navigate` ack times out. That rung used to owe no ack,
  // which silently dropped EVERY per-render observation channel for that
  // capture: no `perf` (so `expect.performance metric: mount` reported
  // "native perf channel unavailable — rebuild the companion" on a perfectly
  // current companion), no `matched`, no `consoleErrorCount`. So: stamp the
  // pending token + the paint-timing origin here exactly like the bridge
  // `navigate` branch does, and let the render-ack effect below post
  // `{type:'rendered', token, ok, perf, …}` over the WS. The host reads it via
  // the retained-ack channel (native-bridge waitForRendered) after the marker
  // confirms — see capture-native's adoptDeviceAckForMarker.
  //
  // Untokenized deep links (a human opening `myapp://validity?component=…` by
  // hand) still owe nothing: no token, no pending ack, unchanged behavior.
  // With no socket the ack write is a no-op, so this cannot fail a bridge-less
  // deep link either.
  useEffect(() => {
    const applyDeepLink = (t: NativeTarget): void => {
      hasNavigatedRef.current = true;
      if (typeof t.token === 'string' && t.token) {
        pendingTokenRef.current = t.token;
        // Before resetNavObservations, which clears the collectors but keeps
        // the stamp (see resetPerf).
        stampPerfNavStart();
      }
      resetNavObservations();
      setTarget(t);
    };
    Linking.getInitialURL()
      .then((url) => {
        const t = parseTargetFromUrl(url);
        if (t.component || t.view) applyDeepLink(t);
      })
      .catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => {
      const t = parseTargetFromUrl(url);
      if (t.component || t.view) applyDeepLink(t);
    });
    return () => sub.remove?.();
  }, []);

  // Control bridge — the PRIMARY navigation path. The host pushes `navigate` /
  // `home` (each tagged with a token); we apply it in place and, once it paints,
  // ack `{type:'rendered', token, ok}`. Auto-reconnects so the device survives
  // the host process restarting between calls. Optional: if no host is
  // listening, this quietly retries and the deep-link path still works.
  useEffect(() => {
    if (!bridgeUrl || typeof WebSocket === 'undefined') return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2000);
    };

    const connect = () => {
      if (cancelled) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(bridgeUrl);
      } catch {
        scheduleReconnect();
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        if (!cancelled) setBridgeConnected(true);
        sendHello(ws);
        // NAVIGATION INTENT CHANNEL: publish a sender the auto-mocked navigator
        // calls whenever a screen tries to navigate. In isolation the navigator
        // is a mock, so the navigation never happens — the host needs to know
        // one was ATTEMPTED so a check asserting "we left this screen" is
        // reported `unverifiable` rather than as a confident product failure.
        // Best-effort and fire-and-forget; a host that predates the message
        // type ignores it.
        (globalThis as any).__validitySendNavIntent = (method: string) => {
          try {
            ws.send(JSON.stringify({ type: 'nav-intent', method, at: Date.now() }));
          } catch {
            /* ignore — intent reporting must never break a render */
          }
        };
      };
      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ping') {
          sendHello(ws);
          return;
        }
        // Host-pushed IN-PLACE reload: tear this JS session down and re-fetch
        // the bundle from Metro — the cheap stale-bundle recovery (the
        // companion ships no expo-splash-screen, so a reload cannot re-present
        // a stuck launch screen). The fresh session reconnects and sends a new
        // hello; the host waits for that before navigating, so no ack is owed
        // here. Deferred a tick so the WS frame queue flushes before the
        // runtime is torn out from under it. Guarded: if DevSettings is
        // missing/throws, the host's reconnect wait times out and it falls
        // back to the terminate+cold-launch ladder.
        if (msg.type === 'reload') {
          setTimeout(() => {
            try {
              DevSettings.reload();
            } catch {
              /* ignore — host falls back to terminate + cold launch */
            }
          }, 50);
          return;
        }
        // Host-pushed dev-menu dismissal: the host SAW the Expo dev menu in its
        // accessibility snapshot and is asking the app to close it from the
        // inside (see closeDevMenu — the menu auto-opens on every React context
        // init until a human finishes onboarding, and being modal it hides the
        // render marker underneath). Acked per token so the host learns whether
        // anything was actually dismissed instead of guessing from a re-snapshot
        // that may still be lagging the real UI. Carries no target, is never
        // recorded as a drive command, and is answered even mid-render.
        if (msg.type === 'dismiss-dev-menu') {
          const dismissToken = typeof msg.token === 'string' ? msg.token : null;
          void closeDevMenu().then(
            (ok) => {
              try {
                ws.send(JSON.stringify({ type: 'dev-menu-dismissed', token: dismissToken, ok }));
              } catch {
                /* ignore — the host's wait times out and it re-observes */
              }
            },
            () => {
              try {
                ws.send(
                  JSON.stringify({ type: 'dev-menu-dismissed', token: dismissToken, ok: false }),
                );
              } catch {
                /* ignore */
              }
            },
          );
          return;
        }
        // Replay = the host's automatic resend of its LAST drive command on
        // (re)connect, not fresh intent. Apply it only on a virgin JS session
        // (post-reload self-heal); once anything has navigated here, a replay
        // is by definition older-or-equal and must not win a race against an
        // in-flight newer navigate or an on-device/deep-link selection.
        if (msg.replay === true && hasNavigatedRef.current) return;
        if (msg.type === 'home') {
          // Ephemeral landing — drop the active view entirely.
          // Same rationale as the navigate branch: clear any open dev menu as
          // the navigation starts so it can't occlude the landing screen.
          closeDevMenuSoon();
          pendingTokenRef.current = typeof msg.token === 'string' ? msg.token : null;
          // Stamp the paint-timing origin for THIS host navigation (readyMs).
          // Before resetNavObservations, which clears the collectors but keeps
          // the stamp. Local/deep-link navs owe no ack, so they don't stamp.
          stampPerfNavStart();
          hasNavigatedRef.current = true;
          resetNavObservations();
          setTarget({});
          return;
        }
        if (msg.type === 'navigate' && (msg.component || msg.view)) {
          // Apply the inline mock-network payload BEFORE the target mounts, so a
          // screen that fetches on render sees the fresh handlers (no rebuild).
          // Absent → the device keeps whatever it last applied (boot/baked).
          if (msg.mockNetwork) {
            try {
              applyMockNetwork(msg.mockNetwork);
            } catch {
              /* ignore — mocking stays at its current state */
            }
          }
          // A dev menu opened by a shake / three-finger press / the launch-time
          // onboarding would occlude this target the moment it paints. Clear it
          // as the navigation starts — fire-and-forget so it costs the render
          // nothing; the awaited close before the ack below is the one that has
          // to have landed.
          closeDevMenuSoon();
          pendingTokenRef.current = typeof msg.token === 'string' ? msg.token : null;
          // Stamp the paint-timing origin for THIS host navigation (readyMs) —
          // before resetNavObservations (which keeps the stamp). Local/deep-link
          // navs owe no ack and never stamp.
          stampPerfNavStart();
          hasNavigatedRef.current = true;
          // Fresh navigation — only THIS target's observations (un-mocked
          // fetches, network responses, console errors, render-perf) reach the ack.
          resetNavObservations();
          setTarget({
            component: msg.component,
            view: msg.view,
            // Inline items (ephemeral view) win over the baked map; absent for a
            // component navigate or a view the host didn't resolve.
            viewItems: Array.isArray(msg.items) ? msg.items : undefined,
            fixture: msg.fixture,
            scenario: msg.scenario,
            // Inline scenario seed (wire) wins over the baked scenarios map.
            scenarioSeed:
              msg.scenarioSeed && typeof msg.scenarioSeed === 'object'
                ? msg.scenarioSeed
                : undefined,
            overrides: msg.propOverrides ?? undefined,
            // Force the theme for this target (color-scheme axis); validated to
            // light/dark so a bad payload can't poison Appearance.
            colorScheme: themeParam(typeof msg.colorScheme === 'string' ? msg.colorScheme : null),
            // Tokenize the render marker too: if the bridge ack is lost, the
            // host's deep-link fallback can still confirm THIS target via the
            // per-navigation marker instead of the stale-prone shared one.
            token: typeof msg.token === 'string' ? msg.token : undefined,
          });
        }
      };
      ws.onclose = () => {
        // Drop the intent sender with the socket — writing to a closed WS
        // throws on every navigate attempt otherwise.
        if ((globalThis as any).__validitySendNavIntent) {
          (globalThis as any).__validitySendNavIntent = undefined;
        }
        if (wsRef.current === ws) wsRef.current = null;
        if (!cancelled) setBridgeConnected(false);
        scheduleReconnect();
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
  }, [bridgeUrl]);

  // Render confirmation: once the requested target has actually painted, ack the
  // token so the host knows the NEW target (not a stale previous marker) is on
  // screen. Fires after two frames so "rendered" means pixels, not just commit.
  // Gated on `ready` — a navigate that arrives mid-boot is acked only once fonts
  // + seeding clear and the real content (not a Placeholder) is showing.
  useEffect(() => {
    const token = pendingTokenRef.current;
    if (!token || !ready) return;
    let ok = false;
    if (!target.component && !target.view)
      ok = true; // landing
    else if (target.view) {
      // Inline items (ephemeral) take precedence over the baked map.
      const items = target.viewItems ?? views[target.view];
      ok = Array.isArray(items) && items.length > 0;
    } else if (target.component) ok = !!registry[target.component];
    pendingTokenRef.current = null;
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Run the ack body as an async IIFE: the dev-menu close below is awaited
        // before the ack is written (see the comment there). Nothing awaits this
        // IIFE — the two-frame wait above is unchanged, and every throw inside
        // is caught, so it can never surface as an unhandled rejection.
        void (async () => {
          try {
            // Snapshot the observation channels this target produced (the
            // two-frame wait lets on-mount fetches reach the catch-all /
            // responses land and any render-time console.error fire first):
            //   - unmatched : un-mocked URLs (web's unmatched-fetch block).
            //   - matched   : observed {method,url,status} responses, so the
            //                 host can evaluate expect.network on device.
            //   - consoleErrorCount : console.error calls, for expect.console.
            // unmatched/matched are omitted when empty (mirroring each other);
            // the count is ALWAYS sent so a host can distinguish "0 errors"
            // (pass-able) from "field absent" (old companion → unverifiable).
            // All additive — an old host ignores the extra fields.
            const unmatched = getUnmatchedSafe();
            const matched = getMatchedSafe();
            // Render-perf for expect.performance: readyMs (navStart→this paint
            // confirm), Profiler mount/worst-update durations, and the commit
            // count. A NEW companion ALWAYS sends the perf object (undefined
            // sub-fields serialize away — e.g. updateMs with zero re-renders);
            // an OLD companion sends no perf field at all → host reads that as
            // unverifiable. Same lifecycle as the other channels.
            const perf = getPerfSnapshot();
            const ackPayload = JSON.stringify({
              type: 'rendered',
              token,
              ok,
              consoleErrorCount: getConsoleErrorCount(),
              perf,
              ...(unmatched.length > 0 ? { unmatched } : {}),
              ...(matched.length > 0 ? { matched } : {}),
            });
            // Clear the Expo dev menu BEFORE the ack goes out — the single most
            // load-bearing ordering in this file for Android.
            //
            // The host treats this ack as "the render is done, go look at the
            // device" and immediately queries the view hierarchy for
            // `validity-root:<token>` (capture-native's paintConfirmed). The dev
            // menu is a MODAL bottom sheet, and it auto-opens on every React
            // context init until a human finishes expo-dev-menu's onboarding
            // (see closeDevMenu) — which on the companion is never. Acking while
            // it is up means the host looks at a tree that structurally CANNOT
            // contain the marker, and a good render is demoted to
            // `unconfirmed`.
            //
            // The payload was serialized ABOVE, before this await, so readyMs
            // still measures navStart→paint and not the dismissal — the metric
            // stays comparable with every run recorded before this existed.
            //
            // Bounded (see DEV_MENU_CLOSE_ACK_BUDGET_MS) and never rejecting, so
            // the ack cannot be lost to a wedged native call. wsRef.current is
            // read AFTER the await: the socket may have been replaced while we
            // waited, and writing to the stale one would drop the ack.
            await closeDevMenuBounded();
            wsRef.current?.send(ackPayload);
          } catch {
            /* ignore */
          }
        })();
      });
    });
    return () => cancelAnimationFrame(outer);
  }, [target, ready, registry, views]);

  /**
   * Remount identity for the target subtree. Both screens below are keyed on
   * it, which forces React to REMOUNT rather than reconcile whenever the host
   * navigates. Two things depend on that, and both were broken without it:
   *
   *  1. `expect.performance metric: mount`. `<React.Profiler id="validity-target">`
   *     lives INSIDE these screens, so it only reports phase 'mount' when its
   *     own subtree mounts. Reconciling ComponentScreen in place meant every
   *     warm re-target produced commits with phase 'update' only — observed on
   *     Android as `perf: {readyMs, updateMs, commitCount: 1}` with no
   *     `mountMs`, so the criterion reported "mount not measured on this
   *     render" for a component that had just rendered. Platform-independent;
   *     it surfaced on Android first only because Android now runs warm sweeps.
   *
   *  2. Capture ISOLATION. Without a key, navigating A → B reuses the screen
   *     element position, so any state ComponentScreen/ViewScreen holds carries
   *     from one capture into the next — the exact cross-contamination the
   *     isolated playground exists to prevent.
   *
   * The token is included so re-navigating to the SAME target with the same
   * props still remounts: each capture is meant to be a fresh render, not a
   * continuation of the previous one.
   */
  const targetKey = [
    target.view ?? target.component ?? 'home',
    target.token ?? '',
    target.fixture ?? '',
    target.scenario ?? '',
    target.colorScheme ?? '',
  ].join('|');

  // ---- Body: every branch renders inside the SafeAreaProvider below so the
  // safe-area hooks resolve and content clears notches / the home indicator. ----
  let body: React.ReactElement;
  if (!fontsReady) {
    body = <Placeholder message="Loading fonts…" />;
  } else if (!seeded) {
    body = <Placeholder message="Seeding mock state…" />;
  } else if (!target.component && !target.view) {
    body = (
      <NativeHome
        registry={registry}
        views={views}
        bridgeConnected={bridgeConnected}
        onSelect={navigateLocal}
      />
    );
  } else if (target.view) {
    // Prefer the inline items shipped with this navigation; fall back to the
    // bundled map for a cold deep-link that didn't carry them. The back bar above
    // consumes the top safe-area inset, so the screen must not add it again.
    body = (
      <ViewScreen
        key={targetKey}
        name={target.view}
        items={target.viewItems ?? views[target.view]}
        registry={registry}
        markerToken={target.token}
        topInset={false}
      />
    );
  } else {
    body = (
      <ComponentScreen
        key={targetKey}
        path={target.component!}
        overrides={target.overrides}
        registry={registry}
        markerToken={target.token}
        topInset={false}
      />
    );
  }

  // When a component/view is active, a back bar sits ABOVE it as a real layout
  // row (not an overlay): it reserves its own vertical space and owns the top
  // safe-area inset, so it never covers the component — the screen below renders
  // in the remaining space. Tapping it returns to the searchable dashboard via
  // the same setTarget construct. The home screen has no bar.
  const hasTarget = Boolean(target.component || target.view);
  return (
    <SafeAreaProvider>
      {hasTarget ? (
        <View style={styles.targetWrap}>
          <BackBar onPress={() => navigateLocal({})} />
          <View style={styles.targetBody}>{body}</View>
        </View>
      ) : (
        body
      )}
    </SafeAreaProvider>
  );
}

/** Back-to-dashboard header bar — a real layout row above an active target. */
function BackBar({ onPress }: { onPress: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.backBar,
        {
          paddingTop: insets.top + 6,
          paddingLeft: insets.left + 8,
          paddingRight: insets.right + 12,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to dashboard"
        onPress={onPress}
        hitSlop={8}
        style={({ pressed }) => [styles.backBtn, pressed && styles.backBtnPressed]}
      >
        <Text style={styles.backBtnText}>‹ Dashboard</Text>
      </Pressable>
    </View>
  );
}

/* --------------------------------------------------------------------------- *
 *                              Screen components                              *
 * --------------------------------------------------------------------------- */

/** Safe-area inset padding for the playground chrome (additive over a base). */
function useChromePadding(base = { v: 24, h: 16 }) {
  const insets = useSafeAreaInsets();
  return {
    paddingTop: base.v + insets.top,
    paddingBottom: base.v + insets.bottom,
    paddingLeft: base.h + insets.left,
    paddingRight: base.h + insets.right,
  };
}

function Placeholder({ message }: { message: string }) {
  const pad = useChromePadding();
  return (
    <View style={[styles.center, pad]}>
      <Text style={styles.placeholder}>{message}</Text>
    </View>
  );
}

/**
 * The playground landing screen — shown when no target is selected. Mirrors the
 * web browse home's hierarchy (brand → hint → views → components) but tuned for
 * touch + safe areas. Navigation is ephemeral and AI-driven: ask Validity to
 * show a component/view and the host re-targets this screen in place.
 */
/** Cap on rendered component rows (the registry can be large); search past it. */
const MAX_COMPONENT_ROWS = 50;

function NativeHome({
  registry,
  views,
  bridgeConnected,
  onSelect,
}: {
  registry: Record<string, ComponentType<any>>;
  views: Record<string, ViewItem[]>;
  bridgeConnected: boolean;
  /** Navigate to a component/view using the same target construct the host drives. */
  onSelect: (t: NativeTarget) => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  // Case-insensitive substring match — views by name, components by path OR
  // basename so "button" finds `app/components/Button.tsx`.
  const allViewNames = Object.keys(views).sort();
  const allComponentPaths = Object.keys(registry).sort();
  const viewNames = q ? allViewNames.filter((n) => n.toLowerCase().includes(q)) : allViewNames;
  const componentPaths = q
    ? allComponentPaths.filter(
        (p) => p.toLowerCase().includes(q) || basename(p).toLowerCase().includes(q),
      )
    : allComponentPaths;
  const shownComponents = componentPaths.slice(0, MAX_COMPONENT_ROWS);
  const nothing = viewNames.length === 0 && componentPaths.length === 0;

  return (
    <ScrollView
      style={styles.homeScroll}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{
        paddingTop: 28 + insets.top,
        paddingBottom: 40 + insets.bottom,
        paddingLeft: 20 + insets.left,
        paddingRight: 20 + insets.right,
      }}
    >
      <View style={styles.brandRow}>
        <View style={styles.brandMark}>
          <Text style={styles.brandMarkText}>V</Text>
        </View>
        <View>
          <Text style={styles.brandTitle}>Validity</Text>
          <Text style={styles.brandSubtitle}>Component playground</Text>
        </View>
        <View style={styles.statusPillWrap}>
          <View
            style={[styles.statusDot, bridgeConnected ? styles.statusDotOn : styles.statusDotOff]}
          />
          <Text style={styles.statusText}>{bridgeConnected ? 'Connected' : 'Offline'}</Text>
        </View>
      </View>

      <Text style={styles.lead}>
        A live, isolated mirror of your components — mocked network, navigation, and storage. Search
        and tap to open one, or ask Validity to show it.
      </Text>

      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search components and views"
          placeholderTextColor="#9aa1ad"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>

      {viewNames.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>
            Views <Text style={styles.sectionCount}>{viewNames.length}</Text>
          </Text>
          {viewNames.map((n) => (
            <Pressable
              key={n}
              accessibilityRole="button"
              accessibilityLabel={`Open view ${n}`}
              onPress={() => onSelect({ view: n })}
              style={({ pressed }) => [styles.rowCard, pressed && styles.rowCardPressed]}
            >
              <View style={[styles.kindGlyph, styles.kindGlyphView]}>
                <Text style={styles.kindGlyphText}>◆</Text>
              </View>
              <Text style={[styles.rowLabel, styles.rowLabelGrow]} numberOfLines={1}>
                {n}
              </Text>
              <Text style={styles.rowChevron}>›</Text>
            </Pressable>
          ))}
        </View>
      )}

      {componentPaths.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>
            Components <Text style={styles.sectionCount}>{componentPaths.length}</Text>
          </Text>
          {shownComponents.map((p) => (
            <Pressable
              key={p}
              accessibilityRole="button"
              accessibilityLabel={`Open ${basename(p)}`}
              onPress={() => onSelect({ component: p })}
              style={({ pressed }) => [styles.rowCard, pressed && styles.rowCardPressed]}
            >
              <View style={styles.kindGlyph}>
                <Text style={styles.kindGlyphText}>{basename(p).charAt(0).toUpperCase()}</Text>
              </View>
              <View style={styles.rowTextWrap}>
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {basename(p)}
                </Text>
                <Text style={styles.rowPath} numberOfLines={1}>
                  {p}
                </Text>
              </View>
              <Text style={styles.rowChevron}>›</Text>
            </Pressable>
          ))}
          {componentPaths.length > shownComponents.length && (
            <Text style={styles.more}>
              +{componentPaths.length - shownComponents.length} more — refine your search
            </Text>
          )}
        </View>
      )}

      {nothing && (
        <Text style={styles.empty}>
          {q
            ? `No components or views match “${query.trim()}”.`
            : 'No components or views registered.'}
        </Text>
      )}
    </ScrollView>
  );
}

/**
 * VIEW: a named composition — stack each item (component + props) with its
 * label, the native analog of the web canvas's frames.
 */
function ViewScreen({
  name,
  items,
  registry,
  markerToken,
  topInset = true,
}: {
  name: string;
  items?: ViewItem[];
  registry: Record<string, ComponentType<any>>;
  /** Host navigation token — tokenizes the render marker (see renderMarkerId). */
  markerToken?: string;
  /** Apply the top safe-area inset. False when a back bar above already cleared it. */
  topInset?: boolean;
}) {
  const insets = useSafeAreaInsets();
  if (!items || items.length === 0) {
    return <Placeholder message={`No view registered for "${name}".`} />;
  }
  return (
    <ScrollView
      testID={renderMarkerId(markerToken)}
      accessibilityLabel={renderMarkerId(markerToken)}
      contentContainerStyle={{
        paddingTop: 16 + (topInset ? insets.top : 0),
        paddingBottom: 24 + insets.bottom,
      }}
    >
      <Text
        style={[
          styles.viewTitle,
          { paddingLeft: 16 + insets.left, paddingRight: 16 + insets.right },
        ]}
      >
        {name}
      </Text>
      {items.map((item, i) => {
        const ItemComp = registry[item.path];
        return (
          <View
            key={`${item.path}:${i}`}
            style={{
              marginBottom: 24,
              paddingLeft: 16 + insets.left,
              paddingRight: 16 + insets.right,
            }}
          >
            <Text style={styles.itemLabel}>{item.label}</Text>
            {ItemComp ? (
              // React.Profiler measures this target's mount/update durations for
              // the perf channel (expect.performance). It remounts per target
              // (these screens are recreated on navigation), so phase 'mount'
              // fires once per capture. onProfileRender is fully guarded.
              <React.Profiler id="validity-target" onRender={onProfileRender}>
                <RenderErrorBoundary resetKey={`${item.path}:${i}`} subject={item.label}>
                  <MockProviderShell routePath={item.path}>
                    <ItemComp {...(item.props || {})} />
                  </MockProviderShell>
                </RenderErrorBoundary>
              </React.Profiler>
            ) : (
              <Text style={styles.missing}>missing: {item.path}</Text>
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

/** COMPONENT: single mount, padded into the safe area so it isn't edge-to-edge. */
function ComponentScreen({
  path,
  overrides,
  registry,
  markerToken,
  topInset = true,
}: {
  path: string;
  overrides?: Record<string, unknown>;
  registry: Record<string, ComponentType<any>>;
  /** Host navigation token — tokenizes the render marker (see renderMarkerId). */
  markerToken?: string;
  /** Apply the top safe-area inset. False when a back bar above already cleared it. */
  topInset?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const Comp = registry[path];
  if (!Comp) {
    return <Placeholder message={`No component registered for "${path}".`} />;
  }
  const props = (overrides ?? {}) as Record<string, unknown>;
  // Render marker (contract with the native capture flow's deep-link fallback):
  // it is mounted ONLY when an actual component/view renders — never for the
  // launcher, "Seeding…", or placeholder states — so the cold path's
  // waitForRef resolves once content is on screen. With a host token the
  // marker is per-navigation (`validity-root:<token>`), so a STALE previous
  // render can't satisfy the wait; without one it degrades to the shared
  // marker. The bridge path uses the per-token `rendered` ack instead. Keep in
  // sync with DEFAULT_RENDER_MARKER in packages/native/src/capture-native.ts.
  return (
    <View
      testID={renderMarkerId(markerToken)}
      accessibilityLabel={renderMarkerId(markerToken)}
      style={{
        flex: 1,
        paddingTop: topInset ? insets.top : 0,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      {/* React.Profiler measures this target's mount/update durations for the
          perf channel (expect.performance). It remounts per target (the screen
          is recreated on navigation), so phase 'mount' fires once per capture.
          onProfileRender is fully guarded. */}
      <React.Profiler id="validity-target" onRender={onProfileRender}>
        <RenderErrorBoundary resetKey={path} subject={basename(path)}>
          <MockProviderShell routePath={path}>
            <Comp {...props} />
          </MockProviderShell>
        </RenderErrorBoundary>
      </React.Profiler>
    </View>
  );
}

/**
 * Catches a render throw from an isolated component/view and shows an ACTIONABLE
 * card instead of a raw redbox. Navigation is auto-mocked, so a surviving
 * "must be used within a Provider" error is an APP-specific provider (auth,
 * theme, query) the user must add to `.validity/wrapper.native.tsx` — the card
 * says exactly that. Resets when `resetKey` changes (navigating to another
 * target retries). Rendered INSIDE the `validity-root` marker so the capture
 * flow screenshots the card rather than hanging on a never-rendered marker.
 */
class RenderErrorBoundary extends React.Component<
  { resetKey?: string; subject?: string; children: React.ReactNode },
  { error: any }
> {
  constructor(props: any) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { error };
  }
  componentDidUpdate(prev: any) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      return <ProviderErrorCard subject={this.props.subject} error={this.state.error} />;
    }
    return this.props.children;
  }
}

function ProviderErrorCard({ subject, error }: { subject?: string; error: any }) {
  const message = (error && (error.message || String(error))) || 'Unknown render error';
  // Anchored on real provider/context phrasings — deliberately NOT the bare words
  // "context"/"navigator" (those match unrelated errors like "context is not
  // defined" and mislabel them as missing-provider).
  const providerish =
    /must be used within|could ?n.?t find a (navigation|theme|route|navigator)|wrap .*in a .*provider|missing .*context|is your component inside/i.test(
      message,
    );
  return (
    <View style={styles.errCard}>
      <Text style={styles.errTitle}>Can’t render {subject || 'this screen'} in isolation</Text>
      <Text style={styles.errMsg} numberOfLines={8}>
        {message}
      </Text>
      <Text style={styles.errHint}>
        {providerish
          ? 'This screen needs a context provider that isn’t mounted. Navigation is auto-mocked, so this is an app-specific provider (auth, theme, query…). Add it to .validity/wrapper.native.tsx — it wraps every isolated render.'
          : 'The component threw while rendering. If it needs an app provider, add it to .validity/wrapper.native.tsx.'}
      </Text>
    </View>
  );
}

/** Base filename (sans extension) for a component path. */
function basename(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.(t|j)sx?$/, '');
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  placeholder: { fontSize: 16, textAlign: 'center', opacity: 0.7, color: '#3c4350' },

  homeScroll: { flex: 1, backgroundColor: '#f7f8fa' },

  brandRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  brandMark: {
    width: 40,
    height: 40,
    borderRadius: 11,
    backgroundColor: '#2354c7',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  brandMarkText: { color: '#fff', fontSize: 22, fontWeight: '700' },
  brandTitle: { fontSize: 20, fontWeight: '700', color: '#11151c' },
  brandSubtitle: { fontSize: 13, color: '#6b7280', marginTop: 1 },
  statusPillWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
    backgroundColor: '#eef0f4',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  statusDot: { width: 7, height: 7, borderRadius: 999, marginRight: 6 },
  statusDotOn: { backgroundColor: '#1ca672' },
  statusDotOff: { backgroundColor: '#c2c7d0' },
  statusText: { fontSize: 11, color: '#6b7280', fontWeight: '600' },

  lead: { fontSize: 15, lineHeight: 22, color: '#3c4350', marginBottom: 16 },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e7e9ee',
    paddingHorizontal: 12,
    marginBottom: 22,
  },
  searchIcon: { fontSize: 17, color: '#9aa1ad', marginRight: 8 },
  searchInput: { flex: 1, paddingVertical: 11, fontSize: 15, color: '#11151c' },

  section: { marginBottom: 24 },
  sectionHeader: { fontSize: 13, fontWeight: '700', color: '#11151c', marginBottom: 10 },
  sectionCount: { color: '#9aa1ad', fontWeight: '600' },

  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ebedf1',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  kindGlyph: {
    width: 26,
    height: 26,
    borderRadius: 7,
    backgroundColor: '#eef2fb',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 11,
  },
  kindGlyphView: { backgroundColor: '#f0ebfb' },
  kindGlyphText: { fontSize: 12, fontWeight: '700', color: '#2354c7' },
  rowCardPressed: { backgroundColor: '#f1f4fb', borderColor: '#cdd8f3' },
  rowTextWrap: { flex: 1 },
  rowLabel: { fontSize: 14, fontWeight: '600', color: '#1b2230' },
  rowLabelGrow: { flex: 1 },
  rowPath: { fontSize: 11, color: '#9aa1ad', marginTop: 1 },
  rowChevron: { fontSize: 20, color: '#c2c7d0', marginLeft: 10, fontWeight: '600' },
  more: { fontSize: 12, color: '#9aa1ad', marginTop: 4, fontStyle: 'italic' },
  empty: { fontSize: 14, color: '#6b7280', textAlign: 'center', marginTop: 8 },

  targetWrap: { flex: 1, backgroundColor: '#f7f8fa' },
  targetBody: { flex: 1 },
  backBar: {
    paddingBottom: 8,
    backgroundColor: '#f7f8fa',
    borderBottomWidth: 1,
    borderBottomColor: '#e7e9ee',
  },
  backBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#eef0f4',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  backBtnPressed: { backgroundColor: '#e1e4ea' },
  backBtnText: { color: '#11151c', fontSize: 13, fontWeight: '600' },

  viewTitle: { fontSize: 16, fontWeight: '600', marginBottom: 12, color: '#11151c' },
  itemLabel: { fontSize: 12, opacity: 0.5, marginBottom: 6, color: '#3c4350' },
  missing: { color: '#c00' },

  errCard: {
    backgroundColor: '#fff7f7',
    borderWidth: 1,
    borderColor: '#f0c9c9',
    borderRadius: 12,
    padding: 16,
    margin: 16,
  },
  errTitle: { fontSize: 15, fontWeight: '700', color: '#a3261f', marginBottom: 8 },
  errMsg: {
    fontSize: 12.5,
    color: '#6b3b38',
    marginBottom: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  errHint: { fontSize: 13, lineHeight: 19, color: '#3c4350' },
});
