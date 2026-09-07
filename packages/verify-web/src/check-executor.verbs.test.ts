/**
 * Real-Playwright coverage for the wait / waitForRequest / select / scroll /
 * element-scoped press verbs. Fake-page unit tests in check-executor.test.ts
 * cover the can't-false-green branches; this file drives a tiny HTML fixture
 * the way a verify run would.
 *
 * If chromium can't launch the suite self-skips (same posture as
 * spec-verify-e2e.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { executeChecks } from './check-executor.js';
import type { Check } from '@validity.ai/verify-spec';

const FIXTURE = `<!doctype html>
<html>
  <body>
    <label>Country
      <select id="country" aria-label="Country">
        <option value="">Pick</option>
        <option value="us">United States</option>
        <option value="ca">Canada</option>
      </select>
    </label>
    <div id="not-a-select" role="button" aria-label="Picker">not a select</div>
    <label>Email <input id="email" aria-label="Email" /></label>
    <div id="spacer" style="height:2000px"></div>
    <p id="footer">Footer</p>
    <button id="ping">Ping</button>
    <p id="later" hidden>Message sent</p>
    <script>
      document.getElementById('ping').addEventListener('click', () => {
        fetch('/api/ping', { method: 'POST' });
        setTimeout(() => { document.getElementById('later').hidden = false; }, 50);
      });
    </script>
  </body>
</html>`;

let browser: Browser | null = null;
let launchError: string | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    launchError = (err as Error).message;
    if (process.env.CI) {
      throw new Error(`Chromium couldn't launch: ${launchError}`, { cause: err });
    }
  }
});

afterAll(async () => {
  await browser?.close();
});

async function withPage(fn: (page: import('playwright').Page) => Promise<void>) {
  if (!browser) {
    console.warn(`skipping browser verb tests — chromium did not launch: ${launchError}`);
    return;
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/ping')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true}',
      });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE });
  });
  await page.goto('http://validity.test/fixture');
  try {
    await fn(page);
  } finally {
    await ctx.close();
  }
}

describe('new check verbs — real Playwright page', () => {
  it('wait { ms } passes', async () => {
    await withPage(async (page) => {
      const [v] = await executeChecks({ page, checks: [{ wait: { ms: 20 } }] });
      expect(v.status).toBe('pass');
    });
  });

  it('wait { for } visible passes once the node appears; timeout fails', async () => {
    await withPage(async (page) => {
      const passChecks: Check[] = [
        { click: { role: 'button', name: 'Ping' } },
        { wait: { for: { text: 'Message sent' }, state: 'visible' } },
      ];
      const pass = await executeChecks({ page, checks: passChecks });
      expect(pass[1]!.status).toBe('pass');

      await page.goto('http://validity.test/fixture');
      const [fail] = await executeChecks({
        page,
        checks: [{ wait: { for: { text: 'Never shown' }, state: 'visible' } }],
      });
      expect(fail.status).toBe('fail');
      expect(fail.detail).toMatch(/timed out/);
    });
  }, 20_000);

  it('waitForRequest matches a POST the page fires; missing URL fails', async () => {
    await withPage(async (page) => {
      const ok = await executeChecks({
        page,
        checks: [
          { click: { role: 'button', name: 'Ping' } },
          { waitForRequest: { url: '/api/ping', method: 'POST' } },
        ],
      });
      expect(ok[1]!.status).toBe('pass');

      const [miss] = await executeChecks({
        page,
        checks: [{ waitForRequest: { url: '/api/never', timeoutMs: 200 } }],
      });
      expect(miss.status).toBe('fail');
      expect(miss.detail).toMatch(/no request observed/);
    });
  }, 15_000);

  it('select on a native <select> passes; a non-select fails honestly', async () => {
    await withPage(async (page) => {
      const [ok] = await executeChecks({
        page,
        checks: [{ select: { selector: { label: 'Country' }, option: 'United States' } }],
      });
      expect(ok.status).toBe('pass');
      expect(await page.locator('#country').inputValue()).toBe('us');

      const [bad] = await executeChecks({
        page,
        checks: [{ select: { selector: { role: 'button', name: 'Picker' }, option: 'x' } }],
      });
      expect(bad.status).toBe('fail');
      expect(bad.detail).toBe('not a native select — use click + click on the option');
    });
  });

  it('scroll intoView brings the footer into the viewport', async () => {
    await withPage(async (page) => {
      const [v] = await executeChecks({
        page,
        checks: [{ scroll: { selector: { text: 'Footer' }, intoView: true } }],
      });
      expect(v.status).toBe('pass');
    });
  });

  it('element-scoped press types a key into the focused field', async () => {
    await withPage(async (page) => {
      await page.locator('#email').fill('hi');
      const [v] = await executeChecks({
        page,
        checks: [{ press: { key: 'a', selector: { label: 'Email' } } }],
      });
      expect(v.status).toBe('pass');
    });
  });
});
