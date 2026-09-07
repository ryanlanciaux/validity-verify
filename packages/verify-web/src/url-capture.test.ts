/**
 * Integration tests for URL-mode capture: real Playwright + a tiny
 * node:http server that simulates the user's dev server. Slow (1-3s each)
 * but they exercise the actual route-interception / cookie / localStorage /
 * play wiring end-to-end.
 *
 * Skip strategy: if Playwright's chromium isn't installed, the browser
 * launch will throw a recognizable message — we surface it as a test
 * failure (matching the existing integration.test.ts convention).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureUrls } from './url-capture.js';

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
  /** Last Cookie header observed on /api/data, for cookie-seeding assertions. */
  lastCookieHeader: () => string | undefined;
}

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

/**
 * Tiny HTTP server with the routes the tests need:
 *   GET /                    → page that fetches /api/data on load and renders it.
 *   GET /api/data            → real-server JSON; also captures the Cookie header.
 *   GET /api/extra           → second API endpoint, used for unmatched-tracking tests.
 *   GET /asset.js            → fake JS asset, used for asset-noise filtering tests.
 *   GET /storage             → page that reads localStorage('seed') and renders it.
 *   GET /button              → page with a button that toggles a div on click.
 */
function startTestServer(): Promise<TestServer> {
  let lastCookie: string | undefined;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        html(
          `<div id="out">loading</div><script>
            fetch('/api/data')
              .then(r => r.json())
              .then(j => { document.getElementById('out').textContent = JSON.stringify(j); })
              .catch(e => { document.getElementById('out').textContent = 'err: ' + e.message; });
          </script>`,
        ),
      );
      return;
    }
    if (url.pathname === '/with-extra' && req.method === 'GET') {
      // Page that hits /api/data AND /api/extra, used to test unmatched tracking.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        html(
          `<div id="out">loading</div><script>
            Promise.all([fetch('/api/data'), fetch('/api/extra')])
              .then(([a, b]) => Promise.all([a.json(), b.json()]))
              .then(([a, b]) => { document.getElementById('out').textContent = JSON.stringify({a, b}); })
              .catch(e => { document.getElementById('out').textContent = 'err: ' + e.message; });
          </script>`,
        ),
      );
      return;
    }
    if (url.pathname === '/with-asset' && req.method === 'GET') {
      // Page that pulls a JS asset, used to verify the unmatched tracker
      // filters framework-shaped chatter even when handlers are configured.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        html(
          `<div id="out">loading</div>
           <script src="/asset.js"></script>
           <script>
             fetch('/api/data')
               .then(r => r.json())
               .then(j => { document.getElementById('out').textContent = JSON.stringify(j); });
           </script>`,
        ),
      );
      return;
    }
    if (url.pathname === '/storage' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        html(
          `<div id="out"></div><script>
             document.getElementById('out').textContent = 'seed=' + (localStorage.getItem('seed') ?? 'MISSING');
           </script>`,
        ),
      );
      return;
    }
    if (url.pathname === '/button' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        html(
          `<button id="b">click</button><div id="out">before</div>
           <script>
             document.getElementById('b').addEventListener('click', () => {
               document.getElementById('out').textContent = 'after';
             });
           </script>`,
        ),
      );
      return;
    }
    if (url.pathname === '/api/data' && req.method === 'GET') {
      lastCookie = req.headers.cookie;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'real-server', cookie: req.headers.cookie ?? null }));
      return;
    }
    if (url.pathname === '/api/extra' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ from: 'real-extra' }));
      return;
    }
    if (url.pathname === '/asset.js' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('/* fake asset */');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      resolveP({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        lastCookieHeader: () => lastCookie,
      });
    });
  });
}

