import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import type {
  ComponentRender,
  CriterionVerdict,
  DataProvenance,
  DataState,
  MockNetworkConfig,
  RenderResult,
  RunEnvironment,
  SpecCriterion,
  ValidityConfig,
  ViewportSpec,
} from '@validity.ai/verify-spec';
import { collectGitInfo, EXPO_WEB_OPT_IN_HINT } from '@validity.ai/verify-spec';
import { detectFramework, assertSupportedFramework } from './detect.js';
import { prepareSandbox, writePropsFile } from './prepare.js';
import { propsFile } from './paths.js';
import { prepareExpoWeb } from './prepare-expo-web.js';
import { startDevServer, type DevServer } from './server.js';
import { launchBrowser, captureComponent, type BrowserSession } from './capture.js';
import { diffAgainstBaseline, confirmBaseline } from './baselines.js';
import { readLiveBrowseLock } from './browse/lock.js';

/**
 * Best-effort: tell a reused browse server to invalidate the cached transform
 * of the sandbox entry modules so it serves this run's re-prepared entry.tsx
 * instead of a stale one (see the `/__validity/api/invalidate` handler in
 * server.ts for why this is necessary). Failures are swallowed: an older browse
 * server without the endpoint returns 404 (fetch still resolves), and a network
 * hiccup must not fail the verify — worst case we degrade to the prior
 * possibly-stale behavior rather than crashing.
 */
