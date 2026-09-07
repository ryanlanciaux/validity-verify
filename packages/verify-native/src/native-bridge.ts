/**
 * Native control bridge — the host (MCP/CLI) side.
 *
 * The companion app, once running, connects back to this WebSocket and the
 * host pushes `navigate` / `home` commands that the playground applies
 * IN-PLACE (no deep-link, no bundle reload, no splash re-present). This is the
 * native analog of the web sandbox's `/__validity/bridge` (see
 * `@validity.ai/verify-web` browse/bridge.ts) and the structural fix for the
 * "buttons works, dropdowns hangs" bug: instead of waiting on a single shared
 * `validity-root` render marker (which a stale previous component satisfies
 * immediately), every navigation carries a unique TOKEN and the device posts
 * `{type:'rendered', token, ok}` back once the NEW target has actually painted.
 * The host waits for that exact token, so a stale frame can never be mistaken
 * for the requested one.
 *
 * Strictly local, one connected device at a time (a new connection replaces the
 * previous — the device reconnects after the host process restarts).
 *
 * Connection INTEGRITY is enforced two ways:
 *   - A WS ping/pong heartbeat reaps half-open sockets (simulator slept, app
 *     suspended): a socket that misses `maxMissedPongs` consecutive pongs is
 *     terminated, so `isConnected()` can't pin a dead session "warm" and route
 *     captures onto a screen nobody is driving.
 *   - The companion's `hello` carries the contentHash its bundle was generated
 *     from plus a stable device identity and its protocol capabilities;
 *     `deviceInfo()` exposes them so the capture flow can detect a STALE bundle
 *     (device still serving old code after a content Metro restart) and push an
 *     in-place `reload` (capability-gated — see {@link NativeReloadMessage})
 *     instead of confidently re-targeting old code. Old companion binaries send
 *     a bare `hello` — that degrades to "no info", never an error.
 *
 * PORT CONTENTION (8083 is a fixed single-bind resource shared by the CLI and
 * the MCP server) is no longer a silent degrade to the splash-prone deep-link
 * ladder. The WS server rides an HTTP server that also speaks three endpoints:
 *   - GET  /status   → `{validityNativeBridge: true, connected, device}`
 *   - GET  /data     → `{validityNativeBridge: true, data}` — the DATA payload
 *                      (views/scenarios/mock/asyncStorage) the device fetches at
 *                      boot and applies over its baked fallback (see
 *                      {@link NativeBridgeHandle.setNativeData}). Same port as
 *                      the WS, so Android's existing `adb reverse tcp:<port>`
 *                      for the bridge already covers it — no second reverse.
 *   - POST /navigate → relay a navigate/home message to the connected device
 *                      and answer with its `rendered` ack
 *   - POST /dismiss-dev-menu
 *                    → relay a dev-menu dismissal (see
 *                      {@link NativeDismissDevMenuMessage}) and answer with
 *                      whether the DEVICE confirmed it closed the menu
 * When our bind loses (EADDRINUSE) we probe the holder: a live Validity bridge
 * → mode 'delegated' (navigations hop through it over HTTP and still get real
 * per-token acks); anything else → mode 'port-held', surfaced to the caller as
 * a machine-readable BRIDGE_PORT_HELD error (see {@link BridgePortHeldError}).
 */
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { localRequestStatus } from '@validity.ai/verify-spec';
import { COMPANION_BRIDGE_PORT } from './prepare-native-app.js';
import type {
  NativeViewItem,
  NativeScenarioSeedWire,
  NativeDataPayload,
} from './prepare-native.js';
import type { NativeMockNetworkData } from './network-native.js';

export { COMPANION_BRIDGE_PORT };

/**
 * Re-target the active view to a component or a named view (mutually exclusive).
 *
 * DATA/CODE BOUNDARY (the iteration-speed contract — see PLAN step 8): every
 * view/scenario/mock input that is pure JSON-serializable DATA travels INLINE on
 * this message (`items` / `scenarioSeed` / `mockNetwork`) so editing it costs a
 * warm bridge re-target, NOT a Metro `--clear` restart. Anything FUNCTION-BEARING
 * cannot be serialized and stays baked generated code tracked by contentHash —
 * scenario seeds encode such values as `undefinedKeys` (see
 * {@link NativeScenarioSeedWire}), so nothing function-bearing ever rides this
 * path. An old companion that predates a given field simply ignores it and falls
 * back to its baked copy — the fields are additive and degrade gracefully.
 */
export interface NativeNavigateMessage {
  type: 'navigate';
  /** Correlates the device's `rendered` ack back to this exact request. */
  token: string;
  /** Component/screen path (mutually exclusive with `view`). */
  component?: string;
  /** Author-defined view name (mutually exclusive with `component`). */
  view?: string;
  /**
   * Resolved view items shipped INLINE with the view (the ephemeral path) — the
   * device renders these directly instead of looking `view` up in the bundled
   * registry map, so a newly-created/edited view renders with no native
   * rebuild. Absent → the device falls back to its baked `views[view]`.
   */
  items?: NativeViewItem[];
  fixture?: string;
  scenario?: string;
  /**
   * Scenario context seed in wire format shipped INLINE — the host resolves the
   * `scenario` name (built-in + config `native.context`) host-side, so a
   * scenario edit reaches the device as data and the auto-mocked context proxy
   * overlays it without a rebuild. Absent → the device falls back to its baked
   * `scenarios[scenario]`.
   */
  scenarioSeed?: NativeScenarioSeedWire;
  /**
   * Mock-network config shipped INLINE — applied via the runtime's
   * `applyMockNetwork()` before the target renders, so a `.validity/config.ts`
   * mock-handler edit reaches the device as data. Absent → the device keeps
   * whatever it last applied (boot fetch / baked). Pure data: handlers have no
   * function members.
   */
  mockNetwork?: NativeMockNetworkData;
  /** Explicit prop overrides; `null` clears them. */
  propOverrides?: Record<string, unknown> | null;
  /**
   * Color scheme (theme) to force on the device for this target via
   * Appearance.setColorScheme — the native side of the verify color-scheme axis.
   * Absent → system/default theme.
   */
  colorScheme?: 'light' | 'dark';
  /**
   * True when this is the bridge's automatic re-send of the last drive command
   * onto a (re)connecting device — NOT a fresh host intent. A device that has
   * already applied any navigation in its current JS session ignores replays,
   * so a reconnect replay racing an in-flight newer navigate can never win.
   */
  replay?: boolean;
}

/** Drop back to the playground landing screen (ephemeral — no target). */
export interface NativeHomeMessage {
  type: 'home';
  token: string;
  /** See {@link NativeNavigateMessage.replay}. */
  replay?: boolean;
}

/** Liveness probe — the device answers with `hello`. */
export interface NativePingMessage {
  type: 'ping';
}

/**
 * In-place dev-client reload: the companion calls DevSettings.reload(), which
 * tears down its JS session and re-fetches the bundle from Metro — the cheap
 * replacement for the terminate+cold-launch ladder now that the companion is
 * built WITHOUT expo-splash-screen (a reload can no longer re-present an
 * un-dismissable launch screen). Carries no token and is never acked over the
 * old socket (it dies with the session); the host confirms via the NEW
 * connection (see {@link NativeBridgeHandle.waitForReconnect}) and then
 * navigates with a normal per-token ack. Deliberately NEVER recorded as
 * lastDriveMessage — replaying a reload onto every reconnect would be an
 * infinite reload loop. Only companions that announce the 'reload' capability
 * in their hello understand it; old binaries ignore unknown message types.
 */
export interface NativeReloadMessage {
  type: 'reload';
}

/**
 * Ask the companion to close the Expo dev menu FROM THE INSIDE.
 *
 * The menu auto-opens on every React-context init until a human taps through
 * expo-dev-menu's onboarding (`DevMenuFragment.onCreate`:
 * `showsAtLaunch || !isOnboardingFinished`, the latter defaulting to false) —
 * on an installer-provisioned companion, that is never. Being a MODAL bottom
 * sheet it takes the accessibility tree with it, so the host's render-marker
 * query and every a11y check underneath see a tree that structurally cannot
 * contain what they are looking for.
 *
 * The companion answers `{type:'dev-menu-dismissed', token, ok}` — `ok:false`
 * meaning "nothing was dismissed" (no expo-dev-menu in this binary, or the
 * native call rejected), which the host must not read as success.
 *
 * Carries a token like the drive messages so the ack correlates, but it is NOT
 * a drive message: it never becomes {@link lastDriveMessage}, so a reconnect
 * replay can't resurrect it. Capability-gated on 'dismiss-dev-menu' — an older
 * companion would drop it silently and leave the caller waiting out the
 * timeout for an ack that can never come.
 */
