/**
 * Regression guard: verify-reuses-browse must NOT serve a stale generated
 * entry.tsx after `.validity/config.ts` mockNetwork handlers change.
 *
 * The seam: `validity browse` holds a long-lived Vite server; `validity__verify`
 * (a separate process) detects it via `node_modules/.validity/.browse.lock` and
 * reuses its URL as a black-box backend instead of cold-booting Vite
 * (render.ts:200-207). The open question the web-sandbox findings flagged
 * ([minor] "Verify-reusing-browse may serve stale generated entry/config"):
 * when verify rewrites entry.tsx with freshly-baked handlers but the reused
 * server already transformed-and-cached the OLD entry, does Vite serve the
 * stale module? Two theorized vectors:
 *   (a) the browse server's middlewares hold the config from ITS boot
 *       (configRef closure, server.ts) — but mockNetwork *handlers* are baked
 *       into entry.tsx as `window.__VALIDITY_BASE_NETWORK__` data, NOT served
 *       from /__validity/api/config, so (a) does not gate handler delivery;
 *   (b) Vite's file watcher ignores node_modules by default and the sandbox
 *       root IS node_modules/.validity, so the rewritten entry.tsx might not
 *       invalidate the module-graph transform cache.
 *
 * Vector (b) IS real: because the sandbox root is node_modules/.validity and
 * Vite's watcher ignores node_modules, rewriting entry.tsx fires no
 * invalidation and the reused server keeps serving the stale transform. (This
 * surfaced as CI flakiness — it happened to re-transform locally but not under
 * load.) The fix is an explicit invalidation: the verify reuse path
 * (render.ts) POSTs `/__validity/api/invalidate` to the reused server after
 * re-preparing, which drops the cached entry modules from the module graph so
 * the next request re-reads the rewritten file. This test exercises that
 * contract directly: re-prepare → POST invalidate → assert fresh handlers. If
 * the endpoint regresses (or a future change stops invalidating), this guard
 * catches the stale entry.
 *
 * No Playwright: this test only needs to prove the transform cache invalidates,
 * which the HTTP layer shows directly — we GET entry.tsx and grep the
 * transformed body for the baked handler marker (the "curl a live browse
 * /entry.tsx" verification the project memory prescribes), no browser needed.
 * (A raw-serve failure mode — where Vite serves un-transformed TS and the page
 * would red with `Unexpected identifier 'global'` — is avoided here the same way
 * integration.test.ts avoids it: realpathSync the tmp root, see below.)
 * A `.tsx` GET routes through Vite's transformMiddleware (which
 * compiles it and registers it in the module graph), so it exercises the same
 * cache a real page import would — but ONLY when the project root isn't a
 * symlink (see setupProject's realpathSync for why; without it Vite refuses
 * the load and silently serves the raw file, which is always fresh and proves
 * nothing). The flow is: warm → re-prepare → assert STALE (bug reproduces) →
 * POST invalidate → assert FRESH (fix works).
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
import type { ValidityConfig } from '@validity.ai/verify-spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareSandbox } from './prepare.js';
import { startDevServer, type DevServer } from './server.js';
import { writeBrowseLock, readLiveBrowseLock } from './browse/lock.js';

// Resolve react/react-dom out of the workspace pnpm store and symlink them
// into the tmp project so we don't have to `pnpm install` per test. Same
// pattern as integration.test.ts.
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const WORKSPACE_ROOT = resolve(__dirname, '..', '..', '..');
const PNPM_STORE = resolve(WORKSPACE_ROOT, 'node_modules', '.pnpm');

function findPnpmPackageDir(prefix: string): string | undefined {
  if (!existsSync(PNPM_STORE)) return undefined;
  const entries = readdirSync(PNPM_STORE);
  const match = entries.find((e) => e.startsWith(`${prefix}@`));
  if (!match) return undefined;
  const candidate = resolve(PNPM_STORE, match, 'node_modules', prefix);
  return existsSync(candidate) ? candidate : undefined;
}

const reactDir = findPnpmPackageDir('react');
const reactDomDir = findPnpmPackageDir('react-dom');
const PRECONDITIONS_OK = Boolean(reactDir && reactDomDir);

// De-quarantined 2026-06-24: the CI flakiness was the real stale-transform bug
// (vector (b) in the header), now fixed by the `/__validity/api/invalidate`
// endpoint this test drives. The afterAll teardown timeout was also raised so
// the Vite-server close can't blow vitest's default 10s hook budget under load.
const SKIP_REASON = !PRECONDITIONS_OK ? `react/react-dom not resolvable from ${PNPM_STORE}` : '';

const COMPONENT = `import React from 'react';
export default function Thing() { return <div>thing</div>; }
`;
const WRAPPER = `import React, { type ReactNode } from 'react';
export default function Wrapper({ children }: { children: ReactNode }) { return <>{children}</>; }
`;

/**
 * Build a config whose base AND scenario mockNetwork handlers carry a unique,
 * greppable marker string. The marker lands verbatim in the baked
 * `window.__VALIDITY_BASE_NETWORK__` / scenarios payload inside entry.tsx, so a
 * fetch of the transformed entry tells us which config the reused server is
 * serving — base and scenario handlers travel the same code path.
 */
