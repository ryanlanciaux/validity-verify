import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { A11yViolation, MockNetworkConfig, PlayFunction } from '@validity.ai/verify-spec';
import { launchBrowser, type BrowserSession } from './capture.js';
import {
  attachDiagnostics,
  type ConsoleErrorEntry,
  type NetworkErrorEntry,
  type PageErrorEntry,
} from './diagnostics.js';
import { resolveResponse } from './network-matcher.js';
import { runAxe, type A11ySeverity } from './a11y.js';

export interface UrlCaptureRequest {
  url: string;
  /** Stable id used for the screenshot filename and reporting back to the host. */
  id: string;
  /**
   * Network mocks applied to this page via Playwright's `page.route('**\/*')`.
   * Anything the browser fetches/XHRs is matched against `handlers`; if no
   * handler matches, the configured `fallback` fires (default 'permissive').
   * Server-side fetches the dev server makes in its own Node process are
   * NOT visible here — only requests that leave the browser.
   */
  mockNetwork?: MockNetworkConfig;
  /** Cookies seeded on the BrowserContext before navigation. Map name → value. */
  cookies?: Record<string, string>;
  /** localStorage seeded via initScript before any page script runs. */
  localStorage?: Record<string, string>;
  /** sessionStorage seeded via initScript before any page script runs. */
  sessionStorage?: Record<string, string>;
  /**
   * Optional play callback — runs after the initial page load + networkidle
   * settle, before the screenshot. Receives a Playwright `Page`. Bounded by
   * `playTimeoutMs` (default 10s).
   */
  play?: PlayFunction;
  playTimeoutMs?: number;
  /** A11y severity floor for this request. Defaults to 'serious'. */
  a11ySeverity?: A11ySeverity;
}

export interface UrlCaptureResult {
  id: string;
  url: string;
  screenshotPath: string;
  errorMessage?: string;
  /** Requests not matched by any handler (handled by the fallback). */
  unmatchedUrls: string[];
  /** `console.error` calls fired during the render. Capped at 25. */
  consoleErrors: ConsoleErrorEntry[];
  /** Uncaught exceptions that escaped React's error boundaries. Capped at 25. */
  pageErrors: PageErrorEntry[];
  /** 4xx/5xx responses (excluding HMR/asset chatter). Capped at 25. */
  networkErrors: NetworkErrorEntry[];
  /** Axe-core violations (severity ≥ floor). Empty when a11y is off or clean. */
  a11yViolations: A11yViolation[];
}

export interface CaptureUrlsArgs {
  requests: UrlCaptureRequest[];
  screenshotsDir: string;
  viewport?: { width: number; height: number };
  /** Fail fast if the dev server isn't reachable, rather than letting Playwright hang for 30s. */
  reachabilityTimeoutMs?: number;
}

const DEFAULT_PLAY_TIMEOUT_MS = 10_000;
const POST_LOAD_NETWORKIDLE_TIMEOUT_MS = 15_000;
const POST_PLAY_SETTLE_MS = 100;

/**
 * Heuristic for "is this a request the user would want to mock?". Used in
 * URL mode to filter the unmatched-URL warning so it surfaces API/data
 * fetches rather than framework chatter (HMR pings, asset bundles, fonts,
 * source maps). False positives are fine — the warning is just a hint.
 */
const ASSET_EXTENSIONS =
  /\.(?:js|mjs|cjs|css|map|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf|eot|wasm|mp4|webm|mp3|wav)(?:\?|$)/i;
const FRAMEWORK_PATH_PREFIXES = [
  '/_next/',
  '/__next/',
  '/_nuxt/',
  '/@vite/',
  '/@id/',
  '/@fs/',
  '/@react-refresh',
  '/node_modules/',
  '/.well-known/',
];

