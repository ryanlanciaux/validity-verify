/**
 * Provider-tree cloner for `.validity/wrapper.gen.tsx`.
 *
 * Given a project root, parse the entry file (src/main.tsx and friends)
 * into a Babel AST, find the React mount call (createRoot.render /
 * hydrateRoot / ReactDOM.render / vite-react-ssg ViteReactSSG), pick the
 * "App element" inside the mounted JSX tree, splice {children} in its
 * place, hoist the imports + top-level consts the rewritten tree
 * references, apply substitution rules (BrowserRouter→MemoryRouter,
 * RouterProvider strip, etc.), and emit the result via @babel/generator.
 *
 * The output is a complete `.validity/wrapper.gen.tsx` source string,
 * including the marker header used by the drift-detection layer to tell
 * "Validity owns this file" from "user has edited it."
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import { readTsconfigPaths, resolveImportSpecifier } from './component-usage.js';
import { detectProviderSignals } from './wrapper-fidelity.js';
import { appManifestEntryFile } from './app-manifest.js';

const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse;
const generate = (_generate as unknown as { default: typeof _generate }).default ?? _generate;

/**
 * Files we look for as the user's React mount entry. Order matters: the
 * first existing match wins. SSG/SSR-specific entries are listed
 * alongside the canonical Vite + React ones because they share the same
 * mount pattern (one createRoot/hydrateRoot/ViteReactSSG call) and
 * Validity treats them identically.
 *
 * Expo entries follow the Vite candidates: `App.tsx` is the classic
 * Expo bare entry, and `app/_layout.tsx` is the Expo Router 50+ root.
 * Both use `registerRootComponent` (Vite/web mount) or the `_layout`
 * default-export pattern (Expo Router) — `findMountCall` matches both.
 */
export const ENTRY_CANDIDATES = [
  'src/main.tsx',
  'src/main.jsx',
  'src/main.ssr.tsx',
  'src/index.tsx',
  'src/index.jsx',
  'src/entry-client.tsx',
  'src/entry.tsx',
  'src/main.ts',
  'app/main.tsx',
  'app/index.tsx',
  // Expo bare / Expo Router entries — registerRootComponent or
  // export-default RootLayout. See findMountCall for the patterns.
  'App.tsx',
  'App.jsx',
  'app/_layout.tsx',
  'app/_layout.jsx',
  // Bare React Native / Ignite entries — the app registers from a root
  // index file (package.json `main: "index.tsx"`). Listed LAST so a web
  // project's src/main.tsx is never shadowed by a root index config file.
  'index.tsx',
  'index.jsx',
  'index.ts',
  'index.js',
];

/** Options for {@link findEntryFile}. */
export interface FindEntryFileOptions {
  /**
   * Consult `.validity/app-manifest.json` first. Default `true`.
   *
   * Mirrors `ValidityConfig.web.useAppManifest`. Callers that have the user's
   * config in hand should thread it through; the ones that don't (shape
   * signature, auto-mock) get the default, which is correct because the
   * manifest only exists at all if the user installed the plugin — installing
   * it IS the opt-in.
   */
  useAppManifest?: boolean;
}

export function findEntryFile(
  projectRoot: string,
  options: FindEntryFileOptions = {},
): string | undefined {
  // AUTHORITATIVE FIRST. The candidate walk below is a heuristic over 17
  // conventional filenames; `index.html`'s `<script type="module" src>` is the
  // app's actual answer. When @validity.ai/verify-plugin-vite has recorded it — and the
  // file still exists, which appManifestEntryFile verifies — prefer it over
  // both package.json `main` and the candidate list. An app with a
  // non-conventional entry (`src/bootstrap/client.tsx`) goes from
  // "no-entry-file" to correct.
  if (options.useAppManifest !== false) {
    const fromManifest = appManifestEntryFile(projectRoot);
    if (fromManifest) return fromManifest;
  }
  // package.json `main` naming a project-relative SOURCE file wins over the
  // static candidate list (bare React Native / Ignite: `"main": "index.tsx"`)
  // — but ONLY when that file actually contains a React mount
  // (registerRootComponent / AppRegistry / createRoot / default-export JSX;
  // see findMountCall). `main` frequently names something that is NOT the
  // React entry — Electron's main process (`"main": "dist-electron/main.js"`),
  // a fullstack server (`"main": "server.js"`), a publish-from-source barrel
  // (`"main": "src/index.ts"`) — and none of those may shadow src/main.tsx.
  // Node-module-style mains (`expo/AppEntry`, `expo-router/entry`) have no
  // source extension and never pass packageJsonMainEntry's checks.
  const pkgMain = packageJsonMainEntry(projectRoot);
  if (pkgMain && sourceFileHasMount(resolve(projectRoot, pkgMain))) return pkgMain;
  for (const candidate of ENTRY_CANDIDATES) {
    const abs = resolve(projectRoot, candidate);
    if (existsSync(abs)) return candidate;
  }
  // Last resort: a source-file `main` that failed the mount gate still names
  // a concrete file for generateWrapperSource to report against (fallback
  // `no-mount-call`), which is more actionable than a bare `no-entry-file`.
  return pkgMain;
}

/**
 * First path segments that are build outputs, not hand-written source:
 * `dist`, `build`, `out`, `output`, `release` plus suffixed variants
 * (`dist-electron`, `build_artifacts`, `out-tsc`) and any dot-dir
 * (`.next`, `.output`). node_modules is rejected at ANY depth separately.
 */
const NON_SOURCE_MAIN_RE = /^(?:\.|(?:dist|build|out|output|release)(?:[-._]|$))/;

function packageJsonMainEntry(projectRoot: string): string | undefined {
  let main: unknown;
  try {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf-8')) as {
      main?: unknown;
    };
    main = pkg.main;
  } catch {
    return undefined;
  }
  if (typeof main !== 'string' || main.length === 0) return undefined;
  if (!/\.(tsx|ts|jsx|js)$/.test(main)) return undefined;
  const abs = resolve(projectRoot, main);
  const rel = relative(projectRoot, abs).replaceAll('\\', '/');
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined;
  const segments = rel.split('/');
  if (segments.includes('node_modules')) return undefined;
  if (NON_SOURCE_MAIN_RE.test(segments[0]!)) return undefined;
  return existsSync(abs) ? rel : undefined;
}

/**
 * Hand-written entries are small; anything bigger is almost certainly a
 * bundle and is not worth parsing for the package.json-main mount gate.
 */
const MAX_MOUNT_PROBE_BYTES = 512 * 1024;

/**
 * True when the file parses cleanly and contains a recognizable React mount
 * (any findMountCall shape, including the default-export-JSX fallback).
 * Gates package.json `main` before it may shadow ENTRY_CANDIDATES.
 */
function sourceFileHasMount(absPath: string): boolean {
  let source: string;
  try {
    if (statSync(absPath).size > MAX_MOUNT_PROBE_BYTES) return false;
    source = readFileSync(absPath, 'utf-8');
  } catch {
    return false;
  }
  try {
    const ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx', 'topLevelAwait'],
      errorRecovery: true,
    });
    if ((ast.errors ?? []).length > 0) return false;
    return findMountCall(ast) !== null;
  } catch {
    return false;
  }
}

export interface GenerateWrapperResult {
  ok: boolean;
  /** Generated source. Always set — falls back to passthrough on failure. */
  source: string;
  /** Reason a fallback was used. Undefined when ok = true. */
  fallbackReason?: string;
  /** Project-relative entry path the cloner used, if any. */
  entryFile?: string;
  /**
   * When the entry mounts an IMPORTED component (Ignite's
   * `registerRootComponent(App)` with `App` from `@/app`), the
   * project-relative path of the module the provider tree was actually
   * cloned from (e.g. 'app/app.tsx'). Undefined when the entry mounts JSX
   * directly or generation fell back.
   */
  resolvedAppModule?: string;
  /**
   * Post-rewrite provider chain the generated wrapper is supposed to contain
   * (outermost first, e.g. ['StrictMode','QueryClientProvider','MemoryRouter']).
   * Empty when ok=false (fallback) or when the entry mounts bare (<App/> only).
   * The wrapper-fidelity analyzer compares this against the wrapper that
   * actually renders.
   */
  expectedProviderChain: string[];
  /**
   * True when a `<RouterProvider>` was replaced by `<MemoryRouter>`, discarding
   * the route-config subtree unanalyzed. `expectedProviderChain` is then
   * known-incomplete (providers mounted inside route elements are invisible to
   * it), so wrapper-fidelity must not report `verified` off it — it caps at
   * `degraded`. See JsxRewriteOutcome.routerSubtreeDiscarded.
   */
  routerSubtreeDiscarded?: boolean;
  /**
   * Project-relative path of the module the JSX mount's splice target was
   * imported from (`<App/>` → src/App.tsx), when it resolved. Present whether
   * or not deep cloning succeeded.
   */
  spliceTargetModule?: string;
  /**
   * Provider signals regex-detected inside `spliceTargetModule`. Fed to
   * wrapper-fidelity: a wrapper (gen + user) that does not reproduce every
   * detected signal must not read `verified` — this is what closes the
   * "providers inside App.tsx are invisible, fidelity says verified, runtime
   * throws missing-provider" hole. Deep cloning normally satisfies them; the
   * fold names whatever is left.
   */
  spliceTargetProviderSignals?: string[];
}

export interface GenerateWrapperOptions {
  projectRoot: string;
  /** Override the entry file lookup. Used by tests. */
  entryFileOverride?: string;
  /** Where wrapper.gen.tsx will be written. Defaults to `<projectRoot>/.validity/wrapper.gen.tsx`. */
  wrapperOutPath?: string;
  /** Validity version embedded in the marker so version bumps force regen. */
  validityVersion?: string;
  /**
   * If true, the generated wrapper imports `./wrapper.user` (default
   * export expected) and wraps `<UserWrapper>{children}</UserWrapper>`
   * at the splice point. Lets users layer custom providers Validity
   * couldn't infer without ever editing the generated file.
   */
  composeWithUserWrapper?: boolean;
}

/**
 * Public entry point. Always returns a usable `source` (passthrough
 * fallback if anything goes wrong); `ok` and `fallbackReason` indicate
 * whether the cloning actually succeeded so callers can surface that to
 * the user.
 */
