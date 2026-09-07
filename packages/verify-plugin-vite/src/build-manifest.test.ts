import { describe, expect, it } from 'vitest';
import {
  buildAppManifest,
  detectFramework,
  detectTailwind,
  htmlEntries,
  readEntryFacts,
  serializeAliases,
  serializeAppManifest,
  summarizeEnv,
  userPluginNames,
  type ManifestFs,
  type ResolvedConfigLike,
} from './build-manifest.js';

/**
 * In-memory filesystem keyed by absolute POSIX path. Keeps these tests
 * hermetic — the builder's only impurity is file reads, so faking those makes
 * every assertion here a statement about the manifest contract rather than
 * about the machine it ran on.
 */
function fakeFs(files: Record<string, string>): ManifestFs {
  return {
    existsSync: (p) => Object.hasOwn(files, p.replaceAll('\\', '/')),
    readFileSync: (p) => {
      const key = p.replaceAll('\\', '/');
      if (!Object.hasOwn(files, key)) throw new Error(`ENOENT: ${key}`);
      return files[key]!;
    },
  };
}

const ROOT = '/app';

function config(overrides: Partial<ResolvedConfigLike> = {}): ResolvedConfigLike {
  return { root: ROOT, ...overrides };
}

describe('serializeAliases', () => {
  it('mirrors string→string aliases and absolutizes relative replacements', () => {
    const { aliases, omitted } = serializeAliases(
      [
        { find: '@', replacement: './src' },
        { find: '@ui', replacement: '/abs/packages/ui/src' },
        { find: 'react-native', replacement: 'react-native-web' },
      ],
      ROOT,
    );
    expect(aliases).toEqual([
      { find: '@', replacement: '/app/src' },
      { find: '@ui', replacement: '/abs/packages/ui/src' },
      { find: 'react-native', replacement: 'react-native-web' },
    ]);
    expect(omitted).toEqual([]);
  });

  it('records regexp finds, custom resolvers and non-string replacements instead of crashing', () => {
    const { aliases, omitted } = serializeAliases(
      [
        { find: /^~(.*)$/, replacement: './src/$1' },
        { find: '@lazy', replacement: './src/lazy', customResolver: () => undefined },
        { find: '@weird', replacement: { nested: true } },
        { find: '@ok', replacement: './src/ok' },
      ],
      ROOT,
    );
    // The one serializable entry still makes it through — a single exotic
    // alias must never cost the user every other alias.
    expect(aliases).toEqual([{ find: '@ok', replacement: '/app/src/ok' }]);
    expect(omitted).toEqual([
      { find: '/^~(.*)$/', reason: 'regexp-find' },
      { find: '@lazy', reason: 'custom-resolver' },
      { find: '@weird', reason: 'non-string-replacement' },
    ]);
  });

  it("omits Vite's own client aliases so the sandbox never links the user's vite runtime", () => {
    const { aliases, omitted } = serializeAliases(
      [
        { find: /^\/?@vite\/env/, replacement: '/@fs/app/node_modules/vite/dist/client/env.mjs' },
        {
          find: /^\/?@vite\/client/,
          replacement: '/@fs/app/node_modules/vite/dist/client/client.mjs',
        },
        { find: '@', replacement: './src' },
      ],
      ROOT,
    );
    expect(aliases).toEqual([{ find: '@', replacement: '/app/src' }]);
    expect(omitted.map((o) => o.reason)).toEqual(['vite-internal', 'vite-internal']);
  });

  it('tolerates a missing or non-array alias field', () => {
    expect(serializeAliases(undefined, ROOT)).toEqual({ aliases: [], omitted: [] });
    expect(serializeAliases({ '@': './src' }, ROOT)).toEqual({ aliases: [], omitted: [] });
  });
});

describe('summarizeEnv', () => {
  it('records envDir + prefixes and counts exposed keys without recording values', () => {
    const env = summarizeEnv(
      config({
        envDir: '/app/config',
        envPrefix: ['PUBLIC_', 'VITE_'],
        env: {
          BASE_URL: '/',
          MODE: 'development',
          DEV: true,
          PROD: false,
          SSR: false,
          VITE_API_URL: 'https://api.example.com',
          PUBLIC_TOKEN: 'sk_live_do_not_leak',
        },
      }),
      false,
    );
    expect(env).toEqual({
      dir: '/app/config',
      prefixes: ['PUBLIC_', 'VITE_'],
      exposedKeyCount: 2,
    });
    // The secret must not appear anywhere in the serialized form.
    expect(JSON.stringify(env)).not.toContain('sk_live');
    expect(JSON.stringify(env)).not.toContain('VITE_API_URL');
  });

  it('records key NAMES only when explicitly opted in, and never values', () => {
    const env = summarizeEnv(
      config({ env: { MODE: 'development', VITE_B: '2', VITE_A: '1' } }),
      true,
    );
    expect(env.exposedKeys).toEqual(['VITE_A', 'VITE_B']);
    expect(JSON.stringify(env)).not.toContain('"1"');
  });

  it("defaults envDir to root and envPrefix to Vite's default", () => {
    expect(summarizeEnv(config(), false)).toEqual({
      dir: '/app',
      prefixes: ['VITE_'],
      exposedKeyCount: 0,
    });
  });

  it('accepts the string form of envPrefix', () => {
    expect(summarizeEnv(config({ envPrefix: 'APP_' }), false).prefixes).toEqual(['APP_']);
  });
});

