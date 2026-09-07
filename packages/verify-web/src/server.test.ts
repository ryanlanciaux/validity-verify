/**
 * Regression test for the SPA-fallback bug: Vite's spaFallbackMiddleware
 * was eating /__validity/api/* requests and returning index.html. The
 * fix routes the middlewares through a configureServer plugin so they
 * install BEFORE Vite's catch-all. Boot a real server (no Playwright)
 * and assert the three endpoints return JSON, plus / still works.
 */
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ValidityConfig } from '@validity.ai/verify-spec';
import {
  depScanAbortBanner,
  depScanFailureModuleSource,
  isDepScanFailureLog,
  isEsbuildBuildFailure,
  startDevServer,
  summarizeDepScanFailure,
  workspaceRendersReactUi,
  type DevServer,
} from './server.js';
import { prepareSandbox } from './prepare.js';

const VALIDITY_CONFIG: ValidityConfig = {
  renderMode: 'web',
  framework: 'vite',
  wrapper: './.validity/wrapper.tsx',
  components: {
    'src/Button.tsx': {
      props: { label: 'Hi' },
      fixtures: {
        primary: { props: { label: 'Primary' } },
      },
    },
  },
  scenarios: {
    'logged-in': {
      mockNetwork: {
        cookies: { session: 'mock-session' },
        localStorage: { token: 'abc' },
        handlers: [{ url: '/api/me', json: { id: '1' } }],
      },
    },
  },
};

const BUTTON_SOURCE = `import React from 'react';
export default function Button({ label }: { label?: string }) {
  return <button>{label ?? 'Click'}</button>;
}
`;

const WRAPPER_SOURCE = `import React, { type ReactNode } from 'react';
export default function Wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
`;

function setupProject(): string {
  const projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-server-test-'));
  writeFileSync(
    resolve(projectRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'server-test-fixture',
        private: true,
        type: 'module',
        dependencies: { vite: '6.0.7' },
      },
      null,
      2,
    ),
  );
  mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
  writeFileSync(resolve(projectRoot, '.validity/wrapper.tsx'), WRAPPER_SOURCE);
  mkdirSync(resolve(projectRoot, 'src'), { recursive: true });
  writeFileSync(resolve(projectRoot, 'src/Button.tsx'), BUTTON_SOURCE);
  prepareSandbox(projectRoot, VALIDITY_CONFIG);
  return projectRoot;
}

