import { resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Response } from 'playwright';
import {
  isClickCheck,
  isFillCheck,
  type A11yViolation,
  type CriterionVerdict,
  type DataProvenance,
  type DataState,
  type PerformanceMetrics,
  type SpecCriterion,
  type UnmatchedRequest,
} from '@validity.ai/verify-spec';
import {
  attachDiagnostics,
  type ConsoleErrorEntry,
  type NetworkErrorEntry,
  type PageErrorEntry,
} from './diagnostics.js';
import { runAxe } from './a11y.js';
import {
  deriveRenderDataProvenance,
  evaluateScreenshotExpects,
  readInPageRequests,
  refoldAfterScreenshot,
  runCriterionChecks,
} from './check-executor.js';
import { diffAgainstBaseline } from './baselines.js';

export interface CaptureArgs {
  devServerUrl: string;
  componentPath: string; // project-relative
  propsId?: string;
  componentId: string;
  /** Scenario id to render under. Sent to entry.tsx as `?scenario=`. Undefined = base. */
  scenarioId?: string;
  /** Fixture id to render under. Sent to entry.tsx as `?fixture=`. Undefined = no fixture. */
  fixtureId?: string;
  /**
   * Stacked-fixture mode. When set, sent as `?fixtures=name1,name2,…` and
   * entry.tsx renders all of them as siblings under the wrapper for one
   * screenshot. Mutually exclusive with `propsId` / `fixtureId`.
   */
  stackedFixtureIds?: string[];
  /**
   * Filename suffix slug; namespaces screenshots per (scenario, fixture)
   * pair. e.g. `logged-in__primary` or `base` or `loading` or `stacked`.
   */
  variantSlug: string;
  screenshotsDir: string;
  viewport?: { width: number; height: number };
  /**
   * Force a color scheme (theme) for this render. Drives the Playwright
   * context `colorScheme` (so `prefers-color-scheme` media-query + Tailwind
   * `media` apps flip) AND is sent to entry.tsx as `?theme=` so it can set the
   * `dark` class + `data-validity-theme` attribute (Tailwind `class` apps) and
   * pass a `colorScheme` prop to the wrapper (ThemeProvider apps). Undefined =
   * the wrapper's own default theme (today's behavior).
   */
  colorScheme?: 'light' | 'dark';
  /**
   * Force a data state (A2). Sent to entry.tsx as `?dataState=` where the
   * in-page MSW layer overrides every non-internal request: `loading` hangs
   * them (so the post-ready networkidle settle is skipped — it would always
   * burn its full timeout), `empty` serves permissive-tagged empty bodies,
   * `error` serves tagged 500s. Undefined = the natural (populated) pipeline.
   */
  dataState?: DataState;
  recordVideo?: boolean;
  waitForSelector?: string;
  timeoutMs?: number;
  /** Cookies to set before navigation. Scoped to the dev-server URL. */
  cookies?: Record<string, string>;
  /** localStorage entries seeded via initScript before any page script runs. */
  localStorage?: Record<string, string>;
  /** sessionStorage entries seeded via initScript before any page script runs. */
  sessionStorage?: Record<string, string>;
  /**
   * Optional play callback — runs after the ready signal + post-ready
   * settle, before the screenshot. Receives a Playwright `Page` so it
   * can drive the rendered DOM. See @validity.ai/verify-spec's `PlayFunction`.
   * Bounded by `playTimeoutMs` (default 10s).
   */
  play?: (args: { page: unknown }) => Promise<void> | void;
  playTimeoutMs?: number;
  /**
   * A11y check severity floor. `serious` (default) returns serious + critical
   * violations; `critical` returns only critical; `off` skips axe entirely.
   * Plumbed through from `config.a11y.severity` by render.ts.
   */
  a11ySeverity?: 'serious' | 'critical' | 'off';
  /**
   * Spec hard/property criteria to execute deterministically against this
   * render. Run after `play`, before the screenshot, so the shot captures the
   * post-interaction state (e.g. a success message). Each criterion's verdict
   * lands in `CaptureResult.criterionVerdicts`. Used only on spec verifies.
   */
  criteriaChecks?: SpecCriterion[];
  /**
   * Project root, used to locate the baseline for `expect.screenshot` checks.
   * When set, after the screenshot is taken we compute a baseline pixel diff and
   * upgrade any screenshot-check verdicts (stubbed `unverifiable` by the
   * executor) to pass/fail against their `maxDiffPixels` threshold. Omitted on
   * non-spec verifies — screenshot verdicts then stay `unverifiable`.
   */
  projectRoot?: string;
  /**
   * Loop cost control. When true, skip the (expensive) full-page screenshot if
   * the render errored OR every mechanical (hard/property) verdict failed AND no
   * soft criterion needs the rendered pixels for host scoring. Lets a loop gate
   * avoid paying for a screenshot it would only use to confirm an already-red
   * verdict. Default `false` ⇒ today's behavior (always shoot). NEVER skips when
   * the hard checks pass — green renders are always captured.
   */
  screenshotShortCircuit?: boolean;
  /**
   * Whether any soft criterion still needs the rendered screenshot (e.g. for
   * host-side judge scoring or a screenshot-baseline diff). Only consulted when
   * `screenshotShortCircuit` is on. Default `true` (the safe choice): we never
   * skip a shot a soft criterion might depend on. Callers that know the spec has
   * zero soft criteria (or none need the pixels) pass `false` to unlock the skip.
   */
  softCriteriaNeedRender?: boolean;
  /**
   * Determinism seed. When set, a seeded `Math.random` (mulberry32) plus a
   * seed-derived `Date.now()` / no-arg `new Date()` are injected via an initScript
   * that runs BEFORE any page script — so renders that lean on randomness or the
   * wall clock are stable across runs. Absent ⇒ no injection (today's behavior).
   * The injected clock is MONOTONIC (advances a fixed 1ms per read) rather than
   * truly frozen, so a synchronous wall-clock busy-wait still terminates; reads
   * stay deterministic because a deterministic render's call sequence is itself
   * deterministic. Defensive: the injected shim is wrapped in try/catch so a
   * hostile or already-patched environment can never break the render. OPT-IN only.
   */
  randomSeed?: string;
}

