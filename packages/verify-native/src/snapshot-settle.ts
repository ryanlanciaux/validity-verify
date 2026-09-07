/**
 * Snapshot-stability gate for the NATIVE capture path — the structural fix for
 * the cold-start check-race (Bug 6, dogfood round 2).
 *
 * The companion's bridge `rendered` ack fires after its JS mountAnimationFrame
 * (ValidityNativeRoot), which proves the COMPONENT view mounted — but a COLD
 * bundle build keeps the expo-dev-client's "Refreshing…" / "Building bundle"
 * overlay on top of that view for several seconds afterward. An a11y check that
 * reads the tree in that window resolves against the LOADING screen (a
 * `heading-visible` presence check returned `presence:false` while the SAME
 * response's later final a11y snapshot already contained the heading node — a
 * warm re-run passed), so a false FAIL resets the certification streak and
 * opens a bogus regression signal. The check executor's own `resolveOnDevice`
 * re-snapshot loop is too short (≈1.25s) to outrun a cold Metro build, so the
 * gate is placed BEFORE the check loop at the capture level, where a single
 * bound sized to a real cold build lives.
 *
 * Settled = two consecutive a11y snapshots serialize EQUAL AND the agreed
 * frame carries NO dev-client loading marker AND the Expo DEV MENU is not on
 * top. Equality alone is not enough: a frozen "Refreshing…" overlay is
 * byte-identical across snapshots yet still hides the real UI, so the marker
 * check must ALSO clear.
 *
 * The dev-menu clause is the fix for the `heading-visible` flake (dogfood
 * 2026-07-27): after a cold `--clear` bundle build, expo-dev-client presents
 * its dev MENU on top of the freshly-rendered component. That surface is
 * byte-stable for many seconds and contains none of the loading markers above
 * ('Go home' / 'Toggle performance monitor' / 'Fast refresh' — note 'Fast
 * refresh' does NOT contain 'refreshing'), so the marker+equality gate declared
 * it settled and the FIRST criterion of the run resolved against the dev-menu
 * tree and hard-FAILED, while every later criterion passed because the menu had
 * been dismissed by then. A hard check that flips on rerun is exactly the
 * false-red this gate exists to prevent, so the menu is now both DETECTED (via
 * {@link snapshotShowsDevMenu}, which refuses to fire on user UI that merely
 * has a 'Close' button) and DISMISSED — waiting it out would just burn the
 * timeout, since nothing dismisses it on its own.
 *
 * Why it is up at all is not a race and not a flake: expo-dev-menu's
 * `DevMenuFragment.onCreate` opens the menu whenever
 * `showsAtLaunch || !isOnboardingFinished`, and `isOnboardingFinished` defaults
 * to false until a human taps through the onboarding sheet — which on an
 * installer-provisioned companion never happens. So it opens on EVERY
 * React-context init. The dismissal that actually works is the companion
 * closing its own menu over the control bridge; the capture flow injects it
 * here as `opts.dismissDevMenu` (see `makeDevMenuDismisser`), because the
 * driver's label-click fallback has nothing to click on Android's SDK-55 sheet.
 *
 * Note what happens if detection ever STOPS firing (Expo renames the menu
 * entries): the menu is byte-stable and marker-free, so the gate SETTLES on it
 * and the false red returns with no warning anywhere. There is no safe
 * degradation here — which is why the anchors carry a conclusive-on-their-own
 * tier and a date-stamped verified-against version. See
 * {@link DEV_MENU_SPECIFIC_ANCHORS}.
 *
 * On timeout the gate
 * returns `settled:false` and the capture ALWAYS proceeds — the gate is
 * advisory and must never itself fail a capture (a pathological never-settling
 * device still produces a screenshot); the outcome is made observable through
 * the caller's warning channel so a false-FAIL can be traced back to a race.
 *
 * Cost on a warm/stable tree: ONE interval (snapshot A → wait → snapshot B) —
 * cheap enough that running the gate on every CONFIRMED render (so it protects
 * the evidence screenshot and every scenario/fixture variant, not just the one
 * target that carries checks) is the cleaner choice over a feature flag.
 */
import { snapshotShowsDevMenu, type NativeDriver } from './agent-device-driver.js';

/**
 * dev-client loading overlays that leak into the a11y snapshot as quoted node
 * labels. Matched as case-insensitive SUBSTRING over the snapshot's text
 * content (the snapshot is newline-delimited `# @eNN [role] "label"` rows; a
 * marker inside any quoted label — "Refreshing…", "Building JavaScript
 * bundle" — counts). Kept deliberately short: only the strings the
 * expo-dev-client actually paints during a cold build; user components that
 * happen to contain one of these words are vanishingly rare and the
 * equality-of-consecutive-snapshots half of the gate still protects them (a
 * real UI frame that doesn't change AND contains the word still has to match
 * the next frame too, so a transient marker-bearing frame can't false-stall).
 */
