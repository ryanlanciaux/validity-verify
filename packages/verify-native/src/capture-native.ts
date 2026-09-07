/**
 * Native capture + browse/verify orchestration.
 *
 * Mirrors the web flow for the simulator/emulator:
 *   - BROWSE  → boot the playground at one component ("show me my Button"
 *               renders that Button in isolation, in the simulator).
 *   - VERIFY  → open the target, screenshot + accessibility-snapshot it, and
 *               return both so the agent scores them against the plan — i.e.
 *               "build this feature and validate it works" closes the loop on
 *               native, with the SAME mocked network/nav/auth the playground
 *               harness sets up.
 *
 * The driver (agent-device by default) is injectable, and so is the clock, so
 * this orchestration is unit-testable without a device.
 */
import {
  isClickCheck,
  isFillCheck,
  type CriterionVerdict,
  type SpecCriterion,
} from '@validity.ai/verify-spec';
import type { TargetSpec } from './deep-link.js';
import { DEFAULT_METRO_URL, snapshotShowsDevMenu } from './agent-device-driver.js';
import type {
  NativeDriver,
  ExecResult,
  NativeSessionReadiness,
  CommandRunner,
} from './agent-device-driver.js';
import { collectPerfEvidence, type DeviceEvidence } from './perf-evidence.js';
import { collectNetworkEvidence } from './network-evidence.js';
import type { ResolvedSecret } from './replay-recording.js';
import { runNativeCriterionChecks, type NativeObservedRequest } from './native-check-executor.js';
import type {
  NativeBridgeHandle,
  NativeHomeMessage,
  NativeNavigateMessage,
  NativePerf,
  NativeRenderedResult,
} from './native-bridge.js';
import { BridgePortHeldError, DEEP_LINK_ACK_CAPABILITY } from './native-bridge.js';
import { COMPANION_REVERSE_PORT, ensureAndroidReverse } from './android-reverse.js';
import { COMPANION_BRIDGE_PORT } from './prepare-native-app.js';
import {
  DEFAULT_SETTLE_GATE_COLD_MS,
  DEFAULT_SETTLE_GATE_INTERVAL_MS,
  DEFAULT_SETTLE_GATE_WARM_MS,
  settleUnconfirmed,
  waitForSettledSnapshot,
} from './snapshot-settle.js';
import { makeDevMenuDismisser, type DevMenuDismisser } from './dev-menu-dismiss.js';
import { deviceOnDevLauncherHome, devServerRowRef } from './dev-launcher.js';
import { diagnoseNativeEnvironment, type EnvironmentDiagnosis } from './environment-diagnosis.js';
import {
  appendCaptureMetric,
  deviceDurationFor,
  deviceOpenCount,
  takeCommandCost,
} from './session-metrics.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Monotonic, collision-resistant token for correlating a navigate→rendered ack. */
let __navSeq = 0;
function mintToken(): string {
  __navSeq += 1;
  return `nav-${Date.now().toString(36)}-${__navSeq}`;
}

/** Build the in-place bridge command for a target (home when there's no target). */
function bridgeMessageFor(
  spec: TargetSpec,
  token: string,
): NativeNavigateMessage | NativeHomeMessage {
  if (!spec.component && !spec.view) return { type: 'home', token };
  return {
    type: 'navigate',
    token,
    component: spec.view ? undefined : spec.component,
    view: spec.view,
    // Ship the resolved view inline so the device renders it without a baked
    // registry entry — a new/edited view re-targets with no native rebuild.
    // Only when non-empty: an empty array would defeat the device's
    // `viewItems ?? views[name]` fallback ([] is not nullish).
    items: spec.view && spec.viewItems && spec.viewItems.length > 0 ? spec.viewItems : undefined,
    fixture: spec.fixture,
    scenario: spec.scenario,
    // Ship the resolved scenario seed + mock-network config INLINE so a scenario
    // or mock-handler edit re-targets a warm device as DATA (no rebuild, no
    // contentHash flip) — the device applies them before the target renders.
    scenarioSeed: spec.scenarioSeed,
    mockNetwork: spec.mockNetwork,
    propOverrides: spec.overrides ?? undefined,
    // Force the device theme for this target (verify color-scheme axis).
    colorScheme: spec.colorScheme,
  };
}

/**
 * Render-marker base: the testID/accessibilityLabel prefix on the playground
 * root that ValidityNativeRoot only mounts once a real component/view renders
 * (not the launcher, "Loading…", or "No component" states). The deep-link path
 * tokenizes it per navigation (`validity-root:<token>` — the token travels in
 * the deep link's `token=` param and the harness echoes it back), so waiting on
 * it confirms THIS navigation painted; a stale previous render carries the old
 * token and can't satisfy the wait. Legacy companions without token support
 * render the bare marker, which the host then never matches — that degrades to
 * an 'unconfirmed' status rather than a false positive.
 */
const DEFAULT_RENDER_MARKER = 'validity-root';
const DEFAULT_BUNDLE_WAIT_MS = 4000;
const DEFAULT_RENDER_WAIT_MS = 8000;
/**
 * How long to wait for the render marker on the WARM probe (deep link only, no
 * bundle reload) before falling back to the control-link cold open. Kept short
 * so a genuinely cold device doesn't pay the full render timeout twice — a warm
 * app re-targets in well under this.
 */
const DEFAULT_WARM_WAIT_MS = 3500;
/**
 * After a CONFIRMED warm re-target (bridge ack or per-token marker) settle this
 * briefly before returning so a trailing layout/paint pass lands before the
 * caller screenshots. Kept SMALL on purpose: the confirmation itself already
 * proves pixels painted — the device's `rendered` ack fires after two
 * requestAnimationFrames (ValidityNativeRoot), and the per-token marker only
 * mounts once a real component/view rendered — so this is just slack for a
 * trailing async layout, NOT the old "hope it painted" 1.5s tax it replaced.
 *
 * ESCAPE HATCH: components whose VISIBLE paint genuinely lags the ack — async
 * images decoding, a custom font swapping in, a deferred data effect — can
 * raise it per call via `warmSettleMs` (captureNative/browseNative option). It
 * only applies on the CONFIRMED path; the UNCONFIRMED settle (no paint signal
 * at all) keeps its longer `settleMs` fallback below.
 */
const DEFAULT_WARM_SETTLE_MS = 200;
/**
 * Hello-in-flight grace. `waitForConnection` (and the device's own ~2s
 * reconnect loop) resolves on the socket ATTACH, but the `hello` that carries
 * the staleness/capability signals lands a beat later — reading `deviceInfo()`
 * in that gap silently skips the stale-bundle guard (a warm re-target then
 * confidently acks OLD code as confirmed evidence) and mis-routes a
 * reload-capable companion onto the terminate ladder. `deviceInfo()` is null
 * ONLY between attach and the first hello on the active socket (every
 * companion, including legacy binaries, sends at least a bare hello on open),
 * so a short bounded wait closes the race; a pathological never-hello peer
 * just pays the bound once and degrades to the conservative no-signal path.
 */
const HELLO_WAIT_POLL_MS = 50;
const HELLO_WAIT_MAX_POLLS = 20; // ≈1s worst case

/**
 * Cold-open bundle gate: observable readiness when the caller wired it
 * (tail-the-Metro-log, see `waitForBundleServed`), else the legacy fixed sleep.
 */
async function awaitBundleLoad(opts: ColdOpenOptions): Promise<void> {
  if (opts.waitForBundle) {
    await opts.waitForBundle();
    return;
  }
  await opts.delay(opts.bundleWaitMs ?? DEFAULT_BUNDLE_WAIT_MS);
}

/**
 * How long to wait for the per-token render marker AFTER a bridge `rendered`
 * ack, before deciding the ack was not backed by paint. Short on purpose: the
 * ack already fired, so a real paint is a frame or two behind it, not seconds.
 */
const DEFAULT_PAINT_CONFIRM_MS = 2500;

/**
 * How long the DEEP-LINK rung waits for the device's ack for its link token
 * after the marker already confirmed the paint (see adoptDeviceAckForMarker).
 * Usually costs nothing: a 'deep-link-ack' companion sends the ack the moment
 * the target paints, so the bridge has it RETAINED before the marker wait even
 * returns and the read resolves synchronously. The budget only pays out when
 * the ack is genuinely late (the device also awaits a bounded dev-menu close
 * before writing it), and it is capped low because the alternative — waiting
 * longer — buys a metric, while the marker already bought the verdict.
 */
const DEFAULT_MARKER_ACK_ADOPT_MS = 1500;

/**
 * Adopt the device's `rendered` ack for a DEEP-LINK confirmation, so a capture
 * that fell to the marker rung still carries the per-render observation
 * channels (perf / matched / consoleErrorCount).
 *
 * THE BUG THIS CLOSES: the bridge ack is the only carrier of on-device timing,
 * and a capture confirmed by the marker never had one — so `expect.performance
 * metric: mount` came back `unverifiable` for a render the device HAD measured,
 * on roughly one criterion per Android sweep, rotating to whichever spec's
 * bridge ack happened to lose the race that time. The device now acks tokenized
 * deep links too (ValidityNativeRoot's Linking effect), the bridge retains acks
 * nobody was waiting for (native-bridge retainedAcks), and this reads one.
 *
 * STRICTLY ADDITIVE and best-effort: gated on the companion ANNOUNCING the
 * capability (an old binary never sends one, so we must not burn the budget
 * waiting), never throws, and never changes the render's status — the marker is
 * what proved the paint, and an ack is only allowed to add observations to it.
 */
async function adoptDeviceAckForMarker(
  opts: ColdOpenOptions,
  token: string,
): Promise<NativeRenderedResult | undefined> {
  const bridge = opts.bridge;
  if (!bridge || !bridge.isConnected()) return undefined;
  if (!(bridge.deviceInfo()?.capabilities ?? []).includes(DEEP_LINK_ACK_CAPABILITY)) {
    return undefined;
  }
  try {
    const ack = await bridge.waitForRendered(
      token,
      opts.markerAckAdoptMs ?? DEFAULT_MARKER_ACK_ADOPT_MS,
    );
    return ack ?? undefined;
  } catch {
    return undefined; // an observation channel must never break a confirmed render
  }
}

/**
 * PAINT CROSS-CHECK for the bridge path. The companion's `rendered` ack fires
 * after its JS mountAnimationFrame — which proves the JS committed, NOT that
 * the view is on screen. On Android that gap is real and observable: the bridge
 * acked `{ok:true}` in ~900ms against a blank screen (25 raw nodes, none
 * accessibility-visible; the screenshot showed only the dev-client gear), and
 * in another repro against the dev-LAUNCHER error screen. `renderConfirmation:
 * 'confirmed'` was false both times, so the settle gate settled on a stable
 * wrong tree and every criterion hard-FAILED an app that never drew.
 *
 * The device already renders the per-navigation marker `validity-root:<token>`
 * for BRIDGE navigations too (ValidityNativeRoot threads the navigate message's
 * token into the target and onto the root's testID/accessibilityLabel), so the
 * host can simply ask the device whether that node is actually THERE. That is a
 * view-hierarchy query, not a JS self-report, which is exactly the independence
 * the ack lacks.
 *
 * A miss DEMOTES to `unconfirmed` — never to `failed`. The distinction matters:
 * `failed` means the device looked the target up and could not render it, which
 * is a real defect worth surfacing; a missing marker only means paint could not
 * be proven here, and an `unconfirmed` render already skips checks rather than
 * scoring them, which is the honest outcome.
 */
interface PaintConfirmation {
  /** True when the per-token marker was found (or there was nothing to check). */
  painted: boolean;
  /**
   * The Expo dev menu was POSITIVELY OBSERVED on screen after the marker was
   * missed — i.e. the miss is explained by a modal occluder rather than by the
   * view failing to draw. Surfaced in the `unconfirmed` reason, because
   * "something covered the app" and "the app never painted" are different
   * problems with different fixes and must not read the same.
   */
  occludedByDevMenu: boolean;
}