describe('userPluginNames', () => {
  it("drops Vite's internals so the list does not churn between serve and build", () => {
    expect(
      userPluginNames(
        config({
          plugins: [
            { name: 'alias' },
            { name: 'vite:resolve' },
            { name: 'vite:react-babel' },
            { name: '@tailwindcss/vite:generate:serve' },
            { name: 'vite-tsconfig-paths' },
            { name: 'commonjs' },
            null,
            { name: '' },
          ],
        }),
      ),
    ).toEqual(['@tailwindcss/vite:generate:serve', 'vite-tsconfig-paths']);
  });
});

describe('detectTailwind', () => {
  it('recognizes the v4 Vite plugin', () => {
    expect(detectTailwind(['@tailwindcss/vite:generate:serve'], [])).toEqual({
      detected: true,
      via: 'vite-plugin',
      major: 4,
    });
  });

  it('recognizes the v4 PostCSS package', () => {
    expect(detectTailwind([], ['@tailwindcss/postcss', 'autoprefixer'])).toEqual({
      detected: true,
      via: 'postcss',
      major: 4,
    });
  });

  it('recognizes v3 through PostCSS — the case the sandbox shim does NOT cover', () => {
    expect(detectTailwind([], ['tailwindcss', 'autoprefixer'])).toEqual({
      detected: true,
      via: 'postcss',
      major: 3,
    });
  });

  it('reports honest absence rather than guessing', () => {
    expect(detectTailwind(['vite-plugin-svgr'], ['autoprefixer'])).toEqual({
      detected: false,
      via: null,
      major: null,
    });
  });
});

describe('htmlEntries', () => {
  it('falls back to root index.html when rollup input is unset', () => {
    const fs = fakeFs({ '/app/index.html': '<html></html>' });
    expect(htmlEntries(config(), fs)).toEqual(['/app/index.html']);
  });

  it('honors explicit rollup inputs in declaration order and ignores non-html entries', () => {
    const fs = fakeFs({});
    expect(
      htmlEntries(
        config({
          build: {
            rollupOptions: { input: { admin: 'admin/index.html', lib: 'src/lib.ts' } },
          },
        }),
        fs,
      ),
    ).toEqual(['/app/admin/index.html']);
  });

  it('returns nothing for a library build with no html', () => {
    expect(htmlEntries(config(), fakeFs({}))).toEqual([]);
  });
});

describe('readEntryFacts', () => {
  const html = [
    '<!doctype html>',
    '<html>',
    '  <head>',
    '    <link rel="preconnect" href="https://fonts.example" />',
    '    <link href="/styles/reset.css" rel="stylesheet" />',
    '    <link rel="stylesheet" href="https://cdn.example/x.css" />',
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.tsx"></script>',
    '  </body>',
    '</html>',
  ].join('\n');

  const main = [
    "import React from 'react';",
    "import './index.css';",
    "import styles from './App.module.css';",
    "import 'some-pkg/dist/style.css';",
    "import App from './App';",
  ].join('\n');

  it('reads the authoritative entry pair from index.html', () => {
    const fs = fakeFs({
      '/app/index.html': html,
      '/app/src/main.tsx': main,
    });
    const { entry } = readEntryFacts(config(), fs);
    expect(entry).toEqual({ html: 'index.html', module: 'src/main.tsx' });
  });

  it('collects entry CSS from the html links and the entry module, skipping remote + bare specs', () => {
    const fs = fakeFs({
      '/app/index.html': html,
      '/app/src/main.tsx': main,
    });
    const { entryCss } = readEntryFacts(config(), fs);
    expect(entryCss).toEqual(['styles/reset.css', 'src/index.css', 'src/App.module.css']);
  });

  it('degrades to nulls rather than throwing when there is no html entry', () => {
    expect(readEntryFacts(config(), fakeFs({}))).toEqual({
      entry: { html: null, module: null },
      entryCss: [],
    });
  });

  it('records the html entry but no module when the script is inline', () => {
    const fs = fakeFs({ '/app/index.html': '<script type="module">boot()</script>' });
    const { entry } = readEntryFacts(config(), fs);
    expect(entry).toEqual({ html: 'index.html', module: null });
  });
});