export function generateWrapperSource(opts: GenerateWrapperOptions): GenerateWrapperResult {
  const { projectRoot } = opts;
  const wrapperOutPath = opts.wrapperOutPath ?? resolve(projectRoot, '.validity/wrapper.gen.tsx');
  const validityVersion = opts.validityVersion ?? '0.0.1';

  const entryFile = opts.entryFileOverride ?? findEntryFile(projectRoot);
  if (!entryFile) {
    return {
      ok: false,
      source: passthroughTemplate({
        validityVersion,
        composeWithUserWrapper: opts.composeWithUserWrapper === true,
        reason: 'no entry file found in src/main.tsx and friends',
      }),
      fallbackReason: 'no-entry-file',
      expectedProviderChain: [],
    };
  }

  let entryAbs = isAbsolute(entryFile) ? entryFile : resolve(projectRoot, entryFile);
  let source: string;
  try {
    source = readFileSync(entryAbs, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      source: passthroughTemplate({
        validityVersion,
        composeWithUserWrapper: opts.composeWithUserWrapper === true,
        reason: `could not read ${entryFile}: ${(err as Error).message}`,
      }),
      fallbackReason: 'entry-read-failed',
      entryFile,
      expectedProviderChain: [],
    };
  }

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx', 'topLevelAwait'],
      errorRecovery: true,
    });
  } catch (err) {
    return {
      ok: false,
      source: passthroughTemplate({
        validityVersion,
        composeWithUserWrapper: opts.composeWithUserWrapper === true,
        reason: `failed to parse ${entryFile}: ${(err as Error).message}`,
      }),
      fallbackReason: 'parse-error',
      entryFile,
      expectedProviderChain: [],
    };
  }
  const parseErrors = ast.errors ?? [];
  if (parseErrors.length > 0) {
    return {
      ok: false,
      source: passthroughTemplate({
        validityVersion,
        composeWithUserWrapper: opts.composeWithUserWrapper === true,
        reason: `${entryFile} has parse errors (${parseErrors.length}); cannot clone provider tree`,
      }),
      fallbackReason: 'parse-error',
      entryFile,
      expectedProviderChain: [],
    };
  }

  const mount = findMountCall(ast);
  if (!mount) {
    return {
      ok: false,
      source: passthroughTemplate({
        validityVersion,
        composeWithUserWrapper: opts.composeWithUserWrapper === true,
        reason: `no React mount call found in ${entryFile} (looked for createRoot.render / hydrateRoot / ReactDOM.render / ViteReactSSG / registerRootComponent)`,
      }),
      fallbackReason: 'no-mount-call',
      entryFile,
      expectedProviderChain: [],
    };
  }

  // The entry mounts an IMPORTED component (Ignite: `registerRootComponent(App)`
  // with `App` from '@/app'). Resolve the import to its module, extract the
  // component's returned JSX, and clone from THAT module — entryAbs/ast/source
  // switch to it so import collection, hoisting, and relative-path rewrites
  // all run against the file that actually declares the provider tree.
  let jsxArg: NodePath<t.JSXElement | t.JSXFragment>;
  let resolvedAppModule: string | undefined;
  if ('importSource' in mount) {
    const resolved = resolveMountIndirection(projectRoot, entryAbs, mount);
    if (!resolved) {
      return {
        ok: false,
        source: passthroughTemplate({
          validityVersion,
          composeWithUserWrapper: opts.composeWithUserWrapper === true,
          reason: `entry mounts '${mount.importedName}' imported from '${mount.importSource}', which could not be resolved to a component with a JSX tree`,
        }),
        fallbackReason: `mount-target-unresolved: '${mount.importSource}'`,
        entryFile,
        expectedProviderChain: [],
      };
    }
    entryAbs = resolved.moduleAbs;
    ast = resolved.ast;
    source = resolved.source;
    jsxArg = resolved.jsxArg;
    resolvedAppModule = relative(projectRoot, resolved.moduleAbs).replaceAll('\\', '/');
  } else {
    jsxArg = mount.jsxArg;
  }

  // Detect the "Router lives inside App.tsx" pattern: the entry file
  // doesn't import any react-router-dom Router primitive, but a relative
  // default-imported file (typically App.tsx) does. In that case the
  // splice point would land *outside* any Router context, so any
  // useNavigate/useLocation/useParams in a rendered component throws
  // "may be used only in the context of a <Router> component". Wrap
  // {children} in <MemoryRouter> at the splice point to provide it.
  const wrapInMemoryRouter = detectRouterContextNeeded(ast, entryAbs);

  // Apply structural rewrites: substitute element names, strip data
  // routers, splice {children} for the App element (deep-cloning the App
  // module's provider prefix around the slot when it can be followed).
  // Mutates the AST in place — the rewriter walks the JSX and the helpers
  // below pick up the shape after rewrites.
  const deepResolve = (importSource: string): DeepCloneResolution | null =>
    resolveDeepProviderPrefix({ projectRoot, fromAbs: entryAbs, importSource, entryAst: ast });
  const rewriteOutcome = applyJsxRewrites(jsxArg, {
    composeWithUserWrapper: opts.composeWithUserWrapper === true,
    wrapInMemoryRouter,
    deepResolve,
  });
  const deep = rewriteOutcome.deep ?? null;

  const usedIdents = collectIdentifiers(jsxArg);

  // Hoist the top-level const/let/var decls referenced in the JSX, plus
  // anything they transitively reference. Iteratively expand until the
  // referenced set stops growing.
  const hoistedDecls = collectHoistedDeclarations(ast, usedIdents);
  const hoistedDeclNames = new Set(declarationNames(hoistedDecls));

  // Imports: keep any whose specifiers are referenced in the JSX or in
  // the hoisted decl bodies. Side-effect imports (no specifiers) keep
  // CSS/font etc. — always lift them so visual fidelity matches.
  const allReferences = new Set<string>([...usedIdents]);
  for (const decl of hoistedDecls) {
    for (const id of collectIdentifiers(decl)) allReferences.add(id);
  }
  const importInfo = collectImports(ast, allReferences);

  // Path-rewrite relative specifiers from "entry-file-relative" to
  // "wrapperOut-relative" so the wrapper.gen.tsx imports resolve.
  const entryDir = dirname(entryAbs);
  const wrapperDir = dirname(wrapperOutPath);
  let rewrittenImports = importInfo.imports.map((imp) =>
    rewriteImportPath(imp, entryDir, wrapperDir),
  );
  let rewrittenSideEffects = importInfo.sideEffects.map((imp) =>
    rewriteImportPath(imp, entryDir, wrapperDir),
  );

  // Deep-cloned prefix elements reference bindings from the APP module, not
  // the entry — hoist their imports and top-level decls from that file, path
  // rewritten from ITS directory. Side-effect imports are restricted to
  // styles: the entry's are boot-order load-bearing, but an app module's
  // analytics/init side effects are for the real boot, not the sandbox.
  if (deep?.prefix) {
    const appDir = dirname(deep.moduleAbs);
    const appReferences = new Set(deep.prefix.referenced);
    const appHoisted = collectHoistedDeclarations(deep.prefix.ast, appReferences);
    for (const decl of appHoisted) {
      for (const id of collectIdentifiers(decl)) appReferences.add(id);
    }
    const appInfo = collectImports(deep.prefix.ast, appReferences);
    rewrittenImports = mergeImportRecords(
      rewrittenImports,
      appInfo.imports.map((imp) => rewriteImportPath(imp, appDir, wrapperDir)),
    );
    rewrittenSideEffects = mergeImportRecords(
      rewrittenSideEffects,
      appInfo.sideEffects
        .filter((imp) => /\.(css|scss|sass|less|styl)$/.test(imp.source))
        .map((imp) => rewriteImportPath(imp, appDir, wrapperDir)),
    );
    hoistedDecls.push(...appHoisted);
  }

  // Emit. Build the wrapper as: header → imports → side-effect imports →
  // hoisted decls → function body wrapping {children} in the JSX tree.
  let body: string;
  try {
    body = generate(jsxArg.node, { jsescOption: { minimal: true } }).code;
  } catch (err) {
    return {
      ok: false,
      source: passthroughTemplate({
        validityVersion,
        composeWithUserWrapper: opts.composeWithUserWrapper === true,
        reason: `JSX serialization failed: ${(err as Error).message}`,
      }),
      fallbackReason: 'emit-error',
      entryFile,
      expectedProviderChain: [],
    };
  }

  const importLines: string[] = [
    "import type { ReactNode } from 'react';",
    ...(opts.composeWithUserWrapper ? ["import UserWrapper from './wrapper.user';"] : []),
    ...rewrittenImports.map(printImport),
    ...rewrittenSideEffects.map(printImport),
  ];

  const declLines: string[] = hoistedDecls.map(
    (d) => generate(d.node, { jsescOption: { minimal: true } }).code,
  );
  void hoistedDeclNames; // referenced by future warning logic; kept for clarity

  const wrapperBody = [
    // `colorScheme` is the active theme during a verify run's color-scheme axis
    // (undefined otherwise). Forwarded to UserWrapper so a ThemeProvider app can
    // switch theme; web also flips via the documentElement class + Playwright
    // colorScheme, so a wrapper that ignores the prop still themes correctly.
    'export default function Wrapper({ children, colorScheme }: { children: ReactNode; colorScheme?: "light" | "dark" }) {',
    `  void colorScheme;`,
    `  return (`,
    indent(body, '    '),
    `  );`,
    '}',
  ].join('\n');

  const assembled = [
    importLines.join('\n'),
    '',
    declLines.join('\n\n'),
    declLines.length > 0 ? '' : null,
    wrapperBody,
    '',
  ]
    .filter((s) => s !== null)
    .join('\n');

  // Re-parse the output to catch syntax errors before we hand it back.
  // Saves the user a confusing Vite "Unexpected token" page when the
  // cloner hits an edge case it didn't anticipate.
  try {
    parse(assembled, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx', 'topLevelAwait'],
    });
  } catch (err) {
    return {
      ok: false,
      source: passthroughTemplate({
        validityVersion,
        composeWithUserWrapper: opts.composeWithUserWrapper === true,
        reason: `generated wrapper failed self-parse: ${(err as Error).message}`,
      }),
      fallbackReason: 'self-parse-failed',
      entryFile,
      expectedProviderChain: [],
    };
  }

  const withMarker = wrapMarker({ body: assembled, validityVersion, entryFile });
  const clonedFrom = resolvedAppModule ?? (deep?.prefix ? deep.moduleRel : undefined);
  return {
    ok: true,
    source: withMarker,
    entryFile,
    ...(clonedFrom !== undefined ? { resolvedAppModule: clonedFrom } : {}),
    expectedProviderChain: rewriteOutcome.expectedProviderChain,
    ...(rewriteOutcome.routerSubtreeDiscarded ? { routerSubtreeDiscarded: true } : {}),
    ...(deep ? { spliceTargetModule: deep.moduleRel } : {}),
    ...(deep && deep.providerSignals.length > 0
      ? { spliceTargetProviderSignals: deep.providerSignals }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Mount-call detection                                                 */
/* ------------------------------------------------------------------ */

interface MountCall {
  /** The original call expression (e.g. createRoot(node).render(<App/>)). */
  callPath: NodePath<t.CallExpression>;
  /** The JSX argument that becomes the wrapper body. */
  jsxArg: NodePath<t.JSXElement | t.JSXFragment>;
}

/**
 * The entry mounts a component IMPORTED from another module — Ignite's
 * `registerRootComponent(App)` with `import { App } from '@/app'`. The
 * provider tree lives in the imported module; `resolveMountIndirection`
 * follows the import to clone it.
 */
interface EntryIndirection {
  /** Module specifier the mounted component is imported from (e.g. '@/app'). */
  importSource: string;
  /** Exported binding name in that module ('default' when isDefault). */
  importedName: string;
  isDefault: boolean;
}

/**
 * Scan the AST for the React mount call and return the JSX argument we
 * should clone. We accept several shapes:
 *
 *   createRoot(node).render(<JSX/>)             → arg of `.render`
 *   ReactDOM.createRoot(node).render(<JSX/>)    → same
 *   ReactDOM.render(<JSX/>, node)               → arg 0 (React 17)
 *   hydrateRoot(node, <JSX/>)                   → arg 1
 *   ViteReactSSG(<JSX/>)                        → arg 0 (vite-react-ssg)
 *   registerRootComponent(<JSX/> | Component)   → Expo bare / Ignite
 *   AppRegistry.registerComponent(n, () => C)   → React Native core
 *
 * A component-identifier argument resolves to its local function's returned
 * JSX, or to an `EntryIndirection` when the identifier is imported.
 *
 * Heuristic, not a spec — we match by callee name. Misses the rare
 * `(window as any).render(...)` and the like; those projects fall back
 * to passthrough.
 */
function findMountCall(ast: t.File): MountCall | EntryIndirection | null {
  let found: MountCall | EntryIndirection | null = null;

  // JSX arg → MountCall; identifier arg → local component's JSX or an
  // import indirection for `generateWrapperSource` to resolve.
  const mountFromArg = (
    path: NodePath<t.CallExpression>,
    arg: NodePath | undefined,
  ): MountCall | EntryIndirection | null => {
    if (!arg) return null;
    if (arg.isJSXElement() || arg.isJSXFragment()) {
      return { callPath: path, jsxArg: arg as NodePath<t.JSXElement | t.JSXFragment> };
    }
    if (!arg.isIdentifier()) return null;
    const name = arg.node.name;
    const localJsx = extractLocalComponentJsx(ast, name);
    if (localJsx) return { callPath: path, jsxArg: localJsx };
    const imported = findImportedBinding(ast, name);
    return imported ?? null;
  };

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      if (found) return;
      const callee = path.node.callee;
      const args = path.get('arguments');

      // registerRootComponent(<JSX/>) / registerRootComponent(App) — Expo bare.
      if (t.isIdentifier(callee, { name: 'registerRootComponent' }) && args.length >= 1) {
        const mounted = mountFromArg(path, args[0]);
        if (mounted) {
          found = mounted;
          return;
        }
      }

      // AppRegistry.registerComponent('main', () => App) — RN core.
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.object, { name: 'AppRegistry' }) &&
        t.isIdentifier(callee.property, { name: 'registerComponent' }) &&
        args.length >= 2
      ) {
        const factory = args[1];
        if (factory && (factory.isArrowFunctionExpression() || factory.isFunctionExpression())) {
          const returned = factoryReturnValue(factory as NodePath<t.Function>);
          const mounted = mountFromArg(path, returned ?? undefined);
          if (mounted) {
            found = mounted;
            return;
          }
        }
      }

      // hydrateRoot(node, <JSX/>)
      if (t.isIdentifier(callee, { name: 'hydrateRoot' }) && args.length >= 2) {
        const jsx = args[1];
        if (jsx && (jsx.isJSXElement() || jsx.isJSXFragment())) {
          found = { callPath: path, jsxArg: jsx as NodePath<t.JSXElement | t.JSXFragment> };
          return;
        }
      }

      // ReactDOM.render(<JSX/>, node)
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.object, { name: 'ReactDOM' }) &&
        t.isIdentifier(callee.property, { name: 'render' }) &&
        args.length >= 1
      ) {
        const jsx = args[0];
        if (jsx && (jsx.isJSXElement() || jsx.isJSXFragment())) {
          found = { callPath: path, jsxArg: jsx as NodePath<t.JSXElement | t.JSXFragment> };
          return;
        }
      }

      // ViteReactSSG(<JSX/>) — vite-react-ssg's mount API
      if (t.isIdentifier(callee, { name: 'ViteReactSSG' }) && args.length >= 1) {
        const jsx = args[0];
        if (jsx && (jsx.isJSXElement() || jsx.isJSXFragment())) {
          found = { callPath: path, jsxArg: jsx as NodePath<t.JSXElement | t.JSXFragment> };
          return;
        }
      }

      // createRoot(node).render(<JSX/>) — including ReactDOM.createRoot
      if (
        t.isMemberExpression(callee) &&
        t.isIdentifier(callee.property, { name: 'render' }) &&
        args.length >= 1
      ) {
        const obj = callee.object;
        if (
          t.isCallExpression(obj) &&
          ((t.isIdentifier(obj.callee) && obj.callee.name === 'createRoot') ||
            (t.isMemberExpression(obj.callee) &&
              t.isIdentifier(obj.callee.property, { name: 'createRoot' })))
        ) {
          const jsx = args[0];
          if (jsx && (jsx.isJSXElement() || jsx.isJSXFragment())) {
            found = { callPath: path, jsxArg: jsx as NodePath<t.JSXElement | t.JSXFragment> };
            return;
          }
        }
      }
    },
  });

  // Expo fallback: no mount call found, but the file looks like an
  // Expo entry — clone the JSX returned by the default export.
  //
  //   • `App.tsx`:                  `export default function App() { return <…/>; }`
  //   • `app/_layout.tsx`:          `export default function RootLayout() { return <…><Slot/></…>; }`
  //   • Or:                          `function App() { … } registerRootComponent(App);`
  //
  // We pick the return-statement JSX of the default-exported function,
  // which is what wraps the user's tree. The splice-point picker
  // downstream then chooses the deepest leaf JSX as `{children}`.
  //
  // This is a best-effort clone — Expo's `<Slot/>` is treated as just
  // another JSX leaf, which means the wrapper will splice `{children}`
  // there. That's actually what we want: <Slot/> represents "the
  // routed screen" and Validity renders ONE component at a time, so
  // the wrapper inserting `{children}` in the same spot is correct.
  if (!found) {
    found = findDefaultExportJsx(ast);
  }
  return found;
}