async function paintConfirmed(
  driver: NativeDriver,
  token: string | undefined,
  timeoutMs: number,
  dismissDevMenu?: DevMenuDismisser,
): Promise<PaintConfirmation> {
  // No token (old companion that doesn't echo one) → nothing to query. Keep the
  // ack's word rather than inventing a downgrade for every legacy binary.
  if (!token) return { painted: true, occludedByDevMenu: false };
  const marker = `${DEFAULT_RENDER_MARKER}:${token}`;
  const wait = async (): Promise<boolean | 'error'> => {
    try {
      const res = await driver.waitForRef(marker, timeoutMs);
      return res.code === 0;
    } catch {
      // A driver/transport error is infra noise, not evidence the view is
      // blank — don't manufacture an `unconfirmed` out of it.
      return 'error';
    }
  };

  const first = await wait();
  if (first !== false) return { painted: true, occludedByDevMenu: false };

  // OCCLUSION RETRY. A miss has two very different causes that must not be
  // conflated: the view genuinely never painted, or something MODAL is sitting
  // on top of it. The Expo dev menu is the second kind and it is not rare — it
  // auto-opens on every React-context init until a human finishes
  // expo-dev-menu's onboarding, which on an installer-provisioned companion
  // never happens (see makeDevMenuDismisser). Being modal it takes the
  // accessibility tree with it, so the marker CANNOT be found underneath no
  // matter how long we wait.
  //
  // The retry is gated on POSITIVELY SEEING the menu, not on the dismissal
  // reporting success. That distinction is load-bearing: closing the dev menu
  // is an idempotent native state write that succeeds whether or not the menu
  // was up, so trusting its return value would re-run the full wait after
  // EVERY genuine miss and double the cost of every honest `unconfirmed`. One
  // snapshot is far cheaper than a second `timeoutMs`, and it is evidence
  // rather than inference — which is also what lets the reason line below claim
  // occlusion instead of guessing at it.
  if (!dismissDevMenu) return { painted: false, occludedByDevMenu: false };
  let sawDevMenu = false;
  try {
    sawDevMenu = snapshotShowsDevMenu(await driver.snapshot());
  } catch {
    sawDevMenu = false; // no snapshot → no evidence of occlusion → no retry
  }
  if (!sawDevMenu) return { painted: false, occludedByDevMenu: false };

  // Seen. Clear it and look exactly ONCE more — a menu that survives its own
  // dismissal is not one more wait away from being gone, and spinning here
  // would trade a bounded `unconfirmed` for an unbounded capture.
  try {
    await dismissDevMenu();
  } catch {
    /* best-effort: the retry below is what actually decides */
  }
  const second = await wait();
  return { painted: second !== false, occludedByDevMenu: second === false };
}

/**
 * The `unconfirmed` reason for a paint cross-check miss. Two distinct outcomes
 * get two distinct sentences on purpose — "the view never drew" sends you to
 * the component, "a dev menu was covering it" sends you to the companion build,
 * and a single generic line would send you to the wrong one.
 */
function paintMissReason(paint: PaintConfirmation): string {
  if (paint.occludedByDevMenu) {
    return (
      'the device acked this render, but the Expo dev menu was observed on screen and could ' +
      'not be cleared — the per-navigation marker can never be visible underneath a modal ' +
      'sheet, so this proves nothing about the render either way. That menu re-opens on every ' +
      "React-context init until expo-dev-menu's onboarding is finished (which never happens on " +
      'a companion nobody taps through), so a companion binary that predates the ' +
      "'dismiss-dev-menu' capability will hit this on every capture — rebuild the companion"
    );
  }
  return (
    'the device acked this render but its per-navigation marker never appeared on ' +
    'screen — the JS committed without the view painting, so nothing here is evidence'
  );
}

/** Run a device action whose absence must not fail the capture. Returns success. */
async function bestEffort(fn: () => Promise<ExecResult>): Promise<boolean> {
  try {
    const res = await fn();
    return res.code === 0;
  } catch {
    return false;
  }
}

/**
 * Authoritative render confirmation. Every open used to return unconditional
 * success — a timed-out ack or a never-painted marker silently degraded to
 * "settle and screenshot whatever is on screen", so the agent could score a
 * stale frame, a placeholder, or the dev launcher as evidence. Now every open
 * reports HOW (and whether) the render was confirmed, and the caller decides
 * what the screenshot is worth.
 */
export type NativeRenderState = 'confirmed' | 'unconfirmed' | 'failed';

export interface NativeRenderStatus {
  /**
   * - 'confirmed'   — the device positively confirmed THIS navigation painted:
   *                   a per-token bridge `rendered` ack, or the per-token
   *                   render marker (`validity-root:<token>`) appeared.
   * - 'unconfirmed' — every confirmation rung timed out and the flow fell back
   *                   to settle-and-return. The screen MAY show the right
   *                   content (slow paint) or may be stale/placeholder/launcher
   *                   — the screenshot must NOT be presented as confirmed
   *                   evidence.
   * - 'failed'      — the device acked `{ok:false}`: it looked the target up
   *                   and could not render it (not in its registry, empty
   *                   view). `error` carries the device's message verbatim.
   */
  status: NativeRenderState;
  /** Which mechanism produced the status. */
  via: 'bridge-ack' | 'marker' | 'settle';
  /** The navigation token the status correlates to (bridge or deep-link). */
  token?: string;
  /**
   * The device-reported error (status 'failed'), or the reason confirmation
   * never landed (status 'unconfirmed').
   */
  error?: string;
  /**
   * URLs the target fetched that no configured handler matched (the device's
   * permissive catch-all answered them), reported in the bridge `rendered` ack.
   * Surfaced in a native verify exactly like web's unmatched-fetch block.
   * Populated on the bridge-ack path and — for a companion that announces
   * {@link DEEP_LINK_ACK_CAPABILITY} — on the deep-link MARKER path too (the
   * device acks the tokenized deep link; see adoptDeviceAckForMarker). Absent
   * on old companions and on the settle fallback.
   */
  unmatchedUrls?: string[];
  /**
   * Matched requests (method/url/status) the device observed during this
   * render, from the companion's network-native matched log carried on the
   * bridge `rendered` ack. Fuels deterministic `expect.network` in native
   * verify. Confirmed-bridge-ack path only; absent on old companions (→ the
   * executor treats the network channel as unavailable → `unverifiable`).
   */
  matchedRequests?: NativeObservedRequest[];
  /**
   * console.error count the device observed during this render (companion
   * console channel, on the `rendered` ack). Fuels `expect.console`. `0` is a
   * real value (channel present, no errors); `undefined` = channel unavailable
   * (old companion) → `unverifiable`.
   */
  consoleErrorCount?: number;
  /**
   * On-device render timing the companion measured this render (companion perf
   * channel, on the `rendered` ack — see {@link NativePerf}). Fuels
   * `expect.performance` (`ready`/`mount`/`update`) and is surfaced
   * observationally in the report. A present object with a missing sub-field =
   * "that metric not measured here" (web parity → `unverifiable`); `undefined` =
   * no timing for this render → `unverifiable` with an explicit reason (see
   * {@link nativePerfUnavailableReason}).
   *
   * CARRIED ON BOTH CONFIRMED PATHS. Historically this was bridge-ack ONLY, so
   * any capture that fell to the deep-link marker rung (a bridge ack that timed
   * out — routine on Android under load) produced a CONFIRMED render with no
   * timing, and `expect.performance metric: mount` reported "rebuild the
   * companion" for roughly one criterion per sweep, rotating between specs. The
   * marker rung now adopts the device's deep-link ack (see
   * adoptDeviceAckForMarker), so a current companion measures every confirmed
   * render. The settle fallback still carries none — but a settle render is
   * `unconfirmed` and never scored.
   */
  perf?: NativePerf;
}

/**
 * Why an `expect.performance` metric has no measurement for THIS render —
 * `undefined` when timing is present (nothing to explain).
 *
 * Exists because one message ("native perf channel unavailable — rebuild the
 * companion") used to cover two very different states, and the wrong one was
 * far more common: a CURRENT companion whose render was confirmed off the
 * bridge-ack path, where the ack — the only carrier of timing — was never
 * asked for. Telling those apart is the difference between a user rebuilding a
 * companion that was already fine and a user seeing that their capture took
 * the fallback rung.
 */
export function nativePerfUnavailableReason(
  render: Pick<NativeRenderStatus, 'via' | 'perf'>,
  deviceCapabilities?: string[],
): string | undefined {
  if (render.perf) return undefined;
  const acksDeepLinks = (deviceCapabilities ?? []).includes(DEEP_LINK_ACK_CAPABILITY);
  if (render.via === 'bridge-ack') {
    return (
      'native perf channel unavailable — the device acked this render without a perf object ' +
      '(companion bundle predates the perf channel): rebuild the companion'
    );
  }
  const path =
    render.via === 'marker'
      ? 'the tokenized render marker (deep-link fallback — the bridge ack did not land)'
      : 'a settle fallback (nothing confirmed this render)';
  const hint = acksDeepLinks
    ? 'the companion acks deep links but no ack arrived for this token within the adopt budget'
    : 'this companion bundle does not ack deep links (see COMPANION_BUILD_REVISION) — rebuild it ' +
      'so fallback renders carry timing';
  return `native perf channel unavailable — this render was confirmed via ${path}, which carries no on-device timing: ${hint}`;
}

interface ColdOpenOptions {
  driver: NativeDriver;
  spec: TargetSpec;
  delay: (ms: number) => Promise<void>;
  /** Metro URL for the dev-client control link (defaults to the driver's). */
  metroUrl?: string;
  /** Skip the dev-client bundle preload (warm app already serving). */
  skipPreload?: boolean;
  /** UI ref/selector to wait for as proof the component rendered. */
  renderMarkerRef?: string;
  /** Max time to wait for the render marker before falling back to settle. */
  waitTimeoutMs?: number;
  /** Time to let the bundle load after the control link, on a cold open. */
  bundleWaitMs?: number;
  /**
   * Observable bundle readiness for COLD opens. The fixed `bundleWaitMs` sleep
   * (4s) undershoots a post---clear first bundle (routinely 30-90s), so every
   * confirmation rung downstream times out and the capture shows the dev
   * launcher. When provided, this is awaited INSTEAD of the fixed sleep after
   * the control link fires: it should resolve once Metro reports the bundle
   * served (e.g. `waitForBundleServed` tailing validity-native.log) with its
   * own generous cap. Its boolean is advisory — the render-confirmation
   * machinery still decides what the capture is worth. Injectable for tests;
   * absent → the legacy fixed sleep.
   */
  waitForBundle?: () => Promise<boolean>;
  /** Fallback settle time if the render marker never appears. Default 1200ms. */
  settleMs?: number;
  /** Max time to wait for the marker on the warm probe before cold-falling-back. */
  warmWaitMs?: number;
  /** Settle after a successful warm re-target (lets the new component paint). */
  warmSettleMs?: number;
  /**
   * How long to wait for the per-token render marker after a bridge `rendered`
   * ack before demoting the render to `unconfirmed` (see paintConfirmed).
   * Default {@link DEFAULT_PAINT_CONFIRM_MS}. Raise it for a component whose
   * VISIBLE paint genuinely lags its JS commit (async image decode, font swap).
   */
  paintConfirmMs?: number;
  /**
   * How long the deep-link (marker) rung waits for the device's ack for its
   * link token before giving up on this render's observation channels — see
   * {@link DEFAULT_MARKER_ACK_ADOPT_MS}. Injectable for tests; `0` disables the
   * wait without disabling the read of an ack the bridge already retained.
   */
  markerAckAdoptMs?: number;
  /**
   * The capture session already asserted `adb reverse` for THIS pinned device
   * (the long-lived MCP/CLI process tracks it per session). `adb reverse` only
   * has to be set up ONCE while the emulator stays attached, but coldOpen used
   * to re-spawn it (metro + bridge ports) on every call — pure per-call latency
   * on Android. When true, skip the two re-asserts here; a capture FAILURE
   * nukes the session cache, so a forward that genuinely dropped is re-asserted
   * on the retry. iOS sims share the host network (ensureAndroidReverse is a
   * no-op there), so this flag is Android-only in effect.
   */
  androidReverseAsserted?: boolean;
  /**
   * Host-side control bridge. When provided AND a device is connected, the
   * target is driven IN-PLACE over the WS (no deep link, no reload, no splash
   * re-present) and confirmed via a per-navigation `rendered` ack — the
   * structural fix for the stale-marker false positive. Absent (or no device
   * connected) → the deep-link warm/cold path below is used unchanged.
   */
  bridge?: NativeBridgeHandle;
  /**
   * Force a FRESH JS bundle. The recovery for a running app whose bundle is
   * provably stale (Metro was restarted for changed content) — warm re-targets
   * would render STALE code in that state. Preferred mechanism: a bridge-pushed
   * IN-PLACE `reload` (the device DevSettings-reloads, re-fetches the fresh
   * bundle, dials back, and is navigated with a per-token ack) — safe now that
   * the companion is built WITHOUT expo-splash-screen, so a reload can no
   * longer re-present an un-dismissable launch screen. The old terminate +
   * control-link cold-launch ladder (needs `bundleId` + a driver with
   * `terminateApp`) remains ONLY as the final fallback when no live bridge
   * session exists (cold boot) or the companion binary predates the 'reload'
   * capability.
   */
  forceReload?: boolean;
  /** App bundle id, required for `forceReload`'s terminate-ladder fallback. */
  bundleId?: string;
  /**
   * The contentHash of the freshly-PREPARED generated source (prepareNative's
   * result). Compared against the contentHash the connected companion baked
   * into its bundle (carried in its bridge `hello`): a mismatch means the
   * device is confidently running STALE code — its warm session is upgraded to
   * the forceReload path so the open serves the fresh bundle instead of
   * re-targeting old code. This closes the CLI stale-bundle hole structurally
   * (no caller has to remember to pass `reload`). Old companion bundles send
   * no hash → the check is skipped (conservative legacy behavior).
   */
  expectedContentHash?: string;
}

