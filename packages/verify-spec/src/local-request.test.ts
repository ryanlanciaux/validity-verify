import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { localRequestStatus } from './local-request.js';

it('guards real HTTP requests by loopback Host, bound port, exact Origin and JSON mutations', async () => {
  const server = createServer((req, res) => {
    res.writeHead(localRequestStatus(req, true) ?? 200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const send = (headers: Record<string, string>, method = 'GET') =>
    new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, method, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject);
      req.end();
    });
  try {
    expect(await send({})).toBe(200);
    expect(await send({ origin: `http://127.0.0.1:${port}` })).toBe(200);
    expect(await send({ host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(200);
    for (const host of [
      'evil.example',
      `evil.example:${port}`,
      '127.0.0.1:1',
      'localhost:999999',
      `127.0.0.1:${port}@evil.example`,
    ]) {
      expect(await send({ host })).toBe(403);
    }
    for (const origin of [
      'null',
      'https://evil.example',
      'http://127.0.0.1:1',
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}/`,
    ]) {
      expect(await send({ origin })).toBe(403);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(await send({ 'content-type': 'text/plain' }, method)).toBe(415);
      expect(await send({}, method)).toBe(415);
      expect(await send({ 'content-type': 'application/json; charset=utf-8' }, method)).toBe(200);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