/**
 * Locate the JSX returned by the file's default-export function. Used
 * as a fallback when no React mount call is present — Expo's
 * `registerRootComponent(App)` pattern lives outside the standard
 * createRoot/hydrateRoot rails, and Expo Router's `app/_layout.tsx`
 * has no mount at all (the router framework does it).
 *
 * Returns a synthetic MountCall whose `jsxArg` is the function's
 * return-statement JSX. The downstream rewriter then picks a splice
 * point inside it as usual.
 */
function findDefaultExportJsx(ast: t.File): MountCall | null {
  let result: MountCall | null = null;
  const inspectFunction = extractReturnedJsx;

  traverse(ast, {
    ExportDefaultDeclaration(path) {
      if (result) return;
      const decl = path.node.declaration;

      // export default function Foo() { return <JSX/>; }
      if (t.isFunctionDeclaration(decl) && decl.body) {
        const bodyPath = path.get('declaration.body') as NodePath<t.BlockStatement>;
        const jsx = inspectFunction(bodyPath);
        if (jsx) {
          result = {
            callPath: path as unknown as NodePath<t.CallExpression>,
            jsxArg: jsx,
          };
        }
        return;
      }

      // export default () => <JSX/> | () => { return <JSX/>; }
      if (t.isArrowFunctionExpression(decl)) {
        const bodyPath = path.get('declaration.body') as NodePath<t.BlockStatement | t.Expression>;
        const jsx = inspectFunction(bodyPath);
        if (jsx) {
          result = {
            callPath: path as unknown as NodePath<t.CallExpression>,
            jsxArg: jsx,
          };
        }
        return;
      }

      // export default App  (identifier — resolve to local function decl)
      if (t.isIdentifier(decl)) {
        const name = decl.name;
        for (const stmt of ast.program.body) {
          if (t.isFunctionDeclaration(stmt) && stmt.id?.name === name) {
            // Walk the function body the same way as above.
            const program = path.scope.getProgramParent();
            // We need a NodePath for the function body — use the path's
            // sibling lookup since the function declaration is at the
            // program level.
            void program;
            // Cheap path: re-traverse with a guard to extract the JSX.
            let jsx: NodePath<t.JSXElement | t.JSXFragment> | null = null;
            traverse(ast, {
              FunctionDeclaration(fnPath) {
                if (jsx) return;
                if (fnPath.node.id?.name !== name) return;
                const bodyPath = fnPath.get('body') as NodePath<t.BlockStatement>;
                jsx = inspectFunction(bodyPath);
              },
            });
            if (jsx) {
              result = {
                callPath: path as unknown as NodePath<t.CallExpression>,
                jsxArg: jsx,
              };
            }
            break;
          }
        }
      }
    },
  });

  return result;
}

/**
 * First render-path `return <JSX/>` of a function body (or the expression
 * body itself for `() => <JSX/>` arrows). Skips non-JSX returns — Ignite's
 * App returns `null` while fonts/i18n load; the JSX return further down is
 * the provider tree we clone.
 */
function extractReturnedJsx(
  body: NodePath<t.BlockStatement | t.Expression>,
): NodePath<t.JSXElement | t.JSXFragment> | null {
  // Arrow with expression body: `() => <JSX/>`.
  if (body.isJSXElement() || body.isJSXFragment()) {
    return body as NodePath<t.JSXElement | t.JSXFragment>;
  }
  // Block body: walk for the FIRST top-level `return <JSX/>;`.
  let returned: NodePath<t.JSXElement | t.JSXFragment> | null = null;
  body.traverse({
    ReturnStatement(retPath) {
      if (returned) return;
      // Only consider returns that belong to the OUTER function — skip
      // returns inside nested functions/render callbacks.
      const enclosingFn = retPath.getFunctionParent();
      if (enclosingFn?.node !== (body.parent as t.Node | null)) return;
      const arg = retPath.get('argument');
      if (arg.isJSXElement() || arg.isJSXFragment()) {
        returned = arg as NodePath<t.JSXElement | t.JSXFragment>;
      }
    },
  });
  return returned;
}

/**
 * Returned JSX of a component declared in THIS file as `function Name() {}`
 * or `const Name = () => …`. Null when no such declaration returns JSX.
 */
function extractLocalComponentJsx(
  ast: t.File,
  name: string,
): NodePath<t.JSXElement | t.JSXFragment> | null {
  let jsx: NodePath<t.JSXElement | t.JSXFragment> | null = null;
  traverse(ast, {
    FunctionDeclaration(fnPath: NodePath<t.FunctionDeclaration>) {
      if (jsx) return;
      if (fnPath.node.id?.name !== name) return;
      jsx = extractReturnedJsx(fnPath.get('body') as NodePath<t.BlockStatement>);
    },
    VariableDeclarator(varPath: NodePath<t.VariableDeclarator>) {
      if (jsx) return;
      if (!t.isIdentifier(varPath.node.id) || varPath.node.id.name !== name) return;
      const init = varPath.get('init');
      if (init.isArrowFunctionExpression() || init.isFunctionExpression()) {
        jsx = extractReturnedJsx(init.get('body') as NodePath<t.BlockStatement | t.Expression>);
      }
    },
  });
  return jsx;
}

/** Import binding for `name` in the file, as an indirection to follow. */
function findImportedBinding(ast: t.File, name: string): EntryIndirection | null {
  for (const stmt of ast.program.body) {
    if (!t.isImportDeclaration(stmt)) continue;
    if (stmt.importKind === 'type') continue;
    for (const spec of stmt.specifiers) {
      if (spec.local.name !== name) continue;
      if (t.isImportDefaultSpecifier(spec)) {
        return { importSource: stmt.source.value, importedName: 'default', isDefault: true };
      }
      if (t.isImportSpecifier(spec)) {
        const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
        return { importSource: stmt.source.value, importedName: imported, isDefault: false };
      }
      // Namespace import (`* as App`) — not a component reference we can follow.
      return null;
    }
  }
  return null;
}

/** Expression returned by an `AppRegistry.registerComponent` factory. */
function factoryReturnValue(fn: NodePath<t.Function>): NodePath | null {
  const body = fn.get('body') as NodePath<t.BlockStatement | t.Expression>;
  if (!body.isBlockStatement()) return body;
  let returned: NodePath | null = null;
  body.traverse({
    ReturnStatement(retPath) {
      if (returned) return;
      if (retPath.getFunctionParent()?.node !== fn.node) return;
      const arg = retPath.get('argument');
      if (arg.node) returned = arg as NodePath;
    },
  });
  return returned;
}

/* ------------------------------------------------------------------ */
/* Entry indirection resolution                                         */
/* ------------------------------------------------------------------ */

interface ResolvedAppModule {
  moduleAbs: string;
  ast: ReturnType<typeof parse>;
  source: string;
  jsxArg: NodePath<t.JSXElement | t.JSXFragment>;
}

/** Max import/re-export hops we follow from the entry to the app module. */
const MAX_INDIRECTION_HOPS = 3;

/**
 * Follow the entry's mount indirection to the module that declares the
 * mounted component and extract that component's returned JSX. Resolves
 * relative specifiers AND tsconfig path aliases (Ignite's `@/app` →
 * `app/app.tsx`), accepts named exports (`export function App`,
 * `export const App = …`), default exports, and follows re-exports up to
 * `MAX_INDIRECTION_HOPS`. Null on any failure — caller falls back to the
 * passthrough wrapper with a precise reason.
 */