/**
 * True when the connected companion reports a bundle contentHash that differs
 * from the freshly-prepared one — i.e. the device is provably running stale
 * generated code and a warm re-target would render the old bundle. False when
 * either side has no hash (old companion / caller didn't pass one): the
 * comparison must degrade to "no signal", never a false positive. Exported as
 * the structured staleness signal; a positive routes the open through the
 * in-place bridge reload (terminate ladder as the final fallback).
 */
export function bridgeReportsStaleBundle(
  bridge: NativeBridgeHandle | undefined,
  expectedContentHash: string | undefined,
): boolean {
  if (!bridge || !expectedContentHash) return false;
  const running = bridge.deviceInfo()?.contentHash;
  return typeof running === 'string' && running !== expectedContentHash;
}

/**
 * Outcome of the bridge open. 'fallback' means "confirmation unknown — try the
 * deep-link path"; 'failed' is AUTHORITATIVE (the device acked `{ok:false}`)
 * and must NOT fall back: the deep link would render the exact same
 * placeholder, and the error would be lost. 'port-held' is likewise terminal:
 * the bridge port is occupied by a non-Validity process and delegation is
 * impossible — falling back to the deep-link ladder would silently degrade
 * (splash re-presents, stale-marker waits), so the caller throws
 * {@link BridgePortHeldError} instead.
 */
type BridgeOpenResult =
  | {
      kind: 'confirmed';
      token: string;
      unmatched?: string[];
      /** Matched requests (method/url/status) the device observed this render — fuels expect.network. */
      matched?: NativeObservedRequest[];
      /** console.error count the device observed this render — fuels expect.console. */
      consoleErrorCount?: number;
      /** On-device render timing the device measured this render — fuels expect.performance. */
      perf?: NativePerf;
      /**
       * Did this confirmed render require a COLD bundle load (a force-reload, a
       * control-link cold boot) vs a WARM in-place re-target? LOCAL ONLY — never
       * persisted on run-meta; consumed by the capture path to size the
       * snapshot-stability gate timeout (cold builds churn the a11y tree for
       * far longer than a warm re-target — see waitForSettledSnapshot).
       */
      cold: boolean;
    }
  | { kind: 'failed'; token: string; error: string; cold: boolean }
  | { kind: 'fallback' }
  | { kind: 'port-held'; detail: string };

/**
 * Push one navigate over the bridge and map the device's outcome onto the
 * shared {@link BridgeOpenResult} contract (used by the warm/cold bridge opens
 * AND the in-place reload path): a positive ack settles briefly so trailing
 * async paint lands, then confirms; a `{ok:false}` ack is AUTHORITATIVE
 * failure (the device error is surfaced verbatim, never swallowed); everything
 * else (no device, ack timeout) is "confirmation unknown — fall back".
 */
async function navigateForResult(
  opts: ColdOpenOptions,
  token: string,
  timeoutMs: number,
  cold: boolean,
): Promise<BridgeOpenResult> {
  const out = await opts.bridge!.navigate(bridgeMessageFor(opts.spec, token), timeoutMs);
  if (out.kind === 'port-held') return { kind: 'port-held', detail: out.detail };
  if (out.kind === 'ack' && out.result.ok) {
    await opts.delay(opts.warmSettleMs ?? DEFAULT_WARM_SETTLE_MS);
    // Carry the device-reported un-mocked URLs through so a native verify can
    // surface them like web's unmatched-fetch block — plus the matched-request
    // + console-error channels that fuel deterministic expect.network / expect.console.
    return {
      kind: 'confirmed',
      token,
      unmatched: out.result.unmatched,
      matched: out.result.matched,
      consoleErrorCount: out.result.consoleErrorCount,
      perf: out.result.perf,
      cold,
    };
  }
  // A `{ok:false}` ack is the device telling us the target CANNOT render
  // ("No component registered", empty view) — authoritative, so don't fall
  // through to the deep-link path (it would mount the same placeholder and
  // drop this error on the floor).
  if (out.kind === 'ack') {
    return {
      kind: 'failed',
      token,
      error: out.result.error ?? 'the device reported a failed render (no error detail)',
      cold,
    };
  }
  return { kind: 'fallback' }; // no device / ack timed out — confirmation unknown
}

/**
 * Refresh a stale warm session IN PLACE: push the bridge `reload` (the device
 * DevSettings-reloads and re-fetches the fresh bundle from Metro), gate on
 * bundle readiness, wait for the reloaded session to dial back, then navigate
 * it with a per-token ack. This replaces the terminate(1s) + control-link +
 * fixed-sleep ladder for every companion that announces the 'reload'
 * capability — that ladder existed only because an in-place reload used to
 * re-present the un-dismissable expo-splash-screen launch screen, and the
 * companion is now built without one. 'fallback' (no live session, an old
 * binary without the capability, or the reload never reconnected) routes the
 * caller to the terminate ladder, which stays as the FINAL fallback.
 */
async function reloadViaBridge(opts: ColdOpenOptions): Promise<BridgeOpenResult> {
  const bridge = opts.bridge;
  if (!bridge || !bridge.isConnected()) return { kind: 'fallback' };
  // Capability gate: only a bundle that declared 'reload' in its hello
  // understands the message — an old binary silently drops unknown types, so
  // pushing anyway would burn the whole bundle+reconnect budget before the
  // terminate ladder ran. ('delegated' handles also land here: they hold no
  // local socket, so the send below fails fast and the ladder takes over.)
  if (!(bridge.deviceInfo()?.capabilities ?? []).includes('reload')) {
    return { kind: 'fallback' };
  }
  // Epoch BEFORE the push: isConnected() stays true across the device-side
  // teardown, so only a connection NEWER than this proves the reloaded
  // session actually attached (see NativeBridgeHandle.waitForReconnect).
  const sinceEpoch = bridge.connectionEpoch();
  if (!bridge.send({ type: 'reload' })) return { kind: 'fallback' };
  // The reload re-fetches the bundle from Metro — gate on observed bundle
  // readiness (or the legacy fixed sleep) before waiting for the dial-back,
  // exactly like a cold boot: a post---clear first bundle takes 30-90s.
  await awaitBundleLoad(opts);
  const reconnected = await bridge.waitForReconnect(
    sinceEpoch,
    opts.waitTimeoutMs ?? DEFAULT_RENDER_WAIT_MS,
  );
  if (!reconnected) return { kind: 'fallback' };
  // Fresh session (a freshly-reloaded bundle): navigate with the COLD ack
  // budget (fonts/seeding settle) and stamp `cold` so the snapshot-stability
  // gate sizes its timeout to a real cold build.
  return navigateForResult(opts, mintToken(), opts.waitTimeoutMs ?? DEFAULT_RENDER_WAIT_MS, true);
}

/**
 * Drive the target IN-PLACE over the control bridge with per-token render
 * confirmation. 'confirmed' only when the device acks that the NEW target
 * actually painted; 'failed' when the device acks `{ok:false}` (its error is
 * surfaced verbatim, never swallowed); 'fallback' on a timeout/no-send means
 * "fall back to the deep-link path".
 *
 *   - WARM (device already connected): push `navigate`, await the `rendered`
 *     ack for that token, settle briefly so the paint lands, done. Never
 *     touches Linking, so the splash is never re-presented.
 *   - COLD (no device yet, preload allowed): boot the app with the dev-client
 *     control link (loads the bundle → the app mounts → connects back), wait
 *     for the connection, THEN push `navigate` and await the ack. The control
 *     link only loads the bundle; the bridge — not a deep link — selects the
 *     target, so the launcher can't intercept the route.
 */
async function openViaBridge(opts: ColdOpenOptions): Promise<BridgeOpenResult> {
  const bridge = opts.bridge;
  if (!bridge) return { kind: 'fallback' };

  // The bind/delegation probe settles within ms of startNativeBridge; a port
  // held by a NON-Validity process is terminal here (see BridgeOpenResult).
  // 'delegated' proceeds normally — navigate() hops through the owning bridge.
  if ((await bridge.whenReady()) === 'port-held') {
    return {
      kind: 'port-held',
      detail:
        `the native bridge port ${bridge.port} is held by a process that is not a Validity ` +
        `bridge, so the device cannot be driven (and a deep-link fallback would silently ` +
        `degrade). Free the port (lsof -ti tcp:${bridge.port}), then retry.`,
    };
  }

  // WARM: a device is already attached from a prior open — re-target in place.
  // (Skipped on forceReload: the in-place reload already had its chance and
  // the process was just killed; a lingering half-open WS must not route us to
  // a stale warm re-target.)
  if (!opts.forceReload && bridge.isConnected()) {
    const warm = await navigateForResult(
      opts,
      mintToken(),
      opts.warmWaitMs ?? DEFAULT_WARM_WAIT_MS,
      false,
    );
    if (warm.kind !== 'fallback') return warm;
  }

  // Caller pinned us warm-only (already-serving app) — don't boot/reload.
  if (opts.skipPreload) return { kind: 'fallback' };

  // COLD: boot the app via the control link so it connects back, then navigate.
  const control = await opts.driver.openControlLink(opts.metroUrl);
  if (control.code !== 0) return { kind: 'fallback' }; // let the deep-link path surface the error
  await awaitBundleLoad(opts);
  // The fresh launch parks on the dev launcher/menu until dismissed; clear it
  // so the JS bundle (and our WS connect) is actually running foreground.
  await dismissAll(opts.driver, makeDevMenuDismisser(opts.driver, opts.bridge));

  const connected = await bridge.waitForConnection(opts.warmWaitMs ?? DEFAULT_WARM_WAIT_MS);
  if (!connected) return { kind: 'fallback' };
  // The device is attached NOW, so the bridge rung is live for the first time
  // this cold boot. Clear the launch-time dev menu before the navigate rather
  // than discovering it as a missed paint confirmation afterwards: the menu
  // opens on React-context init (i.e. exactly the boot that just completed) and
  // the dismissal above could only reach the driver rung, which no-ops on
  // Android. Best-effort — a device with no dev menu answers false and nothing
  // downstream changes.
  await makeDevMenuDismisser(opts.driver, bridge)().catch(() => false);
  return navigateForResult(opts, mintToken(), opts.waitTimeoutMs ?? DEFAULT_RENDER_WAIT_MS, true);
}