export interface NativeDismissDevMenuMessage {
  type: 'dismiss-dev-menu';
  /** Correlates the device's `dev-menu-dismissed` ack back to this request. */
  token: string;
}

export type NativeBridgeServerMessage =
  | NativeNavigateMessage
  | NativeHomeMessage
  | NativePingMessage
  | NativeReloadMessage
  | NativeDismissDevMenuMessage;

/**
 * The companion capability that gates {@link NativeDismissDevMenuMessage}.
 * Announced in the device's `hello` (`caps`). Exported so the capture layer can
 * decide whether a bridge-backed dismissal is even possible before trying one.
 */
export const DISMISS_DEV_MENU_CAPABILITY = 'dismiss-dev-menu';

/**
 * The companion capability that says "I ack TOKENIZED DEEP LINKS too, not just
 * bridge `navigate` messages". Announced in the device's `hello` (`caps`).
 *
 * WHY IT IS GATED: the deep-link rung confirms a render by waiting for the
 * tokenized marker in the a11y tree, so it never NEEDED an ack. But the ack is
 * the ONLY carrier of the per-render observation channels (`perf`, `matched`,
 * `consoleErrorCount`), which is why a capture that fell to that rung reported
 * `expect.performance` unverifiable on a fully-current companion. A host that
 * sees this capability MISSING must not spend its budget waiting for an ack an
 * old binary will never send — it degrades to the explicit "no timing on this
 * confirmation path" verdict instead.
 */
export const DEEP_LINK_ACK_CAPABILITY = 'deep-link-ack';

/**
 * How many unclaimed `rendered` acks the bridge keeps (see `retainedAcks`).
 * Small on purpose: the only readers are same-capture (deep-link rung) or
 * one-beat-late (bridge ack that missed its wait), so anything older is dead
 * weight — and an unbounded map is a leak in a long watch session.
 */
const RETAINED_ACK_LIMIT = 16;

/**
 * Default wait for the device's `dev-menu-dismissed` ack. Generous relative to
 * the work (a single native state write) because it crosses a WS hop to a
 * possibly-busy JS thread, and short enough that a wedged device costs one
 * capture's latency rather than the run.
 */
export const DEFAULT_DISMISS_DEV_MENU_TIMEOUT_MS = 3_000;

/**
 * Render-timing the companion measured INSIDE its own JS for the rendered
 * target and shipped on the `rendered` ack — the native analog of the web
 * executor's Navigation/Paint-Timing reads, but sourced from a monotonic clock
 * (`global.performance.now()`) and `React.Profiler` actualDuration instead.
 *
 * Honest scope: only `readyMs` / `mountMs` / `updateMs` are claimed as
 * deterministic proofs for `expect.performance` (metrics `ready` / `mount` /
 * `update`). `commitCount` is OBSERVATIONAL only (surfaced in the perf block,
 * never asserted). `load` / `firstContentfulPaint` have NO React-Native source
 * and are deliberately absent here — the executor reports them unverifiable
 * rather than fabricating a number.
 *
 * PRESENCE SEMANTICS (per-field): a NEW companion ALWAYS sends a perf OBJECT
 * (at minimum readyMs + mountMs + commitCount); `updateMs` is OMITTED when no
 * update commit fired (no re-render in the capture window), so the executor
 * reads it as undefined and reports `update` unverifiable — web parity with a
 * metric that was simply not measured on this render. (`JSON.stringify` drops
 * undefined sub-fields on the wire automatically.)
 */
export interface NativePerf {
  /** navStart → paint-confirmed, on the device's monotonic clock (ms). */
  readyMs?: number;
  /** React.Profiler mount `actualDuration` (already milliseconds). */
  mountMs?: number;
  /** Worst React.Profiler update `actualDuration` across render + play (ms). */
  updateMs?: number;
  /** Total Profiler commits (mount + updates) — observational, never asserted. */
  commitCount?: number;
}

export interface NativeRenderedResult {
  ok: boolean;
  error?: string;
  /**
   * Render-timing the companion measured for this target (see {@link NativePerf}),
   * carried so `expect.performance` can be evaluated on device — the native
   * analog of the web executor's Performance/Paint-Timing reads.
   *
   * OLD-COMPANION DEGRADATION: absent ENTIRELY on companion binaries that predate
   * this channel (their `rendered` ack carries no `perf` field) — the host reads
   * it as `undefined`, and the executor reports an `expect.performance` assertion
   * `unverifiable` ("native perf channel unavailable — rebuild the companion"),
   * NEVER a `fail`. CRITICAL (mirrors `consoleErrorCount`): a present perf object
   * with a `0` sub-field is NOT collapsed to absent — `0ms` is a real, passable
   * measurement; only a genuinely missing object (or a missing sub-field, e.g.
   * `updateMs` when zero re-renders fired) is unverifiable. The whole-object
   * absence and per-field absence are distinct degradations and both are honest:
   * one means "no channel", the other means "this metric not measured here".
   */
  perf?: NativePerf;
  /**
   * URLs the rendered target fetched that no configured handler matched (the
   * device's permissive catch-all answered them). The native analog of web's
   * `window.__VALIDITY_UNMATCHED__` — surfaced in a native verify so the agent
   * can pin them in `.validity/config.ts`. Absent on old companion binaries
   * (no `unmatched` field in their `rendered` ack) — degrade to "not reported".
   */
  unmatched?: string[];
  /**
   * Network responses the rendered target actually OBSERVED — every request a
   * configured handler OR the permissive catch-all answered, with the status it
   * returned. The native analog of the web executor's `page.on('response')`
   * collection (see `ObservedResponse` in `@validity.ai/verify-web`'s check-executor),
   * so `expect.network` criteria can be evaluated on device: the native check
   * executor filters these by method+url and tests the matched response's status
   * against the criterion's `StatusMatcher`.
   *
   * OLD-COMPANION DEGRADATION: absent on companion binaries that predate this
   * channel (their `rendered` ack carries no `matched` field) — the host reads
   * it as `undefined`, the executor sees NO observations, and an `expect.network`
   * assertion is `unverifiable` (a "we couldn't observe the network" finding),
   * NEVER a `fail`. An empty array (a new companion that observed zero responses)
   * is treated identically — both mean "no candidate to assert against". Capped
   * on read (see {@link MATCHED_READ_CAP}) so a polling screen on a long warm
   * session can't hand us an unbounded array.
   *
   * `provenance` (A4): who answered — `'declared'` = a configured handler (its
   * pattern rides along as `handlerUrl`), `'fabricated'` = the device's
   * catch-all invented the body. Absent on old companion binaries (unknown —
   * the executor then falls back to the unmatched-list taint inference and
   * never claims declared evidence). The host treats the device's claim as
   * UNTRUSTED: any non-whitelisted value is dropped on read, and the executor
   * cross-checks declared claims against the unmatched list + catch-all
   * pattern rule before use.
   */
  matched?: Array<{
    method: string;
    url: string;
    status: number;
    provenance?: 'declared' | 'fabricated';
    handlerUrl?: string;
  }>;
  /**
   * How many times the rendered target called `console.error` during the
   * capture window (the device patches `console.error` to count). The native
   * analog of the web executor's `consoleErrorCount`, so `expect.console`
   * (error-budget) criteria can be evaluated on device.
   *
   * OLD-COMPANION DEGRADATION: absent on binaries that predate this channel —
   * the host reads it as `undefined`, which the executor treats as "console
   * channel unavailable" → an `expect.console` assertion is `unverifiable`,
   * never a `fail`. CRITICAL: `0` is NOT collapsed to absent — a new companion
   * that saw zero errors reports `consoleErrorCount: 0`, which lets the executor
   * `pass` an error-budget check; only a genuinely absent field is unverifiable.
   */
  consoleErrorCount?: number;
}

/**
 * What the companion told us about itself in its last `hello` on the ACTIVE
 * socket. Every field is optional: an old companion binary sends a bare
 * `{type:'hello'}` and the host must degrade to current conservative behavior
 * (no staleness detection, no identity matching) rather than brick the session.
 */