describe('startDevServer — browse API routes survive Vite SPA fallback', () => {
  let projectRoot: string;
  let dev: DevServer | undefined;

  beforeEach(() => {
    projectRoot = setupProject();
  });

  afterEach(async () => {
    if (dev) {
      try {
        await dev.close();
      } catch {
        /* ignore */
      }
      dev = undefined;
    }
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('guards browse reads/writes and restricts props to physical catalog files', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });
    const api = `${dev.url}/__validity/api`;
    for (const origin of ['null', 'https://evil.example']) {
      expect((await fetch(`${api}/config`, { headers: { origin } })).status).toBe(403);
      for (const route of ['fixture', 'views', 'component-scenarios', 'invalidate']) {
        expect(
          (
            await fetch(`${api}/${route}`, {
              method: 'POST',
              headers: { origin, 'content-type': 'application/json' },
              body: '{}',
            })
          ).status,
        ).toBe(403);
      }
    }
    expect((await fetch(`${api}/fixture`, { method: 'POST', body: '{}' })).status).toBe(415);
    expect((await fetch(`${api}/config`, { headers: { origin: dev.url } })).status).toBe(200);
    const outside = mkdtempSync(resolve(tmpdir(), 'validity-outside-props-'));
    try {
      writeFileSync(
        resolve(outside, 'Outside.tsx'),
        'export default function Outside(p: { PRIVATE_SENTINEL: string }) { return null; }',
      );
      symlinkSync(resolve(outside, 'Outside.tsx'), resolve(projectRoot, 'src/Linked.tsx'));
      symlinkSync(outside, resolve(projectRoot, 'src/linked-parent'));
      writeFileSync(
        resolve(projectRoot, 'uncatalogued.txt'),
        'type Props = { PRIVATE_SENTINEL: string };',
      );
      for (const path of [
        resolve(outside, 'Outside.tsx'),
        `../${outside.split('/').pop()}/Outside.tsx`,
        'src/Linked.tsx',
        'src/linked-parent/Outside.tsx',
        'uncatalogued.txt',
      ]) {
        const response = await fetch(`${api}/props?component=${encodeURIComponent(path)}`);
        expect(response.status, path).toBe(403);
        expect(await response.text()).not.toContain('PRIVATE_SENTINEL');
      }
      const response = await fetch(`${api}/props?component=src/Button.tsx`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('label');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);

  it('GET /__validity/api/config returns JSON, not index.html (bug: SPA fallback was masking)', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    const res = await fetch(`${dev.url}/__validity/api/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);

    const body = (await res.json()) as {
      components?: Record<string, unknown>;
      scenarios?: Record<string, unknown>;
    };
    // The explicit component from config survives the merge.
    expect(body.components?.['src/Button.tsx']).toBeDefined();
    // Scenarios survive the merge too.
    expect(body.scenarios?.['logged-in']).toBeDefined();
  }, 30_000);

  it('GET /__validity/api/scenario-state returns the scenario cookies / storage', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    const res = await fetch(`${dev.url}/__validity/api/scenario-state?name=logged-in`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);

    const body = (await res.json()) as {
      cookies: Record<string, string>;
      localStorage: Record<string, string>;
      sessionStorage: Record<string, string>;
    };
    expect(body.cookies.session).toBe('mock-session');
    expect(body.localStorage.token).toBe('abc');
  }, 30_000);

  it('POST /__validity/api/fixture writes a fixture and returns { ok: true }', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    // Seed a real .validity/config.ts so the writer has something to mutate.
    // The fixture writer falls back to a JSON sidecar if the config isn't
    // editable; either path returns ok:true.
    writeFileSync(
      resolve(projectRoot, '.validity/config.ts'),
      `import { defineConfig } from '@validity.ai/verify-spec';
export default defineConfig({
  renderMode: 'web',
  framework: 'vite',
  wrapper: './.validity/wrapper.tsx',
  components: {
    'src/Button.tsx': { props: { label: 'Hi' } },
  },
});
`,
    );

    const res = await fetch(`${dev.url}/__validity/api/fixture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        componentPath: 'src/Button.tsx',
        fixtureName: 'danger',
        props: { variant: 'danger' },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);

    const body = (await res.json()) as { ok: boolean; writtenTo?: string; mode?: string };
    expect(body.ok).toBe(true);
    expect(body.writtenTo).toBeTruthy();
    // The writer landed something on disk — either the config or a sidecar.
    expect(readFileSync(body.writtenTo!, 'utf-8').length).toBeGreaterThan(0);
  }, 30_000);

  it('GET / still returns the sandbox HTML shell (SPA fallback still works for the actual index)', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    const res = await fetch(`${dev.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/text\/html/);
    const body = await res.text();
    // The shell has <div id="root"> from prepare.ts's INDEX_HTML_SOURCE.
    expect(body).toContain('id="root"');
  }, 30_000);

  it('POST /__validity/api/fixture rejects non-POST methods cleanly (regression: would 200 with HTML before the fix)', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    const res = await fetch(`${dev.url}/__validity/api/fixture`);
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type') ?? '').toMatch(/application\/json/);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/method not allowed/i);
  }, 30_000);

  // Regression: a fixture with a Radix-style (lazily-imported, React-hook-
  // calling) library blew up the browse canvas with "Cannot read properties
  // of null (reading 'useState')" because Vite re-optimized deps mid-session
  // and HMR was off, so the page kept stale React module URLs alive. We can't
  // pull Radix into the test workspace, but we CAN assert that the resolved
  // Vite config wires the two prerequisites for the fix: dep-discovery at
  // boot (entries) and a working HMR socket (no `hmr: false` override).
  it('optimizeDeps.entries walks the user source tree and HMR socket is not disabled', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    const cfg = dev.server.config;
    const entries = cfg.optimizeDeps?.entries;
    expect(entries).toBeDefined();
    const list = Array.isArray(entries) ? entries : [entries!];
    // The user's source tree is in the scan — this is the load-bearing entry.
    expect(list.some((p) => typeof p === 'string' && p.includes('/**/*.{'))).toBe(true);
    // Sandbox entries are also listed (explicit absolute paths) so they're
    // not skipped by the node_modules negation.
    expect(list.some((p) => typeof p === 'string' && p.endsWith('/entry.tsx'))).toBe(true);

    // include now covers the React subpaths a dev-mode @vitejs/plugin-react
    // setup pulls in, AND the bare react-dom spec libs sometimes reach for.
    const include = cfg.optimizeDeps?.include ?? [];
    expect(include).toContain('react');
    expect(include).toContain('react/jsx-runtime');
    expect(include).toContain('react/jsx-dev-runtime');
    expect(include).toContain('react-dom');
    expect(include).toContain('react-dom/client');

    // The pre-fix code set `server.hmr: false`, which suppressed the
    // full-reload that recovers from mid-session re-optimization. With HMR
    // alive Vite normalizes it to an object with a port assignment (it
    // does NOT keep the user-supplied `true` literal). The only failure
    // mode we care about is the explicit `false`.
    expect(cfg.server.hmr).not.toBe(false);

    // Browse mode opts OUT of HMR suppression — the design-plane iframes
    // are meant to refresh as the user (or an LLM) edits component source.
    // Verify mode is the path that needs the suppression (covered by a
    // separate test below).
    const pluginNames = cfg.plugins.map((p) => (p as { name?: string })?.name ?? '');
    expect(pluginNames).not.toContain('validity:suppress-user-hmr');
  }, 30_000);

  // Views API regression tests — cover the four touchpoints of the views
  // surface so the collision-handling + persistence stays glued together:
  //   1. GET /__validity/api/config surfaces _views.views[] (palette source).
  //   2. POST /__validity/api/views happy path writes and reflects in config.
  //   3. POST 409 on hard collision (name matches a discovered component path).
  //   4. POST 409 on soft collision (existing view); 200 with `force: true`.
  //   5. DELETE removes the view.
  it('GET /__validity/api/config surfaces _views from the running config', async () => {
    dev = await startDevServer(projectRoot, {
      persist: true,
      config: {
        ...VALIDITY_CONFIG,
        views: {
          overview: {
            title: 'Overview',
            items: [{ componentPath: 'src/Button.tsx', props: { label: 'Hi' } }],
          },
        },
      },
    });

    const res = await fetch(`${dev.url}/__validity/api/config`);
    const body = (await res.json()) as {
      _views?: { views: Array<{ name: string; title?: string; items: unknown[] }> };
    };
    expect(body._views?.views).toBeDefined();
    expect(body._views!.views).toHaveLength(1);
    expect(body._views!.views[0]?.name).toBe('overview');
    expect(body._views!.views[0]?.title).toBe('Overview');
    expect(body._views!.views[0]?.items).toHaveLength(1);
  }, 30_000);

  it('POST /__validity/api/views writes a new view and surfaces it on the next GET', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    // Seed a real config so the writer has something to mutate.
    writeFileSync(
      resolve(projectRoot, '.validity/config.ts'),
      `import { defineConfig } from '@validity.ai/verify-spec';
export default defineConfig({
  renderMode: 'web',
  framework: 'vite',
  wrapper: './.validity/wrapper.tsx',
  components: { 'src/Button.tsx': { props: { label: 'Hi' } } },
});
`,
    );

    const res = await fetch(`${dev.url}/__validity/api/views`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'my-view',
        view: {
          title: 'My View',
          items: [{ componentPath: 'src/Button.tsx', props: { label: 'New' } }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; writtenTo?: string; mode?: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('ast');

    // Now the GET reflects the new view (the server hot-updates its config).
    const cfgRes = await fetch(`${dev.url}/__validity/api/config`);
    const cfgBody = (await cfgRes.json()) as {
      _views?: { views: Array<{ name: string }> };
    };
    expect(cfgBody._views?.views.find((v) => v.name === 'my-view')).toBeDefined();
  }, 30_000);

  // Path-like view names are rejected at the validation gate (the writer
  // quotes them just fine, but a name with `/` or `.` is almost certainly
  // an agent confusing "view" with "component" — surface that as a 400 so
  // the LLM picks a human-friendly name). This is the *only* practical
  // way a component-path collision could surface, so the validation gate
  // doubles as the test for it.
  it('POST /__validity/api/views rejects a path-like view name (would shadow a component path)', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    const res = await fetch(`${dev.url}/__validity/api/views`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'src/Button.tsx',
        view: { items: [{ componentPath: 'src/Button.tsx' }] },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/alphanumeric/i);
  }, 30_000);

  it('POST /__validity/api/views rejects an existing view name without force, accepts with force', async () => {
    dev = await startDevServer(projectRoot, {
      persist: true,
      config: {
        ...VALIDITY_CONFIG,
        views: {
          existing: { items: [{ componentPath: 'src/Button.tsx' }] },
        },
      },
    });
    writeFileSync(
      resolve(projectRoot, '.validity/config.ts'),
      `import { defineConfig } from '@validity.ai/verify-spec';
export default defineConfig({
  renderMode: 'web',
  framework: 'vite',
  wrapper: './.validity/wrapper.tsx',
  views: { existing: { items: [{ componentPath: 'src/Button.tsx' }] } },
});
`,
    );

    // Without force → 409.
    const collidesRes = await fetch(`${dev.url}/__validity/api/views`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'existing',
        view: { items: [{ componentPath: 'src/Button.tsx' }] },
      }),
    });
    expect(collidesRes.status).toBe(409);
    const collidesBody = (await collidesRes.json()) as {
      collisions?: Array<{ kind: string }>;
    };
    expect(collidesBody.collisions?.some((c) => c.kind === 'view')).toBe(true);

    // With force=true → 200 and the view gets rewritten.
    const forceRes = await fetch(`${dev.url}/__validity/api/views`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'existing',
        view: { title: 'Overwritten', items: [{ componentPath: 'src/Button.tsx' }] },
        force: true,
      }),
    });
    expect(forceRes.status).toBe(200);
  }, 30_000);

  it('DELETE /__validity/api/views?name=… removes a view from the config', async () => {
    dev = await startDevServer(projectRoot, {
      persist: true,
      config: {
        ...VALIDITY_CONFIG,
        views: {
          temp: { items: [{ componentPath: 'src/Button.tsx' }] },
        },
      },
    });
    writeFileSync(
      resolve(projectRoot, '.validity/config.ts'),
      `import { defineConfig } from '@validity.ai/verify-spec';
export default defineConfig({
  renderMode: 'web',
  framework: 'vite',
  wrapper: './.validity/wrapper.tsx',
  views: { temp: { items: [{ componentPath: 'src/Button.tsx' }] } },
});
`,
    );

    const res = await fetch(`${dev.url}/__validity/api/views?name=temp`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // GET no longer surfaces it.
    const cfgRes = await fetch(`${dev.url}/__validity/api/config`);
    const cfgBody = (await cfgRes.json()) as { _views?: { views: Array<{ name: string }> } };
    expect(cfgBody._views?.views.find((v) => v.name === 'temp')).toBeUndefined();
  }, 30_000);

  it('POST /__validity/api/views rejects a payload with empty items', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    const res = await fetch(`${dev.url}/__validity/api/views`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad', view: { items: [] } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/items/i);
  }, 30_000);

  // Counterpart to the previous test: in verify mode (no config passed)
  // the suppress plugin IS installed, so Playwright's one-shot screenshot
  // path isn't yanked out from under itself by a mid-capture file change.
  it('verify mode installs validity:suppress-user-hmr', async () => {
    dev = await startDevServer(projectRoot, { persist: true });

    const cfg = dev.server.config;
    const pluginNames = cfg.plugins.map((p) => (p as { name?: string })?.name ?? '');
    expect(pluginNames).toContain('validity:suppress-user-hmr');
  }, 30_000);

  // Regression: in monorepo layouts (apps/*, packages/*) the original
  // exclusion patterns were anchored at the project root — `${root}/node_modules/**`
  // — which let the esbuild scanner walk into `apps/web/node_modules/`,
  // `apps/api/node_modules/`, etc. Symptoms in the field:
  //
  //   "Failed to resolve entry for package 'devtools-protocol'"
  //   "The constant 'version' must be initialized"  (from @types/*.d.ts)
  //   "Failed to resolve entry for package 'undici-types'"
  //
  // The fix: nested-glob the exclusions (`** /node_modules/**`) AND
  // exclude `*.d.ts` outright, since declaration files match the `.ts`
  // include pattern but esbuild can't parse them as implementation.
  // This test pins both pieces so the regression can't sneak back in.
  it('optimizeDeps.entries excludes nested node_modules and .d.ts files (monorepo regression)', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    const cfg = dev.server.config;
    const entries = cfg.optimizeDeps?.entries;
    const list = (Array.isArray(entries) ? entries : [entries!]).filter(
      (p): p is string => typeof p === 'string',
    );

    // Nested node_modules — the load-bearing fix. The negation pattern
    // must NOT be anchored at the root (`!${root}/node_modules/**`)
    // because that would only catch the top-level node_modules; nested
    // ones under apps/* and packages/* would still be walked.
    const hasNestedNm = list.some((p) => p.includes('**/node_modules/**') && p.startsWith('!'));
    expect(hasNestedNm).toBe(true);

    // .d.ts exclusion. `export const X: T;` (no initializer) is valid
    // declaration-only syntax but esbuild parses it as implementation
    // and emits "must be initialized".
    const hasDtsExclude = list.some((p) => p.endsWith('/*.d.ts') && p.startsWith('!'));
    expect(hasDtsExclude).toBe(true);

    // The other heavyweight dirs are nested-globbed too. Catch dist/,
    // build/, and .next/ in particular — they appear under apps/* in
    // every monorepo layout.
    const hasNestedDist = list.some((p) => p.includes('**/dist/**') && p.startsWith('!'));
    const hasNestedBuild = list.some((p) => p.includes('**/build/**') && p.startsWith('!'));
    const hasNestedNext = list.some((p) => p.includes('**/.next/**') && p.startsWith('!'));
    expect(hasNestedDist).toBe(true);
    expect(hasNestedBuild).toBe(true);
    expect(hasNestedNext).toBe(true);
  }, 30_000);

  // Regression: native-binding `.node` files were tripping the optimizer
  // scan whenever a server-only sibling package (apps/api/, etc.) was in
  // the import graph — better-sqlite3 → @mapbox/node-pre-gyp → fsevents
  // → @resvg/resvg-js/*.darwin-arm64.node would hit esbuild's "No loader
  // is configured for '.node' files" path and kill the dev server boot.
  // The fix maps `.node` to `empty` in optimizeDeps.esbuildOptions.loader.
  it('optimizeDeps.esbuildOptions maps .node files to empty loader', async () => {
    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    const cfg = dev.server.config;
    const loader = cfg.optimizeDeps?.esbuildOptions?.loader;
    expect(loader).toBeDefined();
    expect(loader!['.node']).toBe('empty');
  }, 30_000);

  // Regression: in pnpm/yarn/npm monorepos with sibling workspace packages
  // (apps/api/, services/worker/, etc.) that don't depend on React, the
  // broad `**/*.{tsx,ts,…}` scan was pulling those files in as entries
  // and esbuild was following `require('better-sqlite3')` into native
  // bindings. The fix detects workspace packages and excludes those that
  // don't declare React in any dep bucket.
  it('optimizeDeps.entries excludes workspace packages that do not depend on React', async () => {
    // Convert the fixture into a pnpm monorepo with a server-only sibling.
    writeFileSync(resolve(projectRoot, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n");
    mkdirSync(resolve(projectRoot, 'apps/api'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, 'apps/api/package.json'),
      JSON.stringify({
        name: 'api',
        dependencies: { 'better-sqlite3': '*' },
      }),
    );
    mkdirSync(resolve(projectRoot, 'apps/web'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, 'apps/web/package.json'),
      JSON.stringify({
        name: 'web',
        dependencies: { react: '*' },
      }),
    );

    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });
    const cfg = dev.server.config;
    const entries = cfg.optimizeDeps?.entries;
    const list = (Array.isArray(entries) ? entries : [entries!]).filter(
      (p): p is string => typeof p === 'string',
    );

    // The non-React workspace gets a directory exclusion …
    const apiExcluded = list.some(
      (p) => p.startsWith('!') && p.includes('/apps/api/') && p.endsWith('/**'),
    );
    expect(apiExcluded).toBe(true);

    // … and the React workspace does NOT (so its components still get
    // discovered statically and don't trigger mid-session re-optimization).
    const webExcluded = list.some(
      (p) => p.startsWith('!') && p.includes('/apps/web/') && p.endsWith('/**'),
    );
    expect(webExcluded).toBe(false);
  }, 30_000);

  // Phase 1.5 — Screens & Flows. The config endpoint grows a `_screens`
  // envelope carrying every discovered + explicit screen path plus the
  // resolved navigation graph (cubic-bezier arrows in the canvas). Screens
  // ALSO merge into `components` so the existing iframe-render and
  // fixture-write paths keep working unchanged.
  it('GET /__validity/api/config surfaces _screens.screens and _screens.navigation for Next-style page files', async () => {
    // Write two Next.js App Router screens with a Link between them. The
    // dashboard page links to /settings — buildNavigationGraph should
    // resolve that to the settings page's file path.
    mkdirSync(resolve(projectRoot, 'app/dashboard'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, 'app/dashboard/page.tsx'),
      `import React from 'react';
import { Link } from 'react-router-dom';
export default function Dashboard() {
  return <div><Link to="/settings">Go to settings</Link></div>;
}
`,
    );
    mkdirSync(resolve(projectRoot, 'app/settings'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, 'app/settings/page.tsx'),
      `import React from 'react';
export default function Settings() {
  return <div>Settings</div>;
}
`,
    );

    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });

    const res = await fetch(`${dev.url}/__validity/api/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      components?: Record<string, unknown>;
      _screens?: {
        screens: Array<{ path: string; routePath?: string }>;
        navigation: Array<{
          from: string;
          to: string;
          toPath: string;
          trigger: string;
          line: number;
          column: number;
        }>;
      };
    };

    // Both screens show up in `_screens.screens` (sorted by path).
    const screenPaths = body._screens?.screens.map((s) => s.path) ?? [];
    expect(screenPaths).toEqual(
      expect.arrayContaining(['app/dashboard/page.tsx', 'app/settings/page.tsx']),
    );

    // The discovered routePath survives the merge — Next.js conventions
    // give us `/dashboard` and `/settings` from the folder structure.
    const dashboardScreen = body._screens?.screens.find((s) => s.path === 'app/dashboard/page.tsx');
    const settingsScreen = body._screens?.screens.find((s) => s.path === 'app/settings/page.tsx');
    expect(dashboardScreen?.routePath).toBe('/dashboard');
    expect(settingsScreen?.routePath).toBe('/settings');

    // Exactly one resolved edge — dashboard → settings via `<Link to>`.
    expect(body._screens?.navigation).toHaveLength(1);
    const edge = body._screens!.navigation[0]!;
    expect(edge.from).toBe('app/dashboard/page.tsx');
    expect(edge.to).toBe('/settings');
    expect(edge.toPath).toBe('app/settings/page.tsx');
    expect(edge.trigger).toBe('<Link to>');

    // Screens fold into the components map too — existing render / fixture
    // URLs keep working unchanged.
    expect(body.components?.['app/dashboard/page.tsx']).toBeDefined();
    expect(body.components?.['app/settings/page.tsx']).toBeDefined();
  }, 40_000);

  it('GET /__validity/api/config picks up explicit screens (non-conventional location) with a pinned routePath', async () => {
    // Write a screen file in a non-conventional location — no Next.js
    // app/, no pages/, no *Page.tsx suffix, no src/screens/ folder. The
    // user pins it via `screens` in config with an explicit routePath.
    mkdirSync(resolve(projectRoot, 'src/custom'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, 'src/custom/Landing.tsx'),
      `import React from 'react';
export default function Landing() {
  return <div>Landing</div>;
}
`,
    );

    const configWithExplicitScreen: ValidityConfig = {
      ...VALIDITY_CONFIG,
      screens: {
        'src/custom/Landing.tsx': { routePath: '/' },
      },
    };

    dev = await startDevServer(projectRoot, {
      persist: true,
      config: configWithExplicitScreen,
    });

    const res = await fetch(`${dev.url}/__validity/api/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      components?: Record<string, unknown>;
      screens?: Record<string, { routePath?: string }>;
      _screens?: {
        screens: Array<{ path: string; routePath?: string }>;
        navigation: unknown[];
      };
    };

    // The explicit screen is in `_screens.screens`.
    const landing = body._screens?.screens.find((s) => s.path === 'src/custom/Landing.tsx');
    expect(landing).toBeDefined();

    // It also surfaces under the `components` map (so the render path works).
    expect(body.components?.['src/custom/Landing.tsx']).toBeDefined();

    // The pinned routePath survives the merge — both on the top-level
    // `screens` map and inside the `_screens` envelope.
    expect(body.screens?.['src/custom/Landing.tsx']?.routePath).toBe('/');
    expect(landing?.routePath).toBe('/');
  }, 40_000);

  // Regression: gitignored scratch directories (abandoned design-tool
  // exports, old experiments) had their own index.html + components with
  // unsatisfied imports. Vite's default `optimizeDeps.entries` includes
  // `**/*.html`, so any leftover `tmp/old-demo/index.html` was enough to
  // break dep optimization. The fix honors the project's .gitignore
  // when building the entries glob.
  it('optimizeDeps.entries honors .gitignore (excludes gitignored dirs from the scan)', async () => {
    writeFileSync(resolve(projectRoot, '.gitignore'), 'tmp/\nscratch-experiments/\n*.log\n');

    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });
    const cfg = dev.server.config;
    const entries = cfg.optimizeDeps?.entries;
    const list = (Array.isArray(entries) ? entries : [entries!]).filter(
      (p): p is string => typeof p === 'string',
    );

    // Unanchored directory exclusion (matches anywhere in the tree).
    const tmpExcluded = list.some((p) => p.startsWith('!') && p.includes('/**/tmp/**'));
    expect(tmpExcluded).toBe(true);

    const scratchExcluded = list.some(
      (p) => p.startsWith('!') && p.includes('/**/scratch-experiments/**'),
    );
    expect(scratchExcluded).toBe(true);

    // Unanchored file pattern.
    const logExcluded = list.some((p) => p.startsWith('!') && p.endsWith('/**/*.log'));
    expect(logExcluded).toBe(true);
  }, 30_000);

  // Regression: build-tooling configs at the project root (eslint.config.js,
  // vite.config.ts, tailwind.config.js, …) match the broad `**/*.{ts,js,…}`
  // include, so esbuild's dep pre-scan walked them and followed their
  // imports into devDependencies that aren't resolvable in a browser (real
  // case: eslint.config.js importing an uninstalled eslint-plugin-storybook).
  // The scan then errors, dep discovery comes back incomplete, deps get
  // optimized lazily mid-session, and each "new dependencies optimized"
  // reload swaps the React module instance mid-render → "Invalid hook call".
  //
  // The exclusion must be anchored at root/workspace-root level: app source
  // that merely has "config" in its name deeper in the tree is render-path
  // code and still needs to be scanned. Both directions are pinned here.
  it('optimizeDeps.entries excludes root tooling configs but keeps nested src config modules', async () => {
    // Tooling configs at the project root — must NOT be scanned.
    writeFileSync(resolve(projectRoot, 'eslint.config.js'), 'export default [];\n');
    writeFileSync(resolve(projectRoot, 'vite.config.ts'), 'export default {};\n');
    writeFileSync(resolve(projectRoot, 'tailwind.config.js'), 'export default {};\n');
    writeFileSync(resolve(projectRoot, '.eslintrc.js'), 'module.exports = {};\n');

    // Application source that merely has "config" in its name — MUST still
    // be scanned, otherwise its imports go undiscovered and we reintroduce
    // the exact mid-session re-optimization this fix removes.
    mkdirSync(resolve(projectRoot, 'src/lib'), { recursive: true });
    writeFileSync(resolve(projectRoot, 'src/lib/config.ts'), 'export const config = {};\n');
    mkdirSync(resolve(projectRoot, 'src/config'), { recursive: true });
    writeFileSync(resolve(projectRoot, 'src/config/routes.ts'), 'export const routes = [];\n');

    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });
    const cfg = dev.server.config;
    const entries = cfg.optimizeDeps?.entries;
    const list = (Array.isArray(entries) ? entries : [entries!]).filter(
      (p): p is string => typeof p === 'string',
    );

    // Root-anchored exclusions are present …
    const hasConfigExclude = list.some((p) => p.endsWith('/*.config.{js,cjs,mjs,ts,cts,mts}'));
    expect(hasConfigExclude).toBe(true);
    const hasDotrcExclude = list.some((p) => p.endsWith('/.*rc.{js,cjs,mjs,ts,cts,mts}'));
    expect(hasDotrcExclude).toBe(true);

    // … and are NOT depth-globbed (`**/*.config.*` would swallow
    // src/lib/config.ts along with the root tooling files).
    expect(list.some((p) => p.startsWith('!') && p.includes('**/*.config.'))).toBe(false);

    // Now assert the real outcome by running the patterns: the scan set is
    // the include globs minus the `!` exclusions (tinyglobby negation
    // semantics, which is how Vite consumes this list).
    const includes = list.filter((p) => !p.startsWith('!'));
    const excludes = list.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
    const matched = new Set(includes.flatMap((p) => globSync(p)));
    for (const file of excludes.flatMap((p) => globSync(p))) matched.delete(file);
    const scanned = [...matched].map((f) => f.replace(/\\/g, '/'));

    // Excluded direction.
    expect(scanned.some((f) => f.endsWith('/eslint.config.js'))).toBe(false);
    expect(scanned.some((f) => f.endsWith('/vite.config.ts'))).toBe(false);
    expect(scanned.some((f) => f.endsWith('/tailwind.config.js'))).toBe(false);
    expect(scanned.some((f) => f.endsWith('/.eslintrc.js'))).toBe(false);

    // Included direction — the sanity check that keeps this from being a
    // blunt `*config*` exclusion.
    expect(scanned.some((f) => f.endsWith('/src/lib/config.ts'))).toBe(true);
    expect(scanned.some((f) => f.endsWith('/src/config/routes.ts'))).toBe(true);
    expect(scanned.some((f) => f.endsWith('/src/Button.tsx'))).toBe(true);
  }, 30_000);

  // Regression (second instance of the same bug class): Node-side test /
  // E2E scripts also match the broad `**/*.{ts,js,…}` include. Real case:
  // blunders.ai's root `e2e-test.mjs` / `openings-e2e-test.mjs` import
  // Playwright, esbuild's pre-scan follows into playwright-core and dies on
  // chromium-bidi's optional requires. The scan aborts → entries are
  // incomplete → deps optimize lazily mid-session → Vite force-reloads →
  // the React module instance is swapped mid-render → "Invalid hook call".
  //
  // Unlike the tooling-config excludes these are depth-globbed, so both a
  // root `e2e-test.mjs` and a nested `src/components/Button.test.tsx` are
  // pinned here — along with the app source that must survive, since the
  // patterns must key off filename boundaries and not bare substrings.
  it('optimizeDeps.entries excludes test/e2e files at any depth but keeps app source', async () => {
    // The exact filenames that broke the scan against blunders.ai.
    writeFileSync(resolve(projectRoot, 'e2e-test.mjs'), "import 'playwright';\n");
    writeFileSync(resolve(projectRoot, 'openings-e2e-test.mjs'), "import 'playwright';\n");
    // Nested test file — just as poisonous to the scan as a root one.
    mkdirSync(resolve(projectRoot, 'src/components'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, 'src/components/Button.test.tsx'),
      "import { test } from 'vitest';\ntest('x', () => {});\n",
    );
    // Conventional test directories at any depth.
    mkdirSync(resolve(projectRoot, 'e2e'), { recursive: true });
    writeFileSync(resolve(projectRoot, 'e2e/flow.ts'), 'export const flow = 1;\n');
    mkdirSync(resolve(projectRoot, 'src/__tests__'), { recursive: true });
    writeFileSync(resolve(projectRoot, 'src/__tests__/util.ts'), 'export const u = 1;\n');

    // Application source that merely *contains* those substrings in a
    // normal word — a blunt `*test*` / `*e2e*` exclusion would swallow
    // these and silently shrink the scan set.
    mkdirSync(resolve(projectRoot, 'src/lib'), { recursive: true });
    writeFileSync(resolve(projectRoot, 'src/lib/config.ts'), 'export const config = {};\n');
    mkdirSync(resolve(projectRoot, 'src/config'), { recursive: true });
    writeFileSync(resolve(projectRoot, 'src/config/routes.ts'), 'export const routes = [];\n');
    writeFileSync(resolve(projectRoot, 'src/lib/e2eHelpers.ts'), 'export const h = 1;\n');
    writeFileSync(resolve(projectRoot, 'src/contest.ts'), 'export const c = 1;\n');
    writeFileSync(resolve(projectRoot, 'src/latest.ts'), 'export const l = 1;\n');

    dev = await startDevServer(projectRoot, { persist: true, config: VALIDITY_CONFIG });
    const cfg = dev.server.config;
    const entries = cfg.optimizeDeps?.entries;
    const list = (Array.isArray(entries) ? entries : [entries!]).filter(
      (p): p is string => typeof p === 'string',
    );

    // Run the emitted patterns rather than eyeballing them: the scan set is
    // the include globs minus the `!` exclusions.
    const includes = list.filter((p) => !p.startsWith('!'));
    const excludes = list.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
    const matched = new Set(includes.flatMap((p) => globSync(p)));
    for (const file of excludes.flatMap((p) => globSync(p))) matched.delete(file);
    const scanned = [...matched].map((f) => f.replace(/\\/g, '/'));

    // Excluded direction — Node-side test code never reaches the pre-scan.
    expect(scanned.some((f) => f.endsWith('/e2e-test.mjs'))).toBe(false);
    expect(scanned.some((f) => f.endsWith('/openings-e2e-test.mjs'))).toBe(false);
    expect(scanned.some((f) => f.endsWith('/src/components/Button.test.tsx'))).toBe(false);
    expect(scanned.some((f) => f.endsWith('/e2e/flow.ts'))).toBe(false);
    expect(scanned.some((f) => f.endsWith('/src/__tests__/util.ts'))).toBe(false);

    // Included direction — the guard against an overreaching pattern.
    expect(scanned.some((f) => f.endsWith('/src/lib/config.ts'))).toBe(true);
    expect(scanned.some((f) => f.endsWith('/src/config/routes.ts'))).toBe(true);
    expect(scanned.some((f) => f.endsWith('/src/Button.tsx'))).toBe(true);
    expect(scanned.some((f) => f.endsWith('/src/lib/e2eHelpers.ts'))).toBe(true);
    expect(scanned.some((f) => f.endsWith('/src/contest.ts'))).toBe(true);
    expect(scanned.some((f) => f.endsWith('/src/latest.ts'))).toBe(true);
  }, 30_000);
});