/** Best-effort dismissals after a COLD boot: RN LogBox/RedBox overlay, the
 * Expo dev menu/launcher (ref-clicked — `dismiss-overlay` does NOT clear it),
 * and the iOS "Open in App?" confirmation alert. All no-op-safe. COLD rungs
 * ONLY: a fresh launch parks on the launcher/dev menu, so clearing it is
 * expected there. The WARM deep-link probe must never run this — warm, the
 * screen shows the rendered target, and a snapshot-driven dismissal (even
 * gated, see dismissDevMenu) is a screen interaction the evidence pipeline
 * has no business making right before the screenshot. */
async function dismissAll(driver: NativeDriver, dismissDevMenu: DevMenuDismisser): Promise<void> {
  await bestEffort(() => driver.dismissOverlay());
  // Bridge-first (the companion closes the menu on itself), driver-click as the
  // fallback — see makeDevMenuDismisser. On a genuinely cold boot no device is
  // attached yet, so this resolves through the driver rung; the companion's own
  // close-before-ack is what covers the launch-time menu once JS is running.
  await dismissDevMenu().catch(() => false);
  await bestEffort(() => driver.acceptAlert());
}

export interface ColdOpenResult {
  url: string;
  render: NativeRenderStatus;
  cold: boolean;
  /**
   * The per-token render marker this open waited on
   * (`validity-root:<linkToken>`), threaded out so the caller can record the
   * `.ad` destination guard against the SAME landmark the render was confirmed
   * by. Minted inside the ladder, so it can only come out this way.
   */
  marker?: string;
  /**
   * agent-device session readiness, observed ONCE at the top of the open (see
   * the SESSION READINESS GATE in {@link coldOpenLadder}). Absent when the
   * driver has no session to establish (test fakes, minimal drivers).
   * `ready:false` means every session-scoped command in this capture was
   * talking to nothing.
   */
  session?: NativeSessionReadiness;
}

/**
 * Ask the driver to guarantee its agent-device session, without letting the
 * guarantee become the failure. A driver that cannot do it (no `ensureSession`)
 * yields undefined, which every caller reads as "nothing to report".
 */
async function bestEffortSession(
  driver: NativeDriver,
  url: string,
): Promise<NativeSessionReadiness | undefined> {
  if (!driver.ensureSession) return undefined;
  try {
    return await driver.ensureSession(url);
  } catch {
    return undefined;
  }
}

/**
 * Run the session gate + the open ladder, threading the gate's answer out
 * alongside the render. The ladder itself is {@link coldOpenLadder}; this
 * wrapper exists only so the readiness does not have to be repeated on each of
 * the ladder's eight return points.
 */
async function coldOpen(opts: ColdOpenOptions): Promise<ColdOpenResult> {
  const sessionRef: { current?: NativeSessionReadiness } = {};
  const markerRef: { current?: string } = {};
  const out = await coldOpenLadder(opts, sessionRef, markerRef);
  return {
    ...out,
    ...(sessionRef.current ? { session: sessionRef.current } : {}),
    ...(markerRef.current ? { marker: markerRef.current } : {}),
  };
}

/**
 * Open policy shared by browse + capture. BRIDGE-FIRST (in-place re-target /
 * in-place reload), then WARM deep link, then a cold fallback:
 *
 *   0. (stale bundle) when the caller — or the device's own hello — proves the
 *      running bundle is stale, a live reload-capable companion is refreshed
 *      with a bridge-pushed in-place reload (see {@link reloadViaBridge}); the
 *      companion is built WITHOUT expo-splash-screen, so the reload cannot
 *      strand behind a re-presented launch screen. The terminate+cold-launch
 *      ladder survives ONLY as the final fallback for cold boots and old
 *      binaries (which still carry the splash module, where a mid-session
 *      reload re-presents a launch screen JS `hideAsync()` can't dismiss).
 *   1. (warm) open the validity deep link directly. If the companion is already
 *      foreground and serving the bundle, this re-targets via Linking
 *      (setTarget) WITHOUT reloading — cheap, and safe on every binary.
 *      (`openTarget` also opens the agent-device session that snapshot/wait
 *      need.)
 *   2. (cold fallback) if the marker never renders warm — fresh boot, or the dev
 *      client dropped its Metro connection — load the bundle via the control link
 *      and route again. A cold launch renders cleanly on old binaries too (the
 *      first hideAsync() of a launch always lands).
 *
 * Throws (with a helpful message) only if the cold-fallback bundle preload or
 * the route open fails — the dev-menu/alert/render steps degrade gracefully.
 * Every successful return carries a {@link NativeRenderStatus}: 'confirmed'
 * only on a positive per-token confirmation (bridge ack or tokenized marker),
 * 'failed' verbatim on a device `{ok:false}` ack, 'unconfirmed' on every
 * settle-and-return fall-through that used to masquerade as success.
 */