export interface CaptureResult {
  screenshotPath: string;
  videoPath?: string;
  errorMessage?: string;
  /** URLs the rendered component requested that no MSW handler matched. */
  unmatchedUrls: string[];
  /**
   * Structured form of `unmatchedUrls`: each unmatched request plus the
   * fabricated body the fallback answered, so diagnostics can offer a
   * paste-ready handler stub. Deduped by `method url`.
   */
  unmatchedRequests: UnmatchedRequest[];
  /**
   * Where this render's data came from (A4) — folded from the in-page mock
   * request log: any declared handler hit ⇒ `declared-mock`, any permissive/
   * unmatched fallback ⇒ `proxy-fallback`. Best-effort, display-only; absent
   * when the render produced no classifiable traffic (URL mode, no requests).
   */
  dataProvenance?: DataProvenance[];
  /** `console.error` calls fired during the render. Capped at 25. */
  consoleErrors: ConsoleErrorEntry[];
  /** Uncaught exceptions that escaped React's error boundaries. Capped at 25. */
  pageErrors: PageErrorEntry[];
  /** 4xx/5xx responses (excluding HMR/asset chatter). Capped at 25. */
  networkErrors: NetworkErrorEntry[];
  /** Axe-core violations (severity ≥ floor). Empty when a11y is off or clean. */
  a11yViolations: A11yViolation[];
  /** Mechanical hard/property verdicts when `criteriaChecks` was supplied. */
  criterionVerdicts?: CriterionVerdict[];
  /**
   * Performance metrics folded from the sandbox's React Profiler + Navigation/
   * Paint Timing (`window.__VALIDITY_GET_PERF__`). Undefined when the page had
   * no perf instrumentation (older sandbox) or the read failed.
   */
  performance?: PerformanceMetrics;
  /**
   * True when `screenshotShortCircuit` fired and the full-page screenshot was
   * deliberately not taken (render errored / all mechanical verdicts failed and
   * no soft criterion needed the pixels). `screenshotPath` then points at a file
   * that was never written — callers must not assume it exists. Absent/false ⇒
   * the screenshot was taken as usual.
   */
  screenshotSkipped?: boolean;
  /**
   * Present only when INTERACTIVE checks (click/fill) ran: the pristine
   * pre-interaction state, captured before the check loop mutated the page.
   * The evidence screenshot (`screenshotPath`) deliberately stays the
   * post-interaction end state (baseline identity, "success banner" checks);
   * this companion shot exists so soft criteria about the INITIAL state can
   * be scored against what the user first sees. Mirrors the native capture.
   */
  preInteractionScreenshotPath?: string;
}

