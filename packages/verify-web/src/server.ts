import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createRequire } from 'node:module';
import getPort from 'get-port';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildCatalog,
  containedFile,
  localRequestStatus,
  buildComponentUsageMap,
  buildNavigationGraph,
  discoverComponentFiles,
  discoverDesignTokens,
  discoverScreenFiles,
  extractPropsType,
  inferFixtures,
  summarizeProps,
  type ResolvedNavigationEdge,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import {
  createLogger,
  createServer,
  loadConfigFromFile,
  mergeConfig,
  normalizePath,
  type InlineConfig,
  type Plugin,
  type UserConfig,
  type ViteDevServer,
} from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { validityDir } from './paths.js';
import {
  deleteViewFromConfig,
  writeComponentScenariosToConfig,
  writeFixtureToConfig,
  writeViewToConfig,
  type WriteViewItem,
} from './browse/fixture-writer.js';
import { attachBridge, type BridgeHandle } from './browse/bridge.js';
import { buildExpoWebViteOverrides } from './expo-web-aliases.js';
import { flowStripPlugin } from './flow-strip.js';
import { expoWebRequirePlugin } from './expo-web-require.js';
import { buildNextWebViteOverrides } from './next-web-aliases.js';
import { sandboxTailwindDedupeTargets, validityTailwindDedupePlugin } from './tailwind-dedupe.js';
import { buildAppManifestOverrides } from './app-manifest-merge.js';

/**
 * Resolve the directory of @mswjs/interceptors as installed alongside
 * @validity.ai/verify-web. We bundle it as a dep so the user's project doesn't
 * need to install it themselves; Vite is then aliased to load the browser
 * bundle from this absolute path.
 *
 * The package's `exports` map blocks direct `package.json` lookup, so we
 * resolve the top-level entry and walk up two segments
 * (lib/node/index.cjs → package root) to find the dir.
 */
/**
 * Try to resolve a transitive dep from the user's project root, so the
 * sandbox can alias bare specifiers (`react-helmet-async`) even when the
 * dep is only reachable through an intermediate package (pnpm hoists by
 * design but never flattens transitive deps to the top-level). Returns
 * the absolute package directory or null.
 *
 * Used to give the validity wrapper.user.tsx a stable way to import
 * common-but-transitive providers like HelmetProvider (vite-react-ssg
 * → react-helmet-async) without forcing the user to add it as a direct
 * dependency just to render in the sandbox.
 */
function resolveTransitiveDep(projectRoot: string, pkgName: string): string | null {
  // 1. Try standard Node resolution from the project root. Works when the
  //    package is a direct (or hoisted top-level) dep — pnpm only flattens
  //    deps the user has listed in package.json.
  try {
    const reqFromProject = createRequire(resolve(projectRoot, 'package.json'));
    const entry = reqFromProject.resolve(pkgName);
    let cur = dirname(entry);
    for (let i = 0; i < 8; i++) {
      try {
        const pkgPath = resolve(cur, 'package.json');
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
          if (pkg.name === pkgName) return cur;
        }
      } catch {
        /* keep walking */
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  } catch {
    /* fall through to pnpm scan */
  }
  // 2. pnpm fallback: scan node_modules/.pnpm/<pkgName>@<version>/node_modules/<pkgName>/.
  //    Picks the first match — multiple versions of the same package end
  //    up as separate folders, all valid for our purpose (component
  //    rendering is forgiving about minor version differences in transitive
  //    deps).
  try {
    const pnpmRoot = resolve(projectRoot, 'node_modules', '.pnpm');
    if (!existsSync(pnpmRoot)) return null;
    const entries = readdirSync(pnpmRoot);
    // pnpm encodes scoped packages with '+' in place of '/': '@scope+name@1.0.0'.
    const escaped = pkgName.replace('/', '+');
    const prefix = escaped + '@';
    for (const dir of entries) {
      if (!dir.startsWith(prefix)) continue;
      const candidate = resolve(pnpmRoot, dir, 'node_modules', pkgName);
      const pkgJson = resolve(candidate, 'package.json');
      if (existsSync(pkgJson)) return candidate;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * For each of `pkgNames`, return a Vite resolve.alias entry pointing
 * the bare specifier at its resolved location in `projectRoot`'s
 * node_modules. Packages that don't resolve are silently skipped — the
 * sandbox simply doesn't expose them and any wrapper import will fail
 * cleanly with Vite's normal "Failed to resolve import" message.
 */
function autoResolveTransitiveAliases(
  projectRoot: string,
  pkgNames: string[],
): Array<{ find: string; replacement: string }> {
  const out: Array<{ find: string; replacement: string }> = [];
  for (const name of pkgNames) {
    const dir = resolveTransitiveDep(projectRoot, name);
    if (dir) out.push({ find: name, replacement: dir });
  }
  return out;
}

function resolveMswInterceptorsDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@mswjs/interceptors');
    // entry is like /path/to/@mswjs/interceptors/lib/node/index.cjs.
    // Walk up until we hit a dir whose basename is 'interceptors'.
    let cur = dirname(entry);
    for (let i = 0; i < 6; i++) {
      const base = cur.split('/').pop();
      if (base === 'interceptors') return cur;
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface DevServer {
  url: string;
  port: number;
  server: ViteDevServer;
  close: () => Promise<void>;
  /**
   * LLM → page command bridge. Only attached when `startDevServer` was
   * called with `config` (browse mode); verify-only servers leave this
   * undefined since the verify flow has no live page for an agent to drive.
   */
  bridge?: BridgeHandle;
  /**
   * Rejects when Vite's background dependency optimizer (esbuild pre-bundle)
   * fails — e.g. a dep ships syntax esbuild can't parse (Flow-typed RN core).
   * That failure surfaces as a process `unhandledRejection`, NOT as a rejection
   * of `createServer`/`listen`, and with `optimizeDeps.force` the server then
   * holds every module request forever. Consumers (renderComponents) race their
   * work against this so a doomed optimize fails the verify in seconds with the
   * esbuild error, instead of each capture burning its full timeout. Never
   * resolves; a no-op `.catch` is pre-attached so it can't itself become an
   * unhandled rejection when nobody races it (e.g. browse mode).
   */
  fatalError: Promise<never>;
  /**
   * Non-empty once Vite's dependency pre-scan (esbuild over
   * `optimizeDeps.entries`) has ABORTED. The scan failure is silent-fatal by
   * default: Vite logs one red block, degrades to lazy dep discovery, and a
   * mid-session re-optimize reload can then swap the React instance under a
   * mounting tree ("Invalid hook call… more than one copy of React") — renders
   * corrupt with nothing pointing at the stray import that killed the scan.
   * The value is a one-line summary naming the unresolvable import(s) and the
   * file(s) that pulled them in; renderComponents stamps it onto every
   * ComponentRender so verdicts can carry a `dep-scan` evidence taint.
   */
  depScanFailure: () => string | undefined;
  /**
   * One-line provenance for `.validity/app-manifest.json` (written by
   * `@validity.ai/verify-plugin-vite` from inside the user's real Vite build), in the
   * shape "app manifest present; mirrored: …; recorded: …" — or a named
   * reason there wasn't one ("app manifest absent", "app manifest
   * unsupported-version", "app manifest ignored (web.useAppManifest: false)").
   *
   * `mirrored` names what this server ACTUALLY folded into its Vite config;
   * `recorded` names what was read but only written down. The split is the
   * point: a reader must never mistake "we know your app uses Tailwind v3 via
   * PostCSS" for "we rendered your app with Tailwind v3".
   */
  appManifest: string;
}

export interface StartDevServerOptions {
  /**
   * When set, the dev server registers extra middleware that exposes the
   * resolved ValidityConfig + scenario state to the browser (browse mode).
   * Verify mode passes nothing — those endpoints stay off so verify's
   * Playwright path is unchanged.
   */
  config?: ValidityConfig;
  /**
   * When true, the caller intends to keep the server alive past a single
   * verify cycle (browse mode). Doesn't change Vite config today, but is
   * carried in the return value so renderComponents can detect a persistent
   * server it should leave alone instead of closing.
   */
  persist?: boolean;
  /**
   * Prefer this port if available (browse mode --port). When unset, Vite
   * picks a free port via getPort().
   */
  preferredPort?: number;
  /**
   * Toolchain we're rendering for. `'web'` (default) is the standard Vite
   * / react-dom path; `'expo-web'` adds `react-native` → `react-native-web`
   * aliases and stubs out gesture-handler / reanimated where no web build
   * exists; `'next-web'` adds `next/link`/`next/router`/`next/navigation`/
   * `next/image`/`next/font`/`next/dynamic`/`next/headers` stubs so Next.js
   * client components render through the standard web path. Set by
   * `renderComponents` from the resolved framework.
   */
  target?: 'web' | 'expo-web' | 'next-web';
  /**
   * `ValidityConfig.web.useAppManifest`. Verify passes this explicitly because
   * it deliberately does NOT set `config` (that field is the browse-mode API
   * switch), yet still needs to honor the user's opt-out. Undefined means
   * "consume the manifest when the file exists" — installing
   * `@validity.ai/verify-plugin-vite` is the opt-in.
   */
  useAppManifest?: boolean;
}

const VITE_CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];

async function loadUserViteConfig(projectRoot: string): Promise<UserConfig> {
  for (const name of VITE_CONFIG_NAMES) {
    const candidate = resolve(projectRoot, name);
    if (existsSync(candidate)) {
      let viteVersion: string | undefined;
      try {
        const require = createRequire(resolve(projectRoot, 'package.json'));
        viteVersion = require('vite/package.json').version;
      } catch {
        // Non-Vite apps can still use the bundled sandbox.
      }
      if (viteVersion && Number.parseInt(viteVersion, 10) >= 8) {
        throw new Error(
          `Validity's Vite 6 sandbox cannot load Vite ${viteVersion} / Rolldown plugins. ` +
            'Use npm install -D vite@6.4.3 @vitejs/plugin-react@4.7.0 in the app, then retry. ' +
            'Vite 8 sandbox support is not available yet.',
        );
      }
      const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, candidate);
      if (loaded) return loaded.config;
    }
  }
  return {};
}

/**
 * Path-rewrite the user's `resolve.alias` so relative replacements still
 * resolve against the project root. The user's vite.config typically
 * declares aliases relative to its own location (the project root), but
 * Vite resolves relative `replacement` strings against the *configured*
 * root — and we set root to `node_modules/.validity/`, which would point
 * those aliases at the wrong place. Absolutizing here keeps the user's
 * intent intact regardless of where the sandbox lives.
 */
function absolutizeAliases(config: UserConfig, projectRoot: string): UserConfig {
  const alias = config.resolve?.alias;
  if (!alias) return config;
  const fixOne = (replacement: unknown): unknown => {
    if (typeof replacement !== 'string') return replacement;
    if (isAbsolute(replacement)) return replacement;
    if (replacement.startsWith('.')) return resolve(projectRoot, replacement);
    return replacement;
  };
  if (Array.isArray(alias)) {
    return {
      ...config,
      resolve: {
        ...config.resolve,
        alias: alias.map((a) => ({ ...a, replacement: fixOne(a.replacement) as string })),
      },
    };
  }
  // Object form: { '@': './src' } → { '@': '/abs/path/to/src' }
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(alias as Record<string, string>)) {
    next[k] = fixOne(v) as string;
  }
  return { ...config, resolve: { ...config.resolve, alias: next } };
}

/**
 * Detect whether the user already has a tsconfig-paths-style plugin in
 * their Vite config. We only auto-inject `vite-tsconfig-paths` when (a)
 * the user has a tsconfig with `paths` declared, and (b) they haven't
 * already wired in a plugin that handles it. Avoids stomping on custom
 * resolution setups (`vite-tsconfig-paths`, `unplugin-vue-tsconfig-paths`,
 * hand-rolled alias mirroring).
 */
function userHasTsconfigPathsPlugin(config: UserConfig): boolean {
  const plugins = (config.plugins ?? []) as unknown[];
  const flat: unknown[] = plugins.flat(Infinity as unknown as number);
  return flat.some((p) => {
    const name = (p as { name?: string } | null)?.name;
    return typeof name === 'string' && name.includes('tsconfig-paths');
  });
}

function tsconfigDeclaresPaths(projectRoot: string): boolean {
  const tsconfigPath = resolve(projectRoot, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return false;
  try {
    // Strip line + block comments before parsing — tsconfig.json is
    // permissive in a way JSON.parse isn't.
    const raw = readFileSync(tsconfigPath, 'utf-8');
    const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const parsed = JSON.parse(stripped) as {
      compilerOptions?: { paths?: Record<string, unknown>; baseUrl?: string };
    };
    const paths = parsed.compilerOptions?.paths;
    if (paths && Object.keys(paths).length > 0) return true;
    // baseUrl alone (without paths) also enables bare-import resolution
    // inside src/ — same fix applies.
    if (parsed.compilerOptions?.baseUrl) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Resolve the publicDir Vite should serve from. Defaults to the user's
 * `<projectRoot>/public` dir; if the user's vite.config sets a custom
 * `publicDir`, we honor it (relative paths get absolutized against the
 * project root). Setting `publicDir: false` in user config disables it.
 *
 * Without this override, Vite would default `publicDir` to
 * `<root>/public` — but we set root to `node_modules/.validity/`, which
 * has no public dir, so any user reference to `/foo.svg` would 404.
 */
function resolvePublicDir(config: UserConfig, projectRoot: string): string | false {
  const userPublicDir = config.publicDir;
  if (userPublicDir === false) return false;
  if (typeof userPublicDir === 'string') {
    return isAbsolute(userPublicDir) ? userPublicDir : resolve(projectRoot, userPublicDir);
  }
  return resolve(projectRoot, 'public');
}

/**
 * fast-glob (and tinyglobby, which Vite uses for `optimizeDeps.entries`)
 * expects forward-slash paths even on Windows. Absolutize + normalize so
 * the patterns work regardless of the user's platform.
 */
function toGlobPath(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Build the entry list that Vite's initial esbuild scan walks. Two
 * categories:
 *
 *   1. Sandbox entry files (entry.tsx, validity-index.tsx). Listed as
 *      explicit absolute paths because they live inside node_modules/
 *      which the negation patterns below would otherwise exclude.
 *   2. The user's component tree. A broad glob over the project root
 *      with the usual heavyweight dirs excluded — node_modules, .git,
 *      dist, build, .next, and the validity runs cache (which we never
 *      want to walk back into).
 *
 * The point is to short-circuit lazy discovery: every React-hook-calling
 * lib the user might depend on must be findable from a static scan, or
 * Vite re-optimizes the moment a component pulls it in, and the resulting
 * full-reload may not fire in time (or at all, if HMR is suppressed).
 * See the "two copies of React" bug write-up.
 *
 * Path exclusions are nested-glob (`** /node_modules/**`, etc.) because
 * monorepos commonly have node_modules under `apps/*` and `packages/*`,
 * not just at the project root. A pattern anchored at `${root}/node_modules/**`
 * would let the scanner walk into `apps/web/node_modules/typescript/lib/*.js`
 * and try to bundle TypeScript itself — that's how we ended up with the
 * "Failed to resolve entry for package 'devtools-protocol'" cascade.
 *
 * `**\/*.d.ts` is excluded explicitly because `.d.ts` matches the
 * `*.ts` part of the include pattern but its declaration-only syntax
 * (`export const X: T;` with no initializer) can't be parsed by esbuild
 * in implementation mode and surfaces as `The constant "X" must be
 * initialized`.
 */
/**
 * Parse the `packages:` list out of a pnpm-workspace.yaml. The format is
 * constrained enough that a regex pass beats pulling in a YAML parser:
 *
 *   packages:
 *     - 'apps/*'
 *     - "packages/*"
 *     - examples/foo
 *
 * Returns the raw pattern strings (no glob expansion). Unparseable files
 * yield an empty array — the caller treats that as "no workspace info".
 */
function parsePnpmWorkspacePackages(content: string): string[] {
  const lines = content.split('\n');
  const patterns: string[] = [];
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    // Indented list item ("  - 'apps/*'", "  - apps/*", "  - \"apps/*\"").
    const m = /^\s+-\s+(?:'([^']+)'|"([^"]+)"|([^\s'"#]+))\s*$/.exec(line);
    if (m) {
      const value = m[1] ?? m[2] ?? m[3];
      if (value) patterns.push(value);
      continue;
    }
    // Any non-indented, non-blank line terminates the block.
    if (line.length > 0 && /^\S/.test(line)) inPackages = false;
  }
  return patterns;
}

/**
 * Read workspace package globs from the project root. pnpm-workspace.yaml
 * wins if present; otherwise fall back to `workspaces` in package.json
 * (array or `{ packages: [...] }` object form, both common).
 */
function readWorkspacePatterns(projectRoot: string): string[] {
  const pnpmYaml = resolve(projectRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpmYaml)) {
    try {
      return parsePnpmWorkspacePackages(readFileSync(pnpmYaml, 'utf-8'));
    } catch {
      // fall through to package.json
    }
  }
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) return ws;
    if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) return ws.packages;
    return [];
  } catch {
    return [];
  }
}

