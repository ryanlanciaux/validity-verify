/**
 * Locked types — do not change without an explicit orchestrator instruction.
 * See BUILD_PLAN.md → "Locked interfaces".
 */
import type { CriterionVerdict, DataState } from './spec-schema.js';

/**
 * How Validity renders the user's components.
 *
 * - `'web'` — the original path. Components (incl. Expo Web via
 *   `react-native-web`) render in Validity's Vite sandbox and are
 *   screenshotted with Playwright.
 * - `'native'` — the React Native playground: one component/screen is
 *   mounted in a separate registered root on a real Expo Go / dev-client /
 *   emulator (Phase A is the manual + agent-driven playground; automated
 *   capture is via agent-device (Callstack). Network/nav/auth are
 *   mocked in the harness; native modules run for real on the device.
 */
export type RenderMode = 'web' | 'native';

/**
 * Framework selection. `'auto'` runs `detectFramework()` against the
 * project root; the explicit values skip detection and assume the named
 * toolchain. `'expo-web'` shares the `'web'` render mode but aliases
 * `react-native` → `react-native-web`; `'expo-native'` is the
 * native-playground path (renderMode `'native'`). `'next'`/`'next-web'`
 * route to the standard `'web'` render path with `next/*` imports aliased
 * to DOM-friendly stubs (Pages Router + `'use client'` App Router only;
 * Server Components / Route Handlers / Middleware are out of scope).
 */
export type Framework = 'vite' | 'next' | 'next-web' | 'expo-web' | 'expo-native' | 'auto';

export type DetectedFramework = 'vite' | 'next' | 'expo' | 'unknown';

export interface MockHandler {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  status?: number;
  body?: unknown;
}

export interface ValidityMocks {
  auth?: {
    user: Record<string, unknown>;
  };
  api?: 'auto' | MockHandler[];
}

/** A single network handler matched against fetch/XHR requests in the sandbox. */
export interface MockNetworkHandler {
  /**
   * URL pattern to match. Supports:
   *   - exact path: '/api/me'
   *   - exact url:  'https://example.test/api/me'
   *   - prefix:     '/api/*' (single asterisk wildcard)
   * Only the path is matched when no protocol/host is present (matches any host).
   */
  url: string;
  /** HTTP method. Default: any. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | '*';
  /** Response status. Default: 200. */
  status?: number;
  /** JSON body (object/array/primitive). Mutually exclusive with `text`. */
  json?: unknown;
  /** Plain text body. Mutually exclusive with `json`. */
  text?: string;
  /** Optional response headers. Content-Type is auto-set from json/text. */
  headers?: Record<string, string>;
}

/**
 * Network-mocking config. Applied to every isolation render unless a scenario
 * overrides parts of it. Implemented in the browser via @mswjs/interceptors,
 * so requests are intercepted at the `fetch` / `XMLHttpRequest` level — no
 * service worker, no SW handshake.
 */
export interface MockNetworkConfig {
  /**
   * Behavior for requests that match no handler.
   *   'permissive' — respond 200 with an empty shape-correct body (`[]` for
   *                  list-ish URLs, `{}` otherwise). Components fetching unknown
   *                  URLs don't crash the render. Default.
   *   'populate'   — respond 200 with a synthetic POPULATED body: an array of
   *                  sample items for list-ish URLs, a synthetic RSS document
   *                  for feed URLs, a single sample object otherwise. Use this
   *                  so list/feed screens render real-looking content (and their
   *                  populated UI is verifiable) instead of their empty state.
   *   'reject'     — respond 599. Forces the user to mock everything explicitly.
   *   { status, json/text, headers } — custom fallback response.
   */
  fallback?: 'permissive' | 'populate' | 'reject' | MockHandlerResponse;
  /** Handlers tried in order; first match wins. */
  handlers?: MockNetworkHandler[];
  /** Cookies seeded via Playwright before navigation. Map name → value. */
  cookies?: Record<string, string>;
  /** localStorage seeded via Playwright initScript before any page script runs. */
  localStorage?: Record<string, string>;
  /** sessionStorage seeded the same way. */
  sessionStorage?: Record<string, string>;
  /**
   * AsyncStorage seed for the React Native playground (renderMode 'native').
   * The RN analog of `localStorage` — the native harness writes these
   * key/value pairs into `@react-native-async-storage/async-storage` before
   * mounting the target, so an auth gate that reads a token from AsyncStorage
   * sees it. Ignored in web mode.
   */
  asyncStorage?: Record<string, string>;
}

