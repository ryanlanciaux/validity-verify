/**
 * Vite alias map + optimizeDeps tuning for Expo Web rendering.
 *
 * Expo's web target ships with `react-native-web` already in the
 * dependency graph. When Validity's sandbox imports a user component
 * that does `import { View, Text } from 'react-native'`, Vite must
 * rewrite the bare `react-native` specifier to `react-native-web`
 * (which exports DOM-friendly versions of the same primitives).
 *
 * Adjacent ecosystem packages (`react-native-reanimated`,
 * `react-native-gesture-handler`, `react-native-svg`) also need
 * web-friendly substitutes — either the package's own `lib/web` entry,
 * or a passthrough stub when no web build exists. We probe the user's
 * `node_modules` and pick the best available shim for each.
 *
 * **What's out of scope (explicitly):**
 *   - Reanimated worklets (the package mocks them on web; visual
 *     animations are NOT exercised).
 *   - Native modules (anything under `react-native-*` that depends on
 *     a NativeModules.<X> binding will throw at runtime; Validity
 *     surfaces that as a render error).
 *   - `Platform.OS === 'ios'/'android'` conditional code paths (RN-Web
 *     reports `Platform.OS === 'web'`).
 *
 * Phase 2 will exercise those via the real device runner.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Alias } from 'vite';

export interface ExpoWebViteOverrides {
  alias: Alias[];
  /** Bare specifiers Vite's optimizer should pre-bundle for the sandbox. */
  optimizeDepsInclude: string[];
  /** Bare specifiers Vite's optimizer should leave alone. */
  optimizeDepsExclude: string[];
}

/**
 * Resolve a bare module specifier (e.g. `'react-native-web'`) against
 * the user's project root. Returns the package directory (the path to
 * the directory containing the package's `package.json`) or undefined.
 *
 * We use `createRequire(projectRoot)` so resolution honors pnpm's
 * symlinked layout — `import.meta.resolve` would resolve against the
 * sandbox's own location, which sits in `node_modules/.validity/` and
 * has no view of the user's deps.
 */