async function invalidateReusedSandbox(baseUrl: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(`${baseUrl}/__validity/api/invalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    });
  } catch {
    /* best-effort — see docstring */
  } finally {
    clearTimeout(timer);
  }
}

/** Filename-safe slug used to namespace screenshots per scenario / fixture. */
export function slugifySegment(input: string | undefined, fallback = 'base'): string {
  if (!input) return fallback;
  return (
    input
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || fallback
  );
}

/**
 * Per-run-scoped props id (W4 #12). Props are written to the SHARED
 * `node_modules/.validity/props/<id>.json` tree and fetched by id from the dev
 * server, so an id that's identical across runs (the old
 * `componentId__variantSlug`) lets two concurrent verifies of the SAME
 * component+variant with DIFFERENT props clobber each other's file — one run
 * then screenshots the other's props and a false regression is folded. Scoping
 * the id with THIS run's directory name (the `runs/<runId>/` dir that owns
 * `screenshotsDir`) makes every run's props files disjoint. Falls back to a
 * content hash of `screenshotsDir` when the dir layout is unexpected, so the id
 * is still per-run-unique. Deterministic for a given (run, component, variant)
 * so a retried capture within the same run reuses the same file.
 */
export function runScopedPropsId(
  screenshotsDir: string,
  componentId: string,
  variantSlug: string,
): string {
  // Slug with an EMPTY fallback so a dir name that carries no usable run id
  // (`.`, `/`, pure punctuation) reads as empty here rather than collapsing to
  // the shared 'base' sentinel — which would re-merge every such run onto one
  // id. Only then do we reach for the content hash.
  const runSlug = slugifySegment(basename(dirname(screenshotsDir)), '');
  const runToken =
    runSlug || createHash('sha256').update(screenshotsDir).digest('hex').slice(0, 12);
  return `${runToken}__${componentId}__${variantSlug}`;
}

/**
 * Composite slug for a (scenario, fixture, viewport) tuple. Used as the
 * screenshot filename suffix and as a stable identifier when flagging
 * identical renders or keying baselines. Examples:
 *   (undefined, undefined, undefined)    → 'base'
 *   ('logged-in', undefined, undefined)  → 'logged-in'
 *   (undefined, 'primary', undefined)    → 'primary'
 *   ('logged-in', 'primary', undefined)  → 'logged-in__primary'
 *   ('logged-in', 'primary', 'mobile')   → 'logged-in__primary__mobile'
 *
 * Viewport is only appended when set, so the default desktop render path
 * keeps its existing filenames (and existing baselines stay matched).
 */
export function renderVariantSlug(
  scenarioId: string | undefined,
  fixtureId: string | undefined,
  viewportName?: string,
  colorScheme?: string,
  dataState?: string,
): string {
  const parts: string[] = [];
  if (scenarioId || fixtureId) {
    if (scenarioId && fixtureId) {
      parts.push(`${slugifySegment(scenarioId)}__${slugifySegment(fixtureId)}`);
    } else if (fixtureId) {
      parts.push(slugifySegment(fixtureId));
    } else {
      parts.push(slugifySegment(scenarioId));
    }
  } else {
    parts.push('base');
  }
  if (viewportName) parts.push(slugifySegment(viewportName));
  // Theme last, only when set — so single-theme renders keep their existing
  // filenames (and baselines stay matched).
  if (colorScheme) parts.push(slugifySegment(colorScheme));
  // Forced data state after theme, only when set — populated/natural renders
  // keep byte-identical slugs (and baselines); forced clones mint NEW keys
  // like `base__data-empty`.
  if (dataState) parts.push(`data-${slugifySegment(dataState)}`);
  return parts.join('__');
}

/**
 * Heuristic: a truly empty PNG (1280×800, all-uniform background, no
 * visible content) compresses to ~2-3 KB. A small but legitimate
 * standalone component — a single button, a label + input — comes in
 * around 5-8 KB. We pick 4 KB as the threshold: aggressive enough to
 * catch the "agent forgot to add fixtures, component rendered with
 * default `{}` props and shows nothing" case, conservative enough to
 * avoid nagging on small-but-real components.
 */
const EMPTY_RENDER_BYTE_THRESHOLD = 4_000;

function looksEmptyByFileSize(path: string): boolean {
  try {
    const buf = readFileSync(path);
    return buf.byteLength < EMPTY_RENDER_BYTE_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Whether a render may be ESTABLISHED as the first baseline for its variant.
 * "Didn't error" is too weak to bless as ground truth: a blank shot or a
 * render with a failing mechanical (hard/property) verdict is demonstrably
 * wrong, and baking its pixels as the baseline turns a broken first render into
 * a permanent `expect.screenshot` PASS (nothing to diff against ⇒ 0 mismatch)
 * until a human re-baselines. Soft verdicts never gate — they're the agent's
 * judgment, scored later, not a statement about pixel correctness.
 */
export function renderIsBaselineWorthy(args: {
  verdicts?: CriterionVerdict[];
  looksEmpty: boolean;
}): boolean {
  if (args.looksEmpty) return false;
  return !(args.verdicts ?? []).some((v) => v.tier !== 'soft' && v.status === 'fail');
}

function sha256OfFile(path: string): string | undefined {
  try {
    const buf = readFileSync(path);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * After all renders complete, mark byte-identical screenshots within the
 * same component. The first occurrence keeps a clean slate; subsequent
 * identical renders get `identicalTo` pointing at the first render's
 * variant slug. Cross-component duplicates are NOT flagged — different
 * components legitimately can render to the same pixels (e.g., both
 * empty), and the noise would outweigh the signal.
 */
function annotateIdenticalRenders(results: ComponentRender[]): void {
  const byComponent = new Map<string, ComponentRender[]>();
  for (const r of results) {
    const arr = byComponent.get(r.id) ?? [];
    arr.push(r);
    byComponent.set(r.id, arr);
  }
  for (const renders of byComponent.values()) {
    if (renders.length < 2) continue;
    const seen = new Map<string, ComponentRender>();
    for (const r of renders) {
      if (r.renderError || !existsSync(r.screenshotPath)) continue;
      const hash = sha256OfFile(r.screenshotPath);
      if (!hash) continue;
      const first = seen.get(hash);
      if (first) {
        // Include the first render's dataState so e.g. an `empty` clone that
        // renders byte-identical to the base points at the right variant —
        // the report's `identicalTo` hint is how "this component has no empty
        // branch" surfaces.
        r.identicalTo = renderVariantSlug(
          first.scenarioId,
          first.fixtureId,
          undefined,
          undefined,
          first.dataState,
        );
      } else {
        seen.set(hash, r);
      }
    }
  }
}

/**
 * Merge a scenario's mockNetwork on top of the base config:
 *   - cookies / localStorage / sessionStorage merge by key (scenario wins)
 *   - handlers concatenate with the scenario's first (so it wins on URL match)
 *   - fallback replaces base's fallback when the scenario sets one
 */
export function mergeMockNetwork(
  base: MockNetworkConfig | undefined,
  scenario: MockNetworkConfig | undefined,
): MockNetworkConfig {
  if (!base && !scenario) return {};
  if (!scenario) return base!;
  if (!base) return scenario;
  return {
    fallback: scenario.fallback ?? base.fallback,
    handlers: [...(scenario.handlers ?? []), ...(base.handlers ?? [])],
    cookies: { ...(base.cookies ?? {}), ...(scenario.cookies ?? {}) },
    localStorage: { ...(base.localStorage ?? {}), ...(scenario.localStorage ?? {}) },
    sessionStorage: { ...(base.sessionStorage ?? {}), ...(scenario.sessionStorage ?? {}) },
  };
}

/**
 * Display-only provenance fold for a render's persisted `ComponentRender`
 * (A2): a forced clone's data came from the dataState axis BY CONSTRUCTION,
 * so `'dataState-forced'` is always appended — after whatever the request-log
 * fold classified (A4) — and an unforced render passes the capture's
 * classification through untouched (absent stays absent, keeping natural
 * run-metas byte-identical).
 */
export function foldRenderDataProvenance(
  dataState: DataState | undefined,
  captured: DataProvenance[] | undefined,
): DataProvenance[] | undefined {
  return dataState ? [...(captured ?? []), 'dataState-forced'] : captured;
}

export interface RenderRequest {
  componentAbsolutePath: string;
  componentId: string;
  props?: Record<string, unknown>;
  /** Scenario id this render runs under. `undefined` = base render. */
  scenarioId?: string;
  /** Fixture id this render runs under (when the component has fixtures). */
  fixtureId?: string;
  /**
   * Composed play function — runs after the component mounts, before the
   * screenshot. Receives a Playwright `Page`. See @validity.ai/verify-spec's
   * `PlayFunction`.
   */
  play?: (args: { page: unknown }) => Promise<void> | void;
  /**
   * Stacked-fixture mode: render every named fixture as a sibling on the
   * same page, capture one screenshot of all of them. Mutually exclusive
   * with `props`/`fixtureId`. Set when prepareVerification decides a
   * component's fixtures can be stacked.
   */
  stackedFixtureIds?: string[];
  /**
   * Viewport this render is captured at. Undefined → default 1280×800 with
   * no viewport suffix in the slug; explicitly set → its name becomes a
   * slug segment so e.g. `logged-in__primary__mobile` doesn't collide
   * with `logged-in__primary__desktop`.
   */
  viewport?: ViewportSpec;
  /**
   * Color scheme (theme) to render under. Undefined → the wrapper's default
   * theme (no slug suffix). When set, forces Playwright `colorScheme` + the
   * documentElement `dark` class and appends a theme segment to the slug so
   * light/dark land in distinct screenshots + baselines.
   */
  colorScheme?: 'light' | 'dark';
  /**
   * Data state to FORCE for this render (A2). Sent to entry.tsx as
   * `?dataState=` where the in-page MSW layer overrides every non-internal
   * request (loading hangs / empty / error). Appends a `data-<state>` slug
   * segment so forced clones mint their own screenshots + baselines;
   * undefined = the natural (populated) pipeline with unchanged filenames.
   */
  dataState?: DataState;
  /**
   * Spec hard/property criteria to execute deterministically against this
   * render (after play, before screenshot). Set by prepareVerification on the
   * canonical base render of a spec's target component. Verdicts come back on
   * `ComponentRender.criterionVerdicts`.
   */
  criteriaChecks?: SpecCriterion[];
  /**
   * Loop cost control — whether any soft criterion needs this render's
   * screenshot for host scoring. Set by prepareVerification: `false` only when
   * the spec has zero soft criteria (so a red render can skip the screenshot);
   * `true`/undefined ⇒ never skip (screenshots are evidence). Forwarded to
   * `captureComponent.softCriteriaNeedRender`.
   */
  softCriteriaNeedRender?: boolean;
}

export interface RenderRunArgs {
  projectRoot: string;
  config: ValidityConfig;
  screenshotsDir: string;
  videosDir?: string;
  components: RenderRequest[];
  viewport?: { width: number; height: number };
}

/**
 * Assemble the session's {@link RunEnvironment}. PURE, and exported so the
 * shape can be pinned without booting a browser.
 *
 * Optional facts are OMITTED rather than set to a falsy placeholder. That is
 * the honest encoding: on the `reused-browse` path the app-manifest merge and
 * the dep pre-scan both happened in another process, so absence there means
 * "could not observe", and an empty string would read as "observed nothing
 * wrong" — the exact false-green this codebase refuses.
 */
export function buildRunEnvironment(args: {
  target: RunEnvironment['target'];
  /** True when the renders were served by a running `validity browse` server. */
  reusedBrowseServer: boolean;
  tailwindShim: boolean;
  appManifest?: string;
  depScanFailure?: string;
}): RunEnvironment {
  return {
    target: args.target,
    devServer: args.reusedBrowseServer ? 'reused-browse' : 'cold',
    tailwindShim: args.tailwindShim,
    ...(args.appManifest ? { appManifest: args.appManifest } : {}),
    ...(args.depScanFailure ? { depScanFailure: args.depScanFailure } : {}),
  };
}

/**
 * Render every requested (component × variant) and return them alongside ONE
 * {@link RunEnvironment} describing the session they were captured in.
 *
 * The environment channel exists because a render session has facts that are
 * true of the SESSION, not of any element: which toolchain was resolved, whose
 * dev server served the modules, what the app manifest contributed, whether the
 * dependency pre-scan survived. Those used to have nowhere to live, so
 * `depScanFailure` was copied onto every `ComponentRender` and consumers
 * recovered the single string with a `find()` across the array. One session,
 * one record — see `RenderResult` in @validity.ai/verify-spec.
 */
export async function renderComponents(args: RenderRunArgs): Promise<RenderResult> {
  // Resolve target toolchain. `auto` consults detectFramework; the
  // explicit `vite` / `expo-web` / `next` values trust the user. The
  // resolved value drives both the prepare path (which entry.tsx to write)
  // and the Vite server config (which aliases to install). Next.js reuses
  // the standard web prepare path (client components are plain React
  // rendered via createRoot); the `next/*` aliases are wired in server.ts.
  const target = resolveTarget(args.config.framework, args.projectRoot);

  const prepared =
    target === 'expo-web'
      ? prepareExpoWeb(args.projectRoot, args.config)
      : prepareSandbox(args.projectRoot, args.config);

  // Reuse a running `validity browse` server if one exists. The lock
  // file lives at `node_modules/.validity/.browse.lock` and carries the
  // port we should hit; we treat the running server as a black-box
  // backend and don't tear it down at the end of this verify. Lets the
  // user iterate in their browser tab without paying a cold-Vite cost
  // on every agent verify.
  const liveLock = readLiveBrowseLock(args.projectRoot);
  const dev:
    | DevServer
    | {
        url: string;
        close: () => Promise<void>;
        fatalError: Promise<never>;
        depScanFailure: () => string | undefined;
        appManifest?: string;
      } = liveLock
    ? {
        url: `http://127.0.0.1:${liveLock.port}`,
        // No-op close — the browse server owns its own lifecycle.
        close: async () => {},
        // The reused browse server runs in another process; we can't observe
        // its optimizer from here. A never-settling promise makes the
        // fatalError race below a no-op for this path (the browse server
        // surfaces its own optimize failures in its own terminal), and its
        // dep pre-scan state is equally unobservable — undefined, not "ok".
        fatalError: new Promise<never>(() => {}),
        depScanFailure: () => undefined,
        // Same reasoning for the app-manifest merge: it happened at THAT
        // server's boot, in another process. Absent, not "nothing mirrored".
        appManifest: undefined,
      }
    : await startDevServer(args.projectRoot, {
        target,
        // Verify deliberately does NOT pass `config` (that field is the
        // browse-mode API switch), so the app-manifest opt-out has to be
        // threaded explicitly or a user who set it would be ignored here.
        useAppManifest: args.config.web?.useAppManifest,
      });

  // Reuse path only: the prepareSandbox above rewrote entry.tsx with this
  // run's freshly-baked handlers, but the reused server lives in another
  // process and its Vite watcher ignores node_modules/.validity — so its
  // module graph would serve the *previous* run's transform. Ask it to drop
  // the cached entry modules before we navigate. Cold-boot servers (the else
  // branch) transform the just-written entry on first request, so they skip
  // this. (The freshly-booted server's own entry is current.)
  if (liveLock) {
    await invalidateReusedSandbox(dev.url);
  }

  let session: BrowserSession | null = null;
  const results: ComponentRender[] = [];

  // Per-run props namespace (W4 #12). Props are written to the SHARED
  // `node_modules/.validity/props/` tree and fetched by id from the dev server.
  // The old id (`componentId__variantSlug`) is identical across runs, so a
  // watch tick and an MCP verify hitting the SAME component+variant with
  // DIFFERENT props clobber each other's file → one run screenshots the other's
  // props → a false regression is folded. Prefixing with this run's id (the
  // runs/<runId>/ dir that owns screenshotsDir) makes every run's props files
  // disjoint. The files are deleted in the finally below so the shared dir
  // doesn't accumulate. entry.tsx just fetches whatever id is in the URL, so no
  // sandbox-side change is needed. Falls back to a hash of screenshotsDir if the
  // dir layout is ever unexpected, so the id is still per-run-unique.
  const writtenPropsIds: string[] = [];

  try {
    session = await launchBrowser({
      videosDir: args.videosDir,
      viewport: args.viewport,
    });

    // Capture git SHA up front so every baseline promoted in this run
    // carries the same `sha` stamp.
    const gitInfo = collectGitInfo(args.projectRoot);
    // Resolve a11y severity once. `off` short-circuits the axe pass.
    const a11ySeverity = args.config.a11y?.severity ?? 'serious';

    for (const req of args.components) {
      const projectRel = relative(args.projectRoot, req.componentAbsolutePath).replaceAll(
        '\\',
        '/',
      );

      // Resolve the network state for this (component × scenario) render.
      // The handlers themselves are interpreted in the browser by the
      // sandbox's entry.tsx (via @mswjs/interceptors); only cookies and
      // storage are passed to Playwright here for pre-navigation seeding.
      const scenarioCfg = req.scenarioId
        ? args.config.scenarios?.[req.scenarioId]?.mockNetwork
        : undefined;
      const mockNetwork = mergeMockNetwork(args.config.mockNetwork, scenarioCfg);

      // Stacked-fixture mode is a wholly separate axis: no per-fixture URL
      // params, no /props/<id>.json fetch, just a `?fixtures=name1,name2`
      // marker that entry.tsx unrolls against the injected fixtures map.
      const isStacked = req.stackedFixtureIds && req.stackedFixtureIds.length > 0;
      const baseSlug = isStacked ? 'stacked' : renderVariantSlug(req.scenarioId, req.fixtureId);
      let variantSlug = req.viewport
        ? `${baseSlug}__${slugifySegment(req.viewport.name)}`
        : baseSlug;
      // Theme segment last, only when the color-scheme axis is active — so
      // single-theme renders keep their existing filenames + baselines.
      if (req.colorScheme) variantSlug = `${variantSlug}__${slugifySegment(req.colorScheme)}`;
      // Forced data-state segment after theme (mirrors renderVariantSlug):
      // natural renders keep byte-identical slugs; clones mint new keys.
      if (req.dataState && req.dataState !== 'populated') {
        variantSlug = `${variantSlug}__data-${slugifySegment(req.dataState)}`;
      }
      const variantPropsId = runScopedPropsId(args.screenshotsDir, req.componentId, variantSlug);
      const havingProps = !isStacked && req.props && Object.keys(req.props).length > 0;
      if (havingProps) {
        writePropsFile(args.projectRoot, variantPropsId, req.props!);
        writtenPropsIds.push(variantPropsId);
      }

      // Capture viewport: per-request beats run-wide. Default to Playwright's
      // 1280×800 if neither is set.
      const captureViewport = req.viewport
        ? { width: req.viewport.width, height: req.viewport.height }
        : args.viewport;

      const capturePromise = captureComponent(session, {
        devServerUrl: dev.url,
        componentPath: projectRel,
        propsId: havingProps ? variantPropsId : undefined,
        componentId: req.componentId,
        scenarioId: req.scenarioId,
        fixtureId: req.fixtureId,
        stackedFixtureIds: req.stackedFixtureIds,
        variantSlug,
        screenshotsDir: args.screenshotsDir,
        viewport: captureViewport,
        colorScheme: req.colorScheme,
        dataState: req.dataState,
        cookies: mockNetwork.cookies,
        localStorage: mockNetwork.localStorage,
        sessionStorage: mockNetwork.sessionStorage,
        play: req.play,
        a11ySeverity,
        criteriaChecks: req.criteriaChecks,
        projectRoot: args.projectRoot,
        // Loop cost control: let capture skip the screenshot on a definitively
        // red render. prepareVerification sets `req.softCriteriaNeedRender`
        // false ONLY when the spec has zero soft criteria (no pixels needed for
        // host scoring); it's true/undefined otherwise, so the skip stays
        // locked and behavior is unchanged whenever any screenshot is evidence.
        screenshotShortCircuit: true,
        softCriteriaNeedRender: req.softCriteriaNeedRender ?? true,
        // Determinism (opt-in). Only injects when VALIDITY_RANDOM_SEED is set;
        // unset ⇒ undefined ⇒ no injection ⇒ today's behavior. (No spec hash is
        // in scope at this layer, so we don't fall back to one here.)
        randomSeed: process.env.VALIDITY_RANDOM_SEED,
      });

      // Race against fatalError so a doomed dep-optimize (esbuild pre-bundle
      // failure — e.g. Flow-typed RN core) aborts the whole verify in seconds
      // with the real error, instead of this capture (and every one after it)
      // burning its full 30s timeout against a server that will never finish
      // optimizing. Non-fatal path: fatalError never settles, so this is a
      // plain await of the capture.
      //
      // Guard the loser: if fatalError wins, capturePromise is left pending and
      // may later reject (e.g. its 30s goto timeout) with no consumer — attach a
      // noop catch so that late rejection can't surface as an unhandledRejection.
      // The race attaches its own handler independently, so a real capture
      // rejection still propagates.
      capturePromise.catch(() => {});
      const capture = await Promise.race([dev.fatalError, capturePromise]);

      // Baseline diff vs. the established baseline. Computed BEFORE we write
      // any baseline so the diff is against the prior snapshot, not the one we
      // just took. The render layer only *confirms* (writes) a baseline on the
      // FIRST clean render of a variant — subsequent renders skip the write and
      // diff against that established baseline. Re-baselining an existing
      // variant is reserved for `validity accept` (which overwrites). This
      // keeps render-and-iterate working (diffs accumulate against a stable
      // baseline) without the render layer ever clobbering an accepted one.
      // A skipped screenshot (loop cost control on a definitively-red render)
      // has no file on disk — treat it exactly like a render error here: never
      // diff against or establish a baseline from a shot that doesn't exist.
      let baselineMeta: ComponentRender['baseline'] | undefined;
      if (!capture.errorMessage && !capture.screenshotSkipped) {
        const diff = diffAgainstBaseline({
          projectRoot: args.projectRoot,
          componentId: req.componentId,
          variantSlug,
          newScreenshotPath: capture.screenshotPath,
          screenshotsDir: args.screenshotsDir,
        });
        if (diff) {
          baselineMeta = {
            sha: gitInfo?.sha,
            takenAt: diff.takenAt,
            diffPath: diff.diffPath,
            mismatchedPixels: diff.mismatchedPixels,
          };
        }
        // Establish the baseline on the first TRUSTWORTHY render only (no-op
        // when one already exists — the diff above ran against it). "Clean"
        // above means only "didn't throw / wasn't skipped", which is too weak
        // to bless as ground truth: a blank shot or a render with a FAILING
        // mechanical check is demonstrably wrong, and baking its pixels as the
        // baseline turns a broken first render into a permanent `expect.
        // screenshot` PASS (nothing to diff against ⇒ 0 mismatch) until a human
        // re-baselines. Refuse in those cases so `expect.screenshot` stays
        // `unverifiable` until a good render (or `validity accept`) sets the
        // baseline — never a false green off an unvalidated snapshot.
        if (
          renderIsBaselineWorthy({
            verdicts: capture.criterionVerdicts,
            looksEmpty: looksEmptyByFileSize(capture.screenshotPath),
          })
        ) {
          confirmBaseline({
            projectRoot: args.projectRoot,
            componentId: req.componentId,
            variantSlug,
            screenshotPath: capture.screenshotPath,
          });
        }
      }

      results.push({
        id: req.componentId,
        filePath: req.componentAbsolutePath,
        screenshotPath: capture.screenshotPath,
        videoPath: capture.videoPath,
        renderError: capture.errorMessage,
        screenshotSkipped: capture.screenshotSkipped || undefined,
        scenarioId: req.scenarioId,
        fixtureId: req.fixtureId,
        stackedFixtureIds: req.stackedFixtureIds,
        dataState: req.dataState,
        unmatchedUrls: capture.unmatchedUrls,
        unmatchedRequests:
          capture.unmatchedRequests.length > 0 ? capture.unmatchedRequests : undefined,
        dataProvenance: foldRenderDataProvenance(req.dataState, capture.dataProvenance),
        looksEmpty:
          !capture.errorMessage &&
          !capture.screenshotSkipped &&
          looksEmptyByFileSize(capture.screenshotPath),
        consoleErrors: capture.consoleErrors.length > 0 ? capture.consoleErrors : undefined,
        pageErrors: capture.pageErrors.length > 0 ? capture.pageErrors : undefined,
        networkErrors: capture.networkErrors.length > 0 ? capture.networkErrors : undefined,
        viewport: req.viewport,
        baseline: baselineMeta,
        a11yViolations:
          capture.a11yViolations && capture.a11yViolations.length > 0
            ? capture.a11yViolations
            : undefined,
        criterionVerdicts: capture.criterionVerdicts,
        performance: capture.performance,
        // Pristine pre-interaction shot (present only when click/fill checks
        // mutated this render's page) — companion evidence for initial-state
        // soft criteria; the evidence shot stays post-interaction.
        preInteractionScreenshotPath: capture.preInteractionScreenshotPath,
        // Measured on the PRE shot itself, never inherited from `looksEmpty`:
        // the two frames can disagree in both directions (a click that
        // navigates away blanks the post shot; one that renders a list blanks
        // only the pre). The citation gate needs the pre frame's own answer.
        preInteractionLooksEmpty: capture.preInteractionScreenshotPath
          ? looksEmptyByFileSize(capture.preInteractionScreenshotPath)
          : undefined,
      });
    }
  } finally {
    if (session) await session.close();
    await dev.close();
    // Drop this run's props files from the shared dir (W4 #12) — they're
    // consumed at capture time and never read again, so leaving them would let
    // the per-run namespacing grow node_modules/.validity/props/ unbounded.
    // Best-effort: a missing/locked file is harmless.
    for (const id of writtenPropsIds) {
      try {
        rmSync(propsFile(args.projectRoot, id), { force: true });
      } catch {
        /* non-fatal — stray props JSON is inert and overwritten next run */
      }
    }
  }

  // Cross-render annotations: identical screenshots, only flagged within
  // the same component (cross-component byte-equality is mostly noise).
  annotateIdenticalRenders(results);

  // The session's environment record. Assembled AFTER the loop and after
  // `dev.close()`, for two reasons:
  //
  //   - the dep pre-scan fails ASYNCHRONOUSLY around listen(), so reading it
  //     any earlier could miss a failure that lands mid-session (this is why
  //     the old per-render stamping also happened here, not at push time);
  //   - both values are plain state captured by the DevServer closure, so
  //     closing the server does not invalidate them.
  //
  // One aborted scan destabilizes the WHOLE session's module graph (any capture
  // may have raced a re-optimize reload that swapped the React instance), and
  // nothing can attribute which renders were corrupted — which is exactly why
  // it is a session fact rather than a per-render one. run.ts turns it into a
  // demoting `dep-scan` evidence taint across every verdict, unchanged.
  const environment = buildRunEnvironment({
    target,
    reusedBrowseServer: Boolean(liveLock),
    tailwindShim: prepared.tailwindShim,
    appManifest: dev.appManifest,
    depScanFailure: dev.depScanFailure(),
  });

  return { renders: results, environment };
}

