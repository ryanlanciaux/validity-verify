import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import {
  COMPANION_BUILD_REVISION,
  COMPANION_METRO_PORT,
  EXPO_ROUTER_STORE_SPECIFIER,
  METRO_SERVE_ENV,
  companionBuildIdentity,
  defaultCompanionScheme,
  describeBuildInputDiff,
  isAppInstalledCommand,
  isCompanionAppInstalled,
  isCompanionBuildFresh,
  isCompanionMetroUp,
  metroServeSpawnEnv,
  prepareNativeApp,
  readBuildMarker,
  readHostAliases,
  startMetroStep,
  writeBuildMarker,
  type CompanionBuildInputs,
} from './prepare-native-app.js';

const dirs: string[] = [];
function project(files: Record<string, string>, pkg: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-native-app-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const BUTTON = `export default function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}`;

describe('companionBuildIdentity', () => {
  it('computes the SAME scheme/buildHash/buildInputs as prepareNativeApp without writing any files', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const appDir = join(root, '.validity', 'native-app');

    // The cheap probe runs FIRST and must touch nothing on disk.
    const identity = companionBuildIdentity({ projectRoot: root, config: {} });
    expect(existsSync(appDir)).toBe(false);
    expect(identity.scheme).toBe('validity-ai-validity-playground');
    expect(identity.bundleId).toBe('ai.validity.playground');
    expect(identity.appDir).toBe(appDir);
    expect(identity.buildMarkerPath).toBe(join(appDir, '.validity-build.ios'));

    // The full regeneration must agree byte-for-byte on the binary identity —
    // single-sourcing is the whole point (the readiness gate and the rebuild
    // gate can never disagree on buildHash).
    const full = prepareNativeApp({ projectRoot: root, config: {} });
    expect(identity.buildHash).toBe(full.buildHash);
    expect(identity.scheme).toBe(full.scheme);
    expect(identity.buildInputs).toEqual(full.buildInputs);
    expect(identity.buildMarkerPath).toBe(full.buildMarkerPath);
    expect(identity.metroContentMarkerPath).toBe(full.metroContentMarkerPath);
  });

  it('requires independent iOS and Android build receipts and ignores an unscoped legacy receipt', () => {
    const root = project({}, { dependencies: { expo: '51' } });
    const ios = prepareNativeApp({ projectRoot: root, platform: 'ios' });
    const android = prepareNativeApp({ projectRoot: root, platform: 'android' });
    expect(ios.buildMarkerPath).not.toBe(android.buildMarkerPath);
    writeBuildMarker(join(ios.appDir, '.validity-build'), ios.buildHash);
    expect(isCompanionBuildFresh(ios.buildMarkerPath, ios.buildHash)).toBe(false);
    expect(isCompanionBuildFresh(android.buildMarkerPath, android.buildHash)).toBe(false);
    writeBuildMarker(ios.buildMarkerPath, ios.buildHash);
    expect(isCompanionBuildFresh(ios.buildMarkerPath, ios.buildHash)).toBe(true);
    expect(isCompanionBuildFresh(android.buildMarkerPath, android.buildHash)).toBe(false);
    writeBuildMarker(android.buildMarkerPath, android.buildHash);
    expect(isCompanionBuildFresh(ios.buildMarkerPath, ios.buildHash)).toBe(true);
    expect(isCompanionBuildFresh(android.buildMarkerPath, android.buildHash)).toBe(true);
    expect(
      companionBuildIdentity({ projectRoot: root, config: { native: { target: 'android' } } })
        .buildMarkerPath,
    ).toBe(android.buildMarkerPath);
    expect(
      companionBuildIdentity({
        projectRoot: root,
        config: { native: { target: 'android' } },
        platform: 'ios',
      }).buildMarkerPath,
    ).toBe(ios.buildMarkerPath);
  });

  it('honors a configured native.scheme in the cheap identity, flipping buildHash like the full prepare', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const derived = companionBuildIdentity({ projectRoot: root, config: {} });
    const overridden = companionBuildIdentity({
      projectRoot: root,
      config: { native: { scheme: 'myapp' } },
    });
    expect(overridden.scheme).toBe('myapp');
    expect(overridden.buildInputs.scheme).toBe('myapp');
    expect(overridden.buildHash).not.toBe(derived.buildHash);
    // Still no file regeneration from either probe.
    expect(existsSync(join(root, '.validity', 'native-app'))).toBe(false);
  });
});

