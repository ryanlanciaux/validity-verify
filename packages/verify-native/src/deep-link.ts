/**
 * Deep-link builder for the React Native playground.
 *
 * The native harness uses the SAME target contract as web — a component
 * path plus optional fixture / scenario / base64-encoded prop overrides —
 * delivered over a URL. This module turns a {@link TargetSpec} into a URL
 * and the shell command that opens it on the chosen device, so an agent (or
 * `validity browse --native`) can cold-open "navigate to ComponentX".
 *
 * Pure string building — no shelling out here (the caller runs the command),
 * which keeps it deterministic and unit-testable without a device.
 */

import type { NativeViewItem, NativeScenarioSeedWire } from './prepare-native.js';
import type { NativeMockNetworkData } from './network-native.js';

export type NativeTarget = 'ios' | 'android' | 'expo-go';

export interface TargetSpec {
  /** Project-relative component/screen path, e.g. "src/components/Button.tsx". One of component | view. */
  component?: string;
  /** A named view (composition of components), e.g. "Button Variants". One of component | view. */
  view?: string;
  /**
   * Resolved view items, shipped INLINE (base64 JSON in the `items=` param) so a
   * cold deep-link renders the view directly instead of relying on the bundled
   * registry map — the ephemeral-views path, the native analog of `overrides`.
   * Only meaningful alongside `view`.
   */
  viewItems?: NativeViewItem[];
  /** Optional fixture name from config. */
  fixture?: string;
  /** Optional scenario id from config. */
  scenario?: string;
  /**
   * Resolved scenario context seed (wire format) shipped INLINE over the BRIDGE
   * navigate so a scenario edit reaches a warm device as data — no rebuild.
   * NOT encoded into the deep-link URL: the cold/deep-link path picks up fresh
   * scenario data via the device's boot fetch of the bridge's GET /data instead.
   */
  scenarioSeed?: NativeScenarioSeedWire;
  /**
   * Resolved mock-network config shipped INLINE over the BRIDGE navigate so a
   * mock-handler edit reaches a warm device as data — applied before the target
   * renders. Like {@link scenarioSeed} it is delivered via the boot fetch on the
   * cold/deep-link path, not the URL.
   */
  mockNetwork?: NativeMockNetworkData;
  /** Optional explicit prop overrides (encoded as base64 JSON in the URL). */
  overrides?: Record<string, unknown>;
  /**
   * Color scheme (theme) to force for this target — the verify color-scheme
   * axis. Travels over the bridge navigate AND (unlike scenarioSeed) in the
   * deep-link URL as `theme=` so the cold path themes too. Absent → default.
   */
  colorScheme?: 'light' | 'dark';
  /**
   * Per-navigation token. On the deep-link path the harness echoes it as the
   * render-marker testID (`validity-root:<token>`), so the host's waitForRef
   * confirms THIS navigation painted — a stale previous render (which carries
   * the previous token, or no token) can't satisfy the wait. Absent → the
   * harness falls back to the legacy shared `validity-root` marker.
   */
  token?: string;
}

export interface BuildDeepLinkOptions {
  target: NativeTarget;
  /**
   * Custom URL scheme for ios/android cold opens (e.g. "myapp"). Required
   * for ios/android; ignored for expo-go.
   */
  scheme?: string;
  /** Metro host:port for the Expo Go `exp://` form. Default `localhost:8081`. */
  expoHost?: string;
}

export interface DeepLink {
  /** The fully-formed deep-link URL. */
  url: string;
  /** The shell command that opens it on the target device. */
  command: string;
}

/** Base64-encode a JSON value the same way the web flyout encodes prop overrides. */
export function encodeOverrides(overrides: Record<string, unknown>): string {
  // Buffer is available in the CLI/MCP runtime (Node); the harness decodes
  // with the RN-polyfilled global atob.
  return Buffer.from(JSON.stringify(overrides), 'utf-8').toString('base64');
}

/** Base64-encode resolved view items for the `items=` param (same scheme as overrides). */
export function encodeViewItems(items: NativeViewItem[]): string {
  return Buffer.from(JSON.stringify(items), 'utf-8').toString('base64');
}