function resolveMountIndirection(
  projectRoot: string,
  fromAbs: string,
  indirection: EntryIndirection,
  hops = 0,
): ResolvedAppModule | null {
  if (hops >= MAX_INDIRECTION_HOPS) return null;
  const moduleAbs = resolveImportSpecifier(
    indirection.importSource,
    fromAbs,
    readTsconfigPaths(projectRoot),
  );
  if (!moduleAbs) return null;

  let source: string;
  try {
    source = readFileSync(moduleAbs, 'utf-8');
  } catch {
    return null;
  }
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx', 'topLevelAwait'],
      errorRecovery: true,
    });
  } catch {
    return null;
  }
  if ((ast.errors ?? []).length > 0) return null;

  if (indirection.isDefault) {
    const viaDefault = findDefaultExportJsx(ast);
    if (viaDefault) return { moduleAbs, ast, source, jsxArg: viaDefault.jsxArg };
  } else {
    // `export function App() {}` / `export const App = …` / `export { App }`
    // — extractLocalComponentJsx sees the declarations regardless of the
    // surrounding export statement.
    const jsx = extractLocalComponentJsx(ast, indirection.importedName);
    if (jsx) return { moduleAbs, ast, source, jsxArg: jsx };
  }

  // Re-export barrels: `export { App } from './app'` / `export * from './app'`.
  const nextHops: EntryIndirection[] = [];
  for (const stmt of ast.program.body) {
    if (t.isExportNamedDeclaration(stmt) && stmt.source) {
      for (const spec of stmt.specifiers) {
        if (!t.isExportSpecifier(spec)) continue;
        const exported = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
        if (exported !== indirection.importedName) continue;
        nextHops.push({
          importSource: stmt.source.value,
          importedName: spec.local.name,
          isDefault: spec.local.name === 'default',
        });
      }
    } else if (t.isExportAllDeclaration(stmt) && !indirection.isDefault) {
      nextHops.push({
        importSource: stmt.source.value,
        importedName: indirection.importedName,
        isDefault: false,
      });
    }
  }
  for (const next of nextHops) {
    const resolved = resolveMountIndirection(projectRoot, moduleAbs, next, hops + 1);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Project-relative path of the module the entry's mount indirection resolves
 * to (Ignite: index.tsx registers `App` from app/app.tsx), or undefined when
 * the entry mounts JSX directly / nothing resolves. The shape signature
 * tracks this file so provider-tree edits re-trigger regen even though the
 * entry file itself never changes.
 */
export function resolveEntryAppModule(projectRoot: string, entryRel?: string): string | undefined {
  const entry = entryRel ?? findEntryFile(projectRoot);
  if (!entry) return undefined;
  const entryAbs = isAbsolute(entry) ? entry : resolve(projectRoot, entry);
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(readFileSync(entryAbs, 'utf-8'), {
      sourceType: 'module',
      plugins: ['typescript', 'jsx', 'topLevelAwait'],
      errorRecovery: true,
    });
  } catch {
    return undefined;
  }
  const mount = findMountCall(ast);
  if (!mount) return undefined;
  if ('importSource' in mount) {
    const resolved = resolveMountIndirection(projectRoot, entryAbs, mount);
    return resolved ? relative(projectRoot, resolved.moduleAbs).replaceAll('\\', '/') : undefined;
  }
  // JSX mount: the splice target's module (`<App/>` → src/App.tsx) is where
  // deep cloning reads the provider tree from — its edits must drift-trigger
  // regen exactly like the Ignite indirection module's.
  const source = spliceTargetImportSource(mount.jsxArg);
  if (!source) return undefined;
  const moduleAbs = resolveImportSpecifier(source, entryAbs, readTsconfigPaths(projectRoot));
  return moduleAbs ? relative(projectRoot, moduleAbs).replaceAll('\\', '/') : undefined;
}

/* ------------------------------------------------------------------ */
/* Deep provider cloning                                                */
/* ------------------------------------------------------------------ */

/**
 * When the entry mounts JSX (`render(<App/>)`), the splice target `<App/>`
 * historically became `{children}` without ever reading App.tsx — every
 * provider declared INSIDE it (the common shape: QueryClientProvider around
 * `<Routes>`, or providers in a data-router root layout) silently vanished
 * from the wrapper while fidelity, comparing against an entry-only
 * expectation, still said `verified`. Deep cloning follows the splice
 * target's import and extracts its PROVIDER PREFIX — the wrapper components
 * on the render path between the module's default export and the app's
 * routed content — so the generated wrapper reproduces them.
 *
 * The walk is deliberately bounded and conservative:
 *  - it follows the single "spine" (at each element, the child subtree with
 *    the most JSX underneath), expanding LOCAL components inline and keeping
 *    imported ones as cloned wrapper elements;
 *  - conditional returns contribute all their JSX branches as candidates,
 *    scored so the branch that reaches a router or `<Outlet/>` wins (an
 *    App.tsx with public-page early returns still clones the real tree);
 *  - `<RouterProvider router={x}>` substitutes `<MemoryRouter>` and, when
 *    `x` resolves to a same-file `create*Router([{ element: <Layout/>,
 *    children: […] }])`, continues into the layout's provider prefix down
 *    to its `<Outlet/>` (the "providers live in the root route" pattern);
 *  - anything unanalyzable stops the walk. Honesty is preserved regardless:
 *    `spliceTargetProviderSignals` carries the module's detectable provider
 *    names so wrapper-fidelity can refuse `verified` when the wrapper (gen +
 *    user) does not reproduce them.
 */
interface DeepClonedPrefix {
  /** Cloned wrapper elements, outermost first. Childless shells — nested at emit. */
  elements: t.JSXElement[];
  /** Post-substitution element names, outermost first (feeds expectedProviderChain). */
  chainNames: string[];
  /** True when the prefix contains a router (substituted MemoryRouter). */
  foundRouter: boolean;
  /** True when a router's route-config subtree could not be followed. */
  routerSubtreeDiscarded: boolean;
  /** Identifiers the cloned elements reference (import/decl hoisting input). */
  referenced: Set<string>;
  ast: t.File;
}

interface DeepCloneResolution {
  moduleAbs: string;
  /** Project-relative path of the followed module. */
  moduleRel: string;
  /** Regex-detected provider names in the module (fidelity honesty input). */
  providerSignals: string[];
  /** Null when the module resolved but no clonable prefix was extracted. */
  prefix: DeepClonedPrefix | null;
}

/** Content boundaries: the routed/slotted app body starts here. */
const DEEP_CONTENT_STOPPERS = new Set(['Routes', 'Outlet', 'Slot']);
/** Local-component expansions followed per walk (App → Gates → Layout …). */
const MAX_DEEP_COMPONENT_HOPS = 6;
/** Wrapper elements collected per walk — runaway-shape backstop. */
const MAX_DEEP_SPINE_LENGTH = 16;

interface SpineWalkOutcome {
  elements: t.JSXElement[];
  foundRouter: boolean;
  sawOutlet: boolean;
  routerSubtreeDiscarded: boolean;
}

interface SpineWalkCtx {
  ast: t.File;
  /** Local binding name → import record facts, for attr/name resolvability. */
  importLocals: Map<string, { source: string; imported: string }>;
  topLevelVars: Set<string>;
  /** Component names currently being expanded (cycle guard). */
  visiting: Set<string>;
  hops: { count: number };
}

/**
 * All top-level JSX returns of a function, with conditional/logical branches
 * flattened into separate candidates. Never descends into nested functions —
 * a render callback's JSX is not the component's return.
 */
function jsxReturnCandidatesOfFunction(fn: t.Function): Array<t.JSXElement | t.JSXFragment> {
  const out: Array<t.JSXElement | t.JSXFragment> = [];
  const fromExpr = (e: t.Node | null | undefined): void => {
    if (!e) return;
    if (t.isJSXElement(e) || t.isJSXFragment(e)) out.push(e);
    else if (t.isConditionalExpression(e)) {
      fromExpr(e.consequent);
      fromExpr(e.alternate);
    } else if (t.isLogicalExpression(e)) {
      fromExpr(e.left);
      fromExpr(e.right);
    } else if (
      t.isParenthesizedExpression(e) ||
      t.isTSAsExpression(e) ||
      t.isTSNonNullExpression(e)
    )
      fromExpr(e.expression);
  };
  if (!t.isBlockStatement(fn.body)) {
    fromExpr(fn.body);
    return out;
  }
  const stack: t.Statement[] = [...fn.body.body];
  while (stack.length > 0) {
    const stmt = stack.shift()!;
    if (t.isReturnStatement(stmt)) fromExpr(stmt.argument);
    else if (t.isBlockStatement(stmt)) stack.unshift(...stmt.body);
    else if (t.isIfStatement(stmt)) {
      stack.unshift(
        ...[stmt.consequent, stmt.alternate].filter((s): s is t.Statement => s != null),
      );
    } else if (t.isSwitchStatement(stmt)) {
      stack.unshift(...stmt.cases.flatMap((c) => c.consequent));
    }
  }
  return out;
}

/** Function declared at the module top level under `name`, export-wrapped or not. */
function localFunctionComponent(ast: t.File, name: string): t.Function | null {
  const fromStmt = (stmt: t.Statement): t.Function | null => {
    if (t.isFunctionDeclaration(stmt) && stmt.id?.name === name) return stmt;
    if (t.isVariableDeclaration(stmt)) {
      for (const decl of stmt.declarations) {
        if (!t.isIdentifier(decl.id, { name })) continue;
        if (t.isArrowFunctionExpression(decl.init) || t.isFunctionExpression(decl.init)) {
          return decl.init;
        }
      }
    }
    return null;
  };
  for (const stmt of ast.program.body) {
    const direct = fromStmt(stmt);
    if (direct) return direct;
    if (t.isExportNamedDeclaration(stmt) && stmt.declaration) {
      const inner = fromStmt(stmt.declaration);
      if (inner) return inner;
    }
  }
  return null;
}

/** The module's default-exported function component (unwrapping memo/forwardRef/identifier). */
function defaultExportFunction(ast: t.File): t.Function | null {
  for (const stmt of ast.program.body) {
    if (!t.isExportDefaultDeclaration(stmt)) continue;
    let decl: t.Node = stmt.declaration;
    while (t.isCallExpression(decl) && decl.arguments.length > 0) decl = decl.arguments[0]!;
    if (t.isFunctionDeclaration(decl) || t.isArrowFunctionExpression(decl)) return decl;
    if (t.isFunctionExpression(decl)) return decl;
    if (t.isIdentifier(decl)) return localFunctionComponent(ast, decl.name);
  }
  return null;
}

function moduleImportLocals(ast: t.File): Map<string, { source: string; imported: string }> {
  const out = new Map<string, { source: string; imported: string }>();
  for (const stmt of ast.program.body) {
    if (!t.isImportDeclaration(stmt) || stmt.importKind === 'type') continue;
    for (const spec of stmt.specifiers) {
      const imported = t.isImportSpecifier(spec)
        ? t.isIdentifier(spec.imported)
          ? spec.imported.name
          : spec.imported.value
        : t.isImportDefaultSpecifier(spec)
          ? 'default'
          : '*';
      out.set(spec.local.name, { source: stmt.source.value, imported });
    }
  }
  return out;
}

function topLevelVarNames(ast: t.File): Set<string> {
  const out = new Set<string>();
  for (const stmt of ast.program.body) {
    const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
    if (!t.isVariableDeclaration(decl)) continue;
    for (const d of decl.declarations) if (t.isIdentifier(d.id)) out.add(d.id.name);
  }
  return out;
}

/** Leftmost identifier of a JSX element name (`Ctx` in `<Ctx.Provider>`). */
function rootJsxName(opening: t.JSXOpeningElement): string | null {
  let name: t.JSXOpeningElement['name'] = opening.name;
  while (t.isJSXMemberExpression(name)) name = name.object;
  return t.isJSXIdentifier(name) ? name.name : null;
}

