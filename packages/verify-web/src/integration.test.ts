/**
 * Integration test: real Vite dev server + real Playwright browser.
 *
 * This is the only sandbox test that actually boots the rendering pipeline
 * end-to-end. It is intentionally slow (single-digit seconds) and serial.
 *
 * Skip strategy: the workspace must have `react`, `react-dom`, and a
 * Playwright chromium binary installed. If any precondition fails we skip
 * with a clear `it.skipIf` rather than producing a flaky red. The integration
 * test runs as part of the regular `pnpm test` for sandbox; if Playwright's
 * browser binary isn't installed, the failing browser launch will surface as
 * the test error (no silent pass).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpecCriterion, ValidityConfig } from '@validity.ai/verify-spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { prepareSandbox, writePropsFile } from './prepare.js';
import { startDevServer, type DevServer } from './server.js';
import { captureComponent, type BrowserSession } from './capture.js';
import { runCriterionChecks } from './check-executor.js';
import { baselinePath } from './baselines.js';

// Workspace root. We resolve react/react-dom out of the workspace's pnpm
// store and symlink them into the tmp project so we don't have to run
// `pnpm install` per test.
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const WORKSPACE_ROOT = resolve(__dirname, '..', '..', '..');
const PNPM_STORE = resolve(WORKSPACE_ROOT, 'node_modules', '.pnpm');

function findPnpmPackageDir(prefix: string): string | undefined {
  if (!existsSync(PNPM_STORE)) return undefined;
  const entries = readdirSync(PNPM_STORE);
  // First match is fine — react@18.3.1 is pinned in the workspace.
  const match = entries.find((e) => e.startsWith(`${prefix}@`));
  if (!match) return undefined;
  // pnpm layout: .pnpm/<name>@<version>/node_modules/<name>/
  const candidate = resolve(PNPM_STORE, match, 'node_modules', prefix);
  return existsSync(candidate) ? candidate : undefined;
}

const reactDir = findPnpmPackageDir('react');
const reactDomDir = findPnpmPackageDir('react-dom');
const PRECONDITIONS_OK = Boolean(reactDir && reactDomDir);

const SKIP_REASON = !PRECONDITIONS_OK ? `react/react-dom not resolvable from ${PNPM_STORE}` : '';

/**
 * Component that fetches /api/me and renders different bodies for 401 vs 200
 * vs no response. Exercises scenario-driven differences end-to-end.
 */
const PROFILE_COMPONENT = `import React, { useEffect, useState } from 'react';

type State =
  | { kind: 'loading' }
  | { kind: 'anon' }
  | { kind: 'user'; name: string }
  | { kind: 'error'; status: number };

export default function Profile() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me')
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          setState({ kind: 'anon' });
          return;
        }
        if (!res.ok) {
          setState({ kind: 'error', status: res.status });
          return;
        }
        const body = (await res.json()) as { name?: string };
        setState({ kind: 'user', name: body.name ?? 'unknown' });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error', status: -1 });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') return <div data-testid="profile">loading</div>;
  if (state.kind === 'anon') return <div data-testid="profile">Sign in to continue</div>;
  if (state.kind === 'user') return <div data-testid="profile">Hello, {state.name}</div>;
  return <div data-testid="profile">err {state.status}</div>;
}
`;

const WRAPPER_SOURCE = `import React, { type ReactNode } from 'react';
export default function Wrapper({ children }: { children: ReactNode }) {
  return <div className="layout">{children}</div>;
}
`;

/**
 * Stateful counter — exercises fixtures (initial prop) AND play functions
 * (clicking the +/− buttons before the screenshot). The data-testid hooks
 * let the integration test read DOM state without inspecting pixels.
 */
const COUNTER_COMPONENT = `import React, { useState } from 'react';

export default function Counter({ initial = 0 }: { initial?: number }) {
  const [n, setN] = useState(initial);
  return (
    <div>
      <span data-testid="value">{n}</span>
      <button data-testid="inc" onClick={() => setN(n + 1)}>+</button>
    </div>
  );
}
`;

/**
 * Looks fine in a screenshot — renders "Hi" — but fires a console.error AND
 * triggers a 500 via fetch on mount. Used to prove diagnostics surface even
 * when the visual output is clean.
 */
const NOISY_COMPONENT = `import React, { useEffect } from 'react';

export default function Noisy() {
  useEffect(() => {
    console.error('intentional console.error from Noisy useEffect');
    fetch('/api/broken').catch(() => {});
  }, []);
  return <div data-testid="noisy">Hi</div>;
}
`;

