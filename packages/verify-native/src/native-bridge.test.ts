import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import WebSocket, { type ClientOptions } from 'ws';
import { startNativeBridge, type NativeBridgeHandle } from './native-bridge.js';

// Distinct port per test so a leftover socket from one can't bleed into another.
let portSeq = 8190;
const nextPort = (): number => ++portSeq;

const open = (url: string, opts?: ClientOptions): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

const nextMessage = (ws: WebSocket): Promise<any> =>
  new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));

const closed = (ws: WebSocket): Promise<void> =>
  new Promise((resolve) => ws.once('close', () => resolve()));

/** Async variant of `until` — awaits the predicate each tick. */
const untilAsync = async (cond: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Poll until `cond` is true or ~2s elapsed (message handling is async). */
const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

describe('startNativeBridge', () => {
  let bridge: NativeBridgeHandle | null = null;
  afterEach(() => {
    bridge?.close();
    bridge = null;
  });

  it('blocks hostile HTTP and WS clients without disclosing replay or displacing the device', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const origin = `http://127.0.0.1:${port}`;
    // React Native Android getDefaultOrigin(wsUrl) supplies this HTTP origin.
    const client = await open(`ws://127.0.0.1:${port}`, { origin });
    await bridge.waitForConnection(2000);
    try {
      const driven = nextMessage(client);
      bridge.send({ type: 'home', token: 'private-replay-token' });
      expect(await driven).toEqual({ type: 'home', token: 'private-replay-token' });
      for (const options of [
        { origin: 'https://evil.example' },
        { origin: 'null' },
        { headers: { host: `evil.example:${port}` } },
        { headers: { host: '127.0.0.1:1' } },
      ]) {
        await expect(open(`ws://127.0.0.1:${port}`, options)).rejects.toThrow(/403/);
        expect(client.readyState).toBe(WebSocket.OPEN);
      }
      expect(await bridge.waitForRendered('private-replay-token', 20)).toBeNull();
      const ack = bridge.waitForRendered('private-replay-token', 1000);
      client.send(JSON.stringify({ type: 'rendered', token: 'private-replay-token', ok: true }));
      expect(await ack).toMatchObject({ ok: true });
      for (const badOrigin of ['null', 'https://evil.example']) {
        expect((await fetch(`${origin}/data`, { headers: { origin: badOrigin } })).status).toBe(
          403,
        );
        expect(
          (
            await fetch(`${origin}/navigate`, {
              method: 'POST',
              headers: { origin: badOrigin, 'content-type': 'application/json' },
              body: JSON.stringify({ type: 'home', token: 'hostile' }),
            })
          ).status,
        ).toBe(403);
      }
      expect((await fetch(`${origin}/navigate`, { method: 'POST', body: '{}' })).status).toBe(415);
      expect((await fetch(`${origin}/status`, { headers: { origin } })).status).toBe(200);
      const message = nextMessage(client);
      const response = fetch(`${origin}/navigate?timeoutMs=1000`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'home', token: 'authorized' }),
      });
      expect(await message).toEqual({ type: 'home', token: 'authorized' });
      client.send(JSON.stringify({ type: 'rendered', token: 'authorized', ok: true }));
      expect((await response).status).toBe(200);
    } finally {
      client.close();
    }
  });

  it('reports connection, relays navigate, and resolves the matching render ack', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    expect(bridge.isConnected()).toBe(false);

    const connectedSoon = bridge.waitForConnection(2000);
    const client = await open(`ws://127.0.0.1:${port}`);
    client.send(JSON.stringify({ type: 'hello' }));

    expect(await connectedSoon).toBe(true);
    expect(bridge.isConnected()).toBe(true);

    // Host pushes a navigate; the device receives it verbatim.
    const recv = nextMessage(client);
    expect(bridge.send({ type: 'navigate', token: 't1', component: 'src/Button.tsx' })).toBe(true);
    expect(await recv).toMatchObject({
      type: 'navigate',
      token: 't1',
      component: 'src/Button.tsx',
    });

    // Device acks that token → waitForRendered resolves with its result.
    const ackedSoon = bridge.waitForRendered('t1', 2000);
    client.send(JSON.stringify({ type: 'rendered', token: 't1', ok: true }));
    expect(await ackedSoon).toEqual({ ok: true });

    client.close();
  });

  it('threads the rendered ack unmatched URLs into the render result (native verify diagnostic)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    client.send(JSON.stringify({ type: 'hello' }));
    await bridge.waitForConnection(2000);

    // The device reports the un-mocked URLs its permissive catch-all answered;
    // they must reach the host's NativeRenderedResult so a native verify can
    // surface them like web's unmatched-fetch block.
    const acked = bridge.waitForRendered('t1', 2000);
    client.send(
      JSON.stringify({
        type: 'rendered',
        token: 't1',
        ok: true,
        unmatched: ['GET https://api.example.com/users', 'GET /api/feed', 42],
      }),
    );
    // Non-string entries are dropped by the coercer; an all-empty list is absent.
    expect(await acked).toEqual({
      ok: true,
      error: undefined,
      unmatched: ['GET https://api.example.com/users', 'GET /api/feed'],
    });

    client.close();
  });

  it('omits unmatched when the device reports none (old binary / no un-mocked fetches)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    const acked = bridge.waitForRendered('t1', 2000);
    client.send(JSON.stringify({ type: 'rendered', token: 't1', ok: true }));
    expect(await acked).toEqual({ ok: true, error: undefined, unmatched: undefined });

    client.close();
  });

  it('threads matched responses + consoleErrorCount into the render result (network/console channels)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    const acked = bridge.waitForRendered('t1', 2000);
    client.send(
      JSON.stringify({
        type: 'rendered',
        token: 't1',
        ok: true,
        consoleErrorCount: 2,
        matched: [
          { method: 'GET', url: 'https://api.example.com/users', status: 200 },
          // Garbage entries are dropped; a non-finite status normalizes to 0.
          { method: 'POST', url: '/api/login', status: 'oops' },
          { method: 42, url: '/bad' },
          'not-an-object',
        ],
      }),
    );
    expect(await acked).toEqual({
      ok: true,
      error: undefined,
      unmatched: undefined,
      matched: [
        { method: 'GET', url: 'https://api.example.com/users', status: 200 },
        { method: 'POST', url: '/api/login', status: 0 },
      ],
      consoleErrorCount: 2,
    });

    client.close();
  });

  it('carries valid matched provenance/handlerUrl and DROPS garbage provenance values (A4)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    const acked = bridge.waitForRendered('t1', 2000);
    client.send(
      JSON.stringify({
        type: 'rendered',
        token: 't1',
        ok: true,
        matched: [
          {
            method: 'GET',
            url: '/api/feed',
            status: 200,
            provenance: 'declared',
            handlerUrl: '/api/feed',
          },
          { method: 'GET', url: '/api/other', status: 200, provenance: 'fabricated' },
          // Non-whitelisted provenance (hostile/garbage ack) must be dropped —
          // unknown can never be promoted to declared evidence downstream.
          { method: 'GET', url: '/api/x', status: 200, provenance: 'root', handlerUrl: 7 },
        ],
      }),
    );
    expect((await acked)?.matched).toEqual([
      {
        method: 'GET',
        url: '/api/feed',
        status: 200,
        provenance: 'declared',
        handlerUrl: '/api/feed',
      },
      { method: 'GET', url: '/api/other', status: 200, provenance: 'fabricated' },
      { method: 'GET', url: '/api/x', status: 200 },
    ]);

    client.close();
  });

  it('preserves a zero consoleErrorCount (channel available, no errors) — distinct from absent', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    // A new companion that saw zero errors reports 0 — it must NOT collapse to
    // undefined, so an error-budget expect.console can pass rather than read as
    // "channel unavailable".
    const acked = bridge.waitForRendered('t1', 2000);
    client.send(JSON.stringify({ type: 'rendered', token: 't1', ok: true, consoleErrorCount: 0 }));
    expect(await acked).toMatchObject({ ok: true, consoleErrorCount: 0 });

    client.close();
  });

  it('caps the matched list defensively on read and drops absent/garbage channels', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    // Old companion (no matched / consoleErrorCount fields) → both absent.
    const ackedOld = bridge.waitForRendered('old', 2000);
    client.send(JSON.stringify({ type: 'rendered', token: 'old', ok: true }));
    expect(await ackedOld).toEqual({
      ok: true,
      error: undefined,
      unmatched: undefined,
      matched: undefined,
      consoleErrorCount: undefined,
    });

    // A hostile/oversized matched array is capped to the first 200 entries.
    const big = Array.from({ length: 500 }, (_v, i) => ({
      method: 'GET',
      url: `/api/item/${i}`,
      status: 200,
    }));
    const ackedBig = bridge.waitForRendered('big', 2000);
    client.send(JSON.stringify({ type: 'rendered', token: 'big', ok: true, matched: big }));
    const big1 = await ackedBig;
    expect(big1?.matched).toHaveLength(200);
    expect(big1?.matched?.[0]).toEqual({ method: 'GET', url: '/api/item/0', status: 200 });

    // A negative / non-number consoleErrorCount degrades to absent.
    const ackedNeg = bridge.waitForRendered('neg', 2000);
    client.send(
      JSON.stringify({ type: 'rendered', token: 'neg', ok: true, consoleErrorCount: -3 }),
    );
    expect((await ackedNeg)?.consoleErrorCount).toBeUndefined();

    client.close();
  });

  it('threads a valid perf object into the render result (expect.performance channel)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    // A new companion always sends a perf OBJECT; updateMs present here.
    const acked = bridge.waitForRendered('t1', 2000);
    client.send(
      JSON.stringify({
        type: 'rendered',
        token: 't1',
        ok: true,
        perf: { readyMs: 120, mountMs: 8, updateMs: 3, commitCount: 2 },
      }),
    );
    expect((await acked)?.perf).toEqual({
      readyMs: 120,
      mountMs: 8,
      updateMs: 3,
      commitCount: 2,
    });

    client.close();
  });

  it('preserves a zero perf sub-field and omits an absent updateMs (per-field presence)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    // No update commit fired → companion omits updateMs (JSON.stringify drops
    // undefined). A 0ms mount is a REAL measurement and must NOT collapse to
    // absent — it stays so an expect.performance `mount` check can pass.
    const acked = bridge.waitForRendered('t1', 2000);
    client.send(
      JSON.stringify({
        type: 'rendered',
        token: 't1',
        ok: true,
        perf: { readyMs: 0, mountMs: 0, commitCount: 1 },
      }),
    );
    const perf = (await acked)?.perf;
    expect(perf).toEqual({ readyMs: 0, mountMs: 0, commitCount: 1 });
    expect(perf && 'updateMs' in perf).toBe(false); // unmeasured metric is omitted, not 0

    client.close();
  });

  it('degrades a malformed perf safely: non-object → undefined, non-numeric sub-fields dropped', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    // A non-object perf (hostile/garbage) → the whole channel reads absent.
    const ackedBad = bridge.waitForRendered('bad', 2000);
    client.send(JSON.stringify({ type: 'rendered', token: 'bad', ok: true, perf: 'fast' }));
    expect((await ackedBad)?.perf).toBeUndefined();

    // An object with non-numeric / non-finite sub-fields: bad fields are dropped,
    // the good one survives (channel present, partial measurement).
    const ackedPartial = bridge.waitForRendered('partial', 2000);
    client.send(
      JSON.stringify({
        type: 'rendered',
        token: 'partial',
        ok: true,
        perf: { readyMs: 'oops', mountMs: 9, updateMs: null, commitCount: 'x' },
      }),
    );
    expect((await ackedPartial)?.perf).toEqual({ mountMs: 9 });

    client.close();
  });

  it('omits perf entirely when the device reports none (old binary)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    // Old companion: no perf field at all → host reads undefined → the executor
    // reports expect.performance unverifiable, never a fail.
    const acked = bridge.waitForRendered('t1', 2000);
    client.send(JSON.stringify({ type: 'rendered', token: 't1', ok: true }));
    expect((await acked)?.perf).toBeUndefined();

    client.close();
  });

  it('waitForRendered resolves null on timeout (no ack for the token)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    // An ack for a DIFFERENT token must not satisfy the wait.
    client.send(JSON.stringify({ type: 'rendered', token: 'other', ok: true }));
    expect(await bridge.waitForRendered('t1', 150)).toBeNull();

    client.close();
  });

  it('send returns false when no device is connected', () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    expect(bridge.send({ type: 'home', token: 't0' })).toBe(false);
  });

  it('replays the last navigate onto a reconnecting device (reload self-heals to the component)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });

    // First session: host drives the device to a component.
    const first = await open(`ws://127.0.0.1:${port}`);
    first.send(JSON.stringify({ type: 'hello' }));
    await bridge.waitForConnection(2000);
    const firstRecv = nextMessage(first);
    bridge.send({ type: 'navigate', token: 't1', component: 'src/Button.tsx' });
    expect(await firstRecv).toMatchObject({ type: 'navigate', component: 'src/Button.tsx' });

    // The device reloads (Metro full-reload) → its socket drops and a brand-new
    // one connects. The bridge must re-push the active target with no further
    // host action, so the companion lands back on the component, not home.
    const closedSoon = new Promise<void>((resolve) => first.once('close', () => resolve()));
    // Attach the message listener at construction — the replay is pushed the
    // instant the connection lands, so awaiting `open` first would race past it.
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    const replay = nextMessage(second);
    expect(await replay).toMatchObject({ type: 'navigate', component: 'src/Button.tsx' });
    await closedSoon;

    second.close();
  });

  it('does not replay anything onto the first connection of a session', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });

    const client = await open(`ws://127.0.0.1:${port}`);
    // Nothing has been pushed yet, so the only inbound message should be the
    // host's explicit navigate — never a phantom replay before it.
    const firstInbound = nextMessage(client);
    bridge.send({ type: 'navigate', token: 't1', component: 'src/Card.tsx' });
    expect(await firstInbound).toMatchObject({ type: 'navigate', component: 'src/Card.tsx' });

    client.close();
  });

  it('a new connection supersedes the previous one', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const first = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    const closedSoon = new Promise<void>((resolve) => first.once('close', () => resolve()));
    const second = await open(`ws://127.0.0.1:${port}`);
    second.send(JSON.stringify({ type: 'hello' }));
    await closedSoon; // the old socket is closed when the new one arrives

    // The new socket receives sends.
    const recv = nextMessage(second);
    bridge.send({ type: 'home', token: 't2' });
    expect(await recv).toMatchObject({ type: 'home', token: 't2' });

    second.close();
  });

  // ---- heartbeat: half-open sockets must not stay "connected" --------------

  it('heartbeat terminates a socket that stops answering pongs (half-open ≠ warm)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port, heartbeatIntervalMs: 25, maxMissedPongs: 2 });
    // autoPong: false = a live TCP connection whose peer never answers pings —
    // exactly the half-open/suspended-app shape readyState can't see.
    const client = await open(`ws://127.0.0.1:${port}`, { autoPong: false });
    await bridge.waitForConnection(2000);
    expect(bridge.isConnected()).toBe(true);

    await closed(client); // reaped by the heartbeat, no client-side close()
    await until(() => !bridge!.isConnected());
    expect(bridge.isConnected()).toBe(false);
  });

  it('heartbeat keeps a pong-answering socket connected across many intervals', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port, heartbeatIntervalMs: 20, maxMissedPongs: 2 });
    const client = await open(`ws://127.0.0.1:${port}`); // ws auto-pongs by default
    await bridge.waitForConnection(2000);

    // > maxMissedPongs * interval: would have been terminated if pongs didn't count.
    await new Promise((r) => setTimeout(r, 200));
    expect(bridge.isConnected()).toBe(true);
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  // ---- hello: contentHash + device identity ---------------------------------

  it('captures contentHash + device identity from the hello, cleared on disconnect', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    client.send(
      JSON.stringify({
        type: 'hello',
        contentHash: 'abcd1234abcd1234',
        device: { id: 'ios-vendor:XYZ', platform: 'ios' },
      }),
    );
    await until(() => bridge!.deviceInfo() !== null);
    expect(bridge.deviceInfo()).toEqual({
      contentHash: 'abcd1234abcd1234',
      deviceId: 'ios-vendor:XYZ',
      platform: 'ios',
    });

    client.close();
    await until(() => bridge!.deviceInfo() === null);
    expect(bridge.deviceInfo()).toBeNull(); // identity belongs to the dropped session
  });

  it('a bare hello (old companion binary) degrades to empty info, never an error', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    client.send(JSON.stringify({ type: 'hello' }));
    await until(() => bridge!.deviceInfo() !== null);
    expect(bridge.deviceInfo()?.contentHash).toBeUndefined();
    expect(bridge.deviceInfo()?.deviceId).toBeUndefined();
    expect(bridge.deviceInfo()?.capabilities).toBeUndefined(); // no caps → no reload pushes
    client.close();
  });

  it("hello caps land in deviceInfo().capabilities (the 'reload' capability gate)", async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    client.send(JSON.stringify({ type: 'hello', caps: ['reload', 42, 'future-cap'] }));
    await until(() => bridge!.deviceInfo() !== null);
    // Non-string entries are dropped, never an error.
    expect(bridge.deviceInfo()?.capabilities).toEqual(['reload', 'future-cap']);
    client.close();
  });

  it('hello mock-network state lands in deviceInfo().mock (so verify can warn on real-network scoring)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });

    // Disabled with a reason — the loud case the verify response must surface.
    const off = await open(`ws://127.0.0.1:${port}`);
    off.send(JSON.stringify({ type: 'hello', mock: { active: false, reason: 'msw boom' } }));
    await until(() => bridge!.deviceInfo()?.mock !== undefined);
    expect(bridge.deviceInfo()?.mock).toEqual({ active: false, reason: 'msw boom' });
    off.close();
    await until(() => bridge!.deviceInfo() === null);

    // Active — no reason.
    const on = await open(`ws://127.0.0.1:${port}`);
    on.send(JSON.stringify({ type: 'hello', mock: { active: true } }));
    await until(() => bridge!.deviceInfo()?.mock !== undefined);
    expect(bridge.deviceInfo()?.mock).toEqual({ active: true, reason: undefined });
    on.close();
    await until(() => bridge!.deviceInfo() === null);

    // Malformed mock payload (no boolean `active`) → undefined, never an error.
    const bad = await open(`ws://127.0.0.1:${port}`);
    bad.send(JSON.stringify({ type: 'hello', mock: { reason: 'no active flag' } }));
    await until(() => bridge!.deviceInfo() !== null);
    expect(bridge.deviceInfo()?.mock).toBeUndefined();
    bad.close();
  });

  // ---- in-place reload: epoch + reconnect ------------------------------------

  it('relays a reload push; waitForReconnect resolves only on a NEW connection', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const first = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    // The pre-reload socket is still open — it must NOT satisfy the wait
    // (isConnected() can't tell a reloaded session from the old one; the
    // epoch can).
    const sinceEpoch = bridge.connectionEpoch();
    expect(await bridge.waitForReconnect(sinceEpoch, 100)).toBe(false);

    const recv = nextMessage(first);
    expect(bridge.send({ type: 'reload' })).toBe(true);
    expect(await recv).toEqual({ type: 'reload' });

    // The device reloads: its socket drops and a brand-new session dials back.
    const reconnectedSoon = bridge.waitForReconnect(sinceEpoch, 2000);
    first.close();
    const second = await open(`ws://127.0.0.1:${port}`);
    expect(await reconnectedSoon).toBe(true);
    expect(bridge.connectionEpoch()).toBeGreaterThan(sinceEpoch);
    second.close();
  });

  it('a reload is never recorded as the reconnect replay (no infinite reload loop)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const first = await open(`ws://127.0.0.1:${port}`);
    await bridge.waitForConnection(2000);

    // Drive to a component, then push a reload (both delivered).
    bridge.send({ type: 'navigate', token: 't1', component: 'src/Button.tsx' });
    bridge.send({ type: 'reload' });

    // Reconnect: the replay must be the NAVIGATE — replaying the reload would
    // bounce the device into an infinite reload loop.
    const closedSoon = closed(first);
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    const replay = nextMessage(second);
    expect(await replay).toMatchObject({
      type: 'navigate',
      token: 't1',
      component: 'src/Button.tsx',
      replay: true,
    });
    await closedSoon;
    second.close();
  });

  // ---- replay semantics: record-after-write + replay tag --------------------

  it('a failed write is never recorded for replay; replays are tagged replay:true', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });

    // No device connected: the write fails and must NOT become a replay.
    expect(bridge.send({ type: 'navigate', token: 't0', component: 'src/Stale.tsx' })).toBe(false);

    // First connection: nothing should be replayed (t0 was never delivered).
    const first = await open(`ws://127.0.0.1:${port}`);
    const firstInbound = nextMessage(first);
    bridge.send({ type: 'navigate', token: 't1', component: 'src/Button.tsx' });
    expect(await firstInbound).toMatchObject({ token: 't1', component: 'src/Button.tsx' });

    // Reconnect: the DELIVERED navigate is replayed verbatim (same token) but
    // tagged replay:true so the device can ignore it mid-session.
    const closedSoon = closed(first);
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    const replay = nextMessage(second);
    expect(await replay).toEqual(
      expect.objectContaining({
        type: 'navigate',
        token: 't1',
        component: 'src/Button.tsx',
        replay: true,
      }),
    );
    await closedSoon;
    second.close();
  });

  // ---- port contention: delegation + port-held ------------------------------

  it('delegates navigate through the live bridge that owns the port (CLI vs MCP contention)', async () => {
    const port = nextPort();
    const owner = startNativeBridge({ port });
    try {
      // Device connects to the OWNING bridge and acks every navigate.
      const device = await open(`ws://127.0.0.1:${port}`);
      device.send(
        JSON.stringify({ type: 'hello', contentHash: 'hash-A', device: { platform: 'ios' } }),
      );
      device.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'navigate' && !m.replay) {
          device.send(JSON.stringify({ type: 'rendered', token: m.token, ok: true }));
        }
      });
      await owner.waitForConnection(2000);

      // Second host (the CLI while an MCP holds 8083): bind loses → delegated.
      bridge = startNativeBridge({ port });
      expect(await bridge.whenReady()).toBe('delegated');
      expect(await bridge.waitForConnection(2000)).toBe(true);
      expect(bridge.isConnected()).toBe(true);
      // The owning bridge's /status primes the device info (stale check works).
      expect(bridge.deviceInfo()).toMatchObject({ contentHash: 'hash-A' });

      // The navigate hops over HTTP and returns the device's real ack.
      const out = await bridge.navigate(
        { type: 'navigate', token: 'd1', component: 'src/Card.tsx' },
        2000,
      );
      expect(out).toEqual({ kind: 'ack', result: { ok: true } });

      device.close();
    } finally {
      owner.close();
    }
  });

  // ---- GET /data: the device's boot-fetch of the DATA payload --------------

  it('serves the data payload set via setNativeData from GET /data (boot fetch)', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    await bridge.whenReady();

    // Before any setNativeData: the endpoint answers with the bridge signature
    // and null data, so the device keeps its baked fallback.
    const before = await (await fetch(`http://127.0.0.1:${port}/data`)).json();
    expect(before).toEqual({ validityNativeBridge: true, data: null });

    const payload = {
      views: { V: [{ path: 'src/Button.tsx', label: 'primary', props: { label: 'Hi' } }] },
      scenarios: { 'logged-in': { context: { isAuthenticated: true } } },
      mockNetwork: { handlers: [{ url: '/api/me', json: { id: '1' } }], fallback: 'permissive' },
      asyncStorage: [['authToken', 'mock']] as Array<[string, string]>,
    };
    bridge.setNativeData(payload);

    // The freshest copy is now served — the host pushed it without a rebuild.
    const after = await (await fetch(`http://127.0.0.1:${port}/data`)).json();
    expect(after).toEqual({ validityNativeBridge: true, data: payload });

    // Clearing it degrades the device back to its baked fallback.
    bridge.setNativeData(null);
    const cleared = await (await fetch(`http://127.0.0.1:${port}/data`)).json();
    expect(cleared.data).toBeNull();
  });

  // ---- platform binding (2026-07-29: the stale cross-platform holder) ------
  //
  // A validity-mcp left running from a PREVIOUS DAY held 8083 with an Android
  // device attached. An iOS run delegated through it, the Android companion
  // acked every navigate, and the iOS simulator never attached a thing. Every
  // criterion came back unverifiable with every probe reading clean.

  it('REFUSES to delegate to a bridge holding the other platform’s device', async () => {
    const port = nextPort();
    const owner = startNativeBridge({ port });
    try {
      const android = await open(`ws://127.0.0.1:${port}`);
      android.send(
        JSON.stringify({
          type: 'hello',
          device: { platform: 'android', id: 'emulator-5554' },
        }),
      );
      android.on('message', (d) => {
        const m = JSON.parse(d.toString());
        // The wrong device would happily ack — that is the whole problem.
        if (m.type === 'navigate' && !m.replay) {
          android.send(JSON.stringify({ type: 'rendered', token: m.token, ok: true }));
        }
      });
      await owner.waitForConnection(2000);

      // This run drives iOS.
      bridge = startNativeBridge({ port, platform: 'ios' });
      expect(await bridge.whenReady()).toBe('port-held');

      const out = await bridge.navigate({ type: 'navigate', token: 'x1' }, 2000);
      expect(out.kind).toBe('port-held');
      if (out.kind === 'port-held') {
        // Loud, and specific about WHY — not the generic "not a Validity bridge".
        expect(out.detail).toContain('android');
        expect(out.detail).toContain('ios');
        expect(out.detail).toContain('emulator-5554');
        expect(out.detail).toContain(String(port));
      }

      android.close();
    } finally {
      owner.close();
    }
  });

  it('still delegates happily to a bridge on the SAME platform', async () => {
    const port = nextPort();
    const owner = startNativeBridge({ port });
    try {
      const device = await open(`ws://127.0.0.1:${port}`);
      device.send(JSON.stringify({ type: 'hello', device: { platform: 'ios' } }));
      device.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'navigate' && !m.replay) {
          device.send(JSON.stringify({ type: 'rendered', token: m.token, ok: true }));
        }
      });
      await owner.waitForConnection(2000);

      bridge = startNativeBridge({ port, platform: 'ios' });
      expect(await bridge.whenReady()).toBe('delegated');
      expect(bridge.platformMismatch()).toBeNull();
      const out = await bridge.navigate({ type: 'navigate', token: 'y1' }, 2000);
      expect(out).toEqual({ kind: 'ack', result: { ok: true } });

      device.close();
    } finally {
      owner.close();
    }
  });

  it('surfaces a LOCAL wrong-platform companion via platformMismatch()', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port, platform: 'ios' });
    expect(bridge.platformMismatch()).toBeNull(); // no device yet → cannot tell

    const client = await open(`ws://127.0.0.1:${port}`);
    client.send(
      JSON.stringify({ type: 'hello', device: { platform: 'android', id: 'emulator-5554' } }),
    );
    await bridge.waitForConnection(2000);
    await until(() => bridge!.platformMismatch() !== null);

    expect(bridge.platformMismatch()).toEqual({
      expected: 'ios',
      actual: 'android',
      deviceId: 'emulator-5554',
      source: 'hello',
      port,
    });
    client.close();
  });

  it('never guesses: no expected platform, or an old companion that announces none', async () => {
    const port = nextPort();
    // No `platform` option → no binding, exactly today's behavior.
    bridge = startNativeBridge({ port });
    const a = await open(`ws://127.0.0.1:${port}`);
    a.send(JSON.stringify({ type: 'hello', device: { platform: 'android' } }));
    await bridge.waitForConnection(2000);
    expect(bridge.platformMismatch()).toBeNull();
    a.close();
    bridge.close();

    // Bound, but the companion is an old binary sending a bare hello.
    const port2 = nextPort();
    bridge = startNativeBridge({ port: port2, platform: 'ios' });
    const b = await open(`ws://127.0.0.1:${port2}`);
    b.send(JSON.stringify({ type: 'hello' }));
    await bridge.waitForConnection(2000);
    expect(bridge.platformMismatch()).toBeNull();
    b.close();
  });

  it('port held by a non-Validity process → port-held mode + machine-readable navigate outcome', async () => {
    const port = nextPort();
    const squatter: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not a bridge');
    });
    await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', () => r()));
    try {
      bridge = startNativeBridge({ port });
      expect(await bridge.whenReady()).toBe('port-held');
      expect(await bridge.waitForConnection(100)).toBe(false); // fast, no hang

      const out = await bridge.navigate({ type: 'home', token: 't1' }, 500);
      expect(out.kind).toBe('port-held');
      if (out.kind === 'port-held') {
        expect(out.detail).toContain(String(port));
      }
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });
});

