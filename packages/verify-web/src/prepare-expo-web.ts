/**
 * Expo Web prepare path (Lane B of Phase 1).
 *
 * Mirrors `prepareSandbox()` for an Expo project: writes the same
 * `index.html`, `validity-msw.ts`, and (optionally) browse-mode index +
 * Tailwind shim into `node_modules/.validity/`. The difference is the
 * generated `entry.tsx` — it mounts via `AppRegistry.runApplication`
 * from `react-native-web` instead of React 18's `createRoot()`, so the
 * user's RN primitives (`View`, `Text`, `FlatList`, `Image`) compose
 * onto DOM nodes through `react-native-web`'s shim layer.
 *
 * Vite-side aliasing (`react-native` → `react-native-web`, reanimated /
 * gesture-handler stubs) lives in `expo-web-aliases.ts` and is wired by
 * `server.ts`. This file is concerned only with what gets written to
 * disk before Vite boots.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DataState, MockNetworkConfig, ValidityConfig } from '@validity.ai/verify-spec';
import { entryFile, indexHtml, propsDir, relFromValidity, validityDir } from './paths.js';
import { writeSharedSandboxAssets, type PrepareResult } from './prepare.js';

function ensureDir(p: string) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** Stripped-down MockNetworkConfig sent to the browser — same shape as the web prepare. */
function browserNetworkPayload(cfg: MockNetworkConfig | undefined, dataState?: DataState) {
  if (!cfg) {
    return { fallback: 'permissive' as const, handlers: [], ...(dataState ? { dataState } : {}) };
  }
  return {
    fallback: cfg.fallback ?? 'permissive',
    handlers: cfg.handlers ?? [],
    ...(dataState ? { dataState } : {}),
  };
}

/**
 * True when `expo-router` is in the user's dependencies. We surface
 * this in the generated entry's comment header so a future iteration can
 * wire a memory-history router automatically; for now the user-side
 * wrapper (`.validity/wrapper.user.tsx`) is the place to mount a
 * `<MemoryRouter>` equivalent if needed.
 */
function hasExpoRouter(projectRoot: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return 'expo-router' in deps;
  } catch {
    return false;
  }
}

/**
 * Conventional locations for an app's i18n bootstrap module. Ordered:
 * Ignite keeps it at `app/i18n/index.ts`; plain Expo/CRA-style apps use
 * `src/i18n*`; bare `i18n/` at the root is the least common.
 */
const I18N_MODULE_CANDIDATES = [
  'app/i18n/index.ts',
  'app/i18n/index.tsx',
  'app/i18n.ts',
  'src/i18n/index.ts',
  'src/i18n/index.tsx',
  'src/i18n.ts',
  'src/i18n.tsx',
  'i18n/index.ts',
  'i18n.ts',
  'src/lib/i18n.ts',
  'app/lib/i18n.ts',
];

/**
 * Find the app's i18next bootstrap module, if any.
 *
 * In isolation nobody calls the app's `initI18n()` (Ignite runs it in an
 * `App()` useEffect the sandbox never mounts), and Ignite-style
 * `translate()` returns the RAW KEY while `i18next.isInitialized` is
 * false — with no subscription, so late init never repaints. The entry
 * therefore has to await init itself; this detector locates the module
 * whose init function it should call.
 *
 * Gated on `i18next`/`react-i18next` in package.json deps, then the
 * first candidate path whose CONTENT imports i18next (rejects re-export
 * shims that happen to sit at a candidate path). Returns the absolute
 * file path, or undefined when the project doesn't use i18next.
 */