export interface NativeBridgeDeviceInfo {
  /**
   * The generated-content hash baked into the bundle the device is actually
   * running (`validity-content-hash.ts`, emitted by prepareNative). Compare
   * against the freshly-prepared contentHash to detect a stale bundle.
   */
  contentHash?: string;
  /**
   * Stable device identity (vendor/android id when expo-application is
   * available, else a persisted installation id, else a per-session id).
   */
  deviceId?: string;
  /** 'ios' | 'android' as reported by the companion's Platform.OS. */
  platform?: string;
  /**
   * Protocol capabilities the running companion BUNDLE announced in its hello
   * (`caps: [...]`). 'reload' = the bundle handles {@link NativeReloadMessage}
   * via DevSettings.reload(). Capability-gated rather than inferred from other
   * hello fields so a bundle generated between protocol revisions (e.g. one
   * that sends contentHash but predates the reload handler) is never sent a
   * message it would silently drop. Absent on old binaries → no capability →
   * callers keep the legacy terminate+cold-launch behavior.
   */
  capabilities?: string[];
  /**
   * Runtime mock-network state the companion reported (`mock: {active, reason}`
   * in its hello). `active:false` means msw failed to set up (or this is a
   * production bundle) and the screen is talking to the REAL network — the host
   * surfaces this so a native verify never scores real-API data against fixture
   * criteria unknowingly. Absent on old companion binaries (no signal — the host
   * notes the state as unknown rather than asserting either way).
   */
  mock?: { active: boolean; reason?: string };
}

/**
 * How this handle reaches the device:
 *  - 'starting'  — bind in flight (resolves within ms; await {@link NativeBridgeHandle.whenReady}).
 *  - 'local'     — we own the port; the device's socket dials us directly.
 *  - 'delegated' — another live Validity bridge owns the port; navigations hop
 *                  through its HTTP /navigate endpoint and still return acks.
 *  - 'port-held' — the port is held by something that is NOT a Validity bridge;
 *                  bridge-driven navigation is impossible (BRIDGE_PORT_HELD).
 *  - 'failed'    — bind failed for a non-EADDRINUSE reason; degrade like the
 *                  legacy behavior (no device ever connects, callers fall back).
 */
export type NativeBridgeMode = 'starting' | 'local' | 'delegated' | 'port-held' | 'failed';

/**
 * A device identity conflict: the bridge is reaching a device on a platform
 * this run is not driving. Structurally identical to `BridgePlatformMismatch`
 * in environment-diagnosis (which consumes it as a diagnosis input); declared
 * here rather than imported so the bridge keeps no dependency on the diagnosis
 * module.
 */
export interface NativeBridgePlatformMismatch {
  /** The platform this run drives (`StartNativeBridgeOptions.platform`). */
  expected: 'ios' | 'android';
  /** The `Platform.OS` the device on the other end reported. */
  actual: string;
  /** That device's stable id, when it announced one. */
  deviceId?: string;
  /**
   * 'hello' — a device attached to OUR socket announced the wrong platform;
   * 'delegated-status' — the process holding the port has one attached.
   */
  source: 'hello' | 'delegated-status';
  /** The bridge port involved. */
  port: number;
}

/** Outcome of a {@link NativeBridgeHandle.navigate} — the unified drive API. */
export type NativeBridgeNavigateOutcome =
  | { kind: 'ack'; result: NativeRenderedResult }
  /** Delivered, but the device never acked the token within the timeout. */
  | { kind: 'ack-timeout' }
  /** No device connected (locally or behind the delegated bridge). */
  | { kind: 'no-device' }
  /** The port is held and delegation is impossible/broken — machine-readable. */
  | { kind: 'port-held'; detail: string };

/**
 * Machine-readable "the bridge port is held and delegation is impossible"
 * error. Thrown by the capture flow instead of silently degrading to the
 * splash-prone deep-link ladder; MCP/CLI surface `code` + message verbatim.
 */
export class BridgePortHeldError extends Error {
  readonly code = 'BRIDGE_PORT_HELD';
  constructor(detail: string) {
    super(`BRIDGE_PORT_HELD: ${detail}`);
    this.name = 'BridgePortHeldError';
  }
}

export interface NativeBridgeHandle {
  /** The port the WS server bound to (or attempted to). */
  readonly port: number;
  /** How this handle currently reaches the device (see {@link NativeBridgeMode}). */
  mode(): NativeBridgeMode;
  /** Resolves once the bind/delegation probe settled (never 'starting'). */
  whenReady(): Promise<NativeBridgeMode>;
  /**
   * Push a command to the connected device over the LOCAL socket. False when
   * nothing is connected (always false in 'delegated' mode — use `navigate`).
   */
  send(message: NativeBridgeServerMessage): boolean;
  /** Whether a device is currently connected (locally, or to the delegated bridge). */
  isConnected(): boolean;
  /**
   * Navigation attempts the device's AUTO-MOCKED navigator reported at or after
   * `sinceMs`. In isolation the navigator is a mock, so `navigate()` never
   * changes the screen: a check asserting the screen went away is undecidable
   * rather than failing, and the executor uses this to say so. Empty on an old
   * companion (no intent channel) — degrade to today's behavior, never a
   * fabricated demotion.
   */
  navIntentsSince(sinceMs: number): Promise<Array<{ method: string; at: number }>>;
  /**
   * Resolve true once a device is (or becomes) connected, false on timeout.
   * Used after a cold boot to wait for the freshly-launched app to attach
   * before we push the first `navigate`. In 'delegated' mode this polls the
   * owning bridge's /status.
   */
  waitForConnection(timeoutMs: number): Promise<boolean>;
  /**
   * Monotonic count of device connections this bridge has accepted (local mode
   * only — a delegated handle accepts none). Capture it BEFORE pushing a
   * `reload`, then {@link waitForReconnect} with it: the count distinguishes
   * "a NEW JS session dialed back after the reload" from "the pre-reload
   * socket is still open", which `isConnected()`/`waitForConnection` cannot.
   */
  connectionEpoch(): number;
  /**
   * Resolve true once `connectionEpoch()` exceeds `sinceEpoch` — i.e. a NEW
   * device session attached after the caller captured the epoch — false on
   * timeout. The post-reload confirmation: the reloaded companion re-fetches
   * its bundle from Metro and dials back (sending a fresh hello), and only
   * then is it safe to push the follow-up `navigate`. A connection that
   * already existed when the epoch was captured can never satisfy this.
   */
  waitForReconnect(sinceEpoch: number, timeoutMs: number): Promise<boolean>;
  /**
   * Resolve with the device's render ack for `token`, or null on timeout. This
   * is the per-navigation confirmation that the NEW target painted — the
   * replacement for waiting on the shared `validity-root` marker. Local mode
   * only; 'delegated' callers get their ack from {@link navigate}.
   */
  waitForRendered(token: string, timeoutMs: number): Promise<NativeRenderedResult | null>;
  /**
   * Drive the device and await its `rendered` ack — the ONE API that works in
   * every mode (local socket write, or an HTTP hop through the bridge that
   * actually owns the port). Prefer this over send+waitForRendered.
   */
  navigate(
    message: NativeNavigateMessage | NativeHomeMessage,
    timeoutMs: number,
  ): Promise<NativeBridgeNavigateOutcome>;
  /**
   * Ask the connected companion to close the Expo dev menu (see
   * {@link NativeDismissDevMenuMessage}) and resolve with what happened.
   *
   * TRUE means the DEVICE confirmed it closed the menu — the only value a
   * caller may treat as "the occluding sheet is gone". Every other outcome
   * (no device, an old companion without the capability, a rejected native
   * call, an ack timeout) resolves FALSE, so an unavailable dismissal degrades
   * to "we could not clear it" and the caller's own observation decides, rather
   * than to a fabricated success. Works in delegated mode via the owning
   * bridge's HTTP endpoint, exactly like {@link navigate}.
   */
  dismissDevMenu(timeoutMs?: number): Promise<boolean>;
  /**
   * Identity/freshness info from the connected companion's last `hello` (or,
   * in 'delegated' mode, from the owning bridge's /status). Null before any
   * hello; fields are individually optional for old companion binaries.
   */
  deviceInfo(): NativeBridgeDeviceInfo | null;
  /**
   * The platform identity conflict currently observed, or null when there is
   * none — which includes every case where it CANNOT be told (no
   * `StartNativeBridgeOptions.platform`, no device, an old companion binary
   * that announces no platform). Never a guess: both sides are self-reported.
   *
   * Surfaced rather than thrown because a mismatch is diagnostic evidence about
   * the whole run, not a failure of any one navigation — the capture flow feeds
   * it to `diagnoseNativeEnvironment` as `bridgePlatformMismatch`. The one
   * place it IS enforced is delegation: `navigate` refuses to hop through a
   * bridge holding the other platform's device and returns `port-held`, because
   * hopping there produces confident acks from a device nobody is verifying.
   */
  platformMismatch(): NativeBridgePlatformMismatch | null;
  /**
   * Publish the current DATA payload (views / scenario seeds / mock-network /
   * AsyncStorage seed) for the device's boot fetch. The companion GETs
   * `/data` on the bridge's HTTP server right after connecting and applies the
   * payload with PRIORITY over its baked `validity-native-data.ts` fallback, so
   * a reloaded/cold session picks up fresh views + scenario + mock state with no
   * native rebuild and no contentHash flip. The host calls this with
   * `prepared.dataPayload` on every native_browse (cheap — it's just data).
   *
   * Local mode only: in 'delegated' mode the bridge that OWNS the port answers
   * `/data` with ITS payload; this handle still ships the per-target slices
   * inline via {@link navigate} (`items` / `scenarioSeed` / `mockNetwork`),
   * which are authoritative for the driven navigation regardless of who serves
   * the boot fetch. `null` clears it (GET /data then reports `data:null`, and
   * the device keeps its baked fallback).
   */
  setNativeData(payload: NativeDataPayload | null): void;
  /** Tear down the server + active socket. */
  close(): void;
}