describe('startNativeBridge — nav-intent channel (isolation demotion)', () => {
  let bridge: NativeBridgeHandle | null = null;
  afterEach(() => {
    bridge?.close();
    bridge = null;
  });

  it('records nav intents pushed by the device and filters them by sinceMs', async () => {
    // The auto-mocked navigator on the device swallows navigate(), so the host
    // must learn an attempt HAPPENED to demote "the screen should have gone
    // away" from a confident FAIL to unverifiable.
    const port = nextPort();
    bridge = startNativeBridge({ port });
    expect(await bridge.whenReady()).toBe('local');
    const ws = await open(`ws://127.0.0.1:${port}`);
    ws.send(JSON.stringify({ type: 'hello' }));
    await until(() => bridge!.isConnected());

    const before = Date.now();
    ws.send(JSON.stringify({ type: 'nav-intent', method: 'navigate' }));
    await untilAsync(async () => (await bridge!.navIntentsSince(0)).length > 0);

    const all = await bridge.navIntentsSince(0);
    expect(all).toHaveLength(1);
    expect(all[0]!.method).toBe('navigate');
    // Bracketing works: intents older than the window are excluded, so one
    // criterion's navigation can never demote a later one.
    expect(await bridge.navIntentsSince(before - 1000)).toHaveLength(1);
    expect(await bridge.navIntentsSince(Date.now() + 1000)).toHaveLength(0);
    ws.close();
    await closed(ws);
  });

  it('DELEGATED: reads intents from the bridge that owns the port', async () => {
    // The device connects to whichever process owns the port; a delegated
    // handle that read only its own (empty) list would silently never demote.
    const port = nextPort();
    const owner = startNativeBridge({ port });
    try {
      expect(await owner.whenReady()).toBe('local');
      const ws = await open(`ws://127.0.0.1:${port}`);
      ws.send(JSON.stringify({ type: 'hello' }));
      await until(() => owner.isConnected());
      ws.send(JSON.stringify({ type: 'nav-intent', method: 'push' }));
      await untilAsync(async () => (await owner.navIntentsSince(0)).length > 0);

      bridge = startNativeBridge({ port });
      expect(await bridge.whenReady()).toBe('delegated');
      const seen = await bridge.navIntentsSince(0);
      expect(seen.map((i) => i.method)).toEqual(['push']);
      ws.close();
      await closed(ws);
    } finally {
      owner.close();
    }
  });
});

