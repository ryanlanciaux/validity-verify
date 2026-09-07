import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browseNative, captureNative, nativePerfUnavailableReason } from './capture-native.js';
import { readSessionMetrics } from './session-metrics.js';
import type { NativeDriver, ExecResult, NativeSessionReadiness } from './agent-device-driver.js';
import type { TargetSpec } from './deep-link.js';
import type {
  NativeBridgeDeviceInfo,
  NativeBridgePlatformMismatch,
  NativeBridgeHandle,
  NativeBridgeMode,
  NativeBridgeNavigateOutcome,
  NativeBridgeServerMessage,
  NativeHomeMessage,
  NativeNavigateMessage,
  NativeRenderedResult,
} from './native-bridge.js';

function okResult(over: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout: '', stderr: '', ...over };
}

/**
 * The deep-link path now waits on a PER-NAVIGATION marker
 * (`validity-root:<token>`, token minted per open) instead of the shared
 * `validity-root` — normalize the token so call-sequence assertions stay
 * deterministic.
 */
function norm(calls: string[]): string[] {
  return calls.map((c) => c.replace(/validity-root:nav-[a-z0-9]+-\d+/g, 'validity-root:<token>'));
}

class FakeDriver implements NativeDriver {
  readonly platform = 'ios' as const;
  readonly scheme = 'myapp';
  calls: string[] = [];
  controlResult: ExecResult = okResult();
  openResult: ExecResult = okResult();
  dismissResult: ExecResult = okResult();
  alertResult: ExecResult = okResult();
  waitResult: ExecResult = okResult();
  /** Per-call wait outcomes, consumed in order; falls back to `waitResult`. Lets a
   *  test fail the WARM probe (1st wait) but pass the COLD render-wait (2nd). */
  waitResults: ExecResult[] = [];
  shotResult: ExecResult = okResult();
  snapResult: string | (() => string) = 'a11y-tree';
  constructor(private url = 'myapp://validity?component=Foo') {}
  targetUrl(): string {
    return this.url;
  }
  async openUrl(url: string): Promise<ExecResult> {
    this.calls.push(`openUrl:${url}`);
    return this.openResult;
  }
  /** Last spec passed to openTarget — lets tests correlate the deep-link token. */
  lastOpenSpec: TargetSpec | undefined;
  async openTarget(spec: TargetSpec): Promise<ExecResult> {
    this.calls.push('open');
    this.lastOpenSpec = spec;
    return this.openResult;
  }
  async openControlLink(metroUrl?: string): Promise<ExecResult> {
    this.calls.push(`control:${metroUrl ?? ''}`);
    return this.controlResult;
  }
  async dismissOverlay(): Promise<ExecResult> {
    this.calls.push('dismiss');
    return this.dismissResult;
  }
  async dismissDevMenu(): Promise<boolean> {
    this.calls.push('devmenu');
    return true;
  }
  async click(target: string): Promise<ExecResult> {
    this.calls.push(`click:${target}`);
    return okResult();
  }
  async acceptAlert(): Promise<ExecResult> {
    this.calls.push('alert');
    return this.alertResult;
  }
  async waitForRef(ref: string, timeoutMs: number): Promise<ExecResult> {
    this.calls.push(`wait:${ref}:${timeoutMs}`);
    return this.waitResults.length ? this.waitResults.shift()! : this.waitResult;
  }
  async screenshot(path: string): Promise<ExecResult> {
    this.calls.push(`shot:${path}`);
    return this.shotResult;
  }
  async snapshot(): Promise<string> {
    this.calls.push('snap');
    return typeof this.snapResult === 'function' ? this.snapResult() : this.snapResult;
  }
  /**
   * Optional NativeDriver capability — absent unless a test enables it, which
   * keeps every pre-existing expectation on `calls` byte-identical.
   */
  ensureSession?: (url: string) => Promise<NativeSessionReadiness>;
  /** URLs the session gate was asked to establish a session with. */
  sessionUrls: string[] = [];
  /**
   * Opt into the session readiness gate, scripting what it answers. Records the
   * call in `calls` so a test can prove it happened BEFORE the first
   * session-scoped command.
   */
  enableSessionGate(readiness: NativeSessionReadiness = { ready: true, via: 'opened' }): this {
    this.ensureSession = async (url: string) => {
      this.calls.push('ensureSession');
      this.sessionUrls.push(url);
      return readiness;
    };
    return this;
  }
  /**
   * Optional NativeDriver capability — absent unless a test assigns it, so the
   * dev-launcher probe falls back to `snapshot()` for every existing test
   * (which is also what an iOS driver does).
   */
  foregroundActivity?: () => Promise<string | undefined>;
  /** Bundle ids terminated via terminateApp (only when enableTerminate() ran). */
  terminated: string[] = [];
  /** Optional NativeDriver capability — absent unless a test enables it. */
  terminateApp?: (bundleId: string) => Promise<ExecResult>;
  /** Opt into the forceReload terminate capability (records the bundle id). */
  enableTerminate(): this {
    this.terminateApp = async (bundleId: string) => {
      this.calls.push(`terminate:${bundleId}`);
      this.terminated.push(bundleId);
      return okResult();
    };
    return this;
  }
  /**
   * Optional NativeDriver capability — absent unless a test enables it, so the
   * device-evidence seam stays unreachable for every pre-existing test.
   */
  runInSession?: (args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;
  /** Opt into the session passthrough the evidence collectors ride. */
  enableRunInSession(): this {
    this.runInSession = async (args: string[]) => {
      this.calls.push(`session:${args.join(' ')}`);
      return okResult();
    };
    return this;
  }
}

/** Host-side control bridge fake — records sent commands, scripts acks. */
class FakeBridge implements NativeBridgeHandle {
  readonly port = 8083;
  sent: NativeBridgeServerMessage[] = [];
  connected: boolean;
  /** When set, `waitForConnection` flips `connected` true (device attaches after boot). */
  connectsAfterBoot: boolean;
  /** What `waitForRendered` resolves with (null = timeout). */
  rendered: NativeRenderedResult | null;
  /** Scripted bind/delegation outcome ('local' unless a test says otherwise). */
  modeValue: NativeBridgeMode;
  /** Scripted device hello info (null = no hello yet / old companion). */
  info: NativeBridgeDeviceInfo | null;
  /** Does a fresh session dial back after a `reload` push? (DevSettings reload worked.) */
  reconnectsAfterReload: boolean;
  /** Monotonic connection count — bumped when the scripted reload "reconnects". */
  epoch = 1;
  waitConnectionCalls = 0;
  constructor(
    opts: {
      connected?: boolean;
      connectsAfterBoot?: boolean;
      rendered?: NativeRenderedResult | null;
      mode?: NativeBridgeMode;
      info?: NativeBridgeDeviceInfo | null;
      reconnectsAfterReload?: boolean;
    } = {},
  ) {
    this.connected = opts.connected ?? false;
    this.connectsAfterBoot = opts.connectsAfterBoot ?? false;
    this.rendered = opts.rendered ?? { ok: true };
    this.modeValue = opts.mode ?? 'local';
    this.info = opts.info ?? null;
    this.reconnectsAfterReload = opts.reconnectsAfterReload ?? true;
  }
  mode(): NativeBridgeMode {
    return this.modeValue;
  }
  async whenReady(): Promise<NativeBridgeMode> {
    return this.modeValue;
  }
  send(message: NativeBridgeServerMessage): boolean {
    this.sent.push(message);
    // Mirror the real handle: a delivered reload tears the device session down
    // and (when scripted to succeed) a NEW session attaches → epoch bump.
    if (message.type === 'reload' && this.connected && this.reconnectsAfterReload) {
      this.epoch += 1;
    }
    return this.connected;
  }
  isConnected(): boolean {
    return this.connected;
  }
  connectionEpoch(): number {
    return this.epoch;
  }
  async waitForReconnect(sinceEpoch: number): Promise<boolean> {
    return this.epoch > sinceEpoch;
  }
  async waitForConnection(): Promise<boolean> {
    this.waitConnectionCalls += 1;
    if (this.connected) return true;
    if (this.connectsAfterBoot) {
      this.connected = true;
      return true;
    }
    return false;
  }
  /**
   * Per-token ack resolver. Models the real bridge's retained-ack channel: the
   * DEEP-LINK rung asks for an ack keyed by the link token (minted inside
   * coldOpen, so a test reads it off `driver.lastOpenSpec`), while the bridge
   * navigate asks for its own. Absent → every token gets `rendered`, which is
   * the pre-existing behavior every other test relies on.
   */
  ackFor?: (token: string) => NativeRenderedResult | null;
  /** Every waitForRendered the capture made, so gating can be asserted. */
  waitForRenderedCalls: Array<{ token: string; timeoutMs: number }> = [];
  async waitForRendered(token = '', timeoutMs = 0): Promise<NativeRenderedResult | null> {
    this.waitForRenderedCalls.push({ token, timeoutMs });
    return this.ackFor ? this.ackFor(token) : this.rendered;
  }
  /** How many bridge-backed dev-menu dismissals the capture asked for. */
  dismissDevMenuCalls = 0;
  /**
   * Scripted answer for the bridge dismissal rung. TRUE models a current
   * companion that closed its own Expo dev menu; FALSE models the honest
   * degradations (no device, old binary without the 'dismiss-dev-menu'
   * capability, native call rejected) that must fall through to the driver rung.
   */
  dismissDevMenuResult = true;
  async dismissDevMenu(): Promise<boolean> {
    this.dismissDevMenuCalls += 1;
    return this.connected && this.dismissDevMenuResult;
  }
  /** Mirrors the real handle: send + scripted ack, port-held when scripted so. */
  async navigate(
    message: NativeNavigateMessage | NativeHomeMessage,
  ): Promise<NativeBridgeNavigateOutcome> {
    if (this.modeValue === 'port-held') {
      return { kind: 'port-held', detail: `port ${this.port} is held (scripted)` };
    }
    if (!this.send(message)) return { kind: 'no-device' };
    const ack = await this.waitForRendered(message.token, 0);
    return ack ? { kind: 'ack', result: ack } : { kind: 'ack-timeout' };
  }
  deviceInfo(): NativeBridgeDeviceInfo | null {
    return this.info;
  }
  /**
   * Scripted platform identity conflict (see NativeBridgeHandle.platformMismatch).
   * Null on every existing fixture — the mismatch is the exception, and a fake
   * that manufactured one would change what every other capture test diagnoses.
   */
  platformMismatchValue: NativeBridgePlatformMismatch | null = null;
  platformMismatch(): NativeBridgePlatformMismatch | null {
    return this.platformMismatchValue;
  }
  close(): void {}
}

describe('captureNative — control bridge (in-place re-targeting)', () => {
  it('warm: drives the active view over the bridge with NO deep link / reload', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const delays: number[] = [];
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    // No Linking open, no control link — only the up-front stale-LogBox clear
    // (screen-safe), the PAINT cross-check on the per-token marker (the bridge
    // ack proves JS committed, not that the view drew), the two settle-gate
    // polls (Bug 6), the screenshot + the final grounding snap.
    expect(driver.calls).toEqual([
      'dismiss',
      `wait:validity-root:${(bridge.sent[0] as { token: string }).token}:2500`,
      'snap',
      'snap',
      'shot:/tmp/shot.png',
      'snap',
    ]);
    expect(driver.calls.some((c) => c === 'open' || c.startsWith('control'))).toBe(false);
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0]).toMatchObject({ type: 'navigate', component: 'src/Button.tsx' });
    expect((bridge.sent[0] as { token: string }).token).toMatch(/^nav-/);
    // warm settle (200) + one settle-gate interval (400 — the stable-tree cheap
    // case: the constant a11y frame agrees on the first compare).
    expect(delays).toEqual([200, 400]);
  });

  it('warm: carries the companion perf object from the rendered ack onto cap.render.perf', async () => {
    // The companion measures render timing inside its JS and rides it back on the
    // `rendered` ack (NativePerf). The host must surface it on the confirmed
    // render status so it can fuel expect.performance + the observational panel.
    const driver = new FakeDriver();
    const bridge = new FakeBridge({
      connected: true,
      rendered: { ok: true, perf: { readyMs: 120, mountMs: 8, commitCount: 1 } },
    });
    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(cap.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
    expect(cap.render.perf).toEqual({ readyMs: 120, mountMs: 8, commitCount: 1 });
  });

  // ---- the `expect.performance metric: mount` lottery -----------------------
  //
  // MECHANISM. `perf` (and `matched` / `consoleErrorCount`) rides the device's
  // `rendered` ack, and the ack was only ever read on the BRIDGE path. Whenever
  // a bridge ack lost its race — routine on Android under load, and the reason
  // the loss rotated to a different spec every sweep — the capture fell to the
  // deep-link rung, confirmed the paint with the tokenized marker, and returned
  // a CONFIRMED render carrying no timing at all. `expect.performance metric:
  // mount` then reported "native perf channel unavailable — rebuild the
  // companion" for a render the device had measured perfectly well.
  //
  // FIX. The companion acks tokenized deep links too ('deep-link-ack'), the
  // bridge retains acks nobody was waiting for, and the marker rung adopts one.

  it('deep-link rung: adopts the device ack, so a marker-confirmed render still carries perf', async () => {
    const driver = new FakeDriver();
    // Warm bridge session whose navigate ack TIMES OUT (the 1-in-4 case), with a
    // current companion that acks deep links.
    const bridge = new FakeBridge({
      connected: true,
      info: { capabilities: ['reload', 'dismiss-dev-menu', 'deep-link-ack'] },
    });
    bridge.ackFor = (token) =>
      token === driver.lastOpenSpec?.token
        ? {
            ok: true,
            perf: { readyMs: 980, mountMs: 41, commitCount: 1 },
            consoleErrorCount: 0,
            matched: [{ method: 'GET', url: '/api/feed', status: 200 }],
          }
        : null; // the bridge navigate's own ack never lands

    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });

    // The render is confirmed by the MARKER (the fallback rung really ran) …
    expect(cap.render).toMatchObject({ status: 'confirmed', via: 'marker' });
    expect(driver.calls).toContain('open');
    // … and it now carries the timing the device measured for it.
    expect(cap.render.perf).toEqual({ readyMs: 980, mountMs: 41, commitCount: 1 });
    // The other ack-borne channels ride along for free (they were lost too).
    expect(cap.render.consoleErrorCount).toBe(0);
    expect(cap.render.matchedRequests).toEqual([{ method: 'GET', url: '/api/feed', status: 200 }]);
    // The adoption asked for the LINK token, not the navigate token.
    const adopt = bridge.waitForRenderedCalls.at(-1);
    expect(adopt?.token).toBe(driver.lastOpenSpec?.token);
  });

  it('deep-link rung: an old companion is never waited on, and the verdict SAYS which path lost the timing', async () => {
    // A binary without 'deep-link-ack' can never answer, so burning the adopt
    // budget on it is pure latency. And the resulting unverifiable must not
    // keep saying "rebuild the companion" without saying WHY — that message
    // sent people to rebuild companions that were already current.
    const driver = new FakeDriver();
    const bridge = new FakeBridge({
      connected: true,
      info: { capabilities: ['reload'] }, // pre-rev-5 binary
    });
    bridge.ackFor = () => null; // no ack for anything

    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
      criteriaChecks: [
        {
          id: 'AC-9',
          text: 'mounts fast',
          tier: 'hard',
          checks: [{ expect: { performance: { metric: 'mount', maxMs: 1500 } } }],
        } as never,
      ],
    });

    expect(cap.render).toMatchObject({ status: 'confirmed', via: 'marker' });
    expect(cap.render.perf).toBeUndefined();
    // Only the navigate token was ever asked about — no adopt wait happened.
    expect(bridge.waitForRenderedCalls.map((c) => c.token)).toEqual([
      (bridge.sent[0] as { token: string }).token,
    ]);
    const verdict = cap.criterionVerdicts?.[0];
    expect(verdict?.status).toBe('unverifiable');
    const detail = verdict?.checks?.[0]?.detail ?? '';
    expect(detail).toContain('tokenized render marker');
    expect(detail).toContain('does not ack deep links');
    // Never a silent pass, and never a fabricated number.
    expect(verdict?.checks?.[0]?.status).toBe('unverifiable');
  });

  it('bridge-ack path: no adopt wait is added when the ack already landed', async () => {
    // The happy path must not pay for the fix: one ack read, no deep link.
    const driver = new FakeDriver();
    const bridge = new FakeBridge({
      connected: true,
      rendered: { ok: true, perf: { readyMs: 120, mountMs: 8, commitCount: 1 } },
      info: { capabilities: ['reload', 'dismiss-dev-menu', 'deep-link-ack'] },
    });
    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(cap.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
    expect(cap.render.perf).toEqual({ readyMs: 120, mountMs: 8, commitCount: 1 });
    expect(bridge.waitForRenderedCalls).toHaveLength(1);
    expect(driver.calls).not.toContain('open');
  });

  it('warm: an old companion (no perf on the ack) leaves cap.render.perf undefined', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(cap.render.status).toBe('confirmed');
    expect(cap.render.perf).toBeUndefined();
  });

  it('warm: a view target sends a `view` navigate (not `component`)', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true });
    await captureNative({
      driver,
      spec: { view: 'Button Variants' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(bridge.sent[0]).toMatchObject({ type: 'navigate', view: 'Button Variants' });
    expect((bridge.sent[0] as { component?: string }).component).toBeUndefined();
  });

  it('warm: ships the resolved view items INLINE so a new view renders with no rebuild', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true });
    const viewItems = [{ path: 'src/Button.tsx', label: 'Primary', props: { label: 'Go' } }];
    await captureNative({
      driver,
      spec: { view: 'Button Variants', viewItems },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(bridge.sent[0]).toMatchObject({
      type: 'navigate',
      view: 'Button Variants',
      items: viewItems,
    });
  });

  it('warm: ships the resolved scenario seed + mock-network INLINE (data, not a rebuild)', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true });
    const scenarioSeed = { context: { isAuthenticated: true }, undefinedKeys: ['authToken'] };
    const mockNetwork = {
      handlers: [{ url: '/api/me', json: { id: '1' } }],
      fallback: 'permissive' as const,
    };
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx', scenario: 'logged-in', scenarioSeed, mockNetwork },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(bridge.sent[0]).toMatchObject({
      type: 'navigate',
      component: 'src/Button.tsx',
      scenario: 'logged-in',
      scenarioSeed,
      mockNetwork,
    });
  });

  it('warm: a component navigate carries no view items', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true });
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx', viewItems: [{ path: 'x', label: 'x', props: {} }] },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect((bridge.sent[0] as { items?: unknown }).items).toBeUndefined();
  });

  it('warm: a dropped bridge ack re-targets via the deep link, never a cold reload (splash-safe)', async () => {
    // Device is attached (warm) but the render ack times out (rendered=null).
    // The warm session must NOT fall through to the cold control-link reload —
    // that re-presents the un-dismissable splash. It should re-target warm via
    // the deep link instead.
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true });
    bridge.rendered = null; // ack times out (the constructor coerces a passed null)
    const delays: number[] = [];
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    // Bridge navigate was attempted, then the WARM deep-link probe — but NEVER
    // the control link (cold reload).
    expect(bridge.sent).toHaveLength(1);
    expect(driver.calls).toContain('open');
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(false);
  });

  it('warm: even when the warm deep-link marker never paints, it settles instead of cold-reloading', async () => {
    // Worst case: bridge ack dropped AND the warm marker wait fails. Must still
    // avoid the cold control-link reload (splash protection) — settle + return.
    const driver = new FakeDriver();
    driver.waitResult = okResult({ code: 1 }); // warm marker never appears
    const bridge = new FakeBridge({ connected: true });
    bridge.rendered = null; // ack times out
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(false);
    expect(driver.calls).toContain('shot:/tmp/shot.png');
  });

  it('cold: boots via control link, waits for connect, then navigates over the bridge', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({
      connected: false,
      connectsAfterBoot: true,
      rendered: { ok: true },
    });
    const delays: number[] = [];
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      metroUrl: 'http://localhost:8082',
      bridge,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    // Control link boots the app; the bridge (not a deep link) selects the target.
    // The leading dismiss is the up-front stale-LogBox clear (screen-safe). The
    // marker wait is the PAINT cross-check on the bridge ack, and the two
    // settle-gate polls (Bug 6) sit between the render and the screenshot.
    expect(driver.calls).toEqual([
      'dismiss',
      'control:http://localhost:8082',
      'dismiss',
      'devmenu',
      'alert',
      `wait:validity-root:${(bridge.sent[0] as { token: string }).token}:2500`,
      'snap',
      'snap',
      'shot:/tmp/shot.png',
      'snap',
    ]);
    // No deep link, and the only `wait` is the paint cross-check asserted
    // above — not a deep-link marker rung.
    expect(driver.calls.some((c) => c === 'open')).toBe(false);
    expect(driver.calls.filter((c) => c.startsWith('wait'))).toHaveLength(1);
    expect(bridge.waitConnectionCalls).toBe(1);
    expect(bridge.sent).toHaveLength(1);
    expect(delays).toEqual([4000, 200, 400]); // bundle wait + warm settle + settle-gate interval
  });

  it('cold: gates on OBSERVED bundle readiness (waitForBundle) instead of the fixed 4s sleep', async () => {
    // After a --clear restart the first bundle takes 30-90s; a fixed 4s sleep
    // loses that race and every confirmation rung times out against the dev
    // launcher. With waitForBundle wired, the cold open waits on Metro's
    // "Bundled" signal and the fixed bundle sleep never fires.
    const driver = new FakeDriver();
    const bridge = new FakeBridge({
      connected: false,
      connectsAfterBoot: true,
      rendered: { ok: true },
    });
    const delays: number[] = [];
    let bundleWaits = 0;
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      waitForBundle: async () => {
        bundleWaits += 1;
        return true;
      },
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(bundleWaits).toBe(1);
    // warm settle only — NO fixed 4000ms bundle sleep — plus the settle-gate interval.
    expect(delays).toEqual([200, 400]);
  });

  it('falls back to the deep-link path when the bridge has no device (skipPreload)', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: false, connectsAfterBoot: false });
    const delays: number[] = [];
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      skipPreload: true,
      bridge,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    // Bridge can't confirm → legacy warm deep-link probe (no control link; the
    // one up-front dismiss clears only a stale LogBox/RedBox, which is
    // screen-safe — dev-menu/alert dismissals stay cold-only).
    expect(norm(driver.calls)).toEqual([
      'dismiss',
      'open',
      'wait:validity-root:<token>:3500',
      'snap',
      'snap',
      'shot:/tmp/shot.png',
      'snap',
    ]);
    expect(bridge.sent).toHaveLength(0); // never sent (not connected)
    // confirmed via warm marker → short settle + the settle-gate interval.
    expect(delays).toEqual([200, 400]);
  });
});