interface DeviceMessage {
  type?: string;
  token?: string;
  ok?: boolean;
  error?: string;
  /** New-companion hello extras (absent on old binaries — degrade gracefully). */
  contentHash?: unknown;
  device?: { id?: unknown; platform?: unknown };
  /** Protocol capabilities ('reload', …) — see NativeBridgeDeviceInfo.capabilities. */
  caps?: unknown;
  /** Navigator method the device's auto-mock swallowed (on a `nav-intent`). */
  method?: unknown;
  /** Runtime mock-network state — see NativeBridgeDeviceInfo.mock. */
  mock?: unknown;
  /**
   * Un-mocked URLs the rendered target hit (on a `rendered` ack) — see
   * NativeRenderedResult.unmatched. Absent on old companion binaries.
   */
  unmatched?: unknown;
  /**
   * Network responses the rendered target observed (on a `rendered` ack) — see
   * NativeRenderedResult.matched. Absent on old companion binaries.
   */
  matched?: unknown;
  /**
   * console.error count over the capture window (on a `rendered` ack) — see
   * NativeRenderedResult.consoleErrorCount. Absent on old companion binaries.
   */
  consoleErrorCount?: unknown;
  /**
   * Render-timing the target measured (on a `rendered` ack) — see
   * NativeRenderedResult.perf / NativePerf. Absent on old companion binaries.
   */
  perf?: unknown;
}

/** Coerce an untrusted hello/status mock payload into {active, reason} (or absent). */
function coerceMockStatus(v: unknown): { active: boolean; reason?: string } | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  if (typeof m.active !== 'boolean') return undefined;
  return { active: m.active, reason: typeof m.reason === 'string' ? m.reason : undefined };
}

/** Coerce an untrusted hello/status caps payload into a string list (or absent). */
function coerceCapabilities(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const caps = v.filter((c): c is string => typeof c === 'string');
  return caps.length > 0 ? caps : undefined;
}

/**
 * Coerce an untrusted `rendered.unmatched` payload into a string list (or
 * absent). Used both on the WS `rendered` ack and when rehydrating a delegated
 * /navigate response, so an old binary's missing field degrades to "absent".
 */
function coerceUnmatched(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const urls = v.filter((u): u is string => typeof u === 'string');
  return urls.length > 0 ? urls : undefined;
}

/**
 * Defensive cap on the matched-network list read off a (possibly old / garbage)
 * `rendered` ack — the host trusts the device only so far. The companion caps
 * its own recording too (see `__MATCHED_CAP` in network-native), so a healthy
 * ack is already under this; the read cap is belt-and-suspenders against a
 * malformed or hostile payload.
 */
const MATCHED_READ_CAP = 200;

/**
 * Coerce an untrusted `rendered.matched` payload into a list of observed
 * network responses (or absent). Mirrors {@link coerceUnmatched}: drops any
 * entry without a string method+url, normalizes a non-finite status to 0, and
 * caps the list at {@link MATCHED_READ_CAP}. An empty result collapses to
 * `undefined` (mirroring unmatched) — the executor treats both absent and empty
 * as "no observation → unverifiable", so the collapse is lossless for it.
 * Absent on old companion binaries (no `matched` field) — degrade to "channel
 * unavailable".
 */
function coerceMatched(v: unknown): NativeRenderedResult['matched'] {
  if (!Array.isArray(v)) return undefined;
  const out: NonNullable<NativeRenderedResult['matched']> = [];
  for (const e of v) {
    if (out.length >= MATCHED_READ_CAP) break;
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.method !== 'string' || typeof r.url !== 'string') continue;
    const status = typeof r.status === 'number' && Number.isFinite(r.status) ? r.status : 0;
    const entry: NonNullable<NativeRenderedResult['matched']>[number] = {
      method: r.method,
      url: r.url,
      status,
    };
    // Provenance (A4) is WHITELISTED — any other value (garbage / hostile ack)
    // is dropped to `undefined`, which the executor treats as unknown and can
    // therefore never promote to declared evidence.
    if (r.provenance === 'declared' || r.provenance === 'fabricated') {
      entry.provenance = r.provenance;
    }
    if (typeof r.handlerUrl === 'string') entry.handlerUrl = r.handlerUrl;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Coerce an untrusted `rendered.consoleErrorCount` into a non-negative integer
 * (or absent). DELIBERATELY does NOT collapse `0` to absent (unlike the
 * unmatched/matched lists): `0` means "console channel available, zero errors"
 * → an error-budget check can pass; `undefined` means "channel unavailable
 * (old binary)" → unverifiable. Negative / non-finite / non-number → absent.
 */
function coerceConsoleErrorCount(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return Math.floor(v);
}

/**
 * Coerce an untrusted `rendered.perf` payload into a {@link NativePerf} (or
 * absent). SHAPE-GUARDED like the sibling channels: a non-object (old binary,
 * garbage) → `undefined` entirely, which the executor reads as "perf channel
 * unavailable". For a real object, each sub-field is accepted only when it is a
 * finite number and OMITTED otherwise — so a per-field absence (e.g. `updateMs`
 * with zero re-renders, or a non-numeric value) degrades to "this metric not
 * measured" rather than poisoning the verdict. Unlike the unmatched/matched
 * lists this does NOT collapse a `0` sub-field to absent: `0ms` is a real,
 * passable measurement (mirrors {@link coerceConsoleErrorCount}). An object that
 * yields no usable sub-fields still returns an empty object (channel present,
 * nothing measured) — distinct from whole-object absence (no channel).
 */
function coercePerf(v: unknown): NativePerf | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  const num = (x: unknown): number | undefined =>
    typeof x === 'number' && Number.isFinite(x) ? x : undefined;
  const out: NativePerf = {};
  const readyMs = num(m.readyMs);
  const mountMs = num(m.mountMs);
  const updateMs = num(m.updateMs);
  const commitCount = num(m.commitCount);
  if (readyMs !== undefined) out.readyMs = readyMs;
  if (mountMs !== undefined) out.mountMs = mountMs;
  if (updateMs !== undefined) out.updateMs = updateMs;
  if (commitCount !== undefined) out.commitCount = commitCount;
  return out;
}

/**
 * Heartbeat defaults: ping every 10s, terminate after 2 consecutive missed
 * pongs (~30s to reap a half-open socket). RN's WebSocket implementations
 * (NSURLSessionWebSocketTask / OkHttp) answer protocol-level pings
 * automatically, so a healthy companion needs no JS-side change to stay warm.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_MISSED_PONGS = 2;

/** Default ack wait the HTTP /navigate endpoint uses when the caller sent none. */
const DEFAULT_HTTP_NAVIGATE_TIMEOUT_MS = 8_000;
/** Upper bound on a delegated ack wait (covers post---clear first bundles). */
const MAX_HTTP_NAVIGATE_TIMEOUT_MS = 120_000;
/** How long the EADDRINUSE probe waits for the holder to identify itself. */
const STATUS_PROBE_TIMEOUT_MS = 1_000;
/** Poll cadence for delegated waitForConnection. */
const DELEGATED_STATUS_POLL_MS = 250;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Body shape of GET /status (and embedded in POST /navigate responses). */
interface BridgeStatusBody {
  validityNativeBridge: true;
  connected: boolean;
  device: NativeBridgeDeviceInfo | null;
}

/** Body shape of POST /navigate responses. */
interface BridgeNavigateBody extends Omit<BridgeStatusBody, 'validityNativeBridge'> {
  delivered: boolean;
  ack: NativeRenderedResult | null;
}

/**
 * Body shape of POST /dismiss-dev-menu responses. `dismissed` is the DEVICE's
 * answer relayed verbatim — an owning bridge that could not dismiss (no device,
 * old companion, native call rejected, ack timeout) reports false, and the
 * delegated caller degrades exactly as if it had asked locally.
 */
interface BridgeDismissDevMenuBody extends Omit<BridgeStatusBody, 'validityNativeBridge'> {
  dismissed: boolean;
}

/**
 * Body shape of GET /rendered-ack responses — the DELEGATED read of a render
 * ack the owning bridge holds (retained or still in flight). `ack: null` means
 * "no such ack within the budget", which the caller treats exactly like a local
 * timeout: no timing adopted, never a fabricated one.
 */
