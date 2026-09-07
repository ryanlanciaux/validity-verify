import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `next.config.*` comes in three module flavours — CommonJS `.js`, ESM `.mjs`,
 * and TypeScript `.ts` — and this package has to be importable from all of
 * them. That is a PACKAGING property, invisible to every other test in this
 * suite (vitest resolves the TypeScript sources, not the published shape), so
 * it is asserted here. A "cleanup" that collapses the dual build shows up as a
 * red test instead of as `ERR_REQUIRE_ESM` inside somebody's `next dev`.
 */
function pkgUrl(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}

interface Manifest {
  name: string;
  version: string;
  license?: string;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: Record<string, Record<string, string>>;
  files?: string[];
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(pkgUrl('package.json'), 'utf-8')) as Manifest;

describe('package shape (Next config resolution)', () => {
  it('is publishable under the same terms as the sibling plugins', () => {
    expect(manifest.name).toBe('@validity.ai/verify-plugin-next');
    expect(manifest.license).toBe('MIT');
    expect(manifest.engines?.node).toBe('>=20');
    expect(manifest.files).toEqual(['dist', '!dist/.tsbuildinfo', 'README.md']);
    expect(existsSync(pkgUrl('README.md'))).toBe(true);
  });

  it('ships ESM and CommonJS from separate entry points', () => {
    // `import` must land on real ESM: a CJS-only build makes
    // `import withValidity from '@validity.ai/verify-plugin-next'` resolve to the module
    // NAMESPACE rather than the function, so the user's config would call an
    // object. `require` must land on real CJS: `require()` of an ESM-only
    // package throws ERR_REQUIRE_ESM on every Node before 20.19/22.12.
    expect(manifest.type).toBe('module');
    expect(manifest.exports?.['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
      require: './dist/cjs/index.js',
      default: './dist/index.js',
    });
    // `main` is the last-resort entry for a resolver with no exports support;
    // it points at CJS because that resolver is a CJS resolver.
    expect(manifest.main).toBe('./dist/cjs/index.js');
    expect(manifest.types).toBe('./dist/index.d.ts');
  });

  it('builds both halves and stamps the CommonJS one', () => {
    // The nested dist/cjs/package.json is what makes those .js files CommonJS
    // inside a "type": "module" package. Dropping the stamp step silently
    // breaks every `next.config.js` in the world.
    const build = manifest.scripts?.build ?? '';
    expect(build).toContain('tsc -b');
    expect(build).toContain('tsconfig.cjs.json');
    expect(build).toContain('finalize-cjs.mjs');
  });

  it('depends on nothing — not even Next', () => {
    // The wrapper imports nothing from `next` (phase constants are compared as
    // strings), so a peer would be a constraint the code does not have. It is
    // also not free: pnpm auto-installs peers, which would drag Next and React
    // into this monorepo's lockfile.
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
  });

  it('has no @validity/* runtime dependency', () => {
    // Publishing must not drag @validity.ai/verify-spec with it, and the v1 `file:`
    // extraction into .validity/plugins/ has no workspace to link to. The
    // manifest types are re-declared locally for exactly this reason.
    const sources = ['src/index.ts', 'src/schema.ts', 'src/build-manifest.ts', 'src/version.ts'];
    for (const rel of sources) {
      // Prose and doc examples reference the @validity packages on purpose
      // (the manifest types are a documented twin of plugin-vite's, and the
      // usage examples import this very package), so comment lines are
      // stripped first. What must never appear is a real import in CODE.
      const code = readFileSync(pkgUrl(rel), 'utf-8')
        .split('\n')
        .filter((line) => {
          const t = line.trimStart();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
        })
        .join('\n');
      expect(/from\s+['"]@validity\//.test(code)).toBe(false);
      expect(/require\(\s*['"]@validity\//.test(code)).toBe(false);
    }
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      expect(dep.startsWith('@validity/')).toBe(false);
    }
  });
});