describe('isEsbuildBuildFailure', () => {
  it('matches the native esbuild BuildFailure shape (errors array of Messages)', () => {
    const failure = Object.assign(new Error('Build failed with 1 error:\nfoo.js: parse error'), {
      errors: [{ text: 'parse error', location: null, notes: [] }],
      warnings: [],
    });
    expect(isEsbuildBuildFailure(failure)).toBe(true);
  });

  it('matches structurally even when the message wording changes', () => {
    // The Bug-B regression this guards against: an esbuild/Vite message reword
    // must not disable the fail-fast when the errors array is still present.
    const failure = Object.assign(new Error('Bundling terminated: 2 problems'), {
      errors: [{ text: 'x is not defined' }, { text: 'unexpected token' }],
    });
    expect(isEsbuildBuildFailure(failure)).toBe(true);
  });

  it('falls back to the message pattern for re-wrapped Errors without the array', () => {
    expect(isEsbuildBuildFailure(new Error('Build failed with 2 errors'))).toBe(true);
  });

  it('rejects AggregateError (errors hold Errors, not esbuild Messages)', () => {
    expect(isEsbuildBuildFailure(new AggregateError([new Error('x')], 'oops'))).toBe(false);
  });

  it('rejects plain errors and non-objects', () => {
    expect(isEsbuildBuildFailure(new Error('something else broke'))).toBe(false);
    expect(isEsbuildBuildFailure(null)).toBe(false);
    expect(isEsbuildBuildFailure('Build failed with 1 error')).toBe(false);
  });

  it('rejects an empty errors array with an unrelated message', () => {
    const err = Object.assign(new Error('optimize aborted'), { errors: [] });
    expect(isEsbuildBuildFailure(err)).toBe(false);
  });
});