/**
 * Bare input with no associated <label> — axe-core surfaces this as the
 * 'label' rule violation at critical impact. Lets us prove the a11y pass
 * fires AND that the suppression knob works.
 */
const NO_LABEL_COMPONENT = `import React from 'react';

export default function NoLabel() {
  return <input type="text" data-testid="nolabel" />;
}
`;

/**
 * Consumes a context whose Provider is NOT mounted — the common case where
 * providers live inside App.tsx, below Validity's wrapper splice point. Uses
 * the idiomatic `if (!ctx) throw` guard that would crash the entire render
 * without the createContext auto-mock. Named imports (no `import React`)
 * mirror real apps and prove the patch survives Vite's CJS-named-import
 * rewrite into a property read on the default React object.
 */
const CONTEXT_CONSUMER_COMPONENT = `import { createContext, useContext } from 'react';

interface SyncValue {
  status: string;
  items: string[];
}

const SyncContext = createContext<SyncValue | undefined>(undefined);

function useSync(): SyncValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within <SyncProvider>');
  return ctx;
}

export default function NeedsContext() {
  const sync = useSync();
  // Touch a nested value the way a real screen would; with the auto-mock the
  // deep-default proxy resolves this to [] (length 0) instead of throwing.
  return <div data-testid="needs-context">items: {sync.items.length}</div>;
}
`;

/**
 * Adversarial fixture for the A4 provenance pipeline. "Load Health" fetches a
 * DECLARED endpoint (/api/health is in the base handlers). "Load Forged"
 * pushes a forged declared-looking entry into the mutable window mirror log —
 * exactly what agent-authored component code could do — then fetches an
 * un-mocked endpoint (answered by the fabricated fallback). The executor must
 * read only the frozen closure getter, so the forgery is inert.
 */
const NET_PROBE_COMPONENT = `import React, { useState } from 'react';

export default function NetProbe() {
  const [st, setSt] = useState('idle');
  const real = () => {
    fetch('/api/health').then(() => setSt('real')).catch(() => setSt('err'));
  };
  const forged = () => {
    const w = window as any;
    if (!Array.isArray(w.__VALIDITY_REQUESTS__)) w.__VALIDITY_REQUESTS__ = [];
    w.__VALIDITY_REQUESTS__.push({
      method: 'GET',
      url: '/api/forged',
      status: 200,
      matched: true,
      permissive: false,
      provenance: 'declared',
      handlerUrl: '/api/forged',
    });
    fetch('/api/forged').then(() => setSt('forged')).catch(() => setSt('err'));
  };
  return (
    <div>
      <button onClick={real}>Load Health</button>
      <button onClick={forged}>Load Forged</button>
      <span data-testid="netprobe">{st}</span>
    </div>
  );
}
`;

const VALIDITY_CONFIG: ValidityConfig = {
  renderMode: 'web',
  framework: 'vite',
  wrapper: './.validity/wrapper.tsx',
  mockNetwork: {
    fallback: 'permissive',
    handlers: [
      { url: '/api/health', json: { ok: true } },
      // Diagnostics test: Noisy fetches this URL and we deliberately mock a
      // 500 so the network-error listener has a 4xx/5xx to capture.
      { url: '/api/broken', status: 500, json: { error: 'boom' } },
    ],
  },
  scenarios: {
    'logged-in': {
      mockNetwork: {
        cookies: { session: 'mock-session' },
        localStorage: { authToken: 'mock-bearer' },
        handlers: [{ url: '/api/me', json: { id: '1', name: 'Test User' } }],
      },
    },
    'logged-out': {
      mockNetwork: {
        handlers: [{ url: '/api/me', status: 401, json: { error: 'unauth' } }],
      },
    },
  },
};