interface BridgeRenderedAckBody extends Omit<BridgeStatusBody, 'validityNativeBridge'> {
  ack: NativeRenderedResult | null;
}

/** Minimal loopback JSON request (delegation probe + hop). Null on any failure. */
function httpJson(opts: {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs: number;
}): Promise<{ status: number; json: unknown } | null> {
  return new Promise((resolve) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let json: unknown;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on('error', () => resolve(null));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Read + JSON-parse a request body, undefined on overflow/garbage. */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

/** Validate an HTTP-delegated drive message (same shape as the WS protocol). */
function asDriveMessage(v: unknown): NativeNavigateMessage | NativeHomeMessage | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if ((m.type !== 'navigate' && m.type !== 'home') || typeof m.token !== 'string') return null;
  return v as unknown as NativeNavigateMessage | NativeHomeMessage;
}

/** Coerce an untrusted status/hello payload into NativeBridgeDeviceInfo. */
function coerceDeviceInfo(v: unknown): NativeBridgeDeviceInfo | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  return {
    contentHash: typeof m.contentHash === 'string' ? m.contentHash : undefined,
    deviceId: typeof m.deviceId === 'string' ? m.deviceId : undefined,
    platform: typeof m.platform === 'string' ? m.platform : undefined,
    capabilities: coerceCapabilities(m.capabilities),
    mock: coerceMockStatus(m.mock),
  };
}

export interface StartNativeBridgeOptions {
  port?: number;
  /** Heartbeat ping cadence. Tests shrink this; 0/negative disables the heartbeat. */
  heartbeatIntervalMs?: number;
  /** Consecutive unanswered pings before the socket is terminated as half-open. */
  maxMissedPongs?: number;
  /**
   * The platform this run drives. Supplying it BINDS the bridge to a platform:
   * a device — ours, or the one behind a bridge we would delegate to — that
   * reports a different `Platform.OS` is a mismatch (see
   * {@link NativeBridgeHandle.platformMismatch}), and delegation to such a
   * holder is REFUSED rather than performed silently.
   *
   * The failure this exists for (2026-07-29): a validity-mcp process left over
   * from a previous day held port 8083 with an Android device attached. An iOS
   * run delegated through it; the Android companion acked every navigate; the
   * iOS simulator under test never attached anything. Nothing was detectably
   * wrong — the bridge was healthy and pointed at the wrong device.
   *
   * Omitted → no binding, exactly today's behavior.
   */
  platform?: 'ios' | 'android';
}

/**
 * Start the host-side bridge WS server. Binds to `127.0.0.1` (iOS sim shares
 * the host loopback; Android reaches it via `adb reverse tcp:<port>`). Safe to
 * call once and reuse across many `native_browse` calls — the device holds the
 * socket between calls and reconnects if this process restarts.
 */