async function coldOpenLadder(
  opts: ColdOpenOptions,
  sessionRef: { current?: NativeSessionReadiness },
  markerRef: { current?: string } = {},
): Promise<{ url: string; render: NativeRenderStatus; cold: boolean }> {
  const { driver, spec, delay } = opts;
  // One dismisser for the whole open: bridge-first (the companion closes the
  // Expo dev menu on itself), driver ref-click as the fallback. Built once and
  // threaded into every rung that can be blocked by a modal dev menu — the
  // cold-boot hygiene sweep and the paint cross-check. See makeDevMenuDismisser
  // for why the menu is up in the first place and why BACK is not a rung.
  const devMenuDismisser = makeDevMenuDismisser(driver, opts.bridge);
  // Per-navigation token for the DEEP-LINK path: the harness echoes it as the
  // render-marker testID (`validity-root:<token>`), so the marker waits below
  // confirm THIS navigation painted — a previously-rendered component still
  // carries the OLD token (or none) and can no longer satisfy the wait, which
  // kills the documented shared-marker stale false positive. The bridge path
  // mints its own token per navigate (and confirms via the ack instead).
  const linkToken = mintToken();
  const linkSpec: TargetSpec = { ...spec, token: linkToken };
  const url = driver.targetUrl(linkSpec);
  // An explicit caller-supplied marker overrides the tokenized default (escape
  // hatch for custom harnesses that render their own marker).
  const marker = opts.renderMarkerRef ?? `${DEFAULT_RENDER_MARKER}:${linkToken}`;
  // Out-param rather than a return field: the ladder has eight return points
  // and the marker is the same on all of them, so threading it through each
  // would be eight chances to forget one. Mirrors `sessionRef` directly above.
  markerRef.current = marker;

  // STALE-BUNDLE GUARD: the connected companion's hello carries the
  // contentHash its bundle was generated from. If the caller told us what the
  // FRESH hash is and the device reports a different one, every warm shortcut
  // below would confidently render OLD code (the exact CLI "re-target after a
  // content Metro restart acks a stale bundle" bug) — so the open is upgraded
  // to the forceReload path. The bind/delegation probe is awaited first so a
  // delegated handle's device info (primed from the owning bridge's /status)
  // is populated. Old companions report no hash → no signal → no upgrade.
  if (opts.bridge) await opts.bridge.whenReady();
  // Give a just-attached companion its hello before reading deviceInfo() —
  // both the staleness comparison below and reloadViaBridge's capability gate
  // ride it, and the connection waiters resolve BEFORE the hello frame is
  // processed (see HELLO_WAIT_POLL_MS). Only when a caller opted into either
  // signal: legacy callers (no hash, no forceReload) never read the hello.
  if (opts.bridge && (opts.expectedContentHash || opts.forceReload)) {
    for (let i = 0; i < HELLO_WAIT_MAX_POLLS; i++) {
      if (!opts.bridge.isConnected() || opts.bridge.deviceInfo() !== null) break;
      await delay(HELLO_WAIT_POLL_MS);
    }
  }
  const staleBundle = bridgeReportsStaleBundle(opts.bridge, opts.expectedContentHash);
  const forceReload = Boolean(opts.forceReload) || staleBundle;

  // Android: forward the guest's tcp:8082 to the host's Metro so the dev-client
  // can fetch the bundle from the same `localhost:8082` control link iOS uses.
  // Best-effort + iOS no-op (see ensureAndroidReverse). Asserted BEFORE the
  // refresh paths below: the in-place reload's bundle re-fetch and post-reload
  // dial-back both ride these forwards. Skipped when the session already
  // asserted it for this device (once-per-session — see androidReverseAsserted).
  // Both forwards are `app-launch` purpose and stay ours on 0.20.5: the
  // dev-client fetches the bundle itself after launch, and the companion dials
  // the control bridge OUT of the guest — neither is the http(s) URL open whose
  // reachability agent-device now configures (see AndroidReversePurpose).
  if (!opts.androidReverseAsserted) {
    await ensureAndroidReverse(
      driver.platform,
      driver.device,
      undefined,
      COMPANION_REVERSE_PORT,
      'app-launch',
    );
    // Same for the control bridge port, so the companion's WS connect-back
    // reaches the host on Android via the same `localhost` contract iOS gets
    // for free.
    if (opts.bridge) {
      await ensureAndroidReverse(
        driver.platform,
        driver.device,
        undefined,
        COMPANION_BRIDGE_PORT,
        'app-launch',
      );
    }
  }

  // SESSION READINESS GATE — the agent-device session must exist BEFORE any of
  // the rungs below, because every one of them ends in session-scoped commands
  // (`wait` for the paint cross-check, `snapshot` for the settle gate and the
  // checks, `screenshot` for the evidence) and only `agent-device open`
  // establishes one.
  //
  // The bug this closes, measured on iOS 2026-07-29 with a COLD agent-device
  // daemon (`session list` empty) and the companion app still running from a
  // previous session: the control bridge is a WS to the COMPANION PROCESS, and
  // that process outlives the daemon. So `bridge.isConnected()` was true, the
  // bridge fast-path below acked a render, and `coldOpen` returned WITHOUT ever
  // reaching `openControlLink`/`openTarget` — the only calls that open a
  // session. Every command after it answered SESSION_NOT_FOUND, `screenshot`
  // threw, and seven consecutive specs reported ENVIRONMENT BLOCKED with
  // `cause: unknown` over 3m18s. The first `open` finally fired at T+3m40s,
  // when a cold rung was eventually taken, and every later spec worked.
  //
  // Placement is deliberate: ABOVE the in-place reload path too, which has the
  // same hole (it confirms over the bridge and returns). ensureSession is a
  // no-op once this process has established the session, so the cost is one
  // bounded `open` at the FIRST capture of a run and nothing thereafter —
  // exactly the "prove it before the first spec" guarantee, without a per-spec
  // re-open. A driver without the capability (test fakes, minimal drivers)
  // reports nothing and the behavior is unchanged.
  //
  // NEVER fatal. A gate that hard-failed here would convert a recoverable
  // environment into a red build; instead the readiness is returned so the
  // capture can attach a NAMED cause (`no-native-session`) to whatever honest
  // degrade follows.
  sessionRef.current = await bestEffortSession(driver, url);

  // FRESH BUNDLE, IN PLACE (preferred): the caller knows the running bundle is
  // stale (Metro was restarted for content, or the agent asked for a reload) —
  // or the stale-bundle guard above proved it from the device's own hello.
  // With a live, reload-capable companion the refresh is a bridge-pushed
  // DevSettings reload + reconnect + acked navigate — no terminate, no
  // control link, no fixed-sleep ladder. A `{ok:false}` ack and port-held are
  // terminal exactly like the normal bridge open; only 'fallback' (no live
  // session, old binary, reload never reconnected) drops to the ladder below.
  if (forceReload && opts.bridge) {
    const viaReload = await reloadViaBridge(opts);
    if (viaReload.kind === 'confirmed') {
      // The ack proves JS committed, not that the view painted — see
      // paintConfirmed. Ask the device for the per-token marker before calling
      // this evidence.
      const paint = await paintConfirmed(
        driver,
        viaReload.token,
        opts.paintConfirmMs ?? DEFAULT_PAINT_CONFIRM_MS,
        devMenuDismisser,
      );
      return {
        url,
        render: {
          status: paint.painted ? 'confirmed' : 'unconfirmed',
          via: 'bridge-ack',
          token: viaReload.token,
          ...(paint.painted ? {} : { error: paintMissReason(paint) }),
          unmatchedUrls: viaReload.unmatched,
          matchedRequests: viaReload.matched,
          consoleErrorCount: viaReload.consoleErrorCount,
          perf: viaReload.perf,
        },
        cold: true,
      };
    }
    if (viaReload.kind === 'failed') {
      return {
        url,
        render: {
          status: 'failed',
          via: 'bridge-ack',
          token: viaReload.token,
          error: viaReload.error,
        },
        cold: true,
      };
    }
    if (viaReload.kind === 'port-held') {
      throw new BridgePortHeldError(viaReload.detail);
    }
  }

  // FORCED RELOAD, FINAL FALLBACK ladder: the in-place reload wasn't possible
  // (no live bridge session — a cold boot — or a companion binary that
  // predates the 'reload' capability) or it never reconnected. Kill the
  // process FIRST so everything below is a genuine cold launch — the bridge
  // connection drops with the process, so the warm shortcuts won't fire, and
  // the control-link boot serves the fresh bundle.
  if (forceReload && opts.bundleId && driver.terminateApp) {
    await bestEffort(() => driver.terminateApp!(opts.bundleId!));
    // Let the process die and its bridge WS close so isConnected() goes false.
    await delay(1000);
  }

  // WARM SESSION: a device is already attached to the bridge from a prior open.
  // Any re-target must stay warm — even if the bridge ack or the deep-link probe
  // times out, we must NOT fall through to the COLD control-link reload: the
  // session isn't stale (the guard above would have upgraded it), so a cold
  // reload would only burn 15s+ of ladder re-serving the same bundle. So in a
  // warm session we treat the open as preload-skipped throughout. Genuine cold
  // opens (no device connected) are unaffected and still preload the bundle.
  //
  // forceReload OVERRIDES a caller-supplied skipPreload pin: the caller pinned
  // warm because a device was connected, but a forced refresh that reached the
  // terminate ladder above made the session cold BY CONSTRUCTION — honoring
  // the pin would strand the relaunch without a bundle preload (deep link into
  // a dead app, settle, unconfirmed) instead of recovering via the control link.
  const warmSession = !forceReload && opts.bridge?.isConnected() === true;
  const skipPreload = (!forceReload && opts.skipPreload) || warmSession;

  // Stale-overlay hygiene: a PREVIOUS run's LogBox/RedBox would otherwise ride
  // into THIS run's screenshot (checks can pass off the a11y tree while the
  // image still shows the old redbox — false-clean evidence). `react-native
  // dismiss-overlay` clears ONLY the RN LogBox/RedBox; it is screen-safe on a
  // warm, rendered app — unlike the snapshot-driven dev-menu dismissal that
  // earned the warm rungs their no-dismissals rule (it used to click the
  // component's own 'Close'/'Continue' buttons; see dismissAll). Best-effort:
  // the cold rung below still runs the full dismissAll.
  await bestEffort(() => driver.dismissOverlay());

  // 0. BRIDGE FAST-PATH (preferred): drive the active view in-place with a
  //    per-navigation render ack. Eliminates the stale-marker false positive
  //    and never reloads the bundle. A `{ok:false}` ack is FINAL — the
  //    device error is surfaced, not retried via deep link; only an ack
  //    timeout falls through to the deep-link path below. In a warm session
  //    skipPreload is forced on so a missed ack re-targets via the warm
  //    deep-link probe rather than a pointless (and on old binaries
  //    splash-re-presenting) cold reload of the same fresh bundle.
  if (opts.bridge) {
    const viaBridge = await openViaBridge({ ...opts, skipPreload, forceReload });
    if (viaBridge.kind === 'confirmed') {
      // Same paint cross-check as the reload path above.
      const paint = await paintConfirmed(
        driver,
        viaBridge.token,
        opts.paintConfirmMs ?? DEFAULT_PAINT_CONFIRM_MS,
        devMenuDismisser,
      );
      return {
        url,
        render: {
          status: paint.painted ? 'confirmed' : 'unconfirmed',
          via: 'bridge-ack',
          token: viaBridge.token,
          ...(paint.painted ? {} : { error: paintMissReason(paint) }),
          unmatchedUrls: viaBridge.unmatched,
          matchedRequests: viaBridge.matched,
          consoleErrorCount: viaBridge.consoleErrorCount,
          perf: viaBridge.perf,
        },
        cold: viaBridge.cold,
      };
    }
    if (viaBridge.kind === 'failed') {
      return {
        url,
        render: {
          status: 'failed',
          via: 'bridge-ack',
          token: viaBridge.token,
          error: viaBridge.error,
        },
        cold: viaBridge.cold,
      };
    }
    // The port is held by a non-Validity process and delegation is impossible —
    // a deep-link "fallback" here would be the exact silent degrade this error
    // exists to prevent (splash re-present + stale-marker waits). Machine-
    // readable so the MCP/CLI caller can surface BRIDGE_PORT_HELD verbatim.
    if (viaBridge.kind === 'port-held') {
      throw new BridgePortHeldError(viaBridge.detail);
    }
  }

  // 1. WARM probe — deep link only, no reload. `skipPreload` forces this path.
  //    NO dismissals here: warm, the screen already shows rendered user UI, and
  //    the snapshot-driven dev-menu dismissal used to click the component's own
  //    'Close'/'Continue' button before the screenshot (see dismissAll). A warm
  //    app has no launcher to clear; if it's actually cold the marker wait
  //    fails and the cold rung below (which DOES dismiss) recovers.
  const warmOpen = await driver.openTarget(linkSpec);
  if (warmOpen.code === 0) {
    const warmRendered = await bestEffort(() =>
      driver.waitForRef(marker, opts.warmWaitMs ?? DEFAULT_WARM_WAIT_MS),
    );
    if (warmRendered) {
      // Per-token marker matched — THIS navigation painted. Settle briefly so
      // any trailing layout/async paint lands before the screenshot.
      await delay(opts.warmSettleMs ?? DEFAULT_WARM_SETTLE_MS);
      // The marker proved the paint; the ack (if this companion sends one for a
      // deep link) carries what the device MEASURED while painting it. Without
      // this, every capture that reached this rung silently lost perf/network/
      // console — see adoptDeviceAckForMarker.
      const ack = await adoptDeviceAckForMarker(opts, linkToken);
      return {
        url,
        render: {
          status: 'confirmed',
          via: 'marker',
          token: linkToken,
          unmatchedUrls: ack?.unmatched,
          matchedRequests: ack?.matched,
          consoleErrorCount: ack?.consoleErrorCount,
          perf: ack?.perf,
        },
        cold: false,
      };
    }
  }
  // DEV-LAUNCHER RUNG. Everything above assumed the companion is running OUR
  // bundle and only needs re-targeting. When it is parked on expo-dev-launcher's
  // HOME screen that assumption is false in a way no amount of deep-linking can
  // fix: the dev-client process is up but its React root is the launcher's own
  // server picker, so a `validity://` intent starts MainActivity and the app
  // immediately redirects itself back to DevLauncherActivity. Only the
  // dev-client CONTROL link tells it which bundle to load — i.e. the COLD rung
  // below is the remedy, and `skipPreload` is precisely what makes it
  // unreachable.
  //
  // That is not hypothetical: measured on an API 35 emulator 2026-07-29, the
  // bridge kept reporting `isConnected()` for a companion process that had just
  // been killed (the WS rides the `adb reverse` tunnel, which outlives the
  // peer), so `warmSession` pinned `skipPreload` and every Android capture
  // settled on the launcher and reported `unconfirmed`. See dev-launcher.ts for
  // the logcat trace.
  //
  // Probed, not assumed — the whole point is to distinguish "warm app, target
  // didn't paint" from "no bundle loaded at all", and only the second may pay
  // for a cold reload. A genuinely warm session answers false here (its
  // foreground activity is MainActivity) and its behavior is byte-identical to
  // before. Costs one adb call, and only on a path that was already giving up.
  const onLauncher = await deviceOnDevLauncherHome(driver);

  // Caller pinned us warm-only, OR this is a warm bridge session: don't reload
  // (the bundle isn't stale — the guard upgraded it if it were — and on old
  // binaries a reload would re-present the un-dismissable splash). Settle on
  // the in-place re-target and return — reported UNCONFIRMED, because nothing
  // proved the new target painted; the screen may still show the previous one.
  if (skipPreload && !onLauncher) {
    // No paint signal exists on this path, so the wait cannot be shortened by
    // one — but it can stop being blind: `wait stable` returns when the tree
    // stops moving and otherwise spends the same budget (see settleUnconfirmed).
    // The status below stays `unconfirmed` regardless.
    await settleUnconfirmed(driver, { budgetMs: opts.settleMs ?? 1200, delay });
    return {
      url,
      render: {
        status: 'unconfirmed',
        via: 'settle',
        token: linkToken,
        error:
          `warm re-target was never confirmed: no bridge ack, and render marker "${marker}" did not ` +
          `appear within ${opts.warmWaitMs ?? DEFAULT_WARM_WAIT_MS}ms — the screen may still show the previous target`,
      },
      cold: false,
    };
  }

  // 2. COLD fallback — the bundle isn't loaded; load it via the control link.
  const control = await driver.openControlLink(opts.metroUrl);
  if (control.code !== 0) {
    throw new Error(
      `Failed to load the dev-client bundle via the control link on the ${driver.platform} device ` +
        `(exit ${control.code}). Is a simulator/emulator booted and the Validity companion dev build installed? ` +
        `${control.stderr.trim()}`,
    );
  }
  await awaitBundleLoad(opts);

  const open = await driver.openTarget(linkSpec);
  if (open.code !== 0) {
    throw new Error(
      `Failed to open ${url} on the ${driver.platform} device (exit ${open.code}). ` +
        'Is a simulator/emulator booted and the Validity companion dev build installed? ' +
        `${open.stderr.trim()}`,
    );
  }

  await dismissAll(driver, devMenuDismisser);

  const rendered = await bestEffort(() =>
    driver.waitForRef(marker, opts.waitTimeoutMs ?? DEFAULT_RENDER_WAIT_MS),
  );
  if (rendered) {
    // Same ack adoption as the warm marker rung above: a cold deep-link render
    // is still a render the device measured.
    const ack = await adoptDeviceAckForMarker(opts, linkToken);
    return {
      url,
      render: {
        status: 'confirmed',
        via: 'marker',
        token: linkToken,
        unmatchedUrls: ack?.unmatched,
        matchedRequests: ack?.matched,
        consoleErrorCount: ack?.consoleErrorCount,
        perf: ack?.perf,
      },
      cold: true,
    };
  }
  // The marker never painted after a genuine cold boot — usually the first
  // bundle is still compiling (often 30s+ after a --clear restart, far past
  // this wait budget). Settle and return, but report it UNCONFIRMED so the
  // caller never scores a launcher/splash screenshot as evidence. Same
  // wait-stable-backed settle as the warm path above — a wait, never a verdict.
  await settleUnconfirmed(driver, { budgetMs: opts.settleMs ?? 1200, delay });
  // "may still be compiling" and "stuck on the launcher" are different problems
  // with different fixes, and until now they shared one sentence. Ask the device
  // which it is: the control link has already been delivered, so a launcher
  // STILL on screen means the dev-client would not load the bundle — that points
  // at Metro reachability (`adb reverse`) or a companion/Metro mismatch, not at
  // a slow build.
  let stillOnLauncher = await deviceOnDevLauncherHome(driver);
  if (stillOnLauncher) {
    // LAST RUNG: tap our server row on the picker, the way a human un-wedges
    // this (observed 2026-07-30 after an emulator reboot — upstream task #24:
    // the launcher swallows the deep link, and re-delivering it changes
    // nothing). The row is matched STRICTLY to the companion port on a
    // loopback host (see devServerRowRef), one attempt, every step guarded —
    // a recovery that cannot work must cost one click and fall through to the
    // honest unconfirmed report below.
    const recovered = await (async (): Promise<boolean> => {
      try {
        const snap = await driver.snapshot();
        const row = devServerRowRef(snap, opts.metroUrl ?? DEFAULT_METRO_URL);
        if (!row) return false;
        if ((await driver.click(row)).code !== 0) return false;
        await awaitBundleLoad(opts);
        await dismissAll(driver, devMenuDismisser);
        // The tap loaded the BUNDLE, not our target — the deep link the launcher
        // swallowed is gone, so deliver it again now that there is JS to receive it.
        if ((await driver.openTarget(linkSpec)).code !== 0) return false;
        await dismissAll(driver, devMenuDismisser);
        return await bestEffort(() =>
          driver.waitForRef(marker, opts.waitTimeoutMs ?? DEFAULT_RENDER_WAIT_MS),
        );
      } catch {
        return false;
      }
    })();
    if (recovered) {
      console.warn(
        '[validity] the expo-dev-launcher server picker was covering the app — tapped the ' +
          'companion server row to load the bundle (the deep link had been swallowed; upstream task #24)',
      );
      const ack = await adoptDeviceAckForMarker(opts, linkToken);
      return {
        url,
        render: {
          status: 'confirmed',
          via: 'marker',
          token: linkToken,
          unmatchedUrls: ack?.unmatched,
          matchedRequests: ack?.matched,
          consoleErrorCount: ack?.consoleErrorCount,
          perf: ack?.perf,
        },
        cold: true,
      };
    }
    stillOnLauncher = await deviceOnDevLauncherHome(driver);
  }
  return {
    url,
    render: {
      status: 'unconfirmed',
      via: 'settle',
      token: linkToken,
      error: stillOnLauncher
        ? `cold open was never confirmed: the companion is STILL on the expo-dev-launcher home ` +
          `screen after the dev-client control link was delivered, so no bundle is loaded and ` +
          `render marker "${marker}" can never appear. The launcher could not fetch the bundle ` +
          `from Metro — check that Metro is serving (validity browse --native) and, on Android, ` +
          `that \`adb reverse tcp:8082 tcp:8082\` is in place.`
        : `cold open was never confirmed: render marker "${marker}" did not appear within ` +
          `${opts.waitTimeoutMs ?? DEFAULT_RENDER_WAIT_MS}ms — the bundle may still be compiling. ` +
          `If this is the first run after an install, the first bundle build can outlast this ` +
          `wait — re-run once; the second run opens against a warm cache`,
    },
    cold: true,
  };
}

