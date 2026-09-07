/**
 * Next.js render-support tests.
 *
 * **Scope:** full end-to-end Next.js rendering requires a real Next install
 * + Vite resolving the stubs; the existing sandbox integration suite covers
 * the standard web render path. Here we validate the contract pieces plus
 * the gate-integrity surface:
 *
 *   - `detectFramework()` returns `'next'` for a Next-style project.
 *   - `assertSupportedFramework('next')` does NOT throw; `'unknown'` does.
 *   - `resolveTarget('next', …)` returns `'next-web'`; `'auto'` resolves to
 *     `'next-web'` when the project looks like Next; a `'vite'` pin wins.
 *   - `buildNextWebViteOverrides()` emits the `next/*` aliases.
 *   - GATE-INTEGRITY: the server-only stub (`next/headers` / `next/cookies`)
 *     THROWS when called — a client component reaching for a server-only API
 *     must surface a render error, never silently no-op into a green screen.
 *
 * The stubs that `import React` (next/link, next/image, next/dynamic) can't
 * be unit-rendered here — `react` isn't a dependency of @validity.ai/verify-web;
 * Vite resolves it via the global `react` alias at render time. They're
 * exercised by the integration path. We smoke the react-free stubs
 * (next/font, next/headers) directly.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSupportedFramework, detectFramework } from './detect.js';
import { resolveTarget } from './render.js';
import { buildNextWebViteOverrides } from './next-web-aliases.js';

/** Build a minimal "looks like a Next.js project" tmp dir. */
function makeNextProjectRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-next-test-'));
  writeFileSync(
    resolve(root, 'package.json'),
    JSON.stringify({
      name: 'tmp-next',
      version: '0.0.0',
      dependencies: {
        next: '^14.0.0',
        react: '^18.2.0',
        'react-dom': '^18.2.0',
      },
    }),
  );
  // Minimal next.config.js — content irrelevant for these tests.
  writeFileSync(resolve(root, 'next.config.js'), `module.exports = {};\n`);
  // node_modules must exist for the .validity dir to land under it.
  mkdirSync(resolve(root, 'node_modules'), { recursive: true });
  return root;
}

describe('Next.js detection', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = makeNextProjectRoot();
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('detectFramework returns "next" for a project with next in deps', () => {
    expect(detectFramework(projectRoot)).toBe('next');
  });

  it('detectFramework returns "next" for a project with next.config.js (no next dep)', () => {
    // Remove the next dep but keep the config — detection should still fire.
    writeFileSync(
      resolve(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'tmp-next',
        version: '0.0.0',
        dependencies: { react: '^18.2.0' },
      }),
    );
    expect(detectFramework(projectRoot)).toBe('next');
  });

  it('assertSupportedFramework does NOT throw for next', () => {
    expect(() => assertSupportedFramework('next')).not.toThrow();
  });

  it('assertSupportedFramework still throws for unknown', () => {
    expect(() => assertSupportedFramework('unknown')).toThrow();
  });
});

describe('Next.js resolveTarget', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = makeNextProjectRoot();
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("explicit framework: 'next' resolves to 'next-web'", () => {
    expect(resolveTarget('next', projectRoot)).toBe('next-web');
  });

  it("explicit framework: 'next-web' resolves to 'next-web'", () => {
    expect(resolveTarget('next-web', projectRoot)).toBe('next-web');
  });

  it("framework: 'auto' resolves to 'next-web' when the project looks like Next", () => {
    expect(resolveTarget('auto', projectRoot)).toBe('next-web');
  });

  it("framework: 'vite' stays on 'web' even when the project looks like Next (user pin)", () => {
    expect(resolveTarget('vite', projectRoot)).toBe('web');
  });
});

describe('buildNextWebViteOverrides', () => {
  it('emits aliases for next/link, next/router, next/navigation, next/image, next/dynamic, next/headers, next/cookies', () => {
    const overrides = buildNextWebViteOverrides('/tmp/fake-project');
    const finds = overrides.alias.map((a) =>
      typeof a.find === 'string' ? a.find : String(a.find),
    );
    // All the stubbed next/* modules should be in the alias list. The exact
    // set is documented in next-web-aliases.ts; we check each one so a stub
    // file going missing shows up clearly in test output.
    expect(finds).toEqual(
      expect.arrayContaining([
        'next/link',
        'next/router',
        'next/navigation',
        'next/image',
        'next/dynamic',
        'next/headers',
        'next/cookies',
      ]),
    );
  });

  it('emits a regex alias for next/font/* (covers google + local)', () => {
    const overrides = buildNextWebViteOverrides('/tmp/fake-project');
    const hasFontRegex = overrides.alias.some(
      (a) => a.find instanceof RegExp && (a.find as RegExp).test('next/font/google'),
    );
    expect(hasFontRegex).toBe(true);
  });

  it('orders the next/font regex before the plain next/font string', () => {
    const overrides = buildNextWebViteOverrides('/tmp/fake-project');
    const regexIdx = overrides.alias.findIndex((a) => a.find instanceof RegExp);
    const stringIdx = overrides.alias.findIndex((a) => a.find === 'next/font');
    expect(regexIdx).toBeGreaterThanOrEqual(0);
    expect(stringIdx).toBeGreaterThan(regexIdx);
  });

  it('excludes the stubbed packages from optimizeDeps (Vite handles them as plain ES modules)', () => {
    const overrides = buildNextWebViteOverrides('/tmp/fake-project');
    expect(overrides.optimizeDepsExclude).toEqual(
      expect.arrayContaining([
        'next/link',
        'next/router',
        'next/navigation',
        'next/image',
        'next/dynamic',
        'next/font',
      ]),
    );
  });

  it('finds the shipped stubs in the monorepo (locateStub resolves), so aliases are non-empty', () => {
    // Documents the prod-ship dependency: in dev the stubs sit at
    // packages/verify-web/stubs/, so locateStub resolves and aliases install.
    // In a published tarball the stubs must be staged next to cli.js (see
    // staging-sources.ts) or this list goes empty and Next rendering breaks.
    const overrides = buildNextWebViteOverrides('/tmp/fake-project');
    expect(overrides.alias.length).toBeGreaterThan(0);
  });
});

describe('next/headers + next/cookies stub (GATE-INTEGRITY: server-only must throw)', () => {
  // This is the false-green guard. The server-only stub must NOT silently
  // no-op: a client component that calls headers()/cookies() has to surface
  // a render error (caught by the entry's error boundary → data-validity-error),
  // not paint a clean screenshot that gets scored as a pass.
  it('headers() throws and names "server-only"', async () => {
    const mod = await import('../stubs/next-server-only.js');
    expect(() => mod.headers()).toThrow(/server-only/);
  });

  it('cookies() throws and names "server-only"', async () => {
    const mod = await import('../stubs/next-server-only.js');
    expect(() => mod.cookies()).toThrow(/server-only/);
  });

  it('the default export bundles throwing headers + cookies', async () => {
    const mod = await import('../stubs/next-server-only.js');
    expect(() => mod.default.headers()).toThrow(/server-only/);
    expect(() => mod.default.cookies()).toThrow(/server-only/);
  });
});

describe('next/font stub (react-free smoke)', () => {
  it('makeFont() returns an empty className so font-styled components still render', async () => {
    const mod = await import('../stubs/next-font.js');
    const font = mod.default();
    expect(font.className).toBe('');
    expect(font.style).toEqual({ fontFamily: '' });
  });
});