function countJsxNodes(node: t.Node): number {
  let count = 0;
  t.traverseFast(node, (n) => {
    if (t.isJSXElement(n)) count++;
  });
  return count;
}

/** The child subtree the spine continues through: the one with the most JSX. */
function spineChildOf(el: t.JSXElement | t.JSXFragment): t.JSXElement | t.JSXFragment | null {
  const kids = el.children.filter(
    (c): c is t.JSXElement | t.JSXFragment => t.isJSXElement(c) || t.isJSXFragment(c),
  );
  if (kids.length === 0) return null;
  let best = kids[0]!;
  let bestCount = -1;
  for (const k of kids) {
    const c = countJsxNodes(k);
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best;
}

function makeMemoryRouterShell(): t.JSXElement {
  return t.jsxElement(
    t.jsxOpeningElement(
      t.jsxIdentifier('MemoryRouter'),
      [
        t.jsxAttribute(
          t.jsxIdentifier('initialEntries'),
          t.jsxExpressionContainer(t.arrayExpression([t.stringLiteral('/')])),
        ),
      ],
      false,
    ),
    t.jsxClosingElement(t.jsxIdentifier('MemoryRouter')),
    [],
    false,
  );
}

/**
 * Childless clone of a wrapper element, dropping attributes that reference
 * anything the wrapper can't hoist (local functions, `children`, spreads).
 * A dropped attribute degrades gracefully (`<Suspense>` loses its local
 * `fallback` component); an unresolvable ELEMENT name means the caller must
 * stop instead.
 */
function cloneElementShell(el: t.JSXElement, ctx: SpineWalkCtx): t.JSXElement | null {
  const root = rootJsxName(el.openingElement);
  if (!root || (!ctx.importLocals.has(root) && !ctx.topLevelVars.has(root))) return null;
  const kept: Array<t.JSXAttribute> = [];
  for (const attr of el.openingElement.attributes) {
    if (!t.isJSXAttribute(attr)) continue; // spread — unresolvable, drop
    let ok = true;
    if (attr.value && !t.isStringLiteral(attr.value)) {
      t.traverseFast(attr.value, (n) => {
        if (t.isIdentifier(n) || t.isJSXIdentifier(n)) {
          const name = n.name;
          if (name === 'children') ok = false;
          else if (/^[A-Z]/.test(name) || !isLikelyGlobal(name)) {
            if (!ctx.importLocals.has(name) && !ctx.topLevelVars.has(name)) ok = false;
          }
        }
      });
    }
    if (ok) kept.push(t.cloneNode(attr, true));
  }
  const opening = t.jsxOpeningElement(t.cloneNode(el.openingElement.name, true), kept, false);
  return t.jsxElement(
    opening,
    t.jsxClosingElement(t.cloneNode(el.openingElement.name, true)),
    [],
    false,
  );
}

/** Identifier names an attribute filter should not demand a module binding for. */
function isLikelyGlobal(name: string): boolean {
  return (
    name === 'undefined' ||
    name === 'window' ||
    name === 'document' ||
    name === 'navigator' ||
    name === 'process' ||
    name === 'JSON' ||
    name === 'Math' ||
    name === 'Date' ||
    name === 'String' ||
    name === 'Number' ||
    name === 'Boolean'
  );
}

/**
 * Root route layout of a `<RouterProvider router={x}>`: `x` (identifier or
 * inline call) must resolve, in the same file, to `create*Router([...])`
 * whose first route object carries BOTH a JSX `element` and a `children`
 * array — the data-router layout pattern. Returns the layout element name.
 */
function routeLayoutFromRouterProviderEl(ast: t.File, el: t.JSXElement): string | null {
  let routerExpr: t.Node | null = null;
  for (const attr of el.openingElement.attributes) {
    if (!t.isJSXAttribute(attr) || !t.isJSXIdentifier(attr.name, { name: 'router' })) continue;
    if (t.isJSXExpressionContainer(attr.value)) routerExpr = attr.value.expression;
  }
  if (!routerExpr) return null;
  let call: t.CallExpression | null = null;
  if (t.isCallExpression(routerExpr)) call = routerExpr;
  else if (t.isIdentifier(routerExpr)) {
    for (const stmt of ast.program.body) {
      const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
      if (!t.isVariableDeclaration(decl)) continue;
      for (const d of decl.declarations) {
        if (t.isIdentifier(d.id, { name: routerExpr.name }) && t.isCallExpression(d.init)) {
          call = d.init;
        }
      }
    }
  }
  if (!call) return null;
  const callee = call.callee;
  const calleeName = t.isIdentifier(callee) ? callee.name : null;
  if (
    calleeName !== 'createBrowserRouter' &&
    calleeName !== 'createHashRouter' &&
    calleeName !== 'createMemoryRouter'
  ) {
    return null;
  }
  const routes = call.arguments[0];
  if (!t.isArrayExpression(routes)) return null;
  for (const route of routes.elements) {
    if (!t.isObjectExpression(route)) continue;
    let element: t.JSXElement | null = null;
    let hasChildren = false;
    for (const prop of route.properties) {
      if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
      if (prop.key.name === 'element' && t.isJSXElement(prop.value)) element = prop.value;
      if (prop.key.name === 'children') hasChildren = true;
    }
    if (element && hasChildren) return jsxOpeningName(element.openingElement);
  }
  return null;
}

/**
 * Walk one JSX candidate's spine collecting wrapper elements. Local
 * components expand inline; imported wrappers clone; routers substitute
 * `<MemoryRouter>`; content boundaries (intrinsics, Routes/Outlet/Slot,
 * unfollowable leaves) stop the walk.
 */
function walkProviderSpine(
  start: t.JSXElement | t.JSXFragment,
  ctx: SpineWalkCtx,
): SpineWalkOutcome {
  const out: SpineWalkOutcome = {
    elements: [],
    foundRouter: false,
    sawOutlet: false,
    routerSubtreeDiscarded: false,
  };
  const merge = (sub: SpineWalkOutcome): void => {
    out.elements.push(...sub.elements);
    out.foundRouter = out.foundRouter || sub.foundRouter;
    out.sawOutlet = out.sawOutlet || sub.sawOutlet;
    out.routerSubtreeDiscarded = out.routerSubtreeDiscarded || sub.routerSubtreeDiscarded;
  };
  const expandLocal = (name: string): SpineWalkOutcome | null => {
    if (ctx.visiting.has(name) || ctx.hops.count >= MAX_DEEP_COMPONENT_HOPS) return null;
    const fn = localFunctionComponent(ctx.ast, name);
    if (!fn) return null;
    ctx.visiting.add(name);
    ctx.hops.count++;
    try {
      return bestCandidateWalk(jsxReturnCandidatesOfFunction(fn), ctx);
    } finally {
      ctx.visiting.delete(name);
    }
  };

  let cur: t.JSXElement | t.JSXFragment | null = start;
  let steps = 0;
  while (cur && steps++ < MAX_DEEP_SPINE_LENGTH) {
    if (t.isJSXFragment(cur)) {
      cur = spineChildOf(cur);
      continue;
    }
    const name = jsxOpeningName(cur.openingElement);
    if (!name) break;
    if (DEEP_CONTENT_STOPPERS.has(name)) {
      if (name === 'Outlet') out.sawOutlet = true;
      break;
    }
    if (/^[a-z]/.test(name)) break; // intrinsic — the app's own markup begins
    if (name === 'RouterProvider') {
      out.elements.push(makeMemoryRouterShell());
      out.foundRouter = true;
      const layoutName = routeLayoutFromRouterProviderEl(ctx.ast, cur);
      const sub = layoutName ? expandLocal(layoutName) : null;
      if (sub) merge(sub);
      else out.routerSubtreeDiscarded = true;
      break;
    }
    if (name === 'BrowserRouter' || name === 'HashRouter') {
      out.elements.push(makeMemoryRouterShell());
      out.foundRouter = true;
      cur = spineChildOf(cur);
      continue;
    }
    const spineChild = spineChildOf(cur);
    if (!spineChild) {
      // Leaf component: expand when local (the App → AuthedApp indirection);
      // an imported leaf is routed content we can't follow — stop.
      const sub = expandLocal(name);
      if (sub) merge(sub);
      break;
    }
    // Wrapper element with children. A LOCAL function used as a wrapper
    // can't be cloned (its declaration isn't hoistable) — stop; the signals
    // fold keeps fidelity honest about anything below.
    if (localFunctionComponent(ctx.ast, name)) break;
    const shell = cloneElementShell(cur, ctx);
    if (!shell) break;
    out.elements.push(shell);
    cur = spineChild;
  }
  return out;
}

/**
 * Walk every candidate and keep the best: reaching a router or `<Outlet/>`
 * dominates (that's the real app tree, not a public-page early return);
 * chain length breaks ties; a LATER candidate wins equal scores (the main
 * render path is conventionally the last return).
 */
function bestCandidateWalk(
  candidates: Array<t.JSXElement | t.JSXFragment>,
  ctx: SpineWalkCtx,
): SpineWalkOutcome {
  let best: SpineWalkOutcome = {
    elements: [],
    foundRouter: false,
    sawOutlet: false,
    routerSubtreeDiscarded: false,
  };
  let bestScore = -1;
  for (const cand of candidates) {
    const r = walkProviderSpine(cand, ctx);
    const score = (r.foundRouter || r.sawOutlet ? 1000 : 0) + r.elements.length;
    if (score >= bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Follow the splice target's import and extract its provider prefix.
 * Returns null only when the module itself can't be resolved/read; parse or
 * walk failures still return the module identity + provider signals so
 * fidelity can refuse a false `verified`.
 */
function resolveDeepProviderPrefix(args: {
  projectRoot: string;
  fromAbs: string;
  importSource: string;
  entryAst: t.File;
}): DeepCloneResolution | null {
  const moduleAbs = resolveImportSpecifier(
    args.importSource,
    args.fromAbs,
    readTsconfigPaths(args.projectRoot),
  );
  if (!moduleAbs) return null;
  let source: string;
  try {
    source = readFileSync(moduleAbs, 'utf-8');
  } catch {
    return null;
  }
  const moduleRel = relative(args.projectRoot, moduleAbs).replaceAll('\\', '/');
  const providerSignals = detectProviderSignals(source);
  const bail = (): DeepCloneResolution => ({ moduleAbs, moduleRel, providerSignals, prefix: null });

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx', 'topLevelAwait'],
      errorRecovery: true,
    });
  } catch {
    return bail();
  }
  if ((ast.errors ?? []).length > 0) return bail();

  const fn = defaultExportFunction(ast);
  if (!fn) return bail();

  const ctx: SpineWalkCtx = {
    ast,
    importLocals: moduleImportLocals(ast),
    topLevelVars: topLevelVarNames(ast),
    visiting: new Set(),
    hops: { count: 0 },
  };
  const walk = bestCandidateWalk(jsxReturnCandidatesOfFunction(fn), ctx);
  if (walk.elements.length === 0) return bail();

  // Identifiers the cloned shells reference (element names + kept attrs).
  const referenced = new Set<string>();
  for (const el of walk.elements) {
    t.traverseFast(el, (n) => {
      if (t.isIdentifier(n) || t.isJSXIdentifier(n)) referenced.add(n.name);
    });
  }
  if (walk.foundRouter) referenced.add('MemoryRouter');

  // Local-name conflicts with the ENTRY side make the merged import block
  // ambiguous — bail to the honesty path rather than emit a broken wrapper.
  const entryLocals = moduleImportLocals(args.entryAst);
  const entryVars = topLevelVarNames(args.entryAst);
  const appLocals = ctx.importLocals;
  const entryDir = dirname(args.fromAbs);
  const appDir = dirname(moduleAbs);
  const resolveSource = (src: string, fromDir: string): string =>
    src.startsWith('.') ? resolve(fromDir, src) : src;
  for (const name of referenced) {
    if (entryVars.has(name)) return bail();
    const inEntry = entryLocals.get(name);
    const inApp = appLocals.get(name);
    if (inEntry && inApp) {
      const same =
        inEntry.imported === inApp.imported &&
        resolveSource(inEntry.source, entryDir) === resolveSource(inApp.source, appDir);
      if (!same) return bail();
    }
  }

  const chainNames = walk.elements
    .map((el) => jsxOpeningName(el.openingElement))
    .filter((n): n is string => n !== null);

  return {
    moduleAbs,
    moduleRel,
    providerSignals,
    prefix: {
      elements: walk.elements,
      chainNames,
      foundRouter: walk.foundRouter,
      routerSubtreeDiscarded: walk.routerSubtreeDiscarded,
      referenced,
      ast,
    },
  };
}

/** Nest childless shells outermost→innermost around `inner`. */
function nestPrefixElements(
  elements: t.JSXElement[],
  inner: t.JSXExpressionContainer | t.JSXElement,
): t.JSXElement {
  let acc: t.JSXExpressionContainer | t.JSXElement = inner;
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    el.children = [acc];
    el.openingElement.selfClosing = false;
    if (!el.closingElement) {
      el.closingElement = t.jsxClosingElement(t.cloneNode(el.openingElement.name, true));
    }
    acc = el;
  }
  return acc as t.JSXElement;
}

