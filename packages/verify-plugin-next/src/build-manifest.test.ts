import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAppManifest,
  detectTailwind,
  envNamesFrom,
  parseJsonc,
  probePostcssConfig,
  readCssFacts,
  readEnvFacts,
  readTsconfigAliases,
  serializeAppManifest,
  stripJsonComments,
} from './build-manifest.js';

/**
 * Fixtures are REAL directories on disk, written fresh per test.
 *
 * Every fact in this module is derived from a filesystem convention, so a
 * fixture built out of an injected fake `fs` would prove the builder is
 * self-consistent while saying nothing about whether it reads the layout a Next
 * app actually has. Temp dirs cost milliseconds and test the real thing.
 */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scaffold(files: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-plugin-next-fx-'));
  tempDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

const posix = (p: string): string => p.replaceAll('\\', '/');

describe('parseJsonc', () => {
  it('tolerates the comments and trailing commas a real tsconfig carries', () => {
    const parsed = parseJsonc(`{
      // a line comment
      "compilerOptions": {
        /* and a block one */
        "baseUrl": ".",
        "paths": { "@/*": ["./src/*"] },
      },
    }`) as { compilerOptions: { baseUrl: string; paths: Record<string, string[]> } };
    expect(parsed.compilerOptions.baseUrl).toBe('.');
    expect(parsed.compilerOptions.paths['@/*']).toEqual(['./src/*']);
  });

  it('leaves comment-shaped text inside strings alone', () => {
    // The scanner is string-aware precisely so a URL doesn't get eaten as a
    // comment and take the rest of the file with it.
    const parsed = parseJsonc('{"url": "https://example.com/a//b", "glob": "src/**/*"}') as Record<
      string,
      string
    >;
    expect(parsed.url).toBe('https://example.com/a//b');
    expect(parsed.glob).toBe('src/**/*');
  });

  it('keeps an escaped quote from ending the string', () => {
    const parsed = parseJsonc('{"q": "he said \\"hi\\" // not a comment"}') as Record<
      string,
      string
    >;
    expect(parsed.q).toBe('he said "hi" // not a comment');
  });

  it('returns undefined rather than throwing on garbage', () => {
    expect(parseJsonc('{ this is not json')).toBeUndefined();
  });

  it('does not remove a comma that is not trailing', () => {
    expect(stripJsonComments('{"a": 1, "b": 2}')).toBe('{"a": 1, "b": 2}');
  });
});

describe('env facts', () => {
  it('reads NAMES and never values', () => {
    expect(
      envNamesFrom(
        [
          '# a comment',
          'NEXT_PUBLIC_API_URL=https://api.example.com',
          '  export NEXT_PUBLIC_FLAG=true',
          'DATABASE_URL=postgres://user:hunter2@localhost/db',
          '',
          'not an assignment',
        ].join('\n'),
      ),
    ).toEqual(['NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_FLAG', 'DATABASE_URL']);
  });

  it('counts distinct NEXT_PUBLIC_ names across every .env Next loads', () => {
    const root = scaffold({
      '.env': 'NEXT_PUBLIC_API_URL=https://api.example.com\nSECRET_TOKEN=hunter2\n',
      '.env.local': 'NEXT_PUBLIC_API_URL=https://local.example.com\nNEXT_PUBLIC_FLAG=1\n',
      '.env.production': 'NEXT_PUBLIC_SENTRY_DSN=https://abc@sentry.io/1\n',
      // Test-only env is not the app Validity renders — deliberately not counted.
      '.env.test': 'NEXT_PUBLIC_ONLY_IN_TESTS=1\n',
    });
    const env = readEnvFacts(root, false);
    expect(env.dir).toBe(posix(root));
    expect(env.prefixes).toEqual(['NEXT_PUBLIC_']);
    // API_URL appears twice and counts once; the non-public and test-only vars
    // don't count at all.
    expect(env.exposedKeyCount).toBe(3);
    expect(env.exposedKeys).toBeUndefined();
  });

  it('records sorted names under includeEnvKeys, and still no values', () => {
    const root = scaffold({
      '.env': 'NEXT_PUBLIC_Z=zzz\nNEXT_PUBLIC_A=aaa\nSECRET_TOKEN=hunter2\n',
    });
    const env = readEnvFacts(root, true);
    expect(env.exposedKeys).toEqual(['NEXT_PUBLIC_A', 'NEXT_PUBLIC_Z']);
    expect(JSON.stringify(env)).not.toContain('zzz');
    expect(JSON.stringify(env)).not.toContain('hunter2');
  });

  it('reports an honest zero when the app has no .env files', () => {
    const root = scaffold({ 'package.json': '{}' });
    expect(readEnvFacts(root, true)).toEqual({
      dir: posix(root),
      prefixes: ['NEXT_PUBLIC_'],
      exposedKeyCount: 0,
      exposedKeys: [],
    });
  });
});

describe('tsconfig aliases', () => {
  it('mirrors the create-next-app default (baseUrl + @/*)', () => {
    const root = scaffold({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
      }),
    });
    expect(readTsconfigAliases(root)).toEqual({
      aliases: [{ find: '@', replacement: `${posix(root)}/src` }],
      omitted: [],
    });
  });

  it('resolves targets against the tsconfig dir when there is no baseUrl', () => {
    // TypeScript 4.1+ allows `paths` without `baseUrl`, resolving each target
    // relative to the config file that declares it. Next's newer templates do
    // exactly this.
    const root = scaffold({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./app/*'] } } }),
    });
    expect(readTsconfigAliases(root).aliases).toEqual([
      { find: '@', replacement: `${posix(root)}/app` },
    ]);
  });

  it('falls back to jsconfig.json for a JavaScript app', () => {
    const root = scaffold({
      'jsconfig.json': JSON.stringify({ compilerOptions: { paths: { '~/*': ['./src/*'] } } }),
    });
    expect(readTsconfigAliases(root).aliases).toEqual([
      { find: '~', replacement: `${posix(root)}/src` },
    ]);
  });

  it('records every pattern shape it refuses to re-implement', () => {
    const root = scaffold({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: {
            '@/*': ['./src/*'],
            // A fallback chain: TS tries each in order. Mirroring only the
            // first would silently resolve to a different file.
            '@lib/*': ['./src/lib/*', './vendor/lib/*'],
            // Mid-pattern wildcard needs TS's longest-prefix matching.
            '@feat/*/api': ['./src/features/*/api'],
            // Exact (non-prefix) mapping.
            '@config': ['./src/config.ts'],
          },
        },
      }),
    });
    const { aliases, omitted } = readTsconfigAliases(root);
    expect(aliases).toEqual([{ find: '@', replacement: `${posix(root)}/src` }]);
    expect(omitted).toEqual([
      { find: '@lib/*', reason: 'unsupported-tsconfig-pattern' },
      { find: '@feat/*/api', reason: 'unsupported-tsconfig-pattern' },
      { find: '@config', reason: 'unsupported-tsconfig-pattern' },
    ]);
  });

  it('follows one level of relative extends, resolving against the PARENT config dir', () => {
    const root = scaffold({
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: { baseUrl: './packages', paths: { '@ui/*': ['./ui/src/*'] } },
      }),
      'apps/web/tsconfig.json': JSON.stringify({ extends: '../../tsconfig.base.json' }),
    });
    const app = resolve(root, 'apps/web');
    // baseUrl is `./packages` relative to the file that DECLARED it (the repo
    // root), not relative to the app that inherited it.
    expect(readTsconfigAliases(app)).toEqual({
      aliases: [{ find: '@ui', replacement: `${posix(root)}/packages/ui/src` }],
      omitted: [],
    });
  });

  it("lets the child's own paths win over an inherited set", () => {
    const root = scaffold({
      'base.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./base/*'] } } }),
      'tsconfig.json': JSON.stringify({
        extends: './base.json',
        compilerOptions: { paths: { '@/*': ['./child/*'] } },
      }),
    });
    // TypeScript replaces `paths` wholesale rather than merging it.
    expect(readTsconfigAliases(root).aliases).toEqual([
      { find: '@', replacement: `${posix(root)}/child` },
    ]);
  });

  it('inherits baseUrl from the parent while taking paths from the child', () => {
    const root = scaffold({
      'base.json': JSON.stringify({ compilerOptions: { baseUrl: './src' } }),
      'tsconfig.json': JSON.stringify({
        extends: './base.json',
        compilerOptions: { paths: { '@/*': ['./components/*'] } },
      }),
    });
    expect(readTsconfigAliases(root).aliases).toEqual([
      { find: '@', replacement: `${posix(root)}/src/components` },
    ]);
  });

  it('refuses to resolve a package extends, and says so', () => {
    const root = scaffold({
      'tsconfig.json': JSON.stringify({ extends: '@tsconfig/next/tsconfig.json' }),
    });
    expect(readTsconfigAliases(root)).toEqual({
      aliases: [],
      omitted: [{ find: '@tsconfig/next/tsconfig.json', reason: 'unresolved-tsconfig-extends' }],
    });
  });

  it('records a deeper extends chain instead of implying the alias list is complete', () => {
    const root = scaffold({
      'grandparent.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./deep/*'] } } }),
      'parent.json': JSON.stringify({ extends: './grandparent.json' }),
      'tsconfig.json': JSON.stringify({ extends: './parent.json' }),
    });
    const { aliases, omitted } = readTsconfigAliases(root);
    expect(aliases).toEqual([]);
    expect(omitted).toEqual([
      { find: './grandparent.json', reason: 'unresolved-tsconfig-extends' },
    ]);
  });

  it('stays quiet about a deeper chain once it has found real paths', () => {
    const root = scaffold({
      'grandparent.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'parent.json': JSON.stringify({
        extends: './grandparent.json',
        compilerOptions: { paths: { '@/*': ['./src/*'] } },
      }),
      'tsconfig.json': JSON.stringify({ extends: './parent.json' }),
    });
    // The parent declared `paths`, so TypeScript would use those and nothing
    // further up can add to them — there is no incompleteness to report.
    expect(readTsconfigAliases(root)).toEqual({
      aliases: [{ find: '@', replacement: `${posix(root)}/src` }],
      omitted: [],
    });
  });

  it('resolves an extends that omits the .json extension', () => {
    const root = scaffold({
      'base.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'tsconfig.json': JSON.stringify({ extends: './base' }),
    });
    expect(readTsconfigAliases(root).aliases).toEqual([
      { find: '@', replacement: `${posix(root)}/src` },
    ]);
  });

  it('reports an unparsable config rather than reporting no aliases', () => {
    const root = scaffold({ 'tsconfig.json': '{ "compilerOptions": ' });
    expect(readTsconfigAliases(root)).toEqual({
      aliases: [],
      omitted: [{ find: 'tsconfig.json', reason: 'unparsable-tsconfig' }],
    });
  });

  it('records nothing at all when the app has no ts/jsconfig', () => {
    const root = scaffold({ 'package.json': '{}' });
    expect(readTsconfigAliases(root)).toEqual({ aliases: [], omitted: [] });
  });
});