describe('captureUrls — URL mode integration', () => {
  let srv: TestServer;
  let screenshotsDir: string;

  beforeAll(async () => {
    srv = await startTestServer();
    screenshotsDir = mkdtempSync(resolve(tmpdir(), 'validity-url-cap-'));
  }, 60_000);

  afterAll(async () => {
    if (srv) await srv.close();
    if (screenshotsDir) {
      try {
        rmSync(screenshotsDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('passthrough by default (no mockNetwork): real server response shows up', async () => {
    const [r] = await captureUrls({
      requests: [{ id: 'pt-default', url: `${srv.baseUrl}/` }],
      screenshotsDir,
    });
    expect(r!.errorMessage).toBeUndefined();
    expect(r!.unmatchedUrls).toEqual([]);
  }, 60_000);

  it('handler intercepts a URL the page fetches', async () => {
    const [r] = await captureUrls({
      requests: [
        {
          id: 'intercept',
          url: `${srv.baseUrl}/`,
          mockNetwork: {
            handlers: [{ method: 'GET', url: '/api/data', json: { from: 'mock' } }],
          },
        },
      ],
      screenshotsDir,
    });
    expect(r!.errorMessage).toBeUndefined();
    expect(r!.unmatchedUrls).toEqual([]);
  }, 60_000);

  it('unmatched API requests are tracked (and still passthrough to real server)', async () => {
    const [r] = await captureUrls({
      requests: [
        {
          id: 'unmatched',
          url: `${srv.baseUrl}/with-extra`,
          mockNetwork: {
            // Only mock /api/data. /api/extra is unmocked → should appear in unmatchedUrls.
            handlers: [{ method: 'GET', url: '/api/data', json: { from: 'mock' } }],
          },
        },
      ],
      screenshotsDir,
    });
    expect(r!.errorMessage).toBeUndefined();
    expect(r!.unmatchedUrls.some((u) => u.includes('/api/extra'))).toBe(true);
    expect(r!.unmatchedUrls.some((u) => u.includes('/api/data'))).toBe(false);
  }, 60_000);

  it('asset noise (.js) is filtered out of unmatchedUrls', async () => {
    const [r] = await captureUrls({
      requests: [
        {
          id: 'asset-filter',
          url: `${srv.baseUrl}/with-asset`,
          mockNetwork: {
            handlers: [{ method: 'GET', url: '/api/data', json: { from: 'mock' } }],
          },
        },
      ],
      screenshotsDir,
    });
    expect(r!.errorMessage).toBeUndefined();
    // Page loads /asset.js (real, unmatched) — must NOT appear in unmatched.
    expect(r!.unmatchedUrls.some((u) => u.includes('/asset.js'))).toBe(false);
  }, 60_000);

  it('cookie seeding: the Cookie header reaches the real server', async () => {
    await captureUrls({
      requests: [
        {
          id: 'cookies',
          url: `${srv.baseUrl}/`,
          cookies: { sid: 'abc-123' },
        },
      ],
      screenshotsDir,
    });
    const cookie = srv.lastCookieHeader();
    expect(cookie).toBeDefined();
    expect(cookie!).toMatch(/sid=abc-123/);
  }, 60_000);

  it('localStorage seeding: page reads the seeded value at init', async () => {
    // We can't easily read DOM contents from captureUrls (it just returns
    // a screenshot), so we drive an assertion via the play function.
    let seenText: string | null = null;
    const [r] = await captureUrls({
      requests: [
        {
          id: 'localstorage',
          url: `${srv.baseUrl}/storage`,
          localStorage: { seed: 'hello-world' },
          play: async ({ page }) => {
            const p = page as import('playwright').Page;
            seenText = await p.evaluate(() => document.getElementById('out')?.textContent ?? null);
          },
        },
      ],
      screenshotsDir,
    });
    expect(r!.errorMessage).toBeUndefined();
    expect(seenText).toBe('seed=hello-world');
  }, 60_000);

  it('play function runs and its DOM mutations land before the screenshot', async () => {
    let beforeText: string | null = null;
    let afterText: string | null = null;
    const [r] = await captureUrls({
      requests: [
        {
          id: 'play',
          url: `${srv.baseUrl}/button`,
          play: async ({ page }) => {
            const p = page as import('playwright').Page;
            beforeText = await p.evaluate(
              () => document.getElementById('out')?.textContent ?? null,
            );
            await p.locator('#b').click();
            afterText = await p.evaluate(() => document.getElementById('out')?.textContent ?? null);
          },
        },
      ],
      screenshotsDir,
    });
    expect(r!.errorMessage).toBeUndefined();
    expect(beforeText).toBe('before');
    expect(afterText).toBe('after');
  }, 60_000);

  it('play function timeout surfaces as errorMessage (does not throw)', async () => {
    const [r] = await captureUrls({
      requests: [
        {
          id: 'play-timeout',
          url: `${srv.baseUrl}/`,
          playTimeoutMs: 50,
          play: async () => {
            await new Promise((resolveP) => setTimeout(resolveP, 5_000));
          },
        },
      ],
      screenshotsDir,
    });
    expect(r!.errorMessage).toBeDefined();
    expect(r!.errorMessage!).toMatch(/play function/);
  }, 60_000);

  it('mocked 5xx responses surface in networkErrors (URL mode)', async () => {
    const [r] = await captureUrls({
      requests: [
        {
          id: 'net-5xx',
          url: `${srv.baseUrl}/`,
          mockNetwork: {
            // Page fetches /api/data on load — mock it to 500.
            handlers: [{ method: 'GET', url: '/api/data', status: 500, json: { error: 'boom' } }],
          },
        },
      ],
      screenshotsDir,
    });
    expect(r!.errorMessage).toBeUndefined();
    // page.route().fulfill() with status: 500 IS visible to Playwright's
    // page.on('response') listener, unlike isolation mode's JS-layer MSW
    // interception. See diagnostics.ts NetworkErrorEntry docstring.
    expect(r!.networkErrors.some((e) => e.status === 500 && e.url.includes('/api/data'))).toBe(
      true,
    );
  }, 60_000);

  it('console.error fires from page script and surfaces in consoleErrors', async () => {
    // Use a data URL so we don't need a new server route.
    const [r] = await captureUrls({
      requests: [
        {
          id: 'console-err',
          url:
            'data:text/html,' +
            encodeURIComponent(
              '<html><body><script>console.error("oops from page")</script></body></html>',
            ),
        },
      ],
      screenshotsDir,
    });
    expect(r!.consoleErrors.some((e) => e.text.includes('oops from page'))).toBe(true);
  }, 60_000);
});
