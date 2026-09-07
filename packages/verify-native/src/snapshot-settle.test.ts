import { describe, expect, it, vi } from 'vitest';
import {
  DEV_CLIENT_LOADING_MARKERS,
  DEFAULT_SETTLE_GATE_COLD_MS,
  DEFAULT_SETTLE_GATE_INTERVAL_MS,
  DEFAULT_SETTLE_GATE_WARM_MS,
  MAX_DEV_MENU_DISMISS_ATTEMPTS,
  settleUnconfirmed,
  snapshotHasDevClientLoadingMarker,
  waitForSettledSnapshot,
  WAIT_STABLE_QUIET_MS,
} from './snapshot-settle.js';
import type { NativeDriver, WaitStableOutcome } from './agent-device-driver.js';

/**
 * Fake driver whose `snapshot()` pops a scripted sequence (left-to-right) and
 * then freezes on the last value once the sequence is exhausted — so a test
 * can script a "changing → stable" or "marker → clean" transition. Throws are
 * scripted by the string `'THROW'`.
 */
function seqDriver(frames: string[]): NativeDriver {
  let i = 0;
  const calls: string[] = [];
  const driver: NativeDriver = {
    platform: 'ios',
    targetUrl: () => 'myapp://validity?component=x',
    openTarget: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    openUrl: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    openControlLink: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    dismissOverlay: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    dismissDevMenu: vi.fn(async () => false),
    click: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    inputText: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    acceptAlert: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    waitForRef: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    screenshot: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    snapshot: async () => {
      calls.push(`snap#${i}`);
      const f = frames[Math.min(i, frames.length - 1)];
      i += 1;
      if (f === 'THROW') throw new Error('snapshot boom');
      return f ?? '';
    },
    terminateApp: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  };
  return new Proxy(driver, {
    get(target, prop) {
      // expose the call counter for assertions via a side-band property
      if (prop === '__frameIndex') return () => i;
      return Reflect.get(target, prop);
    },
  }) as NativeDriver & { __frameIndex: () => number };
}

describe('snapshotHasDevClientLoadingMarker', () => {
  it('flags the dev-client loading overlays (case-insensitive substring)', () => {
    for (const m of DEV_CLIENT_LOADING_MARKERS) {
      expect(snapshotHasDevClientLoadingMarker(`# @e1 [text] "${m}…"`)).toBe(true);
    }
    // mixed casing must still match ("Refreshing…", "Building JavaScript Bundle")
    expect(snapshotHasDevClientLoadingMarker('# @e1 [text] "Refreshing…"')).toBe(true);
    expect(
      snapshotHasDevClientLoadingMarker('# @e1 [text] "Building JavaScript Bundle: 73%"'),
    ).toBe(true);
  });

  it('returns false for a clean rendered frame', () => {
    expect(snapshotHasDevClientLoadingMarker('# @e1 [heading] "Welcome"')).toBe(false);
    expect(snapshotHasDevClientLoadingMarker('')).toBe(false);
  });
});