// Issue #16: the dep pre-scan abort was silent-fatal — Vite logs one red block,
// degrades to lazy discovery, and a mid-session re-optimize reload corrupts
// renders ("more than one copy of React") with nothing naming the stray import.
// The scan failure must be LOUD (summary names file + import) and observable
// (DevServer.depScanFailure) so verdicts can carry the dep-scan taint.
describe('summarizeDepScanFailure', () => {
  it('extracts the unresolvable import and the importing file from esbuild output', () => {
    const msg = [
      '  Failed to scan for dependencies from entries:',
      '  /tmp/proj/node_modules/.validity/entry.tsx',
      '',
      '  ✘ [ERROR] Could not resolve "chromium-bidi/lib/cjs/bidiMapper/BidiMapper"',
      '',
      '      e2e/session.spec.ts:3:24:',
      '        3 │ import { BidiMapper } from "chromium-bidi/lib/cjs/bidiMapper/BidiMapper";',
      '          ╵                            ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
      '',
    ].join('\n');
    expect(summarizeDepScanFailure(msg)).toBe(
      'Could not resolve "chromium-bidi/lib/cjs/bidiMapper/BidiMapper" (from e2e/session.spec.ts:3:24)',
    );
  });

  it('strips ANSI color codes and caps the list at 3 offenders', () => {
    const esc = '\u001b[31m';
    const reset = '\u001b[0m';
    const block = (name: string, file: string) =>
      `  ✘ ${esc}[ERROR]${reset} Could not resolve "${name}"\n\n      ${file}:1:0:\n`;
    const msg =
      `${esc}  Failed to scan for dependencies from entries:${reset}\n\n` +
      block('pkg-a', 'src/a.ts') +
      block('pkg-b', 'src/b.ts') +
      block('pkg-c', 'src/c.ts') +
      block('pkg-d', 'src/d.ts');
    const summary = summarizeDepScanFailure(msg);
    expect(summary).toContain('Could not resolve "pkg-a" (from src/a.ts:1:0)');
    expect(summary).toContain('(+1 more)');
    expect(summary).not.toContain('pkg-d');
    expect(summary).not.toContain('\u001b');
  });

  it('parses the missing-bare-import shape ("Are they installed?") with the importer named', () => {
    const msg = [
      'Error: The following dependencies are imported but could not be resolved:',
      '',
      '  chromium-bidi/lib/cjs/bidiMapper/BidiMapper (imported by /proj/e2e/session.spec.ts)',
      '',
      'Are they installed?',
      '    at file:///…/vite/dist/node/chunks/dep-abc.js:14849:15',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)',
    ].join('\n');
    expect(summarizeDepScanFailure(msg)).toBe(
      'Could not resolve "chromium-bidi/lib/cjs/bidiMapper/BidiMapper" (imported by /proj/e2e/session.spec.ts)',
    );
  });

  it('degrades to the first non-empty line when the esbuild shape changes upstream — never to silence', () => {
    const msg = '  Failed to scan for dependencies from entries:\n  something new esbuild says\n';
    expect(summarizeDepScanFailure(msg)).toBe('Failed to scan for dependencies from entries:');
  });
});