describe('captureNative — settle policy (confirmed paint is cheap, unconfirmed waits)', () => {
  it('confirmed bridge ack: default warm settle is the short 200ms (not the old 1500ms tax)', async () => {
    // The ack fires after two requestAnimationFrames (pixels painted), so the
    // post-ack settle is just slack for trailing layout — not a "hope it
    // painted" 1.5s pad.
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const delays: number[] = [];
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/s.png',
      bridge,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
    expect(delays).toEqual([200, 400]); // warm settle + settle-gate interval (Bug 6)
  });

  it('warmSettleMs is the slow-paint escape hatch — honored on the CONFIRMED path', async () => {
    // A component whose visible paint lags the ack (async images, custom fonts)
    // can raise the confirmed settle per call.
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const delays: number[] = [];
    await captureNative({
      driver,
      spec: { component: 'src/Gallery.tsx' },
      screenshotPath: '/tmp/s.png',
      bridge,
      warmSettleMs: 900,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([900, 400]); // raised warm settle + settle-gate interval (Bug 6)
  });

  it('UNCONFIRMED warm re-target keeps the LONGER settle (no paint signal at all)', async () => {
    // Worst case: bridge ack dropped AND the warm marker never paints. There is
    // NO confirmation that the new target painted, so the short confirmed settle
    // would be wrong — the longer settleMs fallback (default 1200ms) stays, and
    // warmSettleMs deliberately does NOT apply here.
    const driver = new FakeDriver();
    driver.waitResult = okResult({ code: 1 }); // warm marker never paints
    const bridge = new FakeBridge({ connected: true });
    bridge.rendered = null; // ack times out
    const delays: number[] = [];
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/s.png',
      bridge,
      warmSettleMs: 900, // proven irrelevant on the unconfirmed path
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.render.status).toBe('unconfirmed');
    expect(delays).toEqual([1200]);
  });

  it('exposes a per-phase timing breakdown on the capture result', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/s.png',
      bridge,
      delay: async () => {},
    });
    expect(typeof result.timing.openMs).toBe('number');
    expect(typeof result.timing.screenshotMs).toBe('number');
    expect(typeof result.timing.snapshotMs).toBe('number');
  });
});