/**
 * Phase timings (ms) for one capture/browse, so a slowdown regression is
 * VISIBLE instead of folding into one opaque round-trip number. Cheap
 * instrumentation (wall-clock around each phase); surfaced in the MCP/CLI
 * result's debug field, never used for control flow.
 */
export interface NativeTiming {
  /** coldOpen → render confirmed: the navigate/deep-link + ack/marker wait. */
  openMs: number;
  /** driver.screenshot (captureNative only; browse never screenshots). */
  screenshotMs?: number;
  /** driver.snapshot (captureNative only). */
  snapshotMs?: number;
}

export interface NativeCaptureResult {
  target: TargetSpec;
  /** The deep-link URL that was opened. */
  url: string;
  /** Path the screenshot was written to. */
  screenshotPath: string;
  /** Raw accessibility snapshot (agent-device `snapshot -i` output). */
  a11ySnapshot: string;
  /**
   * Authoritative render confirmation. On 'failed'/'unconfirmed' the
   * screenshot still exists ON DISK (it shows whatever is on screen — useful
   * for debugging) but it is NOT evidence of the requested target; callers
   * must surface the status instead of presenting the image as success.
   */
  render: NativeRenderStatus;
  /** Per-phase timing breakdown (see NativeTiming). */
  timing: NativeTiming;
  /**
   * Mechanical hard/property verdicts from executing `criteriaChecks` on the
   * device (after a CONFIRMED render, before the screenshot). Present only when
   * `criteriaChecks` was supplied AND the render confirmed; soft criteria are
   * never here (LLM-scored). Rolled up into run-meta's `criterionVerdicts`.
   */
  criterionVerdicts?: CriterionVerdict[];
  /**
   * Present only when INTERACTIVE checks (click/fill) ran: the pristine
   * pre-interaction state, captured before the check loop mutated the screen.
   * The evidence screenshot (`screenshotPath`) deliberately stays the
   * post-interaction end state (web-verify parity, baseline identity); this
   * companion shot exists so soft criteria about the INITIAL state can be
   * scored against what the user first sees, not the post-click residue.
   */
  preInteractionScreenshotPath?: string;
  /**
   * Device-side runtime evidence captured AFTER the interaction phase, when
   * `captureDeviceEvidence` asked for it (see {@link NativeDeviceEvidence}).
   * Capture-only: nothing scores it, and its absence is never a verdict.
   */
  deviceEvidence?: NativeDeviceEvidence;
  /**
   * Best-effort explanation for a render that did NOT confirm — the cause
   * behind "no mechanical verdict produced for this criterion" (a phantom
   * device claim, a dead daemon, a hand-started Metro on the companion port, a
   * decayed session, or the component itself). Purely additive metadata:
   * verdict semantics are untouched, and an absent diagnosis means the probes
   * could not tell, never that the environment is fine. Only populated when
   * `projectRoot` was supplied and the render was not confirmed.
   */
  diagnosis?: EnvironmentDiagnosis;
  /**
   * The `.ad` replay recording this capture published, when it published one.
   *
   * Present only on the capture that ESTABLISHED the agent-device session and
   * whose render confirmed — upstream permits one recorded open per session, so
   * a sweep's later captures legitimately have nothing here (see
   * replay-recording.ts). Absent also means "recording is off" or "the guard
   * did not resolve"; it is never a failure, only the absence of an extra
   * artifact. The caller signs it into the run's attestation.
   */
  recordingPath?: string;
}

/**
 * Device-side runtime evidence, captured after the interaction phase —
 * `agent-device perf metrics|frames --json` and `network dump --json`.
 *
 * CAPTURE-ONLY, and the framing matters: 0.20.5 made this evidence STRUCTURED
 * (the June "profiling is prose-only" conclusion is obsolete at the capture
 * layer), but no threshold exists to score it against yet — that needs an
 * N-run variance study, not a guess. So this rides along as provenance and
 * changes no verdict.
 *
 * Each record is a provenance-labelled `DeviceEvidence` (perf-evidence.ts):
 * `status: 'unavailable'` + reason on any refusal — absence never reads as a
 * healthy measurement.
 */
export interface NativeDeviceEvidence {
  /** `perf metrics --json` + `perf frames --json` records. */
  perf?: { metrics: DeviceEvidence; frames: DeviceEvidence };
  /** `network dump --json` record (default projection only — never headers). */
  network?: DeviceEvidence;
  /** Why nothing was captured, when the attempt was made and produced nothing. */
  unavailableReason?: string;
}

/**
 * Collect device-side evidence through the driver's own session (see
 * `NativeDriver.runInSession`, which carries the platform env, cwd, remote
 * profile and host timeout the capture used).
 *
 * The runner is the driver's `runInSession`, so records attach to the session
 * this capture drove (same bin/env/cwd/remote profile) — the collectors' own
 * `env`/`cwd` hints are advisory there; the session's context wins, which is
 * the point.
 *
 * Never throws: evidence collection cannot fail a capture (the collectors
 * classify their own failures into `status: 'unavailable'` records).
 */
async function collectDeviceEvidence(
  driver: NativeDriver,
  opts?: { cwd?: string },
): Promise<NativeDeviceEvidence> {
  const inSession = driver.runInSession?.bind(driver);
  if (!inSession) {
    return {
      unavailableReason:
        'driver does not expose runInSession — session-scoped evidence unavailable',
    };
  }
  const run: CommandRunner = (_bin, args, o) => inSession(args, o);
  const base = {
    run,
    platform: driver.platform,
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
  };
  const perf = await collectPerfEvidence(base);
  const network = await collectNetworkEvidence(base);
  return { perf, network };
}

export interface CaptureNativeOptions {
  driver: NativeDriver;
  spec: TargetSpec;
  /** Where to write the screenshot. */
  screenshotPath: string;
  /**
   * Capture device-side runtime evidence (perf frames/memory, HTTP traffic)
   * after the interaction phase — see {@link NativeDeviceEvidence}.
   *
   * DEFAULT OFF: it costs two extra agent-device spawns per capture, and a
   * `verify --all` sweep pays that per spec. It is evidence a developer opts
   * into for one investigation, not a tax on every run.
   */
  captureDeviceEvidence?: boolean;
  /**
   * Resolved scenario secrets (`scenarios[].secrets` whose env vars are set),
   * threaded to the check executor for secret-safe fills — a `${NAME}`
   * placeholder fills the secret's live value while the armed `.ad` records
   * `${NAME}`; an unresolvable placeholder blocks the fill (unverifiable).
   */
  secrets?: ReadonlyArray<ResolvedSecret>;
  /**
   * Project root. Supplying it turns on the per-capture diagnostics: one JSONL
   * row per capture in `.validity/runs/native-session-metrics.jsonl` (the
   * evidence base for spotting session decay while it happens), and, when a
   * render does not confirm, an environment {@link EnvironmentDiagnosis}.
   * Both are best-effort and cannot fail a capture. Omit to keep a capture
   * completely side-effect-free (tests, ad-hoc drivers).
   */
  projectRoot?: string;
  /** Spec id recorded on the metrics row, so decay can be traced to a sweep. */
  specId?: string;
  /** AVD name, quoted verbatim in the session-reset fix command when known. */
  avdName?: string;
  /**
   * Injectable diagnosis (tests pass a stub). Production uses
   * {@link diagnoseNativeEnvironment}, which shells out to read device/daemon
   * state — a unit test must never do that.
   */
  diagnose?: typeof diagnoseNativeEnvironment;
  /** Settle time used as the render-wait fallback. Default 1200ms. */
  settleMs?: number;
  /** Injectable delay (tests pass a no-op). */
  delay?: (ms: number) => Promise<void>;
  /** Metro URL for the dev-client control link (defaults to the driver's). */
  metroUrl?: string;
  /** Skip the dev-client bundle preload (warm app already serving the bundle). */
  skipPreload?: boolean;
  /** UI ref/selector to wait for as proof the component rendered. Default: the per-navigation `validity-root:<token>` marker. */
  renderMarkerRef?: string;
  /** Max time to wait for the render marker before falling back to settle. */
  waitTimeoutMs?: number;
  /** Time to let the bundle load after the control link, on a cold open. */
  bundleWaitMs?: number;
  /** Observable bundle readiness for cold opens (see ColdOpenOptions.waitForBundle). */
  waitForBundle?: () => Promise<boolean>;
  /**
   * Settle after a CONFIRMED warm re-target. Default 200ms — the ack/marker
   * already proves paint. ESCAPE HATCH for slow-paint components (async
   * images, custom fonts, deferred effects): raise it so the trailing paint
   * lands before the screenshot. Confirmed path only (see DEFAULT_WARM_SETTLE_MS).
   */
  warmSettleMs?: number;
  paintConfirmMs?: number;
  /** The session already asserted `adb reverse` for this device (see ColdOpenOptions.androidReverseAsserted). */
  androidReverseAsserted?: boolean;
  /** Host-side control bridge for in-place re-targeting (see ColdOpenOptions.bridge). */
  bridge?: NativeBridgeHandle;
  /** Force a fresh JS bundle: in-place bridge reload, terminate-ladder final fallback (see ColdOpenOptions.forceReload). */
  forceReload?: boolean;
  /** App bundle id, required for `forceReload`'s terminate-ladder fallback. */
  bundleId?: string;
  /** Freshly-prepared contentHash for the stale-bundle guard (see ColdOpenOptions.expectedContentHash). */
  expectedContentHash?: string;
  /**
   * Spec hard/property criteria to execute DETERMINISTICALLY on the device,
   * after the render is CONFIRMED and BEFORE the screenshot (so the shot
   * captures the post-interaction end state, like the web verify order). Each
   * criterion's verdict lands in `NativeCaptureResult.criterionVerdicts`, run
   * via the native check-executor (parse a11y snapshot → click/inputText/assert
   * through the agent-device driver). Skipped unless the render confirmed.
   */
  criteriaChecks?: SpecCriterion[];
  /**
   * Snapshot-stability gate timeout for a COLD open (ms). After the render is
   * confirmed and BEFORE the check loop + evidence screenshot, the capture holds
   * for two consecutive a11y snapshots to agree AND show no dev-client loading
   * marker — the structural fix for the cold-start evidence race (the `rendered`
   * ack fires before the "Refreshing…" overlay clears, so a check read — or a
   * screenshot taken — in that window is corrupt; see waitForSettledSnapshot).
   * Sized to a real Metro cold build. Default {@link DEFAULT_SETTLE_GATE_COLD_MS}
   * (10000). Consulted on every CONFIRMED render (checks optional).
   */
  settleGateColdMs?: number;
  /**
   * Snapshot-stability gate timeout for a WARM re-target (ms). A warm app
   * settles fast, so this is far shorter than the cold budget. Default
   * {@link DEFAULT_SETTLE_GATE_WARM_MS} (2500). See `settleGateColdMs`.
   */
  settleGateWarmMs?: number;
  /**
   * Polling interval for the snapshot-stability gate (ms). On a stable tree
   * the gate costs ONE interval (snapshot A → wait → snapshot B → settle).
   * Default {@link DEFAULT_SETTLE_GATE_INTERVAL_MS} (400).
   */
  settleGateIntervalMs?: number;
}