describe('waitForSettledSnapshot', () => {
  it('defaults: cold/warm timing + interval are the documented budgets', () => {
    expect(DEFAULT_SETTLE_GATE_COLD_MS).toBe(10000);
    expect(DEFAULT_SETTLE_GATE_WARM_MS).toBe(2500);
    expect(DEFAULT_SETTLE_GATE_INTERVAL_MS).toBe(400);
  });

  it('(a) changing → stable sequence: waits, then returns settled:true', async () => {
    // Frame 0..2 churn (a loading→partial→resolved transition), frame 3 onward
    // identical + no loading marker → the gate MUST advance through the churn
    // and settle once two consecutive frames agree.
    const driver = seqDriver([
      '# @e1 [text] "Refreshing…"',
      '# @e1 [text] "Loading"',
      '# @e1 [heading] "Welcome"',
      '# @e1 [heading] "Welcome"',
      '# @e1 [heading] "Welcome"',
    ]);
    // Fake clock advanced only by the delay callback: each `delay(ms)` bumps the
    // clock so the timeout check advances without real wall-clock.
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r.settled).toBe(true);
    // Snapshots: A(frame0) + then each loop takes B → A,B,B,B… until two agree.
    // Frame0=A(Refreshing), B=Loading(!=) ; A=Loading, B=Welcome(!=) ;
    // A=Welcome, B=Welcome(==, no marker) → settle. So 4 snapshot calls.
    expect(driver.__frameIndex()).toBe(4);
    expect(r.waitedMs).toBe(400 * 3); // three interval waits before settling
  });

  it('(b) stable-but-contains-"Refreshing…" then clean: waits until the marker clears', async () => {
    // Two IDENTICAL frames that BOTH carry "Refreshing…" must NOT settle: a
    // frozen loading overlay is byte-equal across snapshots yet still hides the
    // real UI. The gate keeps polling until a clean frame pair appears.
    const driver = seqDriver([
      '# @e1 [text] "Refreshing…"',
      '# @e1 [text] "Refreshing…"',
      '# @e1 [text] "Refreshing…"',
      '# @e1 [heading] "Welcome"',
      '# @e1 [heading] "Welcome"',
    ]);
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r.settled).toBe(true);
    // Advances past the frozen marker frames (3 churn + the first clean
    // compare pairing) — must NOT settle on the marker-bearing identical pair.
    expect(driver.__frameIndex()).toBeGreaterThanOrEqual(5);
  });

  it('(c) never settles: returns settled:false at the timeout', async () => {
    // Every snapshot is DIFFERENT (a counter baked into the label) AND marker-
    // free: equality never holds, so the loop runs until the clock crosses the
    // timeout, then returns {settled:false, waitedMs:timeout}.
    const driver = seqDriver([]);
    let n = 0;
    const snapshotFn = vi.fn(async () => `# @e1 [text] "frame ${n++}"`);
    (driver as { snapshot: () => Promise<string> }).snapshot = snapshotFn;
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 2000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r.settled).toBe(false);
    expect(r.waitedMs).toBeGreaterThanOrEqual(2000);
    // The gate polled more than once (it didn't give up after the first frame).
    expect(snapshotFn.mock.calls.length).toBeGreaterThan(1);
  });

  it('on a warm/stable tree the gate costs a SINGLE interval (cheap case)', async () => {
    // Identical, marker-free frame from the start: A == B after one wait.
    const driver = seqDriver([
      '# @e1 [heading] "Welcome"',
      '# @e1 [heading] "Welcome"',
      '# @e1 [heading] "Welcome"',
    ]);
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r.settled).toBe(true);
    // Exactly TWO snapshots (A then B) and ONE interval wait.
    expect(driver.__frameIndex()).toBe(2);
    expect(r.waitedMs).toBe(400);
  });

  it('a baseline snapshot that THROWS proceeds immediately (gate is advisory)', async () => {
    const driver = seqDriver(['THROW', '# @e1 [heading] "Welcome"']);
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 5000,
      intervalMs: 100,
      delay: async () => {},
      now: () => 0,
    });
    expect(r).toMatchObject({ settled: true, waitedMs: 0, devMenuDismissals: 0 });
    // The fake driver exposes no `waitStable`, so the gate reports the fallback
    // wait mechanism and no capture stats.
    expect(r.waitMode).toBe('interval');
    expect(r.waitStableCaptures).toBeUndefined();
  });

  // ---- Expo dev-menu overlay (the heading-visible flake, dogfood 2026-07-27) --
  //
  // Verbatim shape of the surface expo-dev-client presents over the rendered
  // component after a cold `--clear` bundle build. It is BYTE-STABLE for many
  // seconds and carries NO loading marker ('Fast refresh' does not contain
  // 'refreshing'), so the equality+marker gate alone declared it settled and
  // the run's first criterion resolved against THIS tree instead of the app.
  const DEV_MENU_FRAME = [
    '@e1 [application] "Validity"',
    '@e2 [window]',
    '@e5 [button] "Close"',
    '@e8 [button] "Reload"',
    '@e9 [button] "Go home"',
    '@e10 [text] "TOOLS"',
    '@e12 [button] "Toggle performance monitor"',
    '@e13 [button] "Toggle element inspector"',
    '@e15 [text] "Fast refresh"',
  ].join('\n');
  const APP_FRAME = [
    '@e1 [application] "Validity"',
    '@e3 [button] "Back to dashboard"',
    '@e4 [other] "Your app, almost ready for launch!"',
    '@e7 [button] "Let\'s go!"',
  ].join('\n');

  it('(d) does NOT settle on a byte-stable Expo dev menu — dismisses it and waits for the app', async () => {
    // Regression guard for the flake: two identical, marker-free dev-menu
    // frames must not satisfy the gate.
    const driver = seqDriver([DEV_MENU_FRAME, DEV_MENU_FRAME, APP_FRAME, APP_FRAME, APP_FRAME]);
    (driver as { dismissDevMenu: () => Promise<boolean> }).dismissDevMenu = vi.fn(async () => true);
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r.settled).toBe(true);
    // It settled on the APP pair, not the dev-menu pair, and it actively
    // dismissed rather than waiting the menu out (nothing else closes it).
    expect(r.devMenuDismissals).toBeGreaterThan(0);
    expect(driver.dismissDevMenu).toHaveBeenCalled();
  });

  it('(e) a dev menu that never closes times out (settled:false) with bounded clicking', async () => {
    // Pathological: the menu stays up forever. The gate must NOT settle on it,
    // must stop clicking after the cap, and must report the race.
    const driver = seqDriver([DEV_MENU_FRAME]);
    const dismiss = vi.fn(async () => true);
    (driver as { dismissDevMenu: () => Promise<boolean> }).dismissDevMenu = dismiss;
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 4000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r.settled).toBe(false);
    expect(dismiss.mock.calls.length).toBe(MAX_DEV_MENU_DISMISS_ATTEMPTS);
    expect(r.devMenuDismissals).toBe(MAX_DEV_MENU_DISMISS_ATTEMPTS);
  });

  it('(f) user UI with a lone dev-menu-ish label is NOT treated as the dev menu', async () => {
    // False-positive guard: a component with its own 'Close' + 'Go home'
    // buttons has only ONE anchor, so the two-anchor floor keeps the gate on
    // its normal path — it settles and never clicks the screen under test.
    const userModal = [
      '@e1 [application] "MyApp"',
      '@e2 [button] "Close"',
      '@e3 [button] "Go home"',
      '@e4 [heading] "Session expired"',
    ].join('\n');
    const driver = seqDriver([userModal, userModal, userModal]);
    const dismiss = vi.fn(async () => true);
    (driver as { dismissDevMenu: () => Promise<boolean> }).dismissDevMenu = dismiss;
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r.settled).toBe(true);
    expect(r.devMenuDismissals).toBe(0);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('(g) a RENAMED dev menu is still caught while one specific anchor survives', async () => {
    // The drift scenario, played out at gate level. Expo has renamed most of
    // the menu and 'Go home' is gone; only 'Element inspector' still matches.
    // This frame is byte-stable and marker-free, so if detection missed it the
    // gate would SETTLE on the menu — no timeout, no warning, and the run's
    // first criterion resolves against the dev menu. That is the
    // heading-visible false red returning silently, which is why one specific
    // anchor has to be enough.
    const renamedMenu = [
      '@e1 [application] "Validity"',
      '@e5 [button] "Close"',
      '@e9 [button] "Back to app"',
      '@e12 [button] "Frame rate overlay"',
      '@e13 [button] "Element inspector"',
    ].join('\n');
    const driver = seqDriver([renamedMenu, renamedMenu, APP_FRAME, APP_FRAME, APP_FRAME]);
    const dismiss = vi.fn(async () => true);
    (driver as { dismissDevMenu: () => Promise<boolean> }).dismissDevMenu = dismiss;
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r.settled).toBe(true);
    expect(r.devMenuDismissals).toBeGreaterThan(0);
    expect(dismiss).toHaveBeenCalled();
  });

  it('a snapshot THROW mid-loop is tolerated (keeps polling, no false-settle)', async () => {
    // Frame0 ok, frame1 throws, frame2.. identical clean → settles on the
    // clean pair, never on the throw.
    const driver = seqDriver([
      '# @e1 [text] "Refreshing…"',
      'THROW',
      '# @e1 [heading] "Welcome"',
      '# @e1 [heading] "Welcome"',
    ]);
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(r.settled).toBe(true);
    // It must NOT have settled on frame0==frame0 (frame0 has a marker) nor on
    // the throw — it advanced into the clean pair.
    expect(driver.__frameIndex()).toBeGreaterThanOrEqual(4);
  });
  it('(h) uses the INJECTED dismisser instead of the driver, and counts only real dismissals', async () => {
    // On Android the driver's ref-click rung has nothing to click (the SDK-55
    // sheet exposes no dismissing label), so the capture flow injects the
    // bridge-backed dismisser — the companion closing its own dev menu. If the
    // gate ignored the injection it would fall back to a rung that no-ops
    // there, burn its whole timeout on a byte-stable menu, and report
    // settled:false on a screen it could actually have cleared.
    const driver = seqDriver([DEV_MENU_FRAME, DEV_MENU_FRAME, APP_FRAME, APP_FRAME, APP_FRAME]);
    const driverDismiss = vi.fn(async () => false); // the Android no-op rung
    (driver as { dismissDevMenu: () => Promise<boolean> }).dismissDevMenu = driverDismiss;
    const injected = vi.fn(async () => true);
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      dismissDevMenu: injected,
    });
    expect(r.settled).toBe(true);
    expect(injected).toHaveBeenCalled();
    // The driver's screen-touching rung was never reached.
    expect(driverDismiss).not.toHaveBeenCalled();
    expect(r.devMenuDismissals).toBeGreaterThanOrEqual(1);
  });

  it('(i) a dismisser that dismisses NOTHING never counts against the attempt budget', async () => {
    // The budget exists to stop a click loop against the screen under
    // verification. A rung that reports false did not touch anything, so
    // counting it would both exhaust the budget early and report heals that
    // never happened. The gate must still time out honestly.
    const driver = seqDriver([
      DEV_MENU_FRAME,
      DEV_MENU_FRAME,
      DEV_MENU_FRAME,
      DEV_MENU_FRAME,
      DEV_MENU_FRAME,
    ]);
    const injected = vi.fn(async () => false);
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 2000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      dismissDevMenu: injected,
    });
    expect(r.settled).toBe(false);
    expect(r.devMenuDismissals).toBe(0);
    // It kept trying (never exhausted a budget it should not consume).
    expect(injected.mock.calls.length).toBeGreaterThan(MAX_DEV_MENU_DISMISS_ATTEMPTS);
  });

  it('(j) an injected dismisser that REJECTS is tolerated — the gate still times out cleanly', async () => {
    const driver = seqDriver([DEV_MENU_FRAME, DEV_MENU_FRAME, DEV_MENU_FRAME]);
    const injected = vi.fn(async () => {
      throw new Error('bridge transport died');
    });
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 1200,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      dismissDevMenu: injected,
    });
    expect(r.settled).toBe(false);
    expect(r.devMenuDismissals).toBe(0);
  });
});
/* -------------------------------------------------------------------------- */
/* `agent-device wait stable` as the WAIT (never the verdict)                  */
/* -------------------------------------------------------------------------- */