/**
 * Import source of the JSX mount's splice target — the deepest element whose
 * tag is a relative default import (`<App/>`). Mirrors the splice-point pick
 * in `applyJsxRewrites`; used by `resolveEntryAppModule` so the shape
 * signature tracks the deep-cloned module for drift.
 */
function spliceTargetImportSource(jsxArg: NodePath<t.JSXElement | t.JSXFragment>): string | null {
  const { defaultImports, relativeDefaultImports } = collectDefaultImports(jsxArg);
  let bestName: string | null = null;
  let bestDepth = -1;
  const consider = (path: NodePath<t.JSXElement>): void => {
    const name = jsxOpeningName(path.node.openingElement);
    if (!name || !relativeDefaultImports.has(name)) return;
    const depth = jsxDepth(path);
    if (depth > bestDepth) {
      bestName = name;
      bestDepth = depth;
    }
  };
  if (jsxArg.isJSXElement()) consider(jsxArg as NodePath<t.JSXElement>);
  jsxArg.traverse({
    JSXElement(path) {
      consider(path);
    },
  });
  return bestName ? (defaultImports.get(bestName) ?? null) : null;
}

/* ------------------------------------------------------------------ */
/* Substitution rules                                                   */
/* ------------------------------------------------------------------ */

interface Rewrites {
  /** Map of original element name → replacement name (and props to inject). */
  renames: Map<
    string,
    { to: string; addAttrs?: t.JSXAttribute[]; setAttrSource?: { router: 'memory' } }
  >;
  /** Set of element names whose import sources should be rewritten away. */
  stripImportNames: Set<string>;
  /** Set of element names that should be replaced wholesale by <MemoryRouter>{children}</MemoryRouter>. */
  replaceWithMemoryRouter: Set<string>;
}

/** Rewrites we apply to the JSX tree before the splice. */
function buildRewrites(): Rewrites {
  const memoryRouterAttr: t.JSXAttribute[] = [
    t.jsxAttribute(
      t.jsxIdentifier('initialEntries'),
      t.jsxExpressionContainer(t.arrayExpression([t.stringLiteral('/')])),
    ),
  ];
  const renames = new Map<string, { to: string; addAttrs?: t.JSXAttribute[] }>([
    ['BrowserRouter', { to: 'MemoryRouter', addAttrs: memoryRouterAttr }],
    ['HashRouter', { to: 'MemoryRouter', addAttrs: memoryRouterAttr }],
  ]);
  const stripImportNames = new Set(['BrowserRouter', 'HashRouter']);
  const replaceWithMemoryRouter = new Set(['RouterProvider']);
  return { renames, stripImportNames, replaceWithMemoryRouter };
}

interface JsxRewriteOutcome {
  /**
   * Post-rewrite element names from the mount root down to (exclusive of)
   * the splice point, outermost first. E.g.
   * ['StrictMode','QueryClientProvider','MemoryRouter']. Intrinsics and
   * `UserWrapper` (composition, not a cloned provider) are excluded.
   */
  expectedProviderChain: string[];
  /**
   * True when a `<RouterProvider router={…}>` was substituted with
   * `<MemoryRouter>`. That substitution deliberately discards the router's
   * route-config subtree UNANALYZED — providers mounted inside a route element
   * (the common `createBrowserRouter([{ element: <AuthProvider>…}])` pattern)
   * are dropped from BOTH the clone and `expectedProviderChain`. Fidelity must
   * therefore never report `verified` for such a wrapper: the expectation it
   * would match against is itself known-incomplete.
   */
  routerSubtreeDiscarded?: boolean;
  /** Deep-clone resolution of the splice target's module, when attempted. */
  deep?: DeepCloneResolution | null;
}

/**
 * Walk the JSX tree and apply the rewrite rules in place. Also locates
 * the splice point — the deepest JSX descendant whose tag matches a
 * relative-default-imported identifier (typically `<App/>`) — and
 * replaces it with `{children}`. If no such candidate exists, picks the
 * deepest leaf JSX element instead. Returns the provider chain wrapping
 * the splice point (the fidelity analyzer's "expected" side).
 */
function applyJsxRewrites(
  jsxRoot: NodePath<t.JSXElement | t.JSXFragment>,
  opts: {
    composeWithUserWrapper: boolean;
    wrapInMemoryRouter?: boolean;
    /** Deep-clone the splice target's module (relative default imports only). */
    deepResolve?: (importSource: string) => DeepCloneResolution | null;
  },
): JsxRewriteOutcome {
  const rewrites = buildRewrites();
  const { defaultImports, relativeDefaultImports } = collectDefaultImports(jsxRoot);

  // Track whether a substitution already injected a `{children}` slot. If
  // so, the splice-point pass below skips its fallback so we don't drop
  // the already-correct slot.
  let spliceAlreadyInjected = false;
  // Provider chain captured when a substitution injects the slot itself
  // (RouterProvider→MemoryRouter) — the normal splice pass never runs then.
  let capturedChain: string[] = [];
  // Set when a RouterProvider→MemoryRouter substitution discarded an
  // unanalyzed route subtree (see JsxRewriteOutcome.routerSubtreeDiscarded).
  let routerSubtreeDiscarded = false;

  // Post-rewrite JSX element names ABOVE `path`, outermost first. Ancestors
  // are already renamed when this runs (renames happen pre-order, before the
  // splice), so the names match what the generated wrapper will contain.
  const chainAbove = (path: NodePath): string[] => {
    const chain: string[] = [];
    let cur: NodePath | null = path.parentPath;
    while (cur) {
      if (cur.isJSXElement()) {
        const name = jsxOpeningName(cur.node.openingElement);
        if (name && /^[A-Z]/.test(name) && name !== 'UserWrapper') chain.unshift(name);
      }
      cur = cur.parentPath;
    }
    return chain;
  };

  // The "splice value" we insert at the App element's location. Plain
  // {children} unless the user has authored wrapper.user.tsx, in which
  // case we wrap it in <UserWrapper>{children}</UserWrapper>; and if the
  // splice target's source file relies on react-router-dom (Router lives
  // inside App.tsx, not in main.tsx), we additionally wrap the whole
  // thing in <MemoryRouter initialEntries={['/']}>.
  const buildSpliceNode = (suppressRouterWrap = false): t.JSXExpressionContainer | t.JSXElement => {
    const inner: t.JSXExpressionContainer | t.JSXElement = opts.composeWithUserWrapper
      ? t.jsxElement(
          t.jsxOpeningElement(t.jsxIdentifier('UserWrapper'), [], false),
          t.jsxClosingElement(t.jsxIdentifier('UserWrapper')),
          [t.jsxExpressionContainer(t.identifier('children'))],
          false,
        )
      : t.jsxExpressionContainer(t.identifier('children'));
    if (!opts.wrapInMemoryRouter || suppressRouterWrap) return inner;
    return t.jsxElement(
      t.jsxOpeningElement(
        t.jsxIdentifier('MemoryRouter'),
        [
          t.jsxAttribute(
            t.jsxIdentifier('initialEntries'),
            t.jsxExpressionContainer(t.arrayExpression([t.stringLiteral('/')])),
          ),
        ],
        false,
      ),
      t.jsxClosingElement(t.jsxIdentifier('MemoryRouter')),
      [inner],
      false,
    );
  };

  // Apply rewrite rules to a single element. Returns `true` if the
  // element was structurally replaced (the caller should then stop
  // recursing into it).
  const applyRewriteToElement = (path: NodePath<t.JSXElement>): boolean => {
    const opening = path.node.openingElement;
    const name = jsxOpeningName(opening);
    if (!name) return false;

    // Replace <RouterProvider router={…}> with <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>.
    // We DO NOT recurse into RouterProvider's children — they're
    // typically <Routes>/<Route> trees that pull lazy chunks for the
    // entire app.
    if (rewrites.replaceWithMemoryRouter.has(name)) {
      // Capture the chain BEFORE the replacement detaches the path: the
      // substituted <MemoryRouter> becomes the innermost expected provider.
      capturedChain = [...chainAbove(path), 'MemoryRouter'];
      const memoryRouter = makeMemoryRouterWithChildren(opts.composeWithUserWrapper);
      path.replaceWith(memoryRouter);
      spliceAlreadyInjected = true;
      // The router's route-config subtree is now gone, unanalyzed — flag it so
      // fidelity refuses to bless the (known-incomplete) expected chain.
      routerSubtreeDiscarded = true;
      return true;
    }

    const rule = rewrites.renames.get(name);
    if (rule) {
      opening.name = t.jsxIdentifier(rule.to);
      if (path.node.closingElement) {
        path.node.closingElement.name = t.jsxIdentifier(rule.to);
      }
      if (rule.addAttrs && rule.addAttrs.length > 0) {
        const have = new Set(
          opening.attributes
            .filter((a): a is t.JSXAttribute => t.isJSXAttribute(a))
            .map((a) => (t.isJSXIdentifier(a.name) ? a.name.name : '')),
        );
        for (const attr of rule.addAttrs) {
          const attrName = t.isJSXIdentifier(attr.name) ? attr.name.name : '';
          if (!have.has(attrName)) opening.attributes.push(attr);
        }
      }
    }
    return false;
  };

  // First pass: rename / strip-and-replace router elements. Handle the
  // root JSXElement explicitly because `traverse` only walks descendants.
  let rootStructurallyReplaced = false;
  if (jsxRoot.isJSXElement()) {
    rootStructurallyReplaced = applyRewriteToElement(jsxRoot as NodePath<t.JSXElement>);
  }
  if (!rootStructurallyReplaced) {
    jsxRoot.traverse({
      JSXElement(path) {
        if (applyRewriteToElement(path)) path.skip();
      },
    });
  }

  // If the first pass already inserted a `{children}` slot (e.g. via the
  // RouterProvider→MemoryRouter substitution), we're done — don't try to
  // splice on top of it.
  if (spliceAlreadyInjected)
    return { expectedProviderChain: capturedChain, routerSubtreeDiscarded };

  // Second pass: pick the splice point.
  let bestCandidate: NodePath<t.JSXElement> | null = null;
  let bestDepth = -1;

  // `path.traverse` walks DESCENDANTS only — but the mount call's JSX
  // arg might *itself* be the splice point (e.g. `render(<App />)`). So
  // we check the root explicitly before traversing.
  if (jsxRoot.isJSXElement()) {
    const rootElem = jsxRoot as NodePath<t.JSXElement>;
    const rootName = jsxOpeningName(rootElem.node.openingElement);
    if (rootName && relativeDefaultImports.has(rootName)) {
      bestCandidate = rootElem;
      bestDepth = 0;
    }
  }

  jsxRoot.traverse({
    JSXElement(path) {
      const name = jsxOpeningName(path.node.openingElement);
      if (!name) return;
      const depth = jsxDepth(path);
      if (relativeDefaultImports.has(name)) {
        if (depth > bestDepth) {
          bestCandidate = path;
          bestDepth = depth;
        }
      }
    },
  });

  if (!bestCandidate) {
    // Fallback: deepest JSX leaf — but skip elements that already have
    // an expression-container child (i.e. someone or something put
    // {children} in there).
    let deepestLeaf: NodePath<t.JSXElement> | null = null;
    let deepestLeafDepth = -1;
    const consider = (path: NodePath<t.JSXElement>) => {
      const hasJsxChild = path.node.children.some((c) => t.isJSXElement(c) || t.isJSXFragment(c));
      if (hasJsxChild) return;
      const depth = jsxDepth(path);
      if (depth > deepestLeafDepth) {
        deepestLeaf = path;
        deepestLeafDepth = depth;
      }
    };
    if (jsxRoot.isJSXElement()) consider(jsxRoot as NodePath<t.JSXElement>);
    jsxRoot.traverse({
      JSXElement(path) {
        consider(path);
      },
    });
    bestCandidate = deepestLeaf;
  }

  if (bestCandidate !== null) {
    const target = bestCandidate as NodePath<t.JSXElement>;
    // Deep-clone the splice target's module when it is a relative default
    // import: the target's own providers (App.tsx) nest around the slot.
    const targetName = jsxOpeningName(target.node.openingElement);
    let deep: DeepCloneResolution | null = null;
    if (targetName && relativeDefaultImports.has(targetName) && opts.deepResolve) {
      const source = defaultImports.get(targetName);
      if (source) deep = opts.deepResolve(source);
    }
    const prefix = deep?.prefix ?? null;
    // A router inside the cloned prefix makes the detector-driven outer
    // MemoryRouter redundant (it would nest two).
    const suppressRouterWrap = prefix?.foundRouter === true;
    // The chain is the target's ancestors (the target itself becomes the
    // `{children}` slot); cloned prefix members follow, and an injected
    // <MemoryRouter> from buildSpliceNode is the innermost expected member.
    const chain = chainAbove(target);
    if (prefix) chain.push(...prefix.chainNames);
    if (opts.wrapInMemoryRouter && !suppressRouterWrap) chain.push('MemoryRouter');
    target.replaceWith(
      prefix
        ? nestPrefixElements(
            prefix.elements.map((el) => t.cloneNode(el, true)),
            buildSpliceNode(suppressRouterWrap),
          )
        : buildSpliceNode(suppressRouterWrap),
    );
    return {
      expectedProviderChain: chain,
      ...(prefix?.routerSubtreeDiscarded ? { routerSubtreeDiscarded: true } : {}),
      deep,
    };
  }
  return { expectedProviderChain: [] };
}