describe('prepareNativeApp', () => {
  it('generates an app.config.js that inherits the host config + overrides identity', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNativeApp({ projectRoot: root, config: {} });

    const appConfig = readFileSync(join(result.appDir, 'app.config.js'), 'utf-8');
    // Inherits the host's Expo config (plugins/newArch/jsEngine carry over)…
    expect(appConfig).toContain('loadHostExpoConfig');
    expect(appConfig).toContain('...host');
    // …and overrides identity so it installs side-by-side. The DEFAULT scheme
    // is companion-unique (validity-<bundleId-slug>) — never the shared
    // 'validity' or the host's own scheme, which two installed apps could both
    // register (deep links then nondeterministically open the wrong app).
    expect(appConfig).toContain('name: "Validity"');
    expect(appConfig).toContain('scheme: "validity-ai-validity-playground"');
    expect(result.scheme).toBe('validity-ai-validity-playground');
    expect(appConfig).toContain('"ai.validity.playground"');
    // No app.json (so we don't fight a host that also ships app.json).
    expect(existsSync(join(result.appDir, 'app.json'))).toBe(false);
    expect(existsSync(join(result.appDir, 'metro.config.js'))).toBe(true);
    expect(existsSync(join(result.appDir, 'babel.config.js'))).toBe(true);
    expect(JSON.parse(readFileSync(join(result.appDir, 'package.json'), 'utf-8')).main).toBe(
      'native-entry.tsx',
    );
  });

  it('strips exactly expo-splash-screen from inherited plugins and nulls every splash config', () => {
    // The companion is built WITHOUT a splash screen so the bridge's in-place
    // reload can never strand behind a re-presented launch screen (the bug the
    // old terminate+cold-launch ladder worked around). Both plugin entry
    // shapes (string and [name, options]) must be stripped — and ONLY
    // expo-splash-screen; every other inherited plugin must survive.
    const root = project(
      {
        'src/Button.tsx': BUTTON,
        'app.json': JSON.stringify({
          expo: {
            name: 'Host',
            plugins: [
              'expo-font',
              ['expo-splash-screen', { backgroundColor: '#ffffff' }],
              'expo-splash-screen',
              ['expo-camera', { cameraPermission: 'x' }],
            ],
            splash: { image: './assets/splash.png' },
            ios: { splash: { image: './assets/splash.png' } },
            android: { splash: { image: './assets/splash.png' } },
          },
        }),
      },
      { dependencies: { expo: '51', 'expo-splash-screen': '0.27.0' } },
    );
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    // EVALUATE the generated config the way Expo would (it's plain CommonJS;
    // @expo/config is unresolvable from the temp dir, so the app.json
    // fallback path loads the host config above).
    const requireCjs = createRequire(import.meta.url);
    const cfg = requireCjs(join(result.appDir, 'app.config.js'))() as {
      plugins: unknown[];
      splash?: unknown;
      ios: { bundleIdentifier?: string; splash?: unknown };
      android: { package?: string; splash?: unknown };
    };
    const pluginNames = cfg.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect(pluginNames).toEqual(['expo-font', 'expo-camera']);
    expect(cfg.splash).toBeUndefined();
    expect(cfg.ios.splash).toBeUndefined();
    expect(cfg.android.splash).toBeUndefined();
    // Identity overrides still applied alongside the splash strip.
    expect(cfg.ios.bundleIdentifier).toBe('ai.validity.playground');
    expect(cfg.android.package).toBe('ai.validity.playground');
  });

  it('drops host branding paths without copying assets or losing native settings', () => {
    const host = {
      icon: './assets/icon.png',
      ios: { icon: { dark: './assets/app-icon-ios.png' }, supportsTablet: true },
      android: {
        icon: './assets/android.png',
        adaptiveIcon: { foregroundImage: './assets/foreground.png' },
        permissions: ['CAMERA'],
      },
    };
    const root = project(
      { 'app.json': JSON.stringify({ expo: host }) },
      { dependencies: { expo: '51' } },
    );
    const app = prepareNativeApp({ projectRoot: root });
    const cfg = createRequire(import.meta.url)(join(app.appDir, 'app.config.js'))();
    expect(cfg.icon).toBeUndefined();
    expect(cfg.ios.icon).toBeUndefined();
    expect(cfg.android.icon).toBeUndefined();
    expect(cfg.android.adaptiveIcon).toBeUndefined();
    expect(cfg.ios.supportsTablet).toBe(true);
    expect(cfg.android.permissions).toEqual(['CAMERA']);
    expect(existsSync(join(app.appDir, 'assets'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'app.json'), 'utf-8')).expo).toEqual(host);
  });

  it('a host with NO plugins/splash still gets a valid splashless config (empty plugins)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    const requireCjs = createRequire(import.meta.url);
    const cfg = requireCjs(join(result.appDir, 'app.config.js'))() as {
      plugins: unknown[];
      splash?: unknown;
    };
    expect(cfg.plugins).toEqual([]);
    expect(cfg.splash).toBeUndefined();
  });

  it('bakes the PREPARED contentHash into validity-content-hash.ts — the stale-guard comparison value', () => {
    // The companion's bridge hello echoes VALIDITY_CONTENT_HASH, and the host's
    // stale-bundle guard (bridgeReportsStaleBundle) compares it against
    // `expectedContentHash`. The value baked is prepareNative's OWN hash —
    // app.contentHash re-hashes prepared + the app-shell bodies and is a
    // DIFFERENT string, so a caller passing app.contentHash would read every
    // fresh bundle as stale and terminate every warm session. This pins both
    // halves of that contract: callers must pass `prepared.contentHash`.
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNativeApp({ projectRoot: root, config: {} });

    const baked = readFileSync(join(result.appDir, 'validity-content-hash.ts'), 'utf-8');
    expect(baked).toContain(
      `export const VALIDITY_CONTENT_HASH = ${JSON.stringify(result.prepared.contentHash)}`,
    );
    // The combined hash is NOT what the device reports — guard against the
    // plausible-looking misuse of comparing the hello against app.contentHash.
    expect(result.contentHash).not.toBe(result.prepared.contentHash);
    expect(baked).not.toContain(result.contentHash);
  });

  it('metro.config pins react-native-gesture-handler/reanimated as singletons ONLY when the host has them', () => {
    const withGh = project(
      { 'src/A.tsx': BUTTON },
      {
        dependencies: {
          expo: '51',
          'react-native': '0.81',
          'react-native-gesture-handler': '2',
          'react-native-reanimated': '3',
        },
      },
    );
    const ghMetro = readFileSync(
      join(prepareNativeApp({ projectRoot: withGh, config: {} }).appDir, 'metro.config.js'),
      'utf-8',
    );
    // A second copy of RNGH double-registers its native views and leaves
    // GestureHandlerRootView undefined — pinning to the host's one copy fixes it.
    expect(ghMetro).toMatch(/const SINGLETONS = \[[^\]]*"react-native-gesture-handler"/);
    expect(ghMetro).toContain('"react-native-reanimated"');

    const noGh = project(
      { 'src/A.tsx': BUTTON },
      { dependencies: { expo: '51', 'react-native': '0.81' } },
    );
    const noGhMetro = readFileSync(
      join(prepareNativeApp({ projectRoot: noGh, config: {} }).appDir, 'metro.config.js'),
      'utf-8',
    );
    // Must NOT pin a package the host lacks (would remap to a missing path). Check
    // the SINGLETONS array specifically — the explanatory comment names the lib.
    const singletonsLine =
      noGhMetro.split('\n').find((l) => l.includes('const SINGLETONS =')) ?? '';
    expect(singletonsLine).not.toContain('react-native-gesture-handler');
    expect(singletonsLine).not.toContain('react-native-reanimated');
  });

  it('metro.config redirects the expo-router store to the isolation mock — only for expo-router apps', () => {
    const expo = project(
      { 'app/index.tsx': BUTTON },
      { dependencies: { expo: '51', 'expo-router': '4.0.0', 'react-native': '0.81' } },
    );
    const expoApp = prepareNativeApp({ projectRoot: expo, config: {} });
    const expoMetro = readFileSync(join(expoApp.appDir, 'metro.config.js'), 'utf-8');
    expect(expoMetro).toContain('validity-expo-router-store-mock.js');
    expect(expoMetro).toContain('expo-router/build/global-state/router-store.js');

    // A react-navigation (non-expo-router) app must NOT carry the redirect.
    const rn = project(
      { 'src/A.tsx': BUTTON },
      { dependencies: { 'react-native': '0.81', '@react-navigation/native': '7.0.0' } },
    );
    const rnApp = prepareNativeApp({ projectRoot: rn, config: {} });
    const rnMetro = readFileSync(join(rnApp.appDir, 'metro.config.js'), 'utf-8');
    expect(rnMetro).not.toContain('validity-expo-router-store-mock.js');
  });

  it('metro.config pins @react-navigation/native + /core as singletons when a router is detected (so the nav mock and the user screen share ONE NavigationContext → setOptions resolves)', () => {
    // Two copies of @react-navigation/* mean two NavigationContext objects: the
    // generated nav mock provides one, the user's screen/wrapper reads the other
    // (which lacks setOptions) → "navigation.setOptions is not a function". Pin
    // both to the host's one copy. The context object lives in /core, re-exported
    // by /native, so BOTH must be pinned.
    const withNav = project(
      {
        'src/A.tsx': BUTTON,
        // Physical packages so the existsSync guard (don't remap a missing path) passes.
        'node_modules/@react-navigation/native/package.json': '{"name":"@react-navigation/native"}',
        'node_modules/@react-navigation/core/package.json': '{"name":"@react-navigation/core"}',
      },
      { dependencies: { 'react-native': '0.81', '@react-navigation/native': '7.0.0' } },
    );
    const navMetro = readFileSync(
      join(prepareNativeApp({ projectRoot: withNav, config: {} }).appDir, 'metro.config.js'),
      'utf-8',
    );
    const navSingletons = navMetro.split('\n').find((l) => l.includes('const SINGLETONS =')) ?? '';
    expect(navSingletons).toContain('@react-navigation/native');
    expect(navSingletons).toContain('@react-navigation/core');

    // No router → must NOT pin @react-navigation (would remap a missing path).
    const noNav = project(
      { 'src/A.tsx': BUTTON },
      { dependencies: { expo: '51', 'react-native': '0.81' } },
    );
    const noNavSingletons =
      readFileSync(
        join(prepareNativeApp({ projectRoot: noNav, config: {} }).appDir, 'metro.config.js'),
        'utf-8',
      )
        .split('\n')
        .find((l) => l.includes('const SINGLETONS =')) ?? '';
    expect(noNavSingletons).not.toContain('@react-navigation');
  });

  it('resolves the host config via @expo/config first (so app.config.ts + plugins are honored)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    const appConfig = readFileSync(join(result.appDir, 'app.config.js'), 'utf-8');
    // Primary path: Expo's own resolver (handles app.config.ts + static/dynamic merge).
    expect(appConfig).toContain("require('@expo/config')");
    expect(appConfig).toContain('getConfig');
    expect(appConfig).toContain('skipSDKVersionRequirement');
    // Wrapped in a try so a missing @expo/config degrades to the manual fallback.
    expect(appConfig).toMatch(/try\s*\{[\s\S]*getConfig/);
  });

  it('fallback LAYERS app.config.js on top of app.json (merges, never early-returns)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const appConfig = readFileSync(
      join(prepareNativeApp({ projectRoot: root, config: {} }).appDir, 'app.config.js'),
      'utf-8',
    );
    // The fallback merges (so a dynamic config adding plugins/newArch on top of a
    // static app.json isn't dropped) instead of returning on the first hit.
    expect(appConfig).toContain('host = { ...host, ...cfgExp }');
    // It must NOT early-return the raw app.json before the config-file loop.
    expect(appConfig).not.toMatch(/return \(j && j\.expo\) \|\| j \|\| \{\};/);
  });

  it('honors a configured native.scheme', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNativeApp({ projectRoot: root, config: { native: { scheme: 'myapp' } } });
    expect(readFileSync(join(result.appDir, 'app.config.js'), 'utf-8')).toContain(
      'scheme: "myapp"',
    );
    expect(result.scheme).toBe('myapp');
  });

  it('NEVER inherits the host app.json scheme as the default — the derived scheme is companion-unique', () => {
    // The documented collision: the host's dev build is usually a dev-client
    // that owns its own scheme; if the companion also registered it, every
    // deep link would nondeterministically open the user's app instead of the
    // companion (and 'succeed' with exit 0). With no explicit override, the
    // companion must derive its own scheme regardless of the host config.
    const root = project(
      {
        'src/Button.tsx': BUTTON,
        'app.json': JSON.stringify({ expo: { name: 'Host', scheme: 'hostapp' } }),
      },
      { dependencies: { expo: '51' } },
    );
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    expect(result.scheme).toBe('validity-ai-validity-playground');
    expect(result.scheme).not.toBe('hostapp');
    // app.config.js inherits the host config (...host) THEN overrides scheme.
    expect(readFileSync(join(result.appDir, 'app.config.js'), 'utf-8')).toContain(
      'scheme: "validity-ai-validity-playground"',
    );
  });

  it('derives the unique scheme from the companion bundle id (defaultCompanionScheme)', () => {
    expect(defaultCompanionScheme('ai.validity.playground')).toBe(
      'validity-ai-validity-playground',
    );
    expect(defaultCompanionScheme('Com.Example.My_App2')).toBe('validity-com-example-my-app2');
    expect(defaultCompanionScheme('...')).toBe('validity-playground'); // degenerate input never yields a bare prefix
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNativeApp({ projectRoot: root, config: {}, bundleId: 'com.acme.qa' });
    expect(result.scheme).toBe('validity-com-acme-qa');
  });

  it('a scheme change flips buildHash and is persisted in buildInputs (the binary registers the scheme)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const derived = prepareNativeApp({ projectRoot: root, config: {} });
    const overridden = prepareNativeApp({
      projectRoot: root,
      config: { native: { scheme: 'myapp' } },
    });
    // The installed binary answers the scheme it was COMPILED with — an edited
    // override must prompt a rebuild or every deep link silently misses.
    expect(overridden.buildHash).not.toBe(derived.buildHash);
    expect(derived.buildInputs.scheme).toBe('validity-ai-validity-playground');
    expect(overridden.buildInputs.scheme).toBe('myapp');
  });

  it('reuses the host babel config when present (so reanimated/module-resolver plugins match)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    writeFileSync(join(root, 'babel.config.js'), 'module.exports = {};');
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    expect(readFileSync(join(result.appDir, 'babel.config.js'), 'utf-8')).toContain(
      'require("../../babel.config.js")',
    );
  });

  it('shares the user node_modules and forces single react/react-native in metro config', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    const metro = readFileSync(join(result.appDir, 'metro.config.js'), 'utf-8');
    expect(metro).toContain('watchFolders');
    expect(metro).toContain("path.resolve(appRoot, '..', '..')"); // reaches the user root
    expect(metro).toContain('react-native');
    expect(metro).toContain('SINGLETONS');
  });

  it('uses Metro’s node watcher even when the host enables Watchman, keeping source watching', () => {
    const root = project(
      {
        'node_modules/expo/metro-config.js':
          'exports.getDefaultConfig = () => ({ resolver: {}, transformer: {} });',
        'metro.config.js': 'module.exports = { resolver: { useWatchman: true } };',
      },
      { dependencies: { expo: '51' } },
    );
    const app = prepareNativeApp({ projectRoot: root });
    const metro = createRequire(import.meta.url)(join(app.appDir, 'metro.config.js'));
    expect(metro.resolver.useWatchman).toBe(false);
    expect(metro.watchFolders).toEqual([realpathSync(root)]);
  });

  it('keeps Validity capture artifacts (shots/, log) OUT of the Metro watcher via blockList', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    const metro = readFileSync(join(result.appDir, 'metro.config.js'), 'utf-8');
    // The user root is still fully watched (component-edit HMR is untouched)…
    expect(metro).toContain('config.watchFolders = [userRoot];');
    // …but the screenshot dir + Metro log — which live UNDER appDir, inside the
    // watched userRoot, and used to churn the watcher on every capture/append —
    // are excluded from the crawl/watch via blockList.
    expect(metro).toContain('config.resolver.blockList');
    expect(metro).toContain('validityArtifactRe');
    // Behavioral: eval the GENERATED escaper + regex (no re-typing the escaping)
    // and prove it matches the artifacts under THIS appRoot and nothing else.
    const block = metro.match(
      /const validityEscapeRe = [\s\S]*?const validityArtifactRe = new RegExp\([\s\S]*?\);/,
    );
    expect(block).not.toBeNull();
    const re = new Function('appRoot', `${block![0]} return validityArtifactRe;`)(
      result.appDir,
    ) as RegExp;
    expect(re.test(`${result.appDir}/shots/Button.png`)).toBe(true);
    expect(re.test(`${result.appDir}/validity-native.log`)).toBe(true);
    expect(re.test(`${result.appDir}/src/Button.tsx`)).toBe(false);
    // A sibling whose name merely starts with "shots" must NOT be excluded.
    expect(re.test(`${result.appDir}/shotsX/y.png`)).toBe(false);
  });

  it('replicates the host metro.config resolver settings (axios/apisauce FormData fix)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    const metro = readFileSync(join(result.appDir, 'metro.config.js'), 'utf-8');
    // It must read the host config and carry over the resolution-affecting knobs
    // (conditionNames etc.) — without these, axios resolves to its FormData-at-
    // module-scope browser build and the companion redboxes on load.
    expect(metro).toContain('metro.config.js');
    expect(metro).toContain('unstable_conditionNames');
    expect(metro).toContain('resolverMainFields');
    expect(metro).toContain('getTransformOptions');
  });

  it("reuses prepareNative so the registry imports the user's components", () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    expect(result.prepared.registeredComponents).toContain('src/Button.tsx');
    const registry = readFileSync(result.prepared.registryPath, 'utf-8');
    // appDir is <root>/.validity/native-app → the import climbs back to ../../src
    // (namespace import + pick() so named exports resolve).
    expect(registry).toMatch(/import \* as M0 from "\.\.\/\.\.\/src\/Button"/);
  });

  it('mirrors the host dependencies into the companion package.json (so native modules autolink)', () => {
    const root = project(
      { 'src/Button.tsx': BUTTON },
      { dependencies: { expo: '51', 'react-native-gesture-handler': '2', 'react-native': '0.74' } },
    );
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    const pkg = JSON.parse(readFileSync(join(result.appDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toMatchObject({
      expo: '51',
      'react-native-gesture-handler': '2',
      'react-native': '0.74',
    });
    expect(result.mirroredDepCount).toBe(3);
  });

  it('emits an ordered, terminating iOS build sequence (install → prebuild --clean → pods → run --no-bundler)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const steps = prepareNativeApp({ projectRoot: root, config: {} }).buildSteps('ios');
    const labels = steps.map((s) => s.label);
    expect(labels).toEqual(['npm install', 'expo prebuild --clean', 'pod install', 'expo run:ios']);
    // prebuild is clean + non-interactive
    const prebuild = steps.find((s) => s.label === 'expo prebuild --clean')!;
    expect(prebuild.args).toContain('--clean');
    expect(prebuild.env).toMatchObject({ CI: '1' });
    const run = steps.find((s) => s.label === 'expo run:ios')!;
    // Expo rejects --port with --no-bundler; Metro is started separately.
    expect(run.args).not.toContain('--port');
    expect(run.env).toMatchObject({
      EXPO_OFFLINE: '1',
      EXPO_PACKAGER_PROXY_URL: 'http://localhost:8082',
    });
    expect(run.args).toContain('--no-bundler');
    // Build/install must terminate before the CLI records a receipt. Metro
    // starts separately, so an existing app/server cannot short-circuit a build.
    expect(steps.some((s) => s.longRunning)).toBe(false);
  });

  it('uses an INCREMENTAL prebuild (no --clean) when the native project already exists', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const app = prepareNativeApp({ projectRoot: root, config: {} });
    // Simulate a prior build leaving the native project in place.
    mkdirSync(join(app.appDir, 'ios'), { recursive: true });
    const steps = app.buildSteps('ios');
    const prebuild = steps.find((s) => s.label.startsWith('expo prebuild'))!;
    expect(prebuild.label).toBe('expo prebuild');
    expect(prebuild.args).not.toContain('--clean');
    // Still non-interactive + pods + run, just without the from-scratch wipe.
    expect(steps.map((s) => s.label)).toEqual([
      'npm install',
      'expo prebuild',
      'pod install',
      'expo run:ios',
    ]);
  });

  it('honors an explicit nativeProjectExists override (clean on first build)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const app = prepareNativeApp({ projectRoot: root, config: {} });
    mkdirSync(join(app.appDir, 'android'), { recursive: true });
    // Even though android/ exists on disk, an explicit false forces --clean.
    const clean = app.buildSteps('android', { nativeProjectExists: false });
    expect(clean.find((s) => s.label.startsWith('expo prebuild'))!.args).toContain('--clean');
    const incremental = app.buildSteps('android', { nativeProjectExists: true });
    expect(incremental.find((s) => s.label.startsWith('expo prebuild'))!.args).not.toContain(
      '--clean',
    );
  });

  it('startMetroStep brings Metro up on the companion port without rebuilding', () => {
    const step = startMetroStep('/tmp/app');
    expect(step.bin).toBe('npx');
    expect(step.args).toEqual(['expo', 'start', '--port', String(COMPANION_METRO_PORT)]);
    expect(step.longRunning).toBe(true);
    expect(step.cwd).toBe('/tmp/app');
    // Must keep Metro's file watcher ON (Fast Refresh): NOT CI=1, which Expo
    // uses to gate the watcher off ("reloads are disabled"). The detached spawn
    // is non-interactive via no-TTY regardless.
    expect(step.env).toMatchObject({ EXPO_OFFLINE: '1' });
    expect(step.env?.CI).toBeUndefined();
  });

  it('seeds a companion-only pnpm build policy without overwriting user approvals or changing content on rerun', () => {
    const root = project(
      {
        'pnpm-lock.yaml': 'lockfileVersion: 9',
        'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\nallowBuilds:\n  esbuild: false\n",
      },
      { dependencies: { expo: '51' } },
    );
    const app = prepareNativeApp({ projectRoot: root });
    const policyPath = join(app.appDir, 'pnpm-workspace.yaml');
    const policy = readFileSync(policyPath, 'utf-8');
    expect(policy).toContain("packages:\n  - '.'");
    expect(policy).toContain('esbuild: true');
    expect(policy).toContain('msw: false');
    expect(policy).not.toContain('dangerouslyAllowAllBuilds');
    expect(app.buildSteps('ios')[0]).toMatchObject({
      args: ['install', '--no-frozen-lockfile'],
      env: { CI: '1' },
      cwd: app.appDir,
    });
    const rerun = prepareNativeApp({ projectRoot: root });
    expect(rerun.contentHash).toBe(app.contentHash);
    const customized = policy + '  sharp: true\n';
    writeFileSync(policyPath, customized);
    prepareNativeApp({ projectRoot: root });
    expect(readFileSync(policyPath, 'utf-8')).toBe(customized);
    expect(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf-8')).toContain('esbuild: false');
  });

  it('resolves workspace and catalog specs to the host’s installed packages in the isolated pnpm workspace', () => {
    const root = project(
      {
        'pnpm-lock.yaml': 'lockfileVersion: 9',
        'node_modules/shared/package.json': JSON.stringify({ name: 'shared', version: '1.0.0' }),
        'node_modules/catalog-default/package.json': JSON.stringify({
          name: 'catalog-default',
          version: '2.0.0',
        }),
        'node_modules/catalog-alias/package.json': JSON.stringify({
          name: 'actual-package',
          version: '3.0.0',
        }),
      },
      {
        dependencies: {
          shared: 'workspace:*',
          'catalog-default': 'catalog:',
          'catalog-alias': 'catalog:ui',
          expo: '51',
        },
      },
    );
    const app = prepareNativeApp({ projectRoot: root });
    const pkg = JSON.parse(readFileSync(join(app.appDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toEqual({
      shared: 'link:../../node_modules/shared',
      'catalog-default': 'link:../../node_modules/catalog-default',
      'catalog-alias': 'link:../../node_modules/catalog-alias',
      expo: '51',
    });
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).dependencies.shared).toBe(
      'workspace:*',
    );
  });

  it('asks for the host install when a workspace dependency cannot be resolved', () => {
    const root = project(
      { 'pnpm-lock.yaml': 'lockfileVersion: 9' },
      { dependencies: { shared: 'workspace:*' } },
    );
    expect(() => prepareNativeApp({ projectRoot: root })).toThrow('Install the host project');
  });

  it('does not add pnpm configuration to an npm companion', () => {
    const root = project({}, { dependencies: { expo: '51' } });
    const app = prepareNativeApp({ projectRoot: root });
    expect(existsSync(join(app.appDir, 'pnpm-workspace.yaml'))).toBe(false);
  });

  it('omits pod install on android and uses the host package manager (pnpm lockfile)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    const steps = prepareNativeApp({ projectRoot: root, config: {} }).buildSteps('android');
    expect(steps.map((s) => s.label)).toEqual([
      'pnpm install',
      'expo prebuild --clean',
      'expo run:android',
    ]);
  });
});