function resolvePackageDir(projectRoot: string, specifier: string): string | undefined {
  try {
    const requireFn = createRequire(resolve(projectRoot, 'package.json'));
    const entry = requireFn.resolve(specifier);
    // Walk up until we find the package.json that owns this file.
    let cur = dirname(entry);
    for (let i = 0; i < 8; i++) {
      if (existsSync(resolve(cur, 'package.json'))) {
        // Guard against finding a transitive package.json — keep
        // walking only if the basename matches a scoped or simple name.
        const seg = cur.split('/').pop() ?? '';
        const parent = cur.split('/').slice(-2, -1)[0] ?? '';
        // Match the bare spec or scope/name.
        if (seg === specifier || `${parent}/${seg}` === specifier) {
          return cur;
        }
        // Fall back to first package.json we find — covers cases
        // where the spec is a deep import.
        return cur;
      }
      const next = dirname(cur);
      if (next === cur) break;
      cur = next;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locate the on-disk web entry for `react-native-svg`. The package
 * historically ships a separate CommonJS build under
 * `lib/commonjs/web/index.js`; newer versions move it. We probe a few
 * known paths and return the first that exists, or undefined to fall
 * back to a passthrough stub.
 */
function findReactNativeSvgWebEntry(projectRoot: string): string | undefined {
  const pkgDir = resolvePackageDir(projectRoot, 'react-native-svg');
  if (!pkgDir) return undefined;
  const candidates = [
    resolve(pkgDir, 'lib/commonjs/web/index.js'),
    resolve(pkgDir, 'lib/module/web/index.js'),
    resolve(pkgDir, 'lib/web/index.js'),
    resolve(pkgDir, 'web/index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/**
 * Path to the passthrough stub shipped with @validity.ai/verify-web.
 * Resolved via `createRequire` so the same lookup works in dev (TS
 * source under packages/verify-web/src/stubs/) and in the published
 * bundle (where stubs/ sits next to cli.js).
 */
function locateStub(
  stubName:
    | 'rn-passthrough.js'
    | 'rn-codegen.js'
    | 'rn-codegen-commands.js'
    | 'rn-get-dev-server.js',
): string | undefined {
  // Walk up from this file. In dev: packages/verify-web/src/* — stubs
  // would live at packages/verify-web/stubs/. In published bundles the
  // installer copies stubs/ alongside cli.js.
  try {
    const here = new URL(import.meta.url).pathname;
    const candidates = [
      resolve(dirname(here), '..', 'stubs', stubName),
      resolve(dirname(here), 'stubs', stubName),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the Vite alias + optimizeDeps overrides Validity adds when the
 * project is an Expo app. Caller merges these on top of the standard
 * web sandbox overrides.
 *
 * Returns the diagnostic info as a side-channel: `installed` enumerates
 * which RN ecosystem packages we found, so the sandbox can warn the
 * user (or the agent) about features that won't be exercised.
 */
export function buildExpoWebViteOverrides(projectRoot: string): ExpoWebViteOverrides {
  const alias: Alias[] = [];

  // Core swap: the bare `react-native` package entry goes to react-native-web.
  //
  // EXACT match only (regex-anchored), and the replacement is the ABSOLUTE
  // package dir. Two bugs this avoids:
  //   1. A bare string find (`'react-native'`) is a *prefix* match in both
  //      Vite's resolver and esbuild's dep optimizer, so it also rewrites deep
  //      imports like `react-native/Libraries/Utilities/codegenNativeComponent`
  //      → `react-native-web/Libraries/...`. react-native-web ships no
  //      `Libraries/` tree (only `dist/`), so that path doesn't exist and the
  //      esbuild pre-bundle of any dep pulling such a spec (e.g.
  //      react-native-safe-area-context's web build) hard-fails. Deep
  //      `react-native/*` specifiers must resolve to the real react-native
  //      package (where they exist) — which is exactly what Expo's Metro web
  //      resolver does.
  //   2. A bare-specifier replacement ('react-native-web') is not absolute, so
  //      esbuild's dep optimizer can't resolve it and warns/fails. Aliasing to
  //      the resolved package dir keeps the optimizer happy.
  const rnwDir = resolvePackageDir(projectRoot, 'react-native-web');
  if (rnwDir) {
    alias.push({ find: /^react-native$/, replacement: rnwDir });
  }

  // Fabric codegen utilities → web stubs. RN web libraries (react-native-
  // safe-area-context, etc.) import these deep `react-native/Libraries/...`
  // specifiers from their generated native specs even in their web build. With
  // the exact-match `react-native` alias above, these now resolve to the REAL
  // (Flow-typed) react-native source, which esbuild can't parse and which
  // cascades into RN core. Redirect them to passthrough stubs so the bundle
  // builds; the native views/commands they describe are never instantiated on
  // web. (These must come AFTER the `^react-native$` exact alias — Vite matches
  // array order, and being more specific they wouldn't be shadowed anyway.)
  const codegenComponentStub = locateStub('rn-codegen.js');
  if (codegenComponentStub) {
    alias.push({
      find: 'react-native/Libraries/Utilities/codegenNativeComponent',
      replacement: codegenComponentStub,
    });
  }
  const codegenCommandsStub = locateStub('rn-codegen-commands.js');
  if (codegenCommandsStub) {
    alias.push({
      find: 'react-native/Libraries/Utilities/codegenNativeCommands',
      replacement: codegenCommandsStub,
    });
  }

  // Dev-server locator → web stub. `react-native/Libraries/Core/Devtools/
  // getDevServer` is reachable transitively from RN dev/debug paths even in a
  // web graph (the exact-match `react-native` alias above does NOT cover this
  // deep specifier). The original parse concern (Flow-typed RN source esbuild
  // couldn't handle) is subsumed by the flow-strip plugin, but the alias is
  // still load-bearing: the real module imports NativeSourceCode, which calls
  // TurboModuleRegistry.getEnforcing('SourceCode') at module scope and throws
  // on web. It's a dev-only Metro-URL helper with no meaning in a one-shot web
  // render, so redirect it to a stub that returns the expected DevServerInfo
  // shape.
  const getDevServerStub = locateStub('rn-get-dev-server.js');
  if (getDevServerStub) {
    alias.push({
      find: 'react-native/Libraries/Core/Devtools/getDevServer',
      replacement: getDevServerStub,
    });
  }

  // Reanimated: use the library's REAL compiled web build (its package
  // main/module resolves naturally from the bare specifier — no alias). The
  // old approach aliased to the `/mock` Jest entry, but that stub omits real
  // exports (`Easing`, `interpolate`, …) so any component that merely IMPORTS
  // one failed to load. The real build works on web because (a) it's forced
  // into the dep optimizer (see optimizeDepsInclude below) so its inline
  // `require(...)` interop is converted to ESM, and (b) the flow-strip esbuild
  // plugin (wired in server.ts for expo-web) makes its transitive Flow-typed
  // `react-native/**` core parse. So: no reanimated alias here.

  // Gesture handler: no web mock ships, so we always route to the stub
  // when the package is in the dep graph. Components that use
  // `<GestureHandlerRootView>` etc. will render as a passthrough <View>.
  if (resolvePackageDir(projectRoot, 'react-native-gesture-handler')) {
    const stub = locateStub('rn-passthrough.js');
    if (stub) {
      alias.push({ find: 'react-native-gesture-handler', replacement: stub });
    }
  }

  // Keyboard controller: its `KeyboardAwareScrollView` / keyboard hooks call
  // reanimated's worklet-only APIs (`useAnimatedScrollHandler` → `useHandler`),
  // which throw "Passed a function that is not a worklet" unless the reanimated
  // Babel worklet plugin ran — and Validity's esbuild sandbox doesn't run it.
  // (Under the old reanimated `/mock` alias those calls were no-ops, so this
  // only surfaced once we switched to the real reanimated build.) It has no
  // meaningful web render anyway — a keyboard-aware scroll container is just a
  // scroll container on web — so route the whole package to the passthrough
  // stub when present, mirroring gesture-handler. Screens that wrap content in
  // `<KeyboardAwareScrollView>` (Ignite's `<Screen>`) then render their content
  // as a passthrough container instead of crashing.
  if (resolvePackageDir(projectRoot, 'react-native-keyboard-controller')) {
    const stub = locateStub('rn-passthrough.js');
    if (stub) {
      alias.push({ find: 'react-native-keyboard-controller', replacement: stub });
    }
  }

  // Reactotron: a dev-only debugging tool. Its react-native plugin reaches
  // deep into RN core (LogBox, AppContainer, Core/Devtools/*) — Flow-typed RN
  // source esbuild can't parse — and it has no purpose in a one-shot web
  // render. Route the whole package to the passthrough stub when present.
  if (resolvePackageDir(projectRoot, 'reactotron-react-native')) {
    const stub = locateStub('rn-passthrough.js');
    if (stub) {
      alias.push({ find: 'reactotron-react-native', replacement: stub });
    }
  }

  // SVG: prefer the package's own web build if present; otherwise stub.
  const svgWeb = findReactNativeSvgWebEntry(projectRoot);
  if (svgWeb) {
    alias.push({ find: 'react-native-svg', replacement: svgWeb });
  } else if (resolvePackageDir(projectRoot, 'react-native-svg')) {
    const stub = locateStub('rn-passthrough.js');
    if (stub) {
      alias.push({ find: 'react-native-svg', replacement: stub });
    }
  }

  return {
    alias,
    // Force-prebundle reanimated's real web build alongside react-native-web:
    // the optimizer converts its inline CommonJS `require(...)` to ESM (else
    // "require is not defined" at runtime) and pulls its transitive Flow-typed
    // `react-native/**` core through the flow-strip esbuild plugin.
    optimizeDepsInclude: ['react-native-web', 'react-native-reanimated'],
    // Our passthrough stubs do their own work — keep the optimizer out. (Note:
    // react-native-reanimated is deliberately NOT excluded anymore; it must be
    // pre-bundled, see optimizeDepsInclude above.)
    optimizeDepsExclude: ['react-native-gesture-handler', 'react-native-svg'],
  };
}
