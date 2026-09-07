/**
 * Android dev-client → host Metro reachability.
 *
 * An iOS simulator shares the host's network, so the dev-client reaches the
 * companion Metro at `http://localhost:8082` directly. An Android emulator
 * does NOT — `localhost` inside the guest is the emulator itself, so the
 * dev-client's bundle fetch from `localhost:8082` times out. `adb reverse`
 * forwards the guest's `tcp:8082` to the host's `tcp:8082`, making the same
 * `localhost:8082` control link work on Android — so we keep ONE deep-link
 * contract across platforms instead of rewriting the URL to `10.0.2.2`.
 *
 * Scoped to APP/DEV-CLIENT LAUNCHES since agent-device 0.20.5, which
 * auto-configures host reachability for its own URL opens — see
 * {@link AndroidReversePurpose} for why that does not cover either port
 * Validity forwards.
 *
 * Pure command-builder + injectable runner (no device needed to unit-test).
 */
import { defaultRunner, type CommandRunner, type PlannedCommand } from './agent-device-driver.js';

/** The companion Metro port we reverse-forward on Android (matches COMPANION_METRO_PORT). */
export const COMPANION_REVERSE_PORT = 8082;

/** Build the `adb reverse tcp:<port> tcp:<port>` command (optionally pinned to a device serial). */
export function androidReverseCommand(
  port: number = COMPANION_REVERSE_PORT,
  device?: string,
): PlannedCommand {
  const base = ['reverse', `tcp:${port}`, `tcp:${port}`];
  return { bin: 'adb', args: device ? ['-s', device, ...base] : base };
}

/**
 * WHY this forward is still ours to set up on agent-device 0.20.5.
 *
 * 0.20.5's release notes say "Android URL opens auto-configure host
 * reachability", which reads like it makes `adb reverse` obsolete. It does
 * not — for either of the two ports Validity forwards:
 *
 *  - the COMPANION METRO port (8082) is reached by the dev-client's own bundle
 *    fetch, made by the APP after it is launched, not by the URL agent-device
 *    opens. Upstream can only configure reachability for a host it is told
 *    about, on an open it performs; Validity's cold path also falls back to
 *    `adb shell am start` (see openUrlWithNativeFallback), which agent-device
 *    never sees at all;
 *  - the CONTROL BRIDGE port (8083) is dialed OUT of the guest by the companion
 *    app to Validity's own WebSocket server. agent-device has no knowledge of
 *    that socket, and nothing upstream will ever forward it.
 *
 * So the gate this function carries is not "old versions need it" — it is
 * PURPOSE. It is asserted for app/dev-client launches (where the app itself
 * dials the host) and is NOT a precondition of opening an http(s) URL on the
 * device, which is the case 0.20.5 handles on its own.
 */
export type AndroidReversePurpose =
  /** Launching the app / dev-client, which then reaches host Metro or the bridge itself. */
  | 'app-launch'
  /**
   * Opening an http(s) URL through `agent-device open`. 0.20.5 configures the
   * reachability for this case, so Validity does not — asserting it anyway
   * would be a redundant `adb` spawn per open, and (worse) would leave a
   * forward in place for a port nothing on this path uses.
   */
  | 'url-open';

/**
 * Ensure the Android emulator/device can reach a host port by setting up
 * `adb reverse`. No-op (returns true) on iOS.
 *
 * `purpose` defaults to `'app-launch'` — the case every existing caller is, and
 * the one agent-device does not cover (see {@link AndroidReversePurpose}). A
 * `'url-open'` caller returns true WITHOUT spawning adb, because upstream
 * configures that path itself.
 *
 * Best-effort: returns false on failure rather than throwing, so the caller can
 * proceed (the cold open will surface a clearer error if the bundle truly can't
 * load).
 */
export async function ensureAndroidReverse(
  platform: 'ios' | 'android',
  device?: string,
  run: CommandRunner = defaultRunner,
  port: number = COMPANION_REVERSE_PORT,
  purpose: AndroidReversePurpose = 'app-launch',
): Promise<boolean> {
  if (platform === 'ios') return true;
  // agent-device 0.20.5 auto-configures host reachability for URL opens; a
  // second, manual forward here would buy nothing and cost a spawn per open.
  if (purpose === 'url-open') return true;
  try {
    const cmd = androidReverseCommand(port, device);
    const res = await run(cmd.bin, cmd.args);
    return res.code === 0;
  } catch {
    return false;
  }
}