/**
 * Expand a single workspace glob (`apps/*`, `packages/*`, or a literal
 * path like `examples/foo`) to absolute directories. Only the trailing
 * `/*` form is treated as a glob — anything more exotic (`apps/**`,
 * a star mid-path) is left alone. Workspace configs in the wild almost
 * always use the `dir/*` shape.
 */
function expandWorkspacePattern(projectRoot: string, pattern: string): string[] {
  if (pattern.includes('**')) return []; // not worth supporting
  const trimmed = pattern.replace(/\/+$/, '');
  if (!trimmed.endsWith('/*')) {
    const abs = resolve(projectRoot, trimmed);
    return existsSync(abs) ? [abs] : [];
  }
  const parent = trimmed.slice(0, -2);
  const parentAbs = resolve(projectRoot, parent);
  if (!existsSync(parentAbs)) return [];
  let children: string[];
  try {
    children = readdirSync(parentAbs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const child of children) {
    if (child.startsWith('.')) continue;
    const abs = resolve(parentAbs, child);
    try {
      if (statSync(abs).isDirectory()) out.push(abs);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/**
 * Discover every workspace package in this project and map its
 * `package.json` name → its absolute on-disk directory. Used to seed
 * Vite's resolve.alias so an iframe rendered out of `apps/web/src/...`
 * can import `@scope/shared` (or any other workspace sibling) even
 * when the sandbox runs from the monorepo root and the user's
 * workspace package isn't symlinked into the root `node_modules`
 * (the common pnpm / yarn-berry layout).
 *
 * Without this, `import { api } from '@scope/backend/_generated/api'`
 * inside an app component fails with "Failed to resolve import" because
 * Vite's bare-spec walker, starting from `node_modules/.validity/`,
 * never sees `packages/backend/`.
 *
 * Discovery is best-effort: missing or unparseable package.jsons are
 * silently skipped (we don't want a single bad workspace entry to
 * blow up browse boot). Order is unspecified — Vite handles alias
 * collisions deterministically by find-string.
 */
function discoverWorkspacePackageAliases(
  projectRoot: string,
): Array<{ find: string; replacement: string }> {
  const patterns = readWorkspacePatterns(projectRoot);
  if (patterns.length === 0) return [];
  const out: Array<{ find: string; replacement: string }> = [];
  for (const pattern of patterns) {
    for (const dir of expandWorkspacePattern(projectRoot, pattern)) {
      const pkgPath = resolve(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string };
        if (typeof pkg.name === 'string' && pkg.name.length > 0) {
          out.push({ find: pkg.name, replacement: dir });
        }
      } catch {
        /* ignore unparseable workspace package.json */
      }
    }
  }
  // Sort longest-find first so Vite's prefix-match never lets a shorter
  // alias (e.g. `@scope/foo`) shadow a longer one (`@scope/foo-extras`).
  out.sort((a, b) => b.find.length - a.find.length);
  return out;
}

/**
 * Server frameworks and server-side-React template kits. A workspace whose
 * only React signal is `react` itself, sitting next to one of these, is a
 * backend rendering JSX for emails / SSR strings — not browser code. Real
 * case: an Express API workspace added `react` for jsx-email templates,
 * passed the old "declares react" check, and its `@tensorflow/tfjs-node`
 * import fed @mapbox/node-pre-gyp to the browser dep scan (which died on
 * its .html file and phantom `aws-sdk` / `mock-aws-s3` requires).
 */
const SERVER_SIDE_REACT_SIGNALS = [
  'express',
  'fastify',
  'koa',
  'hono',
  '@nestjs/core',
  'jsx-email',
  'react-email',
  '@react-email/components',
  '@react-email/render',
];

/**
 * Should the dep optimizer's pre-scan walk this workspace package? Only if
 * it plausibly renders React in a browser. A workspace with no React in its
 * dep tree is server-only code as far as the app under verification is
 * concerned — scanning it just gives esbuild a chance to follow
 * `require('better-sqlite3')` into a native binding and crash the optimizer.
 *
 * `react-dom` / `react-native` / `expo` in any dep bucket is a definite
 * browser/UI signal. Bare `react` alone is ambiguous: shared component
 * libraries commonly declare only a `react` peer dep (keep scanning those),
 * but so do servers that render JSX for emails or SSR — those are told
 * apart by the server-framework signals above.
 */
export function workspaceRendersReactUi(workspaceDir: string): boolean {
  const pkgPath = resolve(workspaceDir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  let deps: Record<string, string>;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  } catch {
    return false;
  }
  if (deps['react-dom'] || deps['react-native'] || deps['expo']) return true;
  if (!deps['react']) return false;
  return !SERVER_SIDE_REACT_SIGNALS.some((name) => name in deps);
}

/**
 * Convert a `.gitignore` body into a list of negative tinyglobby globs
 * rooted at `root`. Handles the common patterns we care about
 * (directory names, `*.ext`, leading `/` for anchored paths) and
 * deliberately ignores the more exotic gitignore semantics (`!` un-ignore,
 * `**` matchers, character classes) — pulling in a real gitignore parser
 * for a "stop scanning scratch dirs" feature isn't worth the bundle weight,
 * and the worst case of a missed pattern is the user re-encountering the
 * old behavior they were already hitting.
 *
 * The point isn't airtight `.gitignore` fidelity — it's letting users opt
 * out of the optimizer scan by adding a directory to `.gitignore`, which
 * is the move they're already making for their editor / git / dev tools.
 */
function gitignoreToGlobExcludes(content: string, root: string): string[] {
  const out: string[] = [];
  for (const raw of content.split('\n')) {
    let line = raw;
    const hash = line.indexOf('#');
    if (hash !== -1) line = line.slice(0, hash);
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('!')) continue;
    // Skip patterns with whitespace (rarely useful, hard to handle).
    if (/\s/.test(line)) continue;
    // Skip character classes — too easy to mis-translate.
    if (line.includes('[')) continue;

    let pattern = line;
    const anchored = pattern.startsWith('/');
    if (anchored) pattern = pattern.slice(1);
    const isDirOnly = pattern.endsWith('/');
    if (isDirOnly) pattern = pattern.slice(0, -1);
    if (!pattern) continue;

    // Anchored patterns (`/dist`) only match at the project root.
    // Unanchored patterns (`dist`, `*.log`) match at any depth.
    const prefix = anchored ? `${root}/` : `${root}/**/`;

    if (isDirOnly) {
      out.push(`!${prefix}${pattern}/**`);
    } else {
      // Could be a file OR a directory name — emit both forms.
      out.push(`!${prefix}${pattern}`);
      out.push(`!${prefix}${pattern}/**`);
    }
  }
  return out;
}

/**
 * Walk `projectRoot/.gitignore` and `<workspace>/.gitignore` for each
 * resolved workspace dir, returning combined glob exclusions. Nested
 * gitignores live inside their workspace dir, so we re-root them when
 * converting (they apply relative to where they live, not the project
 * root).
 *
 * Reading order is deliberate: project root first, then workspaces.
 * Duplicates don't matter — tinyglobby de-dupes negation patterns.
 */
function collectGitignoreExcludes(projectRoot: string, workspaceDirs: readonly string[]): string[] {
  const out: string[] = [];
  const root = toGlobPath(projectRoot);
  const rootGitignore = resolve(projectRoot, '.gitignore');
  if (existsSync(rootGitignore)) {
    try {
      out.push(...gitignoreToGlobExcludes(readFileSync(rootGitignore, 'utf-8'), root));
    } catch {
      /* ignore */
    }
  }
  for (const ws of workspaceDirs) {
    const wsGitignore = resolve(ws, '.gitignore');
    if (!existsSync(wsGitignore)) continue;
    try {
      out.push(...gitignoreToGlobExcludes(readFileSync(wsGitignore, 'utf-8'), toGlobPath(ws)));
    } catch {
      /* ignore */
    }
  }
  return out;
}

function buildOptimizeDepsEntries(projectRoot: string, dir: string): string[] {
  const root = toGlobPath(projectRoot);

  // Workspace-aware exclusions: in pnpm / yarn / npm monorepos, sibling
  // workspaces commonly include server-only code (Express APIs, worker
  // scripts) that pulls in native-binding deps (better-sqlite3 →
  // @mapbox/node-pre-gyp → fsevents → @resvg/resvg-js platform .node
  // files). esbuild walks the broad `**/*.{tsx,…}` include, hits those
  // files, follows the imports, and dies on the .node bindings or the
  // missing optional deps (mock-aws-s3, aws-sdk).
  //
  // Heuristic: a workspace package with no browser-rendering signal in its
  // dep buckets (see workspaceRendersReactUi) is not React-browser code.
  // Exclude its tree from the scan. The active React package (the one
  // validity is rendering for) still gets scanned because either (a) it's
  // the projectRoot itself, or (b) it carries a UI signal in its own
  // package.json. Note the exclusion only removes the workspace's files as
  // scan ENTRY POINTS — a shared UI workspace the app imports is still
  // traversed by esbuild following the app's imports.
  const workspacePatterns = readWorkspacePatterns(projectRoot);
  const workspaceDirs = workspacePatterns.flatMap((p) => expandWorkspacePattern(projectRoot, p));
  const nonReactWorkspaceExcludes: string[] = [];
  for (const ws of workspaceDirs) {
    if (workspaceRendersReactUi(ws)) continue;
    nonReactWorkspaceExcludes.push(`!${toGlobPath(ws)}/**`);
  }

  // Build-tooling config files (eslint.config.js, vite.config.ts,
  // tailwind.config.js, playwright.config.ts, .eslintrc.js, …) are
  // Node-side tooling — never part of the rendered browser app — but
  // they match the broad `**/*.{ts,js,…}` include, so esbuild's dep
  // pre-scan walks them and follows their imports. Those imports are
  // routinely devDependencies that are missing, optional, or simply
  // unresolvable in a browser context (a real case: eslint.config.js
  // importing an uninstalled eslint-plugin-storybook).
  //
  // When the scan hits one it can't resolve it errors out, and the
  // whole point of `optimizeDeps.entries` — discovering every dep up
  // front — silently fails. The fallout is not a visible error, it's a
  // render corruption chain:
  //   scan aborts → deps get discovered lazily mid-session → Vite logs
  //   "new dependencies optimized: …" and forces a reload → the reload
  //   swaps the React module instance out from under a mounting tree →
  //   "Invalid hook call … you might have more than one copy of React".
  // Components then fail to mount and criteria come back `unverifiable`
  // even though the project has exactly one React copy installed. That
  // causality is invisible from a stack trace, hence this comment.
  //
  // Anchored to the project root and to workspace roots ONLY (`/*.`,
  // not `/**/*.`) — application source that merely has "config" in its
  // name deeper in the tree (`src/lib/config.ts`, `src/config/routes.ts`)
  // is real render-path code and must still be scanned.
  const toolingConfigExcludes: string[] = [];
  for (const base of [root, ...workspaceDirs.map(toGlobPath)]) {
    toolingConfigExcludes.push(`!${base}/*.config.{js,cjs,mjs,ts,cts,mts}`);
    // Dotfile-style configs (.eslintrc.js, .prettierrc.js, .stylelintrc.js).
    toolingConfigExcludes.push(`!${base}/.*rc.{js,cjs,mjs,ts,cts,mts}`);
  }

  // Honor .gitignore — users have already curated scratch / experiment
  // directories there (a `tmp/some-old-demo/` with its own index.html
  // and unsatisfied imports is enough to fail Vite's dep scan, since
  // Vite's default `optimizeDeps.entries` includes `**/*.html`).
  const gitignoreExcludes = collectGitignoreExcludes(projectRoot, workspaceDirs);

  return [
    toGlobPath(resolve(dir, 'entry.tsx')),
    toGlobPath(resolve(dir, 'validity-index.tsx')),
    `${root}/**/*.{tsx,jsx,ts,js,mts,mjs,cts,cjs}`,
    // Nested-glob exclusions — match `node_modules` at any depth.
    `!${root}/**/node_modules/**`,
    `!${root}/**/.git/**`,
    `!${root}/**/dist/**`,
    `!${root}/**/build/**`,
    `!${root}/**/out/**`,
    `!${root}/**/.next/**`,
    `!${root}/**/.nuxt/**`,
    `!${root}/**/.turbo/**`,
    `!${root}/**/.cache/**`,
    `!${root}/**/.svelte-kit/**`,
    `!${root}/**/.astro/**`,
    `!${root}/**/.vercel/**`,
    `!${root}/**/.wrangler/**`,
    `!${root}/**/.vite/**`,
    `!${root}/**/coverage/**`,
    `!${root}/**/.validity/runs/**`,
    // .d.ts files: see fn docstring. esbuild's strip-types mode can't
    // parse ambient declarations.
    `!${root}/**/*.d.ts`,
    // Test / E2E / benchmark files are Node-side test-runner code — they
    // drive the app from the outside and are never part of the rendered
    // browser app — but they match the broad `**/*.{ts,js,…}` include, so
    // esbuild's dep pre-scan walks them and follows their imports into
    // heavyweight Node-only toolchains. A real case: blunders.ai's root
    // `e2e-test.mjs` / `openings-e2e-test.mjs` import Playwright, the scan
    // follows into playwright-core, and dies on chromium-bidi's lazy /
    // optional requires ("Could not resolve chromium-bidi/lib/cjs/…").
    //
    // Same silent failure chain as the tooling configs above: the scan
    // aborts → `optimizeDeps.entries` comes back incomplete → the missing
    // deps get discovered lazily mid-session → Vite forces a reload → the
    // reload swaps the React module instance out from under a mounting
    // tree → "Invalid hook call … more than one copy of React". Components
    // never mount and criteria come back `unverifiable`, with nothing in
    // the output pointing at a stray test file as the cause.
    //
    // Unlike the tooling-config excludes these are depth-globbed: a
    // `src/foo.test.ts` poisons the scan exactly as much as a root one.
    // The patterns stay anchored to real filename boundaries (`.test.`,
    // `-e2e.`) rather than bare substrings — app source like
    // `src/lib/e2eHelpers.ts`, `src/contest.ts` or `src/latest.ts` is
    // render-path code and must still be scanned.
    `!${root}/**/*.{test,spec,e2e}.{tsx,jsx,ts,js,mts,mjs,cts,cjs}`,
    `!${root}/**/*-{test,e2e}.{tsx,jsx,ts,js,mts,mjs,cts,cjs}`,
    // Conventional test directories, at any depth.
    `!${root}/**/{__tests__,e2e,cypress,playwright}/**`,
    ...toolingConfigExcludes,
    ...nonReactWorkspaceExcludes,
    ...gitignoreExcludes,
  ];
}

/**
 * Suppress HMR updates for files in the user's source tree. Vite's own
 * full-reload signal (fired after a mid-session dep re-optimization) is
 * emitted via `server.ws.send({ type: 'full-reload', path: '*' })` and
 * does NOT go through plugin `handleHotUpdate` hooks — so this plugin
 * neutralizes file-change HMR without breaking the dep-reoptimize recovery
 * path. node_modules updates pass through (Vite hot-reloads its own internal
 * client modules; suppressing those would break the page).
 *
 * Only installed for the verify path (no `options.config`). Browse mode
 * wants Fast Refresh / full-reload so the design-plane iframes update as
 * the user (or an LLM) edits component source.
 */
function validitySuppressUserHmrPlugin(projectRoot: string): Plugin {
  const root = projectRoot.endsWith('/') ? projectRoot : `${projectRoot}/`;
  return {
    name: 'validity:suppress-user-hmr',
    handleHotUpdate(ctx) {
      const file = ctx.file;
      if (file.startsWith(root) && !file.includes('/node_modules/')) {
        return [];
      }
      return undefined;
    },
  };
}

export async function startDevServer(
  projectRoot: string,
  options: StartDevServerOptions = {},
): Promise<DevServer> {
  // Vite resolves module IDs through symlinks; fs.allow and aliases must use
  // the same root, or /tmp → /private/tmp can fall through to raw TSX serving.
  projectRoot = realpathSync(projectRoot);
  const dir = validityDir(projectRoot);
  const userConfigRaw = await loadUserViteConfig(projectRoot);
  const userConfig = absolutizeAliases(userConfigRaw, projectRoot);
  const mswInterceptorsDir = resolveMswInterceptorsDir();
  const publicDirAbs = resolvePublicDir(userConfig, projectRoot);

  // Inject vite-tsconfig-paths when the user has tsconfig paths/baseUrl
  // configured but hasn't already wired up a resolver. This is the silent
  // fix that lets user components do `import Foo from '@/components/Foo'`
  // (or bare imports under `baseUrl: 'src'`) without the sandbox throwing
  // "Failed to resolve import" — Vite doesn't natively read tsconfig
  // `paths`. We pin the root explicitly so the plugin doesn't walk from
  // process.cwd() (which may not be the project root in MCP contexts).
  const injectedPlugins: NonNullable<InlineConfig['plugins']> = [];
  if (!userHasTsconfigPathsPlugin(userConfig) && tsconfigDeclaresPaths(projectRoot)) {
    injectedPlugins.push(tsconfigPaths({ root: projectRoot }));
  }

  // Tailwind-build dedupe (web + expo-web). When the Tailwind v4 shim is active
  // AND a project entry stylesheet exists, the shim already produces the one
  // complete Tailwind build; a direct import of that same stylesheet (the cloned
  // wrapper, a component) would spawn a SECOND, partial build whose re-declared
  // base utilities clobber the shim's responsive variants. This neutralizes the
  // duplicate. Off (null) for non-Tailwind projects and the bare-`tailwindcss`
  // fallback shim, which has no user entry to double-import. See tailwind-dedupe.ts.
  const tailwindDedupeTargets = sandboxTailwindDedupeTargets(projectRoot);
  if (tailwindDedupeTargets) {
    injectedPlugins.push(validityTailwindDedupePlugin(tailwindDedupeTargets));
  }

  // Browse-mode API routes — registered via configureServer (pre-hook form)
  // so they install BEFORE Vite's internal spaFallbackMiddleware +
  // indexHtmlMiddleware. If we registered them imperatively after
  // createServer (or returned the post-hook `() => { … }` form), every
  // GET /__validity/api/* would be swallowed by the SPA fallback and the
  // browse Index sidebar would mysteriously show an empty state. The
  // catch-all consumes the request first; the plugin form runs first.
  if (options.config) {
    const configRef = options.config;
    injectedPlugins.push({
      name: 'validity:api',
      configureServer(server) {
        registerValidityMiddlewares(server, projectRoot, configRef);
      },
    });
  }

  // Verify mode only: swallow HMR for user files but leave Vite's own
  // full-reload signal alone. The verify canvas is a one-shot screenshot
  // surface — we don't want a typo in the user's source to hot-swap the
  // rendered component out from under Playwright mid-capture. But we DO
  // need the page to reload after Vite re-runs its dep optimizer
  // mid-session, otherwise the page lives with two React module records
  // (old ?v= hash for already-imported deps, new ?v= hash for the
  // just-discovered ones) and any hook-calling lib crashes with
  // "Cannot read properties of null (reading 'useState')".
  //
  // handleHotUpdate runs for file-change events. Vite's dep-reoptimize
  // full-reload is emitted directly via server.ws.send({ type: 'full-reload' })
  // and does NOT go through handleHotUpdate, so returning [] here suppresses
  // user-file HMR without touching the recovery path.
  //
  // Browse mode (options.config set) opts OUT of suppression so the
  // design-plane iframes refresh as the user — or an LLM — edits their
  // components. If the user's vite.config registers @vitejs/plugin-react
  // they get Fast Refresh; otherwise Vite falls back to a full reload of
  // the iframe, which is still what the iteration loop expects.
  if (!options.config) {
    injectedPlugins.push(validitySuppressUserHmrPlugin(projectRoot));
  }

  // Expo Web only: rewrite Metro-style `require('literal')` in the user's
  // own source into hoisted ESM imports. RN/Expo source (e.g. Ignite's
  // theme/context.utils.ts → `const systemui = require('expo-system-ui')`)
  // is normally transformed by Metro; Vite serves it as ESM with no
  // `require` global, so without this the render red-screens on
  // "require is not defined" even when every real ESM import linked fine.
  if (options.target === 'expo-web') {
    injectedPlugins.push(expoWebRequirePlugin(projectRoot));
  }

  const port = options.preferredPort
    ? await getPort({ port: options.preferredPort })
    : await getPort();

  // Expo Web rendering: rewrite `react-native` → `react-native-web` and
  // route reanimated/gesture-handler/svg through our shims when the user
  // has them installed. The aliases land in front of any user-supplied
  // resolve.alias entries (Vite picks the longest/first match), so a
  // project with its own RN-Web setup still wins on conflicts.
  const expoOverrides =
    options.target === 'expo-web' ? buildExpoWebViteOverrides(projectRoot) : null;
  // Next.js rendering: stub `next/link`/`next/router`/`next/navigation`/
  // `next/image`/`next/font`/`next/dynamic`/`next/headers` so client
  // components render through the standard web path. Server Components,
  // Route Handlers, and Middleware are out of scope (require Next's server
  // runtime).
  const nextOverrides =
    options.target === 'next-web' ? buildNextWebViteOverrides(projectRoot) : null;

  // Route every Vite log line to stderr. The MCP server's stdio transport
  // uses process.stdout for the JSON-RPC protocol, so any incidental write to
  // stdout from inside Vite (or any plugin) corrupts the wire format and
  // Claude Code closes the connection.
  const stderrLogger = createLogger('warn', { allowClearScreen: false });
  const stderrify = (write: (msg: string) => void) => (msg: string) => {
    write(msg);
  };
  stderrLogger.info = stderrify((m) => process.stderr.write(`${m}\n`));
  stderrLogger.warn = stderrify((m) => process.stderr.write(`${m}\n`));
  stderrLogger.warnOnce = stderrify((m) => process.stderr.write(`${m}\n`));
  // `error` additionally watches for the dep pre-scan abort. Vite catches the
  // scanner's esbuild failure internally (`logger.error(e.stack || e.message)`
  // in its depsOptimizer — it never throws and never trips the
  // unhandledRejection trap below), so this log line is the ONLY observable
  // signal that the scan died. Capture it, name the offender loudly, and let
  // renderComponents taint the run's verdicts via `depScanFailure`.
  const depScanFailureBox: { summary?: string } = {};
  // Assigned after createServer below; the logger hook fires from inside
  // Vite so the server object always exists by then, but TS can't see that.
  const viteServerBox: { server?: ViteDevServer } = {};
  stderrLogger.error = stderrify((m) => {
    process.stderr.write(`${m}\n`);
    if (!depScanFailureBox.summary && isDepScanFailureLog(m)) {
      depScanFailureBox.summary = summarizeDepScanFailure(m);
      process.stderr.write(depScanAbortBanner(depScanFailureBox.summary));
      // Any page already open is hanging on /.vite-cache/deps/* requests the
      // dead optimizer will never answer. Force a reload: the fresh requests
      // hit the guard middleware below, which answers with a throwing module,
      // and the sandbox's inline error trap turns that into a visible banner.
      viteServerBox.server?.ws.send({ type: 'full-reload', path: '*' });
    }
  });

  // Pre-bundled-dep requests block forever once the pre-scan has aborted —
  // Vite's optimizer never commits, so its middleware awaits a promise that
  // never settles. The page shows nothing: no error, no console output, just
  // an eternal spinner (all source modules serve 200; only deps hang). Answer
  // those requests ourselves with a module that throws the scan summary, so
  // the failure lands in the page as a data-validity-error banner instead of
  // a silent hang.
  injectedPlugins.push({
    name: 'validity:dep-scan-guard',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const summary = depScanFailureBox.summary;
        if (!summary || !req.url || !req.url.includes('/.vite-cache/deps/')) {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/javascript');
        res.end(depScanFailureModuleSource(summary));
      });
    },
  });

  // Sandbox-owned aliases, extracted so the app-manifest merge can see which
  // `find` keys are already claimed before it gap-fills (see
  // app-manifest-merge.ts for the full precedence rule). Order is unchanged
  // from when this lived inline in `overrides.resolve.alias`.
  //
  // Aliases (in order, since Vite matches longest-find first within
  // the array): MSW shim (always when installed), then Expo Web
  // overrides (react-native → react-native-web, gesture-handler stub,
  // etc.) when the caller asked for expo-web.
  const sandboxAlias: Array<{ find: string | RegExp; replacement: string }> = [
    ...(mswInterceptorsDir
      ? [
          {
            find: '@mswjs/interceptors/fetch',
            replacement: resolve(mswInterceptorsDir, 'lib/browser/interceptors/fetch/index.mjs'),
          },
          {
            find: '@mswjs/interceptors/XMLHttpRequest',
            replacement: resolve(
              mswInterceptorsDir,
              'lib/browser/interceptors/XMLHttpRequest/index.mjs',
            ),
          },
          {
            find: '@mswjs/interceptors',
            replacement: resolve(mswInterceptorsDir, 'lib/browser/index.mjs'),
          },
        ]
      : []),
    // Force react / react-dom to a concrete on-disk path. Vite's
    // default resolver walks `node_modules` upward from the importer
    // (here: `node_modules/.validity/entry.tsx`), which works for
    // npm/yarn but breaks on pnpm workspaces where react lives at
    // `apps/<name>/node_modules/react` — there's no `react` at the
    // workspace root, so the walk fails with
    // "Failed to resolve import 'react'". `resolveTransitiveDep`
    // uses Node's createRequire + a pnpm-store scan, which finds
    // the package even when Vite can't.
    //
    // Same treatment for common-but-transitive ecosystem packages
    // (react-helmet-async is the canonical case — vite-react-ssg's
    // <Head /> needs HelmetProvider in the tree but the user rarely
    // lists it as a direct dep).
    // Monorepo workspace packages first — these are typically scoped
    // (`@scope/name`) so they never collide with the unscoped aliases
    // below, but Vite still does longest-prefix matching, so getting
    // them in front of the generic 'react' alias is the safe move.
    ...discoverWorkspacePackageAliases(projectRoot),
    // Order matters: Vite's `find` does prefix-match on strings, so
    // 'react-dom' must come before 'react' (otherwise an import of
    // `react-dom` would hit the 'react' alias and resolve to
    // `/path/to/react-dom`'s suffix relative to /path/to/react/).
    ...autoResolveTransitiveAliases(projectRoot, ['react-helmet-async', 'react-dom', 'react']),
    ...(expoOverrides?.alias ?? []),
    ...(nextOverrides?.alias ?? []),
  ];

  // `.validity/app-manifest.json`, when the user installed
  // `@validity.ai/verify-plugin-vite`. Additive only: it supplies `envDir` (without
  // which the sandbox reads NO `.env` file and `import.meta.env.VITE_*` is
  // empty), the app's PostCSS config path (without which a Tailwind v3
  // project renders unstyled), and gap-fill aliases. It never displaces a
  // sandbox-owned alias or a user-declared one. See app-manifest-merge.ts.
  const manifestOverrides = buildAppManifestOverrides({
    projectRoot,
    // Verify passes the flag explicitly (it has the config but doesn't set
    // `options.config`, which is the browse-mode API switch); browse mode
    // carries the whole config. Undefined from both means "on when present".
    useAppManifest: options.useAppManifest ?? options.config?.web?.useAppManifest,
    userConfig,
    sandboxAlias,
  });
  // Log everything EXCEPT plain absence — no manifest is the default state for
  // every project that hasn't installed the plugin, and a line per verify
  // saying so would be pure noise. A manifest that exists but was rejected or
  // ignored is the opposite: that MUST be visible, or a user debugging why
  // their env didn't apply has nothing to go on.
  if (manifestOverrides.provenance !== 'app manifest absent') {
    process.stderr.write(`[validity] ${manifestOverrides.provenance}\n`);
  }

  const overrides: InlineConfig = {
    root: dir,
    configFile: false,
    // Override publicDir explicitly: Vite's default is `<root>/public`
    // and our root is node_modules/.validity/, so leaving the default
    // would 404 every `<img src="/foo.svg">` / `url(/fonts/x.woff2)`
    // reference into the user's actual public/ dir.
    publicDir: publicDirAbs,
    // App-manifest env repair. Vite resolves `envDir` against `root`, and our
    // root is `node_modules/.validity/` — so WITHOUT this the sandbox loads no
    // `.env` file at all and `import.meta.env.VITE_*` is empty, which makes
    // every env-gated branch in the user's components silently render its
    // fallback. Only applied when the manifest names a dir (i.e. the user
    // installed @validity.ai/verify-plugin-vite and hasn't set `web.useAppManifest:
    // false`), so behavior is unchanged for everyone else.
    ...(manifestOverrides.envDir ? { envDir: manifestOverrides.envDir } : {}),
    ...(manifestOverrides.envPrefix ? { envPrefix: manifestOverrides.envPrefix } : {}),
    // Same root problem for PostCSS discovery, which matters most for Tailwind
    // v3 projects: they wire Tailwind through PostCSS, and the sandbox's
    // Tailwind shim only covers v4. Skipped when the user's own vite.config
    // already declares `css.postcss` — that value is live, the manifest's may
    // be a run behind.
    ...(manifestOverrides.postcssConfigPath
      ? { css: { postcss: manifestOverrides.postcssConfigPath } }
      : {}),
    // Expo Web: Metro defines the `__DEV__` global for all RN source. Vite
    // doesn't, so real RN packages (reanimated, expo-system-ui, …) that
    // reference `__DEV__` at module eval throw "__DEV__ is not defined".
    // Define it as `false` (production-like render) for user source served
    // by Vite; the optimizer gets its own copy via esbuildOptions.define so
    // pre-bundled deps fold it too. Web/Next targets don't need it.
    ...(options.target === 'expo-web' ? { define: { __DEV__: 'false' } } : {}),
    plugins: injectedPlugins,
    server: {
      port,
      host: '127.0.0.1',
      strictPort: true,
      fs: {
        allow: [projectRoot, dir, ...(publicDirAbs ? [publicDirAbs] : [])],
      },
      // Intentionally NOT setting hmr: false. We need Vite's websocket alive
      // so the dep-reoptimize full-reload signal can fire after a new dep is
      // discovered mid-session (Radix, headless-ui, downshift, anything that
      // calls React hooks and isn't in the initial scan). User-file HMR is
      // suppressed via validitySuppressUserHmrPlugin above — the canvas
      // stays static, but Vite can still trigger a full page reload to
      // recover from re-optimization. See the bug write-up under
      // "two copies of React" for the failure mode this restores recovery for.
    },
    cacheDir: resolve(dir, '.vite-cache'),
    clearScreen: false,
    logLevel: 'warn',
    customLogger: stderrLogger,
    // Bump above Vite's chrome87 default so dep pre-bundling accepts
    // top-level await — modern packages (ink, yoga-layout, many CLI tools
    // pulled in transitively when a project uses Vite for both web + Node)
    // need it, and esbuild fails the whole sandbox if any dep does.
    //
    // Force the automatic JSX runtime. Without this, esbuild falls back to
    // its default classic transform (`React.createElement`) because we run
    // Vite at `root: node_modules/.validity/` which has no tsconfig.json
    // for esbuild to read `compilerOptions.jsx` from. Modern user entries
    // typically don't `import React from 'react'` — they rely on the
    // automatic runtime — so the cloner correctly omits React from
    // wrapper.gen.tsx; then esbuild's classic transform tries to call
    // React.createElement and throws "React is not defined" inside the
    // wrapper. The automatic runtime emits `import { jsx } from 'react/jsx-runtime'`
    // instead, which doesn't need React in scope.
    //
    // If the user's vite.config registers @vitejs/plugin-react, that
    // plugin takes over JSX transformation for matched files and our
    // esbuild jsx setting is bypassed — so this setting is purely a
    // safe fallback for the "no react plugin" path.
    esbuild: {
      target: 'es2022',
      jsx: 'automatic',
      jsxImportSource: 'react',
    },
    resolve: {
      // Force a single copy of react / react-dom regardless of where the
      // import enters from (entry.tsx, the user's wrapper, the user's
      // component, react-dom internals). With pnpm symlinks this is
      // critical — without it React-DOM may resolve a different `react`
      // than the entry, and you get "React is not defined" deep inside
      // react-dom-client at runtime.
      //
      // Expo Web target additionally dedupes `react-native-web` so the
      // StyleSheet registry / AppRegistry singletons aren't doubled when
      // the user imports RN primitives from multiple subpaths.
      dedupe:
        options.target === 'expo-web'
          ? ['react', 'react-dom', 'react-native-web']
          : ['react', 'react-dom'],
      // Expo Web: prioritize `.web.*` platform extensions, the way Metro/Expo
      // resolve for the web target. RN ecosystem libraries (react-native-
      // screens, etc.) ship `Foo.web.js` web implementations next to the native
      // `Foo.js`; the native files import RN core internals (AppContainer,
      // Core/Devtools/*) that are Flow-typed source esbuild can't parse and that
      // don't run on web anyway. Without this, Vite's default extension list
      // picks the native file and the dep optimizer hard-fails. Keep the
      // standard extensions after the `.web.*` set so non-RN files still resolve.
      ...(options.target === 'expo-web'
        ? {
            extensions: [
              '.web.mjs',
              '.web.js',
              '.web.mts',
              '.web.ts',
              '.web.jsx',
              '.web.tsx',
              '.mjs',
              '.js',
              '.mts',
              '.ts',
              '.jsx',
              '.tsx',
              '.json',
            ],
          }
        : {}),
      // Aliases, in Vite's own priority order (first match wins within the
      // array): the sandbox's own set (MSW shim, react dedupe, workspace
      // packages, expo/next overrides), then the app-manifest's GAP-FILL
      // entries — `find` keys neither the sandbox nor the user's vite.config
      // declares. See app-manifest-merge.ts for why manifest aliases can only
      // ever add resolution, never redirect it.
      alias: [...sandboxAlias, ...manifestOverrides.alias],
    },
    optimizeDeps: {
      // Force the dep optimizer to re-scan on every run. Without this, Vite
      // reuses cached pre-bundled deps from .vite-cache; if the project
      // changed react versions (or any dep we depend on), the cached bundle
      // is stale and you get cryptic "Cannot read properties of undefined"
      // errors from the wrong-version code. Sub-second cost on a warm cache
      // dir, vs. hours of debugging when it goes wrong.
      force: true,
      // Tell Vite's initial esbuild scan to walk every user source file at
      // boot, not just the sandbox entry. Without this, components are only
      // discovered when the browser actually requests them (entry.tsx uses
      // import.meta.glob to resolve them lazily) — and any React-hook-calling
      // lib transitively imported by a not-yet-clicked component (Radix UI is
      // the canonical example) gets pre-bundled mid-session. Vite then bumps
      // the browserHash and emits a full-reload over HMR; with HMR enabled
      // (see server.hmr above) the page reloads cleanly. Without entries,
      // the discovery window is enormous and the recovery path runs often.
      // With entries, the recovery rarely needs to fire at all.
      entries: buildOptimizeDepsEntries(projectRoot, dir),
      include: [
        'react',
        'react/jsx-runtime',
        // @vitejs/plugin-react emits dev-runtime JSX in dev. If it isn't
        // pre-bundled at boot, the first component render lazily triggers
        // it, which is exactly the re-optimization path we're trying to
        // avoid. Cheap to include unconditionally.
        'react/jsx-dev-runtime',
        // Bare 'react-dom' alongside 'react-dom/client' — some libs reach
        // for unstable_batchedUpdates / legacy entries via the bare spec.
        // Expo Web uses AppRegistry.runApplication from react-native-web,
        // not createRoot from react-dom/client — leave react-dom entries
        // out of the include list to avoid Vite warning about a missing
        // dep when the user's app doesn't depend on it.
        ...(options.target === 'expo-web' ? [] : ['react-dom', 'react-dom/client']),
        '@mswjs/interceptors/fetch',
        '@mswjs/interceptors/XMLHttpRequest',
        ...(expoOverrides?.optimizeDepsInclude ?? []),
        ...(nextOverrides?.optimizeDepsInclude ?? []),
      ],
      exclude: [
        ...(expoOverrides?.optimizeDepsExclude ?? []),
        ...(nextOverrides?.optimizeDepsExclude ?? []),
      ],
      esbuildOptions: {
        target: 'es2022',
        // `.node` files are native bindings — only meaningful under
        // Node.js, never inside a browser bundle. They reach the
        // scanner transitively from server-only deps the React app
        // doesn't actually use (e.g. better-sqlite3 → @mapbox/node-pre-gyp
        // → fsevents → @resvg/resvg-js platform bindings). Treating them
        // as empty modules lets esbuild silently skip them instead of
        // failing the entire dep optimizer with `No loader is configured
        // for ".node" files`. The browser would never execute these paths
        // anyway; if a user genuinely needs a `.node` file in their
        // React bundle they should externalize it themselves.
        loader: { '.node': 'empty' },
        // Expo Web: strip Flow types from the REAL react-native package source
        // so the dep optimizer can parse the deep `react-native/**` core modules
        // that reanimated's real web build (and other RN-web ecosystem packages)
        // statically reference. Scoped to expo-web only; OFF for web/next-web.
        ...(options.target === 'expo-web'
          ? { plugins: [flowStripPlugin()], define: { __DEV__: 'false' } }
          : {}),
        // Expo Web: the dep optimizer (esbuild) resolves RELATIVE imports
        // inside a pre-bundled package with its OWN extension list, NOT Vite's
        // resolve.extensions — so the `.web.*` priority set above doesn't reach
        // it. Mirror it here so a package's `Foo.web.js` wins over the native
        // `Foo.js` during pre-bundle (e.g. react-native-screens' DebugContainer,
        // whose native variant pulls in Flow-typed RN core esbuild can't parse).
        ...(options.target === 'expo-web'
          ? {
              resolveExtensions: [
                '.web.mjs',
                '.web.js',
                '.web.mts',
                '.web.ts',
                '.web.jsx',
                '.web.tsx',
                '.mjs',
                '.js',
                '.mts',
                '.ts',
                '.jsx',
                '.tsx',
                '.css',
                '.json',
              ],
            }
          : {}),
      },
    },
  };

  const merged = mergeConfig(userConfig, overrides);

  // Trap a failing background dep-optimize. Vite runs esbuild pre-bundling off
  // the main request path; when it throws (e.g. Flow-typed RN core esbuild
  // can't parse) the rejection has no local handler and lands as a process-level
  // `unhandledRejection`. We surface it as `fatalError` so renderComponents can
  // abort fast rather than let every capture time out against a server that will
  // never finish optimizing. The listener is scoped to this server's lifetime
  // (removed in close()). Note: we can't attribute a global rejection to a
  // specific server, so with concurrent sandboxes any esbuild build failure
  // trips every live fatalError — acceptable since the reported error is real
  // and verify runs one sandbox at a time.
  let rejectFatal!: (reason: unknown) => void;
  const fatalError = new Promise<never>((_, reject) => {
    rejectFatal = reject;
  });
  // Pre-attach so an un-raced fatalError (browse mode) can't become an
  // unhandled rejection itself. Racers attach their own handler independently.
  fatalError.catch(() => {});
  const onUnhandledRejection = (reason: unknown) => {
    if (isEsbuildBuildFailure(reason)) {
      rejectFatal(reason instanceof Error ? reason : new Error(String(reason)));
    }
  };
  process.on('unhandledRejection', onUnhandledRejection);

  const server = await createServer(merged);
  viteServerBox.server = server;

  // Browse-mode API routes are installed via the `validity:api` plugin
  // above (configureServer pre-hook form). Registering them here, after
  // createServer, would put them behind Vite's SPA fallback and every
  // /__validity/api/* request would return index.html.

  await server.listen();

  const url = `http://127.0.0.1:${port}`;

  // Attach the LLM→page bridge in browse mode. We piggyback on Vite's
  // httpServer for the WS upgrade — that's the only HTTP socket the
  // browse tab knows about, so adding a dedicated port would just force
  // the page to learn two URLs for no benefit. Vite's own HMR socket
  // uses a different path (`/`) so the upgrade handlers don't collide.
  let bridge: BridgeHandle | undefined;
  if (options.config && server.httpServer) {
    bridge = attachBridge(server.httpServer);
  }

  return {
    url,
    port,
    server,
    bridge,
    fatalError,
    depScanFailure: () => depScanFailureBox.summary,
    appManifest: manifestOverrides.provenance,
    close: async () => {
      process.off('unhandledRejection', onUnhandledRejection);
      bridge?.close();
      await server.close();
    },
  };
}