function makeConfig(baseMarker: string, scenarioMarker: string): ValidityConfig {
  return {
    renderMode: 'web',
    framework: 'vite',
    wrapper: './.validity/wrapper.tsx',
    mockNetwork: {
      fallback: 'permissive',
      handlers: [{ url: '/api/marker', json: { marker: baseMarker } }],
    },
    scenarios: {
      'logged-in': {
        mockNetwork: {
          handlers: [{ url: '/api/me', json: { name: scenarioMarker } }],
        },
      },
    },
  };
}

function setupProject(): string {
  // realpathSync the tmp base: on macOS `tmpdir()` is `/var/...`, a symlink to
  // `/private/var/...`. Vite resolves the entry to its realpath, then refuses
  // to load it because the realpath falls outside `server.fs.allow` (which is
  // anchored on the symlinked root) — ERR_LOAD_URL — and silently falls back
  // to serving the raw file off disk. That fallback reads fresh every time, so
  // it would never exercise (or catch staleness in) the transform cache this
  // guard targets. A real user project root isn't a symlink, so resolving it
  // here matches production and lets the transform path actually run.
  const root = mkdtempSync(resolve(realpathSync(tmpdir()), 'validity-stale-'));
  const nm = resolve(root, 'node_modules');
  mkdirSync(nm, { recursive: true });
  symlinkSync(reactDir!, resolve(nm, 'react'));
  symlinkSync(reactDomDir!, resolve(nm, 'react-dom'));
  writeFileSync(
    resolve(root, 'package.json'),
    JSON.stringify({
      name: 'validity-stale-fixture',
      private: true,
      type: 'module',
      dependencies: { react: '18.3.1', 'react-dom': '18.3.1', vite: '6.0.7' },
    }),
  );
  mkdirSync(resolve(root, '.validity'), { recursive: true });
  writeFileSync(resolve(root, '.validity/wrapper.tsx'), WRAPPER);
  mkdirSync(resolve(root, 'src'), { recursive: true });
  writeFileSync(resolve(root, 'src/Thing.tsx'), COMPONENT);
  return root;
}

async function fetchEntry(url: string, headers?: Record<string, string>) {
  // GET /entry.tsx is a `.tsx` request, so Vite's transformMiddleware compiles
  // it and registers it in the module graph (where the staleness lives) — no
  // special headers needed once the fixture root isn't a symlink (see
  // setupProject). The transformed body inlines the baked handler markers.
  const res = await fetch(`${url}/entry.tsx`, headers ? { headers } : undefined);
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag'), text };
}