describe('captureNative — bridge integrity (stale bundle, port contention)', () => {
  it('stale bundle on an OLD binary (no reload capability) → terminate + cold launch ladder', async () => {
    // The CLI stale-ack bug: after a content --clear restart, the still-running
    // app reconnects warm and would happily ack the OLD bundle as success. The
    // companion's hello now carries the hash it bundled with — a mismatch must
    // force a fresh bundle, never a warm re-target. This companion announces NO
    // 'reload' capability (its hello has no caps), so the in-place reload is
    // skipped and the terminate + genuine-cold-launch FINAL fallback runs.
    const driver = new FakeDriver().enableTerminate();
    const bridge = new FakeBridge({
      connected: true,
      rendered: { ok: true },
      info: { contentHash: 'old-hash-0000' },
    });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      bundleId: 'com.example.validity',
      expectedContentHash: 'new-hash-1111',
      delay: async () => {},
    });
    expect(driver.terminated).toEqual(['com.example.validity']);
    // Genuine cold launch: control link boots the fresh bundle, then ONE cold
    // navigate — never a warm navigate against the stale bundle.
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(true);
    expect(bridge.sent).toHaveLength(1);
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
  });

  it('matching contentHash: stays warm — no terminate, no control link', async () => {
    const driver = new FakeDriver().enableTerminate();
    const bridge = new FakeBridge({
      connected: true,
      rendered: { ok: true },
      info: { contentHash: 'same-hash' },
    });
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      bundleId: 'com.example.validity',
      expectedContentHash: 'same-hash',
      delay: async () => {},
    });
    expect(driver.terminated).toEqual([]);
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(false);
    expect(bridge.sent).toHaveLength(1); // the warm navigate
  });

  it('old companion (bare hello, no contentHash) degrades conservatively — warm, never terminated', async () => {
    const driver = new FakeDriver().enableTerminate();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true }, info: {} });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      bundleId: 'com.example.validity',
      expectedContentHash: 'new-hash-1111',
      delay: async () => {},
    });
    expect(driver.terminated).toEqual([]);
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
  });

  it('hello in flight: the open WAITS for the hello before trusting the warm shortcut', async () => {
    // waitForConnection resolves on the socket ATTACH; the hello carrying the
    // staleness/capability signals lands a beat later. Reading deviceInfo() in
    // that gap used to skip the stale-bundle guard entirely — the warm
    // navigate then confidently acked the STALE bundle as confirmed evidence.
    // The open now gives the hello a short bounded wait (HELLO_WAIT_POLL_MS
    // steps), then sees the mismatch + 'reload' capability and refreshes
    // in-place instead of warm-acking old code.
    const driver = new FakeDriver().enableTerminate();
    const bridge = new FakeBridge({
      connected: true,
      rendered: { ok: true },
      info: { contentHash: 'old-hash-0000', capabilities: ['reload'] },
    });
    const realInfo = bridge.deviceInfo.bind(bridge);
    let infoReads = 0;
    bridge.deviceInfo = () => (infoReads++ < 3 ? null : realInfo());
    const delays: number[] = [];
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      bundleId: 'com.example.validity',
      expectedContentHash: 'new-hash-1111',
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    // The hello was awaited (bounded polls), never a warm navigate of stale code.
    expect(delays.filter((d) => d === 50).length).toBe(3);
    expect(bridge.sent.map((m) => m.type)).toEqual(['reload', 'navigate']);
    expect(driver.terminated).toEqual([]);
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
  });

  it('stale OLD binary on a warm-pinned (skipPreload) session: forceReload unpins the preload and the ladder recovers', async () => {
    // The CLI pins skipPreload when it sees a connected device and unchanged
    // content — but the device's own hello can still prove the bundle stale
    // (a previous session's content restart it never picked up). On an old
    // binary (no 'reload' capability) the recovery is the terminate ladder,
    // and the post-terminate session is cold BY CONSTRUCTION: honoring the
    // warm-only pin would deep-link into the dead app and report 'unconfirmed'
    // instead of recovering — the forced refresh must override the pin so the
    // control link preloads the fresh bundle.
    const driver = new FakeDriver().enableTerminate();
    const bridge = new FakeBridge({
      connected: true,
      rendered: { ok: true },
      info: { contentHash: 'old-hash-0000' },
    });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      skipPreload: true,
      bundleId: 'com.example.validity',
      expectedContentHash: 'new-hash-1111',
      delay: async () => {},
    });
    expect(driver.terminated).toEqual(['com.example.validity']);
    // Bundle preload despite the caller's pin — the session is cold now.
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(true);
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
  });

  it('port-held bridge → throws machine-readable BRIDGE_PORT_HELD, never the deep-link ladder', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ mode: 'port-held' });
    await expect(
      captureNative({
        driver,
        spec: { component: 'src/Button.tsx' },
        screenshotPath: '/tmp/shot.png',
        bridge,
        delay: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'BRIDGE_PORT_HELD' });
    // No silent degrade: neither the deep link nor the control link fired.
    expect(driver.calls.filter((c) => c === 'open' || c.startsWith('control'))).toEqual([]);
  });

  it('browseNative forceReload + old binary (no hello caps) terminates instead of acking a stale warm bundle', async () => {
    // info: null = the device never sent a hello with capabilities — the
    // in-place reload is impossible, so the terminate ladder is the fallback.
    const driver = new FakeDriver().enableTerminate();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const result = await browseNative(
      driver,
      { component: 'src/Button.tsx' },
      {
        bridge,
        forceReload: true,
        bundleId: 'com.example.validity',
        expectedContentHash: 'fresh-hash',
        delay: async () => {},
      },
    );
    expect(driver.terminated).toEqual(['com.example.validity']);
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(true);
    expect(bridge.sent).toHaveLength(1); // only the post-cold-launch navigate
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
  });
});

describe('captureNative — in-place bridge reload (the collapsed forceReload tree)', () => {
  /** A live companion that announced the 'reload' capability and a stale bundle. */
  const staleCapableBridge = (
    over: { rendered?: NativeRenderedResult | null; reconnectsAfterReload?: boolean } = {},
  ) =>
    new FakeBridge({
      connected: true,
      rendered: { ok: true },
      info: { contentHash: 'old-hash-0000', capabilities: ['reload'] },
      ...over,
    });

  it('content-change restart: bridge reload + reconnect + acked navigate — NEVER terminateApp', async () => {
    // The replacement for the terminate(1s) + control-link + fixed-sleep
    // ladder: with a live reload-capable companion, a stale bundle (hello
    // contentHash mismatch — the content-restart signal) is refreshed by a
    // bridge-pushed DevSettings reload, then the fresh session is navigated
    // with a normal per-token ack.
    const driver = new FakeDriver().enableTerminate();
    const bridge = staleCapableBridge();
    const delays: number[] = [];
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      bundleId: 'com.example.validity',
      expectedContentHash: 'new-hash-1111',
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    // The whole ladder is gone: no terminate, no control link, no deep link.
    expect(driver.terminated).toEqual([]);
    expect(driver.calls.some((c) => c.startsWith('control') || c === 'open')).toBe(false);
    // reload pushed first, then exactly one navigate onto the fresh session.
    expect(bridge.sent.map((m) => m.type)).toEqual(['reload', 'navigate']);
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
    expect(result.render.token).toBe((bridge.sent[1] as { token: string }).token);
    // Bundle gate (legacy fixed sleep — no waitForBundle wired) + warm settle +
    // the settle-gate interval (Bug 6 — reload is cold, but the tree is stable
    // so it settles on the first compare).
    expect(delays).toEqual([4000, 200, 400]);
  });

  it('explicit forceReload (reload: true) with a capable companion also reloads in place', async () => {
    const driver = new FakeDriver().enableTerminate();
    const bridge = new FakeBridge({
      connected: true,
      rendered: { ok: true },
      info: { capabilities: ['reload'] },
    });
    const result = await browseNative(
      driver,
      { component: 'src/Button.tsx' },
      {
        bridge,
        forceReload: true,
        bundleId: 'com.example.validity',
        delay: async () => {},
      },
    );
    expect(driver.terminated).toEqual([]);
    expect(bridge.sent.map((m) => m.type)).toEqual(['reload', 'navigate']);
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
  });

  it('the reload path gates on OBSERVED bundle readiness when waitForBundle is wired', async () => {
    const driver = new FakeDriver().enableTerminate();
    const bridge = staleCapableBridge();
    const delays: number[] = [];
    let bundleWaits = 0;
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      bundleId: 'com.example.validity',
      expectedContentHash: 'new-hash-1111',
      waitForBundle: async () => {
        bundleWaits += 1;
        return true;
      },
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(bundleWaits).toBe(1);
    // warm settle only — no fixed 4s bundle sleep — plus the settle-gate interval.
    expect(delays).toEqual([200, 400]);
  });

  it("an {ok:false} ack from the reloaded session is FAILED verbatim — the fresh bundle really can't render it", async () => {
    const driver = new FakeDriver().enableTerminate();
    const bridge = staleCapableBridge({
      rendered: { ok: false, error: 'No component registered for "src/Gone.tsx"' },
    });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Gone.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      bundleId: 'com.example.validity',
      expectedContentHash: 'new-hash-1111',
      delay: async () => {},
    });
    expect(result.render).toMatchObject({
      status: 'failed',
      via: 'bridge-ack',
      error: 'No component registered for "src/Gone.tsx"',
    });
    // Authoritative: no terminate-ladder retry, no deep-link fallback.
    expect(driver.terminated).toEqual([]);
    expect(driver.calls.some((c) => c.startsWith('control') || c === 'open')).toBe(false);
  });

  it('a reload that never reconnects falls back to the terminate + cold-launch ladder', async () => {
    // The capability was announced but the fresh session never dialed back
    // (reload silently failed / device wedged) — the ladder is the recovery.
    const driver = new FakeDriver().enableTerminate();
    const bridge = staleCapableBridge({ reconnectsAfterReload: false });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      bundleId: 'com.example.validity',
      expectedContentHash: 'new-hash-1111',
      delay: async () => {},
    });
    expect(bridge.sent[0]).toEqual({ type: 'reload' }); // the attempt happened…
    expect(driver.terminated).toEqual(['com.example.validity']); // …then the ladder
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(true);
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
  });

  it('no live bridge session (cold boot): the reload is never pushed; the ladder runs', async () => {
    const driver = new FakeDriver().enableTerminate();
    const bridge = new FakeBridge({
      connected: false,
      connectsAfterBoot: true,
      rendered: { ok: true },
    });
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      forceReload: true,
      bundleId: 'com.example.validity',
      delay: async () => {},
    });
    expect(bridge.sent.some((m) => m.type === 'reload')).toBe(false);
    expect(driver.terminated).toEqual(['com.example.validity']);
  });
});