function looksLikeApiRequest(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  if (ASSET_EXTENSIONS.test(path)) return false;
  for (const prefix of FRAMEWORK_PATH_PREFIXES) {
    if (path.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Capture a list of URLs against the user's already-running dev server. No
 * sandbox, no synthetic entry — Playwright drives whatever's at the URL.
 * Use when the agent is verifying a page (or set of pages) rather than an
 * isolated component.
 *
 * Per-request: `mockNetwork` installs a `page.route('**\/*')` interceptor;
 * `cookies` / `localStorage` / `sessionStorage` seed via Playwright before
 * navigation; `play` runs after initial settle, before the screenshot.
 *
 * Each request gets a fresh BrowserContext so cookies, storage, and route
 * handlers don't bleed between pages.
 */
export async function captureUrls(args: CaptureUrlsArgs): Promise<UrlCaptureResult[]> {
  if (!existsSync(args.screenshotsDir)) {
    mkdirSync(args.screenshotsDir, { recursive: true });
  }

  const session: BrowserSession = await launchBrowser({ viewport: args.viewport });
  const results: UrlCaptureResult[] = [];

  try {
    for (const req of args.requests) {
      results.push(await capturePage(session, req, args));
    }
  } finally {
    await session.close();
  }

  return results;
}

async function capturePage(
  session: BrowserSession,
  req: UrlCaptureRequest,
  args: CaptureUrlsArgs,
): Promise<UrlCaptureResult> {
  const screenshotPath = resolve(args.screenshotsDir, `${req.id}.png`);
  const unmatchedUrls: string[] = [];

  const context = await session.browser.newContext({
    viewport: args.viewport ?? { width: 1280, height: 800 },
  });

  try {
    if (req.cookies && Object.keys(req.cookies).length > 0) {
      const url = new URL(req.url);
      const cookieEntries = Object.entries(req.cookies).map(([name, value]) => ({
        name,
        value,
        domain: url.hostname,
        path: '/',
        secure: url.protocol === 'https:',
        sameSite: 'Lax' as const,
      }));
      await context.addCookies(cookieEntries);
    }

    if (
      (req.localStorage && Object.keys(req.localStorage).length > 0) ||
      (req.sessionStorage && Object.keys(req.sessionStorage).length > 0)
    ) {
      const seed = {
        localStorage: req.localStorage ?? {},
        sessionStorage: req.sessionStorage ?? {},
      };
      await context.addInitScript(`
        (function () {
          try {
            // Context init scripts also run in foreign frames, popups and redirects.
            if (location.origin !== ${JSON.stringify(new URL(req.url).origin)}) return;
            var seed = ${JSON.stringify(seed)};
            for (var k in seed.localStorage) localStorage.setItem(k, seed.localStorage[k]);
            for (var k2 in seed.sessionStorage) sessionStorage.setItem(k2, seed.sessionStorage[k2]);
          } catch (_) { /* private mode etc. — ignore */ }
        })();
      `);
    }

    const page = await context.newPage();
    // Attach diagnostics before route handlers / navigation so we don't miss
    // a console.error that fires during the initial module-load.
    const diag = attachDiagnostics(page);

    if (req.mockNetwork && req.mockNetwork.handlers && req.mockNetwork.handlers.length > 0) {
      const network = req.mockNetwork;
      // URL-mode semantics differ from isolation mode: the real dev server is
      // serving the page, so unmatched requests must passthrough (otherwise
      // a permissive 200-{} fallback would 200 every framework asset and the
      // page would never render). We only intercept what an explicit handler
      // matches; we still TRACK unmatched requests so the agent gets the
      // same "consider mocking this" hint, but we don't fulfill them.
      await page.route('**/*', async (route) => {
        const request = route.request();
        if (request.isNavigationRequest()) {
          await route.continue();
          return;
        }
        const resolved = resolveResponse(request.method(), request.url(), network);
        if (resolved.matched) {
          await route.fulfill({
            status: resolved.status,
            headers: resolved.headers,
            body: resolved.body,
          });
          return;
        }
        // Don't spam the unmatched list with framework chatter — only track
        // the kinds of requests the user might reasonably want to mock
        // (typically API/JSON calls, not assets).
        if (looksLikeApiRequest(request.url())) {
          unmatchedUrls.push(`${request.method()} ${request.url()}`);
        }
        await route.continue();
      });
    }

    let errorMessage: string | undefined;
    let a11yViolations: A11yViolation[] = [];
    try {
      await page.goto(req.url, { waitUntil: 'load', timeout: 30_000 });
      await page
        .waitForLoadState('networkidle', { timeout: POST_LOAD_NETWORKIDLE_TIMEOUT_MS })
        .catch(() => {});

      if (typeof req.play === 'function') {
        const playTimeout = req.playTimeoutMs ?? DEFAULT_PLAY_TIMEOUT_MS;
        try {
          await Promise.race([
            Promise.resolve(req.play({ page: page as unknown })),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`play function exceeded ${playTimeout}ms`)),
                playTimeout,
              ),
            ),
          ]);
          await page.waitForTimeout(POST_PLAY_SETTLE_MS);
        } catch (err) {
          errorMessage = `play function: ${(err as Error).message}`;
        }
      }

      a11yViolations = await runAxe(page, req.a11ySeverity ?? 'serious');

      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (err) {
      errorMessage = (err as Error).message;
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch {
        // ignore
      }
    }

    // Snapshot diagnostics BEFORE closing the page — listeners stop firing
    // once the page is gone, and we want the post-screenshot tail of
    // console/network activity included.
    const diagnostics = diag.snapshot();
    await page.close();

    return {
      id: req.id,
      url: req.url,
      screenshotPath,
      errorMessage,
      unmatchedUrls: Array.from(new Set(unmatchedUrls)),
      consoleErrors: diagnostics.consoleErrors,
      pageErrors: diagnostics.pageErrors,
      networkErrors: diagnostics.networkErrors,
      a11yViolations,
    };
  } finally {
    await context.close();
  }
}