function makeMemoryRouterWithChildren(composeWithUserWrapper: boolean): t.JSXElement {
  const opening = t.jsxOpeningElement(
    t.jsxIdentifier('MemoryRouter'),
    [
      t.jsxAttribute(
        t.jsxIdentifier('initialEntries'),
        t.jsxExpressionContainer(t.arrayExpression([t.stringLiteral('/')])),
      ),
    ],
    false,
  );
  const closing = t.jsxClosingElement(t.jsxIdentifier('MemoryRouter'));
  const inner: t.JSXExpressionContainer | t.JSXElement = composeWithUserWrapper
    ? t.jsxElement(
        t.jsxOpeningElement(t.jsxIdentifier('UserWrapper'), [], false),
        t.jsxClosingElement(t.jsxIdentifier('UserWrapper')),
        [t.jsxExpressionContainer(t.identifier('children'))],
        false,
      )
    : t.jsxExpressionContainer(t.identifier('children'));
  return t.jsxElement(opening, closing, [inner], false);
}

/**
 * "Router lives inside App.tsx, not main.tsx" detector.
 *
 * The cloner picks `<App />` as the splice point and outputs the wrapper
 * as `<Provider>{children}</Provider>`. If the user's Router setup lives
 * one level down — `createBrowserRouter([...])` + `<RouterProvider/>`
 * inside `App.tsx`, which is the React Router 6.4+ data-router pattern —
 * then the wrapper has no Router context and any rendered component that
 * calls useNavigate/useLocation/useParams throws on mount.
 *
 * We can't statically reproduce the user's route table, but we can
 * inject `<MemoryRouter>` around `{children}` so hooks that just need a
 * Router context (the common case for components rendered in isolation)
 * resolve cleanly.
 *
 * Returns true when the entry file does NOT import any react-router-dom
 * Router primitive (the existing rewrite path already handles those),
 * AND any relative default-imported file does. Conservative: only scans
 * direct neighbors of the entry, not the full transitive tree, so the
 * extra cost is one or two file reads.
 */
function detectRouterContextNeeded(ast: t.File, entryAbs: string): boolean {
  const ROUTER_PRIMITIVES = new Set([
    'BrowserRouter',
    'HashRouter',
    'MemoryRouter',
    'RouterProvider',
  ]);

  // 1. If the entry file already imports a Router primitive, the
  // existing rewrite path (BrowserRouter→MemoryRouter, RouterProvider
  // strip-and-replace) handles it. Skip — adding another <MemoryRouter>
  // would nest two of them.
  for (const stmt of ast.program.body) {
    if (!t.isImportDeclaration(stmt)) continue;
    if (stmt.source.value !== 'react-router-dom') continue;
    for (const spec of stmt.specifiers) {
      if (!t.isImportSpecifier(spec)) continue;
      const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
      if (ROUTER_PRIMITIVES.has(imported)) return false;
    }
  }

  // 2. Scan relative default-imported files (typically App.tsx). If any
  // imports react-router-dom, the splice point needs a Router wrapper.
  // Quick text-level scan — no need to parse to AST just for this.
  const entryDir = dirname(entryAbs);
  for (const stmt of ast.program.body) {
    if (!t.isImportDeclaration(stmt)) continue;
    const source = stmt.source.value;
    if (!source.startsWith('.')) continue;
    const hasDefault = stmt.specifiers.some((s) => t.isImportDefaultSpecifier(s));
    if (!hasDefault) continue;

    const resolved = resolveRelativeImportPath(entryDir, source);
    if (!resolved) continue;
    let content: string;
    try {
      content = readFileSync(resolved, 'utf-8');
    } catch {
      continue;
    }
    if (/from\s+['"]react-router-dom['"]/.test(content)) return true;
  }
  return false;
}

/**
 * Resolve a relative import specifier to a real file path on disk,
 * trying the usual TS/JS extension and index variants. Returns null
 * when nothing matches.
 */
function resolveRelativeImportPath(fromDir: string, source: string): string | null {
  const base = resolve(fromDir, source);
  const candidates = [
    base,
    base + '.tsx',
    base + '.ts',
    base + '.jsx',
    base + '.js',
    resolve(base, 'index.tsx'),
    resolve(base, 'index.ts'),
    resolve(base, 'index.jsx'),
    resolve(base, 'index.js'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

function jsxOpeningName(opening: t.JSXOpeningElement): string | null {
  const name = opening.name;
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name)) {
    // e.g. ReactDOM.Foo — return the last segment.
    let seg = name;
    while (t.isJSXMemberExpression(seg.object)) seg = seg.object;
    return t.isJSXIdentifier(seg.property) ? seg.property.name : null;
  }
  return null;
}

function jsxDepth(path: NodePath): number {
  let depth = 0;
  let cur: NodePath | null = path.parentPath;
  while (cur) {
    if (cur.isJSXElement() || cur.isJSXFragment()) depth++;
    cur = cur.parentPath;
  }
  return depth;
}

/* ------------------------------------------------------------------ */
/* Reference + hoist analysis                                            */
/* ------------------------------------------------------------------ */

/** Collect all referenced identifiers (any JSX tag name + any expression Identifier). */
function collectIdentifiers(scope: NodePath<t.Node> | t.Node): Set<string> {
  const root = (scope as { node?: t.Node }).node ?? (scope as t.Node);
  const refs = new Set<string>();

  const visit = {
    Identifier(path: NodePath<t.Identifier>) {
      // Skip property names of member expressions (e.g. `foo.bar` — `bar`
      // is a property, not a free identifier).
      if (
        t.isMemberExpression(path.parent) &&
        path.parent.property === path.node &&
        !path.parent.computed
      ) {
        return;
      }
      // Skip object-pattern keys (destructuring property names).
      if (
        t.isObjectProperty(path.parent) &&
        path.parent.key === path.node &&
        !path.parent.computed
      ) {
        return;
      }
      refs.add(path.node.name);
    },
    JSXIdentifier(path: NodePath<t.JSXIdentifier>) {
      // JSXIdentifiers appear as element names, attr names, and member-expr
      // segments. Treat the OUTERMOST one (element name root) as a reference;
      // attribute names and prop keys aren't free idents.
      const parent = path.parent;
      if (
        t.isJSXOpeningElement(parent) ||
        t.isJSXClosingElement(parent) ||
        (t.isJSXMemberExpression(parent) && parent.object === path.node)
      ) {
        // Only the leftmost segment is a free reference (Foo in <Foo.Bar/>).
        if (t.isJSXMemberExpression(parent)) {
          // Walk up to find the leftmost root.
          let cur: t.Node = parent;
          while (t.isJSXMemberExpression(cur) && t.isJSXMemberExpression(cur.object)) {
            cur = cur.object;
          }
          if (
            t.isJSXMemberExpression(cur) &&
            t.isJSXIdentifier(cur.object) &&
            cur.object === path.node
          ) {
            refs.add(path.node.name);
          }
        } else {
          refs.add(path.node.name);
        }
      }
    },
  };

  if ((scope as NodePath).traverse) {
    (scope as NodePath).traverse(visit);
  } else {
    traverse(t.file(t.program([t.expressionStatement(root as t.Expression)])), visit);
  }

  return refs;
}

/**
 * Find top-level const/let/var declarations whose names are referenced
 * by `referenced`, then iteratively expand the set to include any
 * declarations the hoisted bodies themselves reference. Returns the
 * declarations in source order so they can be emitted as-is.
 */
function collectHoistedDeclarations(
  ast: t.File,
  referenced: Set<string>,
): NodePath<t.VariableDeclaration>[] {
  // Index top-level VariableDeclarations by their declared names.
  const topLevel: Array<{ path: NodePath<t.VariableDeclaration>; names: string[] }> = [];
  traverse(ast, {
    VariableDeclaration(path: NodePath<t.VariableDeclaration>) {
      if (!t.isProgram(path.parent)) return;
      const names: string[] = [];
      for (const decl of path.node.declarations) {
        if (t.isIdentifier(decl.id)) names.push(decl.id.name);
      }
      if (names.length > 0) topLevel.push({ path, names });
    },
  });

  const want = new Set(referenced);
  const picked = new Set<NodePath<t.VariableDeclaration>>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of topLevel) {
      if (picked.has(entry.path)) continue;
      const matchesNeed = entry.names.some((n) => want.has(n));
      if (!matchesNeed) continue;
      picked.add(entry.path);
      changed = true;
      // Expand: any identifiers referenced inside the picked decl's body
      // are now also "want" candidates.
      const idsInDecl = collectIdentifiers(entry.path);
      for (const id of idsInDecl) want.add(id);
    }
  }

  // Return in source order.
  return topLevel.filter((e) => picked.has(e.path)).map((e) => e.path);
}

function declarationNames(decls: NodePath<t.VariableDeclaration>[]): string[] {
  const names: string[] = [];
  for (const path of decls) {
    for (const decl of path.node.declarations) {
      if (t.isIdentifier(decl.id)) names.push(decl.id.name);
    }
  }
  return names;
}

/* ------------------------------------------------------------------ */
/* Imports                                                              */
/* ------------------------------------------------------------------ */

interface ImportSpec {
  /** "default" | "namespace" | "named:Foo" | "type-only:Foo". */
  kind: 'default' | 'namespace' | 'named';
  /** Imported identifier name (the value imported). */
  imported: string;
  /** Local binding name. */
  local: string;
  /** True if this specifier was a TypeScript `import type`. */
  typeOnly: boolean;
}

interface ImportRecord {
  source: string;
  specifiers: ImportSpec[];
  /** True for `import 'x'` side-effect-only imports. */
  sideEffect: boolean;
}

interface ImportInfo {
  imports: ImportRecord[];
  sideEffects: ImportRecord[];
}

/**
 * Collect every import in the entry file, then keep:
 *  - side-effect imports (CSS, font setup) unconditionally
 *  - imports whose specifiers' local names are referenced in `referenced`
 * Filters out specifiers we shouldn't emit (e.g. BrowserRouter when the
 * rewrite swapped it for MemoryRouter).
 */
function collectImports(ast: t.File, referenced: Set<string>): ImportInfo {
  const rewrites = buildRewrites();
  const imports: ImportRecord[] = [];
  const sideEffects: ImportRecord[] = [];

  // Track whether react-router-dom needs MemoryRouter added (because we
  // rewrote BrowserRouter/HashRouter out and in).
  let routerSourceUsed: string | null = null;

  traverse(ast, {
    ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
      const decl = path.node;
      const source = decl.source.value;
      if (decl.specifiers.length === 0) {
        sideEffects.push({ source, specifiers: [], sideEffect: true });
        return;
      }
      const specs: ImportSpec[] = [];
      for (const spec of decl.specifiers) {
        if (t.isImportDefaultSpecifier(spec)) {
          specs.push({
            kind: 'default',
            imported: 'default',
            local: spec.local.name,
            typeOnly: decl.importKind === 'type',
          });
        } else if (t.isImportNamespaceSpecifier(spec)) {
          specs.push({
            kind: 'namespace',
            imported: '*',
            local: spec.local.name,
            typeOnly: decl.importKind === 'type',
          });
        } else if (t.isImportSpecifier(spec)) {
          const importedName = t.isIdentifier(spec.imported)
            ? spec.imported.name
            : spec.imported.value;
          specs.push({
            kind: 'named',
            imported: importedName,
            local: spec.local.name,
            typeOnly: decl.importKind === 'type' || spec.importKind === 'type',
          });
          if (
            (importedName === 'BrowserRouter' || importedName === 'HashRouter') &&
            source === 'react-router-dom'
          ) {
            routerSourceUsed = source;
          }
        }
      }
      const filtered = specs.filter((s) => {
        // Drop the imports we swapped away.
        if (rewrites.stripImportNames.has(s.imported)) return false;
        if (rewrites.replaceWithMemoryRouter.has(s.imported)) return false;
        return referenced.has(s.local);
      });
      if (filtered.length === 0) {
        // No specifiers left after filtering — don't emit a stray
        // `import {} from 'foo'`.
        return;
      }
      imports.push({ source, specifiers: filtered, sideEffect: false });
    },
  });

  // If we rewrote BrowserRouter→MemoryRouter or stripped RouterProvider,
  // ensure MemoryRouter is imported. Find any existing react-router-dom
  // import record and append; otherwise add a fresh one.
  const needsMemoryRouter =
    routerSourceUsed != null ||
    /* RouterProvider detection: */
    Array.from(referenced).some((r) => r === 'MemoryRouter');
  if (needsMemoryRouter || referenced.has('MemoryRouter')) {
    let existing = imports.find((i) => i.source === 'react-router-dom');
    if (!existing) {
      existing = { source: 'react-router-dom', specifiers: [], sideEffect: false };
      imports.push(existing);
    }
    if (!existing.specifiers.some((s) => s.local === 'MemoryRouter')) {
      existing.specifiers.push({
        kind: 'named',
        imported: 'MemoryRouter',
        local: 'MemoryRouter',
        typeOnly: false,
      });
    }
  }

  return { imports, sideEffects };
}