describe('css facts', () => {
  it('finds the PostCSS config Next discovers from the app root', () => {
    const root = scaffold({ 'postcss.config.mjs': 'export default { plugins: {} };\n' });
    expect(probePostcssConfig(root)).toBe(`${posix(root)}/postcss.config.mjs`);
  });

  it('is null when there is no PostCSS config', () => {
    expect(probePostcssConfig(scaffold({ 'package.json': '{}' }))).toBeNull();
  });

  it('reads Tailwind v4 off @tailwindcss/postcss', () => {
    expect(detectTailwind(new Set(['tailwindcss', '@tailwindcss/postcss']), true)).toEqual({
      detected: true,
      via: 'postcss',
      major: 4,
    });
  });

  it('reads Tailwind v3 off a bare tailwindcss dep plus a PostCSS config', () => {
    expect(detectTailwind(new Set(['tailwindcss']), true)).toEqual({
      detected: true,
      via: 'postcss',
      major: 3,
    });
  });

  it('claims nothing from a dependency with no wiring', () => {
    // A dependency proves installation, not that the build uses it.
    expect(detectTailwind(new Set(['tailwindcss']), false)).toEqual({
      detected: false,
      via: null,
      major: null,
    });
    expect(detectTailwind(new Set(['next', 'react']), true)).toEqual({
      detected: false,
      via: null,
      major: null,
    });
  });

  it('assembles the CSS block from package.json + a config probe', () => {
    const root = scaffold({
      'package.json': JSON.stringify({
        dependencies: { next: '15.0.0' },
        devDependencies: { tailwindcss: '^3.4.0' },
      }),
      'postcss.config.js': 'module.exports = { plugins: { tailwindcss: {} } };\n',
    });
    expect(readCssFacts(root)).toEqual({
      tailwind: { detected: true, via: 'postcss', major: 3 },
      // Never fabricated: the plugin list lives inside a config file Next
      // itself defers loading, and entry CSS is a module-graph question.
      postcssPlugins: [],
      postcssConfigPath: `${posix(root)}/postcss.config.js`,
      entryCss: [],
    });
  });
});