export function projectRelative(projectRoot: string, abs: string): string {
  return relative(projectRoot, abs).replaceAll('\\', '/');
}

export function absoluteFromProject(projectRoot: string, rel: string): string {
  return resolve(projectRoot, rel);
}

/**
 * Thrown when a web render is asked for on a React Native / Expo project that
 * never opted into the `react-native-web` proxy. Exported so callers (the MCP
 * verify dispatcher, `validity browse`) can recognise the condition and route
 * to the device instead of surfacing a raw failure.
 */
export class ExpoWebNotRequestedError extends Error {
  readonly code = 'EXPO_WEB_NOT_REQUESTED';
  constructor(message: string) {
    super(message);
    this.name = 'ExpoWebNotRequestedError';
  }
}

/**
 * Resolve the user's `framework` config (or `'auto'`) to one of the two
 * concrete prepare targets Validity ships today: `'web'` (Vite +
 * react-dom), `'expo-web'` (Vite + react-native-web), or `'next-web'`
 * (Vite + react-dom + `next/*` aliases).
 *
 *   `'vite'`             — always 'web', regardless of detection.
 *   `'expo-web'`         — always 'expo-web' (the explicit opt-in).
 *   `'expo-native'`      — THROWS. The project is pinned to the device; a web
 *                          render would silently validate a different runtime.
 *   `'next'`/`'next-web'`— always 'next-web' (the web prepare path plus
 *                          the `next/*` alias map wired in server.ts).
 *   `'auto'`             — runs `detectFramework()` and
 *                          assertSupportedFramework(). Maps detected
 *                          'next' → 'next-web', 'vite' → 'web', and
 *                          **refuses** detected 'expo' (see below).
 *
 * `auto` deliberately does NOT map Expo → Expo Web. React Native's real
 * runtime is the device; `react-native-web` composes onto DOM nodes and so
 * proves something adjacent to, but not the same as, the shipped app. Picking
 * it automatically is how a "verified" report ends up describing a runtime
 * nobody asked about — so an Expo project must either pin
 * `framework: 'expo-web'` or be validated natively.
 *
 * Throws when `auto` resolves to an unsupported framework (unknown). The
 * web target is the safe fallback when detection comes back unsupported
 * but the user pinned `framework: 'vite'`.
 */