describe('startNativeBridge — Expo dev-menu dismissal', () => {
  let bridge: NativeBridgeHandle | null = null;
  afterEach(() => {
    bridge?.close();
    bridge = null;
  });

  // Why the host needs to ask the APP to close the Expo dev menu at all:
  // expo-dev-menu opens it whenever `showsAtLaunch || !isOnboardingFinished`,
  // and `isOnboardingFinished` defaults to false until a human taps through the
  // onboarding sheet — never, on an installer-provisioned companion. So it
  // re-opens on every React-context init, and being a MODAL bottom sheet it
  // hides the render marker underneath from every a11y query the host makes.

  it('dismissDevMenu: capability-gated — an old companion is never sent the message', async () => {
    // An old binary drops unknown message types silently, so pushing one would
    // burn the whole ack timeout for an ack that can never arrive. Worse, a
    // caller must not read the resulting timeout as "there was no menu".
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    const seen: any[] = [];
    client.on('message', (d) => seen.push(JSON.parse(d.toString())));
    client.send(JSON.stringify({ type: 'hello', caps: ['reload'] }));
    await until(() => bridge!.deviceInfo() !== null);

    const started = Date.now();
    expect(await bridge.dismissDevMenu(2000)).toBe(false);
    // Answered immediately (no ack wait) and nothing was written to the device.
    expect(Date.now() - started).toBeLessThan(500);
    expect(seen.some((m) => m.type === 'dismiss-dev-menu')).toBe(false);
    client.close();
    await closed(client);
  });

  it('dismissDevMenu: a device that never said hello is treated as incapable', async () => {
    // No hello → no capabilities → conservative read. Never a fabricated
    // success, and never a wait for an ack the device may not understand.
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await until(() => bridge!.isConnected());
    expect(await bridge.dismissDevMenu(2000)).toBe(false);
    client.close();
    await closed(client);
  });

  it('dismissDevMenu: sends a tokenized message and relays the device ok verbatim', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    client.send(JSON.stringify({ type: 'hello', caps: ['reload', 'dismiss-dev-menu'] }));
    await until(() => bridge!.deviceInfo() !== null);

    client.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'dismiss-dev-menu') {
        client.send(JSON.stringify({ type: 'dev-menu-dismissed', token: m.token, ok: true }));
      }
    });
    expect(await bridge.dismissDevMenu(2000)).toBe(true);
    client.close();
    await closed(client);
  });

  it('dismissDevMenu: ok:false ("nothing to dismiss") is relayed as false, not swallowed', async () => {
    // A release build has no expo-dev-menu module and the native close can
    // reject. The caller MUST be able to tell "closed it" from "there was
    // nothing I could close" — the latter means keep observing.
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    client.send(JSON.stringify({ type: 'hello', caps: ['dismiss-dev-menu'] }));
    await until(() => bridge!.deviceInfo() !== null);
    client.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'dismiss-dev-menu') {
        client.send(JSON.stringify({ type: 'dev-menu-dismissed', token: m.token, ok: false }));
      }
    });
    expect(await bridge.dismissDevMenu(2000)).toBe(false);
    client.close();
    await closed(client);
  });

  it('dismissDevMenu: a device that never acks resolves false at the timeout', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    client.send(JSON.stringify({ type: 'hello', caps: ['dismiss-dev-menu'] }));
    await until(() => bridge!.deviceInfo() !== null);
    expect(await bridge.dismissDevMenu(150)).toBe(false);
    client.close();
    await closed(client);
  });

  it('dismissDevMenu: a dismissal ack can never satisfy a RENDER waiter', async () => {
    // The two ack channels are keyed independently. If a dev-menu ack could
    // resolve a render waiter, a dismissal would confirm a paint that never
    // happened — the exact class of false confidence the paint cross-check
    // exists to remove.
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    client.send(JSON.stringify({ type: 'hello', caps: ['dismiss-dev-menu'] }));
    await until(() => bridge!.deviceInfo() !== null);

    const rendered = bridge.waitForRendered('shared-token', 200);
    client.send(JSON.stringify({ type: 'dev-menu-dismissed', token: 'shared-token', ok: true }));
    expect(await rendered).toBeNull();
    client.close();
    await closed(client);
  });

  it('dismissDevMenu is NOT a drive command — it is never replayed onto a reconnect', async () => {
    // lastDriveMessage is replayed to every (re)connecting device. A dismissal
    // in that slot would both be meaningless on a fresh session and evict the
    // navigate the session actually needs to self-heal back to.
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const first = await open(`ws://127.0.0.1:${port}`);
    first.send(JSON.stringify({ type: 'hello', caps: ['dismiss-dev-menu'] }));
    await until(() => bridge!.deviceInfo() !== null);
    bridge.send({ type: 'navigate', token: 'n1', component: 'src/Button.tsx' });
    first.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'dismiss-dev-menu') {
        first.send(JSON.stringify({ type: 'dev-menu-dismissed', token: m.token, ok: true }));
      }
    });
    expect(await bridge.dismissDevMenu(2000)).toBe(true);
    first.close();
    await closed(first);

    // A new session gets the NAVIGATE replayed, not the dismissal. The listener
    // is attached before the socket opens (the replay is written on 'connection',
    // so attaching after `open` resolves can miss it).
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    const replayed = await nextMessage(second);
    expect(replayed).toMatchObject({ type: 'navigate', token: 'n1', replay: true });
    second.close();
    await closed(second);
  });

  it('DELEGATED: the dismissal hops through the bridge that owns the port', async () => {
    // Same shape as navigate: the device is connected to the OWNING process, so
    // a delegated handle that tried to dismiss locally would always answer
    // false and quietly leave the menu up.
    const port = nextPort();
    const owner = startNativeBridge({ port });
    try {
      expect(await owner.whenReady()).toBe('local');
      const ws = await open(`ws://127.0.0.1:${port}`);
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'dismiss-dev-menu') {
          ws.send(JSON.stringify({ type: 'dev-menu-dismissed', token: m.token, ok: true }));
        }
      });
      ws.send(JSON.stringify({ type: 'hello', caps: ['dismiss-dev-menu'] }));
      await until(() => owner.isConnected() && owner.deviceInfo() !== null);

      bridge = startNativeBridge({ port });
      expect(await bridge.whenReady()).toBe('delegated');
      expect(await bridge.dismissDevMenu(2000)).toBe(true);
      ws.close();
      await closed(ws);
    } finally {
      owner.close();
    }
  });
});

