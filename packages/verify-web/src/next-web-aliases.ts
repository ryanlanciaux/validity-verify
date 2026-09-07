/**
 * Vite alias map + optimizeDeps tuning for Next.js (client component) rendering.
 *
 * Next.js client components (`'use client'`) are React components that import
 * from `next/*`. Validity's sandbox renders them through Vite + React, with
 * the `next/*` imports aliased to DOM-friendly stubs so the component mounts
 * without Next's server runtime.
 *
 * What's stubbed:
 *   - `next/link`           → `<a href>` (no router navigation)
 *   - `next/router`         → mock `useRouter()` returning no-op nav methods
 *   - `next/navigation`     → mock `useRouter`/`usePathname`/`useSearchParams`/`useParams`
 *   - `next/image`          → `<img>` passthrough (no optimizer)
 *   - `next/font`           → empty className (font loading is build-time)
 *   - `next/dynamic`        → eager (no SSR / no lazy)
 *   - `next/headers`        → throws (server-only)
 *   - `next/cookies`        → throws (server-only)
 *
 * **What's out of scope (explicitly):**
 *   - Server Components (RSC) — require Next's server runtime; not rendered.
 *   - Route Handlers / API routes — not UI.
 *   - Middleware — edge runtime.
 *   - `next/headers` / `next/cookies` — server-only, stubbed to throw.
 *   - Full `next/router` / `next/navigation` behavior — navigation calls are
 *     no-ops; `<Link>` renders an `<a>` but clicking doesn't change the route.
 */
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Alias } from 'vite';

export interface NextWebViteOverrides {
  alias: Alias[];
  /** Bare specifiers Vite's optimizer should pre-bundle for the sandbox. */
  optimizeDepsInclude: string[];
  /** Bare specifiers Vite's optimizer should leave alone. */
  optimizeDepsExclude: string[];
}

/**
 * Path to a stub shipped with @validity.ai/verify-web. Resolved relative to this
 * module so the same lookup works in dev (TS source under
 * packages/verify-web/src/, stubs at packages/verify-web/stubs/) and in the
 * published bundle (where stubs/ sits next to cli.js). Mirrors the
 * dual-candidate `locateStub` in expo-web-aliases.ts.
 */
function locateStub(stubName: string): string | undefined {
  try {
    const here = new URL(import.meta.url).pathname;
    const candidates = [
      resolve(dirname(here), '..', 'stubs', stubName),
      resolve(dirname(here), 'stubs', stubName),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the Vite alias + optimizeDeps overrides Validity adds when the
 * project is a Next.js app. Caller merges these on top of the standard web
 * sandbox overrides.
 */
export function buildNextWebViteOverrides(projectRoot: string): NextWebViteOverrides {
  void projectRoot; // resolution is stub-based, not dep-aware (yet).
  const alias: Alias[] = [];

  // next/link → stub that renders <a href>. Preserves href, children, rest.
  const linkStub = locateStub('next-link.js');
  if (linkStub) alias.push({ find: 'next/link', replacement: linkStub });

  // next/router (Pages Router) → mock useRouter.
  const routerStub = locateStub('next-router.js');
  if (routerStub) alias.push({ find: 'next/router', replacement: routerStub });

  // next/navigation (App Router) → mock useRouter/usePathname/useSearchParams/useParams.
  const navStub = locateStub('next-navigation.js');
  if (navStub) alias.push({ find: 'next/navigation', replacement: navStub });

  // next/image → <img> passthrough.
  const imageStub = locateStub('next-image.js');
  if (imageStub) alias.push({ find: 'next/image', replacement: imageStub });

  // next/dynamic → eager (no SSR, no lazy).
  const dynamicStub = locateStub('next-dynamic.js');
  if (dynamicStub) alias.push({ find: 'next/dynamic', replacement: dynamicStub });

  // next/font/* → empty className. Covers next/font/google, next/font/local.
  // Push the regex first so subpath imports match before the plain string.
  const fontStub = locateStub('next-font.js');
  if (fontStub) {
    alias.push({ find: /^next\/font\/(.*)$/, replacement: fontStub });
    alias.push({ find: 'next/font', replacement: fontStub });
  }

  // next/headers, next/cookies → throw (server-only). A client component
  // that reaches for these must surface a render error, never silently
  // no-op into a green screenshot.
  const serverOnlyStub = locateStub('next-server-only.js');
  if (serverOnlyStub) {
    alias.push({ find: 'next/headers', replacement: serverOnlyStub });
    alias.push({ find: 'next/cookies', replacement: serverOnlyStub });
  }

  return {
    alias,
    // The stubs are tiny plain ES modules — Vite handles them without the
    // optimizer. `react` / `react-dom` are pre-bundled by the standard web
    // sandbox overrides already.
    optimizeDepsInclude: [],
    optimizeDepsExclude: [
      'next/link',
      'next/router',
      'next/navigation',
      'next/image',
      'next/dynamic',
      'next/font',
    ],
  };
}