describe('buildAppManifest', () => {
  const identity = { generatorName: '@validity.ai/verify-plugin-next', generatorVersion: '9.9.9' };

  it('assembles a schema-v1 manifest labelled next', () => {
    const root = scaffold({
      'package.json': JSON.stringify({ dependencies: { '@tailwindcss/postcss': '^4.0.0' } }),
      'postcss.config.mjs': 'export default { plugins: { "@tailwindcss/postcss": {} } };\n',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
      }),
      '.env': 'NEXT_PUBLIC_API_URL=https://api.example.com\n',
    });
    expect(buildAppManifest(root, identity)).toEqual({
      schemaVersion: 1,
      generator: { name: '@validity.ai/verify-plugin-next', version: '9.9.9' },
      framework: 'next',
      root: posix(root),
      // Next has no HTML/module entry pair, and inventing one would send
      // Validity's wrapper generation at a file that isn't the app's entry.
      entry: { html: null, module: null },
      env: { dir: posix(root), prefixes: ['NEXT_PUBLIC_'], exposedKeyCount: 1 },
      css: {
        tailwind: { detected: true, via: 'postcss', major: 4 },
        postcssPlugins: [],
        postcssConfigPath: `${posix(root)}/postcss.config.mjs`,
        entryCss: [],
      },
      aliases: [{ find: '@', replacement: `${posix(root)}/src` }],
      aliasesOmitted: [],
      plugins: [],
    });
  });

  it('records honest empty values for an app with no conventions at all', () => {
    const root = scaffold({ 'package.json': '{}' });
    const m = buildAppManifest(root, identity);
    expect(m.env.exposedKeyCount).toBe(0);
    expect(m.css.tailwind).toEqual({ detected: false, via: null, major: null });
    expect(m.css.postcssConfigPath).toBeNull();
    expect(m.aliases).toEqual([]);
    expect(m.aliasesOmitted).toEqual([]);
    expect(m.plugins).toEqual([]);
  });
});

describe('serializeAppManifest', () => {
  it("writes plugin-vite's key order, two-space indent and a trailing newline", () => {
    const root = scaffold({ 'package.json': '{}' });
    const text = serializeAppManifest(
      buildAppManifest(root, { generatorName: 'g', generatorVersion: '1' }),
    );
    // Byte compatibility with the Vite writer is what lets one reader, one
    // report and one diff handle manifests from either producer.
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'schemaVersion',
      'generator',
      'framework',
      'root',
      'entry',
      'env',
      'css',
      'aliases',
      'aliasesOmitted',
      'plugins',
    ]);
    expect(text.startsWith('{\n  "schemaVersion": 1,\n')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
  });
});