describe('readHostAliases + metro alias replication', () => {
  it('translates tsconfig paths into companion aliases (relative to the user root)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./app/*'], '@assets/*': ['./assets/*'] },
        },
      }),
    );
    const aliases = readHostAliases(root);
    expect(aliases).toEqual(
      expect.arrayContaining([
        { prefix: '@/', rel: 'app' },
        { prefix: '@assets/', rel: 'assets' },
      ]),
    );
  });

  it('tolerates comments/trailing commas in tsconfig (jsonc)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    writeFileSync(
      join(root, 'tsconfig.json'),
      '{\n  // expo base\n  "compilerOptions": { "paths": { "@/*": ["./*"] }, },\n}',
    );
    expect(readHostAliases(root)).toEqual([{ prefix: '@/', rel: '.' }]);
  });

  it('does not let glob `/*` inside string values (paths + include) eat the JSON', () => {
    // Real-world regression: a regex comment-stripper treats the `/*` in "@/*"
    // as a block-comment START and the `*/` in "**/*.ts" as its END, deleting
    // the whole `paths` block. This is the exact shape of an Ignite/Expo
    // tsconfig and it must still yield the aliases.
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./app/*'], '@assets/*': ['./assets/*'] },
        },
        include: ['**/*.ts', '**/*.tsx'],
        exclude: ['node_modules'],
      }),
    );
    expect(readHostAliases(root)).toEqual(
      expect.arrayContaining([
        { prefix: '@/', rel: 'app' },
        { prefix: '@assets/', rel: 'assets' },
      ]),
    );
  });

  it('bakes the aliases + a resolveRequest into the generated metro config, and drops the catch-all Proxy', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./app/*'] } } }),
    );
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    const metro = readFileSync(join(result.appDir, 'metro.config.js'), 'utf-8');
    expect(metro).toContain('resolveRequest');
    expect(metro).toContain('"prefix":"@/"');
    expect(metro).toContain('Object.fromEntries'); // singletons map, not a Proxy
    expect(metro).not.toContain('new Proxy');
  });

  it('returns no aliases when the host has no tsconfig paths', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    expect(readHostAliases(root)).toEqual([]);
  });
});

/** Fake an INSTALLED package under the project's node_modules (what depShipsNativeCode inspects). */
function installPkg(
  root: string,
  name: string,
  version: string,
  markers: { dirs?: string[]; files?: string[] } = {},
): void {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
  for (const d of markers.dirs ?? []) mkdirSync(join(dir, d), { recursive: true });
  for (const f of markers.files ?? []) writeFileSync(join(dir, f), '// native marker');
}

describe('build freshness marker', () => {
  it('round-trips the marker; a NEW component file does NOT flip buildHash (registry is JS, not binary)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const a = prepareNativeApp({ projectRoot: root, config: {} });
    expect(a.buildHash).toMatch(/^[0-9a-f]{16}$/);

    // Before any build → not fresh.
    expect(isCompanionBuildFresh(a.buildMarkerPath, a.buildHash)).toBe(false);
    // After a build → fresh.
    writeBuildMarker(a.buildMarkerPath, a.buildHash, a.buildInputs);
    expect(isCompanionBuildFresh(a.buildMarkerPath, a.buildHash)).toBe(true);

    // Registering a NEW component used to flip the old structure-based hash
    // and prompt a minutes-long native rebuild. The registry is plain JS —
    // delivered via the contentHash → Metro path — so the binary gate must
    // NOT move (while contentHash DOES, so the new registry gets served).
    const withComponent = project(
      { 'src/Button.tsx': BUTTON, 'src/Card.tsx': BUTTON.replace(/Button/g, 'Card') },
      { dependencies: { expo: '51' } },
    );
    const b = prepareNativeApp({ projectRoot: withComponent, config: {} });
    expect(b.prepared.structureHash).not.toBe(a.prepared.structureHash);
    expect(b.buildHash).toBe(a.buildHash);
    expect(b.contentHash).not.toBe(a.contentHash);
  });

  it('a pure-JS dep (no native markers in its installed dir) does NOT flip buildHash', () => {
    const base = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const a = prepareNativeApp({ projectRoot: base, config: {} });

    const withLodash = project(
      { 'src/Button.tsx': BUTTON },
      { dependencies: { expo: '51', lodash: '^4.17.0' } },
    );
    installPkg(withLodash, 'lodash', '4.17.21'); // installed, but ships no native code
    const b = prepareNativeApp({ projectRoot: withLodash, config: {} });
    expect(b.buildInputs.nativeDeps).not.toHaveProperty('lodash');
    expect(b.buildHash).toBe(a.buildHash);
  });

  it('a NEW native-shipping dep DOES flip buildHash (autolinking compiles it in)', () => {
    const base = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const a = prepareNativeApp({ projectRoot: base, config: {} });

    const withVideo = project(
      { 'src/Button.tsx': BUTTON },
      { dependencies: { expo: '51', 'react-native-video': '^6.0.0' } },
    );
    installPkg(withVideo, 'react-native-video', '6.0.0', { dirs: ['ios', 'android'] });
    const b = prepareNativeApp({ projectRoot: withVideo, config: {} });
    expect(b.buildInputs.nativeDeps).toMatchObject({ 'react-native-video': '6.0.0' });
    expect(b.buildHash).not.toBe(a.buildHash);
  });

  it('bumping a native dep VERSION flips buildHash — versions come from the INSTALLED package, not the range', () => {
    // The old hash tracked dep NAMES only, so `reanimated 3 → 4` kept reading
    // "Installed and current" while the binary was built against v3 (stale-
    // binary redboxes). The installed node_modules version is the truth the
    // binary was built against, so a bump there must flip the gate even when
    // the package.json range string is unchanged (e.g. "^3.0.0" → resolved 3.1).
    const root = project(
      { 'src/Button.tsx': BUTTON },
      { dependencies: { expo: '51', 'react-native-reanimated': '*' } },
    );
    installPkg(root, 'react-native-reanimated', '3.16.0', { dirs: ['android'] });
    const v3 = prepareNativeApp({ projectRoot: root, config: {} });
    expect(v3.buildInputs.nativeDeps).toMatchObject({ 'react-native-reanimated': '3.16.0' });

    installPkg(root, 'react-native-reanimated', '4.0.0', { dirs: ['android'] });
    const v4 = prepareNativeApp({ projectRoot: root, config: {} });
    expect(v4.buildInputs.nativeDeps).toMatchObject({ 'react-native-reanimated': '4.0.0' });
    expect(v4.buildHash).not.toBe(v3.buildHash);
  });

  it('detects native code via podspec/gradle files, expo-module/plugin markers, and expo-plugin membership', () => {
    const root = project(
      { 'src/Button.tsx': BUTTON },
      {
        dependencies: {
          expo: '51',
          'pod-lib': '1.0.0', // .podspec at package root
          'expo-mod': '1.0.0', // expo-module.config.json (Expo Modules autolinking)
          'plugin-lib': '1.0.0', // app.plugin.js (config plugin)
          'rn-cli-lib': '1.0.0', // react-native.config.js (RN CLI autolinking)
          'cfg-plugin-only': '1.0.0', // JS-looking dir, but named in expo plugins
          'plain-js': '1.0.0', // none of the above
        },
      },
    );
    writeFileSync(
      join(root, 'app.json'),
      JSON.stringify({ expo: { plugins: ['cfg-plugin-only'] } }),
    );
    installPkg(root, 'pod-lib', '1.0.0', { files: ['PodLib.podspec'] });
    installPkg(root, 'expo-mod', '1.0.0', { files: ['expo-module.config.json'] });
    installPkg(root, 'plugin-lib', '1.0.0', { files: ['app.plugin.js'] });
    installPkg(root, 'rn-cli-lib', '1.0.0', { files: ['react-native.config.js'] });
    installPkg(root, 'cfg-plugin-only', '1.0.0');
    installPkg(root, 'plain-js', '1.0.0');

    const inputs = prepareNativeApp({ projectRoot: root, config: {} }).buildInputs;
    expect(Object.keys(inputs.nativeDeps).sort()).toEqual([
      'cfg-plugin-only',
      'expo-mod',
      'plugin-lib',
      'pod-lib',
      'rn-cli-lib',
    ]);
    expect(inputs.nativeDeps).not.toHaveProperty('plain-js');
    // Not installed + not a plugin → can't ship native code into THIS build.
    expect(inputs.nativeDeps).not.toHaveProperty('expo');
  });

  it('toggling newArchEnabled / changing jsEngine / editing plugins flips buildHash', () => {
    const mk = (expo: object) => {
      const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
      writeFileSync(join(root, 'app.json'), JSON.stringify({ expo }));
      return prepareNativeApp({ projectRoot: root, config: {} });
    };
    const base = mk({ newArchEnabled: true, jsEngine: 'hermes', plugins: ['expo-camera'] });
    expect(base.buildInputs.expoConfig).toMatchObject({
      newArchEnabled: true,
      jsEngine: 'hermes',
      plugins: ['expo-camera'],
    });

    // Each binary-affecting field flips the hash (the old hash missed ALL of
    // these — the undetected-stale-binary direction of the bug).
    const newArchOff = mk({ newArchEnabled: false, jsEngine: 'hermes', plugins: ['expo-camera'] });
    expect(newArchOff.buildHash).not.toBe(base.buildHash);

    const jsc = mk({ newArchEnabled: true, jsEngine: 'jsc', plugins: ['expo-camera'] });
    expect(jsc.buildHash).not.toBe(base.buildHash);

    const extraPlugin = mk({
      newArchEnabled: true,
      jsEngine: 'hermes',
      plugins: ['expo-camera', ['expo-build-properties', { ios: { newArchEnabled: true } }]],
    });
    expect(extraPlugin.buildHash).not.toBe(base.buildHash);

    // Same fields → same hash (the hash is a pure function of the inputs).
    const same = mk({ newArchEnabled: true, jsEngine: 'hermes', plugins: ['expo-camera'] });
    expect(same.buildHash).toBe(base.buildHash);
  });

  it('the host adding/removing expo-splash-screen never flips buildHash (companion strips it)', () => {
    // The companion's app.config.js strips exactly expo-splash-screen, so the
    // POST-OVERRIDE plugins are what the binary is built from — a host splash
    // change is invisible to the companion and must not prompt a rebuild.
    const mk = (plugins: unknown[]) => {
      const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
      writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { plugins } }));
      return prepareNativeApp({ projectRoot: root, config: {} });
    };
    const without = mk(['expo-camera']);
    const withSplash = mk(['expo-camera', ['expo-splash-screen', { backgroundColor: '#fff' }]]);
    expect(withSplash.buildInputs.expoConfig.plugins).toEqual(['expo-camera']);
    expect(withSplash.buildHash).toBe(without.buildHash);
  });

  it('persists the build inputs in the marker and round-trips them', () => {
    const root = project(
      { 'src/Button.tsx': BUTTON },
      { dependencies: { expo: '51', 'react-native-video': '*' } },
    );
    installPkg(root, 'react-native-video', '6.0.0', { dirs: ['ios'] });
    writeFileSync(join(root, 'app.json'), JSON.stringify({ expo: { jsEngine: 'hermes' } }));
    const a = prepareNativeApp({ projectRoot: root, config: {} });

    writeBuildMarker(a.buildMarkerPath, a.buildHash, a.buildInputs);
    const marker = readBuildMarker(a.buildMarkerPath)!;
    expect(marker.hash).toBe(a.buildHash);
    expect(marker.revision).toBe(COMPANION_BUILD_REVISION);
    expect(marker.inputs).toEqual(a.buildInputs);

    // Older-format markers ({hash, rev} or bare hash) parse with NO inputs —
    // the readiness checklist then falls back to its generic one-time reason.
    writeFileSync(a.buildMarkerPath, JSON.stringify({ hash: a.buildHash, rev: 2 }));
    expect(readBuildMarker(a.buildMarkerPath)!.inputs).toBeUndefined();
    // Tampered/partial inputs read as absent, never throw.
    writeFileSync(
      a.buildMarkerPath,
      JSON.stringify({ hash: a.buildHash, rev: 2, inputs: { nativeDeps: { x: 1 } } }),
    );
    expect(readBuildMarker(a.buildMarkerPath)!.inputs).toBeUndefined();
    // A tampered non-string scheme is dropped, not fatal — the rest of the
    // inputs (and their diff) survive.
    writeFileSync(
      a.buildMarkerPath,
      JSON.stringify({
        hash: a.buildHash,
        rev: 2,
        inputs: { ...a.buildInputs, scheme: 42 },
      }),
    );
    const tamperedScheme = readBuildMarker(a.buildMarkerPath)!.inputs!;
    expect(tamperedScheme.scheme).toBeUndefined();
    expect(tamperedScheme.nativeDeps).toEqual(a.buildInputs.nativeDeps);
  });

  it('does NOT change buildHash when only a view is added — views are ephemeral', () => {
    // A view is just data over already-registered components, shipped inline
    // per-navigation (bridge / deep-link), so creating one must never flip the
    // native-rebuild gate. This is the fix for the slow-rebuild-per-view bug.
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const a = prepareNativeApp({ projectRoot: root, config: {} });
    const b = prepareNativeApp({
      projectRoot: root,
      config: { views: { V: { items: [{ componentPath: 'src/Button.tsx' }] } } } as never,
    });
    expect(b.buildHash).toBe(a.buildHash);
    expect(b.prepared.structureHash).toBe(a.prepared.structureHash);

    // ...and the marker written for the view-less build is still fresh.
    writeBuildMarker(a.buildMarkerPath, a.buildHash);
    expect(isCompanionBuildFresh(b.buildMarkerPath, b.buildHash)).toBe(true);
  });

  it('records the app-shell revision in the marker; legacy bare-hash markers parse as revision 1', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const a = prepareNativeApp({ projectRoot: root, config: {} });

    // Fresh marker: JSON {hash, rev} at the current revision.
    writeBuildMarker(a.buildMarkerPath, a.buildHash);
    expect(readBuildMarker(a.buildMarkerPath)).toEqual({
      hash: a.buildHash,
      revision: COMPANION_BUILD_REVISION,
    });
    expect(isCompanionBuildFresh(a.buildMarkerPath, a.buildHash)).toBe(true);

    // Legacy marker (bare hash, written before revisions existed): still
    // parses — revision 1 is the signal the readiness checklist uses to say
    // "companion config changed: splash screen removed" instead of the generic
    // STALE message. It can never read fresh against the revision-salted hash.
    writeFileSync(a.buildMarkerPath, 'deadbeefdeadbeef');
    expect(readBuildMarker(a.buildMarkerPath)).toEqual({
      hash: 'deadbeefdeadbeef',
      revision: 1,
    });
    expect(isCompanionBuildFresh(a.buildMarkerPath, a.buildHash)).toBe(false);

    // Missing/garbage markers → null (never built / unreadable).
    expect(readBuildMarker(join(root, 'no-such-marker'))).toBeNull();
    writeFileSync(a.buildMarkerPath, '{"rev": 2}'); // JSON but no hash
    expect(readBuildMarker(a.buildMarkerPath)).toBeNull();
  });
});