/**
 * Best-effort dev-server URL detection from the project's package.json. The
 * goal is to let the agent call validity__verify with just a list of paths
 * and have us figure out where the dev server is running. Heuristics, in
 * priority order:
 *
 *   1. Explicit `--port <N>` / `--port=<N>` / `-p <N>` in scripts.dev (the
 *      user has overridden the default).
 *   2. Framework default for the runner used in scripts.dev:
 *        vite      → 5173
 *        next      → 3000
 *        astro     → 4321
 *        remix     → 3000
 *        react-scripts → 3000
 *   3. Nothing detected — return undefined; the caller has to ask for an
 *      explicit baseUrl.
 *
 * NB: this does NOT probe the network. The agent is responsible for making
 * sure the dev server is actually running (we can probe later if it's
 * worth the latency).
 */
export function detectDevServerBaseUrl(projectRoot: string): string | undefined {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return undefined;

  let scriptsDev: string;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    scriptsDev = pkg.scripts?.dev?.trim() ?? '';
  } catch {
    return undefined;
  }
  if (!scriptsDev) return undefined;

  const explicitPort =
    scriptsDev.match(/--port[\s=](\d+)/)?.[1] ?? scriptsDev.match(/(?:^|\s)-p[\s=](\d+)/)?.[1];

  const FRAMEWORK_DEFAULTS: Array<{ runner: RegExp; port: number }> = [
    { runner: /\b(vite)\b/, port: 5173 },
    { runner: /\b(next)\b/, port: 3000 },
    { runner: /\b(astro)\b/, port: 4321 },
    { runner: /\b(remix)\b/, port: 3000 },
    { runner: /\b(react-scripts)\b/, port: 3000 },
  ];

  let port: number | undefined;
  if (explicitPort) {
    port = Number(explicitPort);
  } else {
    for (const { runner, port: defaultPort } of FRAMEWORK_DEFAULTS) {
      if (runner.test(scriptsDev)) {
        port = defaultPort;
        break;
      }
    }
  }

  if (!port || !Number.isFinite(port)) return undefined;
  return `http://localhost:${port}`;
}
