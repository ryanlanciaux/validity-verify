import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureComponent, launchBrowser } from './capture.js';
import { captureUrls } from './url-capture.js';

// Two loopback ports are distinct origins. The first page script records what
// it can read, rather than checking only the storage state after capture.
describe('storage seeds stay on the capture target origin', () => {
  const servers: Server[] = [];
  let target: string;
  let foreign: string;
  let screenshotsDir: string;

  async function serve(isTarget: boolean): Promise<string> {
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/redirect' || url.searchParams.get('component') === 'redirect') {
        res.writeHead(302, { location: foreign });
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html data-validity-ready><body>
        <script>document.body.dataset.storage = JSON.stringify([
          localStorage.getItem('audit-local'), sessionStorage.getItem('audit-session')
        ]);</script>
        ${
          isTarget && !url.searchParams.has('frame')
            ? `
          <iframe src="/?frame=same"></iframe><iframe src="${foreign}"></iframe>
        `
            : ''
        }
      </body></html>`);
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test server address');
    return `http://127.0.0.1:${address.port}`;
  }

  beforeAll(async () => {
    screenshotsDir = mkdtempSync(resolve(tmpdir(), 'validity-storage-origin-'));
    foreign = await serve(false);
    target = await serve(true);
  });

  afterAll(async () => {
    for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
    rmSync(screenshotsDir, { recursive: true, force: true });
  });

  for (const mode of ['url', 'component'] as const) {
    for (const redirect of [false, true]) {
      it(`${mode}: ${redirect ? 'initial cross-origin redirect' : 'frames, popup and navigation'} do not receive seeds`, async () => {
        let played = false;
        const seeded = JSON.stringify(['synthetic-local', 'synthetic-session']);
        const empty = JSON.stringify([null, null]);
        const play = async ({ page }: { page: unknown }) => {
          const p = page as Page;
          if (redirect) {
            expect(new URL(p.url()).origin).toBe(foreign);
            expect(await p.locator('body').getAttribute('data-storage')).toBe(empty);
          } else {
            expect(p.frames()).toHaveLength(3);
            for (const frame of p.frames()) {
              expect(await frame.locator('body').getAttribute('data-storage')).toBe(
                new URL(frame.url()).origin === target ? seeded : empty,
              );
            }
            const popupPromise = p.waitForEvent('popup');
            await p.evaluate((url) => {
              window.open(url);
            }, foreign);
            const popup = await popupPromise;
            await popup.waitForLoadState('load');
            expect(await popup.locator('body').getAttribute('data-storage')).toBe(empty);
            await popup.close();
            await p.goto(foreign);
            expect(await p.locator('body').getAttribute('data-storage')).toBe(empty);
            await p.goto(`${target}/?frame=return`);
            expect(await p.locator('body').getAttribute('data-storage')).toBe(seeded);
          }
          played = true;
        };
        const common = {
          screenshotsDir,
          localStorage: { 'audit-local': 'synthetic-local' },
          sessionStorage: { 'audit-session': 'synthetic-session' },
          a11ySeverity: 'off' as const,
          play,
        };
        let result;
        if (mode === 'url') {
          [result] = await captureUrls({
            screenshotsDir,
            requests: [
              { ...common, id: `url-${redirect}`, url: `${target}/${redirect ? 'redirect' : ''}` },
            ],
          });
        } else {
          const session = await launchBrowser();
          try {
            result = await captureComponent(session, {
              ...common,
              devServerUrl: target,
              componentPath: redirect ? 'redirect' : 'fixture',
              componentId: 'storage-origin',
              variantSlug: String(redirect),
            });
          } finally {
            await session.close();
          }
        }
        expect(result?.errorMessage).toBeUndefined();
        expect(played).toBe(true);
      }, 60_000);
    }
  }
});
