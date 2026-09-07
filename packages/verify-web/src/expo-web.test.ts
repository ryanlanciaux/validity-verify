/**
 * Expo Web prepare-contract tests.
 *
 * **Scope of this file:**
 * Full end-to-end Expo Web rendering requires `expo`, `react-native`,
 * and `react-native-web` installed in the project's node_modules — and
 * the existing sandbox integration test suite already covers the
 * end-to-end render path for the web target. Here we only validate the
 * prepare contract:
 *
 *   - `detectFramework()` returns `'expo'` for an Expo-style project.
 *   - `prepareExpoWeb()` writes the same shell files as
 *     `prepareSandbox()` plus an entry.tsx that mounts via RN-Web's
 *     `AppRegistry.runApplication`, not React DOM's `createRoot`.
 *   - `buildExpoWebViteOverrides()` maps `react-native` →
 *     `react-native-web` when the user has RN-Web installed.
 *
 * The "real" render path is exercised by sandbox/integration.test.ts
 * for the web target; an analogous Expo end-to-end suite is deferred
 * until we ship a dedicated Expo fixture project with its own
 * react-native-web install.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { ValidityConfig } from '@validity.ai/verify-spec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectFramework } from './detect.js';
import { entryFile, indexHtml, validityDir } from './paths.js';
import { detectAppI18nModule, prepareExpoWeb } from './prepare-expo-web.js';
import { buildExpoWebViteOverrides } from './expo-web-aliases.js';

/**
 * Build a minimal "looks like an Expo project" tmp dir. We do NOT
 * install `react-native-web` etc. — we just declare them in
 * package.json so the detection / alias-builder code reads them as
 * present.
 */
function makeExpoProjectRoot(
  opts: { withReactNativeWeb?: boolean; withI18n?: boolean | 'deps-only' } = {},
): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-expo-test-'));
  const deps: Record<string, string> = {
    expo: '~50.0.0',
    react: '18.2.0',
    'react-native': '0.73.0',
  };
  if (opts.withReactNativeWeb) deps['react-native-web'] = '~0.19.0';
  if (opts.withI18n) {
    deps['i18next'] = '^23.0.0';
    deps['react-i18next'] = '^14.0.0';
  }
  writeFileSync(
    resolve(root, 'package.json'),
    JSON.stringify({ name: 'tmp-expo', version: '0.0.0', dependencies: deps }),
  );
  if (opts.withI18n === true) {
    // Ignite-style i18n bootstrap module (init is exported, not run at import).
    mkdirSync(resolve(root, 'app/i18n'), { recursive: true });
    writeFileSync(
      resolve(root, 'app/i18n/index.ts'),
      `import i18n from "i18next";\nimport { initReactI18next } from "react-i18next";\nexport const initI18n = async () => {\n  i18n.use(initReactI18next);\n  await i18n.init({ resources: {}, lng: "en" });\n  return i18n;\n};\n`,
    );
  }
  // Minimal App.tsx — content irrelevant for these tests.
  writeFileSync(
    resolve(root, 'App.tsx'),
    `import { View, Text } from 'react-native';\nexport default function App() { return <View><Text>Hello</Text></View>; }\n`,
  );
  // Wrapper file the entry will import.
  mkdirSync(resolve(root, '.validity'), { recursive: true });
  writeFileSync(
    resolve(root, '.validity/wrapper.tsx'),
    `import type { ReactNode } from 'react';\nexport default function W({ children }: { children: ReactNode }) { return <>{children}</>; }\n`,
  );
  // node_modules must exist for the .validity dir to land under it.
  mkdirSync(resolve(root, 'node_modules'), { recursive: true });
  return root;
}

function baseConfig(overrides: Partial<ValidityConfig> = {}): ValidityConfig {
  return {
    renderMode: 'web',
    framework: 'expo-web',
    wrapper: './.validity/wrapper.tsx',
    ...overrides,
  };
}