describe('isDepScanFailureLog', () => {
  it('matches both scanner-death shapes and nothing else', () => {
    expect(isDepScanFailureLog('  Failed to scan for dependencies from entries:\n…')).toBe(true);
    expect(
      isDepScanFailureLog(
        'Error: The following dependencies are imported but could not be resolved:',
      ),
    ).toBe(true);
    expect(isDepScanFailureLog('Forced re-optimization of dependencies')).toBe(false);
    expect(isDepScanFailureLog('Build failed with 1 error')).toBe(false);
  });
});

describe('depScanAbortBanner', () => {
  it('names the summary and the dep-scan taint so the fix is discoverable from the terminal', () => {
    const banner = depScanAbortBanner('Could not resolve "x" (from src/y.ts:1:0)');
    expect(banner).toContain('dependency pre-scan ABORTED');
    expect(banner).toContain('Could not resolve "x" (from src/y.ts:1:0)');
    expect(banner).toContain("'dep-scan' evidence taint");
    expect(banner).toContain('more than one copy of React');
  });
});

describe('depScanFailureModuleSource', () => {
  it('is a throwing module carrying the summary and the optimizeDeps.exclude remediation', () => {
    const src = depScanFailureModuleSource('Could not resolve "aws-sdk" (from src/y.ts:1:0)');
    expect(src).toMatch(/^throw new Error\(/);
    expect(src).toContain('dependency pre-scan ABORTED');
    expect(src).toContain('Could not resolve \\"aws-sdk\\" (from src/y.ts:1:0)');
    expect(src).toContain('optimizeDeps.exclude');
  });
});

// A server-side workspace that declares `react` for jsx-email / SSR templates
// must NOT count as browser code — its Node-only imports (tfjs-node →
// node-pre-gyp) poison the browser dep scan. A component library whose only
// React signal is a `react` peer dep still MUST count, or its deps drop out
// of the pre-scan and get discovered mid-session (the re-optimize reload
// corruption). The heuristic threads that needle via server-framework signals.
describe('workspaceRendersReactUi', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'validity-ws-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const withPkg = (pkg: object): string => {
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify(pkg));
    return dir;
  };

  it('excludes a workspace with no react at all', () => {
    expect(
      workspaceRendersReactUi(withPkg({ name: 'api', dependencies: { 'better-sqlite3': '*' } })),
    ).toBe(false);
  });

  it('includes a workspace with react-dom, react-native, or expo', () => {
    expect(workspaceRendersReactUi(withPkg({ dependencies: { 'react-dom': '*' } }))).toBe(true);
    expect(workspaceRendersReactUi(withPkg({ dependencies: { 'react-native': '*' } }))).toBe(true);
    expect(workspaceRendersReactUi(withPkg({ devDependencies: { expo: '*' } }))).toBe(true);
  });

  it('includes a component library declaring only a react peer dep', () => {
    expect(workspaceRendersReactUi(withPkg({ peerDependencies: { react: '*' } }))).toBe(true);
  });

  it('excludes an Express API that added react for jsx-email templates', () => {
    expect(
      workspaceRendersReactUi(
        withPkg({
          name: 'api',
          dependencies: {
            react: '*',
            express: '*',
            'jsx-email': '*',
            '@tensorflow/tfjs-node': '*',
          },
        }),
      ),
    ).toBe(false);
  });

  it('react-dom wins over a server signal (a Next-style app depends on both)', () => {
    expect(
      workspaceRendersReactUi(
        withPkg({ dependencies: { react: '*', 'react-dom': '*', express: '*' } }),
      ),
    ).toBe(true);
  });

  it('returns false for a dir with no package.json or an unparseable one', () => {
    expect(workspaceRendersReactUi(dir)).toBe(false);
    writeFileSync(resolve(dir, 'package.json'), '{nope');
    expect(workspaceRendersReactUi(dir)).toBe(false);
  });
});