describe('captureNative — authoritative render status', () => {
  it('warm bridge ack ok → confirmed via bridge-ack, token matching the navigate', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
    expect(result.render.token).toBe((bridge.sent[0] as { token: string }).token);
  });

  // ---- the ack is not proof of paint (Android, dogfood round 4) -----------
  //
  // The companion's `rendered` ack fires after its JS mountAnimationFrame, so
  // it proves the JS committed, NOT that the view is on screen. On Android that
  // gap is real: the bridge acked {ok:true} in ~900ms against a BLANK screen
  // (0 accessibility-visible nodes; the screenshot showed only the dev-client
  // gear), and in a second repro against the dev-launcher error screen. The
  // render read 'confirmed' both times, the settle gate settled on a stable
  // wrong tree, and every criterion hard-FAILED an app that never drew.
  it('bridge ack WITHOUT the per-token marker on screen → unconfirmed, not confirmed', async () => {
    const driver = new FakeDriver();
    // The device never renders the marker: the JS acked, the view never drew.
    driver.waitResults = [okResult({ code: 1, stderr: 'no matching ref' })];
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(result.render.status).toBe('unconfirmed');
    expect(result.render.via).toBe('bridge-ack');
    expect(result.render.error).toMatch(/marker never appeared/);
    // NOT 'failed': the device didn't say it couldn't render the target — we
    // just couldn't prove paint. And an unconfirmed render skips checks, so no
    // criterion can hard-FAIL off this screen.
    expect(result.render.status).not.toBe('failed');
    expect(result.criterionVerdicts).toBeUndefined();
  });

  // ---- paint cross-check vs. the Expo dev menu ------------------------------
  //
  // A missed render marker has two causes that must not be conflated: the view
  // never painted, or something MODAL is covering it. The Expo dev menu is the
  // second kind and it is not rare — expo-dev-menu re-opens it on every
  // React-context init until a human finishes its onboarding, which never
  // happens on an installer-provisioned companion. Being modal it takes the
  // accessibility tree with it, so the marker cannot be found underneath no
  // matter how long the host waits.

  /** The SDK-55 Android dev-menu sheet, as agent-device serializes it. */
  const devMenuTree = [
    '# @e1 [text] "ValidityTestApp"',
    '# @e3 [button] "Reload"',
    '# @e4 [button] "Go home"',
    '# @e5 [button] "Performance monitor"',
    '# @e7 [button] "Open DevTools"',
  ].join('\n');

  it('marker missed + dev menu OBSERVED → dismiss, retry once, and confirm', async () => {
    const driver = new FakeDriver();
    // First wait misses (the menu is covering the app); the retry after the
    // dismissal finds the marker.
    driver.waitResults = [okResult({ code: 1, stderr: 'no matching ref' })];
    // Model the menu ACTUALLY closing: the tree shows the sheet until the
    // dismissal lands, and the app underneath afterwards. A fake whose tree
    // never changes would also exercise the settle gate's retry budget, which
    // is a different behaviour than the one under test here.
    const appTree = '# @e1 [text] "Button"';
    let menuUp = true;
    driver.snapResult = () => (menuUp ? devMenuTree : appTree);
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const realDismiss = bridge.dismissDevMenu.bind(bridge);
    bridge.dismissDevMenu = async () => {
      menuUp = false;
      return realDismiss();
    };
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    // The render is real and is reported as such — this is the whole point:
    // before the retry, a companion whose menu popped over a perfectly good
    // render made every criterion on it unverifiable.
    expect(result.render.status).toBe('confirmed');
    expect(result.render.error).toBeUndefined();
    // The dismissal went over the BRIDGE (the app closes its own menu); the
    // driver's screen-touching rung was never needed.
    expect(bridge.dismissDevMenuCalls).toBeGreaterThanOrEqual(1);
    expect(driver.calls.filter((c) => c === 'devmenu')).toEqual([]);
    // Exactly two marker waits: the miss and the one retry.
    expect(driver.calls.filter((c) => c.startsWith('wait:validity-root'))).toHaveLength(2);
  });

  it('marker missed and NO dev menu on screen → no retry, one wait, generic reason', async () => {
    // The cost guard. Closing the dev menu is an IDEMPOTENT native state write
    // that succeeds whether or not a menu was up, so gating the retry on the
    // dismissal's return value would re-run the full paintConfirmMs wait after
    // every honest miss. Gating on OBSERVING the menu keeps a genuine
    // never-painted render at one wait plus one cheap snapshot.
    const driver = new FakeDriver();
    driver.waitResult = okResult({ code: 1, stderr: 'no matching ref' }); // every wait misses
    driver.snapResult = '# @e1 [text] "Some component"\n# @e2 [button] "Submit"';
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(result.render.status).toBe('unconfirmed');
    expect(driver.calls.filter((c) => c.startsWith('wait:validity-root'))).toHaveLength(1);
    // Nothing was dismissed, and the reason blames the render — not a menu
    // nobody saw.
    expect(bridge.dismissDevMenuCalls).toBe(0);
    expect(result.render.error).toMatch(/marker never appeared/);
    expect(result.render.error).not.toMatch(/dev menu/i);
  });

  it('dev menu seen but UNDISMISSABLE → unconfirmed, and the reason says so', async () => {
    // An old companion binary (no 'dismiss-dev-menu' capability) on Android:
    // the bridge answers false and the driver has nothing to click. The run
    // must stay honest AND point at the companion rather than the component.
    const driver = new FakeDriver();
    driver.waitResult = okResult({ code: 1, stderr: 'no matching ref' });
    driver.snapResult = devMenuTree;
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    bridge.dismissDevMenuResult = false;
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(result.render.status).toBe('unconfirmed');
    expect(result.render.error).toMatch(/Expo dev menu was observed/);
    expect(result.render.error).toMatch(/rebuild the companion/);
    // NOT 'failed': the device never said it couldn't render the target, and an
    // unconfirmed render skips checks — so nothing can hard-FAIL off this.
    expect(result.criterionVerdicts).toBeUndefined();
    // Bounded: exactly one retry, never a spin.
    expect(driver.calls.filter((c) => c.startsWith('wait:validity-root'))).toHaveLength(2);
  });

  it('a driver whose waitForRef THROWS does not manufacture an unconfirmed', async () => {
    // Transport/infra noise is not evidence the view is blank.
    const driver = new FakeDriver();
    driver.waitForRef = async () => {
      throw new Error('agent-device session died');
    };
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(result.render.status).toBe('confirmed');
  });

  it('device {ok:false} ack → FAILED with the device error VERBATIM, no deep-link fallback', async () => {
    // The device authoritatively said the target cannot render ("No component
    // registered"). Previously this was dropped and treated like a timeout —
    // the agent got a placeholder screenshot presented as success. Now the
    // error is surfaced and the deep-link path (which would mount the same
    // placeholder) is never attempted.
    const driver = new FakeDriver();
    const bridge = new FakeBridge({
      connected: true,
      rendered: { ok: false, error: 'No component registered for "src/Nope.tsx"' },
    });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Nope.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(result.render.status).toBe('failed');
    expect(result.render.via).toBe('bridge-ack');
    expect(result.render.error).toBe('No component registered for "src/Nope.tsx"');
    // No deep-link retry, no cold reload — the ack is final.
    expect(driver.calls).not.toContain('open');
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(false);
    // The screenshot is still written (debug evidence of what IS on screen).
    expect(driver.calls).toContain('shot:/tmp/shot.png');
  });

  it('cold bridge {ok:false} ack (after control-link boot) → FAILED, never the deep-link rung', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({
      connected: false,
      connectsAfterBoot: true,
      rendered: { ok: false, error: 'View "Empty" resolved to no items' },
    });
    const result = await captureNative({
      driver,
      spec: { view: 'Empty' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(result.render).toMatchObject({
      status: 'failed',
      via: 'bridge-ack',
      error: 'View "Empty" resolved to no items',
    });
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(true); // boot happened
    expect(driver.calls).not.toContain('open'); // deep-link rung never reached
  });

  it('warm session: ack timeout + marker timeout → UNCONFIRMED via settle (the old silent success)', async () => {
    const driver = new FakeDriver();
    driver.waitResult = okResult({ code: 1 }); // tokenized marker never appears
    const bridge = new FakeBridge({ connected: true });
    bridge.rendered = null; // ack times out
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(result.render.status).toBe('unconfirmed');
    expect(result.render.via).toBe('settle');
    expect(result.render.error).toMatch(/never confirmed/i);
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(false); // still splash-safe
  });

  it('skipPreload marker timeout (no bridge) → UNCONFIRMED with the marker reason', async () => {
    const driver = new FakeDriver();
    driver.waitResult = okResult({ code: 1 });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      skipPreload: true,
      delay: async () => {},
    });
    expect(result.render.status).toBe('unconfirmed');
    expect(result.render.error).toMatch(/render marker "validity-root:nav-/);
  });

  it('cold deep-link marker timeout → UNCONFIRMED ("bundle may still be compiling"), settle delay', async () => {
    const driver = new FakeDriver();
    driver.waitResult = okResult({ code: 1 }); // warm AND cold marker waits fail
    const delays: number[] = [];
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result.render.status).toBe('unconfirmed');
    expect(result.render.via).toBe('settle');
    expect(result.render.error).toMatch(/still be compiling/);
    expect(delays).toEqual([4000, 1200]); // bundle wait + settle fallback
  });

  it('deep-link path ships the token in the link spec and waits on the PER-NAVIGATION marker', async () => {
    const driver = new FakeDriver();
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      delay: async () => {},
    });
    const token = driver.lastOpenSpec?.token;
    expect(token).toMatch(/^nav-/);
    // The marker wait targets exactly this navigation's token — a stale
    // previous render (old token) can no longer satisfy it.
    expect(driver.calls).toContain(`wait:validity-root:${token}:3500`);
  });

  it('an explicit renderMarkerRef overrides the tokenized marker (escape hatch)', async () => {
    const driver = new FakeDriver();
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      renderMarkerRef: 'my-marker',
      delay: async () => {},
    });
    expect(driver.calls).toContain('wait:my-marker:3500');
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'marker' });
  });
});