export const DEV_CLIENT_LOADING_MARKERS = [
  'refreshing',
  'downloading',
  'building javascript bundle',
  'bundling',
] as const;

/**
 * How many times the gate will try to dismiss the Expo dev menu in one wait.
 * Bounded so a menu that refuses to close (or a mis-detection) can't turn the
 * gate into a click loop against the screen under verification — after the cap
 * the gate simply stops clicking and rides out the timeout, reporting
 * `settled:false` so the race stays observable.
 */
export const MAX_DEV_MENU_DISMISS_ATTEMPTS = 3;

/** Default polling interval for {@link waitForSettledSnapshot} (ms). */
export const DEFAULT_SETTLE_GATE_INTERVAL_MS = 400;
/** Default gate timeout for a COLD open (ms) — sized to a real Metro cold build. */
export const DEFAULT_SETTLE_GATE_COLD_MS = 10000;
/** Default gate timeout for a WARM re-target (ms) — a warm app settles fast. */
export const DEFAULT_SETTLE_GATE_WARM_MS = 2500;

/**
 * Does the snapshot's text content contain a dev-client loading marker?
 * Case-insensitive substring over the whole snapshot (role + label text).
 * PURE — unit-tested without a device.
 */
export function snapshotHasDevClientLoadingMarker(snapshot: string): boolean {
  const lower = snapshot.toLowerCase();
  return DEV_CLIENT_LOADING_MARKERS.some((m) => lower.includes(m));
}

export interface SettledSnapshotOutcome {
  /** True once two consecutive snapshots agreed AND neither carried a loading marker. */
  settled: boolean;
  /** Wall-clock ms spent in the gate (0 when the baseline snapshot itself threw). */
  waitedMs: number;
  /**
   * How many times the gate dismissed the Expo dev menu while waiting. Non-zero
   * means the checks below WOULD have raced the dev-menu overlay on the old
   * gate — useful when diagnosing a run that used to flake.
   */
  devMenuDismissals: number;
  /**
   * How the gate spent its waits: `wait-stable` when agent-device's quiescence
   * primitive drove them, `interval` when it fell back to a fixed sleep. Purely
   * observational — it exists so a regression can be attributed to the wait
   * mechanism instead of guessed at.
   */
  waitMode?: 'wait-stable' | 'interval';
  /** Total interactive-tree captures `wait stable` reported across the gate. */
  waitStableCaptures?: number;
}

/**
 * Default quiet window handed to `agent-device wait stable` (ms).
 *
 * Matches upstream's own default. Deliberately NOT tied to
 * {@link DEFAULT_SETTLE_GATE_INTERVAL_MS}: that 400ms is a blind sleep between
 * two full snapshots, whereas this is how long the INTERACTIVE tree must hold
 * still before upstream calls it quiet — different jobs, and coupling them
 * would make one number's tuning silently retune the other.
 */
export const WAIT_STABLE_QUIET_MS = 500;

/**
 * Outcome of {@link settleUnconfirmed}. Observational only — nothing here may
 * ever upgrade a render status.
 */
export interface UnconfirmedSettleOutcome {
  /** How the budget was spent. */
  via: 'wait-stable' | 'sleep';
  /** Wall-clock ms actually spent. */
  waitedMs: number;
  /**
   * `wait stable`'s own verdict, when that rung ran: TRUE means the interactive
   * tree held still, FALSE means it never did within the budget.
   *
   * NOT a render confirmation, and the distinction is the whole reason this
   * field is named `stable` and not `settled`: `wait stable` polls the
   * INTERACTIVE tree, which on Android omits standalone static `<Text>` (see
   * `NativeDriver.waitStable`) — it has been measured calling a 4-node tree
   * quiet while the heading under verification had not painted. The caller's
   * render status stays `unconfirmed` either way; this only says how the wait
   * ended.
   */
  stable?: boolean;
}