export function resolveTarget(
  framework: ValidityConfig['framework'],
  projectRoot: string,
): 'web' | 'expo-web' | 'next-web' {
  if (framework === 'expo-web') return 'expo-web';
  if (framework === 'vite') return 'web';
  if (framework === 'next' || framework === 'next-web') return 'next-web';
  if (framework === 'expo-native') {
    throw new ExpoWebNotRequestedError(
      "This project is pinned to native (`framework: 'expo-native'` in .validity/config.ts), " +
        'so it cannot be rendered in the web sandbox. Validate it on a simulator/emulator: ' +
        '`validity browse --native <Component>` or `validity__verify({ native: true })`. ' +
        EXPO_WEB_OPT_IN_HINT,
    );
  }
  // auto
  const detected = detectFramework(projectRoot);
  assertSupportedFramework(detected);
  if (detected === 'expo') {
    throw new ExpoWebNotRequestedError(
      'This is a React Native / Expo project, so its real runtime is a simulator/emulator — ' +
        'Validity will not quietly render it through react-native-web instead. ' +
        'Validate it natively: `validity browse --native <Component>` or ' +
        '`validity__verify({ native: true })`. ' +
        EXPO_WEB_OPT_IN_HINT,
    );
  }
  if (detected === 'next') return 'next-web';
  return 'web'; // vite
}