describe('captureNative', () => {
  it('warm-re-targets (deep link only, NO bundle reload) when the marker renders', async () => {
    // The companion is already foreground + serving — switching components must
    // NOT reload the bundle (a reload re-presents the native splash and JS can no
    // longer hide it). So no control link; just deep-link → settle → capture.
    const driver = new FakeDriver();
    const delays: number[] = [];
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      metroUrl: 'http://localhost:8082',
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(norm(driver.calls)).toEqual([
      'dismiss',
      'open',
      'wait:validity-root:<token>:3500',
      'snap',
      'snap',
      'shot:/tmp/shot.png',
      'snap',
    ]);
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(false);
    // Warm probe never TOUCHES THE SCREEN before the screenshot: no dev-menu
    // dismissal (which used to click a rendered modal's own 'Close' button),
    // no alert accept. The single up-front `dismiss` clears only a stale
    // LogBox/RedBox from a previous run — screen-safe by construction. (The two
    // extra `snap`s before the shot are the settle-gate polls, read-only.)
    expect(driver.calls.filter((c) => ['devmenu', 'alert'].includes(c))).toEqual([]);
    expect(driver.calls.filter((c) => c === 'dismiss')).toEqual(['dismiss']);
    // Warm-settle (let the new component paint) + the settle-gate interval — no bundle wait.
    expect(delays).toEqual([200, 400]);
    expect(result.screenshotPath).toBe('/tmp/shot.png');
    expect(result.a11ySnapshot).toBe('a11y-tree');
    expect(result.url).toBe('myapp://validity?component=Foo');
    // The per-token marker matching IS the confirmation.
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'marker' });
    expect(result.render.token).toMatch(/^nav-/);
  });

  it('cold-falls-back (control link → reroute → render-wait) when the warm marker never renders', async () => {
    const driver = new FakeDriver();
    driver.waitResults = [okResult({ code: 1, stderr: 'warm timeout' })]; // warm fails; cold ok
    const delays: number[] = [];
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      metroUrl: 'http://localhost:8082',
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(norm(driver.calls)).toEqual([
      'dismiss', // up-front stale-LogBox clear (screen-safe)
      'open', // warm probe — no screen-touching dismissals
      'wait:validity-root:<token>:3500', // warm wait → fails
      'snap', // dev-launcher probe: this fake has no activity probe → screen content
      'control:http://localhost:8082', // cold fallback
      'open',
      'dismiss', // cold boot parks on the launcher/menu — dismissing is correct here
      'devmenu',
      'alert',
      'wait:validity-root:<token>:8000', // cold render-wait → ok
      'snap', // settle-gate poll A (Bug 6)
      'snap', // settle-gate poll B — agrees, no loading marker → settled
      'shot:/tmp/shot.png',
      'snap',
    ]);
    // Bundle wait + the settle-gate interval — cold render-wait resolved, so no
    // settle fallback.
    expect(delays).toEqual([4000, 400]);
  });

  it('cold deep-link fallback also gates on waitForBundle (no fixed bundle sleep)', async () => {
    const driver = new FakeDriver();
    driver.waitResults = [okResult({ code: 1, stderr: 'warm timeout' })]; // warm fails; cold ok
    const delays: number[] = [];
    let bundleWaits = 0;
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      metroUrl: 'http://localhost:8082',
      waitForBundle: async () => {
        bundleWaits += 1;
        return true;
      },
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(true); // cold rung reached
    expect(bundleWaits).toBe(1);
    // Only the settle-gate interval — cold render-wait confirmed → no settle
    // fallback, no fixed bundle sleep.
    expect(delays).toEqual([400]);
  });

  it('skipPreload pins warm-only — never reloads, even if the marker times out', async () => {
    const driver = new FakeDriver();
    driver.waitResults = [okResult({ code: 1, stderr: 'timeout' })]; // warm wait fails
    const delays: number[] = [];
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      skipPreload: true,
      settleMs: 1500,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(false);
    expect(norm(driver.calls)).toEqual([
      'dismiss',
      'open',
      'wait:validity-root:<token>:3500',
      // The dev-launcher probe — the ONE thing the warm pin now looks at before
      // settling. This fake's screen is 'a11y-tree', i.e. not the launcher, so
      // the pin holds and no bundle is reloaded.
      'snap',
      'shot:/tmp/shot.png',
      'snap',
    ]);
    expect(delays).toEqual([1500]); // settle fallback, no bundle reload
  });

  it('breaks the warm pin when the device is parked on the dev-launcher home', async () => {
    // The Android blocker: `adb install -r` (or a crash, or the user pressing
    // home) leaves the companion on expo-dev-launcher's server picker with NO
    // bundle loaded, while the host bridge can still report a connection
    // through the adb-reverse tunnel. Deep-linking that screen can never work —
    // only the dev-client control link loads a bundle — so the warm pin has to
    // yield, or every Android capture settles on the launcher and reports
    // `unconfirmed` forever.
    const driver = new FakeDriver();
    driver.waitResults = [
      okResult({ code: 1, stderr: 'timeout' }), // warm marker never appears
      okResult(), // cold render-wait, after the control link, succeeds
    ];
    driver.snapResult = '@e21 [text] "Development Build"\n@e27 [text] "DEVELOPMENT SERVERS"';
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      metroUrl: 'http://localhost:8082',
      skipPreload: true,
      delay: async () => {},
    });
    expect(driver.calls.some((c) => c.startsWith('control:http://localhost:8082'))).toBe(true);
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'marker' });
  });

  it('prefers the activity probe over screen content for the launcher check', async () => {
    // On Android the foreground activity is a class name, not English copy, so
    // it cannot drift with an Expo release. When it answers, it decides — and a
    // launcher-shaped a11y tree must not override a healthy MainActivity.
    const driver = new FakeDriver();
    driver.waitResults = [okResult({ code: 1, stderr: 'timeout' })];
    driver.snapResult = '@e21 [text] "Development Build"\n@e27 [text] "DEVELOPMENT SERVERS"';
    driver.foregroundActivity = async () => 'ai.validity.playground/.MainActivity';
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      skipPreload: true,
      delay: async () => {},
    });
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(false);
    expect(result.render).toMatchObject({ status: 'unconfirmed', via: 'settle' });
  });

  it('taps OUR server row on a wedged launcher and recovers the render', async () => {
    // Upstream task #24: after an emulator reboot the launcher swallows the
    // deep link, and re-delivering it changes nothing — the fix a human
    // performed on 2026-07-30 was one tap on the companion's server row. This
    // is that tap, automated: strictly OUR row (loopback host + companion
    // port), then the target deep link again now that JS exists to receive it.
    const driver = new FakeDriver();
    driver.waitResults = [
      okResult({ code: 1, stderr: 'timeout' }), // warm marker never appears
      okResult({ code: 1, stderr: 'timeout' }), // cold render-wait: still the picker
      okResult(), // post-tap render-wait: the marker paints
    ];
    driver.snapResult = [
      '@e27 [text] "DEVELOPMENT SERVERS"',
      '@e30 [group] "http://10.0.2.2:8083"',
      '@e35 [group] "http://10.0.2.2:8082"',
      '@e44 [text] "RECENTLY OPENED"',
    ].join('\n');
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      metroUrl: 'http://localhost:8082',
      delay: async () => {},
    });
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'marker' });
    // The row tapped is the companion's — never the bridge port or a LAN peer.
    expect(driver.calls).toContain('click:@e35');
    // The deep link was re-delivered after the tap.
    expect(driver.calls.filter((c) => c === 'open').length).toBeGreaterThanOrEqual(2);
  });

  it('gives up in one attempt when the picker has no matching row', async () => {
    // A launcher listing only foreign servers must not be tapped at all — a
    // stranger's bundle is worse than an honest unconfirmed report.
    const driver = new FakeDriver();
    driver.waitResult = okResult({ code: 1, stderr: 'timeout' });
    driver.snapResult = [
      '@e27 [text] "DEVELOPMENT SERVERS"',
      '@e44 [text] "RECENTLY OPENED"',
      '@e47 [group] "Validity, http://192.168.68.65:8082"',
    ].join('\n');
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      metroUrl: 'http://localhost:8082',
      delay: async () => {},
    });
    expect(result.render.status).toBe('unconfirmed');
    expect(driver.calls.some((c) => c.startsWith('click:'))).toBe(false);
    expect(result.render.error).toMatch(/STILL on the expo-dev-launcher home/);
  });

  it('names the launcher in the cold-open failure reason instead of guessing at a slow build', async () => {
    // "the bundle may still be compiling" and "the dev-client never loaded a
    // bundle" send a reader to different places. Once the control link has been
    // delivered and the launcher is STILL up, it is the second one.
    const driver = new FakeDriver();
    driver.waitResult = okResult({ code: 1, stderr: 'timeout' });
    driver.snapResult = '@e27 [text] "DEVELOPMENT SERVERS"\n@e44 [text] "RECENTLY OPENED"';
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      delay: async () => {},
    });
    expect(result.render.status).toBe('unconfirmed');
    expect(result.render.error).toMatch(/STILL on the expo-dev-launcher home/);
    expect(result.render.error).toMatch(/adb reverse tcp:8082/);
  });

  it('takes a pristine PRE-interaction shot before click/fill checks mutate the screen', async () => {
    // Soft evidence hygiene: the evidence shot stays post-interaction (web
    // parity, baseline identity), but interactive checks get a labeled
    // companion so initial-state soft criteria aren't scored on click residue.
    const driver = new FakeDriver();
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      delay: async () => {},
      criteriaChecks: [
        {
          id: 'AC-1',
          text: 'tapping Go navigates',
          tier: 'hard',
          checks: [{ click: { text: 'Go' } }],
        } as never,
      ],
    });
    const shots = driver.calls.filter((c) => c.startsWith('shot:'));
    expect(shots[0]).toBe('shot:/tmp/shot.pre-interaction.png');
    expect(shots[shots.length - 1]).toBe('shot:/tmp/shot.png');
    expect(result.preInteractionScreenshotPath).toBe('/tmp/shot.pre-interaction.png');
    expect(result.screenshotPath).toBe('/tmp/shot.png');
  });

  it('assert-only checks take NO pre-interaction shot (the screen is untouched)', async () => {
    const driver = new FakeDriver();
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      delay: async () => {},
      criteriaChecks: [
        {
          id: 'AC-1',
          text: 'no console errors',
          tier: 'hard',
          checks: [{ expect: { console: { errors: 0 } } }],
        } as never,
      ],
    });
    expect(driver.calls.filter((c) => c.startsWith('shot:'))).toEqual(['shot:/tmp/shot.png']);
    expect(result.preInteractionScreenshotPath).toBeUndefined();
  });

  it('does not fail when the overlay/alert steps return non-zero (cold rung)', async () => {
    const driver = new FakeDriver();
    driver.waitResults = [okResult({ code: 1, stderr: 'warm timeout' })]; // reach the cold rung (where dismissals run)
    driver.dismissResult = okResult({ code: 1, stderr: 'no overlay' });
    driver.alertResult = okResult({ code: 1, stderr: 'no alert' });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      delay: async () => {},
    });
    expect(driver.calls).toContain('dismiss'); // the failing steps actually ran
    expect(driver.calls).toContain('shot:/tmp/shot.png');
    expect(result.screenshotPath).toBe('/tmp/shot.png');
  });

  it('throws a helpful error when the cold-fallback bundle preload (control link) fails', async () => {
    const driver = new FakeDriver();
    driver.waitResults = [okResult({ code: 1, stderr: 'warm timeout' })]; // force cold fallback
    driver.controlResult = okResult({ code: 1, stderr: 'no device' });
    await expect(
      captureNative({
        driver,
        spec: { component: 'src/Button.tsx' },
        screenshotPath: '/tmp/shot.png',
        delay: async () => {},
      }),
    ).rejects.toThrow(/dev-client bundle/);
  });

  it('throws a helpful error when opening the deep link fails', async () => {
    const driver = new FakeDriver();
    driver.openResult = okResult({ code: 1, stderr: 'no device' }); // both warm + cold open fail
    await expect(
      captureNative({
        driver,
        spec: { component: 'src/Button.tsx' },
        screenshotPath: '/tmp/shot.png',
        delay: async () => {},
      }),
    ).rejects.toThrow(/Failed to open/);
  });

  it('throws when the screenshot fails', async () => {
    const driver = new FakeDriver();
    driver.shotResult = okResult({ code: 1, stderr: 'capture failed' });
    await expect(
      captureNative({
        driver,
        spec: { component: 'src/Button.tsx' },
        screenshotPath: '/tmp/shot.png',
        delay: async () => {},
      }),
    ).rejects.toThrow(/Screenshot failed/);
  });

  it('treats a failing a11y snapshot as best-effort', async () => {
    const driver = new FakeDriver();
    driver.snapResult = () => {
      throw new Error('no a11y');
    };
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      delay: async () => {},
    });
    expect(result.a11ySnapshot).toBe('');
  });
});