describe('Expo Web detection', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = makeExpoProjectRoot();
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("detectFramework() returns 'expo' for a package.json with expo in deps", () => {
    expect(detectFramework(projectRoot)).toBe('expo');
  });

  it("WRONG-RUNTIME: an Expo project carrying a vite.config.ts is still 'expo', not 'vite'", () => {
    // Regression: Vite was checked FIRST, so an Expo app that keeps a
    // vite.config.ts (a common way to get a `@/` path alias for tooling)
    // detected as a plain Vite web app. resolveTarget's auto path then
    // returned 'web' and rendered React Native through react-native-web —
    // silently validating a runtime the app never ships on, which is exactly
    // what ExpoWebNotRequestedError exists to prevent. `detectAppTarget`
    // already ordered expo before vite; the two must not disagree.
    writeFileSync(resolve(projectRoot, 'vite.config.ts'), 'export default {};\n');
    expect(detectFramework(projectRoot)).toBe('expo');
  });

  it("detectFramework() still returns 'vite' for a plain Vite app (no RN/Expo signals)", () => {
    const root2 = mkdtempSync(resolve(tmpdir(), 'validity-plain-vite-'));
    try {
      writeFileSync(
        resolve(root2, 'package.json'),
        JSON.stringify({ name: 'web', devDependencies: { vite: '^5' } }),
      );
      expect(detectFramework(root2)).toBe('vite');
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  it("detectFramework() returns 'expo' when only app.json exists (no expo in deps)", () => {
    const root2 = mkdtempSync(resolve(tmpdir(), 'validity-expo-appjson-'));
    try {
      writeFileSync(resolve(root2, 'package.json'), JSON.stringify({ name: 'rn-via-app-json' }));
      writeFileSync(resolve(root2, 'app.json'), JSON.stringify({ expo: { name: 'X' } }));
      expect(detectFramework(root2)).toBe('expo');
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });
});

describe('prepareExpoWeb', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = makeExpoProjectRoot();
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes entry.tsx, validity-msw.ts, and index.html under node_modules/.validity', () => {
    const result = prepareExpoWeb(projectRoot, baseConfig());

    expect(result.validityDir).toBe(validityDir(projectRoot));
    expect(existsSync(result.entryFile)).toBe(true);
    expect(existsSync(result.indexHtml)).toBe(true);
    expect(existsSync(resolve(result.validityDir, 'validity-msw.ts'))).toBe(true);
    expect(existsSync(resolve(result.validityDir, '.gitignore'))).toBe(true);
  });

  it('entry.tsx imports react-native-web and mounts via AppRegistry, not createRoot', () => {
    prepareExpoWeb(projectRoot, baseConfig());
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    // RN-Web mount surface, NOT react-dom/client.
    expect(entry).toContain("from 'react-native-web'");
    expect(entry).toContain('AppRegistry.registerComponent');
    expect(entry).toContain('AppRegistry.runApplication');
    expect(entry).not.toContain('react-dom/client');
    expect(entry).not.toContain('createRoot(');

    // Same network/glob/ready contract as the web entry.
    expect(entry).toContain('await setupValidityNetwork(');
    expect(entry).toContain("import.meta.glob('../../**/*.{tsx,jsx}')");
    expect(entry).toContain("params.get('scenario')");
    expect(entry).toContain('__validityReady');
    expect(entry).toContain('data-validity-ready');
  });

  it('entry.tsx mirrors the web perf fold, including updateTotalMs (D2 mirror guard)', () => {
    prepareExpoWeb(projectRoot, baseConfig());
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');

    expect(entry).toContain('window.__VALIDITY_GET_PERF__ =');
    // The MIRROR contract with prepare.ts: any fold change lands in both files.
    // prepare.test.ts pins the same strings on the web entry.
    expect(entry).toContain('out.updateTotalMs =');
    expect(entry).toContain('updates.reduce((s, c) => s + c.actualDuration, 0)');
    // Same mirror contract for the harness-boot subtraction: an expo-web entry
    // that skipped it would keep reporting the sandbox's cold start as the
    // component's readyMs, i.e. false-red exactly one target.
    expect(entry).toContain('window.__VALIDITY_PERF_BOOT_MS__ = performance.now();');
    expect(entry).toContain('window.__VALIDITY_PERF_READY_MS__ - boot');
    expect(entry).toContain('out.harnessBootMs = Math.round(boot);');
  });

  it('index.html is the framework-agnostic shell (same as the web prepare path)', () => {
    prepareExpoWeb(projectRoot, baseConfig());
    const html = readFileSync(indexHtml(projectRoot), 'utf-8');
    // Mount point identical to web — AppRegistry takes #root as its rootTag.
    expect(html).toContain('<div id="root"></div>');
    // Early-error trap + scenario-seed script.
    expect(html).toContain('data-validity-error');
    expect(html).toContain('/__validity/api/scenario-state');
  });

  it('serializes base mockNetwork into entry.tsx', () => {
    prepareExpoWeb(
      projectRoot,
      baseConfig({
        mockNetwork: {
          fallback: 'reject',
          handlers: [{ url: '/api/me', json: { id: '1' } }],
        },
      }),
    );
    const entry = readFileSync(entryFile(projectRoot), 'utf-8');
    const match = entry.match(/window\.__VALIDITY_BASE_NETWORK__ = (.+);/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!);
    expect(parsed.fallback).toBe('reject');
    expect(parsed.handlers).toEqual([{ url: '/api/me', json: { id: '1' } }]);
  });
});