describe('detectFramework', () => {
  /**
   * Verbatim plugin names from a real scaffolded TanStack Start app
   * (`@tanstack/react-start` 1.168.38 on Vite 8.2.1), in resolved order with
   * Vite's own internals filtered out — i.e. exactly what `userPluginNames`
   * hands `detectFramework`. Kept as observed rather than trimmed to the one
   * name the matcher needs, so a future rename shows up here as a real diff.
   */
  const TANSTACK_START_PLUGINS = [
    'tanstack-start-core:config',
    'tanstack-start-core::server-fn:client',
    'tanstack-start-core::server-fn:ssr',
    'tanstack-start-core:compiler-virtual-module',
    'tanstack-start-core:server-fn-resolver',
    'tanstack-start-core:import-protection',
    'tanstack-start:route-tree-client-plugin',
    'tanstack:router-generator',
    'tanstack-router:code-splitter:compile-reference-file',
    'tanstack-router:code-splitter:compile-virtual-file',
    'tanstack-router:code-splitter:compile-shared-file',
    'tanstack-start-core:load-env',
    'tanstack-start-core:dev-client-entry',
    'tanstack-start:start-manifest-plugin',
    'tanstack-react-start:config',
    'tanstack-start-core:dev-base-rewrite',
    'tanstack-start-core:dev-server',
    'tanstack-start-core:preview-server',
    'tanstack-start-core:post-build',
    'tanstack-start:start-manifest-capture-client-build',
  ];

  /**
   * The complete non-Vite plugin set of a plain Vite SPA that uses
   * `@tanstack/router-plugin` and nothing else — also observed, not invented.
   * Every one of these ALSO appears in the Start list above, which is exactly
   * why they cannot be the evidence.
   */
  const TANSTACK_ROUTER_ONLY_PLUGINS = [
    'tanstack:router-generator',
    'tanstack-router:code-splitter:compile-reference-file',
    'tanstack-router:code-splitter:compile-virtual-file',
    'tanstack-router:code-splitter:compile-shared-file',
    'tanstack:router-inline-css-defaults',
  ];

  it('claims expo-web only on hard react-native-web evidence', () => {
    expect(
      detectFramework(
        [{ find: 'react-native', replacement: '/app/node_modules/react-native-web' }],
        [],
      ),
    ).toBe('expo-web');
    expect(detectFramework([], ['vite-plugin-rnw'])).toBe('expo-web');
  });

  it('stays vite for a plain web app', () => {
    expect(detectFramework([{ find: '@', replacement: '/app/src' }], ['vite-plugin-svgr'])).toBe(
      'vite',
    );
  });

  it("claims tanstack-start on Start's own resolved plugins", () => {
    expect(detectFramework([], TANSTACK_START_PLUGINS)).toBe('tanstack-start');
  });

  it('matches each observed Start prefix family on its own', () => {
    // One plugin is enough: a partial pipeline (a plugin filtered by `apply`,
    // a future Start release that drops one of these) must still be Start.
    expect(detectFramework([], ['tanstack-start-core:config'])).toBe('tanstack-start');
    expect(detectFramework([], ['tanstack-start:start-manifest-plugin'])).toBe('tanstack-start');
    expect(detectFramework([], ['tanstack-react-start:config'])).toBe('tanstack-start');
    // The framework infix generalizes from the observed react form, so the
    // Solid package labels itself correctly without a second observation.
    expect(detectFramework([], ['tanstack-solid-start:config'])).toBe('tanstack-start');
  });

  it('does NOT claim tanstack-start for a TanStack Router SPA — Router is not Start', () => {
    // A plain Vite app with file-based routing has no Start server, no server
    // functions and no Start build pipeline. Calling it `tanstack-start` would
    // assert a framework it does not run.
    expect(detectFramework([], TANSTACK_ROUTER_ONLY_PLUGINS)).toBe('vite');
    // Nor does the bare dependency, which leaves no plugin trace at all.
    expect(detectFramework([{ find: '@', replacement: '/app/src' }], [])).toBe('vite');
  });

  it('keeps expo-web when RN-Web and TanStack Start evidence collide', () => {
    // Precedence is deliberate and asymmetric. `expo-web` says "this app's
    // source is React Native", a claim about what is being rendered;
    // `tanstack-start` is provenance about the build pipeline that nothing
    // branches on. Dropping the RN-Web signal would misdescribe the app, so
    // the RN checks run first and win — via either evidence path.
    expect(
      detectFramework(
        [{ find: 'react-native', replacement: '/app/node_modules/react-native-web' }],
        TANSTACK_START_PLUGINS,
      ),
    ).toBe('expo-web');
    expect(detectFramework([], ['vite-plugin-rnw', ...TANSTACK_START_PLUGINS])).toBe('expo-web');
    // And the case the plan calls out by name: RN-Web + TanStack Router only.
    expect(detectFramework([], ['vite-plugin-rnw', ...TANSTACK_ROUTER_ONLY_PLUGINS])).toBe(
      'expo-web',
    );
  });
});