describe('browseNative', () => {
  it('warm-re-targets (deep link + render-wait, no screen-touching dismissals) without capturing', async () => {
    const driver = new FakeDriver();
    const result = await browseNative(
      driver,
      { component: 'src/Button.tsx' },
      { metroUrl: 'http://localhost:8082', delay: async () => {} },
    );
    // The single leading dismiss clears only a stale LogBox/RedBox (screen-safe);
    // dev-menu/alert dismissals stay cold-only.
    expect(norm(driver.calls)).toEqual(['dismiss', 'open', 'wait:validity-root:<token>:3500']);
    expect(driver.calls.some((c) => c.startsWith('control'))).toBe(false);
    expect(driver.calls).not.toContain('snap');
    expect(driver.calls.some((c) => c.startsWith('shot'))).toBe(false);
    expect(result.url).toBe('myapp://validity?component=Foo');
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'marker' });
  });

  it('throws when the device is not ready (warm fails, then cold preload fails)', async () => {
    const driver = new FakeDriver();
    driver.waitResults = [okResult({ code: 1, stderr: 'warm timeout' })];
    driver.controlResult = okResult({ code: 1, stderr: 'device offline' });
    await expect(
      browseNative(driver, { component: 'src/A.tsx' }, { delay: async () => {} }),
    ).rejects.toThrow(/dev-client bundle|Failed to open/i);
  });

  it('surfaces UNCONFIRMED instead of silent success when warm-pinned and the marker never renders', async () => {
    const driver = new FakeDriver();
    driver.waitResult = okResult({ code: 1 });
    const result = await browseNative(
      driver,
      { component: 'src/A.tsx' },
      { skipPreload: true, delay: async () => {} },
    );
    expect(result.render.status).toBe('unconfirmed');
    expect(result.render.via).toBe('settle');
  });

  it('surfaces the device {ok:false} ack as FAILED with the error verbatim', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({
      connected: true,
      rendered: { ok: false, error: 'No component registered for "src/A.tsx"' },
    });
    const result = await browseNative(
      driver,
      { component: 'src/A.tsx' },
      { bridge, delay: async () => {} },
    );
    expect(result.render).toMatchObject({
      status: 'failed',
      via: 'bridge-ack',
      error: 'No component registered for "src/A.tsx"',
    });
  });
});

describe('captureNative — snapshot-stability gate (cold-start check race, Bug 6)', () => {
  // The gate is the structural fix for the cold-start race: the bridge `rendered`
  // ack fires before the dev-client "Refreshing…" overlay clears, so a check
  // reading the a11y tree in that window false-FAILs (heading-visible →
  // presence:false) while the LATER final snapshot already contains the node.
  // The gate holds the check loop at the capture level until two consecutive
  // snapshots agree AND carry no loading marker. These cover the three
  // sequences the spec requires: (a) churn→stable, (b) frozen-marker→clean,
  // (c) never-settles → timed-out capture STILL proceeds.

  /**
   * FakeDriver that scripts a snapshot SEQUENCE (consumed left-to-right, then
   * frozen on the last frame). `snapCount` lets a test assert HOW MANY times
   * the gate polled before the capture proceeded to the screenshot. An EMPTY
   * `frames` array defers to the inherited `snapResult` (a per-call churn fn),
   * so a test can script an endlessly-changing tree that never settles.
   */
  class SeqDriver extends FakeDriver {
    snapCount = 0;
    constructor(
      private frames: string[],
      url = 'myapp://validity?component=Foo',
    ) {
      super(url);
    }
    async snapshot(): Promise<string> {
      this.calls.push('snap');
      this.snapCount += 1;
      if (this.frames.length === 0) {
        return typeof this.snapResult === 'function' ? this.snapResult() : this.snapResult;
      }
      return this.frames[Math.min(this.snapCount - 1, this.frames.length - 1)];
    }
  }

  it('(a) churn → stable: the gate waits for the tree to settle before the screenshot', async () => {
    // The warm bridge ack confirms paint, but the first few a11y frames still
    // show the churning dev-client overlay; the gate must advance past them
    // before the evidence screenshot + checks read the tree.
    const driver = new SeqDriver([
      '# @e1 [text] "Refreshing…"',
      '# @e1 [text] "Loading 12%"',
      '# @e1 [heading] "Welcome back"',
      '# @e1 [heading] "Welcome back"',
    ]);
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Dashboard.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      criteriaChecks: [
        {
          id: 'AC-1',
          text: 'heading is visible',
          tier: 'hard',
          checks: [{ expect: { element: { role: 'heading', name: 'Welcome back' } } }],
        } as never,
      ],
      // Real delay so the gate's wall-clock timeout is exercised (the no-op
      // test delay never advances Date.now) — but tiny budgets keep it fast.
      delay: async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
      },
      settleGateWarmMs: 2000,
      settleGateIntervalMs: 5,
    });
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
    // The snapshot was polled MORE than twice (it advanced past the churn + the
    // frozen marker), proving the gate did not settle on the loading frames.
    expect(driver.snapCount).toBeGreaterThan(2);
    // And the capture proceeded to the evidence screenshot + final snapshot.
    expect(driver.calls).toContain('shot:/tmp/shot.png');
  });

  it('(b) frozen "Refreshing…" → clean: the gate does NOT settle on an identical marker pair', async () => {
    // Two byte-identical frames BOTH carrying "Refreshing…" must keep polling —
    // a frozen loading overlay is equal across snapshots yet still hides the
    // real UI. Only the clean pair settles.
    const driver = new SeqDriver([
      '# @e1 [text] "Refreshing…"',
      '# @e1 [text] "Refreshing…"',
      '# @e1 [text] "Refreshing…"',
      '# @e1 [heading] "Welcome back"',
      '# @e1 [heading] "Welcome back"',
    ]);
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    await captureNative({
      driver,
      spec: { component: 'src/Dashboard.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      criteriaChecks: [
        {
          id: 'AC-1',
          text: 'heading is visible',
          tier: 'hard',
          checks: [{ expect: { element: { role: 'heading', name: 'Welcome back' } } }],
        } as never,
      ],
      delay: async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
      },
      settleGateWarmMs: 2000,
      settleGateIntervalMs: 5,
    });
    // It advanced PAST the 3 frozen marker frames (≥ 5 polls: baseline + the
    // marker pairs + the clean pair), never settling on the identical-but-
    // marked pair.
    expect(driver.snapCount).toBeGreaterThanOrEqual(5);
  });

  it('(c) never settles → gate times out, capture STILL proceeds (no false capture FAIL) + warns', async () => {
    // Every a11y frame is a fresh counter → equality never holds, so the gate
    // hits its timeout. The capture MUST still take the screenshot (the gate is
    // advisory — never block capture) and surface the race via console.warn so
    // a false check-FAIL can be diagnosed instead of silently blamed on the
    // spec. A short warm budget keeps the test fast.
    // Empty frames → SeqDriver defers to snapResult, a per-call counter that
    // ALWAYS churns (never repeats) so the gate can never find an identical pair.
    const driver = new SeqDriver([]);
    let churn = 0;
    driver.snapResult = () => `# @e1 [text] "churn ${churn++}"`;
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await captureNative({
      driver,
      spec: { component: 'src/Dashboard.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      criteriaChecks: [
        {
          id: 'AC-1',
          text: 'heading is visible',
          tier: 'hard',
          checks: [{ expect: { element: { role: 'heading', name: 'Welcome back' } } }],
        } as never,
      ],
      delay: async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
      },
      settleGateWarmMs: 60, // short, so the test stays fast
      settleGateIntervalMs: 10,
    });
    // The capture proceeded despite the never-settling gate.
    expect(result.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
    expect(driver.calls).toContain('shot:/tmp/shot.png');
    // And the race was made observable (the package's existing warn convention).
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => /never settled/.test(String(c[0])))).toBe(true);
    warnSpy.mockRestore();
  });

  it('no criteriaChecks → the gate STILL runs (the evidence SCREENSHOT is scored too)', async () => {
    // The gate is keyed on a CONFIRMED render, NOT on criteriaChecks: the
    // native verify path attaches checks to only ONE base-render target while
    // every scenario/fixture/theme VARIANT (and native_browse) still produces a
    // scored screenshot with no checks. Gating only when checks are present
    // would leave all those screenshots racing the same "Refreshing…" overlay.
    // Here a churn→stable sequence with NO checks must still poll past the
    // loading frame before the evidence screenshot is taken.
    const driver = new SeqDriver([
      '# @e1 [text] "Refreshing…"',
      '# @e1 [heading] "Profile"',
      '# @e1 [heading] "Profile"',
    ]);
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    await captureNative({
      driver,
      spec: { component: 'src/Profile.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      criteriaChecks: [],
      delay: async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
      },
      settleGateWarmMs: 2000,
      settleGateIntervalMs: 5,
    });
    // The gate advanced past the "Refreshing…" frame (baseline + the churn
    // compare + the settling clean pair = ≥3 polls) BEFORE the sole final
    // grounding snapshot — proving it ran even with no checks. Under the old
    // check-only gating this would have been a single (final) snapshot.
    expect(driver.snapCount).toBeGreaterThanOrEqual(3);
    expect(driver.calls).toContain('shot:/tmp/shot.png');
  });

  // ---- unsettled tree must not produce a FAIL ------------------------------
  //
  // Found on the first Android run ever attempted: the companion ANR'd, so the
  // a11y tree was the system "Close app / Wait" dialog. The gate correctly
  // timed out and warned — and both criteria then reported a confident hard
  // FAIL against that dialog. A warning next to a false red is still a false
  // red.

  /** A tree that never settles: every frame differs, none is a loading marker. */
  function churningDriver(): SeqDriver {
    const d = new SeqDriver([]);
    let n = 0;
    d.snapResult = () => `# @e1 [button] "Close app"\n# @e2 [text] "tick ${n++}"`;
    return d;
  }

  const headingCriterion = {
    id: 'AC-1',
    text: 'the heading is visible',
    tier: 'hard',
    // `state: 'visible'` on purpose: a BARE presence assertion resolves
    // `unverifiable` when absent (it cannot tell "gone" from "not exposed"),
    // so it would never exercise the fail→unverifiable demotion at all.
    checks: [{ expect: { element: { role: 'heading', name: 'Welcome back', state: 'visible' } } }],
  } as never;

  it('demotes a FAIL to unverifiable when the tree never settled', async () => {
    const driver = churningDriver();
    const result = await captureNative({
      driver,
      spec: { component: 'src/Dashboard.tsx' },
      screenshotPath: '/tmp/shot.png',
      criteriaChecks: [headingCriterion],
      delay: async () => {},
      settleGateWarmMs: 30,
      settleGateIntervalMs: 5,
    });
    const v = result.criterionVerdicts?.[0];
    expect(v?.status).toBe('unverifiable');
    expect(v?.detail).toContain('never settled');
    // The original finding is preserved, not thrown away — a reader can still
    // see WHAT the check concluded, just not treat it as a verdict.
    expect(v?.detail).toContain('was:');
    // The capture still proceeds: the gate must never block evidence.
    expect(driver.calls).toContain('shot:/tmp/shot.png');
  });

  it('leaves a PASS alone on an unsettled tree — unsettledness cannot fabricate a match', async () => {
    const driver = new SeqDriver([]);
    let n = 0;
    // Never settles (every frame differs) but the heading IS present in each.
    driver.snapResult = () => `# @e1 [heading] "Welcome back"\n# @e2 [text] "tick ${n++}"`;
    const result = await captureNative({
      driver,
      spec: { component: 'src/Dashboard.tsx' },
      screenshotPath: '/tmp/shot.png',
      criteriaChecks: [headingCriterion],
      delay: async () => {},
      settleGateWarmMs: 30,
      settleGateIntervalMs: 5,
    });
    expect(result.criterionVerdicts?.[0]?.status).toBe('pass');
  });

  it('demotes a FAIL to unverifiable when the a11y tree is EMPTY', async () => {
    // The Android case, verified on a freshly built companion: the bridge acked
    // `rendered {ok:true}` in ~900ms while the screen was blank. The ack fires
    // after the companion's JS mountAnimationFrame, which is not proof of
    // paint — so the render read 'confirmed', the gate settled happily on
    // nothing, and both criteria hard-FAILED an app that never drew. A tree
    // with no element rows cannot support "the heading is missing".
    const driver = new SeqDriver(['Page: app://x\nApp: ai.validity.playground\nSnapshot: 0 nodes']);
    const result = await captureNative({
      driver,
      spec: { component: 'src/Dashboard.tsx' },
      screenshotPath: '/tmp/shot.png',
      criteriaChecks: [headingCriterion],
      delay: async () => {},
      settleGateWarmMs: 2000,
      settleGateIntervalMs: 5,
    });
    const v = result.criterionVerdicts?.[0];
    expect(v?.status).toBe('unverifiable');
    expect(v?.detail).toContain('EMPTY');
    expect(v?.detail).toContain('not proof of paint');
    // Evidence is still captured — the demotion never blocks the screenshot.
    expect(driver.calls).toContain('shot:/tmp/shot.png');
  });

  it('a SETTLED tree still reports a real FAIL — the demotion is not blanket', async () => {
    // Guard against the fix turning every native failure into unverifiable.
    const driver = new SeqDriver([
      '# @e1 [text] "Something else"',
      '# @e1 [text] "Something else"',
      '# @e1 [text] "Something else"',
    ]);
    const result = await captureNative({
      driver,
      spec: { component: 'src/Dashboard.tsx' },
      screenshotPath: '/tmp/shot.png',
      criteriaChecks: [headingCriterion],
      delay: async () => {},
      settleGateWarmMs: 2000,
      settleGateIntervalMs: 5,
    });
    expect(result.criterionVerdicts?.[0]?.status).toBe('fail');
  });
});