describe('waitForSettledSnapshot — wait stable adoption', () => {
  /** seqDriver plus a scripted `waitStable`, recording how it was called. */
  function withWaitStable(
    frames: string[],
    outcome: () => Promise<WaitStableOutcome> = async () => ({
      settled: true,
      waitedMs: 120,
      captures: 2,
      nodeCount: 4,
    }),
  ): {
    driver: NativeDriver;
    calls: Array<[number, number]>;
    delays: number[];
  } {
    const driver = seqDriver(frames);
    const calls: Array<[number, number]> = [];
    (driver as { waitStable?: unknown }).waitStable = async (q: number, t: number) => {
      calls.push([q, t]);
      return outcome();
    };
    return { driver, calls, delays: [] };
  }

  it('uses the primitive instead of the blind sleep, and reports the mode', async () => {
    const { driver, calls } = withWaitStable([
      '# @e1 [heading] "Welcome"',
      '# @e1 [heading] "Welcome"',
    ]);
    const delays: number[] = [];
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async (ms) => {
        delays.push(ms);
      },
      now: () => 0,
    });
    expect(r.settled).toBe(true);
    expect(r.waitMode).toBe('wait-stable');
    // The fixed sleep never ran, and the primitive got upstream's own default
    // quiet window.
    expect(delays).toEqual([]);
    expect(calls[0]![0]).toBe(WAIT_STABLE_QUIET_MS);
    // Capture stats are carried through for observability.
    expect(r.waitStableCaptures).toBe(2);
  });

  it('does NOT let a settled `wait stable` override the byte-equality verdict', async () => {
    // THE REGRESSION GUARD. On Android `wait stable` polls the interactive tree,
    // which drops standalone static <Text> — measured live at nodeCount:4 on a
    // WelcomeScreen whose heading was plainly on screen. Here it reports settled
    // on every call while the FULL tree is still changing; the gate must keep
    // polling and settle only when two full snapshots actually agree.
    const { driver } = withWaitStable([
      '# @e1 [text] "Refreshing…"',
      '# @e1 [text] "Loading"',
      '# @e1 [heading] "Welcome"',
      '# @e1 [heading] "Welcome"',
    ]);
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async () => {},
      now: () => 0,
    });
    expect(r.settled).toBe(true);
    // Four snapshots: it did not stop at the first "settled" the primitive
    // reported.
    expect((driver as unknown as { __frameIndex: () => number }).__frameIndex()).toBe(4);
  });

  it('still refuses to settle on a byte-stable dev menu, however quiet the tree is', async () => {
    // The Expo clauses are semantics agent-device cannot know, so a primitive
    // that says "quiet" must not be able to wave the menu through.
    const menu =
      '# @e1 [text] "Go home"\n# @e2 [text] "Toggle performance monitor"\n# @e3 [text] "Fast refresh"';
    const { driver } = withWaitStable([menu, menu, menu, menu, menu, menu, menu, menu]);
    let clock = 0;
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 2000,
      intervalMs: 400,
      delay: async (ms) => {
        clock += ms;
      },
      now: () => (clock += 400),
      dismissDevMenu: async () => false,
    });
    expect(r.settled).toBe(false);
  });

  it('falls back to the fixed sleep — for good — when the primitive rejects', async () => {
    let stableCalls = 0;
    const { driver } = withWaitStable(
      [
        '# @e1 [text] "a"',
        '# @e1 [text] "b"',
        '# @e1 [heading] "Welcome"',
        '# @e1 [heading] "Welcome"',
      ],
      async () => {
        stableCalls += 1;
        throw new Error('UNSUPPORTED_OPERATION');
      },
    );
    const delays: number[] = [];
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async (ms) => {
        delays.push(ms);
      },
      now: () => 0,
    });
    expect(r.settled).toBe(true);
    expect(r.waitMode).toBe('interval');
    // Demoted after ONE rejection, so the gate cannot alternate between two
    // different wait characteristics mid-run.
    expect(stableCalls).toBe(1);
    expect(delays.length).toBeGreaterThan(0);
  });

  it('can be forced onto the fallback wait explicitly', async () => {
    const { driver, calls } = withWaitStable([
      '# @e1 [heading] "Welcome"',
      '# @e1 [heading] "Welcome"',
    ]);
    const r = await waitForSettledSnapshot(driver, {
      timeoutMs: 10000,
      intervalMs: 400,
      delay: async () => {},
      now: () => 0,
      waitStable: false,
    });
    expect(r.settled).toBe(true);
    expect(r.waitMode).toBe('interval');
    expect(calls).toEqual([]);
  });
});