describe('describeBuildInputDiff', () => {
  const inputs = (over: Partial<CompanionBuildInputs> = {}): CompanionBuildInputs => ({
    nativeDeps: { 'expo-router': '3.4.0', 'react-native': '0.81.0' },
    expoConfig: { plugins: ['expo-camera'], newArchEnabled: true, jsEngine: 'hermes' },
    ...over,
  });

  it('names a native dep version bump (the readiness message body)', () => {
    const diff = describeBuildInputDiff(
      inputs(),
      inputs({ nativeDeps: { 'expo-router': '4.0.0', 'react-native': '0.81.0' } }),
    );
    expect(diff).toEqual(['native deps changed: expo-router 3.4.0→4.0.0']);
  });

  it('names added and removed native deps', () => {
    const diff = describeBuildInputDiff(
      inputs(),
      inputs({ nativeDeps: { 'react-native': '0.81.0', 'react-native-video': '6.0.0' } }),
    );
    expect(diff).toEqual([
      'native deps changed: expo-router removed, react-native-video@6.0.0 added',
    ]);
  });

  it('names expo-config field changes (newArchEnabled / jsEngine / plugins)', () => {
    const cur = inputs({
      expoConfig: {
        plugins: [['expo-camera', { perm: 'x' }], 'expo-font'],
        newArchEnabled: false,
        jsEngine: 'jsc',
      },
    });
    const diff = describeBuildInputDiff(inputs(), cur);
    expect(diff).toEqual([
      'expo config changed: newArchEnabled true→false, jsEngine hermes→jsc, plugin expo-camera options changed, plugin expo-font added',
    ]);
  });

  it('an unset field reads as unset/default, and a pure plugin reorder is still named', () => {
    const prev = inputs({
      expoConfig: { plugins: ['expo-camera', 'expo-font'] },
    });
    const reordered = inputs({
      expoConfig: { plugins: ['expo-font', 'expo-camera'] },
    });
    expect(describeBuildInputDiff(prev, reordered)).toEqual([
      'expo config changed: plugin order changed',
    ]);
    expect(
      describeBuildInputDiff(
        prev,
        inputs({ expoConfig: { plugins: ['expo-camera', 'expo-font'], jsEngine: 'hermes' } }),
      ),
    ).toEqual(['expo config changed: jsEngine default→hermes']);
  });

  it('returns [] when nothing visibly differs (caller falls back to its generic message)', () => {
    expect(describeBuildInputDiff(inputs(), inputs())).toEqual([]);
  });

  it('names a companion URL scheme change (an edited override leaves the binary on the old scheme)', () => {
    const diff = describeBuildInputDiff(
      inputs({ scheme: 'validity-ai-validity-playground' }),
      inputs({ scheme: 'myapp' }),
    );
    expect(diff).toEqual(['companion URL scheme changed: validity-ai-validity-playground→myapp']);
    // A pre-scheme marker (rev<3) reads as the legacy default era — still named,
    // though the revision message normally owns those rebuilds.
    expect(describeBuildInputDiff(inputs(), inputs({ scheme: 'validity-x' }))).toEqual([
      'companion URL scheme changed: (legacy default)→validity-x',
    ]);
    expect(describeBuildInputDiff(inputs({ scheme: 'same' }), inputs({ scheme: 'same' }))).toEqual(
      [],
    );
  });
});