export interface BrowserSession {
  browser: Browser;
  /** @deprecated use a per-call context instead — kept for legacy callers. */
  context: BrowserContext;
  close: () => Promise<void>;
}

export async function launchBrowser(
  opts: {
    videosDir?: string;
    viewport?: { width: number; height: number };
  } = {},
): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    recordVideo: opts.videosDir ? { dir: opts.videosDir } : undefined,
  });
  return {
    browser,
    context,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const POST_READY_NETWORKIDLE_TIMEOUT_MS = 5_000;
const POST_READY_SETTLE_MS = 200;
const DEFAULT_PLAY_TIMEOUT_MS = 10_000;
const POST_PLAY_SETTLE_MS = 100;

/**
 * Capture one (component × scenario) render in a fresh BrowserContext to
 * isolate cookies/localStorage from sibling renders.
 *
 * Wait strategy:
 *   1. `waitUntil: 'load'` — get past initial paint, but don't depend on
 *      networkidle (long-poll components prevent it from firing).
 *   2. waitForFunction(`data-validity-ready` || `data-validity-error`) — the
 *      sandbox's entry.tsx sets `data-validity-ready` after the first React
 *      commit AND a microtask tick (so initial-effect fetches register first).
 *   3. Soft post-ready settle: `waitForLoadState('networkidle', 5s).catch()`
 *      so components that fetch on mount have their data resolve before the
 *      shot, but a perpetual setInterval doesn't hang the run.
 *   4. 200ms paint settle.
 */
export async function captureComponent(
  session: BrowserSession,
  args: CaptureArgs,
): Promise<CaptureResult> {
  if (!existsSync(args.screenshotsDir)) {
    mkdirSync(args.screenshotsDir, { recursive: true });
  }

  // Fresh context per render → no cookie / storage bleed between scenarios.
  // initScript runs before any page script, so storage seeding lands before
  // even the React bundle parses.
  const context = await session.browser.newContext({
    viewport: args.viewport ?? { width: 1280, height: 800 },
    // Force prefers-color-scheme so media-query / Tailwind `media` themed apps
    // flip; the entry's class/attr + wrapper prop cover the other strategies.
    ...(args.colorScheme ? { colorScheme: args.colorScheme } : {}),
  });

  try {
    if (args.cookies && Object.keys(args.cookies).length > 0) {
      const url = new URL(args.devServerUrl);
      const cookieEntries = Object.entries(args.cookies).map(([name, value]) => ({
        name,
        value,
        domain: url.hostname,
        path: '/',
        // 127.0.0.1 / localhost over http — `secure: false` is required.
        secure: url.protocol === 'https:',
        sameSite: 'Lax' as const,
      }));
      await context.addCookies(cookieEntries);
    }

    if (
      (args.localStorage && Object.keys(args.localStorage).length > 0) ||
      (args.sessionStorage && Object.keys(args.sessionStorage).length > 0)
    ) {
      // Context init scripts also run in foreign frames, popups and redirects.
      // Seed only the target origin, before its first page script reads storage.
      const seed = {
        localStorage: args.localStorage ?? {},
        sessionStorage: args.sessionStorage ?? {},
      };
      await context.addInitScript(`
        (function () {
          try {
            if (location.origin !== ${JSON.stringify(new URL(args.devServerUrl).origin)}) return;
            var seed = ${JSON.stringify(seed)};
            for (var k in seed.localStorage) localStorage.setItem(k, seed.localStorage[k]);
            for (var k2 in seed.sessionStorage) sessionStorage.setItem(k2, seed.sessionStorage[k2]);
          } catch (_) { /* private mode etc. — ignore */ }
        })();
      `);
    }

    // Determinism seed (opt-in). Installs a seeded PRNG over `Math.random` plus
    // a monotonic seed-derived clock so renders that touch randomness or the wall
    // clock are stable across runs (e.g. a "generate id" or "show current time"
    // component). Runs as an initScript BEFORE any page/user script so the very
    // first read already sees the deterministic values. Everything is wrapped in
    // try/catch: a failure to patch must never break a render, it only forfeits
    // determinism. OPT-IN — no injection at all when `randomSeed` is unset, so
    // today's default behavior is byte-identical.
    if (args.randomSeed) {
      await context.addInitScript(`
        (function () {
          try {
            var seedStr = ${JSON.stringify(args.randomSeed)};
            // FNV-1a 32-bit hash of the seed string → a uint32 used both as the
            // PRNG state and to derive a stable frozen epoch.
            var h = 2166136261 >>> 0;
            for (var i = 0; i < seedStr.length; i++) {
              h ^= seedStr.charCodeAt(i);
              h = Math.imul(h, 16777619) >>> 0;
            }
            // mulberry32 — small, fast, well-distributed PRNG seeded from the hash.
            var state = h >>> 0;
            Math.random = function () {
              state = (state + 0x6d2b79f5) | 0;
              var t = Math.imul(state ^ (state >>> 15), 1 | state);
              t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
              return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            // Seed the clock from a fixed epoch derived from the seed, then
            // advance it by a fixed 1ms per read (MONOTONIC, not frozen). A
            // monotonic clock keeps reads deterministic (the call sequence of a
            // deterministic render is itself deterministic) while letting a
            // synchronous wall-clock busy-wait — \`while (Date.now() < start + ms)\`
            // — actually terminate instead of spinning until the render watchdog
            // times out. We override Date.now() and the no-arg \`new Date()\` only;
            // argument'd Date construction (parsing, explicit y/m/d) delegates to
            // the real Date so date math still works.
            var clock = 1700000000000 + (h % 1000000000);
            var tick = function () { var t = clock; clock += 1; return t; };
            var _Date = Date;
            function FixedDate() {
              if (arguments.length === 0) return new _Date(tick());
              // Delegate to the real Date constructor with the provided args.
              var args = Array.prototype.slice.call(arguments);
              return new (Function.prototype.bind.apply(_Date, [null].concat(args)))();
            }
            FixedDate.prototype = _Date.prototype;
            FixedDate.now = function () { return tick(); };
            FixedDate.parse = _Date.parse;
            FixedDate.UTC = _Date.UTC;
            // eslint-disable-next-line no-global-assign
            Date = FixedDate;
          } catch (_) { /* already patched / locked-down env — forfeit determinism */ }
        })();
      `);
    }

    const page = await context.newPage();
    // Attach BEFORE navigation so an error that fires during the initial
    // module-load (or pre-React script tags) is captured.
    const diag = attachDiagnostics(page);
    const params = new URLSearchParams({ component: args.componentPath });
    if (args.propsId) params.set('propsId', args.propsId);
    if (args.scenarioId) params.set('scenario', args.scenarioId);
    if (args.fixtureId) params.set('fixture', args.fixtureId);
    if (args.stackedFixtureIds && args.stackedFixtureIds.length > 0) {
      params.set('fixtures', args.stackedFixtureIds.join(','));
    }
    if (args.colorScheme) params.set('theme', args.colorScheme);
    if (args.dataState) params.set('dataState', args.dataState);
    const url = `${args.devServerUrl}/?${params.toString()}`;

    const screenshotPath = resolve(
      args.screenshotsDir,
      `${args.componentId}__${args.variantSlug}.png`,
    );
    let errorMessage: string | undefined;
    let unmatchedUrls: string[] = [];
    let unmatchedRequests: UnmatchedRequest[] = [];
    let dataProvenance: DataProvenance[] | undefined;
    let a11yViolations: A11yViolation[] = [];
    let criterionVerdicts: CriterionVerdict[] | undefined;
    let preInteractionScreenshotPath: string | undefined;
    let performanceMetrics: PerformanceMetrics | undefined;
    let screenshotSkipped = false;

    // A module the sandbox needs (wrapper.user.tsx, a provider it imports)
    // that fails Vite's transform comes back as an HTTP 500 — the entry never
    // evaluates, neither ready nor error attribute ever fires, and the wait
    // below would burn its full timeout PER RENDER with an opaque message.
    // Detect the 500 and fail immediately with Vite's own error text.
    let moduleLoadFailure: string | null = null;
    let signalModuleFailure: (() => void) | undefined;
    const moduleFailureFired = new Promise<void>((res) => {
      signalModuleFailure = res;
    });
    const isModuleUrl = (u: string): boolean =>
      u.startsWith(args.devServerUrl) &&
      (u.includes('/@fs/') || /\.(tsx|ts|jsx|mjs|js|css)(\?|$)/.test(u.split('?')[0] ?? ''));
    const onResponse = (resp: Response): void => {
      if (moduleLoadFailure !== null || resp.status() !== 500 || !isModuleUrl(resp.url())) return;
      resp
        .text()
        .then((body) => {
          const firstLine =
            body
              .split('\n')
              .find((l) => l.trim().length > 0)
              ?.trim() ?? '';
          moduleLoadFailure =
            `sandbox module failed to compile (HTTP 500): ${resp.url()}` +
            (firstLine ? `\n${firstLine.slice(0, 300)}` : '');
          signalModuleFailure?.();
        })
        .catch(() => {
          moduleLoadFailure = `sandbox module failed to compile (HTTP 500): ${resp.url()}`;
          signalModuleFailure?.();
        });
    };
    page.on('response', onResponse);

    try {
      await page.goto(url, { waitUntil: 'load', timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS });

      await Promise.race([
        page.waitForFunction(
          () => {
            return (
              document.documentElement.hasAttribute('data-validity-ready') ||
              document.querySelector('[data-validity-error="true"]') !== null
            );
          },
          undefined,
          { timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS },
        ),
        moduleFailureFired.then(() => {
          throw new Error(moduleLoadFailure ?? 'sandbox module failed to compile (HTTP 500)');
        }),
      ]);
      // Ready fired — a post-ready 500 (broken lazy chunk) stays a console
      // diagnostic instead of aborting a render that already mounted.
      page.off('response', onResponse);

      // Drain pending fetches that started during mount (data hydration etc.),
      // bounded so a perpetual interval doesn't block the shot. Skipped under
      // forced 'loading' — requests hang by design, so the settle would always
      // burn its full timeout for nothing.
      if (args.dataState !== 'loading') {
        await page
          .waitForLoadState('networkidle', { timeout: POST_READY_NETWORKIDLE_TIMEOUT_MS })
          .catch(() => {});
      }

      await page.waitForTimeout(POST_READY_SETTLE_MS);

      // Run the play function before the screenshot, if provided.
      // Bounded by playTimeoutMs (default 10s) so a buggy or slow play
      // doesn't hang the whole verify. If play throws or times out, we
      // record the error and still take a screenshot of whatever state
      // the page is in — so the user can see what went wrong.
      if (typeof args.play === 'function') {
        const playTimeout = args.playTimeoutMs ?? DEFAULT_PLAY_TIMEOUT_MS;
        try {
          await Promise.race([
            Promise.resolve(args.play({ page: page as unknown })),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`play function exceeded ${playTimeout}ms`)),
                playTimeout,
              ),
            ),
          ]);
          // Brief paint settle after play actions so the screenshot
          // captures their effect.
          await page.waitForTimeout(POST_PLAY_SETTLE_MS);
        } catch (err) {
          // We deliberately don't re-check `data-validity-error` here —
          // a play function failure is a Validity-orchestration error, not
          // a render error from the user's component tree. Tag it clearly.
          errorMessage = `play function: ${(err as Error).message}`;
        }
      }

      // The early-error trap may have surfaced a render error during the
      // play step (e.g. play action triggered a thrown effect). Re-check
      // here so it's the rendererror message we report, not the play error.
      const errElPostPlay = await page.$('[data-validity-error="true"]');
      if (errElPostPlay) {
        errorMessage = (await errElPostPlay.innerText()).trim();
      }

      // Spec hard/property checks — execute deterministically against the
      // mounted component, AFTER play and BEFORE the screenshot, so the shot
      // captures the post-interaction end state (e.g. a "Message sent"
      // success banner). A failure inside the executor is infra noise, not a
      // render error: never let it abort the capture.
      //
      // Spec checks run with screenshot stubs (the executor emits
      // `unverifiable` for `expect.screenshot` since it has no baseline access).
      // The baseline diff is computed after the screenshot is taken (below),
      // then those screenshot verdicts are upgraded to pass/fail if a baseline
      // exists for the variant.
      if (args.criteriaChecks && args.criteriaChecks.length > 0 && !errorMessage) {
        // Pre-interaction base shot — ONLY when a check will actually mutate
        // the page (click/fill). Assert-only checks leave the page untouched,
        // so the post-interaction evidence shot already IS the base state
        // there. Best-effort: a pre-shot failure never blocks the checks.
        const willInteract = args.criteriaChecks.some((c) =>
          (c.checks ?? []).some((ch) => isClickCheck(ch) || isFillCheck(ch)),
        );
        if (willInteract) {
          const prePath = screenshotPath.replace(/\.png$/i, '') + '.pre-interaction.png';
          try {
            await page.screenshot({ path: prePath, fullPage: true });
            preInteractionScreenshotPath = prePath;
          } catch {
            // companion only — the evidence shot below still rides
          }
        }
        criterionVerdicts = [];
        for (const criterion of args.criteriaChecks) {
          try {
            // Seed the console gate with every console.error observed on the page
            // so far (mount + render + play). Read fresh per criterion so it also
            // reflects errors produced by earlier criteria's interactions.
            const priorConsoleErrors = diag.consoleErrorCount();
            criterionVerdicts.push(
              await runCriterionChecks({
                page,
                criterion,
                baseUrl: args.devServerUrl,
                priorConsoleErrors,
              }),
            );
          } catch (err) {
            criterionVerdicts.push({
              id: criterion.id,
              tier: criterion.tier,
              status: 'unverifiable',
              detail: `check executor error: ${(err as Error).message.split('\n')[0]}`,
            });
          }
        }
      }

      // Run axe-core after play (so the rendered state includes interactions)
      // but before the screenshot (keeps order deterministic). Failures here
      // never short-circuit the capture — a11y is observational signal, not
      // a gate.
      a11yViolations = await runAxe(page, args.a11ySeverity ?? 'serious');

      // Loop cost control (opt-in). Skip the full-page screenshot only when the
      // caller asked for the short-circuit AND no soft criterion needs the pixels
      // AND the render is already definitively red — i.e. it errored, or it ran
      // mechanical (hard/property) checks and EVERY one of them failed. We never
      // skip when the hard checks pass (a green render is always captured) and
      // never skip when there are no mechanical verdicts to stand on (so a plain
      // visual render keeps its shot). When skipped, `screenshotPath` is left
      // pointing at an un-written file and the baseline-upgrade block below
      // no-ops. Default (`screenshotShortCircuit` unset) preserves today's
      // behavior exactly: the screenshot is always taken.
      const mechanicalVerdicts = (criterionVerdicts ?? []).filter((v) => v.tier !== 'soft');
      const allMechanicalFailed =
        mechanicalVerdicts.length > 0 && mechanicalVerdicts.every((v) => v.status === 'fail');
      const renderIsRed = Boolean(errorMessage) || allMechanicalFailed;
      if (args.screenshotShortCircuit && args.softCriteriaNeedRender === false && renderIsRed) {
        screenshotSkipped = true;
      } else {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }

      // Upgrade `expect.screenshot` verdicts now that the shot exists. The
      // executor stubbed them `unverifiable` (no baseline access); compare the
      // just-captured screenshot against the established baseline and resolve
      // each screenshot verdict to pass/fail vs. its `maxDiffPixels` threshold.
      // Skipped entirely when no baseline exists (diff undefined) or the
      // criterion has no screenshot checks — those verdicts stay unverifiable.
      // Best-effort: a baseline-read failure leaves the stub in place, never a
      // silent pass.
      if (!screenshotSkipped && criterionVerdicts && args.projectRoot) {
        for (const verdict of criterionVerdicts) {
          if (!verdict.checks) continue;
          const hasScreenshotCheck = verdict.checks.some(
            (c) => 'expect' in c.check && c.check.expect.screenshot !== undefined,
          );
          if (!hasScreenshotCheck) continue;
          const diff = diffAgainstBaseline({
            projectRoot: args.projectRoot,
            componentId: args.componentId,
            variantSlug: args.variantSlug,
            newScreenshotPath: screenshotPath,
            screenshotsDir: args.screenshotsDir,
          });
          if (diff) {
            verdict.checks = evaluateScreenshotExpects(verdict.checks, diff);
            // Re-fold, but keep a network-taint demotion STICKY — a passing
            // screenshot must never launder a tainted-network pass back to pass.
            // See refoldAfterScreenshot (security-critical).
            verdict.status = refoldAfterScreenshot({
              networkTainted: verdict.networkTainted,
              evidenceTaints: verdict.evidenceTaints,
              checks: verdict.checks,
            });
          }
        }
      }

      // Read unmatched URLs AFTER the screenshot so any post-paint fetches
      // are also captured. No DOM impact, no race with React state.
      try {
        unmatchedUrls = await page.evaluate(() => {
          const list = (window as unknown as { __VALIDITY_UNMATCHED__?: string[] })
            .__VALIDITY_UNMATCHED__;
          return Array.isArray(list) ? Array.from(new Set(list)) : [];
        });
      } catch {
        unmatchedUrls = [];
      }

      // Structured unmatched requests + fabricated bodies (paste-ready-stub
      // source). Deduped by `method url` so a repeated endpoint yields one stub;
      // the first occurrence wins (it carries the body). Same post-screenshot
      // timing — the in-page body reads (clone .text()) have long resolved.
      try {
        unmatchedRequests = await page.evaluate(() => {
          const list = (
            window as unknown as {
              __VALIDITY_UNMATCHED_REQUESTS__?: Array<{
                method: string;
                url: string;
                body?: unknown;
              }>;
            }
          ).__VALIDITY_UNMATCHED_REQUESTS__;
          if (!Array.isArray(list)) return [];
          const seen = new Set<string>();
          const out: Array<{ method: string; url: string; body?: unknown }> = [];
          for (const r of list) {
            if (!r || typeof r.method !== 'string' || typeof r.url !== 'string') continue;
            const key = r.method + ' ' + r.url;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ method: r.method, url: r.url, body: r.body });
          }
          return out;
        });
      } catch {
        unmatchedRequests = [];
      }

      // Fold the render's whole request log into a data-provenance summary
      // (declared-mock / proxy-fallback). Same post-screenshot timing as the
      // unmatched read; display-only — a failure here never affects verdicts.
      try {
        dataProvenance = deriveRenderDataProvenance(await readInPageRequests(page));
      } catch {
        dataProvenance = undefined;
      }

      // Read perf metrics last — after play + checks, so update/re-render
      // durations include any interaction-driven commits. Folded in-page by
      // __VALIDITY_GET_PERF__ (Profiler commits + Navigation/Paint Timing).
      try {
        const perf = await page.evaluate(() => {
          const get = (
            window as unknown as { __VALIDITY_GET_PERF__?: () => Record<string, number> }
          ).__VALIDITY_GET_PERF__;
          return typeof get === 'function' ? get() : null;
        });
        if (perf && typeof perf === 'object' && Object.keys(perf).length > 0) {
          performanceMetrics = perf as PerformanceMetrics;
        }
      } catch {
        performanceMetrics = undefined;
      }
    } catch (err) {
      errorMessage = (err as Error).message;
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch {
        // ignore
      }
    }

    let videoPath: string | undefined;
    try {
      const v = page.video();
      if (v) videoPath = await v.path();
    } catch {
      // ignore
    }

    // Snapshot diagnostics BEFORE closing the page — the listeners stop
    // firing once the page is gone, and we want the post-screenshot tail
    // of console/network activity included.
    const diagnostics = diag.snapshot();

    await page.close();

    return {
      screenshotPath,
      videoPath,
      errorMessage,
      unmatchedUrls,
      unmatchedRequests,
      dataProvenance,
      consoleErrors: diagnostics.consoleErrors,
      pageErrors: diagnostics.pageErrors,
      networkErrors: diagnostics.networkErrors,
      a11yViolations,
      criterionVerdicts,
      performance: performanceMetrics,
      // Only surface when actually skipped — undefined keeps the field absent on
      // the common (screenshot-taken) path.
      screenshotSkipped: screenshotSkipped ? true : undefined,
      preInteractionScreenshotPath,
    };
  } finally {
    await context.close();
  }
}