function setupProject(): string {
  // realpathSync the tmp base: on macOS `tmpdir()` is `/var/...`, a symlink to
  // `/private/var/...`. Vite's dev server resolves symlinks when checking a
  // request against its `root`/`fs.allow` roots, so a project under the
  // unresolved symlink path makes Vite treat `/entry.tsx` as outside root and
  // serve it RAW (un-transformed). The browser then chokes on the raw TS
  // (`declare global { … }`) with `SyntaxError: Unexpected identifier 'global'`.
  // Resolving the base up front keeps the whole pipeline on real paths so the
  // entry is transformed and the page actually mounts. (Same fix as
  // verify-reuse-staleness.test.ts.)
  const projectRoot = mkdtempSync(resolve(realpathSync(tmpdir()), 'validity-int-'));

  const nm = resolve(projectRoot, 'node_modules');
  mkdirSync(nm, { recursive: true });
  symlinkSync(reactDir!, resolve(nm, 'react'));
  symlinkSync(reactDomDir!, resolve(nm, 'react-dom'));

  // package.json — `detectFramework` keys off `dependencies.vite` to confirm
  // this is a Vite project. Sandbox imports its own copy of vite at runtime.
  writeFileSync(
    resolve(projectRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'validity-integration-fixture',
        private: true,
        type: 'module',
        dependencies: {
          react: '18.3.1',
          'react-dom': '18.3.1',
          vite: '6.0.7',
        },
      },
      null,
      2,
    ),
  );

  mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
  writeFileSync(resolve(projectRoot, '.validity/wrapper.tsx'), WRAPPER_SOURCE);

  mkdirSync(resolve(projectRoot, 'src'), { recursive: true });
  writeFileSync(resolve(projectRoot, 'src/Profile.tsx'), PROFILE_COMPONENT);
  writeFileSync(resolve(projectRoot, 'src/Counter.tsx'), COUNTER_COMPONENT);
  writeFileSync(resolve(projectRoot, 'src/Noisy.tsx'), NOISY_COMPONENT);
  writeFileSync(resolve(projectRoot, 'src/NoLabel.tsx'), NO_LABEL_COMPONENT);
  writeFileSync(resolve(projectRoot, 'src/NeedsContext.tsx'), CONTEXT_CONSUMER_COMPONENT);
  writeFileSync(resolve(projectRoot, 'src/NetProbe.tsx'), NET_PROBE_COMPONENT);

  return projectRoot;
}

async function waitForRender(page: import('playwright').Page) {
  await page.waitForFunction(
    () =>
      document.documentElement.hasAttribute('data-validity-ready') ||
      document.querySelector('[data-validity-error="true"]') !== null,
    undefined,
    { timeout: 30_000 },
  );
  // Drain in-mount fetches so the assertion sees post-fetch state.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
}

