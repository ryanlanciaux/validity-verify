/**
 * The dev-menu dismissal ladder: bridge rung first (the companion closes its
 * own Expo dev menu), driver ref-click as the fallback.
 *
 * The ordering is the point. The driver rung interacts with the SCREEN UNDER
 * VERIFICATION — it snapshots and clicks an `@eNN` ref — while the bridge rung
 * is a native state write inside the app with an ack. Whenever both could work,
 * the one that cannot mis-click has to win.
 */
import { describe, expect, it } from 'vitest';
import { makeDevMenuDismisser } from './dev-menu-dismiss.js';
import type { NativeDriver } from './agent-device-driver.js';
import type { NativeBridgeHandle } from './native-bridge.js';

const okResult = { code: 0, stdout: '', stderr: '' };

/** Minimal driver that only records whether its dismissal rung was reached. */
function fakeDriver(opts: { dismissed?: boolean; throws?: boolean } = {}): {
  driver: NativeDriver;
  calls: () => number;
} {
  let calls = 0;
  const driver = {
    platform: 'android' as const,
    targetUrl: () => 'x://y',
    openTarget: async () => okResult,
    openUrl: async () => okResult,
    openControlLink: async () => okResult,
    dismissOverlay: async () => okResult,
    async dismissDevMenu(): Promise<boolean> {
      calls += 1;
      if (opts.throws) throw new Error('agent-device session died');
      return opts.dismissed ?? false;
    },
    click: async () => okResult,
    inputText: async () => okResult,
    acceptAlert: async () => okResult,
    waitForRef: async () => okResult,
    screenshot: async () => okResult,
    snapshot: async () => '',
  } satisfies NativeDriver;
  return { driver, calls: () => calls };
}

/** Minimal bridge exposing only what the dismisser touches. */
function fakeBridge(opts: { connected: boolean; dismissed?: boolean; throws?: boolean }): {
  bridge: NativeBridgeHandle;
  calls: () => number;
} {
  let calls = 0;
  const bridge = {
    isConnected: () => opts.connected,
    async dismissDevMenu(): Promise<boolean> {
      calls += 1;
      if (opts.throws) throw new Error('bridge transport died');
      return opts.dismissed ?? false;
    },
  } as unknown as NativeBridgeHandle;
  return { bridge, calls: () => calls };
}

describe('makeDevMenuDismisser', () => {
  it('prefers the bridge rung and does NOT touch the screen when it succeeds', async () => {
    // The whole reason the bridge rung exists: no snapshot, no click, so the
    // component under verification cannot be interacted with before its
    // screenshot.
    const { driver, calls: driverCalls } = fakeDriver({ dismissed: true });
    const { bridge, calls: bridgeCalls } = fakeBridge({ connected: true, dismissed: true });
    expect(await makeDevMenuDismisser(driver, bridge)()).toBe(true);
    expect(bridgeCalls()).toBe(1);
    expect(driverCalls()).toBe(0);
  });

  it('falls back to the driver when the bridge dismissed nothing', async () => {
    // `false` from the bridge means an old companion binary (no capability), a
    // release build with no dev-menu module, or a rejected native call. On iOS
    // the driver's label click is a real dismissal, so it must still be tried.
    const { driver, calls: driverCalls } = fakeDriver({ dismissed: true });
    const { bridge } = fakeBridge({ connected: true, dismissed: false });
    expect(await makeDevMenuDismisser(driver, bridge)()).toBe(true);
    expect(driverCalls()).toBe(1);
  });

  it('falls back to the driver when the bridge THROWS', async () => {
    // A transport failure says nothing about whether the menu is up, so it must
    // not short-circuit the ladder.
    const { driver, calls: driverCalls } = fakeDriver({ dismissed: true });
    const { bridge } = fakeBridge({ connected: true, throws: true });
    expect(await makeDevMenuDismisser(driver, bridge)()).toBe(true);
    expect(driverCalls()).toBe(1);
  });

  it('skips a DISCONNECTED bridge entirely rather than burning its ack timeout', async () => {
    const { driver, calls: driverCalls } = fakeDriver({ dismissed: false });
    const { bridge, calls: bridgeCalls } = fakeBridge({ connected: false, dismissed: true });
    expect(await makeDevMenuDismisser(driver, bridge)()).toBe(false);
    expect(bridgeCalls()).toBe(0);
    expect(driverCalls()).toBe(1);
  });

  it('works with no bridge at all (deep-link-only callers)', async () => {
    const { driver, calls: driverCalls } = fakeDriver({ dismissed: true });
    expect(await makeDevMenuDismisser(driver)()).toBe(true);
    expect(driverCalls()).toBe(1);
  });

  it('a driver that THROWS resolves false — a dismissal never breaks its capture', async () => {
    const { driver } = fakeDriver({ throws: true });
    expect(await makeDevMenuDismisser(driver)()).toBe(false);
  });

  it('reports FALSE when no rung dismissed anything (the caller must keep observing)', async () => {
    // The honest answer to "could you clear it?" is what lets the caller
    // distinguish "the screen is readable now" from "I could not tell".
    const { driver } = fakeDriver({ dismissed: false });
    const { bridge } = fakeBridge({ connected: true, dismissed: false });
    expect(await makeDevMenuDismisser(driver, bridge)()).toBe(false);
  });
});