describe('app i18n auto-init (expo-web)', () => {
  it('writes validity-i18n.ts and wires the entry when an i18n bootstrap module exists', () => {
    const root = makeExpoProjectRoot({ withI18n: true });
    try {
      prepareExpoWeb(root, baseConfig());

      const i18nModule = readFileSync(resolve(validityDir(root), 'validity-i18n.ts'), 'utf-8');
      // Imports the app's own bootstrap module (extension stripped, relative
      // to node_modules/.validity) and guards on i18next.isInitialized so the
      // init is idempotent.
      expect(i18nModule).toContain("import('../../app/i18n/index')");
      expect(i18nModule).toContain('isInitialized');
      expect(i18nModule).toContain('export async function ensureAppI18n');

      const entry = readFileSync(entryFile(root), 'utf-8');
      expect(entry).toContain("import { ensureAppI18n } from './validity-i18n';");
      // Ordering contract: interceptors first (init may fetch translations),
      // then AWAIT i18n (translate() is non-reactive — init after mount would
      // freeze raw keys in), then the AppRegistry mount.
      const networkIdx = entry.indexOf('await setupValidityNetwork(');
      const i18nIdx = entry.indexOf('ensureAppI18n(), new Promise');
      const mountIdx = entry.indexOf('AppRegistry.runApplication');
      expect(networkIdx).toBeGreaterThan(-1);
      expect(i18nIdx).toBeGreaterThan(networkIdx);
      expect(mountIdx).toBeGreaterThan(i18nIdx);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips wiring when i18next is a dep but no bootstrap module exists', () => {
    const root = makeExpoProjectRoot({ withI18n: 'deps-only' });
    try {
      prepareExpoWeb(root, baseConfig());
      expect(existsSync(resolve(validityDir(root), 'validity-i18n.ts'))).toBe(false);
      const entry = readFileSync(entryFile(root), 'utf-8');
      expect(entry).not.toContain('ensureAppI18n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detectAppI18nModule requires the i18next dep even when a candidate file exists', () => {
    const root = makeExpoProjectRoot(); // no i18next in deps
    try {
      mkdirSync(resolve(root, 'app/i18n'), { recursive: true });
      writeFileSync(
        resolve(root, 'app/i18n/index.ts'),
        `import i18n from "i18next";\nexport const initI18n = async () => i18n;\n`,
      );
      expect(detectAppI18nModule(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detectAppI18nModule finds the src/i18n.ts variant', () => {
    const root = makeExpoProjectRoot({ withI18n: 'deps-only' });
    try {
      mkdirSync(resolve(root, 'src'), { recursive: true });
      writeFileSync(
        resolve(root, 'src/i18n.ts'),
        `import { initReactI18next } from "react-i18next";\nexport async function setupI18n() {}\n`,
      );
      expect(detectAppI18nModule(root)).toBe(resolve(root, 'src/i18n.ts'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detectAppI18nModule rejects a candidate file that never references i18next', () => {
    const root = makeExpoProjectRoot({ withI18n: 'deps-only' });
    try {
      mkdirSync(resolve(root, 'src'), { recursive: true });
      // Home-grown i18n helper at a candidate path — not an i18next bootstrap.
      writeFileSync(
        resolve(root, 'src/i18n.ts'),
        `const strings = { hello: 'Hello' };\nexport const t = (k: keyof typeof strings) => strings[k];\n`,
      );
      expect(detectAppI18nModule(root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('buildExpoWebViteOverrides', () => {
  it('returns no aliases when react-native-web is not installed', () => {
    // No `node_modules/react-native-web` on disk → resolvePackageDir
    // returns undefined, and the RN→RN-Web alias isn't emitted.
    const root = makeExpoProjectRoot();
    try {
      const overrides = buildExpoWebViteOverrides(root);
      const findStr = (find: string | RegExp) => (typeof find === 'string' ? find : find.source);
      const aliasFinds = overrides.alias.map((a) => findStr(a.find));
      expect(aliasFinds).not.toContain('react-native');
      // optimizeDepsInclude is static — react-native-web is always in
      // the list so Vite warns clearly if it's missing.
      expect(overrides.optimizeDepsInclude).toContain('react-native-web');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('aliases react-native → react-native-web when the package is installed in node_modules', () => {
    const root = makeExpoProjectRoot({ withReactNativeWeb: true });
    try {
      // Stub a minimal react-native-web package on disk so
      // createRequire().resolve('react-native-web') succeeds.
      const rnwDir = resolve(root, 'node_modules/react-native-web');
      mkdirSync(rnwDir, { recursive: true });
      writeFileSync(
        resolve(rnwDir, 'package.json'),
        JSON.stringify({ name: 'react-native-web', main: './index.js' }),
      );
      writeFileSync(resolve(rnwDir, 'index.js'), 'module.exports = {};\n');

      const overrides = buildExpoWebViteOverrides(root);
      // The react-native alias must be an EXACT-match regex, not a bare string:
      // a string find is a prefix match and would rewrite deep imports like
      // `react-native/Libraries/...` (which don't exist under react-native-web,
      // crashing esbuild's dep optimizer). Anchored regex matches only the
      // package entry; deep specifiers fall through to real react-native.
      const rnAlias = overrides.alias.find(
        (a) => a.find instanceof RegExp && a.find.source === '^react-native$',
      );
      expect(rnAlias).toBeDefined();
      expect(rnAlias!.find).toBeInstanceOf(RegExp);
      expect((rnAlias!.find as RegExp).test('react-native')).toBe(true);
      // Deep imports must NOT match (so they resolve to the real RN package).
      expect((rnAlias!.find as RegExp).test('react-native/Libraries/Foo')).toBe(false);
      // The replacement is the ABSOLUTE package dir (not a bare specifier), so
      // esbuild's dep optimizer can resolve it. (realpath-tolerant: createRequire
      // resolves through the macOS /var → /private/var tmp symlink.)
      const replacement = rnAlias!.replacement as string;
      expect(isAbsolute(replacement)).toBe(true);
      expect(realpathSync(replacement)).toBe(realpathSync(rnwDir));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