/**
 * Cold-open the target (load bundle → route → dismiss dev overlay/alert →
 * wait for render), then screenshot + snapshot. Throws with a clear message if
 * the bundle preload or the deep-link open fails (usual cause: no booted
 * simulator/emulator, or the companion dev build isn't installed).
 */
export async function captureNative(opts: CaptureNativeOptions): Promise<NativeCaptureResult> {
  const { driver, spec, screenshotPath } = opts;
  const delay = opts.delay ?? sleep;

  const openStart = Date.now();
  const { url, render, cold, session, marker } = await coldOpen({
    driver,
    spec,
    delay,
    metroUrl: opts.metroUrl,
    skipPreload: opts.skipPreload,
    renderMarkerRef: opts.renderMarkerRef,
    waitTimeoutMs: opts.waitTimeoutMs,
    bundleWaitMs: opts.bundleWaitMs,
    waitForBundle: opts.waitForBundle,
    settleMs: opts.settleMs,
    warmSettleMs: opts.warmSettleMs,
    paintConfirmMs: opts.paintConfirmMs,
    androidReverseAsserted: opts.androidReverseAsserted,
    bridge: opts.bridge,
    forceReload: opts.forceReload,
    bundleId: opts.bundleId,
    expectedContentHash: opts.expectedContentHash,
  });
  const openMs = Date.now() - openStart;

  // SNAPSHOT-STABILITY GATE — the structural fix for the cold-start evidence
  // race (Bug 6). The companion's `rendered` ack fires after its
  // mountAnimationFrame — proof the COMPONENT view mounted — but a COLD bundle
  // build keeps the expo-dev-client's "Refreshing…" overlay on top of that view
  // for seconds afterward. A `heading-visible` presence check read in that
  // window resolved against the loading screen (presence:false) while the SAME
  // response's later final a11y snapshot already contained the heading; a warm
  // re-run then passed. The check executor's own resolve loop is far too short
  // (~1.25s) to outrun a cold build, so the gate holds everything downstream at
  // the CAPTURE level, before any evidence is read off a still-loading tree.
  //
  // Gated on the RENDER being confirmed, NOT on criteriaChecks — because a
  // raced loading overlay corrupts BOTH kinds of scored evidence, and the check
  // loop is only one of them: the pre-interaction + evidence SCREENSHOTS are the
  // primary evidence the soft-criteria judge/agent scores, and the native verify
  // path leaves plenty of renders check-free — a base-render target binds its
  // checks to base renders only, and native_browse never passes any — while
  // every one of those still produces a scored screenshot (see server.ts:
  // `isCheckTarget ? … : undefined`).
  // Gating only when checks are present would leave all those screenshots exposed
  // to the exact overlay this fixes. An UNCONFIRMED render is deliberately NOT
  // gated: it never settles to the real UI (it IS the launcher/splash/compiling
  // screen), so waiting would only burn the whole timeout, and its diagnostic
  // screenshot WANTS the actual on-screen failure state. Cost on a warm/stable
  // tree is ONE interval (the cheap case); the full timeout is only ever spent
  // on a genuinely never-settling tree (e.g. a live-animating element), where
  // the warning below is exactly the signal you want. Never hard-fails the
  // capture: on timeout it proceeds and SURFACES the race so a false verdict can
  // be traced back to it.
  // Whether the tree ever settled. Read by the check loop below: a criterion
  // that FAILS against a tree which never settled is not evidence of anything.
  let treeSettled = true;
  if (render.status === 'confirmed') {
    const outcome = await waitForSettledSnapshot(driver, {
      timeoutMs: cold
        ? (opts.settleGateColdMs ?? DEFAULT_SETTLE_GATE_COLD_MS)
        : (opts.settleGateWarmMs ?? DEFAULT_SETTLE_GATE_WARM_MS),
      intervalMs: opts.settleGateIntervalMs ?? DEFAULT_SETTLE_GATE_INTERVAL_MS,
      delay,
      // Same bridge-first dismissal the open used. Without this the gate would
      // fall back to the driver's ref-click, which no-ops on Android (no label
      // on the SDK-55 sheet dismisses it) — so a menu that appeared AFTER the
      // render would burn the gate's whole timeout and report `settled:false`.
      dismissDevMenu: makeDevMenuDismisser(driver, opts.bridge),
    });
    if (outcome.devMenuDismissals > 0 && typeof console !== 'undefined' && console.warn) {
      // Not a failure — the gate healed it. But it means expo-dev-client put
      // its dev menu over the rendered component (typical right after a cold
      // `--clear` bundle build), which is precisely what used to make the run's
      // FIRST criterion false-fail. Say so, so a "why was this run slower"
      // question has an answer and a regression here stays visible.
      console.warn(
        `[validity] dismissed the Expo dev menu ${outcome.devMenuDismissals}× during the ` +
          'snapshot-settle gate — it was covering the rendered component',
      );
    }
    treeSettled = outcome.settled;
    if (!outcome.settled) {
      // The gate is advisory — the capture ALWAYS proceeds. But an unsettled
      // gate means the checks/screenshots below may have raced a loading screen
      // (the exact false verdict this gate exists to heal); make that observable
      // so a bogus regression signal can be diagnosed, instead of silently
      // blaming the check or scoring a "Refreshing…" screenshot as a broken
      // render. There is no low-friction persisted warnings channel on the
      // capture result (snapshot/run-meta fields are an add-only contract), so
      // follow the package's existing `console.warn('[validity] …')` convention.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(
          `[validity] native snapshot never settled within ${outcome.waitedMs}ms` +
            ` (${cold ? 'cold' : 'warm'} open) — checks/screenshot may have raced a loading screen`,
        );
      }
    }
  }

  // `.ad` REPLAY RECORDING — published here, and here for two reasons.
  //
  // AFTER the settle gate, because the destination guard is a real `wait` on
  // the render marker and a tree that has not settled would make it flaky
  // (recording a guard that only sometimes resolves is worse than recording
  // none). BEFORE the check loop, because the checks click and fill BY REF, and
  // upstream refuses to publish a script containing a session-local `@eNN` —
  // publishing first freezes the script at `open` → `wait <landmark>`, which is
  // exactly the open-to-destination shape replay can re-verify.
  //
  // Entirely best-effort: every call is guarded, nothing throws, and a run that
  // publishes no recording is a completely normal run. `driver.recordingState()`
  // is the interlock — it is set only on the capture that ESTABLISHED the
  // session with an armed open, so a sweep does this once.
  let recordingPath: string | undefined;
  if (
    render.status === 'confirmed' &&
    marker &&
    driver.recordDestinationGuard &&
    driver.publishRecording &&
    driver.recordingState?.()?.published === false
  ) {
    const guarded = await driver
      .recordDestinationGuard(marker, opts.paintConfirmMs ?? DEFAULT_PAINT_CONFIRM_MS)
      .catch(() => false);
    if (guarded) {
      const published = await driver
        .publishRecording()
        .catch(() => ({ published: false, path: undefined }));
      if (published.published && published.path) recordingPath = published.path;
    }
  }

  // Spec hard/property checks — execute DETERMINISTICALLY on the device after a
  // CONFIRMED render and BEFORE the screenshot, so the shot captures the
  // post-interaction end state (the native analog of the web verify order).
  // A non-confirmed render is not evidence, so checks are skipped there. A
  // check-executor failure is infra noise, never a render failure.
  let criterionVerdicts: CriterionVerdict[] | undefined;
  let preInteractionScreenshotPath: string | undefined;
  let deviceEvidence: NativeDeviceEvidence | undefined;
  if (opts.criteriaChecks && opts.criteriaChecks.length > 0 && render.status === 'confirmed') {
    // Pre-interaction base shot — ONLY when a check will actually mutate the
    // screen (click/fill). Assert-only checks leave the screen untouched, so
    // the post-interaction evidence shot already IS the base state there and
    // a duplicate would be dead weight.
    const willInteract = opts.criteriaChecks.some((c) =>
      (c.checks ?? []).some((ch) => isClickCheck(ch) || isFillCheck(ch)),
    );
    if (willInteract) {
      const prePath = screenshotPath.replace(/\.png$/i, '') + '.pre-interaction.png';
      if (await bestEffort(() => driver.screenshot(prePath))) {
        preInteractionScreenshotPath = prePath;
      }
    }
    criterionVerdicts = [];
    for (const criterion of opts.criteriaChecks) {
      try {
        criterionVerdicts.push(
          await runNativeCriterionChecks({
            driver,
            criterion,
            secrets: opts.secrets,
            // Network/console/perf were observed at the render ack (see the
            // render-time caveat in native-check-executor); pass them through.
            matchedRequests: render.matchedRequests,
            consoleErrorCount: render.consoleErrorCount,
            // On-device render timing — fuels deterministic expect.performance
            // (ready/mount/update). Absent → unverifiable WITH THE REASON: an
            // old companion and a fallback-confirmed render are different
            // problems with different fixes, and conflating them told users to
            // rebuild a companion that was already current.
            perf: render.perf,
            perfUnavailableReason: nativePerfUnavailableReason(
              render,
              opts.bridge?.deviceInfo()?.capabilities,
            ),
            // The permissive catch-all's un-mocked URLs — feeds the network
            // taint step so a pass satisfied by a fabricated catch-all body is
            // demoted to unverifiable (parity with the web executor).
            unmatchedUrls: render.unmatchedUrls,
            navigate: async (target: string) => {
              await driver.openUrl(target);
            },
            // Navigation attempts the auto-mocked navigator swallowed — lets
            // the executor demote "the screen should have gone away" from a
            // confident FAIL to `unverifiable` in isolation. Absent bridge →
            // omitted, and the demotion never fires.
            ...(opts.bridge
              ? { navIntentsSince: (since: number) => opts.bridge!.navIntentsSince(since) }
              : {}),
          }),
        );
      } catch (err) {
        criterionVerdicts.push({
          id: criterion.id,
          tier: criterion.tier,
          status: 'unverifiable',
          detail: `native check executor error: ${(err as Error).message.split('\n')[0]}`,
        });
      }
    }

    // DEVICE-SIDE EVIDENCE (perf frames/memory, HTTP traffic from the session
    // logs). Off by default because it costs two extra spawns per capture and a
    // sweep pays that per spec; capture-only by design — nothing scores it, and
    // no threshold exists to score it against (see the plan's perf/network
    // note). Best-effort: any failure leaves `deviceEvidence` absent.
    if (opts.captureDeviceEvidence && driver.runInSession) {
      deviceEvidence = await collectDeviceEvidence(driver, { cwd: opts.projectRoot });
    }

    // UNSETTLED-TREE DEMOTION. Until now the gate only WARNED on timeout and
    // the verdicts stood, so a criterion could hard-FAIL against a tree the
    // harness had just admitted it could not read. The first Android run ever
    // hit this immediately: the companion ANR'd, the a11y tree was the system
    // "Close app / Wait" dialog, and both criteria reported a confident FAIL
    // with only an advisory warning alongside. That is a false red — the whole
    // defect class this gate exists to remove.
    //
    // Only FAIL is demoted, and that asymmetry is deliberate rather than a
    // hedge: a native check FAILS by not finding its element, which is exactly
    // what an occluded or still-loading tree produces spuriously. A PASS had to
    // positively match the element in the tree, so the component demonstrably
    // rendered — unsettledness cannot manufacture one. Demoting passes would
    // discard real evidence to no benefit.
  }

  const shotStart = Date.now();
  const shot = await driver.screenshot(screenshotPath);
  if (shot.code !== 0) {
    // This throw is the run's LAST word on a session-less capture (the CLI's
    // native engine feeds the message straight into `openErrorText`), so when
    // the readiness gate already told us there is no session, say so here
    // rather than letting an empty stderr reach the diagnosis as `unknown`.
    const why =
      session && !session.ready ? `\n${session.errorText ?? 'no agent-device session'}` : '';
    throw new Error(`Screenshot failed (exit ${shot.code}): ${shot.stderr.trim()}${why}`);
  }
  const screenshotMs = Date.now() - shotStart;

  let a11ySnapshot = '';
  const snapStart = Date.now();
  try {
    a11ySnapshot = await driver.snapshot();
  } catch {
    // Snapshot is best-effort grounding — a missing a11y tree shouldn't fail
    // the capture; the screenshot is still the primary evidence.
    a11ySnapshot = '';
  }
  const snapshotMs = Date.now() - snapStart;

  // BLIND-EVIDENCE DEMOTION. A criterion that FAILED against a tree the harness
  // could not actually read is not evidence the app is wrong. Two ways that
  // happens, both observed on real devices:
  //
  //  - the tree never SETTLED. The gate used to only warn on timeout and let
  //    the verdicts stand: on the first Android run the companion ANR'd, the
  //    tree was the system "Close app / Wait" dialog, and both criteria
  //    reported a confident FAIL against it with an advisory line alongside.
  //
  //  - the tree is EMPTY. On Android with a FRESHLY BUILT companion the bridge
  //    acked `rendered {ok:true}` in ~900ms while the screen was blank (25 raw
  //    nodes, 0 surviving the a11y filter; the screenshot showed only the
  //    dev-client gear). The ack fires after the companion's JS
  //    mountAnimationFrame, which is NOT proof the view painted — so
  //    `renderConfirmation: 'confirmed'` was false and the gate settled quite
  //    happily on nothing.
  //
  // Only FAIL is demoted, and the asymmetry is load-bearing rather than a
  // hedge: a native check fails by NOT FINDING its element, which is exactly
  // what an occluded, still-loading, or unpainted tree fabricates. A PASS had
  // to positively match an element, so the component demonstrably rendered —
  // neither condition can manufacture one.
  //
  // The underlying Android paint problem is NOT fixed here; that is a
  // companion/Expo investigation. What is fixed is Validity claiming to know
  // the app is wrong when it could not see the app.
  if (criterionVerdicts && criterionVerdicts.length > 0) {
    const treeHasNodes = /@e\d+\s*\[[^\]]*\]/.test(a11ySnapshot);
    if (!treeSettled || !treeHasNodes) {
      const reason = !treeSettled
        ? 'the on-device view never settled, so this criterion resolved against a tree that ' +
          'may still have been a loading screen, system dialog, or overlay'
        : 'the on-device accessibility tree was EMPTY, so there was nothing to resolve this ' +
          'criterion against — the view had not painted (a bridge render-ack is not proof of paint)';
      criterionVerdicts = criterionVerdicts.map((v) =>
        v.status === 'fail'
          ? {
              ...v,
              status: 'unverifiable' as const,
              detail: `${reason} — not evidence the app is wrong${v.detail ? ` (was: ${v.detail})` : ''}`,
            }
          : v,
      );
    }
  }

  // PER-CAPTURE METRICS + DIAGNOSIS. Both are pure instrumentation on the way
  // out: the row records what this capture cost so a session that is DECAYING
  // (snapshot p95 climbing, renders stopping at unconfirmed) is visible in
  // numbers instead of being rediscovered two hours later, and the diagnosis
  // turns an unconfirmed render into a named cause with a fix instead of "no
  // mechanical verdict produced". Neither can change a verdict, and neither can
  // fail the capture — the metrics write swallows its errors and
  // diagnoseNativeEnvironment always resolves.
  let diagnosis: EnvironmentDiagnosis | undefined;
  if (opts.projectRoot) {
    // Ground the two host-side timings in agent-device's OWN per-request
    // durations, so "snapshots are getting slower" can be attributed to the
    // device rather than to this process. Strictly additive and strictly
    // best-effort: a driver without the method, an unreadable stream, or a
    // window with no matching event all leave the device-side fields absent
    // and the host-side ones exactly as they were.
    const events = await (driver.sessionEvents?.() ?? Promise.resolve([])).catch(() => []);
    // Daemon-reported cost of every `--cost` command this capture issued, taken
    // as a DELTA so each row owns its own spend and nothing double-counts.
    // Zero samples means the driver never got a readable cost (older binary,
    // `--cost` disabled, an injected runner) — recorded as absent, never as a
    // free capture.
    const cost = takeCommandCost();
    appendCaptureMetric(opts.projectRoot, {
      ts: new Date().toISOString(),
      platform: driver.platform,
      specId: opts.specId,
      openMs,
      snapshotMs,
      screenshotMs,
      renderStatus: render.status,
      openCallCount: deviceOpenCount(),
      snapshotDeviceMs: deviceDurationFor(events, 'snapshot', snapStart, Date.now()),
      screenshotDeviceMs: deviceDurationFor(events, 'screenshot', shotStart, snapStart),
      ...(cost.samples > 0 ? { deviceCostMs: cost.totalMs, deviceCostSamples: cost.samples } : {}),
    });
    if (render.status !== 'confirmed') {
      diagnosis = await (opts.diagnose ?? diagnoseNativeEnvironment)({
        projectRoot: opts.projectRoot,
        platform: driver.platform,
        renderStatus: render.status,
        avdName: opts.avdName,
        // The readiness gate's verdict, when it ran. A capture with no
        // agent-device session cannot have produced device evidence, and that
        // outranks every softer suspicion the probes would otherwise land on.
        ...(session ? { sessionEstablished: session.ready } : {}),
        ...(session?.errorText ? { openErrorText: session.errorText } : {}),
        // The evidence this capture ALREADY read. Without it the two Expo dev
        // surfaces — a modal dev menu over a good render, and the dev-launcher
        // home screen with no bundle loaded — are invisible to the probes, and
        // both were getting attributed to session decay or to the component.
        a11ySnapshot,
        // A device identity conflict the bridge observed (a stale process
        // holding the bridge port with the other platform's device attached).
        // Null/undefined when there is none, or when it cannot be told.
        bridgePlatformMismatch: opts.bridge?.platformMismatch() ?? null,
      }).catch(() => undefined);
    }
  }

  return {
    target: spec,
    url,
    screenshotPath,
    a11ySnapshot,
    render,
    timing: { openMs, screenshotMs, snapshotMs },
    criterionVerdicts,
    preInteractionScreenshotPath,
    diagnosis,
    recordingPath,
    ...(deviceEvidence ? { deviceEvidence } : {}),
  };
}