/**
 * The wait taken when a render was NEVER CONFIRMED — no bridge ack, no paint
 * marker — and the capture is about to return `unconfirmed` anyway.
 *
 * What it replaces: a blind fixed sleep (1200ms) chosen to be "probably enough"
 * for a transition nobody could observe. `agent-device wait stable` is strictly
 * better AS A WAIT — it returns the moment the interactive tree stops moving,
 * so a screen that has already stopped costs a fraction of the budget, and one
 * that is still moving gets the full budget instead of an arbitrary slice of it.
 *
 * What it deliberately does NOT do: change the verdict. The caller reports
 * `unconfirmed` before and after this call, because nothing here proves the
 * requested target painted — a quiet tree is quiet, not correct. The fast paths
 * that CAN prove it (the companion's bridge ack, the per-token render marker)
 * run earlier and are untouched.
 *
 * Never throws: a driver without `waitStable`, or one whose call rejects, falls
 * back to the same sleep this replaced, so the worst case is exactly today's
 * behavior.
 */
export async function settleUnconfirmed(
  driver: NativeDriver,
  opts: {
    /** Total budget (ms) — the fixed sleep's duration, and the wait's deadline. */
    budgetMs: number;
    delay: (ms: number) => Promise<void>;
    /** Quiet window for `wait stable`. Defaults to {@link WAIT_STABLE_QUIET_MS}. */
    quietMs?: number;
    /** Monotonic clock (tests inject; production uses Date.now). */
    now?: () => number;
  },
): Promise<UnconfirmedSettleOutcome> {
  const now = opts.now ?? (() => Date.now());
  const start = now();
  if (typeof driver.waitStable === 'function') {
    try {
      const res = await driver.waitStable(opts.quietMs ?? WAIT_STABLE_QUIET_MS, opts.budgetMs);
      return { via: 'wait-stable', waitedMs: now() - start, stable: res.settled };
    } catch {
      /* no such primitive on this binary/device — fall through to the sleep */
    }
  }
  await opts.delay(opts.budgetMs);
  return { via: 'sleep', waitedMs: now() - start };
}

/**
 * Bounded snapshot-stability gate. Loop: snapshot A → wait → snapshot B;
 * settled when `A === B` (serialized) AND `B` carries no
 * {@link DEV_CLIENT_LOADING_MARKERS loading marker}. Continue until settled or
 * `timeoutMs` elapses; on timeout return `settled:false` (the caller ALWAYS
 * proceeds — the gate must never fail a capture).
 *
 * The WAIT is `agent-device wait stable` when the driver exposes it (see
 * `NativeDriver.waitStable`), falling back to a fixed `intervalMs` sleep
 * otherwise. That primitive returns the moment the interactive tree stops
 * moving, so a warm screen leaves the gate in a fraction of an interval and a
 * cold Metro build is absorbed by upstream's own polling instead of by a
 * sequence of blind 400ms sleeps.
 *
 * What did NOT change, and must not: the VERDICT. `wait stable` polls the
 * interactive-only tree, which on Android omits standalone static `<Text>` —
 * measured on the Ignite WelcomeScreen, where it reported a settled tree of 4
 * nodes while the heading and body copy were on screen. Trusting it as the
 * verdict would reintroduce exactly the false-green this gate was built to
 * stop, so byte-equality over the gate's own full snapshots still decides, and
 * the loading-marker and dev-menu clauses (Expo semantics agent-device cannot
 * know) are untouched.
 *
 * The clock is injectable (`now`) so the loop is unit-testable without real
 * wall-clock advancement (tests pass a no-op `delay` and advance a fake clock
 * via `now`); production uses `Date.now`. A snapshot that THROWS mid-gate is
 * tolerated: the baseline throw short-circuits to `settled:true` (nothing to
 * gate on — proceed), and a throw on a later frame discards that frame and
 * keeps polling (a transient device hiccup shouldn't abort the gate; the next
 * snapshot may recover — and a chronically-failing snapshot just hits the
 * timeout and reports `settled:false`, which is exactly the observable outcome
 * a never-settling device deserves).
 */