/* eslint-disable-next-line no-control-regex -- ANSI escapes ARE control chars */
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/**
 * True when a Vite log line is the dependency pre-scan dying. The scanner
 * fails in two shapes, both logged (never thrown) via `logger.error` in
 * Vite's depsOptimizer:
 *
 *   1. "Failed to scan for dependencies from entries: …" — esbuild itself
 *      failed over the entries (syntax it can't parse, loader errors).
 *   2. "The following dependencies are imported but could not be resolved: …
 *      Are they installed?" — the scan ran but a bare import resolved to
 *      nothing. THIS is the chromium-bidi case: a stray deep-subpath import
 *      anywhere in the swept tree lands here.
 */
export function isDepScanFailureLog(message: string): boolean {
  return (
    message.includes('Failed to scan for dependencies') ||
    message.includes('dependencies are imported but could not be resolved')
  );
}

/**
 * Boil Vite's multi-line scan-failure text down to one line naming what
 * killed the scan and from where. Handles both shapes of
 * `isDepScanFailureLog`:
 *
 *   ✘ [ERROR] Could not resolve "chromium-bidi/lib/cjs/bidiMapper/BidiMapper"
 *
 *       e2e/session.spec.ts:3:24:
 *
 * and
 *
 *   The following dependencies are imported but could not be resolved:
 *
 *     chromium-bidi/lib/cjs/bidiMapper/BidiMapper (imported by /abs/src/poison.ts)
 *
 * Falls back to the first non-empty line when the shape ever changes upstream —
 * a wording drift must degrade to a less specific summary, never back to
 * silence.
 */