/**
 * Per-capture instrumentation. This is the evidence base for the session-decay
 * blocker: the same build scores 33 pass on a cold emulator and, hours later,
 * renders nothing but `unconfirmed` — with no record of what changed in
 * between. Both of these are additive: a capture must behave identically with
 * and without them.
 */
describe('captureNative — agent-device session readiness gate', () => {
  // THE REGRESSION. Measured on iOS 2026-07-29: the agent-device daemon was
  // cold at sweep start (`doctor`: "daemon state: Not running"; `session list`
  // empty) while the companion APP was still running from an earlier session.
  // Validity's control bridge is a WS to that app process, so `isConnected()`
  // was true, the bridge fast-path acked renders, and coldOpen returned without
  // ever reaching openControlLink/openTarget — the only calls that open an
  // agent-device session. The commands that read EVIDENCE went out anyway and
  // answered SESSION_NOT_FOUND for 3m18s across seven consecutive specs, every
  // one reported as blocked with `cause: unknown`. The first `open` landed at
  // T+3m40s and every later spec worked.

  it('opens the session BEFORE any session-scoped command, warm bridge included', async () => {
    const driver = new FakeDriver().enableSessionGate();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    // First thing that happens, ahead of the LogBox clear, the paint
    // cross-check `wait`, the settle-gate `snap`s and the `shot`.
    expect(driver.calls[0]).toBe('ensureSession');
    const firstSessionScoped = driver.calls.findIndex((c) =>
      /^(wait|snap|shot|dismiss|click|alert)/.test(c),
    );
    expect(driver.calls.indexOf('ensureSession')).toBeLessThan(firstSessionScoped);
    // …and it is asked to open the target's own deep link, not some placeholder.
    expect(driver.sessionUrls).toEqual(['myapp://validity?component=Foo']);
  });

  it('runs the gate on the in-place reload path too — it has the same hole', async () => {
    // reloadViaBridge confirms over the bridge and returns, so a gate placed
    // below it would be skipped on exactly the runs that reload.
    const driver = new FakeDriver().enableSessionGate();
    const bridge = new FakeBridge({
      connected: true,
      rendered: { ok: true },
      info: { contentHash: 'old-hash-0000', capabilities: ['reload'] },
    });
    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      expectedContentHash: 'new-hash-1111',
      delay: async () => {},
    });
    expect(bridge.sent.map((m) => m.type)).toEqual(['reload', 'navigate']);
    expect(cap.render).toMatchObject({ status: 'confirmed', via: 'bridge-ack' });
    expect(driver.calls[0]).toBe('ensureSession');
  });

  it('asks EXACTLY once per capture — the gate is not a per-command retry', async () => {
    const driver = new FakeDriver().enableSessionGate();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(driver.calls.filter((c) => c === 'ensureSession')).toHaveLength(1);
  });

  it('a driver without the capability behaves exactly as before', async () => {
    // Minimal drivers and fakes must not be forced to grow a session concept.
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(driver.calls).toEqual([
      'dismiss',
      `wait:validity-root:${(bridge.sent[0] as { token: string }).token}:2500`,
      'snap',
      'snap',
      'shot:/tmp/shot.png',
      'snap',
    ]);
    expect(cap.render.status).toBe('confirmed');
  });

  it('NEVER fails the capture when the gate cannot open a session', async () => {
    // The gate is additive. A hard failure here would convert a recoverable
    // environment into a red build — the trade this codebase never makes.
    const driver = new FakeDriver().enableSessionGate({
      ready: false,
      via: 'failed',
      errorText: 'Error (SESSION_NOT_FOUND): No active session. Run open first.',
    });
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(cap.render.status).toBe('confirmed');
  });

  it('a THROWING gate is swallowed — it can cost attribution, never the run', async () => {
    const driver = new FakeDriver();
    driver.ensureSession = async () => {
      throw new Error('boom');
    };
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
    });
    expect(cap.render.status).toBe('confirmed');
  });

  it('names the missing session on the throw that used to arrive as `cause: unknown`', async () => {
    // The CLI's native engine feeds this message straight into openErrorText.
    // Before the gate, a session-less screenshot failure carried only
    // agent-device's stderr — and when that was empty, nothing at all.
    const driver = new FakeDriver().enableSessionGate({
      ready: false,
      via: 'failed',
      errorText: '`agent-device open` did not establish a session',
    });
    driver.shotResult = okResult({ code: 1, stderr: '' });
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    await expect(
      captureNative({
        driver,
        spec: { component: 'src/Button.tsx' },
        screenshotPath: '/tmp/shot.png',
        bridge,
        delay: async () => {},
      }),
    ).rejects.toThrow(/did not establish a session/);
  });

  it('hands the readiness to the diagnosis, so an unconfirmed render names the cause', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'validity-session-gate-'));
    try {
      const driver = new FakeDriver().enableSessionGate({
        ready: false,
        via: 'failed',
        errorText: 'Error (SESSION_NOT_FOUND): No active session. Run open first.',
      });
      driver.waitResults = [okResult({ code: 1, stderr: 'no matching ref' })];
      const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
      const diagnose = vi.fn(async () => ({
        cause: 'no-native-session' as const,
        symptom: 'observed',
        detail: 'explained',
        confidence: 'confirmed' as const,
      }));
      const cap = await captureNative({
        driver,
        spec: { component: 'src/Button.tsx' },
        screenshotPath: '/tmp/shot.png',
        bridge,
        delay: async () => {},
        projectRoot,
        diagnose: diagnose as never,
      });
      expect(cap.render.status).toBe('unconfirmed');
      expect(diagnose).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionEstablished: false,
          openErrorText: expect.stringContaining('SESSION_NOT_FOUND'),
        }),
      );
      expect(cap.diagnosis?.cause).toBe('no-native-session');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('tells the diagnosis the session WAS open, so it looks elsewhere', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'validity-session-gate-'));
    try {
      const driver = new FakeDriver().enableSessionGate({ ready: true, via: 'already-open' });
      driver.waitResults = [okResult({ code: 1, stderr: 'no matching ref' })];
      const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
      const diagnose = vi.fn(async () => ({
        cause: 'render-failure' as const,
        symptom: 'observed',
        detail: 'explained',
        confidence: 'suspected' as const,
      }));
      await captureNative({
        driver,
        spec: { component: 'src/Button.tsx' },
        screenshotPath: '/tmp/shot.png',
        bridge,
        delay: async () => {},
        projectRoot,
        diagnose: diagnose as never,
      });
      const arg = diagnose.mock.calls[0]![0] as { sessionEstablished?: boolean };
      expect(arg.sessionEstablished).toBe(true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('captureNative — session metrics + diagnosis', () => {
  const projects: string[] = [];
  const newProject = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'validity-capture-metrics-'));
    projects.push(dir);
    return dir;
  };
  afterEach(() => {
    while (projects.length) rmSync(projects.pop()!, { recursive: true, force: true });
  });

  it('appends one metrics row per capture, with the phase timings and render status', async () => {
    const projectRoot = newProject();
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
      projectRoot,
      specId: 'spec-e221',
    });

    const rows = readSessionMetrics(projectRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      platform: 'ios',
      specId: 'spec-e221',
      renderStatus: 'confirmed',
    });
    expect(typeof rows[0]!.openMs).toBe('number');
    expect(typeof rows[0]!.snapshotMs).toBe('number');
  });

  it('writes nothing and diagnoses nothing without a projectRoot', async () => {
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const diagnose = vi.fn();
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
      diagnose: diagnose as never,
    });
    expect(result.diagnosis).toBeUndefined();
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('attaches a diagnosis to an UNCONFIRMED render, without changing the verdict semantics', async () => {
    const projectRoot = newProject();
    const driver = new FakeDriver();
    driver.waitResults = [okResult({ code: 1, stderr: 'no matching ref' })];
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const diagnose = vi.fn(async () => ({
      cause: 'phantom-device-claim' as const,
      symptom: 'observed',
      detail: 'explained',
      fixCommand: 'kill …',
      confidence: 'confirmed' as const,
    }));
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
      projectRoot,
      diagnose: diagnose as never,
    });

    expect(result.render.status).toBe('unconfirmed');
    expect(result.diagnosis?.cause).toBe('phantom-device-claim');
    // The gate is untouched: an unconfirmed render still produces no verdicts.
    expect(result.criterionVerdicts).toBeUndefined();
    expect(readSessionMetrics(projectRoot)[0]!.renderStatus).toBe('unconfirmed');
  });

  // ---- 2026-07-29: the diagnosis must SEE what the capture saw -------------
  it('feeds the a11y snapshot and the bridge platform mismatch into the diagnosis', async () => {
    const projectRoot = newProject();
    const driver = new FakeDriver();
    driver.waitResults = [okResult({ code: 1, stderr: 'no matching ref' })];
    // What the capture actually read. Deliberately NOT a dev-menu tree here:
    // an on-screen dev menu sends the capture down its own dismiss+retry rung,
    // and this test is about the snapshot REACHING the diagnosis at all. The
    // dev-surface probes themselves are unit-tested in environment-diagnosis.
    driver.snapResult = '# @e1 [header] "Sign in"\n# @e2 [button] "Continue"';
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    bridge.platformMismatchValue = {
      expected: 'ios',
      actual: 'android',
      deviceId: 'emulator-5554',
      source: 'delegated-status',
      port: 8083,
    };
    const diagnose = vi.fn(async () => ({
      cause: 'dev-menu-open' as const,
      symptom: 'observed',
      detail: 'explained',
      confidence: 'confirmed' as const,
    }));
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
      projectRoot,
      diagnose: diagnose as never,
    });

    const passed = diagnose.mock.calls[0]![0] as unknown as {
      a11ySnapshot?: string;
      bridgePlatformMismatch?: { actual?: string } | null;
    };
    expect(passed.a11ySnapshot).toContain('Sign in');
    expect(passed.bridgePlatformMismatch).toMatchObject({ actual: 'android' });
  });

  it('passes a NULL mismatch when the bridge sees none — never a fabricated one', async () => {
    const projectRoot = newProject();
    const driver = new FakeDriver();
    driver.waitResults = [okResult({ code: 1, stderr: 'no matching ref' })];
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const diagnose = vi.fn(async () => ({
      cause: 'unknown' as const,
      symptom: '',
      detail: '',
      confidence: 'suspected' as const,
    }));
    await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
      projectRoot,
      diagnose: diagnose as never,
    });
    const passed = diagnose.mock.calls[0]![0] as unknown as { bridgePlatformMismatch?: unknown };
    expect(passed.bridgePlatformMismatch).toBeNull();
  });

  it('leaves a CONFIRMED render undiagnosed — there is nothing to explain', async () => {
    const projectRoot = newProject();
    const driver = new FakeDriver();
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const diagnose = vi.fn();
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
      projectRoot,
      diagnose: diagnose as never,
    });
    expect(result.render.status).toBe('confirmed');
    expect(result.diagnosis).toBeUndefined();
    expect(diagnose).not.toHaveBeenCalled();
  });

  it('survives a diagnosis that throws — instrumentation can never fail a capture', async () => {
    const projectRoot = newProject();
    const driver = new FakeDriver();
    driver.waitResults = [okResult({ code: 1, stderr: 'no matching ref' })];
    const bridge = new FakeBridge({ connected: true, rendered: { ok: true } });
    const result = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      bridge,
      delay: async () => {},
      projectRoot,
      diagnose: (() => Promise.reject(new Error('probe exploded'))) as never,
    });
    expect(result.render.status).toBe('unconfirmed');
    expect(result.diagnosis).toBeUndefined();
  });
});