describe('startNativeBridge — retained render acks (deep-link + late-ack channel)', () => {
  let bridge: NativeBridgeHandle | null = null;
  afterEach(() => {
    bridge?.close();
    bridge = null;
  });

  // WHY THIS EXISTS — the `expect.performance metric: mount` lottery. The
  // `rendered` ack is the ONLY carrier of on-device timing (perf), matched
  // requests and the console-error count. The host used to DROP any ack nobody
  // was already waiting for, which is exactly the shape of the two paths that
  // matter most:
  //   • the DEEP-LINK rung (a bridge ack timed out; the render is confirmed by
  //     the tokenized marker, and the ack is asked for only afterwards), and
  //   • a LATE bridge ack (the device answered a beat after the host gave up).
  // Every capture that took either path reported `expect.performance`
  // unverifiable — "rebuild the companion" — for a render the device HAD
  // measured, rotating to a different spec each sweep.

  it('retains an ack nobody is waiting for and hands it to the next waitForRendered', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    client.send(JSON.stringify({ type: 'hello', caps: ['deep-link-ack'] }));
    await until(() => bridge!.isConnected());

    // The device acks the DEEP-LINK token the moment it paints — before the
    // host (still waiting on the a11y marker) asks for it.
    client.send(
      JSON.stringify({
        type: 'rendered',
        token: 'link-1',
        ok: true,
        consoleErrorCount: 0,
        perf: { readyMs: 640, mountMs: 31, commitCount: 1 },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    // Zero budget: the ack must come from the retained store, not from waiting.
    const ack = await bridge.waitForRendered('link-1', 0);
    expect(ack).toMatchObject({ ok: true, perf: { readyMs: 640, mountMs: 31, commitCount: 1 } });

    client.close();
    await closed(client);
  });

  it('consumes a retained ack on read — one ack is evidence for exactly one render', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await until(() => bridge!.isConnected());

    client.send(
      JSON.stringify({ type: 'rendered', token: 'link-1', ok: true, perf: { mountMs: 12 } }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(await bridge.waitForRendered('link-1', 0)).toMatchObject({ perf: { mountMs: 12 } });
    // A SECOND capture reusing that token must not inherit the first's timing.
    expect(await bridge.waitForRendered('link-1', 20)).toBeNull();

    client.close();
    await closed(client);
  });

  it('a live waiter still wins — retention never delays or duplicates a normal ack', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await until(() => bridge!.isConnected());

    const acked = bridge.waitForRendered('t1', 2000);
    client.send(JSON.stringify({ type: 'rendered', token: 't1', ok: true, perf: { mountMs: 7 } }));
    expect(await acked).toMatchObject({ ok: true, perf: { mountMs: 7 } });
    // Nothing was retained behind the waiter's back.
    expect(await bridge.waitForRendered('t1', 20)).toBeNull();

    client.close();
    await closed(client);
  });

  it('bounds the retained set so an unread session cannot grow without limit', async () => {
    const port = nextPort();
    bridge = startNativeBridge({ port });
    const client = await open(`ws://127.0.0.1:${port}`);
    await until(() => bridge!.isConnected());

    // 20 unread acks against a 16-entry FIFO: the oldest are evicted, the
    // newest (the only ones any caller could still want) survive.
    for (let i = 0; i < 20; i += 1) {
      client.send(JSON.stringify({ type: 'rendered', token: `t${i}`, ok: true }));
    }
    await new Promise((r) => setTimeout(r, 80));
    expect(await bridge.waitForRendered('t0', 0)).toBeNull();
    expect(await bridge.waitForRendered('t3', 0)).toBeNull();
    expect(await bridge.waitForRendered('t19', 0)).toMatchObject({ ok: true });

    client.close();
    await closed(client);
  });

  it('DELEGATED: reads a retained ack from the bridge that owns the port', async () => {
    // The device is connected to the OWNING process, so a delegated handle that
    // looked only at its own (empty) store would keep losing perf on every
    // fallback-confirmed render — the exact bug, just one process over.
    const port = nextPort();
    const owner = startNativeBridge({ port });
    try {
      expect(await owner.whenReady()).toBe('local');
      const ws = await open(`ws://127.0.0.1:${port}`);
      ws.send(JSON.stringify({ type: 'hello', caps: ['deep-link-ack'] }));
      await until(() => owner.isConnected());
      ws.send(
        JSON.stringify({
          type: 'rendered',
          token: 'link-9',
          ok: true,
          perf: { readyMs: 500, mountMs: 44, commitCount: 1 },
        }),
      );
      await new Promise((r) => setTimeout(r, 50));

      bridge = startNativeBridge({ port });
      expect(await bridge.whenReady()).toBe('delegated');
      expect(await bridge.waitForRendered('link-9', 500)).toMatchObject({
        ok: true,
        perf: { readyMs: 500, mountMs: 44, commitCount: 1 },
      });
      // And an unknown token degrades to null rather than a fabricated timing.
      expect(await bridge.waitForRendered('nope', 100)).toBeNull();
      ws.close();
      await closed(ws);
    } finally {
      owner.close();
    }
  });
});