/**
 * Union two already-path-rewritten import lists. Records to the same source
 * merge specifier-by-specifier; duplicate (kind, imported, local) triples
 * collapse. Local-name conflicts never reach here — the deep-clone resolver
 * pre-checks and bails on any ambiguous binding.
 */
function mergeImportRecords(base: ImportRecord[], extra: ImportRecord[]): ImportRecord[] {
  const out = base.map((r) => ({ ...r, specifiers: [...r.specifiers] }));
  for (const rec of extra) {
    const existing = out.find((r) => r.sideEffect === rec.sideEffect && r.source === rec.source);
    if (!existing) {
      out.push({ ...rec, specifiers: [...rec.specifiers] });
      continue;
    }
    for (const spec of rec.specifiers) {
      const dupe = existing.specifiers.some(
        (s) => s.kind === spec.kind && s.imported === spec.imported && s.local === spec.local,
      );
      if (!dupe) existing.specifiers.push(spec);
    }
  }
  return out;
}

function rewriteImportPath(imp: ImportRecord, fromDir: string, toDir: string): ImportRecord {
  const src = imp.source;
  if (!src.startsWith('.')) return imp; // bare or absolute — leave alone
  const absolutized = resolve(fromDir, src);
  let rel = relative(toDir, absolutized).replaceAll('\\', '/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return { ...imp, source: rel };
}

function printImport(imp: ImportRecord): string {
  if (imp.sideEffect) return `import '${imp.source}';`;
  const defaults = imp.specifiers.filter((s) => s.kind === 'default');
  const namespaces = imp.specifiers.filter((s) => s.kind === 'namespace');
  const named = imp.specifiers.filter((s) => s.kind === 'named');
  const parts: string[] = [];
  if (defaults.length > 0) parts.push(defaults[0]!.local);
  if (namespaces.length > 0) parts.push(`* as ${namespaces[0]!.local}`);
  if (named.length > 0) {
    parts.push(
      `{ ${named
        .map((s) => {
          const inner = s.imported === s.local ? s.local : `${s.imported} as ${s.local}`;
          return s.typeOnly ? `type ${inner}` : inner;
        })
        .join(', ')} }`,
    );
  }
  return `import ${parts.join(', ')} from '${imp.source}';`;
}

function collectDefaultImports(jsxRoot: NodePath<t.Node>): {
  defaultImports: Map<string, string>;
  relativeDefaultImports: Set<string>;
} {
  const file = (jsxRoot as NodePath).findParent((p) => p.isProgram())?.node as
    | t.Program
    | undefined;
  const defaultImports = new Map<string, string>();
  const relativeDefaultImports = new Set<string>();
  if (!file) return { defaultImports, relativeDefaultImports };
  for (const stmt of file.body) {
    if (!t.isImportDeclaration(stmt)) continue;
    const source = stmt.source.value;
    for (const spec of stmt.specifiers) {
      if (t.isImportDefaultSpecifier(spec)) {
        defaultImports.set(spec.local.name, source);
        if (source.startsWith('.')) relativeDefaultImports.add(spec.local.name);
      }
    }
  }
  return { defaultImports, relativeDefaultImports };
}

/* ------------------------------------------------------------------ */
/* Marker + passthrough                                                 */
/* ------------------------------------------------------------------ */

interface PassthroughOpts {
  validityVersion: string;
  reason: string;
}

export function passthroughTemplate(
  opts: PassthroughOpts & { composeWithUserWrapper?: boolean },
): string {
  const composes = opts.composeWithUserWrapper === true;
  const body = [
    `import type { ReactNode } from 'react';`,
    ...(composes ? [`import UserWrapper from './wrapper.user';`] : []),
    ``,
    // `colorScheme` carries the active theme during a verify run's color-scheme
    // axis (undefined otherwise). Forwarded to UserWrapper so a ThemeProvider
    // app can switch theme from it.
    `export default function Wrapper({ children, colorScheme }: { children: ReactNode; colorScheme?: "light" | "dark" }) {`,
    composes
      ? `  return <UserWrapper colorScheme={colorScheme}>{children}</UserWrapper>;`
      : `  void colorScheme;\n  return <>{children}</>;`,
    `}`,
    ``,
  ].join('\n');
  return wrapMarker({
    body,
    validityVersion: opts.validityVersion,
    reason: opts.reason,
  });
}

interface MarkerOpts {
  body: string;
  validityVersion: string;
  /** Project-relative entry the cloner used. Optional for passthroughs. */
  entryFile?: string;
  /** Reason the cloner fell back. Optional for successful clones. */
  reason?: string;
}

/**
 * Prepend the marker header used by the drift detector to recognize
 * Validity-managed files. The hash is sha256(body) truncated to 16 hex
 * chars; on read, we re-hash everything below the marker and compare.
 * Mismatch = user edited the generated file. The header is exactly
 * three lines so the hash check can skip them deterministically.
 */
export function wrapMarker(opts: MarkerOpts): string {
  const hash = sha256First16(opts.body);
  const at = new Date().toISOString();
  const reason = opts.reason ? `; ${opts.reason}` : '';
  const entry = opts.entryFile ? `; entry=${opts.entryFile}` : '';
  const header = [
    `// @validity-generated do-not-edit hash=${hash} at=${at} validity=${opts.validityVersion}${entry}${reason}`,
    `// Edit .validity/wrapper.user.tsx instead — anything you put there wraps the generated tree.`,
    `// Regenerate manually with: validity init --force`,
    '',
  ].join('\n');
  return header + opts.body;
}

const MARKER_LINE_COUNT = 3;

export interface ParsedMarker {
  hash: string;
  at?: string;
  validityVersion?: string;
  entryFile?: string;
  reason?: string;
}

/** Parse the marker line if present. Returns undefined when missing. */
export function parseMarker(source: string): ParsedMarker | undefined {
  const firstLine = source.split('\n', 1)[0] ?? '';
  const m = firstLine.match(/^\/\/ @validity-generated do-not-edit (.+)$/);
  if (!m) return undefined;
  // Tokenize key=value pairs separated by whitespace OR `;`. The
  // optional reason field can contain words, so we capture only the
  // recognized keys and let the rest (including spaces) flow into the
  // last-known key.
  const fields: Record<string, string> = {};
  // Match `<key>=<value>` where value is either a "quoted string" or a
  // run of non-whitespace, non-`;` characters.
  const pairRe = /(\w+)=(\S+?)(?=\s|;|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pairRe.exec(m[1]!)) !== null) {
    fields[match[1]!] = match[2]!;
  }
  if (!fields.hash) return undefined;
  return {
    hash: fields.hash,
    at: fields.at,
    validityVersion: fields.validity,
    entryFile: fields.entry,
    reason: fields.reason,
  };
}

/**
 * Does the on-disk file's content match the marker's hash? True = file
 * is Validity-owned and untouched. False = either no marker or user
 * edited the body.
 */
export function isManagedAndUntouched(source: string): boolean {
  const marker = parseMarker(source);
  if (!marker) return false;
  const lines = source.split('\n');
  const body = lines.slice(MARKER_LINE_COUNT).join('\n');
  return sha256First16(body) === marker.hash;
}

function sha256First16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ */
/* Misc helpers                                                         */
/* ------------------------------------------------------------------ */

function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => (l.length === 0 ? l : prefix + l))
    .join('\n');
}

/** Readable file mtime+size for cache-key use. Returns null on error. */
export function fingerprintFile(path: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}