describe('nativePerfUnavailableReason', () => {
  // The message a user reads when a performance metric has no number. It has to
  // name the ACTUAL problem: "rebuild the companion" was previously printed for
  // every cause, including the common one (a render confirmed off the ack path)
  // where rebuilding fixes nothing.

  it('says nothing when the render carries timing', () => {
    expect(
      nativePerfUnavailableReason({ via: 'marker', perf: { mountMs: 12 } }, ['deep-link-ack']),
    ).toBeUndefined();
  });

  it('bridge-ack with no perf = a genuinely old binary → rebuild', () => {
    const reason = nativePerfUnavailableReason({ via: 'bridge-ack' }, []);
    expect(reason).toContain('rebuild the companion');
    expect(reason).toContain('predates the perf channel');
  });

  it('marker path on an old binary names the path AND the rebuild', () => {
    const reason = nativePerfUnavailableReason({ via: 'marker' }, ['reload']);
    expect(reason).toContain('tokenized render marker');
    expect(reason).toContain('deep-link fallback');
    expect(reason).toContain('does not ack deep links');
  });

  it('marker path on a CURRENT binary blames the missing ack, not the binary', () => {
    // Rebuilding is the wrong advice here — the companion is fine, its ack just
    // did not arrive inside the adopt budget.
    const reason = nativePerfUnavailableReason({ via: 'marker' }, ['deep-link-ack']);
    expect(reason).toContain('no ack arrived for this token');
    expect(reason).not.toContain('rebuild');
  });

  it('settle path says nothing confirmed this render', () => {
    expect(nativePerfUnavailableReason({ via: 'settle' })).toContain(
      'nothing confirmed this render',
    );
  });
});
/* ------------------------------------------------------------------ *
 * `.ad` recording: the guard + publish the capture performs.          *
 * ------------------------------------------------------------------ */

describe('captureNative — `.ad` replay recording', () => {
  /**
   * A driver that HAS the recording verbs. Everything else is FakeDriver, so
   * these tests only exercise the capture's decision about WHEN to record.
   */
  class RecordingDriver extends FakeDriver {
    guardCalls: Array<{ marker: string; timeoutMs: number }> = [];
    publishCalls = 0;
    guardResult = true;
    publishResult: { published: boolean; path?: string; reason?: string } = {
      published: true,
      path: '/runs/r1/replay.ad',
    };
    state: { path: string; published: boolean } | undefined = {
      path: '/runs/r1/replay.ad',
      published: false,
    };
    recordingState(): { path: string; published: boolean } | undefined {
      return this.state;
    }
    async recordDestinationGuard(marker: string, timeoutMs: number): Promise<boolean> {
      this.guardCalls.push({ marker, timeoutMs });
      return this.guardResult;
    }
    async publishRecording(): Promise<{
      published: boolean;
      path?: string;
      reason?: string;
    }> {
      this.publishCalls += 1;
      return this.publishResult;
    }
  }

  const shot = (): string => join(mkdtempSync(join(tmpdir(), 'validity-rec-')), 'a.png');

  it('records a guard on the SAME marker the render was confirmed by, then publishes', async () => {
    const driver = new RecordingDriver();
    const res = await captureNative({
      driver,
      spec: { component: 'src/A.tsx' },
      screenshotPath: shot(),
    });
    expect(res.render.status).toBe('confirmed');
    expect(driver.guardCalls).toHaveLength(1);
    // The guard must target the per-navigation marker: a guard on the SHARED
    // `validity-root` would resolve against a previously-rendered component.
    expect(driver.guardCalls[0]!.marker).toMatch(/^validity-root:nav-/);
    expect(driver.publishCalls).toBe(1);
    expect(res.recordingPath).toBe('/runs/r1/replay.ad');
  });

  it('does not publish when the guard never resolved', async () => {
    // A guard that does not resolve cannot be a destination guard, and a
    // published script without one is refused upstream anyway.
    const driver = new RecordingDriver();
    driver.guardResult = false;
    const res = await captureNative({
      driver,
      spec: { component: 'src/A.tsx' },
      screenshotPath: shot(),
    });
    expect(driver.publishCalls).toBe(0);
    expect(res.recordingPath).toBeUndefined();
  });

  it('reports no path when upstream refuses the publication', async () => {
    const driver = new RecordingDriver();
    driver.publishResult = {
      published: false,
      reason: 'no portable destination guard',
    };
    const res = await captureNative({
      driver,
      spec: { component: 'src/A.tsx' },
      screenshotPath: shot(),
    });
    expect(res.recordingPath).toBeUndefined();
  });

  it('records nothing when the session already published — one `.ad` per session', async () => {
    const driver = new RecordingDriver();
    driver.state = { path: '/runs/r1/replay.ad', published: true };
    const res = await captureNative({
      driver,
      spec: { component: 'src/A.tsx' },
      screenshotPath: shot(),
    });
    expect(driver.guardCalls).toHaveLength(0);
    expect(driver.publishCalls).toBe(0);
    expect(res.recordingPath).toBeUndefined();
  });

  it('records nothing when no recording was armed', async () => {
    const driver = new RecordingDriver();
    driver.state = undefined;
    await captureNative({
      driver,
      spec: { component: 'src/A.tsx' },
      screenshotPath: shot(),
    });
    expect(driver.guardCalls).toHaveLength(0);
    expect(driver.publishCalls).toBe(0);
  });

  it('records nothing when the render did not confirm', async () => {
    // An unconfirmed render is the launcher/splash/compiling screen. Recording
    // a journey to THAT and calling it a destination would be the false green
    // the whole capture path exists to prevent.
    const driver = new RecordingDriver();
    driver.waitResult = okResult({ code: 1 }); // the marker never paints
    const res = await captureNative({
      driver,
      spec: { component: 'src/A.tsx' },
      screenshotPath: shot(),
      // Stub the sleeps: the unconfirmed ladder otherwise spends its real
      // bundle/settle budget, which has nothing to do with what this asserts.
      delay: async () => {},
    });
    expect(res.render.status).not.toBe('confirmed');
    expect(driver.guardCalls).toHaveLength(0);
    expect(driver.publishCalls).toBe(0);
  });

  it('never fails the capture when the recording throws', async () => {
    const driver = new RecordingDriver();
    driver.recordDestinationGuard = async (): Promise<boolean> => {
      throw new Error('daemon fell over');
    };
    const res = await captureNative({
      driver,
      spec: { component: 'src/A.tsx' },
      screenshotPath: shot(),
    });
    expect(res.render.status).toBe('confirmed');
    expect(res.recordingPath).toBeUndefined();
  });

  it('is inert for a driver that has no recording verbs at all', async () => {
    const driver = new FakeDriver();
    const res = await captureNative({
      driver,
      spec: { component: 'src/A.tsx' },
      screenshotPath: shot(),
    });
    expect(res.render.status).toBe('confirmed');
    expect(res.recordingPath).toBeUndefined();
  });
});

/**
 * The device-evidence seam (perf frames/memory + HTTP traffic). Capture-only,
 * OFF by default, and never able to change a verdict — see
 * `NativeDeviceEvidence`.
 */
describe('captureNative — device-side evidence seam', () => {
  const criterion = [
    {
      id: 'AC-1',
      text: 'renders',
      tier: 'hard',
      checks: [{ expect: { element: { role: 'button', name: 'Go' } } }],
    } as never,
  ];

  it('captures NOTHING by default — a sweep must not pay two extra spawns per spec', async () => {
    const driver = new FakeDriver().enableRunInSession();
    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      delay: async () => {},
      criteriaChecks: criterion,
    });
    expect(cap.deviceEvidence).toBeUndefined();
    expect(driver.calls.some((c) => c.startsWith('session:'))).toBe(false);
  });

  it('collects perf + network records through the SESSION passthrough when asked', async () => {
    const driver = new FakeDriver().enableRunInSession();
    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      delay: async () => {},
      criteriaChecks: criterion,
      captureDeviceEvidence: true,
    });
    // All three records exist and are provenance-labelled DeviceEvidence —
    // whatever their status, absence is never how a capture attempt reads.
    expect(cap.deviceEvidence?.unavailableReason).toBeUndefined();
    expect(cap.deviceEvidence?.perf?.metrics.kind).toBe('perf-metrics');
    expect(cap.deviceEvidence?.perf?.frames.kind).toBe('perf-frames');
    expect(cap.deviceEvidence?.network?.kind).toBe('network-dump');
    // The commands ran through runInSession (same session as the capture),
    // and the network dump never asks for headers (bearer tokens live there).
    const session = driver.calls.filter((c) => c.startsWith('session:'));
    expect(session.some((c) => c.includes('perf metrics'))).toBe(true);
    expect(session.some((c) => c.includes('perf frames'))).toBe(true);
    expect(session.some((c) => c.includes('network dump'))).toBe(true);
    expect(session.some((c) => c.includes('--include'))).toBe(false);
    // …and the criteria verdicts are untouched by it.
    expect(cap.criterionVerdicts).toHaveLength(1);
  });

  it('is a no-op for a driver with no session passthrough', async () => {
    const driver = new FakeDriver();
    const cap = await captureNative({
      driver,
      spec: { component: 'src/Button.tsx' },
      screenshotPath: '/tmp/shot.png',
      delay: async () => {},
      criteriaChecks: criterion,
      captureDeviceEvidence: true,
    });
    expect(cap.deviceEvidence).toBeUndefined();
  });
});