export function summarizeDepScanFailure(message: string): string {
  const plain = message.replace(ANSI_RE, '');
  const lines = plain.split('\n');
  const offenders: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const err = lines[i]!.match(/\[ERROR\]\s+(.*\S)/);
    if (!err) continue;
    // The source frame is the next `path:line:col:` line (blank lines between).
    let from = '';
    for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
      const frame = lines[j]!.match(/^\s+(\S+:\d+:\d+):/);
      if (frame) {
        from = ` (from ${frame[1]})`;
        break;
      }
      if (/\[ERROR\]/.test(lines[j]!)) break;
    }
    offenders.push(`${err[1]}${from}`);
  }
  // Shape 2: "  <dep> (imported by <file>)" list rows.
  if (offenders.length === 0) {
    for (const line of lines) {
      const row = line.match(/^\s+(\S+) \(imported by (.+)\)\s*$/);
      if (row) offenders.push(`Could not resolve "${row[1]}" (imported by ${row[2]})`);
    }
  }
  if (offenders.length === 0) {
    const first = lines.map((l) => l.trim()).find((l) => l.length > 0);
    return first ?? 'dependency pre-scan failed (no detail captured)';
  }
  const shown = offenders.slice(0, 3).join('; ');
  const more = offenders.length > 3 ? ` (+${offenders.length - 3} more)` : '';
  return `${shown}${more}`;
}

