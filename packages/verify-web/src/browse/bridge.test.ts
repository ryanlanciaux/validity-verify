import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { type ClientOptions } from 'ws';
import { expect, it } from 'vitest';
import { attachBridge } from './bridge.js';

const open = (url: string, options?: ClientOptions): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

it('denies foreign/null origins and rebinding before replacing the legitimate page', async () => {
  const server = createServer();
  const bridge = attachBridge(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/__validity/bridge`;
  const client = await open(url, { origin: `http://127.0.0.1:${port}` });
  try {
    for (const options of [
      { origin: 'https://evil.example' },
      { origin: 'null' },
      { origin: `http://localhost:${port}` },
      { headers: { host: `evil.example:${port}` } },
      { headers: { host: '127.0.0.1:1' } },
    ]) {
      await expect(open(url, options)).rejects.toThrow(/403/);
      expect(client.readyState).toBe(WebSocket.OPEN);
      const message = new Promise<string>((resolve) =>
        client.once('message', (data) => resolve(data.toString())),
      );
      expect(bridge.send({ type: 'ping' })).toBe(true);
      expect(JSON.parse(await message)).toEqual({ type: 'ping' });
    }
    const local = await open(url); // Native/local tooling may omit Origin.
    expect(bridge.isConnected()).toBe(true);
    local.close();
  } finally {
    client.close();
    bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