export function startNativeBridge(opts: StartNativeBridgeOptions = {}): NativeBridgeHandle {
  const port = opts.port ?? COMPANION_BRIDGE_PORT;
  const expectedPlatform = opts.platform;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxMissedPongs = opts.maxMissedPongs ?? DEFAULT_MAX_MISSED_PONGS;
  let activeSocket: WebSocket | null = null;
  /** The active companion's last hello payload (null before hello / after drop). */
  let activeHello: NativeBridgeDeviceInfo | null = null;
  /** Navigation attempts the device's mocked navigator reported (see 'nav-intent'). */
  const navIntents: Array<{ method: string; at: number }> = [];

  // The last drive command (navigate/home) we pushed this session. Replayed to a
  // device the moment it (re)connects, so a Metro full-reload — which re-runs the
  // companion's JS from scratch and drops its in-memory `target` back to the home
  // list — is immediately re-targeted to the component the user is iterating on,
  // with no deep-link round-trip. This is what makes "make the text red" behave
  // like editing a normal screen by hand: the reload self-heals back to the same
  // component over the WS. Session-scoped on purpose (in-memory): a fresh host
  // process starts with no last command, so a genuinely cold launch with no host
  // driving still lands on home rather than resurrecting a stale target. Pings
  // are never recorded — only navigation intent that was actually WRITTEN to a
  // socket (a failed write must not become tomorrow's replay: the caller falls
  // back/retries, and replaying an undelivered message could resurrect a target
  // older than whatever the device did in the meantime).
  let lastDriveMessage: NativeNavigateMessage | NativeHomeMessage | null = null;

  // The DATA payload (views/scenarios/mock/asyncStorage) served from GET /data
  // for the device's boot fetch. Plain data, refreshed by the host every
  // native_browse via setNativeData(); null until the first call (the device
  // then keeps its baked fallback). Session-scoped in-memory like
  // lastDriveMessage — a fresh host process serves nothing until it prepares.
  let nativeData: NativeDataPayload | null = null;

  // Render acks keyed by navigation token, and one-shot connection waiters.
  const renderWaiters = new Map<string, (r: NativeRenderedResult) => void>();
  const connectionWaiters = new Set<() => void>();
  // Dev-menu dismissal acks, keyed the same way (see dismissDevMenu). Kept in
  // its own map so a dismissal ack can never satisfy a render waiter — the two
  // token spaces are independent and a cross-match would confirm a paint that
  // never happened.
  const devMenuWaiters = new Map<string, (ok: boolean) => void>();
  // UNCLAIMED render acks, kept so a token whose ack arrives BEFORE anyone waits
  // for it is not thrown away. Two real flows need this and both used to lose
  // every observation channel silently:
  //   - the DEEP-LINK rung: the host opens `…?token=<t>`, confirms the paint by
  //     waiting for the tokenized marker in the a11y tree, and only THEN asks
  //     for the ack — which the device (a 'deep-link-ack' companion) already
  //     sent the moment the target painted;
  //   - a LATE bridge ack: `navigate` timed out host-side, the device answered a
  //     beat later. Retaining it lets the caller adopt the timing instead of
  //     reporting `expect.performance` unverifiable for a render that WAS
  //     measured.
  // Bounded FIFO: a long session must not accumulate acks nobody reads.
  const retainedAcks = new Map<string, NativeRenderedResult>();
  // Distinct token namespace from navigations (`nav-…`), so a stray ack can
  // never be mistaken for the other channel's even if a map lookup were moved.
  let devMenuSeq = 0;
  const mintDismissToken = (): string => {
    devMenuSeq += 1;
    return `devmenu-${Date.now().toString(36)}-${devMenuSeq}`;
  };

  const wakeConnectionWaiters = (): void => {
    for (const w of connectionWaiters) w();
    connectionWaiters.clear();
  };

  // Monotonic device-connection count + waiters for a connection NEWER than a
  // captured epoch. This is what makes the post-reload handshake race-free: a
  // `reload` tears the device's JS session down and a brand-new socket dials
  // back after the bundle re-fetch, but `isConnected()` reads true the whole
  // time (the old socket lingers until the teardown) — only an epoch bump
  // proves a FRESH session attached.
  let connectionEpochCount = 0;
  const reconnectWaiters = new Set<() => void>();
  const wakeReconnectWaiters = (): void => {
    for (const w of [...reconnectWaiters]) w();
  };
  const waitForReconnect = (sinceEpoch: number, timeoutMs: number): Promise<boolean> => {
    if (connectionEpochCount > sinceEpoch) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reconnectWaiters.delete(onConnection);
        resolve(v);
      };
      const onConnection = (): void => {
        if (connectionEpochCount > sinceEpoch) finish(true);
      };
      reconnectWaiters.add(onConnection);
      const timer = setTimeout(() => finish(false), timeoutMs);
    });
  };

  // ---- Mode resolution (local bind vs delegation vs port-held) -------------
  let mode: NativeBridgeMode = 'starting';
  /**
   * Why the port is held, when we know something more specific than "not a
   * Validity bridge" — currently a cross-platform holder. Surfaced verbatim in
   * the `port-held` navigate outcome (and therefore in BRIDGE_PORT_HELD).
   */
  let portHeldDetail: string | undefined;
  const modeWaiters: Array<(m: NativeBridgeMode) => void> = [];
  const resolveMode = (m: NativeBridgeMode): void => {
    if (mode !== 'starting') return;
    mode = m;
    for (const w of modeWaiters.splice(0)) w(m);
  };
  const whenReady = (): Promise<NativeBridgeMode> =>
    mode !== 'starting'
      ? Promise.resolve(mode)
      : new Promise<NativeBridgeMode>((r) => modeWaiters.push(r));

  // Delegation caches (refreshed by every /status probe + /navigate response).
  let remoteConnected = false;
  let remoteDevice: NativeBridgeDeviceInfo | null = null;
  const ingestRemoteStatus = (json: unknown): void => {
    if (!json || typeof json !== 'object') return;
    const body = json as Partial<BridgeStatusBody> & Partial<BridgeNavigateBody>;
    remoteConnected = body.connected === true;
    remoteDevice = coerceDeviceInfo(body.device) ?? remoteDevice;
  };

  const isConnected = (): boolean => {
    if (mode === 'delegated') return remoteConnected;
    const ws = activeSocket;
    return Boolean(ws && ws.readyState === ws.OPEN);
  };

  const deviceInfo = (): NativeBridgeDeviceInfo | null =>
    mode === 'delegated' ? remoteDevice : activeHello;

  /**
   * Compare a reported `Platform.OS` against the platform this run drives.
   * Returns null whenever the question cannot be ANSWERED — no expected
   * platform, no device info, an old companion that announces none — because
   * "I could not tell" and "they match" must not collapse into the same
   * answer here any more than anywhere else in this codebase.
   */
  const mismatchOf = (
    info: NativeBridgeDeviceInfo | null,
    source: NativeBridgePlatformMismatch['source'],
  ): NativeBridgePlatformMismatch | null => {
    if (!expectedPlatform || !info) return null;
    const actual = info.platform?.trim().toLowerCase();
    if (!actual || actual === expectedPlatform) return null;
    return { expected: expectedPlatform, actual, deviceId: info.deviceId, source, port };
  };

  const platformMismatch = (): NativeBridgePlatformMismatch | null =>
    mode === 'delegated'
      ? mismatchOf(remoteDevice, 'delegated-status')
      : mismatchOf(activeHello, 'hello');

  /** One sentence naming a cross-platform holder, reused by every refusal. */
  const crossPlatformDetail = (m: NativeBridgePlatformMismatch): string =>
    `port ${port} is held by a Validity bridge whose device is ${m.actual}` +
    `${m.deviceId ? ` (${m.deviceId})` : ''}, but this run drives ${m.expected} — refusing to ` +
    `delegate: that device would ack every navigate while the ${m.expected} device under test ` +
    `never renders. Free the port (lsof -ti tcp:${port} -sTCP:LISTEN) or stop the other validity ` +
    'CLI/MCP session, then retry';

  const send = (message: NativeBridgeServerMessage): boolean => {
    const ws = activeSocket;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      return false;
    }
    // Record the navigation intent only AFTER the write was accepted — a failed
    // write must never become the reconnect replay (see lastDriveMessage doc).
    if (message.type === 'navigate' || message.type === 'home') {
      lastDriveMessage = message;
    }
    return true;
  };

  const waitForRendered = (
    token: string,
    timeoutMs: number,
  ): Promise<NativeRenderedResult | null> => {
    // An ack that beat this call is already on file (see retainedAcks) — take
    // it and answer immediately. Consumed on read: an ack proves ONE render, so
    // a second wait on the same token must not be satisfied by the first one's
    // evidence.
    const retained = retainedAcks.get(token);
    if (retained) {
      retainedAcks.delete(token);
      return Promise.resolve(retained);
    }
    return new Promise<NativeRenderedResult | null>((resolve) => {
      let done = false;
      const finish = (v: NativeRenderedResult | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        renderWaiters.delete(token);
        resolve(v);
      };
      renderWaiters.set(token, (r) => finish(r));
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  };

  /** Wait for one `dev-menu-dismissed` ack; false on timeout. */
  const waitForDevMenuDismissed = (token: string, timeoutMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        devMenuWaiters.delete(token);
        resolve(v);
      };
      devMenuWaiters.set(token, finish);
      const timer = setTimeout(() => finish(false), timeoutMs);
    });

  /**
   * Local-socket dev-menu dismissal: capability-gate, push, await the ack.
   * Shared by the handle method and the HTTP endpoint a DELEGATED handle hops
   * through, so both paths enforce the same gate and the same ack semantics.
   */
  const dismissDevMenuLocally = async (timeoutMs: number): Promise<boolean> => {
    // Capability gate: an old companion silently drops an unknown message type,
    // so pushing one would just burn `timeoutMs` on an ack that cannot arrive.
    // A device that has not said hello yet reports no capabilities → treated as
    // incapable, which is the conservative read (never a fabricated success).
    const caps = deviceInfo()?.capabilities;
    if (!caps || !caps.includes(DISMISS_DEV_MENU_CAPABILITY)) return false;
    const token = mintDismissToken();
    if (!send({ type: 'dismiss-dev-menu', token })) return false;
    return waitForDevMenuDismissed(token, timeoutMs);
  };

  // ---- HTTP surface (status + delegated navigate) ---------------------------
  const server = createServer((req, res) => {
    const status = localRequestStatus(req, true);
    if (status) {
      res.writeHead(status);
      res.end(status === 415 ? 'application/json required' : 'Forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const respond = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    };
    if (req.method === 'GET' && url.pathname === '/status') {
      const body: BridgeStatusBody = {
        validityNativeBridge: true,
        connected: isConnected(),
        device: deviceInfo(),
      };
      respond(200, body);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/data') {
      // The device's boot fetch: hand back the current DATA payload (or null,
      // meaning "no host data yet — keep your baked fallback"). Marked with the
      // bridge signature so the device can distinguish a real Validity bridge
      // from some other process that happens to hold the port.
      respond(200, { validityNativeBridge: true, data: nativeData });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/nav-intents') {
      // DELEGATED READ: when another Validity process owns this port, its
      // bridge is the only one the device is connected to — so it is the only
      // one that sees nav intents. A delegated handle fetches them here, the
      // same way navigations hop through POST /navigate. Without this the
      // delegated caller reads an empty local list and the isolation
      // demotion silently never fires.
      const parsed = Number.parseInt(url.searchParams.get('sinceMs') ?? '', 10);
      const sinceMs = Number.isFinite(parsed) ? parsed : 0;
      respond(200, {
        validityNativeBridge: true,
        intents: navIntents.filter((n) => n.at >= sinceMs),
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/rendered-ack') {
      // DELEGATED READ, mirroring GET /nav-intents: the device is connected to
      // the bridge that OWNS the port, so only that process sees its acks. A
      // delegated handle reads one here after its deep-link rung confirmed the
      // paint; without this hop a delegated session keeps losing the perf /
      // network / console channels on every non-bridge-ack confirmation.
      void (async () => {
        const token = url.searchParams.get('token');
        if (!token) {
          respond(400, { error: 'token query param is required' });
          return;
        }
        const parsed = Number.parseInt(url.searchParams.get('timeoutMs') ?? '', 10);
        const timeoutMs = Math.min(
          Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
          MAX_HTTP_NAVIGATE_TIMEOUT_MS,
        );
        const ack = await waitForRendered(token, timeoutMs);
        const body: BridgeRenderedAckBody = {
          connected: isConnected(),
          device: deviceInfo(),
          ack,
        };
        respond(200, body);
      })();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/dismiss-dev-menu') {
      // DELEGATED WRITE, mirroring POST /navigate: when another Validity
      // process owns this port, the device is connected to IT, so only it can
      // push the dismissal. The delegated handle hops here and gets the
      // device's real answer back rather than assuming one.
      void (async () => {
        const parsed = Number.parseInt(url.searchParams.get('timeoutMs') ?? '', 10);
        const timeoutMs = Math.min(
          Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DISMISS_DEV_MENU_TIMEOUT_MS,
          MAX_HTTP_NAVIGATE_TIMEOUT_MS,
        );
        const dismissed = await dismissDevMenuLocally(timeoutMs);
        const body: BridgeDismissDevMenuBody = {
          connected: isConnected(),
          device: deviceInfo(),
          dismissed,
        };
        respond(200, body);
      })();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/navigate') {
      void (async () => {
        const message = asDriveMessage(await readJsonBody(req, 1_000_000));
        if (!message) {
          respond(400, { error: 'body must be a navigate/home message with a string token' });
          return;
        }
        const parsed = Number.parseInt(url.searchParams.get('timeoutMs') ?? '', 10);
        const timeoutMs = Math.min(
          Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HTTP_NAVIGATE_TIMEOUT_MS,
          MAX_HTTP_NAVIGATE_TIMEOUT_MS,
        );
        if (!send(message)) {
          const body: BridgeNavigateBody = {
            delivered: false,
            connected: isConnected(),
            device: deviceInfo(),
            ack: null,
          };
          respond(200, body);
          return;
        }
        const ack = await waitForRendered(message.token, timeoutMs);
        const body: BridgeNavigateBody = {
          delivered: true,
          connected: isConnected(),
          device: deviceInfo(),
          ack,
        };
        respond(200, body);
      })();
      return;
    }
    respond(404, { error: 'not found' });
  });

  // EADDRINUSE is the interesting failure: probe whoever holds the port. A live
  // Validity bridge → delegate through it (its /status also primes the
  // connected/device caches so callers can make warm/stale decisions before the
  // first navigate). Anything else → 'port-held', which the capture flow turns
  // into a loud BRIDGE_PORT_HELD error instead of a silent deep-link degrade.
  server.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      void httpJson({
        port,
        method: 'GET',
        path: '/status',
        timeoutMs: STATUS_PROBE_TIMEOUT_MS,
      }).then((res) => {
        const body = res?.json as Partial<BridgeStatusBody> | undefined;
        if (res && res.status === 200 && body?.validityNativeBridge === true) {
          ingestRemoteStatus(res.json);
          // PLATFORM BINDING. A live Validity bridge is normally exactly what we
          // want to delegate to — but not when it is driving the OTHER
          // platform's device. Delegating there is the silent misroute: the
          // navigations are delivered, the wrong companion acks them, and the
          // device under test is never touched. Refuse and say so.
          const cross = mismatchOf(remoteDevice, 'delegated-status');
          if (cross) {
            portHeldDetail = crossPlatformDetail(cross);
            resolveMode('port-held');
            return;
          }
          resolveMode('delegated');
        } else {
          resolveMode('port-held');
        }
      });
      return;
    }
    resolveMode('failed');
  });
  server.on('listening', () => resolveMode('local'));
  server.listen(port, '127.0.0.1');

  // A delegated handle can outlive the bridge it delegates to (e.g. the
  // long-lived MCP process delegated to a since-closed CLI bridge). When the
  // remote stops answering, try to claim the now-free port ourselves instead of
  // degrading; one attempt in flight at a time.
  let recovering = false;
  const tryRecoverLocal = (): Promise<boolean> => {
    if (mode === 'local') return Promise.resolve(true);
    if (recovering || mode === 'starting') return Promise.resolve(false);
    recovering = true;
    return new Promise<boolean>((resolve) => {
      const cleanup = (): void => {
        server.off('listening', onListening);
        server.off('error', onError);
        recovering = false;
      };
      const onListening = (): void => {
        cleanup();
        mode = 'local';
        resolve(true);
      };
      const onError = (): void => {
        cleanup();
        resolve(false);
      };
      server.once('listening', onListening);
      server.once('error', onError);
      try {
        server.listen(port, '127.0.0.1');
      } catch {
        cleanup();
        resolve(false);
      }
    });
  };

  const wss = new WebSocketServer({
    server,
    verifyClient: ({ req }, done) => done(localRequestStatus(req) === undefined, 403, 'Forbidden'),
  });

  // ws re-emits the underlying http server's errors on the WSS; without a
  // listener an EADDRINUSE would THROW (EventEmitter error semantics) even
  // though the server.on('error') handler above already classified it.
  wss.on('error', () => {
    /* handled via the http server's 'error' handler */
  });

  wss.on('connection', (ws) => {
    // One device at a time: a new connection (e.g. the app relaunched, or the
    // host restarted and the device reconnected) supersedes the old socket.
    if (activeSocket && activeSocket.readyState === activeSocket.OPEN) {
      try {
        activeSocket.close(1000, 'replaced by newer session');
      } catch {
        /* ignore */
      }
    }
    activeSocket = ws;
    activeHello = null; // identity belongs to a hello on THIS socket
    // The socket being open already means "connected"; wake any waiters. The
    // epoch bump (a NEW session attached) also wakes reload-reconnect waiters.
    connectionEpochCount += 1;
    wakeConnectionWaiters();
    wakeReconnectWaiters();

    // Heartbeat: WS readyState alone cannot see a half-open TCP connection (the
    // sim slept, the app was suspended) — the socket reads OPEN forever while
    // nothing is listening on the other end. Ping on a cadence; each ping
    // increments the missed counter and any pong resets it, so a peer that
    // stops answering is terminate()d after `maxMissedPongs` silent intervals
    // and isConnected() goes false instead of pinning a dead session warm.
    if (heartbeatIntervalMs > 0) {
      let missedPongs = 0;
      ws.on('pong', () => {
        missedPongs = 0;
      });
      const heartbeat = setInterval(() => {
        if (ws.readyState !== ws.OPEN) {
          clearInterval(heartbeat);
          return;
        }
        if (missedPongs >= maxMissedPongs) {
          clearInterval(heartbeat);
          try {
            ws.terminate(); // fires 'close' → activeSocket/activeHello clear below
          } catch {
            /* ignore */
          }
          return;
        }
        missedPongs += 1;
        try {
          ws.ping();
        } catch {
          /* ignore — the next interval re-checks readyState */
        }
      }, heartbeatIntervalMs);
      heartbeat.unref?.();
      ws.on('close', () => clearInterval(heartbeat));
    }

    // Replay the active target onto the freshly-(re)connected device. After a
    // reload the device boots back to the home list (its `target` state is gone);
    // re-pushing the last navigate restores the component the host is driving so
    // iteration stays pinned to it. Verbatim resend (same token, tagged
    // `replay: true`): any stale host-side render waiter for that token is
    // already resolved, so the device's ack is harmlessly ignored — and the tag
    // lets a device that did NOT reload (socket-only reconnect, or a replay
    // racing an in-flight newer navigate) ignore the resend instead of being
    // yanked back to an older target. No-op on the very first connection of a
    // session (nothing pushed yet) — the caller's own navigate drives that one.
    if (lastDriveMessage) {
      try {
        ws.send(JSON.stringify({ ...lastDriveMessage, replay: true }));
      } catch {
        /* ignore — the device will get the caller's next navigate regardless */
      }
    }

    ws.on('message', (data) => {
      let msg: DeviceMessage;
      try {
        const text = typeof data === 'string' ? data : data.toString('utf-8');
        msg = JSON.parse(text) as DeviceMessage;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello') {
        // Identity/freshness only from the ACTIVE socket (a superseded socket's
        // late hello must not overwrite the new session's info). Old companions
        // send a bare hello → every field stays undefined → callers degrade to
        // conservative behavior (no staleness check), never an error.
        if (ws === activeSocket) {
          activeHello = {
            contentHash: typeof msg.contentHash === 'string' ? msg.contentHash : undefined,
            deviceId: typeof msg.device?.id === 'string' ? msg.device.id : undefined,
            platform: typeof msg.device?.platform === 'string' ? msg.device.platform : undefined,
            capabilities: coerceCapabilities(msg.caps),
            mock: coerceMockStatus(msg.mock),
          };
        }
        wakeConnectionWaiters();
        return;
      }
      if (msg.type === 'nav-intent') {
        // The auto-mocked navigator on the device tried to navigate. Record it
        // with a timestamp so a check executor can ask "was a navigation
        // attempted while I was running?" and demote an assertion that the
        // screen changed — under isolation the mock swallows the navigation, so
        // such a check is UNDECIDABLE, not a product failure.
        navIntents.push({
          method: typeof msg.method === 'string' ? msg.method : 'navigate',
          at: Date.now(),
        });
        // Bound the buffer: a screen in a navigate loop must not grow this
        // without limit across a long session.
        if (navIntents.length > 200) navIntents.splice(0, navIntents.length - 200);
        return;
      }
      if (msg.type === 'dev-menu-dismissed' && typeof msg.token === 'string') {
        // `ok` is the device's honest answer: false when this binary has no
        // expo-dev-menu module or the native close rejected (nothing was
        // dismissed). Pass it through unchanged — the caller must be able to
        // tell "closed it" from "there was nothing I could close".
        const waiter = devMenuWaiters.get(msg.token);
        if (waiter) {
          devMenuWaiters.delete(msg.token);
          waiter(Boolean(msg.ok));
        }
        return;
      }
      if (msg.type === 'rendered' && typeof msg.token === 'string') {
        const result: NativeRenderedResult = {
          ok: Boolean(msg.ok),
          error: msg.error,
          unmatched: coerceUnmatched(msg.unmatched),
          matched: coerceMatched(msg.matched),
          consoleErrorCount: coerceConsoleErrorCount(msg.consoleErrorCount),
          perf: coercePerf(msg.perf),
        };
        const waiter = renderWaiters.get(msg.token);
        if (waiter) {
          renderWaiters.delete(msg.token);
          waiter(result);
          return;
        }
        // NOBODY IS WAITING (yet). Retain it instead of dropping it: on the
        // deep-link rung the host asks for this ack only after the tokenized
        // marker confirms the paint, and a late bridge ack is still honest
        // evidence for its token. Dropping it is what made
        // `expect.performance metric: mount` a per-sweep lottery — the render
        // was measured on device and the number died here. Bounded FIFO so a
        // session of unread acks can't grow without limit.
        retainedAcks.set(msg.token, result);
        while (retainedAcks.size > RETAINED_ACK_LIMIT) {
          const oldest = retainedAcks.keys().next();
          if (oldest.done) break;
          retainedAcks.delete(oldest.value);
        }
      }
    });
    ws.on('close', () => {
      if (activeSocket === ws) {
        activeSocket = null;
        activeHello = null;
      }
    });
    ws.on('error', () => {
      if (activeSocket === ws) {
        activeSocket = null;
        activeHello = null;
      }
    });
  });

  /** Hop a navigate through the bridge that owns the port; null = transport failure. */
  const delegateNavigate = async (
    message: NativeNavigateMessage | NativeHomeMessage,
    timeoutMs: number,
  ): Promise<NativeBridgeNavigateOutcome | null> => {
    const res = await httpJson({
      port,
      method: 'POST',
      path: `/navigate?timeoutMs=${timeoutMs}`,
      body: message,
      timeoutMs: timeoutMs + 2_000, // margin over the remote's own ack wait
    });
    if (!res || res.status !== 200) return null;
    ingestRemoteStatus(res.json);
    const body = res.json as Partial<BridgeNavigateBody> | undefined;
    if (!body?.delivered) return { kind: 'no-device' };
    if (!body.ack || typeof body.ack !== 'object') return { kind: 'ack-timeout' };
    return {
      kind: 'ack',
      result: {
        ok: Boolean(body.ack.ok),
        error: body.ack.error,
        unmatched: coerceUnmatched(body.ack.unmatched),
        matched: coerceMatched(body.ack.matched),
        consoleErrorCount: coerceConsoleErrorCount(body.ack.consoleErrorCount),
        perf: coercePerf(body.ack.perf),
      },
    };
  };

  // Named (not an object method) so the recursive retry after a successful
  // port recovery keeps working even if a caller destructures the handle.
  async function navigateOutcome(
    message: NativeNavigateMessage | NativeHomeMessage,
    timeoutMs: number,
  ): Promise<NativeBridgeNavigateOutcome> {
    const m = await whenReady();
    if (m === 'port-held') {
      return {
        kind: 'port-held',
        detail:
          portHeldDetail ??
          `port ${port} is held by a process that is not a Validity bridge — ` +
            `free it (lsof -ti tcp:${port}) or stop that process, then retry`,
      };
    }
    if (m === 'delegated' && mode === 'delegated') {
      // The holder may have had no device attached when we probed it, and
      // acquired the WRONG one since. Re-check before every hop: a delegated
      // navigate to the other platform's device comes back as a confident ack
      // for a render nobody under test performed.
      const cross = platformMismatch();
      if (cross) return { kind: 'port-held', detail: crossPlatformDetail(cross) };
      const out = await delegateNavigate(message, timeoutMs);
      if (out) return out;
      // The owning bridge stopped answering. Try to claim the freed port and
      // drive locally; if that also fails the port is effectively held.
      if (await tryRecoverLocal()) {
        return navigateOutcome(message, timeoutMs);
      }
      return {
        kind: 'port-held',
        detail:
          `port ${port} is held but the Validity bridge that owns it stopped answering — ` +
          `close the other validity session (CLI or MCP) holding it, then retry`,
      };
    }
    // 'local' (and 'failed', where no socket can exist → no-device, matching
    // the legacy degrade-to-deep-link behavior for non-EADDRINUSE bind errors),
    // plus a recovered ex-delegated handle that now owns the port.
    if (!send(message)) return { kind: 'no-device' };
    const ack = await waitForRendered(message.token, timeoutMs);
    return ack ? { kind: 'ack', result: ack } : { kind: 'ack-timeout' };
  }

  return {
    port,
    mode: () => mode,
    whenReady,
    send,
    isConnected,
    navIntentsSince: async (sinceMs: number) => {
      // In 'delegated' mode the DEVICE is connected to the bridge that owns the
      // port, so only that process sees nav intents — read them from it, the
      // same hop navigations take. Any failure degrades to "no intents", which
      // just means the demotion doesn't fire: never a fabricated one.
      if (mode === 'delegated') {
        try {
          const res = await httpJson({
            port,
            method: 'GET',
            path: `/nav-intents?sinceMs=${sinceMs}`,
            timeoutMs: STATUS_PROBE_TIMEOUT_MS,
          });
          const body = res?.json as { intents?: unknown } | undefined;
          return Array.isArray(body?.intents)
            ? (body.intents as Array<{ method: string; at: number }>)
            : [];
        } catch {
          return [];
        }
      }
      return navIntents.filter((n) => n.at >= sinceMs);
    },
    waitForConnection(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      const localWait = (): Promise<boolean> => {
        if (isConnected()) return Promise.resolve(true);
        if (mode === 'port-held' || mode === 'failed') return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
          let done = false;
          const finish = (v: boolean): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            connectionWaiters.delete(onConn);
            resolve(v);
          };
          const onConn = (): void => finish(true);
          connectionWaiters.add(onConn);
          const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()));
        });
      };
      return whenReady().then(async (m) => {
        if (m !== 'delegated') return localWait();
        // Delegated: poll the owning bridge's /status (also refreshes the
        // device-info cache the staleness check reads).
        for (;;) {
          const res = await httpJson({
            port,
            method: 'GET',
            path: '/status',
            timeoutMs: STATUS_PROBE_TIMEOUT_MS,
          });
          if (res) {
            ingestRemoteStatus(res.json);
          } else if (await tryRecoverLocal()) {
            // The owning bridge died and we claimed the port — wait locally.
            return localWait();
          }
          if (isConnected()) return true;
          if (Date.now() >= deadline) return false;
          await sleep(DELEGATED_STATUS_POLL_MS);
        }
      });
    },
    connectionEpoch: () => connectionEpochCount,
    waitForReconnect,
    async waitForRendered(token: string, timeoutMs: number) {
      // In 'delegated' mode the device's acks land on the bridge that owns the
      // port — read them over the same kind of hop navigations take. Any
      // failure degrades to "no ack" (null), which the caller reports as an
      // unmeasured render: never a fabricated timing.
      if (mode === 'delegated') {
        const res = await httpJson({
          port,
          method: 'GET',
          path: `/rendered-ack?token=${encodeURIComponent(token)}&timeoutMs=${timeoutMs}`,
          timeoutMs: timeoutMs + 2_000, // margin over the remote's own wait
        });
        if (!res || res.status !== 200) return null;
        ingestRemoteStatus(res.json);
        const body = res.json as Partial<BridgeRenderedAckBody> | undefined;
        const ack = body?.ack;
        if (!ack || typeof ack !== 'object') return null;
        return {
          ok: Boolean(ack.ok),
          error: ack.error,
          unmatched: coerceUnmatched(ack.unmatched),
          matched: coerceMatched(ack.matched),
          consoleErrorCount: coerceConsoleErrorCount(ack.consoleErrorCount),
          perf: coercePerf(ack.perf),
        };
      }
      return waitForRendered(token, timeoutMs);
    },
    navigate: navigateOutcome,
    async dismissDevMenu(timeoutMs = DEFAULT_DISMISS_DEV_MENU_TIMEOUT_MS) {
      const m = await whenReady();
      // Nothing to talk to. Deliberately NOT an error: a dismissal is a
      // best-effort hygiene step, and the caller's next observation is what
      // actually decides whether the screen is readable.
      if (m === 'port-held' || m === 'failed') return false;
      if (m === 'delegated' && mode === 'delegated') {
        const res = await httpJson({
          port,
          method: 'POST',
          path: `/dismiss-dev-menu?timeoutMs=${timeoutMs}`,
          body: {},
          timeoutMs: timeoutMs + 2_000, // margin over the remote's own ack wait
        });
        if (!res || res.status !== 200) return false;
        ingestRemoteStatus(res.json);
        const body = res.json as Partial<BridgeDismissDevMenuBody> | undefined;
        return body?.dismissed === true;
      }
      return dismissDevMenuLocally(timeoutMs);
    },
    deviceInfo,
    platformMismatch,
    setNativeData(payload) {
      nativeData = payload;
    },
    close() {
      resolveMode('failed'); // unblock whenReady() waiters if we never settled
      try {
        wss.close();
      } catch {
        /* ignore */
      }
      try {
        server.close();
      } catch {
        /* ignore */
      }
      if (activeSocket && activeSocket.readyState === activeSocket.OPEN) {
        try {
          activeSocket.close(1001, 'server shutting down');
        } catch {
          /* ignore */
        }
      }
      activeSocket = null;
      activeHello = null;
      lastDriveMessage = null;
      nativeData = null;
      renderWaiters.clear();
      retainedAcks.clear();
      devMenuWaiters.clear();
      connectionWaiters.clear();
      reconnectWaiters.clear();
    },
  };
}