/**
 * JS served in place of a pre-bundled dep once the pre-scan has aborted.
 * Evaluating it throws, which fires the sandbox index.html's inline
 * `window.onerror` trap and paints the failure as a data-validity-error
 * banner. A non-200 response would NOT do that — a failed static import in
 * a module graph errors on the <script> element, which the window-level
 * trap never sees, and the page would stay blank.
 */
export function depScanFailureModuleSource(summary: string): string {
  const message =
    'dependency pre-scan ABORTED — pre-bundled deps were never written, so this import can never load.\n' +
    `${summary}\n` +
    "Fix or exclude the offending import (e.g. optimizeDeps.exclude in the project's " +
    'vite.config, or drop the server-only workspace from the scan), then reload.';
  return `throw new Error(${JSON.stringify(message)});\n`;
}

/** The loud, actionable block printed the moment the pre-scan abort is seen. */
export function depScanAbortBanner(summary: string): string {
  return (
    `\n✗ validity: dependency pre-scan ABORTED — ${summary}\n` +
    `  Deps will be discovered lazily; a mid-render re-optimize reload can swap the React\n` +
    `  instance under a mounting tree ("Invalid hook call… more than one copy of React").\n` +
    `  Verdicts from this session carry a demoting 'dep-scan' evidence taint. Fix or\n` +
    `  exclude the offending import above to restore trustworthy renders.\n\n`
  );
}