export interface NativeBrowseResult {
  url: string;
  /** The argv the caller can run/print to open it (for transparency + CLI). */
  openCommand: { bin: string; args: string[] };
  /** Authoritative render confirmation (see NativeCaptureResult.render). */
  render: NativeRenderStatus;
  /** Per-phase timing breakdown (browse has no screenshot/snapshot phase). */
  timing: NativeTiming;
}

export interface BrowseNativeOptions {
  /** Metro URL for the dev-client control link (defaults to the driver's). */
  metroUrl?: string;
  /** Skip the dev-client bundle preload (warm app already serving the bundle). */
  skipPreload?: boolean;
  /** UI ref/selector to wait for as proof the component rendered. */
  renderMarkerRef?: string;
  /** Max time to wait for the render marker before falling back to settle. */
  waitTimeoutMs?: number;
  /** Time to let the bundle load after the control link, on a cold open. */
  bundleWaitMs?: number;
  /** Observable bundle readiness for cold opens (see ColdOpenOptions.waitForBundle). */
  waitForBundle?: () => Promise<boolean>;
  /** Fallback settle time if the render marker never appears. */
  settleMs?: number;
  /** Settle after a CONFIRMED warm re-target — slow-paint escape hatch (see ColdOpenOptions.warmSettleMs). */
  warmSettleMs?: number;
  /** Paint cross-check budget after a bridge ack (see ColdOpenOptions.paintConfirmMs). */
  paintConfirmMs?: number;
  /** The session already asserted `adb reverse` for this device (see ColdOpenOptions.androidReverseAsserted). */
  androidReverseAsserted?: boolean;
  /** Injectable delay (tests pass a no-op). */
  delay?: (ms: number) => Promise<void>;
  /** Host-side control bridge for in-place re-targeting (see ColdOpenOptions.bridge). */
  bridge?: NativeBridgeHandle;
  /**
   * Force a fresh JS bundle (see ColdOpenOptions.forceReload — in-place bridge
   * reload when a live reload-capable companion is attached, terminate + cold
   * launch as the final fallback). The CLI passes this after a content
   * `--clear` Metro restart: the still-running app's HMR socket is severed and
   * it would otherwise reconnect to the bridge and warm-ack a STALE bundle as
   * success.
   */
  forceReload?: boolean;
  /** App bundle id, required for `forceReload`'s terminate-ladder fallback. */
  bundleId?: string;
  /** Freshly-prepared contentHash for the stale-bundle guard (see ColdOpenOptions.expectedContentHash). */
  expectedContentHash?: string;
}

/**
 * "Show me my Button in the simulator." Cold-opens the playground at one
 * component (load bundle → route → dismiss dev overlay/alert → wait for render)
 * — no capture. Returns the command actually run so a CLI/MCP surface can echo
 * it to the user.
 */
export async function browseNative(
  driver: NativeDriver & { openTargetCommand?: (s: TargetSpec) => { bin: string; args: string[] } },
  spec: TargetSpec,
  opts: BrowseNativeOptions = {},
): Promise<NativeBrowseResult> {
  const openStart = Date.now();
  const { url, render } = await coldOpen({
    driver,
    spec,
    delay: opts.delay ?? sleep,
    metroUrl: opts.metroUrl,
    skipPreload: opts.skipPreload,
    renderMarkerRef: opts.renderMarkerRef,
    waitTimeoutMs: opts.waitTimeoutMs,
    bundleWaitMs: opts.bundleWaitMs,
    waitForBundle: opts.waitForBundle,
    settleMs: opts.settleMs,
    warmSettleMs: opts.warmSettleMs,
    paintConfirmMs: opts.paintConfirmMs,
    androidReverseAsserted: opts.androidReverseAsserted,
    bridge: opts.bridge,
    forceReload: opts.forceReload,
    bundleId: opts.bundleId,
    expectedContentHash: opts.expectedContentHash,
  });
  const openMs = Date.now() - openStart;

  const openCommand = driver.openTargetCommand
    ? driver.openTargetCommand(spec)
    : { bin: '(driver)', args: [] };
  return { url, openCommand, render, timing: { openMs } };
}