export async function waitForSettledSnapshot(
  driver: NativeDriver,
  opts: {
    timeoutMs: number;
    intervalMs: number;
    delay: (ms: number) => Promise<void>;
    /** Monotonic clock in ms (tests inject a fake; production uses Date.now). */
    now?: () => number;
    /**
     * How the gate dismisses a detected Expo dev menu. Defaults to the driver's
     * own snapshot+ref-click, which is the right fallback but a NO-OP on
     * Android — the SDK-55 sheet exposes no label that dismisses it (see
     * ANDROID_DEV_MENU_LABELS). The capture flow injects the bridge-backed
     * dismisser instead (`makeDevMenuDismisser`), which asks the companion to
     * close the menu on itself and works on both platforms.
     *
     * Contract: resolves TRUE only when something was actually dismissed. The
     * gate counts only true dismissals against
     * {@link MAX_DEV_MENU_DISMISS_ATTEMPTS}, so a no-op rung can neither
     * exhaust the budget nor be reported as a heal that never happened.
     */
    dismissDevMenu?: () => Promise<boolean>;
    /**
     * Set false to force the fixed-interval sleep and skip `agent-device wait
     * stable` entirely. Default true (use it when the driver offers it). Exists
     * for tests and as an escape hatch if the primitive ever misbehaves on a
     * given device — not something callers should need to set.
     */
    waitStable?: boolean;
  },
): Promise<SettledSnapshotOutcome> {
  const now = opts.now ?? (() => Date.now());
  const dismissDevMenu = opts.dismissDevMenu ?? (() => driver.dismissDevMenu());
  const start = now();
  let devMenuDismissals = 0;
  // `wait stable` is the PRIMARY wait; the fixed sleep is the fallback. The
  // mode is latched on first use (and demoted for good if the primitive
  // rejects) so one flaky call can't make the gate alternate between two
  // different wait characteristics mid-run.
  const useWaitStable = opts.waitStable !== false && typeof driver.waitStable === 'function';
  let waitMode: 'wait-stable' | 'interval' = useWaitStable ? 'wait-stable' : 'interval';
  let waitStableCaptures: number | undefined;

  /**
   * One wait. Prefers agent-device's own quiescence primitive, which returns as
   * soon as the interactive tree stops moving instead of always paying a full
   * interval, and falls back to the fixed sleep on any rejection.
   *
   * Its RESULT is intentionally not used to decide anything: on Android the
   * interactive tree it polls omits standalone static text (see
   * `NativeDriver.waitStable`), so it can report a settled 4-node tree while
   * the heading under verification has not painted. Byte-equality over the
   * gate's own full snapshots remains the verdict, and the loading-marker and
   * dev-menu clauses below are untouched — those encode Expo semantics
   * agent-device has no way to know.
   */
  const waitOnce = async (remainingMs: number): Promise<void> => {
    if (waitMode === 'wait-stable' && driver.waitStable) {
      try {
        const budget = Math.max(opts.intervalMs, Math.min(remainingMs, opts.timeoutMs));
        const res = await driver.waitStable(WAIT_STABLE_QUIET_MS, budget);
        if (res.captures !== undefined) {
          waitStableCaptures = (waitStableCaptures ?? 0) + res.captures;
        }
        return;
      } catch {
        // The primitive is unavailable on this binary/device — stop asking.
        waitMode = 'interval';
      }
    }
    await opts.delay(opts.intervalMs);
  };

  let a: string;
  try {
    a = await driver.snapshot();
  } catch {
    // No baseline snapshot → nothing to compare; proceed immediately rather
    // than burn the whole timeout (the gate is advisory — it must never BLOCK
    // capture, and a device that can't snapshot at all can't benefit anyway).
    return { settled: true, waitedMs: 0, devMenuDismissals, waitMode, waitStableCaptures };
  }
  while (true) {
    const elapsed = now() - start;
    if (elapsed >= opts.timeoutMs) {
      return { settled: false, waitedMs: elapsed, devMenuDismissals, waitMode, waitStableCaptures };
    }
    await waitOnce(opts.timeoutMs - elapsed);
    let b: string;
    try {
      b = await driver.snapshot();
    } catch {
      // Discard the failed frame so the next compare starts fresh rather than
      // matching against a stale baseline that may itself have carried a
      // marker (an A that threw-then-recovered into a marker-bearing frame
      // would falsely settle if we kept the old A).
      a = '';
      continue;
    }
    if (snapshotShowsDevMenu(b)) {
      // The dev menu is up: the component underneath is NOT readable, and the
      // menu is stable enough to satisfy `a === b` — the exact false-settle
      // that produced the heading-visible flake. Actively dismiss it (nothing
      // else will) and re-baseline so the post-dismiss frame is never compared
      // against a menu frame.
      if (devMenuDismissals < MAX_DEV_MENU_DISMISS_ATTEMPTS) {
        // Best-effort. The bridge rung asks the app to close its own dev menu
        // (no screen interaction at all); the driver fallback re-checks the
        // anchor detection itself and clicks NOTHING when it disagrees, so a
        // mis-detection here cannot reach the screen under verification.
        const clicked = await dismissDevMenu().catch(() => false);
        if (clicked) devMenuDismissals += 1;
      }
      a = '';
      continue;
    }
    if (a === b && !snapshotHasDevClientLoadingMarker(b)) {
      return {
        settled: true,
        waitedMs: now() - start,
        devMenuDismissals,
        waitMode,
        waitStableCaptures,
      };
    }
    a = b;
  }
}