/**
 * True when `reason` is an esbuild build failure — the shape Vite's dep
 * optimizer throws when pre-bundling hits unparseable source. Checked
 * structurally first: esbuild's BuildFailure carries an `errors` array of
 * Message objects, each with a string `text` (the `.text` shape check keeps
 * AggregateError — whose `errors` hold Errors with `.message` — from
 * matching, important because this runs on every process-wide
 * unhandledRejection). The message regex is only a fallback for re-wrapped
 * Errors that lost the array; a wording change upstream can no longer
 * silently disable the fail-fast.
 */
export function isEsbuildBuildFailure(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const r = reason as { message?: unknown; errors?: unknown };
  if (
    Array.isArray(r.errors) &&
    r.errors.length > 0 &&
    r.errors.every(
      (e) => e && typeof e === 'object' && typeof (e as { text?: unknown }).text === 'string',
    )
  ) {
    return true;
  }
  return typeof r.message === 'string' && /Build failed with \d+ error/.test(r.message);
}

/**
 * Wire up the Validity-internal API routes used by browse mode (and
 * harmless in verify). Three endpoints:
 *
 *   GET  /__validity/api/config            → resolved ValidityConfig (JSON)
 *   GET  /__validity/api/scenario-state    → cookies + storage for ?name=<id>
 *   POST /__validity/api/fixture           → write a fixture to .validity/config.ts
 *
 * The third lives behind the "browse" lane and is the one with side
 * effects on the user's working tree — keep it gated to the same-origin
 * server, which Vite already binds to 127.0.0.1.
 */