describe('verify-reuses-browse serves fresh baked handlers (no stale entry)', () => {
  let root: string | undefined;
  let dev: DevServer | undefined;

  beforeAll(() => {
    if (!PRECONDITIONS_OK) return;
    root = setupProject();
  });

  afterAll(async () => {
    try {
      if (dev) {
        // Let Vite's deps optimizer go idle BEFORE closing. Closing while an
        // optimization is in-flight leaves the esbuild context canceled but
        // undisposed, and server.close() then blocks on it forever — the
        // teardown hang the quarantine cited. In production the page has fully
        // loaded (optimization long settled) before close; this test closes
        // eagerly, so we reproduce that settled state explicitly.
        await dev.server.waitForRequestsIdle();
        await dev.close();
      }
    } catch {
      /* ignore */
    }
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
    // Backstop over vitest's default 10s hook timeout; the idle-wait above
    // makes close near-instant, so this is just insurance under CI load.
  }, 30_000);

  it.skipIf(!PRECONDITIONS_OK)(
    `a reused (lock-detected) browse server re-serves entry.tsx with edited mockNetwork handlers${
      SKIP_REASON ? ` (skip: ${SKIP_REASON})` : ''
    }`,
    async () => {
      if (!root) throw new Error('projectRoot not set up'); // satisfies TS

      // ---- Boot the browse server (browse mode: options.config set) ----
      const configA = makeConfig('BASE_ALPHA', 'SCEN_ALPHA');
      prepareSandbox(root, configA);
      dev = await startDevServer(root, { config: configA });

      // Record a browse lock the way `validity browse` does, and assert the
      // verify-side reuse detector resolves the live server through it — this
      // is the exact seam renderComponents reuses (render.ts:200-207).
      writeBrowseLock(root, {
        pid: process.pid,
        port: dev.port,
        startedAt: new Date().toISOString(),
      });
      const live = readLiveBrowseLock(root);
      expect(live).not.toBeNull();
      expect(live!.port).toBe(dev.port);
      const reusedUrl = `http://127.0.0.1:${live!.port}`;

      // ---- Warm the transform cache: load entry.tsx under config A. This
      // compiles the entry and pins its transform in the reused server's
      // module graph (the cache that goes stale). ----
      const warm = await fetchEntry(reusedUrl);
      expect(warm.text).toContain('BASE_ALPHA');
      expect(warm.text).toContain('SCEN_ALPHA');
      expect(warm.text).not.toContain('BASE_BRAVO');

      // ---- Edit .validity/config.ts handlers, then re-prepare. This is what
      // renderComponents does on the reuse path: prepareSandbox rewrites
      // entry.tsx in node_modules/.validity (which Vite's watcher ignores)
      // WITHOUT restarting the reused server. ----
      const configB = makeConfig('BASE_BRAVO', 'SCEN_BRAVO');
      prepareSandbox(root, configB);

      // ---- Prove the bug exists before proving the fix: with the entry
      // rewritten but NOT invalidated, the reused server still serves config
      // A's pinned transform. (This is the staleness the quarantine flagged.) ----
      const stale = await fetchEntry(reusedUrl);
      expect(stale.text).toContain('BASE_ALPHA');
      expect(stale.text).not.toContain('BASE_BRAVO');

      // ---- Drop the cached entry transform, exactly as renderComponents does
      // on the reuse path (render.ts → invalidateReusedSandbox). ----
      const inv = await fetch(`${reusedUrl}/__validity/api/invalidate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      expect(inv.status).toBe(200);
      // The endpoint must report entry.tsx as actually invalidated — a no-op
      // (empty list) would mean the entry module wasn't found and the fix isn't
      // engaged, so the freshness below would be coincidental.
      const invBody = (await inv.json()) as { ok: boolean; invalidated: string[] };
      expect(invBody.ok).toBe(true);
      expect(invBody.invalidated.some((u) => u.includes('entry.tsx'))).toBe(true);

      // ---- The reused server must now serve the NEW handlers. ----
      const fresh = await fetchEntry(reusedUrl);
      expect(fresh.text).toContain('BASE_BRAVO');
      expect(fresh.text).toContain('SCEN_BRAVO');
      expect(fresh.text).not.toContain('BASE_ALPHA');
      expect(fresh.text).not.toContain('SCEN_ALPHA');

      // ---- A real browser tab revalidates with If-None-Match. The stale etag
      // from config A must NOT yield a 304 (which would let the browser reuse
      // its cached stale module); Vite returns 200 with the fresh body. ----
      if (warm.etag) {
        const conditional = await fetchEntry(reusedUrl, { 'If-None-Match': warm.etag });
        expect(conditional.status).toBe(200);
        expect(conditional.text).toContain('BASE_BRAVO');
        expect(conditional.text).not.toContain('BASE_ALPHA');
      }
    },
    120_000,
  );
});