describe('buildAppManifest + serializeAppManifest', () => {
  const files = {
    '/app/index.html': '<script type="module" src="/src/main.tsx"></script>',
    '/app/src/main.tsx': "import './index.css';",
    '/app/postcss.config.js': 'export default {};',
  };

  const fullConfig = config({
    envDir: '/app',
    envPrefix: 'VITE_',
    env: { MODE: 'development', VITE_API: 'x' },
    resolve: { alias: [{ find: '@', replacement: './src' }] },
    plugins: [{ name: 'vite:resolve' }, { name: 'vite:react-babel' }],
  });

  it('assembles every documented field', () => {
    const m = buildAppManifest(fullConfig, {
      generatorName: '@validity.ai/verify-plugin-vite',
      generatorVersion: '9.9.9',
      fs: fakeFs(files),
    });
    expect(m).toEqual({
      schemaVersion: 1,
      generator: { name: '@validity.ai/verify-plugin-vite', version: '9.9.9' },
      framework: 'vite',
      root: '/app',
      entry: { html: 'index.html', module: 'src/main.tsx' },
      env: { dir: '/app', prefixes: ['VITE_'], exposedKeyCount: 1 },
      css: {
        tailwind: { detected: false, via: null, major: null },
        postcssPlugins: [],
        postcssConfigPath: '/app/postcss.config.js',
        entryCss: ['src/index.css'],
      },
      aliases: [{ find: '@', replacement: '/app/src' }],
      aliasesOmitted: [],
      // Both fixture plugins are Vite internals, so the user-plugin list is
      // legitimately empty — see userPluginNames for why that filter exists.
      plugins: [],
    });
  });

  it('finds the PostCSS config by probing when Vite leaves discovery to postcss', () => {
    const m = buildAppManifest(config(), {
      generatorName: 'g',
      generatorVersion: '1',
      fs: fakeFs({ '/app/.postcssrc.json': '{}' }),
    });
    expect(m.css.postcssConfigPath).toBe('/app/.postcssrc.json');
  });

  it('reads an inline PostCSS plugin list, including v3 Tailwind', () => {
    const m = buildAppManifest(
      config({
        css: {
          postcss: {
            plugins: [{ postcssPlugin: 'tailwindcss' }, { postcssPlugin: 'autoprefixer' }],
          },
        },
      }),
      { generatorName: 'g', generatorVersion: '1', fs: fakeFs({}) },
    );
    expect(m.css.postcssPlugins).toEqual(['tailwindcss', 'autoprefixer']);
    expect(m.css.tailwind).toEqual({ detected: true, via: 'postcss', major: 3 });
  });

  it('carries the tanstack-start label all the way into the assembled manifest', () => {
    const m = buildAppManifest(
      config({
        plugins: [
          { name: 'vite:resolve' },
          { name: 'tanstack-start-core:config' },
          { name: 'tanstack-react-start:config' },
        ],
      }),
      { generatorName: 'g', generatorVersion: '1', fs: fakeFs(files) },
    );
    expect(m.framework).toBe('tanstack-start');
    // The label is derived from the SAME filtered list the manifest records,
    // so the evidence is auditable from the file itself.
    expect(m.plugins).toEqual(['tanstack-start-core:config', 'tanstack-react-start:config']);
  });

  it('serializes deterministically — same config in, byte-identical JSON out', () => {
    const opts = {
      generatorName: '@validity.ai/verify-plugin-vite',
      generatorVersion: '9.9.9',
      fs: fakeFs(files),
    };
    const a = serializeAppManifest(buildAppManifest(fullConfig, opts));
    const b = serializeAppManifest(buildAppManifest(fullConfig, opts));
    expect(a).toBe(b);
    // Key order is the schema's declaration order, not alphabetical: a reader
    // diffing two manifests should see semantic changes, never reshuffles.
    expect(Object.keys(JSON.parse(a))).toEqual([
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
    expect(a.endsWith('\n')).toBe(true);
  });
});
