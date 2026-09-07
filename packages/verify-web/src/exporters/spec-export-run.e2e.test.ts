/**
 * PROVES the exported Playwright output actually RUNS — the fix-or-kill gate
 * for the export/portability story.
 *
 * Every other export test string-matches or transpiles the generated text;
 * none of that catches a wrong Playwright API, a bad selector strategy, or a
 * race in the emitted waitForResponse. This test closes that hole end to end:
 *
 *   1. freeze a real spec (navigate / fill / click / expect.network /
 *      expect.element / expect.console) — zero export warnings, so it is
 *      exactly the export-eligible population the portable badge vouches for;
 *   2. compile it with the REAL exporter into `.validity/exports/playwright/`;
 *   3. execute the generated `.spec.ts` with the REAL `@playwright/test`
 *      runner against a live local HTTP server — and require it to PASS;
 *   4. break the page (the success status never appears) and require the SAME
 *      generated test to FAIL — proving the assertions are live, not vacuous.
 *
 * If Chromium can't launch, CI fails explicitly; local runs keep the
 * fallback warning, mirroring spec-verify-e2e.test.ts.
 */
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { freezeSpec, writeSpec, type Spec, type ValidityConfig } from '@validity.ai/verify-spec';
import { writeSpecExport } from './spec-export-manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The sandbox package root — its node_modules carries @playwright/test. */
const sandboxRoot = resolve(here, '..', '..');

const T0 = '2026-01-01T00:00:00.000Z';

/**
 * The live fixture app. `showThanks` is mutable so the SAME exported test can
 * be run against a working page (must pass) and a broken one (must fail).
 */
function contactFormHtml(showThanks: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Contact</title></head>
<body>
  <form>
    <label>Email <input type="text" name="email"></label>
    <button type="button">Send</button>
  </form>
  <script>
    document.querySelector('button').addEventListener('click', async () => {
      await fetch('/api/contact', { method: 'POST', body: '{}' });
      ${
        showThanks
          ? `const el = document.createElement('div');
      el.setAttribute('role', 'status');
      el.setAttribute('aria-label', 'Thanks!');
      el.textContent = 'Thanks! Your message was sent.';
      document.body.appendChild(el);`
          : `/* broken build: the success status never appears */`
      }
    });
  </script>
</body></html>`;
}

function exportRunSpec(): Spec {
  return {
    id: 'spec-run1',
    version: 1,
    status: 'draft',
    source: { prompt: 'contact form posts and confirms', createdBy: 'agent' },
    runtime: 'web',
    criteria: [
      {
        id: 'AC-1',
        text: 'submitting the contact form posts and shows the confirmation',
        tier: 'hard',
        checks: [
          { navigate: { url: '/' } },
          { fill: { role: 'textbox', name: 'Email', value: 'a@b.com' } },
          { click: { role: 'button', name: 'Send' } },
          { expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } } },
          { expect: { element: { role: 'status', name: 'Thanks!', state: 'visible' } } },
          { expect: { console: { errors: 0 } } },
        ],
      },
    ],
    createdAt: T0,
  };
}

describe('exported Playwright output RUNS (fix-or-kill gate for portability)', () => {
  let browser: Browser | undefined;
  let launchError = '';
  let server: Server | undefined;
  let baseUrl = '';
  let showThanks = true;

  beforeAll(async () => {
    try {
      browser = await chromium.launch();
    } catch (err) {
      launchError = (err as Error).message;
      if (process.env.CI) {
        throw new Error(`Chromium couldn't launch: ${launchError}`, { cause: err });
      }
      return;
    }
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/contact') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(contactFormHtml(showThanks));
    });
    await new Promise<void>((ready) => server!.listen(0, '127.0.0.1', ready));
    const addr = server.address();
    if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  });

  // MUST be async (spawn, not spawnSync): the fixture HTTP server lives in
  // THIS process, and a synchronous wait would block the event loop — the
  // browser's requests would hang and every goto dies with net::ERR_ABORTED.
  function runExportedSuite(root: string): Promise<{ status: number | null; output: string }> {
    return new Promise((done) => {
      const child = spawn(
        process.execPath,
        [
          // Use the same runner instance the exported test imports, not the
          // potentially different `playwright` dependency's bin shim.
          createRequire(import.meta.url).resolve('@playwright/test/cli'),
          'test',
          '--config',
          'playwright.config.ts',
        ],
        { cwd: root, timeout: 90_000 },
      );
      let output = '';
      child.stdout.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr.on('data', (d: Buffer) => (output += d.toString()));
      child.on('close', (status) => done({ status, output }));
    });
  }

  it('the generated .spec.ts passes against the live page and fails against a broken one', async () => {
    if (!browser) {
      console.warn(`skipping export-run e2e — chromium did not launch: ${launchError}`);
      return;
    }

    const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-export-run-')));
    try {
      writeSpec(root, exportRunSpec());
      const frozen = freezeSpec({ projectRoot: root, specId: 'spec-run1', gitBinding: null }).spec;

      const config: ValidityConfig = {
        renderMode: 'web',
        framework: 'auto',
        wrapper: './.validity/wrapper.tsx',
        export: { baseUrl },
      };
      const result = writeSpecExport(root, frozen, config, { now: T0 });
      // The proof only counts for the export-eligible population: this spec
      // must compile with ZERO warnings, or the test is exercising a stub.
      expect(result.warnings).toEqual([]);
      expect(result.written.some((p) => p.endsWith('.spec.ts'))).toBe(true);

      // Let the generated test resolve `@playwright/test` from the sandbox
      // package's own dependency tree.
      symlinkSync(resolve(sandboxRoot, 'node_modules'), resolve(root, 'node_modules'), 'dir');
      writeFileSync(
        resolve(root, 'playwright.config.ts'),
        `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './.validity/exports/playwright',
  timeout: 30_000,
  expect: { timeout: 4_000 },
  workers: 1,
  reporter: 'list',
});
`,
      );

      // 3. The exported suite RUNS and PASSES against the working page.
      showThanks = true;
      const green = await runExportedSuite(root);
      expect(green.output).toContain('1 passed');
      expect(green.status).toBe(0);

      // 4. The SAME suite FAILS when the page breaks — live assertions, not
      // vacuous ones. (The status element never appears; toBeVisible times
      // out at the config's 4s expect budget.)
      showThanks = false;
      const red = await runExportedSuite(root);
      expect(red.status).not.toBe(0);
      expect(red.output).toContain('1 failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