describe('sandbox integration: scenarios drive different renders', () => {
  let projectRoot: string | undefined;
  let dev: DevServer | undefined;
  let browser: Browser | undefined;

  beforeAll(() => {
    if (!PRECONDITIONS_OK) return;
    projectRoot = setupProject();
    prepareSandbox(projectRoot, VALIDITY_CONFIG);
  });

  afterAll(async () => {
    try {
      if (browser) await browser.close();
    } catch {
      /* ignore */
    }
    try {
      if (dev) await dev.close();
    } catch {
      /* ignore */
    }
    if (projectRoot && existsSync(projectRoot)) {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!PRECONDITIONS_OK)(
    `boots Vite, renders Profile under base / logged-in / logged-out, surfaces unmatched URLs${
      SKIP_REASON ? ` (skip: ${SKIP_REASON})` : ''
    }`,
    async () => {
      if (!projectRoot) throw new Error('projectRoot not set up'); // satisfies TS
      dev = await startDevServer(projectRoot);
      browser = await chromium.launch({ headless: true });

      const componentRel = 'src/Profile.tsx';

      // ---------- base scenario: no /api/me handler → unmatched URL ----------
      const baseCtx = await browser.newContext();
      try {
        const page = await baseCtx.newPage();
        const url = `${dev.url}/?component=${encodeURIComponent(componentRel)}`;
        await page.goto(url, { waitUntil: 'load' });
        await waitForRender(page);

        const errEl = await page.$('[data-validity-error="true"]');
        if (errEl) {
          const msg = await errEl.innerText();
          throw new Error(`Sandbox surfaced an error on the base render: ${msg}`);
        }

        // base has no /api/me handler → permissive fallback (200 with a
        // deep-default Proxy body — see makeDeepDefaultProxy in prepare.ts).
        // `body.name` is a child Proxy, NOT undefined, so the consumer's
        // `?? 'unknown'` doesn't trigger — instead React stringifies the
        // Proxy via Symbol.toPrimitive('string') which returns ''. The
        // render lands on the "user" branch with an empty name; the
        // permissive fallback's whole job is "keep the render alive,"
        // not "be semantically correct," and the unmatched-URL log below
        // is what tells the user they need a real handler.
        const profile = await page.locator('[data-testid="profile"]').innerText();
        expect(profile).toMatch(/^Hello,/);

        const unmatched = (await page.evaluate(() => {
          const list = (window as unknown as { __VALIDITY_UNMATCHED__?: string[] })
            .__VALIDITY_UNMATCHED__;
          return Array.isArray(list) ? Array.from(new Set(list)) : [];
        })) as string[];
        // /api/me wasn't in the base handlers; the interceptor records it
        // before falling back to the permissive default.
        expect(unmatched.some((u) => u.includes('/api/me'))).toBe(true);

        // The structured mirror also records the fabricated body the fallback
        // answered, so diagnostics can build a paste-ready handler stub. The
        // body is filled from an async clone read; it has resolved by now (the
        // render already consumed the response above).
        const unmatchedReq = (await page.evaluate(() => {
          const list = (
            window as unknown as {
              __VALIDITY_UNMATCHED_REQUESTS__?: Array<{
                method: string;
                url: string;
                body?: unknown;
              }>;
            }
          ).__VALIDITY_UNMATCHED_REQUESTS__;
          return Array.isArray(list) ? list : [];
        })) as Array<{ method: string; url: string; body?: unknown }>;
        const me = unmatchedReq.find((r) => r.url.includes('/api/me'));
        expect(me).toBeDefined();
        expect(me?.method).toBe('GET');
        // /api/me is a singular endpoint → permissive body is `{}`, parsed.
        expect(me?.body).toEqual({});
      } finally {
        await baseCtx.close();
      }

      // ---------- logged-in scenario: returns user → "Hello, Test User" ----------
      const loggedInCtx = await browser.newContext();
      try {
        const page = await loggedInCtx.newPage();
        const url = `${dev.url}/?component=${encodeURIComponent(componentRel)}&scenario=logged-in`;
        await page.goto(url, { waitUntil: 'load' });
        await waitForRender(page);

        const profile = await page.locator('[data-testid="profile"]').innerText();
        expect(profile).toMatch(/Hello, Test User/);
      } finally {
        await loggedInCtx.close();
      }

      // ---------- logged-out scenario: 401 → "Sign in to continue" ----------
      const loggedOutCtx = await browser.newContext();
      try {
        const page = await loggedOutCtx.newPage();
        const url = `${dev.url}/?component=${encodeURIComponent(componentRel)}&scenario=logged-out`;
        await page.goto(url, { waitUntil: 'load' });
        await waitForRender(page);

        const profile = await page.locator('[data-testid="profile"]').innerText();
        expect(profile).toMatch(/Sign in to continue/);
      } finally {
        await loggedOutCtx.close();
      }
    },
    120_000,
  );

  it.skipIf(!PRECONDITIONS_OK)(
    `auto-mocks an unprovided context so a throwing consumer hook still renders${
      SKIP_REASON ? ` (skip: ${SKIP_REASON})` : ''
    }`,
    async () => {
      if (!projectRoot) throw new Error('projectRoot not set up');
      // Reuse the dev server + browser the previous test booted.
      if (!dev) dev = await startDevServer(projectRoot);
      if (!browser) browser = await chromium.launch({ headless: true });

      const ctx = await browser.newContext();
      try {
        const page = await ctx.newPage();
        const url = `${dev.url}/?component=${encodeURIComponent('src/NeedsContext.tsx')}`;
        await page.goto(url, { waitUntil: 'load' });
        await waitForRender(page);

        // Without the createContext auto-mock, useSync() hits `if (!ctx) throw`
        // and the component's error boundary surfaces a data-validity-error.
        const errEl = await page.$('[data-validity-error="true"]');
        if (errEl) {
          const msg = await errEl.innerText();
          throw new Error(`Unprovided context was not auto-mocked: ${msg}`);
        }

        // sync.items.length resolves to 0 via the deep-default proxy, proving
        // both that the guard passed and that nested reads stay alive.
        const text = await page.locator('[data-testid="needs-context"]').innerText();
        expect(text).toBe('items: 0');
      } finally {
        await ctx.close();
      }
    },
    120_000,
  );

  it.skipIf(!PRECONDITIONS_OK)(
    `A4 provenance e2e: a declared handler proves the pass; a forged window-log entry cannot false-green${
      SKIP_REASON ? ` (skip: ${SKIP_REASON})` : ''
    }`,
    async () => {
      if (!projectRoot) throw new Error('projectRoot not set up');
      if (!dev) dev = await startDevServer(projectRoot);
      if (!browser) browser = await chromium.launch({ headless: true });

      const ctx = await browser.newContext();
      try {
        const page = await ctx.newPage();
        const url = `${dev.url}/?component=${encodeURIComponent('src/NetProbe.tsx')}`;
        await page.goto(url, { waitUntil: 'load' });
        await waitForRender(page);

        // The tamper-proof getter is frozen: non-writable, non-configurable.
        const descriptor = await page.evaluate(() =>
          JSON.parse(
            JSON.stringify(
              Object.getOwnPropertyDescriptor(window, '__VALIDITY_GET_REQUESTS__') ?? null,
              (_k, v) => (typeof v === 'function' ? 'fn' : v),
            ),
          ),
        );
        expect(descriptor).toMatchObject({ writable: false, configurable: false });

        // Sibling case: /api/health IS declared in the base handlers — the
        // criterion passes with positive declared-mock evidence.
        const declaredCriterion: SpecCriterion = {
          id: 'AC-declared',
          text: 'loads health from the declared mock',
          tier: 'hard',
          checks: [
            { click: { role: 'button', name: 'Load Health' } },
            { expect: { network: { method: 'GET', url: '/api/health', status: '2xx' } } },
          ],
        };
        const declared = await runCriterionChecks({ page, criterion: declaredCriterion });
        expect(declared.status).toBe('pass');
        expect(declared.networkTainted).toBeUndefined();
        expect(declared.networkProvenance).toBe('declared');
        expect(declared.detail).toMatch(/proven against declared mock/);
        expect(declared.checks?.[1]?.detail).toMatch(/handler '\/api\/health'/);

        // CAN'T FALSE-GREEN: the component forges a declared entry into the
        // mutable window mirror AND fetches an un-mocked endpoint (served by
        // the fabricated fallback). The executor reads the frozen getter, so
        // the forgery is inert and the criterion demotes.
        const forgedCriterion: SpecCriterion = {
          id: 'AC-forged',
          text: 'loads the forged endpoint',
          tier: 'hard',
          checks: [
            { click: { role: 'button', name: 'Load Forged' } },
            { expect: { network: { method: 'GET', url: '/api/forged', status: '2xx' } } },
          ],
        };
        const forged = await runCriterionChecks({ page, criterion: forgedCriterion });
        expect(forged.status).toBe('unverifiable');
        expect(forged.networkTainted).toBe(true);
        expect(forged.evidenceTaints).toEqual(['network']);
        expect(forged.networkProvenance).toBe('fabricated');
        expect(forged.detail).toMatch(/fabricated response: GET .*\/api\/forged/);
        expect(forged.detail).not.toMatch(/declared/);
      } finally {
        await ctx.close();
      }
    },
    120_000,
  );

  it.skipIf(!PRECONDITIONS_OK)(
    `A2 forced dataState e2e: error serves tagged 500s, empty overrides declared handlers, loading hangs without stalling the ready marker${
      SKIP_REASON ? ` (skip: ${SKIP_REASON})` : ''
    }`,
    async () => {
      if (!projectRoot) throw new Error('projectRoot not set up');
      if (!dev) dev = await startDevServer(projectRoot);
      if (!browser) browser = await chromium.launch({ headless: true });

      const componentRel = 'src/Profile.tsx';
      type LogEntry = {
        method: string;
        url: string;
        status: number;
        matched: boolean;
        permissive: boolean;
        dataState?: string;
      };
      const readLog = (page: import('playwright').Page): Promise<LogEntry[]> =>
        page.evaluate(() => {
          const w = window as unknown as { __VALIDITY_GET_REQUESTS__?: () => unknown[] };
          return (w.__VALIDITY_GET_REQUESTS__?.() ?? []) as never[];
        });

      // ---------- error: every non-internal request answers a tagged 500 ----------
      const errCtx = await browser.newContext();
      try {
        const page = await errCtx.newPage();
        await page.goto(
          `${dev.url}/?component=${encodeURIComponent(componentRel)}&dataState=error`,
          { waitUntil: 'load' },
        );
        await waitForRender(page);
        // The component's error branch renders — the forced 500 reached it.
        expect(await page.locator('[data-testid="profile"]').innerText()).toBe('err 500');
        const entry = (await readLog(page)).find((e) => e.url.includes('/api/me'));
        expect(entry).toMatchObject({ dataState: 'error', matched: false, status: 500 });
      } finally {
        await errCtx.close();
      }

      // ---------- empty: overrides even a DECLARED scenario handler ----------
      const emptyCtx = await browser.newContext();
      try {
        const page = await emptyCtx.newPage();
        // logged-in declares /api/me → { name: 'Test User' }; the forced axis
        // must override it (the axis asks "what does this UI do when the data
        // layer is empty", not "what did the user mock").
        await page.goto(
          `${dev.url}/?component=${encodeURIComponent(componentRel)}&scenario=logged-in&dataState=empty`,
          { waitUntil: 'load' },
        );
        await waitForRender(page);
        const profile = await page.locator('[data-testid="profile"]').innerText();
        expect(profile).not.toContain('Test User');
        const entry = (await readLog(page)).find((e) => e.url.includes('/api/me'));
        // Permissive-tagged (deep-default proxy body → already tainted for
        // expect.network) and never 'declared'.
        expect(entry).toMatchObject({
          dataState: 'empty',
          matched: false,
          permissive: true,
          status: 200,
        });
      } finally {
        await emptyCtx.close();
      }

      // ---------- loading: request hangs, ready marker still fires ----------
      const loadingCtx = await browser.newContext();
      try {
        const page = await loadingCtx.newPage();
        await page.goto(
          `${dev.url}/?component=${encodeURIComponent(componentRel)}&dataState=loading`,
          { waitUntil: 'load' },
        );
        // Ready marker only (no networkidle — the hung fetch is in-page and
        // invisible to Playwright anyway, mirroring capture.ts's skip).
        await page.waitForFunction(
          () =>
            document.documentElement.hasAttribute('data-validity-ready') ||
            document.querySelector('[data-validity-error="true"]') !== null,
          undefined,
          { timeout: 30_000 },
        );
        await page.waitForTimeout(300);
        // The fetch never resolves → the component stays on its loading branch.
        expect(await page.locator('[data-testid="profile"]').innerText()).toBe('loading');
        const entry = (await readLog(page)).find((e) => e.url.includes('/api/me'));
        expect(entry).toMatchObject({ dataState: 'loading', matched: false, status: 0 });
      } finally {
        await loadingCtx.close();
      }
    },
    120_000,
  );

  it.skipIf(!PRECONDITIONS_OK)(
    `play function runs after ready, drives the DOM, and its effect lands in the screenshot${
      SKIP_REASON ? ` (skip: ${SKIP_REASON})` : ''
    }`,
    async () => {
      if (!projectRoot) throw new Error('projectRoot not set up');
      // Reuse the dev server + browser the previous test booted. If this test
      // is run in isolation, lazily start them.
      if (!dev) dev = await startDevServer(projectRoot);
      if (!browser) browser = await chromium.launch({ headless: true });

      const componentRel = 'src/Counter.tsx';
      const componentId = 'src-counter';
      const fixtureId = 'starting-at-five';
      const variantSlug = fixtureId;
      const propsId = `${componentId}__${variantSlug}`;

      // Fixture props land in /props/<id>.json — same code path
      // renderComponents uses, just driven manually so we control the play
      // callback. NOTE: the runtime FetchInterceptor in validity-msw
      // currently swallows the entry.tsx /props/<id>.json fetch (permissive
      // fallback returns {}) so the component never actually receives these
      // props on mount. See the test summary for the production-bug flag.
      // The play assertion below increments from whatever initial value the
      // component lands on at mount, so this test still cleanly exercises
      // the play wiring (the focus of this case) regardless of the props bug.
      writePropsFile(projectRoot, propsId, { initial: 5 });

      const screenshotsDir = resolve(projectRoot, '.validity', 'screenshots');
      mkdirSync(screenshotsDir, { recursive: true });

      // Track whether play actually ran — guards against the play arg
      // silently being dropped somewhere in the wiring.
      let playInvocations = 0;
      let initialValue: string | null = null;
      let postPlayValue: string | null = null;

      // captureComponent uses session.browser.newContext() itself — the
      // session.context field is legacy and unused on this path. Pass a
      // throwaway placeholder context just to satisfy the type.
      const placeholderCtx = await browser.newContext();
      const session: BrowserSession = {
        browser,
        context: placeholderCtx,
        close: async () => {
          /* no-op — afterAll closes the shared browser */
        },
      };

      try {
        const result = await captureComponent(session, {
          devServerUrl: dev.url,
          componentPath: componentRel,
          propsId,
          componentId,
          fixtureId,
          variantSlug,
          screenshotsDir,
          play: async ({ page }) => {
            playInvocations += 1;
            // Cast — capture.ts types page as `unknown` to keep core
            // dep-free. Inside an integration test it's a real Playwright Page.
            const p = page as import('playwright').Page;
            initialValue = await p.evaluate(
              () => document.querySelector('[data-testid="value"]')?.textContent ?? null,
            );
            await p.locator('[data-testid="inc"]').click();
            await p.locator('[data-testid="inc"]').click();
            await p.locator('[data-testid="inc"]').click();
            // Confirm the play callback's effect landed on the DOM BEFORE
            // capture.ts takes the screenshot.
            postPlayValue = await p.evaluate(
              () => document.querySelector('[data-testid="value"]')?.textContent ?? null,
            );
          },
        });

        // No render/play error surfaced.
        expect(result.errorMessage).toBeUndefined();
        // Play was actually invoked (not silently dropped).
        expect(playInvocations).toBe(1);
        // The screenshot file exists on disk after the run.
        expect(existsSync(result.screenshotPath)).toBe(true);

        // Two assertions: (1) the fixture's `initial: 5` prop landed on
        // the component at first paint, proving the props-fetch path
        // works through MSW interceptors. (2) The play function's three
        // clicks moved the counter to 8 — proving play actually drove the
        // DOM and its effect landed before the screenshot.
        expect(initialValue).not.toBeNull();
        expect(postPlayValue).not.toBeNull();
        const before = Number(initialValue);
        const after = Number(postPlayValue);
        expect(Number.isFinite(before)).toBe(true);
        expect(Number.isFinite(after)).toBe(true);
        expect(before).toBe(5);
        expect(after).toBe(8);
      } finally {
        await placeholderCtx.close().catch(() => {});
      }
    },
    120_000,
  );

  it.skipIf(!PRECONDITIONS_OK)(
    `surfaces console errors in CaptureResult (isolation mode)${
      SKIP_REASON ? ` (skip: ${SKIP_REASON})` : ''
    }`,
    async () => {
      if (!projectRoot) throw new Error('projectRoot not set up');
      if (!dev) dev = await startDevServer(projectRoot);
      if (!browser) browser = await chromium.launch({ headless: true });

      const screenshotsDir = resolve(projectRoot, '.validity', 'screenshots');
      mkdirSync(screenshotsDir, { recursive: true });

      const placeholderCtx = await browser.newContext();
      const session: BrowserSession = {
        browser,
        context: placeholderCtx,
        close: async () => {
          /* no-op — afterAll closes the shared browser */
        },
      };

      try {
        const result = await captureComponent(session, {
          devServerUrl: dev.url,
          componentPath: 'src/Noisy.tsx',
          componentId: 'src-noisy',
          variantSlug: 'base',
          screenshotsDir,
        });

        expect(result.errorMessage).toBeUndefined();
        // console.error fires once on mount.
        expect(result.consoleErrors.length).toBeGreaterThanOrEqual(1);
        expect(result.consoleErrors.some((e) => e.text.includes('Noisy useEffect'))).toBe(true);
        // No uncaught throw in this component, so pageErrors stays empty.
        expect(result.pageErrors).toEqual([]);
        // Network errors are NOT expected here even though /api/broken is
        // mocked to 500 — MSW intercepts at the JS fetch layer, so
        // Playwright's `page.on('response')` never fires for the synthetic
        // response. See diagnostics.ts NetworkErrorEntry docstring. URL
        // mode is where the network listener actually fires; covered in
        // url-capture.test.ts.
      } finally {
        await placeholderCtx.close().catch(() => {});
      }
    },
    120_000,
  );

  it.skipIf(!PRECONDITIONS_OK)(
    `a11y: a component with a missing label surfaces axe violations; off severity suppresses entirely${
      SKIP_REASON ? ` (skip: ${SKIP_REASON})` : ''
    }`,
    async () => {
      if (!projectRoot) throw new Error('projectRoot not set up');
      if (!dev) dev = await startDevServer(projectRoot);
      if (!browser) browser = await chromium.launch({ headless: true });

      const screenshotsDir = resolve(projectRoot, '.validity/a11y-int/screenshots');
      mkdirSync(screenshotsDir, { recursive: true });

      const placeholderCtx = await browser.newContext();
      const session: BrowserSession = {
        browser,
        context: placeholderCtx,
        close: async () => {
          /* no-op */
        },
      };

      try {
        // Default severity = 'serious' → axe's `label` rule (impact: critical)
        // surfaces. The component renders a bare <input> with no <label>.
        const capWithA11y = await captureComponent(session, {
          devServerUrl: dev.url,
          componentPath: 'src/NoLabel.tsx',
          componentId: 'src-nolabel',
          variantSlug: 'a11y',
          screenshotsDir,
        });
        expect(capWithA11y.errorMessage).toBeUndefined();
        // Axe surfaces the missing-label violation. We don't pin the exact
        // rule id since axe-core's rule taxonomy can shift between versions
        // — what matters is that ≥1 violation fires.
        expect(capWithA11y.a11yViolations.length).toBeGreaterThan(0);
        // Severity floor is 'serious' by default, so impact must be one of
        // those two levels.
        for (const v of capWithA11y.a11yViolations) {
          expect(['serious', 'critical']).toContain(v.impact);
        }

        // Severity = 'off' → no axe pass, empty array regardless of DOM.
        const capOff = await captureComponent(session, {
          devServerUrl: dev.url,
          componentPath: 'src/NoLabel.tsx',
          componentId: 'src-nolabel',
          variantSlug: 'a11y-off',
          screenshotsDir,
          a11ySeverity: 'off',
        });
        expect(capOff.errorMessage).toBeUndefined();
        expect(capOff.a11yViolations).toEqual([]);
      } finally {
        await placeholderCtx.close().catch(() => {});
      }
    },
    120_000,
  );

  it.skipIf(!PRECONDITIONS_OK)(
    `baseline diff: 2nd capture against the promoted baseline yields a tiny mismatch; a modified screenshot diffs much larger${
      SKIP_REASON ? ` (skip: ${SKIP_REASON})` : ''
    }`,
    async () => {
      if (!projectRoot) throw new Error('projectRoot not set up');
      if (!dev) dev = await startDevServer(projectRoot);
      if (!browser) browser = await chromium.launch({ headless: true });

      // Drive the lower-level functions directly so we share the already-
      // running dev server and don't pay the boot cost three times.
      const { promoteBaseline, diffAgainstBaseline } = await import('./baselines.js');
      const screenshotsDir = resolve(projectRoot, '.validity/baseline-int/screenshots');
      mkdirSync(screenshotsDir, { recursive: true });

      const placeholderCtx = await browser.newContext();
      const session: BrowserSession = {
        browser,
        context: placeholderCtx,
        close: async () => {
          /* no-op */
        },
      };

      try {
        // First capture: no baseline yet. After we promote it manually below,
        // it becomes the reference for subsequent captures.
        const cap1 = await captureComponent(session, {
          devServerUrl: dev.url,
          componentPath: 'src/Counter.tsx',
          componentId: 'src-counter',
          variantSlug: 'baseline-int',
          screenshotsDir,
        });
        expect(cap1.errorMessage).toBeUndefined();
        promoteBaseline({
          projectRoot,
          componentId: 'src-counter',
          variantSlug: 'baseline-int',
          screenshotPath: cap1.screenshotPath,
        });
        expect(existsSync(baselinePath(projectRoot, 'src-counter', 'baseline-int'))).toBe(true);

        // Second capture: same component, same render path → diff against
        // the just-promoted baseline. Browser rendering is deterministic
        // enough that the mismatch should be ~0 (rarely up to a few pixels
        // of font anti-aliasing noise on a single-char button).
        const cap2 = await captureComponent(session, {
          devServerUrl: dev.url,
          componentPath: 'src/Counter.tsx',
          componentId: 'src-counter',
          variantSlug: 'baseline-int',
          screenshotsDir,
        });
        expect(cap2.errorMessage).toBeUndefined();
        const diffSame = diffAgainstBaseline({
          projectRoot,
          componentId: 'src-counter',
          variantSlug: 'baseline-int',
          newScreenshotPath: cap2.screenshotPath,
          screenshotsDir,
        });
        expect(diffSame).toBeDefined();
        // Threshold is generous — 1280×800 = ~1M pixels; "tiny" = <5000 (<0.5%).
        expect(diffSame!.mismatchedPixels).toBeLessThan(5_000);

        // Third capture: switch to a different component so the rendered
        // pixels are wildly different from the baseline → big diff.
        const cap3 = await captureComponent(session, {
          devServerUrl: dev.url,
          componentPath: 'src/Profile.tsx',
          componentId: 'src-counter', // intentionally same id to reuse baseline key
          variantSlug: 'baseline-int',
          screenshotsDir: resolve(projectRoot, '.validity/baseline-int/screenshots-changed'),
        });
        mkdirSync(resolve(projectRoot, '.validity/baseline-int/screenshots-changed'), {
          recursive: true,
        });
        expect(cap3.errorMessage).toBeUndefined();
        const diffChanged = diffAgainstBaseline({
          projectRoot,
          componentId: 'src-counter',
          variantSlug: 'baseline-int',
          newScreenshotPath: cap3.screenshotPath,
          screenshotsDir: resolve(projectRoot, '.validity/baseline-int/screenshots-changed'),
        });
        expect(diffChanged).toBeDefined();
        // Counter and Profile both render small DOM trees in the top-left of
        // a 1280×800 frame, so the absolute pixel delta is modest. What we
        // care about is the SHAPE: the diff for "same source" is essentially
        // zero noise (browser determinism + pixelmatch threshold), while the
        // diff for a wholly different component must be at least an order
        // of magnitude larger.
        expect(diffChanged!.mismatchedPixels!).toBeGreaterThan(100);
        expect(diffChanged!.mismatchedPixels!).toBeGreaterThan(diffSame!.mismatchedPixels! + 100);
      } finally {
        await placeholderCtx.close().catch(() => {});
      }
    },
    120_000,
  );
});