export interface MockHandlerResponse {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/**
 * Optional play function that runs after the component mounts (and after
 * any post-ready settle) but BEFORE the screenshot. Receives a Playwright
 * `Page` so the function can drive the DOM — fill inputs, click buttons,
 * focus elements — to land on a state that requires interaction (e.g.,
 * a form showing validation errors after a failed submit).
 *
 * Capped at 10s. Errors / timeouts are surfaced as `render error: play
 * function …` in the verify response.
 *
 * Typed as `unknown` here because the Page type lives in Playwright,
 * which isn't a dep of @validity.ai/verify-spec. Sandbox callers cast appropriately.
 */
export type PlayFunction = (args: { page: unknown }) => Promise<void> | void;

/**
 * Viewport spec for a scenario. Pass a preset name for `mobile = 375×667`,
 * `tablet = 768×1024`, `desktop = 1280×800`, or an inline `{ width, height,
 * name }` object for a custom size. The `name` becomes a slug segment in
 * the screenshot filename so the multi-viewport renders don't collide.
 */
export type ViewportPreset = 'mobile' | 'tablet' | 'desktop';
export interface ViewportSpec {
  width: number;
  height: number;
  name: string;
}
export type ViewportInput = ViewportPreset | ViewportSpec;

/**
 * Built-in viewport presets. The default desktop size matches the Playwright
 * launch default we already use (1280×800), so omitting `viewports` keeps
 * the existing single-render behavior with the same dimensions.
 */
export const VIEWPORT_PRESETS: Record<ViewportPreset, ViewportSpec> = {
  mobile: { width: 375, height: 667, name: 'mobile' },
  tablet: { width: 768, height: 1024, name: 'tablet' },
  desktop: { width: 1280, height: 800, name: 'desktop' },
};

/** Normalize either a preset key or an inline viewport spec to a `ViewportSpec`. */
export function resolveViewport(input: ViewportInput): ViewportSpec {
  if (typeof input === 'string') return VIEWPORT_PRESETS[input];
  return input;
}

/** A named scenario — a partial mockNetwork override applied on top of the base. */
export interface ScenarioConfig {
  /** Human-readable description, surfaced to the agent. */
  description?: string;
  /**
   * Network overrides for this scenario. Handlers are concatenated with
   * scenario-level entries tried first (so they win on URL conflicts).
   * cookies / localStorage / sessionStorage merge by key (scenario wins).
   * fallback replaces the base fallback when set.
   */
  mockNetwork?: MockNetworkConfig;
  /**
   * Optional play function — runs once per render under this scenario,
   * before the screenshot. Use to drive the rendered output into a state
   * that needs interaction (open a menu, submit a form, focus a field).
   * If a fixture-level play is also defined, scenario play runs first.
   */
  play?: PlayFunction;
  /**
   * Optional list of viewports to render this scenario under. When set,
   * each viewport becomes its own (component × scenario × fixture × viewport)
   * render. Counts against the pair cap. Use the preset name strings or pass
   * inline `{ width, height, name }`. Undefined / empty → single 1280×800
   * render as before.
   */
  viewports?: ViewportInput[];
  /**
   * Native-only scenario seeds. `context` is a flat overlay applied to the
   * native companion's auto-mocked React contexts (the deep-default proxy that
   * lets `useAuth()`/`useTheme()` render in isolation): a consumer reading
   * `useAuth().isAuthenticated` gets the seeded value instead of the heuristic
   * default. Built-in `logged-in` / `logged-out` scenarios ship sensible
   * auth-shaped seeds out of the box; declaring `native.context` here OVERRIDES
   * or extends them per app. Ignored by the web sandbox.
   */
  native?: {
    context?: Record<string, unknown>;
  };
  /** Data-population state to force for renders under this scenario (A2). */
  dataState?: DataState;
  /**
   * Values this scenario treats as SECRETS — never written to disk in the
   * clear (native `.ad` replay recordings, run evidence, printed notices).
   *
   * Each entry declares a replay VARIABLE name; the live value is read from
   * the environment at run time and never from this file. A recorded `fill`
   * whose value is a secret publishes as the `${NAME}` placeholder
   * (`agent-device fill … --record-as NAME`), and `validity replay` supplies
   * the value back with `-e NAME=<value>`. A secret that could not be
   * represented as a placeholder FAILS CLOSED: the recording is abandoned
   * rather than published with the literal in it.
   *
   * Purely additive and opt-in: a config without `secrets` behaves exactly as
   * it did before this existed.
   */
  secrets?: ScenarioSecretConfig[];
}

/**
 * One declared secret. The string form is shorthand for
 * `{ name: X, env: X }` — the common case where the replay variable and the
 * environment variable share a name.
 *
 * There is deliberately NO `value` field: a secret that can be written in
 * `.validity/config.ts` is a secret committed to the repository, and the whole
 * point of this surface is that the literal never lands on disk.
 */
export type ScenarioSecretConfig = string | ScenarioSecret;

export interface ScenarioSecret {
  /**
   * The replay variable name — what appears in the `.ad` as `${NAME}` and what
   * `validity replay` forwards as `-e NAME=…`. Upper-snake by convention;
   * non-conforming names are normalized at the call site.
   */
  name: string;
  /** Environment variable the live value is read from. Defaults to `name`. */
  env?: string;
}

/**
 * Named fixture for a component — a specific set of props (and optional
 * play function) that drives the component into a known visual state.
 * Use fixtures to render the same component under "primary / loading /
 * disabled" or "empty / with-value / with-error" without writing a story
 * file. When a component has fixtures, Validity renders one screenshot per
 * fixture instead of one screenshot under each requested scenario.
 */
export interface ComponentFixture {
  /** Human-readable description shown alongside the fixture name. */
  description?: string;
  /** Props passed to the component. */
  props?: Record<string, unknown>;
  /** Optional interaction step — see PlayFunction. */
  play?: PlayFunction;
}

/**
 * Per-spec run-artifact retention, enforced automatically after every watch
 * tick (and shared with the dashboard's bake-on-demand persist decision).
 * Counts are RUNS PER SPEC, newest-first; the newest run always keeps its
 * artifacts (counts clamp to ≥1) so "the last run" is always inspectable.
 *
 * What retention NEVER touches: `run-meta.json` and each spec's `runs.jsonl`
 * timeline — the run HISTORY stays complete, "spec hasn't been run since …"
 * stays honest, and any pruned run can still be opened on the dashboard (the
 * run view re-bakes from run-meta; without raw screenshots it renders the
 * verdicts/reasoning imageless). Whole-directory pruning stays with
 * `validity clean`.
 */
export interface RetentionConfig {
  /**
   * Runs (per spec) that keep their raw `screenshots/` + `judge-pack/` +
   * `videos/`. Older runs lose them. Baked report.html files are
   * self-contained (base64-inlined), so a run inside the `reports` window
   * stays fully viewable even after its raw images are pruned.
   * Default: unlimited.
   */
  images?: number;
  /**
   * Runs (per spec) that keep their baked `report.html`. Older runs lose it;
   * clicking one on the dashboard re-bakes transiently from run-meta WITHOUT
   * re-persisting (a click must not refill the disk). Default: unlimited.
   */
  reports?: number;
}

/**
 * HTML report config. After every `validity__verify` call, the agent calls
 * `validity__submit_report` with its verdict and per-file notes; Validity
 * writes a self-contained HTML file to the run directory that the user can
 * open via `npx http-server <runDir>`.
 *
 * Default: `{ enabled: true, brand: 'validity' }` — opt out by setting
 * `report: false` (or `{ enabled: false }`).
 */
export interface ReportConfig {
  /** When false, `submit_report` becomes a no-op. Default: true. */
  enabled?: boolean;
  /** Whether to render the Validity wordmark in the report header. Default: 'validity'. */
  brand?: 'validity' | 'none';
  /**
   * Whether a mechanical sweep (`validity verify --all`) bakes a per-run
   * report.html. Default: true. Set false to skip the bake (~1MB per run
   * dir) without disabling MCP verify/judge reports.
   */
  watchReports?: boolean;
}

export interface ComponentEntry {
  /** Default props. Used when no fixtures are defined and the component is rendered "as-is." */
  props?: Record<string, unknown>;
  /**
   * Named fixtures. When present, Validity renders one screenshot per
   * fixture (instead of fanning out across the requested scenarios for
   * this component). Use this to validate component states like
   * primary/loading/disabled or empty/with-value/with-error.
   */
  fixtures?: Record<string, ComponentFixture>;
  /**
   * Allow-list of scenario ids that apply to this component. The
   * `validity browse` toolbar uses this to filter the Scenario dropdown
   * so a user picking a component only sees scenarios that are relevant
   * to it. When undefined, every scenario in the global `scenarios` map
   * is offered (back-compat). When set to an empty array, the dropdown
   * is hidden for this component. Verify behaviour is unaffected —
   * verify still renders against whatever scenarios you pass on the
   * tool call.
   */
  scenarios?: string[];
}

/**
 * A user-pinned screen entry. Screens are surfaced in `validity browse`
 * as a separate canvas section above components and participate in the
 * navigation graph (flow arrows). Most screens are auto-discovered from
 * Next.js conventions / filename heuristics (see `discoverScreenFiles`);
 * use this entry to pin a screen explicitly or override its `routePath`
 * for non-conventional file layouts.
 *
 * Shape mirrors ComponentEntry — props/fixtures behave identically. The
 * `routePath` field is the only screen-specific addition and is used to
 * resolve navigation edges (`<Link to="/foo">` → which screen file).
 */
export interface ScreenEntry {
  /** Default props (rare for full screens, common for screens that take a route param). */
  props?: Record<string, unknown>;
  /** Named fixtures — same semantics as ComponentEntry. */
  fixtures?: Record<string, ComponentFixture>;
  /** Per-screen scenario allow-list — see ComponentEntry.scenarios. */
  scenarios?: string[];
  /**
   * Route path this screen serves. Drives navigation-edge resolution in
   * the browse canvas. Auto-derived for Next.js conventions (App Router's
   * `page.tsx`, Pages Router's `pages/...`); set explicitly here for other
   * file layouts. Format: `/users/:id` style (Express-ish).
   */
  routePath?: string;
}

/**
 * Controls automatic re-runs when `runVerification` produces a non-pass verdict.
 * Capped server-side at `MAX_RETRY_ATTEMPTS_HARD_LIMIT` so a buggy config can't
 * burn unlimited Anthropic tokens.
 */
export interface RetryOnFailureConfig {
  /** Total attempts including the first run. 1 = no retry. Default: 1. */
  maxAttempts: number;
  /** Retry on a `partial` verdict in addition to `fail`. Default: false. */
  retryOnPartial?: boolean;
}

/**
 * A11y check config. Validity runs axe-core after the play function and
 * before the screenshot, filters to violations at or above the severity
 * floor, and surfaces them in the verify tool result + HTML report.
 *
 * Default: `{ severity: 'serious' }` — both `serious` and `critical` count.
 * Set `severity: 'critical'` to filter out serious-only failures, or
 * `severity: 'off'` to skip axe entirely (saves ~200ms per render).
 */
export interface A11yConfig {
  /**
   * Lowest impact to surface. `serious` (default) surfaces both `serious` and
   * `critical`. `off` disables the axe pass entirely.
   */
  severity?: 'serious' | 'critical' | 'off';
}

/**
 * Web-sandbox config (renderMode `'web'`). Optional — the sandbox has working
 * defaults for everything here. Ignored entirely in native mode.
 */
export interface WebConfig {
  /**
   * Consume `.validity/app-manifest.json` when it exists (written by the
   * `@validity.ai/verify-plugin-vite` Vite plugin from inside the user's REAL build).
   *
   * Default: ON whenever the file exists — installing the plugin IS the opt-in,
   * so requiring a second flag would just be a footgun. Set `false` to make the
   * sandbox ignore a present manifest and fall back to inferring the app's
   * setup, which is the right move when a manifest is suspected stale or wrong.
   *
   * What the manifest changes when consumed: `envDir` (so `import.meta.env.VITE_*`
   * is populated the way the real app sees it), `envPrefix`, the PostCSS config
   * path, and resolved aliases the sandbox's static config read couldn't see.
   * Everything else in the manifest is recorded as provenance only.
   */
  useAppManifest?: boolean;
}

/**
 * React Native playground config (renderMode `'native'`). Optional — the
 * native harness has sensible defaults. Only consulted when rendering on a
 * device/emulator; ignored entirely in web mode.
 */
export interface NativeConfig {
  /**
   * Custom URL scheme for the VALIDITY COMPANION APP's cold-open deep links
   * (`<scheme>://validity?component=…` mounts a target in the companion).
   * Unset, the companion derives a companion-unique default
   * (`defaultCompanionScheme` in prepare-native-app.ts) — which is what you
   * want: do NOT set this to your own app's scheme. Two installed apps
   * registering one scheme makes iOS route deep links nondeterministically,
   * and the flow would screenshot the wrong app. Your app's OWN scheme
   * (needed for `.ad` journeys/dev-client opens) is guaranteed separately —
   * by `@validity.ai/verify-plugin-expo`, or by your existing Expo config.
   * Falls back to the Expo Go `exp://` form when unset AND no companion
   * exists (pure-JS components only).
   */
  scheme?: string;
  /**
   * Preferred device target for the driver / deep-link command.
   *   'android' — adb (open uiautomator; the recommended first target)
   *   'ios'     — xcrun simctl (macOS + Xcode required)
   *   'expo-go' — Expo Go over exp:// (pure-JS components only)
   */
  target?: 'ios' | 'android' | 'expo-go';
  /**
   * Path to the app's real root component, for the harness to optionally
   * compose its providers around the target. The harness swaps the
   * registered root; this is a reference, not the mount point.
   */
  appEntry?: string;
  /**
   * Custom fonts to load before mounting (the native analog of web's
   * `@font-face`). Native loads fonts at runtime, and the companion has its own
   * root, so without these isolated components fall back to the system font.
   * Validity auto-detects the host's `useFonts`/`Font.loadAsync` map; this
   * OVERRIDES/supplements it when the scan can't reach a font.
   *
   * Key = font family/key the app references in `fontFamily`. Value = a path to
   * the font asset relative to the project root (e.g.
   * `'./assets/fonts/Inter-Regular.ttf'`), or a package/tsconfig-alias spec the
   * companion's Metro can resolve.
   */
  fonts?: Record<string, string>;
  /**
   * Recycle the companion Metro bundler after it has served this many captures,
   * before it can decay.
   *
   * MEASURED BASIS (2026-07-29 isolation run, 18 sweeps against one
   * continuously-running Android emulator): a bundler stops delivering an
   * attachable bundle after roughly 40-50 device opens past its last restart —
   * every navigate is still acked, the RN root never attaches, and it does not
   * recover on its own. Restarting Metro is the only intervention that ever
   * recovered it, and it recovered it every time. Validity therefore recycles
   * the bundler on its own a full sweep BELOW that cliff.
   *
   * Default: 30 on Android (where the cliff was measured), OFF on iOS (where it
   * was not — an unmeasured 30-90s `--clear` tax per few sweeps is not a fix for
   * a failure nobody has seen there). Set a number to change the threshold or to
   * opt iOS in; set `false` (or 0) to disable the preventive recycle entirely
   * and rely only on the reactive heal that follows a `metro-decayed` diagnosis.
   */
  metroRecycleAfterCaptures?: number | false;
  /**
   * Record each native verify's device session as an agent-device `.ad` replay
   * script (`<run-dir>/replay.ad`), signed into the run's attestation so
   * `validity replay` can re-execute it on a device later.
   *
   * ON by default: the recording is what makes a native run answer "does the
   * claim still hold?" rather than only "are these bytes unmodified?", and a
   * trust feature that is off by default is a trust feature nobody has.
   *
   * The cost is two extra agent-device commands per RUN (not per capture): one
   * selector `wait` for the destination guard and one `session save-script`.
   * Set `false` to skip both — for a device that is behaving badly, or when the
   * `.ad` in the run dir is unwanted. Turning it off changes no verdict; it
   * only removes the artifact, and `validity replay` then reports the run as
   * having nothing to re-execute on-device.
   */
  recordReplay?: boolean;
  /**
   * Drive a REMOTE device through an agent-device remote profile instead of a
   * locally booted simulator/emulator.
   *
   * `configPath` is a path (project-root-relative or absolute) to the profile
   * the USER creates with `agent-device connect …` — the cloud control plane, a
   * direct proxy to a Mac they own, BrowserStack, AWS Device Farm or Limrun.
   * Validity passes it through as `--remote-config <path>` on every
   * agent-device command and holds NO provider knowledge of its own: the
   * credentials, the device selectors and the provider choice all live in that
   * file, which is the user's to write and never Validity's to interpret.
   *
   * Unset (the default) drives the local device exactly as before.
   */
  remote?: {
    /** Path to the agent-device remote profile JSON. */
    configPath: string;
  };
  /**
   * Capture device-side runtime evidence during a native verify — `agent-device
   * perf metrics|frames --json` and `network dump --json`, taken AFTER the
   * interaction phase and written to `<run-dir>/device-evidence.json`.
   *
   * ADVISORY ONLY, and this is load-bearing rather than a disclaimer: nothing
   * reads the file to produce a verdict, a gate, or a score. 0.20.5 made these
   * numbers structured, but no threshold exists to judge them against — a frame
   * time from a debug build on a shared emulator, compared to a constant, is
   * exactly the confident-and-wrong red this codebase refuses to ship. Scoring
   * them needs an N-run variance study first. Every record is stamped
   * `scoring: 'advisory-evidence-only'` in the artifact itself so a reader who
   * finds it out of context cannot mistake evidence for a scored criterion.
   *
   * OFF by default: it costs two extra agent-device spawns per capture, which a
   * `verify --all` sweep would pay per spec. Turn it on for one investigation
   * (a jank report, a suspicion that a mock is leaking to the real network),
   * not as a tax on every run. Turning it on or off changes no verdict either
   * way — it only adds or removes an artifact.
   */
  deviceEvidence?: boolean;
}

/**
 * Named commands referenced by `expect.command` checks (A5). Keys are the names
 * a frozen spec references (`run: 'typecheck'`); values are the shell strings.
 * Keeping the shell string in config (never in the spec) is the supply-chain
 * discipline that lets a frozen spec's hash bind the NAME without ever carrying
 * executable shell.
 */
export interface CommandsConfig {
  typecheck?: string;
  test?: string;
  lint?: string;
  [name: string]: string | undefined;
}

/**
 * Who scores a spec's soft criteria (A6). `self` = the same agent that did the
 * work; `fresh-context` = a separate scoring pass with no build context;
 * `human` = a person signs off; `model` = an automated LLM judge scored the
 * soft criteria blind from the judge-pack (`validity judge`). Drives the
 * judge-pack + the scored-by badge. ADD-ONLY: `model` was appended — existing
 * values keep their meaning and no reader may assume the set is closed at three.
 */
export type JudgeMode = 'self' | 'fresh-context' | 'human' | 'model';

/**
 * Provider configuration for the automated LLM judge (`validity judge`). The
 * model scores a spec's soft criteria from the BLIND judge-pack (rubric +
 * screenshots only — no source, diff, or prompt history), so soft scores no
 * longer depend on the same agent that built the change grading its own work,
 * and CI can score them too.
 *
 * The API key is read from the environment (`apiKeyEnv`, or the provider
 * default) AT CALL TIME — never persisted to disk and never sent anywhere
 * except the user's chosen provider. No Validity server is ever involved in a
 * judge call (hard product rule).
 */
export interface JudgeModelConfig {
  /**
   * Wire protocol. `anthropic` → the Anthropic Messages API; `openai` → the
   * OpenAI Chat Completions API; `openai-compatible` → any OpenAI-shaped
   * endpoint (local model server, gateway, third-party host) — `baseUrl` is
   * then required.
   */
  provider: 'anthropic' | 'openai' | 'openai-compatible';
  /** Model id, e.g. `'claude-3-5-sonnet-latest'` or `'gpt-4o'`. */
  model: string;
  /**
   * Env var holding the API key. Defaults: `ANTHROPIC_API_KEY` for `anthropic`,
   * `OPENAI_API_KEY` otherwise. Read at call time; the key value is never
   * written to config, run-meta, or any Validity surface.
   */
  apiKeyEnv?: string;
  /**
   * API base URL. REQUIRED for `openai-compatible`; ignored for the first-party
   * `anthropic`/`openai` providers (they use their public endpoints).
   */
  baseUrl?: string;
}

/** Scoring config (A6). */
export interface ScoringConfig {
  judge?: JudgeMode;
  /**
   * Provider config for the automated LLM judge (`validity judge` /
   * `verify --all --judge`). When set (and the API key env var is present), the
   * judge scores soft criteria from the blind judge-pack. Absent ⇒ no automated
   * judge; soft criteria are scored by the host agent (or a fresh-context judge).
   */
  judgeModel?: JudgeModelConfig;
}

export interface ValidityConfig {
  renderMode: RenderMode;
  framework: Framework;
  wrapper: string;
  /** @deprecated Pass-through context mocks read by the user's wrapper. Use `mockNetwork` for HTTP. */
  mocks?: ValidityMocks;
  /** Base network mocking applied to every render. */
  mockNetwork?: MockNetworkConfig;
  /**
   * Color schemes (themes) to render every target under. OMITTED (the default)
   * is smart: verify captures BOTH light and dark automatically whenever the
   * spec has a theme-related criterion ("looks right in light and dark", "dark
   * mode", …), and a single default-theme render otherwise — so theme criteria
   * are verifiable with no config and theme-agnostic verifies aren't doubled.
   * Set explicitly to override: `['light','dark']` forces both on EVERY target;
   * a single entry forces that one theme; `[]` forces the axis OFF. Multiplies
   * into the render budget like viewports. Applied via Playwright `colorScheme`
   * + a `dark` class on web and RN `Appearance.setColorScheme` on native, and
   * passed to the wrapper as a `colorScheme` prop so a ThemeProvider can consume it.
   */
  colorSchemes?: Array<'light' | 'dark'>;
  /** Named scenarios — additional renders with overridden network state. */
  scenarios?: Record<string, ScenarioConfig>;
  /** HTML report config. Defaults to `{ enabled: true, brand: 'validity' }`. */
  report?: ReportConfig | boolean;
  /**
   * Per-spec run-artifact retention (see RetentionConfig). Unset = keep
   * everything (today's behavior); `validity clean` remains the manual
   * whole-run-directory pruner.
   */
  retention?: RetentionConfig;
  components?: Record<string, ComponentEntry>;
  /**
   * Screens — page-level components surfaced separately from `components`
   * in `validity browse`. Most are auto-discovered; entries here pin
   * specific files or override their `routePath`. Has no effect on
   * `validity verify` (verify treats screens and components identically).
   */
  screens?: Record<string, ScreenEntry>;
  /**
   * Browse-mode views — named compositions of components rendered together
   * on a single canvas. Authored interactively via the views_* MCP tools or
   * by hand. Has no effect on `validity verify`.
   */
  views?: Record<string, ViewDefinition>;
  retryOnFailure?: RetryOnFailureConfig;
  /** A11y check config. Defaults to `{ severity: 'serious' }`. */
  a11y?: A11yConfig;
  /**
   * Gate applied by `validity__spec_freeze` (and `validity spec freeze`).
   *   'auto'   — freeze freely (default). The agent flow needs no human in the loop.
   *   'never'  — same as auto for freezing; reserved for "specs never lock" policies.
   *   'always' — a spec must be `approved` (set out of band via spec_update) before
   *              freeze succeeds, so a human signs off on the contract first.
   */
  specApproval?: 'always' | 'never' | 'auto';
  /** React Native playground config (renderMode 'native'). Ignored in web mode. */
  native?: NativeConfig;
  /** Web-sandbox config (renderMode 'web'). Ignored in native mode. */
  web?: WebConfig;
  /**
   * Coverage floor gate applied during `verify --all`. When set, the run
   * succeeds (exit code 0) only if hard+property criteria verifiability
   * (pass + fail) / (pass + fail + unverifiable) >= this floor (0–100 percent).
   * Soft criteria are never counted. Not enforced during interactive verify.
   * Default: undefined (no gate). Example: 80 requires at least 80% of
   * hard+property criteria to have mechanical verdicts (pass or fail status).
   */
  coverageFloorPercent?: number;
  /** Named commands for `expect.command` checks (A5). */
  commands?: CommandsConfig;
  /** Command execution timeout in ms (A5). Default 180_000, max 600_000. */
  commandTimeoutMs?: number;
  /**
   * Data-population axis (A2). `undefined` = auto (smart per-spec); `[]` = off;
   * a list forces those data states on every target.
   */
  dataStates?: DataState[];
  /** Scoring config (A6) — `{ judge?: JudgeMode }`. */
  scoring?: ScoringConfig;
  /**
   * Enforcement posture (B1). `strict` gates the loop on frozen specs; absence
   * (or `advisory`) is display-only. Default advisory by absence.
   */
  enforcement?: 'advisory' | 'strict';
  /**
   * Opt-in strict knob (A6/1.5). Default OFF. When true, a blocking SOFT
   * criterion's pass does not count toward `computeSignedOff` if it is
   * `selfScored` (scored in the same session that ran verify, or an unproven
   * judge claim) — it must come from a fresh-context judge or the automated
   * model judge instead. Read at `submit_report` time; never changes a
   * criterion's rendered verdict, only whether it can satisfy sign-off.
   */
  requireFreshJudge?: boolean;
  /**
   * Gates ALL `.validity/history/` writes (F2 spec trends + F1's score.jsonl).
   * Default off — history is opt-in so a watch tick never silently changes repo
   * posture by writing a committed-by-default file.
   */
  historyCommitted?: boolean;
  /** Continuous-watch config (signals-system-design.md). */
  watch?: WatchConfig;
  /**
   * Exported-test inputs (spec maturity ladder, Phase B). These feed the
   * deterministic Playwright/Maestro compilers, so they are recorded in the
   * exports manifest — `spec export --check` classifies a moved input as
   * config drift, never as a hand edit.
   */
  export?: ExportConfig;
  /**
   * Advisory maturity floor (maturity Phase D). When set, `verify --all`
   * WARNS about specs whose derived level sits below this rung after the
   * grace window (e.g. 'team' flags dev specs left unfrozen for >7 days).
   * NEVER a gate — gating on maturity would incentivize deleting specs; the
   * PR-comment census already covers "how much contract exists".
   */
  minimumMaturity?: 'dev' | 'team' | 'certified';
}

/**
 * Inputs to the deterministic spec exporters (`.validity/exports/`).
 * Both are optional; each absence is an honest export warning (`needs-setup`)
 * that blocks certification until wired — an exported test that can't run
 * anywhere must never read as "runnable anywhere".
 */
export interface ExportConfig {
  /** baseURL prepended to exported Playwright `navigate()` targets. */
  baseUrl?: string;
  /** Bundle/package id stamped into exported Maestro flows (`appId:`). */
  appId?: string;
  /** Maestro-specific export knobs (launch preamble, route navigation). */
  maestro?: MaestroExportConfig;
}

/**
 * One step of a Maestro route preamble — how to reach a screen in the REAL
 * installed app (Validity verifies components in isolation; Maestro runs the
 * whole app, so non-launch screens need a navigation path).
 */
export type MaestroRouteStep =
  | { tapOn: string } // tap by visible text
  | { tapOnId: string }; // tap by accessibility id / RN testID

/**
 * Maestro exporter inputs beyond `appId`. All of these change exported flow
 * BYTES, so they are folded into the exports manifest's `inputsHash` — a
 * change here classifies as config drift in `spec export --check`, never as
 * a hand edit.
 */
export interface MaestroExportConfig {
  /**
   * PREVIEW OPT-IN. Maestro export is parked behind this flag: the mapping is
   * structurally lossy (network/console/perf/a11y/command checks cannot be
   * expressed as Maestro steps and degrade to TODO comments) and generated
   * flows have no automated on-device validation harness yet. Off (default),
   * `spec export` refuses native specs with an honest preview notice and the
   * portability badge stays hidden for them. Set `enabled: true` to export
   * anyway — every degradation still warns.
   */
  enabled?: boolean;
  /**
   * Launch the app with `clearState: true` (fresh install state) so flows are
   * deterministic run-to-run. Default true — matches hand-authored flows.
   */
  clearState?: boolean;
  /**
   * Emit conditional taps that dismiss dev-build overlays (Android ANR dialog,
   * expo-dev-client onboarding/menu) after launch. Each guard no-ops on
   * release builds. Default true.
   */
  dismissDevOverlays?: boolean;
  /**
   * Navigation preambles keyed by a spec's `navigate` target (e.g. '/welcome').
   * A string value is a deep link (`myapp://welcome` → `openLink`); an array
   * is a tap sequence executed in order. Without a mapping, a navigate check
   * degrades to a TODO comment and the export warns `needs-setup`.
   */
  routes?: Record<string, string | MaestroRouteStep[]>;
  /**
   * DEFAULT target binding for `spec export --run` (see {@link MaestroRunConfig}).
   * Does not change exported flow bytes — it only says which device the flows
   * are handed to — so it is deliberately NOT part of the exporter inputs above.
   */
  run?: MaestroRunConfig;
}

/**
 * Default target binding for `validity spec export --run`, so a CI job that
 * always runs against the same device does not have to repeat `--platform` on
 * every invocation.
 *
 * PRECEDENCE, per field: an explicit CLI flag always wins; config fills only
 * the fields the command line left unset; unset in both leaves the flag off
 * entirely, which is agent-device's documented "use the active session"
 * default rather than a Validity guess. `platform` and `device` resolve
 * INDEPENDENTLY — the CI shape is a fixed `platform` in config with the runner
 * passing the udid of whichever device it booted.
 *
 * Nothing here can change a verdict: it selects what the flows run against,
 * and the resulting device binding is recorded verbatim on the export run
 * record (`ExportRunRecord.device`), so a reader always sees the target that
 * actually ran, whichever layer named it.
 */
export interface MaestroRunConfig {
  /** `--platform` default: which runtime agent-device binds. */
  platform?: 'ios' | 'android';
  /** `--device` default: a specific simulator udid / adb serial. */
  device?: string;
}

/**
 * The signal kinds the on-signal hook can filter on. Mirrors `SignalKind`
 * in scorecard.ts (duplicated as a literal union so config types don't pull
 * the scorecard module into the schema layer).
 */
export type WatchSignalKind =
  | 'regression'
  | 'unverifiable'
  | 'coverage-drop'
  | 'spec-changed'
  | 'needs-scoring'
  | 'needs-rescoring'
  | 'perf-drift'
  | 'needs-review'
  | 'recovered'
  | 'maturity-drop'
  | 'hardening-candidate'
  | 'judge-gap'
  | 'replay-divergence';

/**
 * Actuation hook (signals-system-design.md, pillar 3): a command the watcher
 * runs when signals newly open. THE way drift-response gets delegated to an
 * agent (or a notifier) without Validity growing sink integrations.
 * Fire-and-forget and advisory forever — hook exit codes never touch
 * verdicts, the scorecard, or `--fail-on-signal`.
 */
export interface OnSignalHookConfig {
  /** Shell command to run. Receives the VALIDITY_* env contract. */
  command: string;
  /**
   * Which kinds trigger a launch. Default:
   * `['regression', 'needs-scoring', 'needs-rescoring']`.
   */
  kinds?: WatchSignalKind[];
  /**
   * Minimum seconds between launches (serialized: never more than one hook
   * process at a time; signals arriving during a run/cooldown coalesce into
   * the next launch). Default 300.
   */
  cooldownSeconds?: number;
}

/** `watch` config block. */
export interface WatchConfig {
  /** Run a command when signals newly open (agent dispatch, notifier, …). */
  onSignal?: OnSignalHookConfig;
}

/**
 * One component to render inside a view, with optional override props
 * (or a fixture name to source props from).
 */
export interface ViewItem {
  /** Project-relative component path. Must resolve to a component file. */
  componentPath: string;
  /** Pick props from `components[componentPath].fixtures[fixtureName]`. */
  fixtureName?: string;
  /** Explicit prop overrides — win over fixture props when both present. */
  props?: Record<string, unknown>;
  /** Optional section header label shown above the rendered item. */
  label?: string;
  /**
   * Optional frame group id. Items sharing a `frame` render together inside
   * one device frame on the canvas; items without a `frame` auto-group by
   * `componentPath` (variants of one component cluster into a single frame,
   * distinct components/screens each get their own frame). Set this to group
   * different components into one frame, or to split one component's items
   * across separate frames.
   */
  frame?: string;
}

/**
 * A named composition of components for browse mode. Lives under
 * `views[name]`. Names share a flat namespace with components and screens;
 * the views API rejects collisions.
 */
export interface ViewDefinition {
  /** Optional display title — defaults to the view name. */
  title?: string;
  description?: string;
  /** Vertical column ('stack', default) or wrapped flex row ('grid'). */
  layout?: 'stack' | 'grid';
  items: ViewItem[];
}

export interface Criterion {
  id: string;
  description: string;
  status: 'pass' | 'fail' | 'unverifiable';
  evidence?: {
    componentId: string;
    screenshotPath: string;
    reasoning: string;
  };
  suggestion?: string;
}

/**
 * A single acceptance criterion captured BEFORE the agent does work.
 * Persisted via `validity__plan` so build-time and verify-time score
 * against the exact same contract instead of re-extracting from the
 * free-form prompt twice (which lets interpretation drift).
 *
 * `observable` is a hint about what kind of evidence resolves the
 * criterion — purely advisory in v1 (the agent still scores visually
 * from screenshots + diagnostics), but reserved for later when verify
 * can dispatch deterministic checks per category.
 */
export interface AcceptanceCriterion {
  /** Stable id, e.g. 'primary-blue', 'a11y-label'. Generated by the agent. */
  id: string;
  /** Human-readable statement of the criterion. */
  description: string;
  /** Hint at what kind of evidence resolves this criterion. Optional. */
  observable?: 'visual' | 'behavioral' | 'console' | 'a11y' | 'network';
}

/**
 * Acceptance criteria captured at intent time, before the agent does
 * work. Written by `validity__plan`, read by `validity__verify` (via
 * `planId`) and `validity__submit_report`. Locks the contract between
 * build and verify; gives the user an audit trail of what the agent
 * was actually validating against.
 *
 * STEERING NOTE — for loop-grade work prefer a FROZEN SPEC over a plan. A spec
 * carries tiered (hard/property/soft) criteria, a content hash that binds the
 * scoring contract, and the lifecycle that makes it immutable once frozen — it
 * is the durable contract the continuous watcher and sign-off gate read. A plan
 * is the lighter, pre-spec capture; its `contentHash` exists ONLY for drift
 * detection (has this plan been edited since it was written?), not as a
 * scoring/sign-off contract.
 */
export interface ValidityPlan {
  /** Stable id assigned by Validity. */
  planId: string;
  /** ISO timestamp of plan creation. */
  createdAt: string;
  /** The user prompt this plan was derived from. Verbatim. */
  prompt: string;
  /** Optional component path the plan targets (project-relative). */
  componentPath?: string;
  /** Optional URL the plan targets (URL-mode verifies). */
  url?: string;
  /** The structured criteria the agent will build + score against. */
  criteria: AcceptanceCriterion[];
  /**
   * sha256 over the plan's content (the hash field itself excluded) + the
   * scoring-contract version. Set by `writePlan` at write time. Used ONLY for
   * tamper/drift detection via `planHashMatches` — NOT a sign-off contract
   * (that is a frozen spec's job). Absent on plans written before this field.
   */
  contentHash?: string;
}

/**
 * One `console.error` call captured during a render. Mirrors Playwright's
 * `ConsoleMessage.location()` shape so the report can hyperlink the source.
 */
export interface ConsoleErrorEntry {
  text: string;
  url?: string;
  lineNumber?: number;
}

/** Uncaught exception / unhandled rejection that escaped React error boundaries. */
export interface PageErrorEntry {
  message: string;
  stack?: string;
}

/** 4xx / 5xx response (filtered to exclude HMR/asset chatter). */
export interface NetworkErrorEntry {
  method: string;
  url: string;
  status: number;
  statusText?: string;
}

/**
 * Performance metrics measured during a web-sandbox render. Captured passively
 * on every render (so the report always shows the numbers) and ALSO consumed by
 * `expect.performance` checks, which budget one metric against a `maxMs`. All
 * fields are optional — a metric is omitted when the runtime can't observe it
 * (e.g. no Paint Timing entry yet, no React commit of that phase, or a native
 * render where on-device timing isn't bridged). Times are milliseconds.
 *
 * The `<metric>Ms` field names line up 1:1 with the `PerformanceMetric` enum in
 * spec-schema.ts (`load`→`loadMs`, …) so the check executor maps `metric` to a
 * field by suffixing `Ms` — keep the two in sync.
 */
export interface PerformanceMetrics {
  /** Full navigation→load timing (Navigation Timing API). */
  loadMs?: number;
  /** First Contentful Paint (Paint Timing API). */
  firstContentfulPaintMs?: number;
  /**
   * Harness-boot→`data-validity-ready`: how long the COMPONENT took to load and
   * reach its first settled commit. Deliberately NOT navigation-relative — the
   * sandbox's own cold start (Vite's first-request transform of the entry module
   * graph, browser JIT, msw install) is subtracted out via `harnessBootMs`.
   *
   * Before that subtraction this was navigation-relative, which made the metric
   * a lie: whichever component happened to render FIRST in a sandbox session ate
   * ~1s of harness warm-up and blew any budget under it, while the exact same
   * component measured ~84ms rendering second. A budget below the harness floor
   * could only ever false-fail. Historical `readyMs` values recorded before this
   * change are navigation-relative and are NOT comparable to later ones —
   * trends/compare show a one-time step down at that boundary.
   */
  readyMs?: number;
  /**
   * The sandbox's own cold-start cost: `performance.now()` at the moment the
   * generated entry module body begins executing, i.e. everything the harness
   * spent before the component was even asked for. Recorded for transparency
   * (and so a surprising `readyMs` can be told apart from a slow harness); it is
   * advisory only and deliberately NOT in `performanceMetricSchema`, so it can't
   * be budgeted via `expect.performance` — it is not the app's cost.
   */
  harnessBootMs?: number;
  /** React Profiler initial-mount commit cost. */
  mountMs?: number;
  /** Worst React Profiler update (re-render) commit cost across the render + play. */
  updateMs?: number;
  /** Total React commits observed (mount + updates) — context for the durations. */
  commitCount?: number;
  /**
   * Sum of ALL React Profiler update commit costs across the render + play (D2).
   * Distinct from `updateMs` (the single WORST update). Advisory context only —
   * deliberately NOT added to `performanceMetricSchema`, so it is not budgetable
   * via `expect.performance`.
   */
  updateTotalMs?: number;
}

/**
 * Where a render's data came from (A4/A2). Stamped best-effort per render for
 * display: `declared-mock` (a configured handler answered), `auto-populate` /
 * `proxy-fallback` (the permissive proxy fabricated it), `dataState-forced`
 * (A2 forced a specific data condition).
 */
export type DataProvenance =
  | 'declared-mock'
  | 'auto-populate'
  | 'proxy-fallback'
  | 'dataState-forced';

/**
 * One unmatched fetch the permissive/populate fallback answered, captured so
 * diagnostics can emit a paste-ready `.validity/config.ts` handler stub (see
 * `buildHandlerStub`). Parallel to `unmatchedUrls` (kept for back-compat); `body`
 * is the fabricated body the fallback returned — the parsed JSON when it parsed,
 * else the raw string — truncated in-page. Absent when the render wrote no body.
 */
export interface UnmatchedRequest {
  method: string;
  url: string;
  body?: unknown;
}

/**
 * Facts about the ENVIRONMENT one render session ran in.
 *
 * SESSION-SCOPED, NOT PER-ELEMENT — and that distinction is the whole reason
 * this type exists. A dependency pre-scan aborts once, for the session; the
 * app manifest is mirrored once, at sandbox boot; the toolchain is resolved
 * once. Stamping those onto every `ComponentRender` (which is what
 * `depScanFailure` used to do) made a single fact look like N facts: readers
 * had to `find()` through the renders to recover one string, run-metas carried
 * the same sentence once per screenshot, and nothing in the shape said whether
 * two renders disagreeing was even possible. One session, one record.
 *
 * DISPLAY + TAINT PROVENANCE ONLY. `depScanFailure` feeds the existing
 * demoting `dep-scan` evidence taint (unchanged); nothing else here touches a
 * verdict, a gate, or a score.
 *
 * ADD-ONLY on the persisted shape (`RunMeta.environment`): readers must treat
 * every field as possibly-absent, and the whole record as absent on run-metas
 * written before this landed.
 */
export interface RunEnvironment {
  /**
   * The sandbox toolchain the renders actually ran through, as resolved by
   * `resolveTarget`. `expo-web` and `next-web` both compose the app onto DOM
   * nodes through a shim layer, so a reader deciding how far to trust a
   * screenshot needs to see which one produced it.
   */
  target: 'web' | 'expo-web' | 'next-web';
  /**
   * How the dev server was obtained. `cold` = this run booted (and owns) its
   * own Vite; `reused-browse` = the renders were served by a running
   * `validity browse` server in ANOTHER process.
   *
   * Load-bearing for honesty: on the reuse path the optimizer and dep pre-scan
   * live in a process this run cannot observe, so an absent `depScanFailure`
   * there means "could not tell", never "the scan survived".
   */
  devServer: 'cold' | 'reused-browse';
  /**
   * `prepareSandbox`/`prepareExpoWeb` emitted the Tailwind v4 scan shim. False
   * is a real answer, not a gap: a Tailwind **v3** project wires Tailwind
   * through PostCSS, which the shim does not cover — so `false` on a project
   * whose app manifest records Tailwind is exactly the case where utilities
   * may be missing from the pixels.
   */
  tailwindShim: boolean;
  /**
   * `DevServer.appManifest` — the one-line "app manifest present; mirrored: …;
   * recorded: …" provenance for `.validity/app-manifest.json`, naming what the
   * sandbox ACTED ON versus what it merely read. Distinct from
   * `EnsureResult.appManifest`, which describes what the FILE records.
   *
   * Absent on the `reused-browse` path — the merge happened in the other
   * process and this run has nothing to report about it.
   */
  appManifest?: string;
  /**
   * The dependency pre-scan aborted during this session (one-line summary
   * naming the unresolvable import + the file that pulled it in). Absent =
   * the scan survived on the `cold` path, or was unobservable on the
   * `reused-browse` path.
   */
  depScanFailure?: string;
}

export interface ComponentRender {
  id: string;
  filePath: string;
  screenshotPath: string;
  /**
   * sha256 of the screenshot bytes, stamped into run-meta at write time
   * (`stampScreenshotHashes`, render-identity.ts). Lets byte-identity — the
   * soft-score carry-forward / renderUnchanged input — survive the run dir's
   * PNGs being pruned from disk. Absent on pre-hash run-metas and on
   * errored/skipped/unconfirmed renders.
   */
  screenshotSha256?: string;
  videoPath?: string;
  renderError?: string;
  /**
   * LEGACY, READ-ONLY. The sandbox's dependency pre-scan aborted during this
   * render's session (one-line summary naming the unresolvable import +
   * importing file).
   *
   * NO LONGER WRITTEN: the pre-scan aborts once per SESSION, so smearing the
   * same sentence onto every render made one fact look like N. It now lives on
   * {@link RunEnvironment.depScanFailure} (`RunMeta.environment`), which is
   * where every consumer must read it first.
   *
   * The field survives on the type because run-metas are persisted evidence a
   * reader opens months later: run-metas written before the environment channel
   * carry the failure ONLY here, and dropping the declaration would make those
   * runs silently read as clean — a false green in the one place the codebase
   * refuses one. Consumers keep it strictly as a fallback behind
   * `environment.depScanFailure`.
   */
  depScanFailure?: string;
  /**
   * Loop cost control: the screenshot at `screenshotPath` was intentionally NOT
   * written because the render was definitively red (errored, or every mechanical
   * check failed) and the spec has no soft criterion needing the pixels. Readers
   * must treat this like `renderError` for screenshot purposes — the file does
   * not exist; never diff/establish a baseline or include it as evidence.
   */
  screenshotSkipped?: boolean;
  /** Scenario this render was performed under, if any. `undefined` = base. */
  scenarioId?: string;
  /** Fixture name applied to this render. `undefined` = no fixture (default props). */
  fixtureId?: string;
  /**
   * If set, this render is one screenshot showing all of these fixtures
   * stacked as siblings (instead of the component being rendered with one
   * fixture's props). Triggered automatically when a component has 2+
   * fixtures and none use `play`.
   */
  stackedFixtureIds?: string[];
  /** URLs the rendered component fetched that no handler matched. Logged via `window.__VALIDITY_UNMATCHED__`. */
  unmatchedUrls?: string[];
  /**
   * Structured form of `unmatchedUrls` (add-only): each unmatched request plus
   * the fabricated body the fallback answered, so diagnostics can offer a
   * paste-ready handler stub. Logged via `window.__VALIDITY_UNMATCHED_REQUESTS__`.
   * Absent on runs written before this landed.
   */
  unmatchedRequests?: UnmatchedRequest[];
  /**
   * Heuristic: the captured PNG is suspiciously small (well below what a
   * 1280×800 frame with any visible content produces). Surface in the
   * report as a hint that the user may need a fixture with props.
   */
  looksEmpty?: boolean;
  /**
   * If the screenshot bytes match another render of the same component
   * verbatim, points at that render's slug (`{scenarioId|base}__{fixtureId|base}`).
   * Surfaces in the report so users notice when two scenarios/fixtures
   * are visually redundant.
   */
  identicalTo?: string;
  /** `console.error` calls captured during this render. */
  consoleErrors?: ConsoleErrorEntry[];
  /** Uncaught exceptions captured during this render. */
  pageErrors?: PageErrorEntry[];
  /** Failed network responses (4xx/5xx) captured during this render. */
  networkErrors?: NetworkErrorEntry[];
  /** Viewport this render was captured at. Undefined = default 1280×800. */
  viewport?: { width: number; height: number; name: string };
  /**
   * Pixel-diff result against the saved baseline for this render's key
   * (`componentId__variantSlug`). Undefined when no baseline existed at
   * verify time (e.g. first run, or a freshly-added variant).
   */
  baseline?: {
    /** Git SHA the baseline was promoted at (best-effort, optional). */
    sha?: string;
    /** When the baseline file was last written, ISO. */
    takenAt: string;
    /** Path of the diff PNG written to the run dir, project-relative is OK. */
    diffPath?: string;
    /** Pixels that changed between baseline and current screenshot. */
    mismatchedPixels?: number;
  };
  /** Accessibility violations (severity ≥ configured floor). Capped at 50. */
  a11yViolations?: A11yViolation[];
  /**
   * NATIVE-ONLY: the agent-device accessibility-tree snapshot captured for this
   * render (the native analog of the DOM-based `a11yViolations`, which axe-core
   * can't produce on a simulator). Persisted into run-meta so a native verify's
   * evidence survives to `submit_report` unmodified; the web isolation/URL paths
   * never set it. Free-form text, not structured violations.
   */
  a11ySnapshot?: string;
  /**
   * Checks target only (web AND native): the pristine PRE-interaction
   * screenshot, captured before click/fill checks mutated the screen. The
   * evidence shot (`screenshotPath`) deliberately stays the post-interaction
   * end state ("success banner" checks, baseline identity); this companion
   * image lets soft criteria about the INITIAL state be scored against what
   * the user first sees. Never indexed as a render key, never baselined.
   * Citable as `<id>::pre` (see `citableScreenshotIds`).
   */
  preInteractionScreenshotPath?: string;
  /**
   * Same blank-PNG heuristic as {@link looksEmpty}, measured on the
   * PRE-interaction companion instead of the evidence shot. Tracked separately
   * because the two frames genuinely differ: a render that is blank after a
   * click (navigated away, modal swallowed the view) may have been perfectly
   * fine before it, and vice versa. The citation gate reads this to decide
   * whether `<id>::pre` may back a soft `pass` — inheriting `looksEmpty` would
   * be a guess in both directions. Web isolation/URL renders only; native
   * capture computes no emptiness heuristic (the file-size threshold is tuned
   * for 1280×800 browser PNGs), so it stays undefined there.
   */
  preInteractionLooksEmpty?: boolean;
  /**
   * Performance metrics measured for this render. Surfaced passively in the
   * report's per-render Performance panel and read by `expect.performance`
   * checks. Populated by the web sandbox (full set) AND by native verify (the
   * companion's on-device `NativePerf`: `readyMs`/`mountMs`/`updateMs`/
   * `commitCount` — a structural subset; `loadMs`/`firstContentfulPaintMs` have
   * no React-Native source and stay absent). Undefined when perf instrumentation
   * produced nothing or, on native, when the companion predates the perf channel.
   */
  performance?: PerformanceMetrics;
  /**
   * Mechanical hard/property-tier verdicts from executing a spec's `checks`
   * against this render: the canonical base render of a spec's target
   * component, or — when the target has NO base render (fixtures/scenarios
   * drive it) — every eligible variant, whose verdicts the roll-up merges
   * fail-wins. Present only on spec verifies. Soft criteria are NOT here —
   * they're LLM-scored. Rolled up into run-meta's `criterionVerdicts`.
   */
  criterionVerdicts?: CriterionVerdict[];
  /** Data-population state this render was forced into (A2). */
  dataState?: DataState;
  /**
   * Where this render's data came from (A4/A2). Best-effort, display-only —
   * derived from the render's request log: any declared handler hit ⇒
   * `declared-mock`, any permissive/unmatched ⇒ `proxy-fallback`; A2 stamps
   * `dataState-forced` when it forced a state.
   */
  dataProvenance?: DataProvenance[];
  /**
   * NATIVE-ONLY: whether the device confirmed this render (A3). `unconfirmed`
   * means the screenshot is not evidence — the native verify handler stamps it.
   */
  renderConfirmation?: 'confirmed' | 'unconfirmed';
}

/**
 * Axe-core a11y violation, normalized for the report + tool result. We only
 * carry the fields the agent (and a reader) needs to act — `nodes` is a count
 * so the tool response stays small, while `nodeDetails` carries a BOUNDED
 * evidence slice (first N failing nodes) so a reader can see WHICH elements
 * failed without re-running axe: the selector, a trimmed HTML snippet, and
 * axe's failure summary. Optional because old run-meta snapshots predate it
 * (add-only snapshot contract — never rename/remove existing fields).
 */
export interface A11yViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  description: string;
  helpUrl?: string;
  /** Number of DOM nodes that triggered this rule. */
  nodes: number;
  /**
   * Bounded evidence slice: first N failing nodes (selector, trimmed HTML,
   * axe failure summary). Capped in `runAxe` so the persisted run-meta and
   * tool response stay small even when a rule fires on hundreds of nodes.
   */
  nodeDetails?: Array<{ target: string; html?: string; failureSummary?: string }>;
}

export interface ValidityReport {
  runId: string;
  prompt: string;
  taskId?: string;
  criteria: Criterion[];
  components: ComponentRender[];
  verdict: 'pass' | 'fail' | 'partial';
  createdAt: string;
}

export interface LockedTask {
  taskId: string;
  prompt: string;
  criteria: Criterion[];
  createdAt: string;
}