function registerValidityMiddlewares(
  server: ViteDevServer,
  projectRoot: string,
  config: ValidityConfig,
): void {
  server.middlewares.use('/__validity/api', (req, res, next) => {
    const status = localRequestStatus(req, true);
    if (status) {
      sendJson(res, status, { error: status === 415 ? 'application/json required' : 'Forbidden' });
      return;
    }
    next();
  });
  server.middlewares.use('/__validity/api/config', (_req, res) => {
    // Merge discovered component files into the config response so the
    // browse sidebar can show them even when the user hasn't added explicit
    // entries to `components` in .validity/config.ts. Discovered entries
    // have no `props` / `fixtures` — the user promotes them via the
    // "Save as fixture" button or by editing the config directly. Explicit
    // entries win on path conflict (we never overwrite user-authored
    // fixtures).
    let discovered: string[] = [];
    try {
      discovered = discoverComponentFiles(projectRoot);
    } catch {
      // Walk failure (e.g., permission error) is non-fatal — the sidebar
      // just shows whatever's in config.components, same as before.
      discovered = [];
    }

    // Screens are a parallel concern — discovered the same way as
    // components but classified separately so the browse canvas can render
    // them above the components grid. We merge them into the same
    // `components` map so the existing iframe-render + fixture-write paths
    // keep working unchanged, AND surface the screen list + resolved
    // navigation graph under a `_screens` envelope field for the canvas.
    let discoveredScreens: Array<{ path: string; routePath?: string }> = [];
    try {
      discoveredScreens = discoverScreenFiles(projectRoot);
    } catch {
      // Walk failure → empty list. Same posture as discoverComponentFiles.
      discoveredScreens = [];
    }
    const explicit = config.components ?? {};
    const explicitScreens = config.screens ?? {};
    const merged: Record<
      string,
      {
        props?: unknown;
        fixtures?: Record<
          string,
          { description?: string; props?: Record<string, unknown>; inferred?: boolean }
        >;
        scenarios?: string[];
        discovered?: boolean;
      }
    > = {};

    // Explicit entries pass through verbatim — we never overwrite a
    // user-authored fixture with an inferred one.
    for (const [path, entry] of Object.entries(explicit)) {
      merged[path] = { ...entry };
    }

    // Build the merged `screens` record (mirrors the components merge):
    // explicit screens win, discovered ones fill in the gaps, and a
    // discovered routePath populates an explicit entry that lacks one.
    const mergedScreens: Record<
      string,
      {
        props?: unknown;
        fixtures?: Record<
          string,
          { description?: string; props?: Record<string, unknown>; inferred?: boolean }
        >;
        scenarios?: string[];
        routePath?: string;
        discovered?: boolean;
      }
    > = {};
    for (const [path, entry] of Object.entries(explicitScreens)) {
      mergedScreens[path] = { ...entry };
    }
    for (const screen of discoveredScreens) {
      const existing = mergedScreens[screen.path];
      if (!existing) {
        mergedScreens[screen.path] = {
          discovered: true,
          routePath: screen.routePath,
        };
      } else if (!existing.routePath && screen.routePath) {
        // Fill in a missing routePath from the discovered classification —
        // the user's explicit entry didn't pin one but Next.js conventions
        // tell us what it should be.
        existing.routePath = screen.routePath;
      }
    }

    // Fold screens into the components map so existing render / fixture
    // paths keep working unchanged. Screens take precedence on path
    // conflict — they're the more specific classification (a path that's
    // both in `components` and `screens` is really a screen).
    for (const [path, screenEntry] of Object.entries(mergedScreens)) {
      // Strip the screen-only `routePath` before merging into components
      // (the component shape doesn't carry it). The `_screens` envelope
      // is the authoritative source for routePath downstream.
      const { routePath: _routePath, ...rest } = screenEntry;
      void _routePath;
      merged[path] = { ...rest };
    }

    // For everything else (discovered OR explicit-but-empty), attempt
    // static type inference. If we can synthesize a credible fixture
    // from the component's prop types, attach it under `fixtures` with
    // an `inferred: true` marker so the canvas can flag it and the
    // user can promote it to a real fixture later. Inference failures
    // (no exported component, no resolvable props, parse errors) leave
    // the entry as a bare placeholder.
    const inferableForPath = (path: string): boolean => {
      const entry = merged[path];
      if (!entry) return true;
      // Skip components the user has already configured with fixtures
      // or explicit default props — they don't need help.
      const hasFixtures = entry.fixtures && Object.keys(entry.fixtures).length > 0;
      const hasProps = entry.props && Object.keys(entry.props).length > 0;
      return !hasFixtures && !hasProps;
    };

    for (const path of discovered) {
      if (!merged[path]) {
        merged[path] = { discovered: true };
      }
    }

    for (const path of Object.keys(merged)) {
      if (!inferableForPath(path)) continue;
      try {
        const result = inferFixtures(resolve(projectRoot, path));
        if (!result) continue;
        const fixtures: NonNullable<(typeof merged)[string]['fixtures']> = {};
        for (const [name, fx] of Object.entries(result.fixtures)) {
          fixtures[name] = {
            description: fx.description,
            props: fx.props,
            inferred: true,
          };
        }
        merged[path]!.fixtures = fixtures;
      } catch {
        // Inference is best-effort — any throw leaves the entry as-is
        // and the canvas falls back to the placeholder card.
      }
    }

    // Resolve the navigation graph against the merged screens list (so
    // explicit routePath pins beat the discovered defaults). Wrap in
    // try/catch — Babel parse failures on weird user code shouldn't take
    // down the config endpoint. Failure → empty edge list.
    let navigation: ResolvedNavigationEdge[] = [];
    try {
      const screensForGraph = Object.entries(mergedScreens).map(([path, entry]) => ({
        path,
        routePath: entry.routePath,
      }));
      navigation = buildNavigationGraph(projectRoot, screensForGraph);
    } catch {
      navigation = [];
    }

    // Surface every screen with its (possibly explicit, possibly inferred)
    // routePath alongside it — the canvas needs both to draw the Screens
    // section AND to show the route under each screen card. Earlier this
    // was just a flat `paths: string[]` and the canvas had no way to
    // recover routePath without re-joining against `screens` (which the
    // server doesn't always include verbatim). Bundling them here keeps
    // the API single-trip.
    const screens = Object.keys(mergedScreens)
      .sort()
      .map((path) => {
        const entry = mergedScreens[path]!;
        const routePath = entry.routePath;
        return routePath !== undefined ? { path, routePath } : { path };
      });

    // For each screen, list the user-config components imported into it
    // (matched against the merged components map, excluding screens
    // themselves — a screen importing another screen is a flow edge, not a
    // "used component"). Powers the detail view's "Used in this screen"
    // jump list. Failure is silent: empty map → no jump rows shown.
    const screenSet = new Set(screens.map((s) => s.path));
    const nonScreenComponentPaths = Object.keys(merged).filter((p) => !screenSet.has(p));
    let componentUsage: Record<string, string[]> = {};
    try {
      componentUsage = buildComponentUsageMap({
        projectRoot,
        screens: screens.map((s) => s.path),
        componentPaths: nonScreenComponentPaths,
      });
    } catch {
      componentUsage = {};
    }

    // Views — author-defined compositions of components rendered together
    // on a single canvas. Surface them under a `_views` envelope (mirrors
    // `_screens`) so the browse-index can fold them into the palette and
    // the views_* MCP tools can list them with a single GET.
    const viewsEntries = Object.entries(config.views ?? {}).map(([name, view]) => ({
      name,
      title: view.title,
      description: view.description,
      layout: view.layout ?? 'stack',
      items: view.items,
    }));

    sendJson(res, 200, {
      ...config,
      components: merged,
      _screens: {
        screens,
        navigation,
        componentUsage,
      },
      _views: {
        views: viewsEntries,
      },
    });
  });

  // GET /__validity/api/catalog — the structured library (components /
  // screens / views with fixtures, routes, usage, navigation). Same data
  // the validity__catalog MCP tool returns; exposed here so the browse UI
  // (and curl-based checks) can read it without re-deriving the merge.
  // `?props=1` opts into prop-type extraction; `?kind=` / `?q=` filter.
  server.middlewares.use('/__validity/api/catalog', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const includeProps = url.searchParams.get('props') === '1';
    const kind = url.searchParams.get('kind') ?? undefined;
    const q = url.searchParams.get('q')?.toLowerCase();
    let catalog;
    try {
      catalog = buildCatalog(projectRoot, config, { includeProps });
    } catch {
      sendJson(res, 200, {
        entries: [],
        navigation: [],
        counts: { components: 0, screens: 0, views: 0 },
      });
      return;
    }
    let entries = catalog.entries;
    if (kind) entries = entries.filter((e) => e.kind === kind);
    if (q)
      entries = entries.filter(
        (e) => e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q),
      );
    sendJson(res, 200, {
      ...catalog,
      entries: entries.map((e) => ({ ...e, propsSummary: summarizeProps(e.props) })),
    });
  });

  // GET /__validity/api/tokens — read-only design tokens (CSS custom
  // properties + Tailwind theme) for the design-token inspector. No
  // write-back endpoint by design: token edits happen in the user's source,
  // driven by the agent, not inside Validity.
  server.middlewares.use('/__validity/api/tokens', (_req, res) => {
    try {
      sendJson(res, 200, discoverDesignTokens(projectRoot));
    } catch {
      sendJson(res, 200, { cssVariables: [], tailwindColors: [], cssFiles: [] });
    }
  });

  server.middlewares.use('/__validity/api/scenario-state', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const name = url.searchParams.get('name') ?? '';
    const scenario = config.scenarios?.[name];
    if (!scenario) {
      sendJson(res, 200, { cookies: {}, localStorage: {}, sessionStorage: {} });
      return;
    }
    const net = scenario.mockNetwork ?? {};
    sendJson(res, 200, {
      cookies: net.cookies ?? {},
      localStorage: net.localStorage ?? {},
      sessionStorage: net.sessionStorage ?? {},
    });
  });

  server.middlewares.use('/__validity/api/fixture', (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    readJsonBody(req)
      .then((body) => {
        const { componentPath, fixtureName, props } = (body ?? {}) as {
          componentPath?: string;
          fixtureName?: string;
          props?: Record<string, unknown>;
        };
        if (!componentPath || !fixtureName) {
          sendJson(res, 400, { error: 'componentPath and fixtureName are required' });
          return;
        }
        const result = writeFixtureToConfig({
          projectRoot,
          componentPath,
          fixtureName,
          props: props ?? {},
        });
        if (!result.ok) {
          sendJson(res, 500, { error: result.error ?? 'unknown error' });
          return;
        }
        sendJson(res, 200, { ok: true, writtenTo: result.writtenTo, mode: result.mode });
      })
      .catch((err: unknown) => {
        sendJson(res, 500, { error: (err as Error)?.message ?? String(err) });
      });
  });

  // GET /__validity/api/props?component=<projectRelativePath>
  //   → { componentName: string|null, props: Array<{name, type, optional}> }
  //
  // Powers the browse-mode Props flyout: the panel uses the returned prop
  // metadata to render per-prop form fields (text/number/checkbox/select).
  // Inference is best-effort — any failure (missing file, unparseable
  // source, no exported component) returns the empty shape rather than a
  // 500 so the UI degrades gracefully to "no inferred props".
  server.middlewares.use('/__validity/api/props', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const componentPath = url.searchParams.get('component');
    if (!componentPath) {
      sendJson(res, 400, { error: 'component query param is required' });
      return;
    }
    try {
      const abs = containedFile(projectRoot, resolve(projectRoot, componentPath));
      if (
        isAbsolute(componentPath) ||
        !abs ||
        !buildCatalog(projectRoot, config).entries.some(
          (entry) => entry.kind !== 'view' && entry.path === componentPath,
        )
      ) {
        sendJson(res, 403, { error: 'Component must be a project catalog file' });
        return;
      }
      const result = extractPropsType(abs);
      sendJson(res, 200, {
        componentName: result.componentName,
        props: result.props,
      });
    } catch {
      sendJson(res, 200, { componentName: null, props: [] });
    }
  });

  // Views CRUD. GET (list) is served by /__validity/api/config under
  // `_views`. This endpoint handles writes:
  //
  //   POST   /__validity/api/views          { name, view, force? }
  //   DELETE /__validity/api/views?name=…
  //
  // Name collisions are detected here: a view name must not collide with
  // an existing component path, screen path, OR another view name unless
  // `force: true` is passed. The collision response is 409 + a structured
  // body so the views_create MCP tool can surface the exact conflict to
  // the user instead of the LLM inventing an unrelated explanation.
  server.middlewares.use('/__validity/api/views', (req, res) => {
    if (req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          const { name, view, force } = (body ?? {}) as {
            name?: string;
            view?: {
              title?: string;
              description?: string;
              layout?: 'stack' | 'grid';
              items?: WriteViewItem[];
            };
            force?: boolean;
          };
          if (!name || typeof name !== 'string') {
            sendJson(res, 400, { error: 'name is required (string)' });
            return;
          }
          if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) {
            sendJson(res, 400, {
              error:
                'view name must start with an alphanumeric character and contain only letters, digits, spaces, underscores, or hyphens',
            });
            return;
          }
          if (!view || !Array.isArray(view.items) || view.items.length === 0) {
            sendJson(res, 400, { error: 'view.items must be a non-empty array' });
            return;
          }
          for (const it of view.items) {
            if (!it || typeof it.componentPath !== 'string' || !it.componentPath) {
              sendJson(res, 400, { error: 'each view item must include componentPath (string)' });
              return;
            }
          }

          // Collision check. We treat the configured components + the
          // discovered files + the configured screens + the existing
          // view names as the namespace. force=true lets the caller
          // overwrite an existing view of the same name (the typical
          // "I want to update my view" case) but never a component or
          // screen path.
          let allComponents: string[] = [];
          try {
            allComponents = discoverComponentFiles(projectRoot);
          } catch {
            allComponents = [];
          }
          const componentPaths = new Set<string>([
            ...Object.keys(config.components ?? {}),
            ...allComponents,
          ]);
          const screenPaths = new Set<string>(Object.keys(config.screens ?? {}));
          try {
            const discoveredScreens = discoverScreenFiles(projectRoot);
            for (const s of discoveredScreens) screenPaths.add(s.path);
          } catch {
            /* swallow */
          }
          const viewNames = new Set<string>(Object.keys(config.views ?? {}));

          const collisions: Array<{ kind: 'component' | 'screen' | 'view'; with: string }> = [];
          if (componentPaths.has(name)) collisions.push({ kind: 'component', with: name });
          if (screenPaths.has(name)) collisions.push({ kind: 'screen', with: name });
          if (viewNames.has(name) && !force) collisions.push({ kind: 'view', with: name });

          // Component/screen collisions are always hard — `force` only
          // controls the view-overwrite case. The MCP tool surfaces the
          // hard collision so the LLM tells the user instead of guessing.
          const hardCollision = collisions.some((c) => c.kind !== 'view');
          if (hardCollision || (collisions.length > 0 && !force)) {
            sendJson(res, 409, {
              error: 'name collision',
              collisions,
            });
            return;
          }

          const result = writeViewToConfig({
            projectRoot,
            name,
            view: {
              title: view.title,
              description: view.description,
              layout: view.layout,
              items: view.items as WriteViewItem[],
            },
          });
          if (!result.ok) {
            sendJson(res, 500, { error: result.error ?? 'unknown error' });
            return;
          }
          // Reflect the write into the live config so subsequent GETs and
          // the bridge-driven palette see the new view without restarting
          // the dev server. Hot-edit: harmless if absent (the next config
          // reload would pick it up anyway), but instant feels better.
          const next = { ...(config.views ?? {}) };
          next[name] = {
            title: view.title,
            description: view.description,
            layout: view.layout,
            items: view.items as WriteViewItem[],
          };
          (config as { views?: Record<string, unknown> }).views = next;

          sendJson(res, 200, {
            ok: true,
            writtenTo: result.writtenTo,
            mode: result.mode,
            warning: result.mode === 'sidecar' ? result.error : undefined,
          });
        })
        .catch((err: unknown) => {
          sendJson(res, 500, { error: (err as Error)?.message ?? String(err) });
        });
      return;
    }

    if (req.method === 'DELETE') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const name = url.searchParams.get('name');
      if (!name) {
        sendJson(res, 400, { error: 'name query param is required' });
        return;
      }
      const result = deleteViewFromConfig({ projectRoot, name });
      if (!result.ok) {
        sendJson(res, 500, { error: result.error ?? 'unknown error' });
        return;
      }
      if (config.views) {
        const next = { ...config.views };
        delete next[name];
        (config as { views?: Record<string, unknown> }).views = next;
      }
      sendJson(res, 200, { ok: true, writtenTo: result.writtenTo, mode: result.mode });
      return;
    }

    sendJson(res, 405, { error: 'method not allowed' });
  });

  // POST /__validity/api/invalidate — drop the cached transform for the
  // sandbox entry modules so a reused (lock-detected) browse server re-reads
  // the freshly re-prepared entry.tsx instead of serving the stale transform.
  //
  // Why this exists: the sandbox `root` is node_modules/.validity, and Vite's
  // file watcher ignores `**/node_modules/**` by default — so prepareSandbox
  // rewriting entry.tsx (with newly-baked mockNetwork handlers) fires no
  // invalidation, and the module graph keeps serving the stale transform. The
  // verify reuse path (render.ts) re-prepares the entry against a long-lived
  // browse server running in a *separate process*, so it can't reach into this
  // server's module graph directly — it POSTs here after re-preparing. This
  // mirrors the in-memory hot-edit the views write performs above, extended to
  // the Vite module graph.
  server.middlewares.use('/__validity/api/invalidate', (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    // entry.tsx carries the baked network handlers; validity-index.tsx is the
    // other generated module that can transitively pin stale state.
    const dir = validityDir(projectRoot);
    const entryNames = ['entry.tsx', 'validity-index.tsx'];
    const invalidated = new Set<string>();
    const invalidate = (mod: { url?: string } | null | undefined): void => {
      if (!mod) return;
      // ModuleNode shape; invalidateModule accepts the back-compat node.
      server.moduleGraph.invalidateModule(mod as never);
      if (mod.url) invalidated.add(mod.url);
    };

    // Look the modules up two ways and union the results, because the module
    // graph is keyed by the resolved (realpath'd) file path: on a symlinked
    // root (e.g. macOS tmpdir's /var → /private/var) a raw `resolve(dir, …)`
    // won't match getModulesByFile. (1) by served URL — what the browser
    // actually requested; (2) by file path, both raw and realpath-resolved.
    Promise.all(
      entryNames.map((name) =>
        server.moduleGraph
          .getModuleByUrl(`/${name}`)
          .then(invalidate)
          .catch(() => {}),
      ),
    )
      .then(() => {
        for (const name of entryNames) {
          const abs = resolve(dir, name);
          const candidates = new Set([normalizePath(abs)]);
          try {
            candidates.add(normalizePath(realpathSync(abs)));
          } catch {
            /* file may not exist yet — skip */
          }
          for (const file of candidates) {
            const mods = server.moduleGraph.getModulesByFile(file);
            if (mods) for (const mod of mods) invalidate(mod);
          }
        }
        sendJson(res, 200, { ok: true, invalidated: [...invalidated] });
      })
      .catch((err: unknown) => {
        sendJson(res, 500, { error: (err as Error)?.message ?? String(err) });
      });
  });

  server.middlewares.use('/__validity/api/component-scenarios', (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    readJsonBody(req)
      .then((body) => {
        const { componentPath, scenarios } = (body ?? {}) as {
          componentPath?: string;
          scenarios?: string[] | null;
        };
        if (!componentPath) {
          sendJson(res, 400, { error: 'componentPath is required' });
          return;
        }
        // `null` from the client means "delete the override" → undefined here.
        const normalizedScenarios =
          scenarios === null || scenarios === undefined ? undefined : scenarios;
        const result = writeComponentScenariosToConfig({
          projectRoot,
          componentPath,
          scenarios: normalizedScenarios,
        });
        if (!result.ok) {
          sendJson(res, 500, { error: result.error ?? 'unknown error' });
          return;
        }
        sendJson(res, 200, { ok: true, writtenTo: result.writtenTo, mode: result.mode });
      })
      .catch((err: unknown) => {
        sendJson(res, 500, { error: (err as Error)?.message ?? String(err) });
      });
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}
