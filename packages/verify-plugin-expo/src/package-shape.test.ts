import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Expo's plugin resolution imposes three packaging constraints that are easy to
 * "clean up" into a broken package. They are asserted here so the cleanup shows
 * up as a red test instead of as `PluginError: Failed to resolve plugin` in a
 * user's `expo prebuild`.
 */
function pkgUrl(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}

interface Manifest {
  name: string;
  main: string;
  type?: string;
  exports?: unknown;
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(pkgUrl('package.json'), 'utf-8')) as Manifest;

describe('package shape (Expo plugin resolution)', () => {
  it('ships app.plugin.js at the package root', () => {
    // `resolvePluginForModule` looks for `<package>/app.plugin.js` BEFORE
    // falling back to `main` — this is what makes the string form
    // `"plugins": ["@validity.ai/verify-plugin-expo"]` resolve at all.
    expect(existsSync(pkgUrl('app.plugin.js'))).toBe(true);
    expect(manifest.files).toContain('app.plugin.js');
  });

  it('is CommonJS', () => {
    // Expo requires config plugins from a synchronous getConfig(); a
    // "type": "module" package would depend on the host Node's require(ESM).
    expect(manifest.type).toBeUndefined();
  });

  it('declares no exports map', () => {
    // An exports map would have to explicitly allow the ./app.plugin.js
    // subpath that Expo resolves. Omitting it keeps classic resolution.
    expect(manifest.exports).toBeUndefined();
  });

  it('app.plugin.js points at the built CJS entry', () => {
    const source = readFileSync(pkgUrl('app.plugin.js'), 'utf-8');
    expect(source).toContain("require('./dist/index.js')");
    expect(manifest.main).toBe('./dist/index.js');
  });

  it('carries the JS-only mocking deps and nothing native', () => {
    // Installing the plugin should satisfy Validity's "Mocking dev deps"
    // readiness step. @react-native-async-storage/async-storage is
    // deliberately NOT here: it ships native code, and a config plugin must
    // not silently add a module to the user's binary via autolinking.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      'fast-text-encoding',
      'msw',
      'react-native-url-polyfill',
    ]);
  });

  it('declares no dependency on the Expo toolchain, not even a peer', () => {
    // The plugin is a pure (config) => config transform — it imports nothing
    // from @expo/config-plugins, so peering on it would be a constraint the
    // code does not have. It is also not free: pnpm auto-installs peers, so a
    // declared `expo` peer pulls expo + react-native + the whole
    // @react-native/babel-preset tree into this monorepo's lockfile.
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.dependencies).not.toHaveProperty('@expo/config-plugins');
    expect(manifest.dependencies).not.toHaveProperty('expo');
  });

  it('has no @validity/* runtime dependency', () => {
    // Publishing this to npm must not drag @validity.ai/verify-spec with it, and the v1
    // `file:` extraction into .validity/plugins/ has no workspace to link to.
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      expect(dep.startsWith('@validity/')).toBe(false);
    }
  });
});