export function detectAppI18nModule(projectRoot: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (!('i18next' in deps) && !('react-i18next' in deps)) return undefined;
  } catch {
    return undefined;
  }
  for (const rel of I18N_MODULE_CANDIDATES) {
    const abs = resolve(projectRoot, rel);
    if (!existsSync(abs)) continue;
    try {
      const content = readFileSync(abs, 'utf-8');
      if (/(from ['"]i18next['"]|initReactI18next)/.test(content)) return abs;
    } catch {
      /* unreadable candidate — keep scanning */
    }
  }
  return undefined;
}

/**
 * Prepare the sandbox for an Expo project rendered through
 * `react-native-web`. Same public contract as `prepareSandbox()`.
 */
export function prepareExpoWeb(projectRoot: string, config: ValidityConfig): PrepareResult {
  const dir = validityDir(projectRoot);
  ensureDir(dir);
  ensureDir(propsDir(projectRoot));

  // .gitignore inside validity dir to keep generated files out of git regardless
  writeFileSync(resolve(dir, '.gitignore'), '*\n');

  const wrapperAbs = resolve(projectRoot, config.wrapper);
  const wrapperRel = relFromValidity(projectRoot, wrapperAbs).replace(/\.(tsx?|jsx?)$/, '');

  // Pre-serialize the network configs into the entry — same shape as the
  // web prepare path. Cookies/storage live OUTSIDE this payload: Playwright
  // handles them via addCookies/addInitScript (verify) or the pre-React
  // seed script in index.html (browse).
  const baseNetwork = browserNetworkPayload(config.mockNetwork);
  const scenariosNetwork: Record<string, ReturnType<typeof browserNetworkPayload>> = {};
  for (const [name, scenario] of Object.entries(config.scenarios ?? {})) {
    scenariosNetwork[name] = browserNetworkPayload(scenario.mockNetwork, scenario.dataState);
  }

  const fixturesByComponent: Record<string, Record<string, unknown>> = {};
  for (const [path, entry] of Object.entries(config.components ?? {})) {
    if (!entry.fixtures) continue;
    const map: Record<string, unknown> = {};
    for (const [fxName, fx] of Object.entries(entry.fixtures)) {
      map[fxName] = fx.props ?? {};
    }
    fixturesByComponent[path] = map;
  }

  // Shared HTML shell + MSW shim + browse index template + (optional)
  // Tailwind v4 shim. Tailwind is rare in Expo projects but cheap to
  // emit; the detector keys off `@tailwindcss/vite` in package.json so
  // it stays off for the common case.
  const { hasTailwindV4, hasBrowseIndex } = writeSharedSandboxAssets(projectRoot);

  // entry.tsx — Expo-flavored. Uses react-native-web's AppRegistry to
  // mount, NOT createRoot. The component map and the URL-parameter
  // contract (`?component=&fixtures=&scenario=`) are identical to the
  // web entry so render.ts doesn't need a separate code path.
  const baseNetworkJson = JSON.stringify(baseNetwork);
  const scenariosNetworkJson = JSON.stringify(scenariosNetwork);
  const mocksJson = JSON.stringify(config.mocks ?? {});
  const fixturesJson = JSON.stringify(fixturesByComponent);
  const expoRouter = hasExpoRouter(projectRoot);

  const tailwindShimImport = hasTailwindV4 ? "import './validity-tailwind-shim.css';\n" : '';

  const browseIndexImport = hasBrowseIndex ? "import { Index } from './validity-index';\n" : '';

  // App i18n auto-init (mirror of the other auto-handled providers/mocks).
  // Without it, Ignite-style translate() freezes raw keys into the render
  // (init lives in an App() useEffect the sandbox never mounts), making
  // every text/accessible-name check unverifiable.
  const i18nModuleAbs = detectAppI18nModule(projectRoot);
  if (i18nModuleAbs) {
    const i18nRel = relFromValidity(projectRoot, i18nModuleAbs).replace(/\.(tsx?|jsx?)$/, '');
    writeFileSync(
      resolve(dir, 'validity-i18n.ts'),
      `// AUTO-GENERATED by Validity (Expo Web). Awaits the app's own i18n
// bootstrap so translate() returns real strings instead of raw keys.
export async function ensureAppI18n(): Promise<void> {
  try {
    // Dynamic imports: the app module must evaluate AFTER the network
    // interceptors are installed — some apps fetch translations at init.
    const [i18nextMod, appMod] = await Promise.all([
      import('i18next'),
      import('${i18nRel}'),
    ]);
    const inst: any = (i18nextMod as any).default ?? i18nextMod;
    // Already initialized (module-scope init, or a wrapper got there first)
    // — this also makes the whole function idempotent.
    if (inst?.isInitialized) return;
    for (const [name, value] of Object.entries(appMod as Record<string, unknown>)) {
      if (typeof value !== 'function') continue;
      if (!/^(init|setup|configure|bootstrap)/i.test(name)) continue;
      await (value as () => unknown)();
      if (inst?.isInitialized) return;
    }
    // Default-exported init function (a default-exported i18n INSTANCE is
    // an object, so it is skipped).
    if (!inst?.isInitialized && typeof (appMod as any).default === 'function') {
      await ((appMod as any).default as () => unknown)();
    }
  } catch (err) {
    console.warn('[validity] app i18n auto-init failed (text may render as raw keys)', err);
  }
}
`,
    );
  }
  const i18nInitImport = i18nModuleAbs ? "import { ensureAppI18n } from './validity-i18n';\n" : '';
  const i18nInitAwait = i18nModuleAbs
    ? `
// App i18n must be ready BEFORE the screen renders — Ignite-style translate()
// is non-reactive (returns the raw key while i18next.isInitialized is false),
// so init completing after mount would leave raw keys frozen in. The 5s race
// means a hanging init (e.g. an unmocked remote-backend fetch) degrades to
// raw-key rendering instead of stalling capture.
await Promise.race([ensureAppI18n(), new Promise((r) => setTimeout(r, 5000))]);
`
    : '';

  // RN runtime globals shim. Metro defines `process`, `global`, and `__DEV__`
  // for all RN/Expo source; a bare Vite context doesn't. Real RN packages
  // (reanimated, expo-system-ui, …) touch these at module-eval time and would
  // otherwise throw "process is not defined" / "__DEV__ is not defined". This
  // is written as its own module and imported FIRST in entry.tsx so its side
  // effects run before react-native-web / the user Wrapper evaluate (ESM
  // imports evaluate in source order). `__DEV__` is also folded at build via
  // Vite `define`; the runtime copy here covers any dynamic-global access.
  writeFileSync(
    resolve(dir, 'validity-rn-globals.ts'),
    `// AUTO-GENERATED by Validity (Expo Web). RN runtime globals Metro injects.
const g = globalThis as any;
if (typeof g.process === 'undefined') {
  g.process = {
    env: { NODE_ENV: 'production' },
    browser: true,
    platform: 'web',
    version: '',
    nextTick: (fn: (...a: any[]) => void, ...args: any[]) =>
      Promise.resolve().then(() => fn(...args)),
  };
} else if (typeof g.process.env === 'undefined') {
  g.process.env = { NODE_ENV: 'production' };
}
if (typeof g.__DEV__ === 'undefined') g.__DEV__ = false;
if (typeof g.global === 'undefined') g.global = g;
export {};
`,
  );

  writeFileSync(
    entryFile(projectRoot),
    `import './validity-rn-globals';
// SECOND (right after the RN globals shim, still before the Wrapper import):
// apply the fetch/XHR interceptors at module-eval time so a request fired while
// the user's provider graph evaluates lands on patched globals, not the real
// network. See validity-net-bootstrap.
import './validity-net-bootstrap';
${tailwindShimImport}// Validity sandbox entry — Expo Web (Phase 1, Lane B).
//
// Mounts via react-native-web's AppRegistry, not React 18 createRoot.
// The Vite alias map (server.ts) rewrites bare \`react-native\` imports
// to \`react-native-web\`, so the user's <View>/<Text> trees compile
// onto DOM nodes. Expo-router${expoRouter ? ' is detected — the user wrapper handles router context for now.' : ' is not in dependencies; no router context wired.'}
import React, { useEffect, useState } from 'react';
import { AppRegistry } from 'react-native-web';
import Wrapper from '${wrapperRel}';
import { setupValidityNetwork } from './validity-msw';
${i18nInitImport}${browseIndexImport}

declare global {
  interface Window {
    __VALIDITY_MOCKS__?: any;
    __VALIDITY_BASE_NETWORK__?: any;
    __VALIDITY_SCENARIOS__?: Record<string, any>;
    __VALIDITY_FIXTURES__?: Record<string, Record<string, Record<string, unknown>>>;
    __VALIDITY_UNMATCHED__?: string[];
    __VALIDITY_PROFILE__?: Array<{
      phase: string;
      actualDuration: number;
      baseDuration: number;
      startTime: number;
      commitTime: number;
    }>;
    __VALIDITY_PERF_READY_MS__?: number;
    __VALIDITY_PERF_BOOT_MS__?: number;
    __VALIDITY_GET_PERF__?: () => Record<string, number>;
    __validityReady?: boolean;
  }
}

// Perf origin — MIRROR of the web entry. Harness cost (Vite cold transform of
// this module graph, browser JIT, the imports above) lands before this line, so
// __VALIDITY_GET_PERF__ can subtract it and report the component's own
// load+mount as readyMs rather than the sandbox's cold start.
try {
  window.__VALIDITY_PERF_BOOT_MS__ = performance.now();
} catch (_) {
  /* no perf clock — readyMs stays navigation-relative */
}

window.__VALIDITY_MOCKS__ = ${mocksJson};
window.__VALIDITY_BASE_NETWORK__ = ${baseNetworkJson};
window.__VALIDITY_SCENARIOS__ = ${scenariosNetworkJson};
window.__VALIDITY_FIXTURES__ = ${fixturesJson};
window.__VALIDITY_UNMATCHED__ = [];
window.__VALIDITY_PROFILE__ = [];

// Auto-mock React contexts whose Provider lives below the wrapper splice
// point (App.tsx-level providers absent in the sandbox) — MIRROR of the web
// entry (prepare.ts). A consumer like useAuth() does
//   const ctx = useContext(C); if (!ctx) throw new Error('must be used within …')
// which would crash the whole render. We seed createContext's default with a
// deep-default proxy (from the validity-msw module, on window) so that guard
// passes and any ctx.some.deep.value read resolves to 0 / [] / '' / a proxy.
// User screens are imported dynamically (below) AFTER this runs, so their
// named createContext imports pick up the patched version. A real Provider,
// when present in the wrapper, still supplies its own value and wins.
const __validityRealCreateContext = React.createContext;
(React as any).createContext = function validityCreateContext(defaultValue: unknown) {
  const proxyFactory = (window as any).__VALIDITY_DEEP_DEFAULT__ as (() => unknown) | undefined;
  const seeded =
    (defaultValue === undefined || defaultValue === null) && proxyFactory
      ? proxyFactory()
      : defaultValue;
  return (__validityRealCreateContext as any)(seeded);
};

// Performance instrumentation — MIRROR of prepare.ts. A <React.Profiler> wraps
// each rendered component and pushes commits into __VALIDITY_PROFILE__;
// __VALIDITY_GET_PERF__ folds them + Navigation/Paint Timing into a flat
// metrics object that capture.ts and the spec check executor read. react-native-web
// supports React.Profiler; Navigation/Paint Timing may be absent under Expo —
// the getter is defensive and just omits unavailable metrics.
const __validityOnRender = (
  _id: string,
  phase: string,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number,
) => {
  try {
    (window.__VALIDITY_PROFILE__ as Array<Record<string, unknown>>).push({
      phase,
      actualDuration,
      baseDuration,
      startTime,
      commitTime,
    });
  } catch (_) {
    /* perf is best-effort */
  }
};
window.__VALIDITY_GET_PERF__ = () => {
  const out: Record<string, number> = {};
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      | { loadEventEnd?: number; domContentLoadedEventEnd?: number }
      | undefined;
    if (nav) {
      // OR (not nullish-coalescing) is deliberate: loadEventEnd reads 0 until
      // the load event fires, so a 0 must fall back to domContentLoadedEventEnd
      // rather than be kept.
      const load = nav.loadEventEnd || nav.domContentLoadedEventEnd || 0;
      if (load > 0) out.loadMs = Math.round(load);
    }
    const fcp = performance
      .getEntriesByType('paint')
      .find((e) => e.name === 'first-contentful-paint');
    if (fcp) out.firstContentfulPaintMs = Math.round(fcp.startTime);
  } catch (_) {
    /* Navigation/Paint Timing unavailable */
  }
  if (typeof window.__VALIDITY_PERF_READY_MS__ === 'number') {
    // Subtract harness boot — mirror of the web entry. See prepare.ts.
    const boot =
      typeof window.__VALIDITY_PERF_BOOT_MS__ === 'number' ? window.__VALIDITY_PERF_BOOT_MS__ : 0;
    if (boot > 0) out.harnessBootMs = Math.round(boot);
    out.readyMs = Math.max(0, Math.round(window.__VALIDITY_PERF_READY_MS__ - boot));
  }
  try {
    const commits = (window.__VALIDITY_PROFILE__ ?? []) as Array<{
      phase: string;
      actualDuration: number;
    }>;
    out.commitCount = commits.length;
    // Profiler commit durations keep 2 decimals on purpose — sub-ms precision
    // matters against tight budgets (e.g. a 16ms frame); the coarse
    // Navigation/Paint timings above are integer-rounded.
    const mount = commits.find((c) => c.phase === 'mount');
    if (mount) out.mountMs = Math.round(mount.actualDuration * 100) / 100;
    const updates = commits.filter((c) => c.phase === 'update' || c.phase === 'nested-update');
    if (updates.length > 0) {
      out.updateMs = Math.round(Math.max(...updates.map((c) => c.actualDuration)) * 100) / 100;
      out.updateTotalMs =
        Math.round(updates.reduce((s, c) => s + c.actualDuration, 0) * 100) / 100;
    }
  } catch (_) {
    /* profiler data unavailable */
  }
  return out;
};

// Interceptors are already applied (validity-net-bootstrap, imported above).
// This WIRES the per-render handlers into them and releases any request held
// while handlers were unknown — mirror of the web entry.
const params = new URLSearchParams(window.location.search);
const scenarioId = params.get('scenario') ?? undefined;
// Forced data-state axis (A2) — mirror of the web entry.
const dataState = params.get('dataState') ?? undefined;
const baseNetwork = window.__VALIDITY_BASE_NETWORK__;
const scenarioNetwork = scenarioId ? window.__VALIDITY_SCENARIOS__?.[scenarioId] : undefined;
await setupValidityNetwork({ base: baseNetwork, scenario: scenarioNetwork, dataState });
${i18nInitAwait}
// Glob is identical to the web entry — Expo projects keep their source
// tree under the project root (no \`src/\` mandate from Expo) so the
// recursive **/* glob picks up App.tsx, app/_layout.tsx, and any
// components/ subdir uniformly.
const componentMap = import.meta.glob('../../**/*.{tsx,jsx}');

async function loadProps(propsId: string | null): Promise<Record<string, unknown>> {
  if (!propsId) return {};
  try {
    const res = await fetch('/props/' + propsId + '.json');
    if (!res.ok) return {};
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveComponent(componentPath: string): (() => Promise<any>) | null {
  const candidate = '../../' + componentPath.replace(/^\\/+/, '');
  if (componentMap[candidate]) return componentMap[candidate];
  const lower = candidate.toLowerCase();
  for (const [key, loader] of Object.entries(componentMap)) {
    if (key.toLowerCase() === lower) return loader;
  }
  return null;
}

interface StackedFixture {
  id: string;
  props: Record<string, unknown>;
}

function resolveStackedFixtures(componentPath: string, fixtureNames: string[]): StackedFixture[] {
  const map = window.__VALIDITY_FIXTURES__?.[componentPath] ?? {};
  return fixtureNames.map((id) => ({ id, props: (map[id] as Record<string, unknown>) ?? {} }));
}

type AppState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready-index' }
  | { kind: 'ready-single'; Component: any; props: Record<string, unknown> }
  | { kind: 'ready-stacked'; Component: any; fixtures: StackedFixture[] };

/**
 * Error boundary mirrored from the web entry. RN-Web has no native
 * "show this in red" surface, so we render a vanilla DOM <pre> exactly
 * like the web path — Playwright reads it the same way.
 */
class ValidityErrorBoundary extends React.Component<
  { children: React.ReactNode; source: 'wrapper' | 'component' },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      const message = this.state.error.message || String(this.state.error);
      const stack = this.state.error.stack ?? message;
      const isWrapper = this.props.source === 'wrapper';
      const heading = isWrapper
        ? 'Validity wrapper error'
        : 'This component threw at runtime';
      const hint = isWrapper
        ? 'The cloned provider tree threw while rendering. Check .validity/wrapper.tsx — usually a provider needs context (auth, theme, store) that Validity has not seeded.'
        : 'It probably needs more than props — a context provider (auth, theme, query client), a router, or a mocked API response. Define a fixture under .validity/config.ts with a wrapper or seeded data.';
      // Same friendly-card design as the web entry; rendered via
      // createElement so the Expo Web entry stays JSX-free for the
      // RN-Web alias resolution pass.
      return React.createElement(
        'div',
        {
          'data-validity-error': 'true',
          'data-validity-error-source': this.props.source,
          style: {
            margin: 16,
            padding: '18px 22px',
            background: '#fffbeb',
            border: '1px dashed #f59e0b',
            borderRadius: 8,
            font:
              '13px ui-sans-serif, -apple-system, system-ui, "Segoe UI", Roboto, sans-serif',
            color: '#0f172a',
            maxWidth: 640,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            boxSizing: 'border-box',
          },
        },
        React.createElement(
          'div',
          {
            style: {
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: '#b45309',
              fontWeight: 600,
            },
          },
          heading,
        ),
        React.createElement(
          'p',
          { style: { margin: 0, fontSize: 13, lineHeight: 1.55 } },
          hint,
        ),
        React.createElement(
          'code',
          {
            style: {
              fontSize: 12,
              color: '#b00020',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              background: 'rgba(176, 0, 32, 0.06)',
              padding: '6px 8px',
              borderRadius: 4,
              wordBreak: 'break-word',
            },
          },
          message,
        ),
        React.createElement(
          'details',
          { style: { marginTop: 2 } },
          React.createElement(
            'summary',
            {
              style: {
                cursor: 'pointer',
                fontSize: 12,
                color: '#64748b',
                fontWeight: 500,
                userSelect: 'none',
              },
            },
            'Show stack trace',
          ),
          React.createElement(
            'pre',
            {
              style: {
                marginTop: 8,
                padding: 10,
                background: 'rgba(15, 23, 42, 0.04)',
                border: '1px solid rgba(15, 23, 42, 0.08)',
                borderRadius: 4,
                font:
                  '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                color: '#475569',
                whiteSpace: 'pre-wrap',
                maxHeight: 240,
                overflow: 'auto',
                margin: 0,
              },
            },
            stack,
          ),
        ),
      );
    }
    return this.props.children as React.ReactElement;
  }
}

function App() {
  const [state, setState] = useState<AppState>({ kind: 'loading' });

  useEffect(() => {
    const componentPath = params.get('component');
    const propsId = params.get('propsId');
    const stackedNames = (params.get('fixtures') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (!componentPath) {
      ${hasBrowseIndex ? 'setState({ kind: "ready-index" });' : `setState({ kind: 'error', message: 'No ?component= query parameter provided.' });`}
      return;
    }

    const loader = resolveComponent(componentPath);
    if (!loader) {
      setState({ kind: 'error', message: 'Component not found in glob: ' + componentPath });
      return;
    }

    if (stackedNames.length > 0) {
      loader()
        .then((mod) => {
          const Component = (mod as any).default ?? Object.values(mod as object)[0];
          if (!Component) {
            setState({ kind: 'error', message: 'No exported component in ' + componentPath });
            return;
          }
          const fixtures = resolveStackedFixtures(componentPath, stackedNames);
          setState({ kind: 'ready-stacked', Component, fixtures });
        })
        .catch((err) => setState({ kind: 'error', message: String(err?.message ?? err) }));
      return;
    }

    Promise.all([loader(), loadProps(propsId)])
      .then(([mod, props]) => {
        const Component = (mod as any).default ?? Object.values(mod as object)[0];
        if (!Component) {
          setState({ kind: 'error', message: 'No exported component in ' + componentPath });
          return;
        }
        setState({ kind: 'ready-single', Component, props });
      })
      .catch((err) => setState({ kind: 'error', message: String(err?.message ?? err) }));
  }, []);

  useEffect(() => {
    if (
      state.kind === 'ready-single' ||
      state.kind === 'ready-stacked' ||
      state.kind === 'ready-index' ||
      state.kind === 'error'
    ) {
      // Perf anchor: stamp time-to-ready the first time we reach a terminal
      // state (mirror of the web entry).
      if (typeof window.__VALIDITY_PERF_READY_MS__ !== 'number') {
        try {
          window.__VALIDITY_PERF_READY_MS__ = performance.now();
        } catch (_) {
          /* no perf clock */
        }
      }
      // Same two-tier deferral as the web entry — give any
      // initial-effect fetches a chance to register against the
      // interceptor before Playwright thinks we're ready.
      window.__validityReady = true;
      Promise.resolve().then(() => {
        requestAnimationFrame(() => {
          document.documentElement.setAttribute('data-validity-ready', 'true');
        });
      });
    }
  }, [state.kind]);

  if (state.kind === 'loading') return null;
  if (state.kind === 'error') {
    return React.createElement(
      'pre',
      {
        'data-validity-error': 'true',
        style: {
          padding: 16,
          color: '#b00020',
          font: '13px ui-monospace, Menlo, monospace',
          whiteSpace: 'pre-wrap',
        },
      },
      'Validity render error: ' + state.message,
    );
  }
  ${
    hasBrowseIndex
      ? `if (state.kind === 'ready-index') {
    return <Index />;
  }`
      : ''
  }

  if (state.kind === 'ready-stacked') {
    const { Component, fixtures } = state;
    return (
      <ValidityErrorBoundary source="wrapper">
        <Wrapper>
          <ValidityErrorBoundary source="component">
            <div
              data-validity-stack="true"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 32,
                padding: 24,
              }}
            >
              {fixtures.map((fx) => (
                <section
                  key={fx.id}
                  data-validity-fixture={fx.id}
                  style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
                >
                  <header
                    style={{
                      font:
                        '11px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: '#64748b',
                    }}
                  >
                    {fx.id}
                  </header>
                  <div>
                    <React.Profiler id="validity-render" onRender={__validityOnRender}>
                      <Component {...fx.props} />
                    </React.Profiler>
                  </div>
                </section>
              ))}
            </div>
          </ValidityErrorBoundary>
        </Wrapper>
      </ValidityErrorBoundary>
    );
  }

  const { Component, props } = state;
  return (
    <ValidityErrorBoundary source="wrapper">
      <Wrapper>
        <ValidityErrorBoundary source="component">
          <React.Profiler id="validity-render" onRender={__validityOnRender}>
            <Component {...props} />
          </React.Profiler>
        </ValidityErrorBoundary>
      </Wrapper>
    </ValidityErrorBoundary>
  );
}

// react-native-web's AppRegistry takes a NAME and a factory returning
// the root component, then mounts into the provided rootTag. Per the
// react-native-web docs, this is the supported entry point — it sets up
// the StyleSheet registry + i18n + accessibility hooks before render
// runs. createRoot would skip all of that and produce subtly wrong
// styles (margin/padding shorthand, flex defaults, line-height).
const ValidityRoot = () => React.createElement(App);
AppRegistry.registerComponent('ValidityRoot', () => ValidityRoot);
const rootTag = document.getElementById('root');
if (rootTag) {
  AppRegistry.runApplication('ValidityRoot', { rootTag });
}
`,
  );

  return {
    validityDir: dir,
    entryFile: entryFile(projectRoot),
    indexHtml: indexHtml(projectRoot),
    propsDir: propsDir(projectRoot),
    tailwindShim: hasTailwindV4,
  };
}