describe('startDevServer — dep pre-scan abort is captured, not swallowed', () => {
  let projectRoot: string;
  let dev: DevServer | undefined;

  // The scanner needs react/react-dom RESOLVABLE in the fixture, or every
  // boot dies on "react … could not be resolved" before reaching the poison
  // (and the clean-tree control would false-positive). Symlink them out of
  // this repo's pnpm store — `.pnpm/react-dom@*/node_modules/` holds
  // react-dom plus its whole dep closure (react, scheduler, loose-envify).
  function linkReactIntoFixture(root: string): void {
    const storeDir = globSync(
      resolve(import.meta.dirname, '../../..', 'node_modules/.pnpm/react-dom@*/node_modules'),
    )[0];
    if (!storeDir) throw new Error('react-dom not found in the repo pnpm store');
    mkdirSync(resolve(root, 'node_modules'), { recursive: true });
    for (const pkg of readdirSync(storeDir)) {
      symlinkSync(resolve(storeDir, pkg), resolve(root, 'node_modules', pkg), 'dir');
    }
  }

  beforeEach(() => {
    projectRoot = setupProject();
    linkReactIntoFixture(projectRoot);
  });

  afterEach(async () => {
    if (dev) {
      try {
        await dev.close();
      } catch {
        /* ignore */
      }
      dev = undefined;
    }
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('a stray unresolvable bare import in the swept tree sets depScanFailure naming dep + file', async () => {
    // The July-21 incident verbatim: a deep-subpath import of a package the
    // project does not have, sitting in a file the entries glob sweeps. The
    // scanner records it as missing, Vite logs "could not be resolved … Are
    // they installed?" internally and degrades to lazy discovery — never
    // throws.
    writeFileSync(
      resolve(projectRoot, 'src/poison.ts'),
      `import 'chromium-bidi/lib/cjs/bidiMapper/BidiMapper';\nexport const p = 1;\n`,
    );
    dev = await startDevServer(projectRoot, { persist: true });

    // The scanner fails asynchronously around listen(); poll briefly.
    const deadline = Date.now() + 20_000;
    let failure: string | undefined;
    while (Date.now() < deadline) {
      failure = dev.depScanFailure();
      if (failure) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(failure).toBeDefined();
    expect(failure).toContain('chromium-bidi/lib/cjs/bidiMapper/BidiMapper');
    expect(failure).toContain('src/poison.ts');
  }, 60_000);

  it('a clean tree leaves depScanFailure undefined', async () => {
    dev = await startDevServer(projectRoot, { persist: true });
    // Give the scanner the same window it gets in the failure test.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(dev.depScanFailure()).toBeUndefined();
  }, 60_000);

  it('answers pre-bundled-dep requests with a throwing module once the scan has aborted', async () => {
    writeFileSync(
      resolve(projectRoot, 'src/poison.ts'),
      `import 'chromium-bidi/lib/cjs/bidiMapper/BidiMapper';\nexport const p = 1;\n`,
    );
    dev = await startDevServer(projectRoot, { persist: true });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !dev.depScanFailure()) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(dev.depScanFailure()).toBeDefined();
    // The reported symptom: this request used to block forever (the dead
    // optimizer's commit promise never settles), leaving the browse page a
    // blank spinner with a "Browse session ready" tool result. It must now
    // answer immediately with a module that throws the scan summary so the
    // page's inline error trap paints a banner.
    const res = await fetch(`${dev.url}/.vite-cache/deps/react.js?v=abc123`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('throw new Error');
    expect(body).toContain('dependency pre-scan ABORTED');
  }, 60_000);
});
