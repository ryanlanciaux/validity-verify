/**
 * Tailwind-build dedupe (dogfood round-2, bug 1). Two concerns:
 *   - `sandboxTailwindDedupeTargets` decides WHEN the plugin is active.
 *   - the plugin's resolveId/load/transform hooks enforce the "entry stylesheet
 *     exists exactly once (via the shim)" invariant.
 * Hooks are exercised directly (no Vite server) so the cascade contract is
 * pinned without a full render.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  sandboxTailwindDedupeTargets,
  validityTailwindDedupePlugin,
  type TailwindDedupeTargets,
} from './tailwind-dedupe.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tmpProject(opts: { tailwind?: boolean; entryCss?: string | null } = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-tw-dedupe-'));
  roots.push(root);
  writeFileSync(
    resolve(root, 'package.json'),
    JSON.stringify({
      name: 'p',
      devDependencies: opts.tailwind === false ? {} : { '@tailwindcss/vite': '^4.0.0' },
    }),
  );
  mkdirSync(resolve(root, 'node_modules', '.validity'), { recursive: true });
  if (opts.entryCss !== null) {
    mkdirSync(resolve(root, 'src', 'styles'), { recursive: true });
    writeFileSync(
      resolve(root, opts.entryCss ?? 'src/styles/globals.css'),
      '@import "tailwindcss";\n@theme { --color-accent: #f0a; }\n.card { padding: 1rem; }\n',
    );
  }
  return root;
}

// Hooks are declared as plain functions in the plugin; unwrap the ObjectHook
// shape defensively and drop `this` (the hooks never use it).
function hook<T extends (...args: never[]) => unknown>(h: unknown): T {
  return (typeof h === 'function' ? h : (h as { handler: T }).handler) as T;
}

describe('sandboxTailwindDedupeTargets', () => {
  it('returns entry + shim paths when Tailwind v4 and a project entry stylesheet exist', () => {
    const root = tmpProject();
    const targets = sandboxTailwindDedupeTargets(root);
    expect(targets).not.toBeNull();
    expect(targets!.entryCssAbs).toBe(resolve(root, 'src/styles/globals.css'));
    expect(targets!.shimCssAbs).toBe(
      resolve(root, 'node_modules/.validity/validity-tailwind-shim.css'),
    );
  });

  it('is OFF without @tailwindcss/vite', () => {
    expect(sandboxTailwindDedupeTargets(tmpProject({ tailwind: false }))).toBeNull();
  });

  it('is OFF when no project entry stylesheet is found (bare-tailwindcss fallback shim)', () => {
    expect(sandboxTailwindDedupeTargets(tmpProject({ entryCss: null }))).toBeNull();
  });
});

describe('validityTailwindDedupePlugin hooks', () => {
  const targets: TailwindDedupeTargets = {
    entryCssAbs: '/proj/src/styles/globals.css',
    shimCssAbs: '/proj/node_modules/.validity/validity-tailwind-shim.css',
  };
  const plugin = validityTailwindDedupePlugin(targets);
  const resolveId = hook<(s: string, i?: string) => string | null>(plugin.resolveId);
  const load = hook<(id: string) => string | null>(plugin.load);
  const transform = hook<(code: string, id: string) => { code: string } | null>(plugin.transform);

  it('marks a DIRECT (wrapper/component) import of the entry stylesheet for neutralization', () => {
    const out = resolveId('../src/styles/globals.css', '/proj/.validity/wrapper.gen.tsx');
    expect(out).toBe('/proj/src/styles/globals.css?validity-tw-dedupe');
    // …and load() empties exactly that marked id.
    expect(load(out as string)).toBe('');
  });

  it("leaves the SHIM's own @import of the entry stylesheet untouched (the one complete build)", () => {
    // Same file resolves from the shim; discriminated by importer → not marked.
    const out = resolveId('../../src/styles/globals.css', targets.shimCssAbs);
    expect(out).toBeNull();
    // The un-marked entry id loads normally (returns null → Vite reads the file).
    expect(load('/proj/src/styles/globals.css')).toBeNull();
  });

  it('ignores imports of other stylesheets and entry-less resolutions', () => {
    expect(resolveId('./theme.css', '/proj/.validity/wrapper.gen.tsx')).toBeNull();
    expect(resolveId('../src/styles/globals.css', undefined)).toBeNull();
  });

  it('rewrites @import "tailwindcss" → @reference in OTHER directly-imported CSS (no dup build, @apply kept)', () => {
    const out = transform(
      '@import "tailwindcss";\n.badge { @apply inline-flex; color: red; }\n',
      '/proj/src/components/badge.css',
    );
    expect(out).not.toBeNull();
    expect(out!.code).toContain('@reference "tailwindcss";');
    expect(out!.code).not.toMatch(/@import\s+["']tailwindcss/);
    // Custom rules (NOT in the shim) survive.
    expect(out!.code).toContain('@apply inline-flex');
    expect(out!.code).toContain('color: red');
  });

  it('never rewrites the entry stylesheet or the shim, and no-ops plain CSS', () => {
    expect(transform('@import "tailwindcss";\n', targets.entryCssAbs)).toBeNull();
    expect(transform('@import "tailwindcss";\n', targets.shimCssAbs)).toBeNull();
    expect(transform('.x { color: blue; }', '/proj/src/plain.css')).toBeNull();
  });
});