describe('isCompanionMetroUp', () => {
  it('true when Metro answers /status with packager-status:running', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: 'packager-status:running', stderr: '' }));
    expect(await isCompanionMetroUp(COMPANION_METRO_PORT, run)).toBe(true);
    // probes the right port
    expect(
      run.mock.calls[0][1].some((a: string) => a.includes(`:${COMPANION_METRO_PORT}/status`)),
    ).toBe(true);
  });
  it('false when nothing is listening (curl non-zero / empty body)', async () => {
    const run = vi.fn(async () => ({ code: 7, stdout: '', stderr: 'Connection refused' }));
    expect(await isCompanionMetroUp(COMPANION_METRO_PORT, run)).toBe(false);
  });
  it('false when the port answers but is NOT Metro', async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: '<html>some other server</html>',
      stderr: '',
    }));
    expect(await isCompanionMetroUp(COMPANION_METRO_PORT, run)).toBe(false);
  });
});

describe('isAppInstalledCommand', () => {
  it('uses simctl get_app_container on ios', () => {
    expect(isAppInstalledCommand('ai.validity.playground', 'ios')).toEqual({
      bin: 'xcrun',
      args: ['simctl', 'get_app_container', 'booted', 'ai.validity.playground'],
    });
  });
  it('uses adb pm list packages on android', () => {
    expect(isAppInstalledCommand('ai.validity.playground', 'android').bin).toBe('adb');
  });
  it('pins the probe to a udid/serial when given — `booted` is ambiguous with >1 device', () => {
    expect(isAppInstalledCommand('ai.validity.playground', 'ios', 'UDID-1').args).toEqual([
      'simctl',
      'get_app_container',
      'UDID-1',
      'ai.validity.playground',
    ]);
    expect(
      isAppInstalledCommand('ai.validity.playground', 'android', 'emulator-5554').args,
    ).toEqual(['-s', 'emulator-5554', 'shell', 'pm', 'list', 'packages', 'ai.validity.playground']);
  });
});

