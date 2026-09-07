import { describe, expect, it } from 'vitest';
import type { AppManifest, AppManifestReadResult } from '@validity.ai/verify-spec';
import type { UserConfig } from 'vite';
import { buildAppManifestOverrides, claimedAliasFinds } from './app-manifest-merge.js';

function manifest(overrides: Partial<AppManifest> = {}): AppManifest {
  return {
    schemaVersion: 1,
    generator: { name: '@validity.ai/verify-plugin-vite', version: '0.0.1' },
    framework: 'vite',
    root: '/app',
    entry: { html: 'index.html', module: 'src/main.tsx' },
    env: { dir: '/app', prefixes: ['VITE_'], exposedKeyCount: 3 },
    css: {
      tailwind: { detected: false, via: null, major: null },
      postcssPlugins: [],
      postcssConfigPath: null,
      entryCss: [],
    },
    aliases: [],
    aliasesOmitted: [],
    plugins: [],
    ...overrides,
  };
}

function ok(m: AppManifest): AppManifestReadResult {
  return { ok: true, manifest: m, path: '/app/.validity/app-manifest.json' };
}

const SANDBOX_ALIAS = [
  { find: '@mswjs/interceptors', replacement: '/v/msw/lib/browser/index.mjs' },
  { find: 'react-dom', replacement: '/app/node_modules/react-dom' },
  { find: 'react', replacement: '/app/node_modules/react' },
];

function build(args: {
  read: AppManifestReadResult;
  userConfig?: UserConfig;
  useAppManifest?: boolean;
}) {
  return buildAppManifestOverrides({
    projectRoot: '/app',
    useAppManifest: args.useAppManifest,
    userConfig: args.userConfig ?? {},
    sandboxAlias: SANDBOX_ALIAS,
    read: args.read,
  });
}

describe('env mirroring — the hole the manifest actually plugs', () => {
  it('supplies envDir so import.meta.env.VITE_* is not empty in the sandbox', () => {
    const out = build({
      read: ok(manifest({ env: { dir: '/app', prefixes: ['VITE_'], exposedKeyCount: 3 } })),
    });
    expect(out.envDir).toBe('/app');
    expect(out.applied).toBe(true);
    expect(out.provenance).toContain('mirrored: envDir (3 client vars)');
  });

  it('mirrors a non-default env prefix but leaves the default implicit', () => {
    const withDefault = build({ read: ok(manifest()) });
    expect(withDefault.envPrefix).toBeUndefined();

    const withCustom = build({
      read: ok(
        manifest({ env: { dir: '/app', prefixes: ['APP_', 'PUBLIC_'], exposedKeyCount: 1 } }),
      ),
    });
    expect(withCustom.envPrefix).toEqual(['APP_', 'PUBLIC_']);
    expect(withCustom.provenance).toContain('envPrefix (APP_, PUBLIC_)');
  });
});

describe('postcss mirroring', () => {
  it("adopts the app's postcss config — the Tailwind v3 case the shim does not cover", () => {
    const out = build({
      read: ok(
        manifest({
          css: {
            tailwind: { detected: true, via: 'postcss', major: 3 },
            postcssPlugins: ['tailwindcss', 'autoprefixer'],
            postcssConfigPath: '/app/postcss.config.js',
            entryCss: ['src/index.css'],
          },
        }),
      ),
    });
    expect(out.postcssConfigPath).toBe('/app/postcss.config.js');
    expect(out.provenance).toContain('postcss config');
    // Tailwind is RECORDED, never claimed as mirrored — the sandbox did not
    // render with Tailwind, it merely pointed PostCSS at the user's config.
    expect(out.provenance).toContain('recorded: tailwind v3 via postcss');
  });

  it("defers to the user's own vite.config css.postcss", () => {
    const out = build({
      read: ok(
        manifest({ css: { ...manifest().css, postcssConfigPath: '/app/postcss.config.js' } }),
      ),
      userConfig: { css: { postcss: { plugins: [] } } },
    });
    expect(out.postcssConfigPath).toBeUndefined();
    expect(out.provenance).not.toContain('postcss config');
  });
});

describe('alias merge precedence', () => {
  it('gap-fills only: a sandbox-owned find is never displaced', () => {
    const out = build({
      read: ok(
        manifest({
          aliases: [
            { find: 'react', replacement: '/somewhere/else/react' },
            { find: '@gen', replacement: '/app/src/generated' },
          ],
        }),
      ),
    });
    expect(out.alias).toEqual([{ find: '@gen', replacement: '/app/src/generated' }]);
  });

  it("a user's own vite.config alias wins over the manifest (both alias shapes)", () => {
    const objectForm = build({
      read: ok(manifest({ aliases: [{ find: '@', replacement: '/stale/src' }] })),
      userConfig: { resolve: { alias: { '@': '/app/src' } } },
    });
    expect(objectForm.alias).toEqual([]);

    const arrayForm = build({
      read: ok(manifest({ aliases: [{ find: '@', replacement: '/stale/src' }] })),
      userConfig: { resolve: { alias: [{ find: '@', replacement: '/app/src' }] } },
    });
    expect(arrayForm.alias).toEqual([]);
  });

  it('contributes aliases a static config read could never see', () => {
    const out = build({
      read: ok(
        manifest({
          // A framework preset injected these from inside a plugin, so
          // loadUserViteConfig never saw them.
          aliases: [
            { find: '@preset/env', replacement: '/app/.cache/env.ts' },
            { find: '@preset/routes', replacement: '/app/.cache/routes.ts' },
          ],
        }),
      ),
    });
    expect(out.alias.map((a) => a.find)).toEqual(['@preset/env', '@preset/routes']);
    expect(out.provenance).toContain('aliases (2)');
  });

  it('deduplicates repeated finds inside the manifest itself', () => {
    const out = build({
      read: ok(
        manifest({
          aliases: [
            { find: '@dup', replacement: '/first' },
            { find: '@dup', replacement: '/second' },
          ],
        }),
      ),
    });
    expect(out.alias).toEqual([{ find: '@dup', replacement: '/first' }]);
  });
});

describe('opt-out and absence', () => {
  it('produces nothing when web.useAppManifest is false', () => {
    const out = build({ read: ok(manifest()), useAppManifest: false });
    expect(out).toEqual({
      alias: [],
      applied: false,
      provenance: 'app manifest ignored (web.useAppManifest: false)',
    });
  });

  it('names the rejection reason instead of failing silently', () => {
    for (const reason of ['absent', 'unsupported-version', 'malformed-json'] as const) {
      const out = build({ read: { ok: false, reason, path: '/app/.validity/app-manifest.json' } });
      expect(out.applied).toBe(false);
      expect(out.envDir).toBeUndefined();
      expect(out.provenance).toBe(`app manifest ${reason}`);
    }
  });
});

describe('claimedAliasFinds', () => {
  it('ignores RegExp finds rather than guessing at overlap', () => {
    const claimed = claimedAliasFinds(
      [
        { find: /^~/, replacement: '/app/src' },
        { find: 'react', replacement: '/r' },
      ],
      {},
    );
    expect([...claimed]).toEqual(['react']);
  });
});