function buildQuery(spec: TargetSpec): string {
  const params = new URLSearchParams();
  // A view is a composition; otherwise a single component/screen. Same
  // ?view= / ?component= contract as the web sandbox.
  if (spec.view) params.set('view', spec.view);
  else if (spec.component) params.set('component', spec.component);
  if (spec.fixture) params.set('fixture', spec.fixture);
  if (spec.scenario) params.set('scenario', spec.scenario);
  // Theme for the color-scheme axis — in the URL so the cold/deep-link path
  // themes too (parsed by ValidityNativeRoot's `?theme=` handling).
  if (spec.colorScheme) params.set('theme', spec.colorScheme);
  // Per-navigation render-marker token (see TargetSpec.token).
  if (spec.token) params.set('token', spec.token);
  if (spec.overrides && Object.keys(spec.overrides).length > 0) {
    params.set('overrides', encodeOverrides(spec.overrides));
  }
  // Ship the resolved view inline so a cold deep-link renders it without a
  // baked registry entry (the ephemeral-views path).
  if (spec.view && spec.viewItems && spec.viewItems.length > 0) {
    params.set('items', encodeViewItems(spec.viewItems));
  }
  return params.toString();
}

/**
 * Build the target URL for a device. The path segment is always
 * `validity` so the harness can route on it:
 *   - ios/android: `<scheme>://validity?component=…`
 *   - expo-go:     `exp://<host>/--/validity?component=…`
 */
export function buildTargetUrl(spec: TargetSpec, opts: BuildDeepLinkOptions): string {
  const query = buildQuery(spec);
  if (opts.target === 'expo-go') {
    const host = opts.expoHost ?? 'localhost:8081';
    return `exp://${host}/--/validity?${query}`;
  }
  const scheme = opts.scheme;
  if (!scheme) {
    throw new Error(
      `A custom URL scheme is required to deep-link on ${opts.target}. ` +
        'Validity derives a companion-unique scheme automatically (prepareNativeApp) — pass ' +
        "that app.scheme. Do NOT reuse your own app's scheme (both apps would register it and " +
        'deep links would open the wrong one); use the Expo Go target for pure-JS components.',
    );
  }
  return `${scheme}://validity?${query}`;
}

/**
 * Build the expo-dev-client CONTROL deep link that tells an installed dev
 * build which Metro to connect to and load. On a COLD launch the dev launcher
 * intercepts an app deep link (e.g. `<scheme>://validity?…`) and shows its
 * own UI instead of routing to JS — because no bundle is loaded yet. Opening
 * this control link first makes the launcher connect to `metroUrl` and load
 * the bundle, after which a subsequent `<scheme>://validity?…` is delivered to
 * JS via Linking. See expo-dev-launcher's `expo-development-client` URL host.
 *
 *   `<scheme>://expo-development-client/?url=<url-encoded metroUrl>`
 */
export function buildDevClientLoadUrl(scheme: string, metroUrl = 'http://localhost:8081'): string {
  if (!scheme) {
    throw new Error(
      'A custom URL scheme is required to build the dev-client control link. ' +
        'Validity derives a companion-unique scheme automatically (prepareNativeApp) — pass ' +
        'that app.scheme; only set native.scheme to override it deliberately, never to match ' +
        "your own app's scheme.",
    );
  }
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`;
}

function shellQuote(s: string): string {
  // Double-quote and escape embedded double quotes / backticks / $.
  return `"${s.replace(/(["`$\\])/g, '\\$1')}"`;
}

/**
 * Single-quote for the DEVICE-side shell inside an `adb shell` command.
 * `adb shell` re-joins its arguments into one line that the device's `sh`
 * parses again, so host-side quoting alone lets a bare `&` in the query
 * string (`?component=…&token=…`) background `am start` and truncate the URL
 * at the `&` — the deep link arrives without its token and the render never
 * confirms. Mirrors deviceShellQuote in agent-device-driver.ts; verified live
 * on an API 35 emulator.
 */
function deviceQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the URL + the command to open it on the target device.
 *   ios     → xcrun simctl openurl booted "<url>"
 *   android → adb shell am start -a android.intent.action.VIEW -d "<url>"
 *   expo-go → npx uri-scheme open "<url>" (works for the exp:// form too)
 */
export function buildDeepLink(spec: TargetSpec, opts: BuildDeepLinkOptions): DeepLink {
  const url = buildTargetUrl(spec, opts);
  let command: string;
  switch (opts.target) {
    case 'ios':
      command = `xcrun simctl openurl booted ${shellQuote(url)}`;
      break;
    case 'android':
      // The inner single quotes must SURVIVE the host shell so the device
      // `sh` sees them — hence device-quote first, host-quote around it.
      command = `adb shell ${shellQuote(`am start -a android.intent.action.VIEW -d ${deviceQuote(url)}`)}`;
      break;
    case 'expo-go':
      command = `npx uri-scheme open ${shellQuote(url)}`;
      break;
    default: {
      const _exhaustive: never = opts.target;
      throw new Error(`Unknown native target: ${String(_exhaustive)}`);
    }
  }
  return { url, command };
}