describe('isCompanionAppInstalled', () => {
  it('ios: true when get_app_container exits 0', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '/path', stderr: '' }));
    expect(await isCompanionAppInstalled('ai.validity.playground', 'ios', run)).toBe(true);
  });
  it('ios: false when get_app_container exits non-zero', async () => {
    const run = vi.fn(async () => ({ code: 2, stdout: '', stderr: 'No such file' }));
    expect(await isCompanionAppInstalled('ai.validity.playground', 'ios', run)).toBe(false);
  });
  it('android: true when pm list prints the package id', async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: 'package:ai.validity.playground\n',
      stderr: '',
    }));
    expect(await isCompanionAppInstalled('ai.validity.playground', 'android', run)).toBe(true);
  });
});

describe('metroServeSpawnEnv', () => {
  // Not setting CI ourselves (METRO_SERVE_ENV) was only half the fix from
  // commit e8f8c65: the serve child INHERITS the parent env, and an agent
  // harness / CI shell commonly exports CI=1 — Expo's isWatchEnabled() gate is
  // a truthiness check, so the inherited value kills the watcher (and Fast
  // Refresh with it) exactly like setting it ourselves would.
  it('strips an INHERITED CI=1 (and CONTINUOUS_INTEGRATION) from the child env', () => {
    const env = metroServeSpawnEnv(
      { PATH: '/usr/bin', CI: '1', CONTINUOUS_INTEGRATION: 'true', HOME: '/home/u' },
      METRO_SERVE_ENV,
    );
    expect(env.CI).toBeUndefined();
    expect(env.CONTINUOUS_INTEGRATION).toBeUndefined();
    // The rest of the parent env still passes through (PATH etc. are needed
    // for npx/expo to even spawn), and the serve env composes on top.
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/u', EXPO_OFFLINE: '1' });
  });

  it('composes the step env over the parent env (step wins on conflicts)', () => {
    const env = metroServeSpawnEnv({ EXPO_OFFLINE: '0', FOO: 'bar' }, { EXPO_OFFLINE: '1' });
    expect(env.EXPO_OFFLINE).toBe('1');
    expect(env.FOO).toBe('bar');
  });

  it('is a passthrough (minus CI flags) when the step has no env of its own', () => {
    const env = metroServeSpawnEnv({ PATH: '/usr/bin', CI: 'true' });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

describe('EXPO_ROUTER_STORE_SPECIFIER', () => {
  it('is the exact path the generated metro.config redirect matches (preflight cannot drift)', () => {
    const root = project(
      { 'src/Button.tsx': BUTTON },
      { dependencies: { expo: '51', 'expo-router': '4' } },
    );
    const result = prepareNativeApp({ projectRoot: root, config: {} });
    const metroConfig = readFileSync(join(result.appDir, 'metro.config.js'), 'utf-8');
    expect(metroConfig).toContain(`validityFp.endsWith('${EXPO_ROUTER_STORE_SPECIFIER}')`);
  });
});

describe('companion local dependency paths', () => {
  it.each(['npm', 'pnpm'])('rebases real local targets without changing the host (%s)', (pm) => {
    const plugin = '@validity.ai/verify-plugin-expo';
    const root = project(
      {
        ...(pm === 'pnpm' ? { 'pnpm-lock.yaml': 'lockfileVersion: 9' } : {}),
        '.validity/plugins/expo/package.json': JSON.stringify({ name: plugin, version: '1.0.0' }),
        'linked/package.json': JSON.stringify({ name: 'linked', version: '1.0.0' }),
        'local.tgz': 'path-resolution fixture, not an installable archive',
      },
      {
        dependencies: {
          expo: '51',
          [plugin]: 'file:.validity/plugins/expo',
          linked: 'link:./linked',
          archive: 'file:./linked/../local.tgz',
          registry: '^1.2.3',
          alias: 'npm:original@^1',
          home: 'file:~/local',
        },
      },
    );
    const hostPath = join(root, 'package.json');
    const host = JSON.parse(readFileSync(hostPath, 'utf-8'));
    host.dependencies.absolute = `file:${join(root, 'linked')}`;
    writeFileSync(hostPath, JSON.stringify(host));
    const before = readFileSync(hostPath, 'utf-8');
    const app = prepareNativeApp({ projectRoot: root });
    const { dependencies } = JSON.parse(readFileSync(join(app.appDir, 'package.json'), 'utf-8'));
    expect(dependencies).toEqual({
      ...host.dependencies,
      [plugin]: 'file:../plugins/expo',
      linked: 'link:../../linked',
      archive: 'file:../../local.tgz',
    });
    for (const [name, target] of [
      [plugin, '.validity/plugins/expo'],
      ['linked', 'linked'],
      ['archive', 'local.tgz'],
    ]) {
      const resolved = resolve(app.appDir, dependencies[name].slice(5));
      expect(resolved).toBe(join(root, target));
      expect(existsSync(resolved)).toBe(true);
    }
    expect(readFileSync(hostPath, 'utf-8')).toBe(before);
  });
});
