import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ValidityConfig } from '@validity.ai/verify-spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { entryFile, indexHtml, validityDir } from './paths.js';
import { prepareSandbox } from './prepare.js';

/**
 * `prepareSandbox` writes generated files into `<projectRoot>/node_modules/.validity/`.
 * Each test gets a fresh tmp project root, with a stub wrapper at the path the
 * config points to, so `relFromValidity` can compute a sensible import.
 */
function makeProjectRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-prepare-test-'));
  // Wrapper file the entry will import — content irrelevant; prepare only
  // resolves the path string into the entry import.
  mkdirSync(resolve(root, '.validity'), { recursive: true });
  writeFileSync(
    resolve(root, '.validity/wrapper.tsx'),
    `import type { ReactNode } from 'react';\nexport default function W({ children }: { children: ReactNode }) { return <>{children}</>; }\n`,
  );
  // node_modules has to exist for the .validity dir to land under it.
  mkdirSync(resolve(root, 'node_modules'), { recursive: true });
  return root;
}

function baseConfig(overrides: Partial<ValidityConfig> = {}): ValidityConfig {
  return {
    renderMode: 'web',
    framework: 'vite',
    wrapper: './.validity/wrapper.tsx',
    ...overrides,
  };
}

describe('prepareSandbox', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectRoot();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes entry.tsx, validity-msw.ts, and index.html under node_modules/.validity', () => {
    const result = prepareSandbox(projectRoot, baseConfig());

    expect(result.validityDir).toBe(validityDir(projectRoot));
    expect(existsSync(result.entryFile)).toBe(true);
    expect(existsSync(result.indexHtml)).toBe(true);
    expect(existsSync(resolve(result.validityDir, 'validity-msw.ts'))).toBe(true);
    expect(existsSync(resolve(result.validityDir, 'validity-net-bootstrap.ts'))).toBe(true);
    expect(existsSync(resolve(result.validityDir, '.gitignore'))).toBe(true);
  });

  it('the net bootstrap holds pre-ready requests instead of passing them through', () => {
    prepareSandbox(projectRoot, baseConfig());
    const bootstrap = readFileSync(
      resolve(validityDir(projectRoot), 'validity-net-bootstrap.ts'),
      'utf-8',
    );

    // A request that arrives before the responder is wired AWAITS the
    // ready-promise (queued), and is recorded for diagnostics — it is never
    // silently passed to the real network.
    expect(bootstrap).toContain('if (!responder) {');
    expect(bootstrap).toContain('notePreReady(method, url);');
    expect(bootstrap).toContain('await ready;');
    expect(bootstrap).toContain('window.__VALIDITY_PREREADY__');
    // Single apply, guarded so a double-eval can't stack listeners.
    expect(bootstrap).toContain("Symbol.for('validity.net.bootstrap.applied')");
    // Both realms are patched here (fetch AND XHR), before any user module.
    expect(bootstrap).toContain('fetchInterceptor.apply();');
    expect(bootstrap).toContain('xhrInterceptor.apply();');
  });

  it('entry.tsx contains the expected runtime hooks', () => {
    prepareSandbox(projectRoot, baseConfig());
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    // Top-level await of the interceptor setup, before the dynamic import.
    expect(entry).toContain('await setupValidityNetwork(');
    // Dynamic component map.
    expect(entry).toContain("import.meta.glob('../../**/*.{tsx,jsx}')");
    // Globals consumed by the sandbox.
    expect(entry).toContain('__VALIDITY_BASE_NETWORK__');
    expect(entry).toContain('__VALIDITY_SCENARIOS__');
    expect(entry).toContain('__VALIDITY_UNMATCHED__');
    // Scenario id is parsed from the URL.
    expect(entry).toContain("params.get('scenario')");
    // Imports the sibling shim (not the user's project).
    expect(entry).toContain("from './validity-msw'");
  });

  it('entry.tsx wires the performance instrumentation (Profiler + perf getter)', () => {
    prepareSandbox(projectRoot, baseConfig());
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    // Perf globals + getter the sandbox/check-executor read.
    expect(entry).toContain('window.__VALIDITY_PROFILE__ = [];');
    expect(entry).toContain('window.__VALIDITY_GET_PERF__ =');
    expect(entry).toContain('__VALIDITY_PERF_READY_MS__');
    // The rendered component is wrapped in a Profiler that records commits.
    expect(entry).toContain('<React.Profiler id="validity-render" onRender={__validityOnRender}>');
    // Folds mount vs update commits + Paint/Navigation timing.
    expect(entry).toContain('first-contentful-paint');
    expect(entry).toContain("phase === 'mount'");
    // D2 fold extension: cumulative update-commit cost rides next to the worst
    // single update. Mirrored byte-for-byte in prepare-expo-web.ts (guarded by
    // the matching assertion in expo-web.test.ts).
    expect(entry).toContain('out.updateTotalMs =');
    expect(entry).toContain('updates.reduce((s, c) => s + c.actualDuration, 0)');
  });

  // Regression: readyMs used to be navigation-relative, so it carried Vite's
  // cold-start transform. Whichever component rendered FIRST in a session paid
  // ~1s of harness warm-up and false-failed any budget under that floor, while
  // the same component measured ~84ms rendering second. The boot stamp is what
  // makes the subtraction possible; if it ever moves BELOW the component load,
  // the metric silently goes back to being a lie.
  it('entry.tsx stamps harness boot before anything component-related, and subtracts it from readyMs', () => {
    prepareSandbox(projectRoot, baseConfig());
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    expect(entry).toContain('window.__VALIDITY_PERF_BOOT_MS__ = performance.now();');
    expect(entry).toContain('out.readyMs = Math.max(0, Math.round(');
    expect(entry).toContain('window.__VALIDITY_PERF_READY_MS__ - boot');
    // Harness cost is reported, not hidden — a reader can tell a slow
    // component apart from a cold sandbox.
    expect(entry).toContain('out.harnessBootMs = Math.round(boot);');

    // Ordering is the whole point: the stamp must sit AFTER the imports (which
    // is where Vite's cold transform lands, since ES imports evaluate
    // depth-first) and BEFORE the mock/fixture wiring that precedes the render.
    const boot = entry.indexOf('window.__VALIDITY_PERF_BOOT_MS__ = performance.now();');
    expect(boot).toBeGreaterThan(entry.indexOf("import './validity-net-bootstrap';"));
    expect(boot).toBeLessThan(entry.indexOf('window.__VALIDITY_MOCKS__ ='));
  });

  it('the bootstrap module applies the interceptors; validity-msw wires the responder', () => {
    prepareSandbox(projectRoot, baseConfig());
    const bootstrap = readFileSync(
      resolve(validityDir(projectRoot), 'validity-net-bootstrap.ts'),
      'utf-8',
    );
    const msw = readFileSync(resolve(validityDir(projectRoot), 'validity-msw.ts'), 'utf-8');

    // The interceptor classes + their .apply() now live in the bootstrap, so the
    // patch happens at module-eval time before any user module.
    expect(bootstrap).toContain("import { FetchInterceptor } from '@mswjs/interceptors/fetch'");
    expect(bootstrap).toContain(
      "import { XMLHttpRequestInterceptor } from '@mswjs/interceptors/XMLHttpRequest'",
    );
    expect(bootstrap).toContain('fetchInterceptor.apply();');
    expect(bootstrap).toContain('xhrInterceptor.apply();');
    // validity-msw no longer creates interceptors — it hands over a responder.
    expect(msw).not.toContain('new FetchInterceptor()');
    expect(msw).toContain(
      "import { wireValidityResponder, VALIDITY_HANG } from './validity-net-bootstrap'",
    );
    expect(msw).toContain('wireValidityResponder(respondTo)');
    expect(msw).toContain('export async function setupValidityNetwork(');
    // The shim tracks unmatched URLs into the global so the capture step can
    // surface them to the agent.
    expect(msw).toContain('__VALIDITY_UNMATCHED__');
    // ...and the structured mirror (request + fabricated body) that backs the
    // paste-ready handler stub.
    expect(msw).toContain('__VALIDITY_UNMATCHED_REQUESTS__');
    expect(msw).toContain('trackUnmatchedRequest(method, url, res)');
  });

  it('entry.tsx imports the net bootstrap FIRST — before the Wrapper import', () => {
    prepareSandbox(projectRoot, baseConfig());
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    const bootstrapIdx = entry.indexOf("import './validity-net-bootstrap'");
    const wrapperIdx = entry.indexOf('import Wrapper from');
    expect(bootstrapIdx).toBeGreaterThanOrEqual(0);
    expect(wrapperIdx).toBeGreaterThanOrEqual(0);
    // The interceptors must be applied before the user's provider graph (pulled
    // in by the Wrapper import) can fire a module-eval request.
    expect(bootstrapIdx).toBeLessThan(wrapperIdx);
  });

  it('validity-msw.ts stamps network provenance and freezes the request-log getter (A4)', () => {
    prepareSandbox(projectRoot, baseConfig());
    const msw = readFileSync(resolve(validityDir(projectRoot), 'validity-msw.ts'), 'utf-8');

    // The frozen closure getter: non-writable, non-configurable, defined only
    // once — the executor's tamper-proof read; the window array is a mirror.
    expect(msw).toContain("Object.defineProperty(window, '__VALIDITY_GET_REQUESTS__'");
    expect(msw).toContain('writable: false');
    expect(msw).toContain('configurable: false');
    expect(msw).toContain(
      "Object.prototype.hasOwnProperty.call(window, '__VALIDITY_GET_REQUESTS__')",
    );
    // trackRequest folds matched+permissive into the declared/fabricated stamp
    // and pushes to the closure log before mirroring.
    expect(msw).toContain("provenance: matched && !permissive ? 'declared' : 'fabricated'");
    expect(msw).toContain('__validityRequestLog.push(entry)');
    // The handler-match branch threads the config pattern through so a
    // declared verdict can cite it.
    expect(msw).toContain('trackRequest(method, url, res, true, h.url)');
    expect(msw).toContain('trackRequest(method, url, res, false)');
  });

  it('wires the forced dataState axis into entry.tsx + validity-msw.ts (A2)', () => {
    prepareSandbox(
      projectRoot,
      baseConfig({ scenarios: { 'server-down': { dataState: 'error' } } }),
    );
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');
    const msw = readFileSync(resolve(validityDir(projectRoot), 'validity-msw.ts'), 'utf-8');

    // The verify-time ?dataState= param reaches setupValidityNetwork.
    expect(entry).toContain("const dataState = params.get('dataState') ?? undefined;");
    expect(entry).toContain(
      'await setupValidityNetwork({ base: baseNetwork, scenario: scenarioNetwork, dataState });',
    );
    // A scenario-level dataState rides the serialized scenario payload.
    expect(entry).toContain(
      '"server-down":{"fallback":"populate","handlers":[],"dataState":"error"}',
    );

    // The MSW layer's forced branches precede handler matching and stamp the
    // provenance header/log field the taint path reads.
    expect(msw).toContain('const forcedRaw = args.dataState ?? args.scenario?.dataState;');
    expect(msw).toContain("const forced = forcedRaw === 'populated' ? undefined : forcedRaw;");
    expect(msw).toContain("trackForced(method, url, 0, 'loading'); // evidence first — then hang");
    expect(msw).toContain("'x-validity-datastate': 'error'");
    expect(msw).toContain("res.headers.set('x-validity-datastate', 'empty');");
    // Forced empty keeps the permissive tag (deep-default proxy + taint).
    expect(msw).toContain("res.headers.set('x-validity-permissive', '1');");
    // Forced loading: respondTo returns the shared HANG sentinel; the bootstrap's
    // single request handler turns that into a never-resolving promise (one place
    // now, shared by the fetch + XHR listeners).
    expect(msw).toContain('return VALIDITY_HANG;');
    const bootstrap = readFileSync(
      resolve(validityDir(projectRoot), 'validity-net-bootstrap.ts'),
      'utf-8',
    );
    expect(bootstrap).toContain('if (result === VALIDITY_HANG) {');
    expect(bootstrap).toContain('await new Promise<never>(() => {});');
    // The request-log entry carries the dataState the executor reads.
    expect(msw).toContain("const forcedState = response.headers.get('x-validity-datastate');");
    expect(msw).toContain('if (forcedState) entry.dataState = forcedState;');
  });

  // Regression: the in-page interceptor was swallowing the browse index's
  // fetch('/__validity/api/config') call because only '/props/' was on the
  // passthrough list. With permissive fallback (the default) that turned
  // into a silent 200 + {} and the sidebar rendered "no components found"
  // even though the Vite middleware served the data correctly to curl.
  it('validity-msw.ts marks /__validity/ as an internal passthrough so browse APIs reach Vite', () => {
    prepareSandbox(projectRoot, baseConfig());
    const msw = readFileSync(resolve(validityDir(projectRoot), 'validity-msw.ts'), 'utf-8');

    expect(msw).toMatch(/VALIDITY_INTERNAL_PATH_PREFIXES\s*=\s*\[[^\]]*['"]\/__validity\/['"]/);
    expect(msw).toMatch(/VALIDITY_INTERNAL_PATH_PREFIXES\s*=\s*\[[^\]]*['"]\/props\/['"]/);
  });

  it('index.html includes the early-error trap and dynamic entry mount', () => {
    prepareSandbox(projectRoot, baseConfig());
    const html = readFileSync(indexHtml(projectRoot), 'utf-8');

    // The error-trap script attaches a [data-validity-error] element so the
    // capture step can read the failure rather than hanging on a blank page.
    expect(html).toContain('data-validity-error');
    expect(html).toContain("addEventListener('error'");
    expect(html).toContain("addEventListener('unhandledrejection'");
    // The entry tag is injected dynamically by the seed script (so the
    // browse-mode scenario seed has a chance to plant cookies / storage
    // before React mounts). Verify mode keeps working because the script
    // is injected unconditionally when no scenario is set.
    expect(html).toContain("s.src = '/entry.tsx'");
    expect(html).toContain('/__validity/api/scenario-state');
  });

  it('serializes the base mockNetwork into entry.tsx', () => {
    const config = baseConfig({
      mockNetwork: {
        fallback: 'reject',
        handlers: [
          { url: '/api/me', json: { id: '1' } },
          { url: '/api/health', text: 'ok' },
        ],
      },
    });
    prepareSandbox(projectRoot, config);
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    // The injected JSON literal lives between `__VALIDITY_BASE_NETWORK__ = ` and `;`.
    const match = entry.match(/window\.__VALIDITY_BASE_NETWORK__ = (.+);/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!);
    expect(parsed.fallback).toBe('reject');
    expect(parsed.handlers).toEqual([
      { url: '/api/me', json: { id: '1' } },
      { url: '/api/health', text: 'ok' },
    ]);
  });

  it('serializes scenarios (without cookies/storage — those go through Playwright)', () => {
    const config = baseConfig({
      scenarios: {
        'logged-in': {
          mockNetwork: {
            cookies: { session: 'mock' },
            localStorage: { token: 'bearer' },
            handlers: [{ url: '/api/me', json: { id: '1' } }],
          },
        },
        'logged-out': {
          mockNetwork: {
            handlers: [{ url: '/api/me', status: 401 }],
          },
        },
      },
    });
    prepareSandbox(projectRoot, config);
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    const match = entry.match(/window\.__VALIDITY_SCENARIOS__ = (.+);/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!) as Record<
      string,
      { fallback: string; handlers: unknown[] }
    >;

    expect(Object.keys(parsed).sort()).toEqual(['logged-in', 'logged-out']);
    // logged-in: handlers preserved, no cookies/localStorage in browser payload.
    expect(parsed['logged-in']!.handlers).toEqual([{ url: '/api/me', json: { id: '1' } }]);
    expect(parsed['logged-in']).not.toHaveProperty('cookies');
    expect(parsed['logged-in']).not.toHaveProperty('localStorage');
    // logged-out: status-only handler kept verbatim.
    expect(parsed['logged-out']!.handlers).toEqual([{ url: '/api/me', status: 401 }]);
  });

  it('defaults fallback to populate when no mockNetwork is configured', () => {
    // Populate is the system-wide default so list/feed screens render content;
    // non-collection endpoints still get the crash-safe permissive body.
    prepareSandbox(projectRoot, baseConfig());
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    const match = entry.match(/window\.__VALIDITY_BASE_NETWORK__ = (.+);/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!);
    expect(parsed).toEqual({ fallback: 'populate', handlers: [] });
  });

  // Regression: when Vite re-optimizes deps mid-session (a lazily-discovered
  // Radix import, for example) AND HMR is suppressed, the page ends up with
  // two React module records and every hook call in a downstream lib crashes
  // with "Cannot read properties of null (reading 'useState')". Two fixes
  // landed together — `optimizeDeps.entries` to avoid the re-optimize in the
  // first place (in server.ts), AND a boot-time duplicate-React assertion
  // here so any future regression surfaces as a clear in-canvas error rather
  // than a cryptic null-dispatcher trace inside a child component.
  it('entry.tsx contains the duplicate-React boot assertion', () => {
    prepareSandbox(projectRoot, baseConfig());
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    // Both static + dynamic React must be present so the comparison runs.
    expect(entry).toMatch(/import React.*from 'react'/);
    expect(entry).toContain("await import('react')");
    expect(entry).toContain("await import('react-dom/client')");
    // The check itself and its operative branches.
    expect(entry).toContain('duplicate React detected at boot');
    expect(entry).toContain('two copies of React');
    // The error gets attributed to the sandbox layer (not the user's
    // component) so the capture step labels it correctly.
    expect(entry).toContain('data-validity-error-source="sandbox"');
  });
});

/**
 * Browse canvas: the home page (`validity-index.tsx`) is a Figma-style
 * artboard surface that arranges one iframe per fixture/state for the
 * selected component. These tests pin down two contracts:
 *
 *   1. The template emits with the named `Index` export, the canvas
 *      sentinel attribute, and the canvas wiring expected by entry.tsx.
 *   2. The LLM verify contract is untouched — entry.tsx still routes
 *      `?component=` to single / stacked render, and the Index branch
 *      only fires when no `?component=` param is set. Canvas-introduced
 *      URL params (`?canvas=`, `?focus=`, `?viewport=`) cannot bleed
 *      into the verify path.
 */
describe('browse canvas index', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectRoot();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes validity-index.tsx with the canvas sentinel and named Index export', () => {
    prepareSandbox(projectRoot, baseConfig());
    const indexPath = resolve(validityDir(projectRoot), 'validity-index.tsx');
    expect(existsSync(indexPath)).toBe(true);
    const src = readFileSync(indexPath, 'utf-8');

    // Named export consumed by entry.tsx — renaming this breaks the
    // generated entry's `import { Index } from './validity-index'`.
    expect(src).toMatch(/export function Index\s*\(/);
    // Canvas sentinel — load-bearing for any future end-to-end probe
    // that wants to wait for the canvas root specifically.
    expect(src).toContain('data-validity-canvas="true"');
    // Ready signal — same as the legacy index. Browse is never a capture
    // target, but the signal lets a future health check stay generic.
    expect(src).toContain('__validityReady');
    expect(src).toContain("setAttribute('data-validity-ready'");
  });

  it('canvas template iframes render through the verify URL contract', () => {
    prepareSandbox(projectRoot, baseConfig());
    const indexPath = resolve(validityDir(projectRoot), 'validity-index.tsx');
    const src = readFileSync(indexPath, 'utf-8');

    // Each frame URL is built with the same params verify's capture
    // step sends. If this regresses, frames in the canvas would diverge
    // from the verify screenshots.
    expect(src).toMatch(/buildFrameUrl\s*\(/);
    expect(src).toMatch(/p\.set\(['"]component['"],/);
    expect(src).toMatch(/p\.set\(['"]fixture['"],/);
    expect(src).toMatch(/p\.set\(['"]scenario['"],/);
  });

  it('entry.tsx Index branch only fires when ?component= is absent', () => {
    prepareSandbox(projectRoot, baseConfig());
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    // The component branch is the verify path — it must continue to
    // dispatch on params.get('component') before falling through to
    // the Index render.
    expect(entry).toContain("params.get('component')");
    // Both single and stacked render paths still exist.
    expect(entry).toContain("'ready-single'");
    expect(entry).toContain("'ready-stacked'");
    // Canvas URL params live in a disjoint namespace — they exist only
    // in the Index template, never in entry.tsx's dispatch logic.
    expect(entry).not.toContain("params.get('canvas')");
    expect(entry).not.toContain("params.get('focus')");
    expect(entry).not.toContain("params.get('viewport')");
  });

  it('does not change the single / stacked verify dispatch when canvas params are present', () => {
    prepareSandbox(projectRoot, baseConfig());
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    // The dispatch order matters: if no `component`, render Index;
    // otherwise resolve loader + dispatch by `fixtures` (stacked) or
    // propsId (single). Asserting both the absence of a canvas-aware
    // branch AND the presence of the original branches catches any
    // accidental coupling between the two.
    expect(entry).toMatch(/if\s*\(\s*!componentPath\s*\)\s*\{/);
    expect(entry).toMatch(/stackedNames\.length\s*>\s*0/);
    expect(entry).toMatch(/Promise\.all\(\s*\[loader\(\)/);
  });

  // Regression: previously every auto-discovered .tsx got iframe-rendered
  // with empty props, which produced "Cannot read properties of undefined"
  // crashes for any component requiring required props (the user's
  // chart components were the canonical case). The canvas now renders
  // a placeholder card instead when neither fixtures nor explicit
  // default props are configured — the iframe simply doesn't mount.
  it('skips iframe auto-render for components without fixtures or default props', () => {
    prepareSandbox(projectRoot, baseConfig());
    const indexPath = resolve(validityDir(projectRoot), 'validity-index.tsx');
    const src = readFileSync(indexPath, 'utf-8');

    // The placeholder card is the visual stand-in when neither fixtures
    // nor default props exist for the focused component.
    expect(src).toMatch(/function PlaceholderCard\s*\(/);
    // Detail view honors the predicate inline (showPlaceholder).
    expect(src).toMatch(/showPlaceholder/);
  });

  it('exposes the three built-in viewports (Desktop, Tablet, Mobile)', () => {
    prepareSandbox(projectRoot, baseConfig());
    const indexPath = resolve(validityDir(projectRoot), 'validity-index.tsx');
    const src = readFileSync(indexPath, 'utf-8');

    // Per-component viewport toggle: D (desktop) is the default,
    // Tablet (768×1024) and Mobile (375×667) are alternates.
    expect(src).toMatch(/desktop:\s*\{\s*key:\s*['"]desktop['"]/);
    expect(src).toMatch(/tablet:\s*\{\s*key:\s*['"]tablet['"]/);
    expect(src).toMatch(/mobile:\s*\{\s*key:\s*['"]mobile['"]/);
    expect(src).toContain('width: 1280');
    expect(src).toContain('width: 768');
    expect(src).toContain('width: 375');
    // Viewport is single-select post-redesign: Desktop is the default
    // selection on first visit (Tablet / Mobile are switched-to alternates).
    expect(src).toMatch(/new Set\(\[['"]desktop['"]\]\)/);
  });

  it('exposes an inspector flyout for the focused component', () => {
    prepareSandbox(projectRoot, baseConfig());
    const indexPath = resolve(validityDir(projectRoot), 'validity-index.tsx');
    const src = readFileSync(indexPath, 'utf-8');

    // Inspector flyout — the slide-over rail on the right of the canvas
    // that renders the active component's metadata, or, when an element
    // is pinned, its DevTools-style measurements + jump-to-component.
    expect(src).toMatch(/function InspectorFlyout\s*\(/);
    expect(src).toMatch(/function PinnedElementPanel\s*\(/);
    expect(src).toMatch(/function ComponentSummary\s*\(/);
    // Sections we surface for a component: Fixtures, Scenarios, Used in
    // this screen, Flows.
    expect(src).toContain('Fixtures');
    expect(src).toContain('Scenarios');
    expect(src).toContain('Used in this screen');
    expect(src).toContain('Flows');
  });

  it('wires the in-iframe inspector via postMessage', () => {
    prepareSandbox(projectRoot, baseConfig());
    const indexPath = resolve(validityDir(projectRoot), 'validity-index.tsx');
    const src = readFileSync(indexPath, 'utf-8');

    // The parent canvas talks to each iframe via postMessage — enable
    // / disable / clear-selection / theme. The message strings here are
    // the contract validity-inspector.ts listens for.
    expect(src).toContain('validity:inspect:enable');
    expect(src).toContain('validity:inspect:disable');
    expect(src).toContain('validity:inspect:clear-selection');
    expect(src).toContain('validity:theme:set');
    expect(src).toMatch(/broadcastToFrames\s*\(/);
  });

  it('uses URL state for detail-view focus + design-tool toggles', () => {
    prepareSandbox(projectRoot, baseConfig());
    const indexPath = resolve(validityDir(projectRoot), 'validity-index.tsx');
    const src = readFileSync(indexPath, 'utf-8');

    // Every cross-session knob lives in the URL so links are shareable.
    expect(src).toMatch(/p\.get\(['"]focus['"]\)/);
    expect(src).toMatch(/p\.get\(['"]inspect['"]\)/);
    expect(src).toMatch(/p\.get\(['"]fullscreen['"]\)/);
    expect(src).toMatch(/p\.get\(['"]theme['"]\)/);
    expect(src).toMatch(/p\.get\(['"]bg['"]\)/);
    expect(src).toMatch(/p\.get\(['"]flyout['"]\)/);
    expect(src).toMatch(/p\.get\(['"]scenario['"]\)/);
  });

  // Regression: previously the iframe was held at opacity:0 until
  // onLoad fired and onError was missing. With slow/failed loads the
  // shimmer + opacity combo could leave a frame permanently invisible.
  // The fix is onError mirroring onLoad to drop the shimmer.
  it('iframe load failures still resolve the shimmer (onError mirrors onLoad)', () => {
    prepareSandbox(projectRoot, baseConfig());
    const indexPath = resolve(validityDir(projectRoot), 'validity-index.tsx');
    const src = readFileSync(indexPath, 'utf-8');

    // onError mirrors onLoad so a failed iframe load doesn't leave
    // the shimmer up forever.
    expect(src).toMatch(/onError=\{\(\)\s*=>\s*setLoaded\(true\)\}/);
  });

  // The browse template ships a sibling validity-inspector.ts module
  // that the entry.tsx imports. Smoke-test that prepareSandbox writes
  // it to .validity/ so Vite can resolve the import at runtime.
  it('writes validity-inspector.ts alongside the entry', () => {
    prepareSandbox(projectRoot, baseConfig());
    const inspectorPath = resolve(validityDir(projectRoot), 'validity-inspector.ts');
    expect(existsSync(inspectorPath)).toBe(true);
    const src = readFileSync(inspectorPath, 'utf-8');
    expect(src).toMatch(/export function startValidityInspector\s*\(/);
    // The inspector is idle until the parent posts an enable message
    // — verify the gate is present so verify mode doesn't get
    // overlays painted on it.
    expect(src).toContain('window.parent === window');
  });
});
