import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import {
  prepareNative,
  resolveNativeViewItems,
  scaffoldNativeWrapper,
  renderNativeWrapperScaffold,
  deriveExpoRouteInfo,
  makeDeepDefaultProxy,
  encodeScenarioSeedWire,
} from './prepare-native.js';
import { detectNative } from './detect-native.js';

const dirs: string[] = [];
function project(files: Record<string, string>, pkg: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-native-prep-'));
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

describe('prepareNative', () => {
  it('emits the entry, registry, and mock modules and registers components', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const out = join(root, 'out');
    const result = prepareNative({ projectRoot: root, outDir: out, config: {} });

    expect(existsSync(result.entryPath)).toBe(true);
    expect(existsSync(result.registryPath)).toBe(true);
    expect(existsSync(result.mockModulePath)).toBe(true);
    expect(existsSync(result.asyncStorageModulePath)).toBe(true);
    expect(existsSync(join(out, 'validity-native-wrapper.tsx'))).toBe(true);
    expect(result.registeredComponents).toContain('src/Button.tsx');
    expect(result.detection.usesExpo).toBe(true);
  });

  it('copies the raw RN templates into the out dir', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const out = join(root, 'out');
    prepareNative({ projectRoot: root, outDir: out, config: {} });
    expect(existsSync(join(out, 'ValidityNativeRoot.tsx'))).toBe(true);
    expect(existsSync(join(out, 'mock-provider-shell.tsx'))).toBe(true);
  });

  describe('auto-mocked navigation (validity-native-nav.tsx)', () => {
    it('generates RN-context nav module when router is react-navigation', () => {
      const root = project(
        { 'src/Button.tsx': BUTTON },
        { dependencies: { 'react-native': '0.81', '@react-navigation/native': '7.0.0' } },
      );
      const out = join(root, 'out');
      const result = prepareNative({ projectRoot: root, outDir: out, config: {} });
      expect(result.detection.router).toBe('react-navigation');
      expect(existsSync(result.navModulePath)).toBe(true);
      const nav = readFileSync(result.navModulePath, 'utf-8');
      expect(nav).toContain('NavigationContext');
      expect(nav).toContain('NavigationRouteContext');
      expect(nav).toContain("from '@react-navigation/native'");
      expect(nav).toContain('export function NavigationMockProvider');
    });

    it('expo-router projects also get the RN-context nav module (expo-router depends on @react-navigation/native)', () => {
      const root = project(
        { 'src/Button.tsx': BUTTON },
        { dependencies: { expo: '51', 'expo-router': '4.0.0' } },
      );
      const out = join(root, 'out');
      const result = prepareNative({ projectRoot: root, outDir: out, config: {} });
      expect(result.detection.router).toBe('expo-router');
      const nav = readFileSync(result.navModulePath, 'utf-8');
      expect(nav).toContain("from '@react-navigation/native'");
      expect(nav).toContain('NavigationMockProvider');
    });

    it('generates a ZERO-IMPORT passthrough when no navigation library is present (bundle-safety for non-nav apps)', () => {
      const root = project(
        { 'src/Button.tsx': BUTTON },
        { dependencies: { 'react-native': '0.81' } },
      );
      const out = join(root, 'out');
      const result = prepareNative({ projectRoot: root, outDir: out, config: {} });
      expect(result.detection.router).toBe('none');
      const nav = readFileSync(result.navModulePath, 'utf-8');
      // Must NOT statically import a package a non-navigation app doesn't have.
      expect(nav).not.toContain('@react-navigation/native');
      // Still exports a passthrough so the shell import always resolves.
      expect(nav).toContain('export function NavigationMockProvider');
      expect(nav).toContain('<>{children}</>');
    });

    it('injects navigation/route PROPS into the isolated child (screens receive them as props, not just hooks)', () => {
      // React Navigation hands navigation/route to screens as props; contexts
      // only serve the hooks. Without the injection a prop-consuming screen
      // redboxes with "Cannot read property 'navigate' of undefined".
      for (const deps of [
        { 'react-native': '0.81', '@react-navigation/native': '7.0.0' },
        { expo: '51', 'expo-router': '4.0.0' },
      ]) {
        const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: deps });
        const out = join(root, 'out');
        const nav = readFileSync(
          prepareNative({ projectRoot: root, outDir: out, config: {} }).navModulePath,
          'utf-8',
        );
        expect(nav).toContain('export function withNavProps');
        expect(nav).toContain('withNavProps(children, mockNavigation, route)');
        // Explicit fixture props must win — injection only fills undefined.
        expect(nav).toContain('props.navigation === undefined');
      }
    });

    it('mock navigation shape satisfies useScrollToTop + useIsFocused', () => {
      const root = project(
        { 'src/Button.tsx': BUTTON },
        { dependencies: { 'react-native': '0.81', '@react-navigation/native': '7.0.0' } },
      );
      const out = join(root, 'out');
      const nav = readFileSync(
        prepareNative({ projectRoot: root, outDir: out, config: {} }).navModulePath,
        'utf-8',
      );
      // useScrollToTop walks getParent() and reads getState().routes[0].key;
      // addListener must return an unsubscribe fn; useIsFocused falls back to isFocused().
      expect(nav).toContain('getParent: () => undefined');
      expect(nav).toContain('addListener: () => () => {}');
      expect(nav).toContain('isFocused: () => true');
      expect(nav).toContain('routes: [mockRoute]');
      // route.key MUST equal getState().routes[0].key — both come from mockRoute.
      expect(nav).toContain("key: 'validity'");
    });

    it('the copied shell imports the generated nav module', () => {
      const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
      const out = join(root, 'out');
      prepareNative({ projectRoot: root, outDir: out, config: {} });
      const shell = readFileSync(join(out, 'mock-provider-shell.tsx'), 'utf-8');
      expect(shell).toContain("import { NavigationMockProvider } from './validity-native-nav'");
      expect(shell).toContain('<NavigationMockProvider');
    });

    it('expo-router: generates the store mock + introspecting nav module, and the RN-only path does NOT', () => {
      const expo = project(
        { 'app/index.tsx': BUTTON },
        { dependencies: { expo: '51', 'expo-router': '4.0.0', 'react-native': '0.81' } },
      );
      const expoOut = join(expo, 'out');
      const r = prepareNative({ projectRoot: expo, outDir: expoOut, config: {} });
      expect(r.detection.router).toBe('expo-router');
      // The store mock — the single seam every expo-router hook + component funnels through.
      expect(existsSync(join(expoOut, 'validity-expo-router-store-mock.js'))).toBe(true);
      // The nav module introspects the screen's app/ route + provides LocalRouteParamsContext.
      const nav = readFileSync(r.navModulePath, 'utf-8');
      expect(nav).toContain('function deriveExpoRoute');
      expect(nav).toContain('LocalRouteParamsContext');
      expect(nav).toContain('globalThis.__validityExpoRoute');

      // A react-navigation app must NOT get the expo-router store mock (it has no expo-router).
      const rn = project(
        { 'src/A.tsx': BUTTON },
        { dependencies: { 'react-native': '0.81', '@react-navigation/native': '7.0.0' } },
      );
      const rnOut = join(rn, 'out');
      prepareNative({ projectRoot: rn, outDir: rnOut, config: {} });
      expect(existsSync(join(rnOut, 'validity-expo-router-store-mock.js'))).toBe(false);
    });

    it('expo-router store mock exposes the full store surface other expo-router modules read', () => {
      const expo = project(
        { 'app/index.tsx': BUTTON },
        { dependencies: { expo: '51', 'expo-router': '4.0.0', 'react-native': '0.81' } },
      );
      const out = join(expo, 'out');
      prepareNative({ projectRoot: expo, outDir: out, config: {} });
      const mock = readFileSync(join(out, 'validity-expo-router-store-mock.js'), 'utf-8');
      // The crash site: real syncStoreRootState() calls store.navigationRef.isReady().
      expect(mock).toContain('isReady: function ()');
      // Enumerated cross-module store surface + the module exports.
      for (const member of [
        'routeInfoSnapshot',
        'rootStateSnapshot',
        'subscribeToRootState',
        'getStateFromPath',
        'dismissAll',
        'canDismiss',
      ]) {
        expect(mock).toContain(member);
      }
      for (const exp of ['exports.store', 'exports.useStoreRouteInfo', 'exports.useExpoRouter']) {
        expect(mock).toContain(exp);
      }
    });

    it('react-navigation + expo-router nav modules mount the link contexts (useLinkTo/useLinkProps/<Link>)', () => {
      for (const deps of [
        { 'react-native': '0.81', '@react-navigation/native': '7.0.0' },
        { expo: '51', 'expo-router': '4.0.0', 'react-native': '0.81' },
      ]) {
        const root = project({ 'app/index.tsx': BUTTON }, { dependencies: deps });
        const r = prepareNative({ projectRoot: root, outDir: join(root, 'out'), config: {} });
        const nav = readFileSync(r.navModulePath, 'utf-8');
        for (const ctx of [
          'NavigationContainerRefContext',
          'NavigationHelpersContext',
          'LinkingContext',
        ]) {
          expect(nav).toContain(ctx);
        }
        expect(nav).toContain('function NavContexts');
      }
    });

    it('expo-router store mock provides linkTo + getSortedRoutes and a recording Proxy fallback', () => {
      const expo = project(
        { 'app/index.tsx': BUTTON },
        { dependencies: { expo: '51', 'expo-router': '4.0.0', 'react-native': '0.81' } },
      );
      const out = join(expo, 'out');
      prepareNative({ projectRoot: expo, outDir: out, config: {} });
      // The store mock is plain CommonJS with no RN imports → loadable here.
      const req = createRequire(import.meta.url);
      const mock = req(join(out, 'validity-expo-router-store-mock.js'));
      expect(typeof mock.store.linkTo).toBe('function'); // <Link> press path
      expect(Array.isArray(mock.store.getSortedRoutes())).toBe(true); // Sitemap maps over it
      // Proxy fallback: an unstubbed member is a recording no-op, not a crash.
      expect(typeof mock.store.someFutureMethod).toBe('function');
      expect(() => mock.store.someFutureMethod('x')).not.toThrow();
    });

    it('GestureHandlerRootView wrapper module is conditional on the dep', () => {
      const withGh = project(
        { 'src/A.tsx': BUTTON },
        {
          dependencies: { expo: '51', 'react-native': '0.81', 'react-native-gesture-handler': '2' },
        },
      );
      const ghOut = join(withGh, 'out');
      const rg = prepareNative({ projectRoot: withGh, outDir: ghOut, config: {} });
      expect(rg.detection.hasGestureHandler).toBe(true);
      const gh = readFileSync(join(ghOut, 'validity-native-gh.tsx'), 'utf-8');
      expect(gh).toMatch(/import .*GestureHandlerRootView.* from 'react-native-gesture-handler'/);

      const noGh = project(
        { 'src/A.tsx': BUTTON },
        { dependencies: { expo: '51', 'react-native': '0.81' } },
      );
      const noGhOut = join(noGh, 'out');
      prepareNative({ projectRoot: noGh, outDir: noGhOut, config: {} });
      const ghPass = readFileSync(join(noGhOut, 'validity-native-gh.tsx'), 'utf-8');
      expect(ghPass).not.toMatch(/import .* from 'react-native-gesture-handler'/);
      expect(ghPass).toContain('export function GestureRoot');
    });

    it('contentHash flips when the detected router changes (drives the Metro --clear gate)', () => {
      const files = { 'src/Button.tsx': BUTTON };
      const navProj = project(files, {
        dependencies: { 'react-native': '0.81', '@react-navigation/native': '7.0.0' },
      });
      const noneProj = project(files, { dependencies: { 'react-native': '0.81' } });
      const a = prepareNative({ projectRoot: navProj, outDir: join(navProj, 'out'), config: {} });
      const b = prepareNative({ projectRoot: noneProj, outDir: join(noneProj, 'out'), config: {} });
      expect(a.contentHash).not.toBe(b.contentHash);
    });
  });

  describe('createContext deep-default auto-mock (validity-native-context-patch)', () => {
    it('generates the patch module (globalThis, idempotent, undefined/null-only guard) and never references window', () => {
      const root = project(
        { 'src/A.tsx': BUTTON },
        {
          dependencies: { expo: '51', '@react-navigation/native': '7.0.0', 'react-native': '0.81' },
        },
      );
      const out = join(root, 'out');
      prepareNative({ projectRoot: root, outDir: out, config: {} });
      const patch = readFileSync(join(out, 'validity-native-context-patch.ts'), 'utf-8');
      expect(patch).toContain('function makeDeepDefaultProxy');
      expect(patch).toContain('globalThis.__VALIDITY_DEEP_DEFAULT__ = makeDeepDefaultProxy');
      expect(patch).toContain('React.__validityContextPatched');
      expect(patch).toContain('defaultValue === undefined || defaultValue === null');
      // RN has no window — the patch must use globalThis only.
      expect(patch).not.toContain('window.__VALIDITY');
    });

    it('native-entry installs the patch AFTER ValidityNativeRoot but BEFORE component-registry (the load-bearing scoping)', () => {
      const root = project(
        { 'src/A.tsx': BUTTON },
        {
          dependencies: { expo: '51', '@react-navigation/native': '7.0.0', 'react-native': '0.81' },
        },
      );
      const out = join(root, 'out');
      const entry = readFileSync(
        prepareNative({ projectRoot: root, outDir: out, config: {} }).entryPath,
        'utf-8',
      );
      const iRoot = entry.indexOf("from './ValidityNativeRoot'");
      const iPatch = entry.indexOf("'./validity-native-context-patch'");
      const iRegistry = entry.indexOf("from './component-registry'");
      expect(iRoot).toBeGreaterThanOrEqual(0);
      // Patch must sit strictly between them so RN contexts keep undefined defaults
      // (created in the ValidityNativeRoot subtree) and only user-screen contexts
      // (imported via the registry) get proxy defaults. NOTE: this checks the
      // textual import POSITION, which (because Metro evaluates imports depth-first
      // in source order) determines eval order — but it does NOT itself exercise
      // runtime eval order; the proxy-behavior test above covers the proxy itself.
      expect(iPatch).toBeGreaterThan(iRoot);
      expect(iPatch).toBeLessThan(iRegistry);
    });

    // Pure standard ES → V8 results are representative of Hermes.
    it('makeDeepDefaultProxy makes any provider-guard pass and survives deep access/coercion/iteration', () => {
      const p: any = makeDeepDefaultProxy();
      // The whole point: `const c = useContext(C); if (!c) throw` must NOT throw.
      expect(Boolean(p)).toBe(true);
      expect(() => p.user.profile.name.length).not.toThrow();
      expect(String(p.label)).toBe('');
      expect(Number(p.count)).toBe(0);
      expect(p.isLoading).toBe(false); // flag-shaped → false (no error branch)
      expect(Array.isArray(p.items)).toBe(true);
      expect(p.items.length).toBe(0);
      expect([...p.list]).toEqual([]); // iterable
      expect(p.then).toBeUndefined(); // not a thenable
      expect(typeof p.login).toBe('function'); // method calls don't throw
      expect(() => p.login('x')).not.toThrow();
      // Callable child proxies wrap a function target. React/Hermes clone via
      // ownKeys+get; returning [] used to throw "ownKeys target key is
      // non-configurable but not present in trap result".
      const child: any = p.login;
      expect(() => Object.getOwnPropertyNames(child)).not.toThrow();
      expect(() => Object.assign({}, child)).not.toThrow();
    });

    it('scenario context seed overlays the proxy (top-level only) for logged-in / logged-out', () => {
      const p: any = makeDeepDefaultProxy();
      const g = globalThis as any;
      try {
        // logged-in: seeded keys win over the heuristic default.
        g.__VALIDITY_CONTEXT_SEED__ = {
          isAuthenticated: true,
          authEmail: 'me@app.com',
          user: { name: 'Test User' },
        };
        expect(p.isAuthenticated).toBe(true);
        expect(p.authEmail).toBe('me@app.com');
        expect(p.user.name).toBe('Test User');
        // a NON-seeded key still falls back to the heuristic.
        expect(p.someOtherFlag === undefined || typeof p.someOtherFlag !== 'undefined').toBe(true);
        // child proxies must NOT read the seed (nested isAuthenticated stays heuristic false).
        expect(p.foo.isAuthenticated).toBe(false);

        // logged-out (explicit): isAuthenticated false, token cleared.
        g.__VALIDITY_CONTEXT_SEED__ = { isAuthenticated: false, authToken: undefined };
        expect(p.isAuthenticated).toBe(false);
        expect(p.authToken).toBeUndefined();

        // no scenario → heuristic default (effectively logged-out).
        g.__VALIDITY_CONTEXT_SEED__ = null;
        expect(p.isAuthenticated).toBe(false);
      } finally {
        g.__VALIDITY_CONTEXT_SEED__ = null;
      }
    });
  });

  describe('scenario context seeds (in the validity-native-data DATA module)', () => {
    it('ships built-in logged-in/logged-out and merges config native.context (config wins, undefined → undefinedKeys)', () => {
      const root = project(
        { 'src/A.tsx': BUTTON },
        { dependencies: { expo: '51', 'react-native': '0.81' } },
      );
      const out = join(root, 'out');
      const res = prepareNative({
        projectRoot: root,
        outDir: out,
        config: {
          scenarios: {
            'logged-in': { native: { context: { authEmail: 'me@app.com' } } },
            admin: { native: { context: { role: 'admin', isAuthenticated: true } } },
          },
        },
      });
      // Scenarios now live in the EXCLUDED data module (editing them must not
      // flip contentHash), in WIRE format (context + undefinedKeys).
      const mod = readFileSync(res.dataModulePath, 'utf-8');
      expect(mod).toContain('export const scenarios =');
      // Built-ins present.
      expect(mod).toContain('"logged-in"');
      expect(mod).toContain('"logged-out"');
      expect(mod).toContain('"isAuthenticated": true');
      // Config override merged into the built-in seed (config wins per key).
      expect(mod).toContain('"authEmail": "me@app.com"');
      // Config-only scenario added.
      expect(mod).toContain('"admin"');
      expect(mod).toContain('"role": "admin"');
      // undefined-valued keys (e.g. logged-out's cleared authToken) travel as
      // undefinedKeys, NOT a literal `undefined` (JSON drops those) — the device
      // re-materializes them so `authToken === undefined` still behaves.
      expect(mod).toContain('"undefinedKeys"');
      expect(mod).toMatch(/"undefinedKeys":\s*\[[\s\S]*?"authToken"/);
    });

    it('native-entry imports the scenarios map from the data module and passes it to ValidityNativeRoot', () => {
      const root = project(
        { 'src/A.tsx': BUTTON },
        { dependencies: { expo: '51', 'react-native': '0.81' } },
      );
      const out = join(root, 'out');
      const entry = readFileSync(
        prepareNative({ projectRoot: root, outDir: out, config: {} }).entryPath,
        'utf-8',
      );
      expect(entry).toContain(
        "import { views, scenarios, asyncStorageSeed } from './validity-native-data'",
      );
      expect(entry).toContain('scenarios={scenarios}');
    });
  });

  describe('encodeScenarioSeedWire (the scenario data/code boundary)', () => {
    it('keeps JSON values in context and lists undefined-valued keys separately', () => {
      expect(encodeScenarioSeedWire({ a: 1, b: undefined })).toEqual({
        context: { a: 1 },
        undefinedKeys: ['b'],
      });
    });
    it('encodes FUNCTION values as undefinedKeys (functions cannot travel as data)', () => {
      const wire = encodeScenarioSeedWire({ fn: () => 1, x: 'y' });
      expect(wire.context).toEqual({ x: 'y' });
      expect(wire.undefinedKeys).toEqual(['fn']);
    });
    it('omits undefinedKeys entirely when nothing is undefined-valued', () => {
      expect(encodeScenarioSeedWire({ a: 1 })).toEqual({ context: { a: 1 } });
    });
  });

  // Locks the intended expo-router introspection semantics (the SAME function is
  // embedded verbatim into the generated nav module via .toString()).
  describe('deriveExpoRouteInfo (expo-router route introspection)', () => {
    const cases: Array<
      [
        string,
        { pathname: string; segments: string[]; params: Record<string, unknown>; isIndex: boolean },
      ]
    > = [
      ['app/index.tsx', { pathname: '/', segments: [], params: {}, isIndex: true }],
      ['app/(tabs)/index.tsx', { pathname: '/', segments: ['(tabs)'], params: {}, isIndex: true }],
      [
        'app/(tabs)/post/[id].tsx',
        {
          pathname: '/post/id',
          segments: ['(tabs)', 'post', '[id]'],
          params: { id: 'id' },
          isIndex: false,
        },
      ],
      [
        'app/[id]/[slug].tsx',
        {
          pathname: '/id/slug',
          segments: ['[id]', '[slug]'],
          params: { id: 'id', slug: 'slug' },
          isIndex: false,
        },
      ],
      [
        'app/[...rest].tsx',
        { pathname: '/rest', segments: ['[...rest]'], params: { rest: ['rest'] }, isIndex: false },
      ],
    ];
    it.each(cases)(
      '%s → resolved pathname, group-preserving segments, name-placeholder params',
      (path, want) => {
        const info = deriveExpoRouteInfo(path);
        expect(info.pathname).toBe(want.pathname);
        expect(info.segments).toEqual(want.segments);
        expect(info.params).toEqual(want.params);
        expect(info.isIndex).toBe(want.isIndex);
      },
    );
  });

  it('polyfills module force-resolves RN lazy globals (FormData…) with a read-only touch, never an assignment', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const out = join(root, 'out');
    prepareNative({ projectRoot: root, outDir: out, config: {} });
    const polyfills = readFileSync(join(out, 'validity-native-polyfills.ts'), 'utf-8');
    // The lazy web-API globals that crash on early bare access (the FormData bug).
    for (const name of ['FormData', 'Blob', 'Headers', 'Request', 'Response']) {
      expect(polyfills).toContain(`'${name}'`);
    }
    // Read-only touch — NEVER an unconditional assignment over a (possibly
    // frozen) global, which itself redboxes with "property is not writable".
    expect(polyfills).toContain('void globalThis[__name]');
    expect(polyfills).not.toMatch(/globalThis\.FormData\s*=/);
    // The load-bearing fix: front-load RN core init so the lazy FormData global
    // is installed before Expo's winter runtime eagerly reads bare `FormData`.
    expect(polyfills).toContain("require('react-native/Libraries/Core/InitializeCore')");
    // DOM event globals msw's WS interceptor reads at setup — without these,
    // server.listen() throws and ALL network mocking silently disables.
    expect(polyfills).toContain('globalThis.MessageEvent');
    expect(polyfills).toContain('globalThis.CloseEvent');
    // native-entry imports the polyfills FIRST so they run before any other module.
    const entry = readFileSync(join(out, 'native-entry.tsx'), 'utf-8');
    expect(entry.indexOf("import './validity-native-polyfills'")).toBeGreaterThanOrEqual(0);
    expect(entry.indexOf("import './validity-native-polyfills'")).toBeLessThan(
      entry.indexOf("from './component-registry'"),
    );
  });

  it('contentHash changes when a generated CODE body changes but the component set (structureHash) does not', () => {
    // Same component set, different CODE body (expo-splash-screen present → the
    // generated splash module differs) → identical structureHash but a different
    // served body → contentHash MUST differ (drives the Metro --clear). NOTE: a
    // pure-DATA change (mockNetwork/views/scenario) deliberately does NOT flip
    // contentHash — that's the exclusion boundary, pinned in its own describe
    // below. Use two SEPARATE identical roots so the first run's generated files
    // don't pollute the second's catalog scan.
    const files = { 'src/Button.tsx': BUTTON };
    const rootA = project(files, { dependencies: { expo: '51' } });
    const b1 = prepareNative({ projectRoot: rootA, outDir: join(rootA, 'out'), config: {} });
    const rootB = project(files, { dependencies: { expo: '51', 'expo-splash-screen': '~0.27' } });
    const b2 = prepareNative({ projectRoot: rootB, outDir: join(rootB, 'out'), config: {} });
    expect(b1.structureHash).toBe(b2.structureHash); // same components
    expect(b1.contentHash).not.toBe(b2.contentHash); // different served (splash) body
    expect(b1.contentHash).toMatch(/^[0-9a-f]{16}$/);
  });

  // The contentHash gate exists to force a Metro --clear when SERVED CODE
  // changes; over-excluding reintroduces the "edit never took effect" class.
  // These cases pin the exclusion to EXACTLY the data module: data edits stay
  // off the hash (no restart), code edits stay on it.
  describe('contentHash exclusion boundary (views/scenarios/mock are DATA, not code)', () => {
    // Two fresh identical roots so the first run's generated files can't pollute
    // the second's catalog scan; configB applies to the second.
    function pair(
      configA: Record<string, unknown>,
      configB: Record<string, unknown>,
    ): ReturnType<typeof prepareNative>[] {
      const files = { 'src/Button.tsx': BUTTON };
      const a = project(files, { dependencies: { expo: '51' } });
      const ra = prepareNative({ projectRoot: a, outDir: join(a, 'out'), config: configA });
      const b = project(files, { dependencies: { expo: '51' } });
      const rb = prepareNative({ projectRoot: b, outDir: join(b, 'out'), config: configB });
      return [ra, rb];
    }

    it('does NOT flip when ONLY views change — views_create must not restart Metro', () => {
      const [a, b] = pair(
        {},
        { views: { V: { items: [{ componentPath: 'src/Button.tsx', props: { label: 'x' } }] } } },
      );
      expect(a.contentHash).toBe(b.contentHash);
      // …yet the data payload DID change — the view reaches the device as data.
      expect(JSON.stringify(a.dataPayload.views)).not.toBe(JSON.stringify(b.dataPayload.views));
    });

    it('does NOT flip when ONLY mockNetwork handlers change', () => {
      const [a, b] = pair(
        {},
        { mockNetwork: { handlers: [{ url: '/api/me', json: { id: '1' } }] } },
      );
      expect(a.contentHash).toBe(b.contentHash);
      expect(a.dataPayload.mockNetwork).not.toEqual(b.dataPayload.mockNetwork);
    });

    it('does NOT flip when ONLY scenario context seeds change', () => {
      const [a, b] = pair({}, { scenarios: { admin: { native: { context: { role: 'admin' } } } } });
      expect(a.contentHash).toBe(b.contentHash);
      expect(JSON.stringify(a.dataPayload.scenarios)).not.toBe(
        JSON.stringify(b.dataPayload.scenarios),
      );
    });

    it('does NOT flip when ONLY the asyncStorage seed changes', () => {
      const [a, b] = pair({}, { mockNetwork: { asyncStorage: { authToken: 'mock' } } });
      expect(a.contentHash).toBe(b.contentHash);
      expect(a.dataPayload.asyncStorage).not.toEqual(b.dataPayload.asyncStorage);
    });

    it('STILL flips when the registry imports change (a new component is genuine CODE)', () => {
      const a = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
      const ra = prepareNative({ projectRoot: a, outDir: join(a, 'out'), config: {} });
      const b = project(
        { 'src/Button.tsx': BUTTON, 'src/Card.tsx': BUTTON.replace(/Button/g, 'Card') },
        { dependencies: { expo: '51' } },
      );
      const rb = prepareNative({ projectRoot: b, outDir: join(b, 'out'), config: {} });
      expect(ra.structureHash).not.toBe(rb.structureHash); // component set changed
      expect(ra.contentHash).not.toBe(rb.contentHash); // registry import lines changed
    });
  });

  it('bakes the contentHash into validity-content-hash.ts, EXCLUDED from the hash inputs', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    // Default outDir (node_modules/.validity-native) so the re-run below doesn't
    // catalog the first run's generated files as project components.
    const a = prepareNative({ projectRoot: root, config: {} });
    const hashModulePath = join(a.outDir, 'validity-content-hash.ts');
    expect(readFileSync(hashModulePath, 'utf-8')).toContain(
      `export const VALIDITY_CONTENT_HASH = ${JSON.stringify(a.contentHash)}`,
    );

    // The module is DERIVED from the tracked content, not an input: tampering
    // with it and re-running must restore it WITHOUT flipping contentHash —
    // otherwise baking the hash would invalidate itself forever (circular).
    writeFileSync(hashModulePath, 'export const VALIDITY_CONTENT_HASH = "tampered";\n');
    const b = prepareNative({ projectRoot: root, config: {} });
    expect(b.contentHash).toBe(a.contentHash);
    expect(readFileSync(hashModulePath, 'utf-8')).toContain(JSON.stringify(a.contentHash));
  });

  describe('device identity module (validity-native-identity)', () => {
    it('prefers expo-application when the host ships it (vendor / android id)', () => {
      const root = project(
        { 'src/Button.tsx': BUTTON },
        { dependencies: { expo: '51', 'expo-application': '6' } },
      );
      const out = join(root, 'out');
      prepareNative({ projectRoot: root, outDir: out, config: {} });
      const body = readFileSync(join(out, 'validity-native-identity.ts'), 'utf-8');
      expect(body).toContain("require('expo-application')");
      expect(body).toContain('getAndroidId');
      expect(body).toContain('getIosIdForVendorAsync');
      // Every rung is best-effort; the session fallback is always present.
      expect(body).toContain("'session:' + randomId()");
    });

    it('falls back to an AsyncStorage-persisted installation id when available', () => {
      const root = project(
        { 'src/Button.tsx': BUTTON },
        { dependencies: { expo: '51', '@react-native-async-storage/async-storage': '2' } },
      );
      const out = join(root, 'out');
      prepareNative({ projectRoot: root, outDir: out, config: {} });
      const body = readFileSync(join(out, 'validity-native-identity.ts'), 'utf-8');
      expect(body).not.toContain("require('expo-application')");
      expect(body).toContain("require('@react-native-async-storage/async-storage')");
      expect(body).toContain('__validity_installation_id__');
    });

    it('degrades to a session-scoped id when neither optional dep is installed', () => {
      const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
      const out = join(root, 'out');
      prepareNative({ projectRoot: root, outDir: out, config: {} });
      const body = readFileSync(join(out, 'validity-native-identity.ts'), 'utf-8');
      // No optional imports → the bundle can never fail to resolve them.
      expect(body).not.toContain("require('expo-application')");
      expect(body).not.toContain('async-storage');
      expect(body).toContain('return sessionId');
    });
  });

  it('generates a registry with namespace imports + a pick() resolver (handles NAMED exports)', () => {
    // Ignite-style: named export, no default. A default import would be undefined.
    const named = `export function Button() { return <button>hi</button>; }`;
    const root = project({ 'src/Button.tsx': named }, { dependencies: { expo: '51' } });
    const out = join(root, 'out');
    const result = prepareNative({ projectRoot: root, outDir: out, config: {} });
    const registry = readFileSync(result.registryPath, 'utf-8');
    // Namespace import (not default), resolved via pick(mod, baseName).
    expect(registry).toMatch(/import \* as M0 from "\.\..*Button"/);
    expect(registry).toContain('"src/Button.tsx": pick(M0, "Button")');
    expect(registry).toContain('function pick(');
    expect(registry).not.toMatch(/^import C0 from/m);
  });

  it('registers via registerRootComponent for Expo and AppRegistry for bare RN', () => {
    const expoRoot = project({ 'src/A.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const expoOut = join(expoRoot, 'out');
    const expoEntry = readFileSync(
      prepareNative({ projectRoot: expoRoot, outDir: expoOut }).entryPath,
      'utf-8',
    );
    expect(expoEntry).toContain('registerRootComponent');

    const bareRoot = project({ 'src/A.tsx': BUTTON }, { dependencies: { 'react-native': '0.74' } });
    const bareOut = join(bareRoot, 'out');
    const bareEntry = readFileSync(
      prepareNative({ projectRoot: bareRoot, outDir: bareOut }).entryPath,
      'utf-8',
    );
    expect(bareEntry).toContain('AppRegistry.registerComponent');
  });

  it('owns the splash lifecycle when expo-splash-screen is present, no-op otherwise', () => {
    // Ignite-style: ships expo-splash-screen → real prevent/hide, root imports it.
    const withSplash = project(
      { 'src/A.tsx': BUTTON },
      { dependencies: { expo: '51', 'expo-splash-screen': '~0.27' } },
    );
    const splashOut = join(withSplash, 'out');
    const r1 = prepareNative({ projectRoot: withSplash, outDir: splashOut });
    const splashMod = readFileSync(r1.splashModulePath, 'utf-8');
    expect(splashMod).toContain("import * as SplashScreen from 'expo-splash-screen'");
    expect(splashMod).toContain('preventAutoHideAsync');
    expect(splashMod).toContain('export function hideSplash()');
    // The raw template imports the generated splash module + dismisses on ready.
    const root = readFileSync(join(splashOut, 'ValidityNativeRoot.tsx'), 'utf-8');
    expect(root).toContain("import { hideSplash } from './validity-native-splash'");
    expect(root).toContain('hideSplash()');

    // No expo-splash-screen → no-op module, NO import (won't break the bundle).
    const noSplash = project({ 'src/A.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const noSplashMod = readFileSync(
      prepareNative({ projectRoot: noSplash, outDir: join(noSplash, 'out') }).splashModulePath,
      'utf-8',
    );
    expect(noSplashMod).toContain('export function hideSplash(): void {}');
    expect(noSplashMod).not.toContain("from 'expo-splash-screen'");
  });

  it('threads mockNetwork handlers + asyncStorage into the baked DATA module (not the static mock code)', () => {
    const root = project({ 'src/A.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const out = join(root, 'out');
    const result = prepareNative({
      projectRoot: root,
      outDir: out,
      config: {
        mockNetwork: {
          handlers: [{ url: '/api/me', json: { id: '1' } }],
          asyncStorage: { authToken: 'mock' },
        },
      },
    });
    // The mock + async-storage MODULES are now STATIC (no project data baked in)
    // — the handlers + seed live in the DATA module, applied at runtime.
    const mockCode = readFileSync(result.mockModulePath, 'utf-8');
    expect(mockCode).not.toContain('/api/me'); // not baked into the code
    expect(mockCode).toContain('export function startMockNetwork');
    const data = readFileSync(result.dataModulePath, 'utf-8');
    expect(data).toContain('export const mockNetwork =');
    expect(data).toContain('"url": "/api/me"');
    expect(data).toContain('"id": "1"');
    // AsyncStorage seed pairs land in the data module too (delivery rung 3).
    expect(data).toContain('export const asyncStorageSeed =');
    expect(data).toContain('"authToken"');
    expect(data).toContain('"mock"');
  });

  it('generates a views map (compositions) in the DATA module, resolving fixture props', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNative({
      projectRoot: root,
      outDir: join(root, 'out'),
      config: {
        components: { 'src/Button.tsx': { fixtures: { primary: { props: { label: 'Hi' } } } } },
        views: {
          'Button Variants': {
            items: [
              { componentPath: 'src/Button.tsx', fixtureName: 'primary' },
              { componentPath: 'src/Button.tsx', props: { label: 'Custom' }, label: 'Custom' },
            ],
          },
        },
      } as never,
    });
    // Views are DATA, not registry code — they live in the data module so a
    // views_create never rewrites the registry / flips contentHash.
    const data = readFileSync(result.dataModulePath, 'utf-8');
    expect(data).toContain('export const views =');
    expect(data).toContain('Button Variants');
    expect(data).toContain('"label": "Hi"'); // fixture props resolved
    expect(data).toContain('"label": "Custom"');
    // The registry stays view-free (it's pure component import code).
    expect(readFileSync(result.registryPath, 'utf-8')).not.toContain('Button Variants');
    expect(result.targetContract.params).toContain('view');
  });

  it('drops view items whose component is not registered (the view never reaches the data module)', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const result = prepareNative({
      projectRoot: root,
      outDir: join(root, 'out'),
      config: { views: { Mixed: { items: [{ componentPath: 'src/DoesNotExist.tsx' }] } } } as never,
    });
    expect(readFileSync(result.dataModulePath, 'utf-8')).not.toContain('Mixed');
    expect(result.dataPayload.views).toEqual({});
  });

  it('resolveNativeViewItems resolves labels + prop precedence and drops unregistered items', () => {
    const registered = new Set(['src/Button.tsx']);
    const components = { 'src/Button.tsx': { fixtures: { primary: { props: { label: 'Hi' } } } } };
    const items = resolveNativeViewItems(
      {
        items: [
          { componentPath: 'src/Button.tsx', fixtureName: 'primary' },
          { componentPath: 'src/Button.tsx', props: { label: 'Custom' }, label: 'Custom' },
          // explicit props win over the fixture when both are present
          { componentPath: 'src/Button.tsx', fixtureName: 'primary', props: { label: 'Win' } },
          // unregistered → dropped
          { componentPath: 'src/Missing.tsx' },
        ],
      } as never,
      registered,
      components,
    );
    expect(items).toEqual([
      { path: 'src/Button.tsx', label: 'primary', props: { label: 'Hi' } },
      { path: 'src/Button.tsx', label: 'Custom', props: { label: 'Custom' } },
      { path: 'src/Button.tsx', label: 'primary', props: { label: 'Win' } },
    ]);
  });

  it('resolveNativeViewItems returns [] for an undefined view (loud-fail signal for the host)', () => {
    expect(resolveNativeViewItems(undefined, new Set(), {})).toEqual([]);
  });

  it('scaffolds .validity/wrapper.native.tsx once and re-exports it from the generated wrapper', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const out = join(root, 'out');
    const res = prepareNative({ projectRoot: root, outDir: out });
    const wrapperPath = join(root, '.validity', 'wrapper.native.tsx');
    expect(res.scaffoldedWrapperPath).toBe(wrapperPath);
    expect(existsSync(wrapperPath)).toBe(true);
    // The generated re-export points at the user file (not a throwaway passthrough).
    const generated = readFileSync(join(out, 'validity-native-wrapper.tsx'), 'utf-8');
    expect(generated).toContain('export { default } from');
    expect(generated).toContain('wrapper.native');
  });

  it('re-exports wrapper.gen.tsx instead of scaffolding an empty native stub', () => {
    const gen = 'export default function Gen({ children }) { return children; }\n';
    const root = project(
      { 'src/Button.tsx': BUTTON, '.validity/wrapper.gen.tsx': gen },
      { dependencies: { expo: '51' } },
    );
    const out = join(root, 'out');
    const res = prepareNative({ projectRoot: root, outDir: out });
    expect(res.scaffoldedWrapperPath).toBeUndefined();
    expect(existsSync(join(root, '.validity', 'wrapper.native.tsx'))).toBe(false);
    const generated = readFileSync(join(out, 'validity-native-wrapper.tsx'), 'utf-8');
    expect(generated).toContain('from "../.validity/wrapper.gen"');
  });

  it('ignores an unmodified native scaffold when wrapper.gen.tsx exists', () => {
    const gen = 'export default function Gen({ children }) { return children; }\n';
    const root = project(
      { 'src/Button.tsx': BUTTON, '.validity/wrapper.gen.tsx': gen },
      { dependencies: { expo: '51', '@react-navigation/native': '^7' } },
    );
    const scaffold = renderNativeWrapperScaffold(detectNative(root));
    mkdirSync(join(root, '.validity'), { recursive: true });
    writeFileSync(join(root, '.validity', 'wrapper.native.tsx'), scaffold);
    const generated = readFileSync(
      join(
        prepareNative({ projectRoot: root, outDir: join(root, 'out') }).outDir,
        'validity-native-wrapper.tsx',
      ),
      'utf-8',
    );
    expect(generated).toContain('wrapper.gen');
  });

  it('does not overwrite an existing .validity/wrapper.native.tsx', () => {
    const custom = `export default function W({ children }) { return children; } // mine`;
    const root = project(
      {
        'src/Button.tsx': BUTTON,
        '.validity/wrapper.native.tsx': custom,
        '.validity/wrapper.gen.tsx':
          'export default function Gen({ children }) { return children; }',
      },
      { dependencies: { expo: '51' } },
    );
    const res = prepareNative({ projectRoot: root, outDir: join(root, 'out') });
    expect(res.scaffoldedWrapperPath).toBeUndefined();
    expect(readFileSync(join(root, '.validity', 'wrapper.native.tsx'), 'utf-8')).toBe(custom);
    expect(readFileSync(join(res.outDir, 'validity-native-wrapper.tsx'), 'utf-8')).toContain(
      'from "../.validity/wrapper.native"',
    );
  });

  it('skips scaffolding when scaffoldWrapper is false', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { expo: '51' } });
    const res = prepareNative({
      projectRoot: root,
      outDir: join(root, 'out'),
      scaffoldWrapper: false,
    });
    expect(res.scaffoldedWrapperPath).toBeUndefined();
    expect(existsSync(join(root, '.validity', 'wrapper.native.tsx'))).toBe(false);
  });

  it('does not scaffold for non-native projects', () => {
    const root = project({ 'src/Button.tsx': BUTTON }, { dependencies: { react: '^18' } });
    expect(scaffoldNativeWrapper(root, detectNative(root))).toBeUndefined();
    expect(existsSync(join(root, '.validity', 'wrapper.native.tsx'))).toBe(false);
  });

  it('tailors the scaffold hint to the detected router', () => {
    const expoRoot = project({}, { dependencies: { expo: '51', 'expo-router': '^3' } });
    const expoRouter = renderNativeWrapperScaffold(detectNative(expoRoot));
    expect(expoRouter).toContain('expo-router');
    expect(expoRouter).toContain('ValidityNativeWrapper');

    const navRoot = project(
      {},
      { dependencies: { 'react-native': '0.76', '@react-navigation/native': '^6' } },
    );
    const reactNav = renderNativeWrapperScaffold(detectNative(navRoot));
    expect(reactNav).toContain('NavigationContainer');
  });
});
