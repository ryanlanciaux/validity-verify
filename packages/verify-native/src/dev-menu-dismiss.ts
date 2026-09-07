/**
 * ONE dev-menu dismissal, shared by every place that needs the Expo dev menu
 * out of the way (the cold-boot hygiene sweep, the paint cross-check retry, and
 * the snapshot-settle gate).
 *
 * ── Why the menu is there at all ─────────────────────────────────────────────
 *
 * Not a flake, and not something the run provoked: `DevMenuFragment.onCreate`
 * in expo-dev-menu opens the menu whenever
 *
 *     preferences.showsAtLaunch || !preferences.isOnboardingFinished
 *
 * and `isOnboardingFinished` defaults to FALSE (`DevMenuPreferences.kt`),
 * flipping to true only when a human taps through the onboarding sheet. The
 * Validity companion is provisioned by the installer and never hand-driven, so
 * that preference is false for the life of the install and the menu auto-opens
 * on EVERY React-context init — every launch, and every reload.
 *
 * It is a MODAL bottom sheet, so it takes the accessibility tree with it: the
 * per-navigation render marker (`validity-root:<token>`) is not visible
 * underneath it, so the paint cross-check misses and demotes a perfectly good
 * render to `unconfirmed`, and any a11y check that ran there would be reading
 * the menu instead of the app.
 *
 * ── The two rungs, in order ──────────────────────────────────────────────────
 *
 *  1. BRIDGE (preferred, both platforms). Ask the companion to call
 *     expo-dev-menu's own `ExpoDevMenu.closeMenu()` on itself. It is a native
 *     state write with an ack, it cannot mis-click, it cannot navigate the app
 *     anywhere, and it works identically on iOS and Android because the module
 *     name and method are the same on both.
 *  2. DRIVER (fallback, effectively iOS-only). The historical snapshot +
 *     ref-click by dismiss label, gated on positive dev-menu detection. On
 *     Android no label on the SDK-55 sheet dismisses it (see
 *     ANDROID_DEV_MENU_LABELS), so this rung deliberately no-ops there.
 *
 * There is deliberately no third rung. BACK was tried and reverted: once the
 * menu is gone a BACK lands on the app root and exits to the launcher, so a
 * stale snapshot could walk the app out from under the run — and evidence
 * captured of the Android home screen is worse than evidence captured behind a
 * menu, because at least the latter is reported `unconfirmed`.
 *
 * Every rung is best-effort and TRUE means "something was actually dismissed".
 * A caller must be able to distinguish that from "nothing could be dismissed",
 * because the honest response to the latter is to keep observing, not to assume
 * the screen is now readable.
 */
import type { NativeDriver } from './agent-device-driver.js';
import type { NativeBridgeHandle } from './native-bridge.js';

/** A bounded, best-effort dev-menu dismissal. Resolves true iff one happened. */
export type DevMenuDismisser = () => Promise<boolean>;

/**
 * Compose the bridge + driver rungs into a single dismisser.
 *
 * The bridge rung is skipped without a connected device (it would just burn its
 * ack timeout) and is itself capability-gated inside the handle, so an old
 * companion binary falls straight through to the driver rung. Both rungs are
 * try/caught: a dismissal is hygiene, and a transport failure in it must never
 * propagate into the capture it was protecting.
 */
export function makeDevMenuDismisser(
  driver: NativeDriver,
  bridge?: NativeBridgeHandle,
  opts: { timeoutMs?: number } = {},
): DevMenuDismisser {
  return async () => {
    if (bridge?.isConnected()) {
      try {
        if (await bridge.dismissDevMenu(opts.timeoutMs)) return true;
      } catch {
        // Fall through to the driver rung — a bridge transport failure says
        // nothing about whether the menu is up.
      }
    }
    try {
      return await driver.dismissDevMenu();
    } catch {
      return false;
    }
  };
}