describe('settleUnconfirmed — the wait on a render nothing confirmed', () => {
  const driverWith = (waitStable?: NativeDriver['waitStable']): NativeDriver =>
    ({
      platform: 'ios',
      targetUrl: () => '',
      openTarget: async () => ({ code: 0, stdout: '', stderr: '' }),
      openUrl: async () => ({ code: 0, stdout: '', stderr: '' }),
      openControlLink: async () => ({ code: 0, stdout: '', stderr: '' }),
      dismissOverlay: async () => ({ code: 0, stdout: '', stderr: '' }),
      dismissDevMenu: async () => false,
      click: async () => ({ code: 0, stdout: '', stderr: '' }),
      inputText: async () => ({ code: 0, stdout: '', stderr: '' }),
      acceptAlert: async () => ({ code: 0, stdout: '', stderr: '' }),
      waitForRef: async () => ({ code: 0, stdout: '', stderr: '' }),
      screenshot: async () => ({ code: 0, stdout: '', stderr: '' }),
      snapshot: async () => '',
      ...(waitStable ? { waitStable } : {}),
    }) as NativeDriver;

  it('uses `wait stable` when the driver has it, and never sleeps the whole budget', async () => {
    const slept: number[] = [];
    const waitStable = vi.fn(async () => ({ settled: true, waitedMs: 120, captures: 2 }));
    const out = await settleUnconfirmed(driverWith(waitStable), {
      budgetMs: 1200,
      delay: async (ms) => {
        slept.push(ms);
      },
    });
    expect(waitStable).toHaveBeenCalledWith(WAIT_STABLE_QUIET_MS, 1200);
    expect(out.via).toBe('wait-stable');
    expect(out.stable).toBe(true);
    expect(slept).toEqual([]);
  });

  it('reports a wait that never quieted WITHOUT changing anything about the verdict', async () => {
    const out = await settleUnconfirmed(
      driverWith(async () => ({ settled: false, waitedMs: 1200 })),
      { budgetMs: 1200, delay: async () => {} },
    );
    // `stable:false` is information about the WAIT. The caller reports
    // `unconfirmed` either way — a quiet tree was never proof of a paint.
    expect(out).toMatchObject({ via: 'wait-stable', stable: false });
  });

  it('falls back to the fixed sleep when the driver has no such primitive', async () => {
    const slept: number[] = [];
    const out = await settleUnconfirmed(driverWith(), {
      budgetMs: 1200,
      delay: async (ms) => {
        slept.push(ms);
      },
    });
    expect(out.via).toBe('sleep');
    expect(out.stable).toBeUndefined();
    expect(slept).toEqual([1200]);
  });

  it('falls back to the sleep when the primitive rejects — never throws at the caller', async () => {
    const slept: number[] = [];
    const out = await settleUnconfirmed(
      driverWith(async () => {
        throw new Error('unsupported on this binary');
      }),
      {
        budgetMs: 900,
        delay: async (ms) => {
          slept.push(ms);
        },
      },
    );
    expect(out.via).toBe('sleep');
    expect(slept).toEqual([900]);
  });
});
