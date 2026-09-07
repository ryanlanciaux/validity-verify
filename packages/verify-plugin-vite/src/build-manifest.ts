import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  APP_MANIFEST_SCHEMA_VERSION,
  type AppManifest,
  type AppManifestAlias,
  type AppManifestCss,
  type AppManifestEntry,
  type AppManifestEnv,
  type AppManifestOmittedAlias,
  type AppManifestTailwind,
} from './schema.js';

/**
 * The slice of Vite's `ResolvedConfig` this module actually reads.
 *
 * Declared structurally rather than importing `ResolvedConfig` so that
 * (a) the manifest builder is unit-testable with hand-written fixtures, and
 * (b) the package keeps working across the whole supported Vite peer range
 * without tracking type churn in fields we never touch. A real
 * `ResolvedConfig` is assignable to this.
 */
export interface ResolvedConfigLike {
  root: string;
  envDir?: string;
  envPrefix?: string | string[];
  env?: Record<string, unknown>;
  cacheDir?: string;
  resolve?: { alias?: unknown };
  css?: { postcss?: unknown };
  plugins?: ReadonlyArray<{ name?: string } | null | undefined>;
  build?: { rollupOptions?: { input?: unknown } };
}

/** Filesystem surface used by the builder. Injectable so tests stay hermetic. */
export interface ManifestFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf-8'): string;
}

const nodeFs: ManifestFs = {
  existsSync: fsExistsSync,
  readFileSync: (p, e) => fsReadFileSync(p, e),
};

/** Options that change what the builder records (not how it records it). */
export interface BuildManifestOptions {
  /** Package name recorded in `generator.name`. */
  generatorName: string;
  /** Package version recorded in `generator.version`. */
  generatorVersion: string;
  /**
   * Record client env variable NAMES in `env.exposedKeys`. Off by default:
   * the manifest is a committable file and names leak product surface. Values
   * are never recorded under any setting.
   */
  includeEnvKeys?: boolean;
  /** Filesystem override (tests). */
  fs?: ManifestFs;
}

/* ------------------------------------------------------------------ *
 * Path helpers                                                        *
 * ------------------------------------------------------------------ */

/**
 * Normalize to forward slashes. Every path in the manifest is POSIX-style so
 * a manifest generated on Windows and read on CI (or vice versa, via a
 * committed file) compares byte-for-byte the same way.
 */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

/**
 * Render `abs` relative to `root`, POSIX-style. Returns `null` when the path
 * escapes the root — the manifest never records `../..`-style paths, because a
 * reader in a re-rooted sandbox cannot safely re-anchor them.
 */
function relativeToRoot(root: string, abs: string): string | null {
  const rel = toPosix(relative(root, abs));
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel;
}

/* ------------------------------------------------------------------ *
 * Aliases                                                             *
 * ------------------------------------------------------------------ */

/**
 * Vite injects two of its own aliases into every resolved config so the
 * browser can fetch its client runtime (`/@vite/client`, `/@vite/env`). They
 * point INTO the user's `node_modules/vite/dist/client/`. Mirroring them into
 * Validity's sandbox would wire the sandbox's HMR client to a different Vite
 * install than the one serving it — the one thing sandbox isolation is
 * explicitly there to prevent. Detected two ways because Vite has moved
 * between a RegExp `find` and a string `find` across majors.
 */
function isViteInternalAlias(findText: string, replacement: unknown): boolean {
  if (/^\/?\^?\/?@vite\//.test(findText)) return true;
  if (typeof replacement === 'string') {
    const r = toPosix(replacement);
    if (r.includes('/vite/dist/client/')) return true;
  }
  return false;
}

/** Render an alias `find` for human consumption (RegExp → `/source/flags`). */
function renderFind(find: unknown): string {
  if (find instanceof RegExp) return `/${find.source}/${find.flags}`;
  if (typeof find === 'string') return find;
  return String(find);
}

/**
 * Split the resolved alias array into what the sandbox can safely mirror and
 * what it can only record. See {@link AppManifestAliasOmissionReason} for why
 * each bucket exists.
 *
 * Relative string replacements are absolutized against `root` here, because
 * only this side knows the user's real root — the sandbox's root is
 * `node_modules/.validity/`, where the same relative path means something
 * else entirely.
 */
export function serializeAliases(
  alias: unknown,
  root: string,
): { aliases: AppManifestAlias[]; omitted: AppManifestOmittedAlias[] } {
  const aliases: AppManifestAlias[] = [];
  const omitted: AppManifestOmittedAlias[] = [];
  if (!Array.isArray(alias)) return { aliases, omitted };

  for (const raw of alias) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as { find?: unknown; replacement?: unknown; customResolver?: unknown };
    const findText = renderFind(entry.find);

    if (isViteInternalAlias(findText, entry.replacement)) {
      omitted.push({ find: findText, reason: 'vite-internal' });
      continue;
    }
    if (entry.customResolver != null) {
      omitted.push({ find: findText, reason: 'custom-resolver' });
      continue;
    }
    if (entry.find instanceof RegExp) {
      omitted.push({ find: findText, reason: 'regexp-find' });
      continue;
    }
    if (typeof entry.find !== 'string') {
      omitted.push({ find: findText, reason: 'regexp-find' });
      continue;
    }
    if (typeof entry.replacement !== 'string') {
      omitted.push({ find: findText, reason: 'non-string-replacement' });
      continue;
    }
    // A replacement that starts with `.` is a filesystem path relative to the
    // config's own directory (== root, for every config shape in the wild).
    // Anything else is either already absolute or a bare specifier, and both
    // are recorded verbatim.
    const replacement = entry.replacement.startsWith('.')
      ? toPosix(resolve(root, entry.replacement))
      : toPosix(entry.replacement);
    aliases.push({ find: entry.find, replacement });
  }
  return { aliases, omitted };
}

/* ------------------------------------------------------------------ *
 * Env                                                                 *
 * ------------------------------------------------------------------ */

/**
 * Variables Vite synthesizes into `import.meta.env` itself. They are not user
 * env vars and counting them would inflate `exposedKeyCount` on every app.
 */
const VITE_BUILTIN_ENV_KEYS = new Set(['BASE_URL', 'MODE', 'DEV', 'PROD', 'SSR', 'LEGACY']);

/**
 * Summarize client env exposure. Values are dropped on the floor; names only
 * appear when `includeEnvKeys` is set. `dir` is what actually repairs the
 * sandbox — see {@link AppManifestEnv}.
 */
export function summarizeEnv(config: ResolvedConfigLike, includeEnvKeys: boolean): AppManifestEnv {
  const dir = toPosix(config.envDir ? resolve(config.envDir) : resolve(config.root));
  const rawPrefix = config.envPrefix;
  const prefixes = (
    rawPrefix === undefined ? ['VITE_'] : Array.isArray(rawPrefix) ? [...rawPrefix] : [rawPrefix]
  )
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .sort();
  const exposedKeys = Object.keys(config.env ?? {})
    .filter((k) => !VITE_BUILTIN_ENV_KEYS.has(k))
    .sort();
  const env: AppManifestEnv = {
    dir,
    prefixes: prefixes.length > 0 ? prefixes : ['VITE_'],
    exposedKeyCount: exposedKeys.length,
  };
  if (includeEnvKeys) env.exposedKeys = exposedKeys;
  return env;
}

/* ------------------------------------------------------------------ *
 * Plugins                                                             *
 * ------------------------------------------------------------------ */

/**
 * Unprefixed plugin names that belong to Vite/Rollup internals. Everything
 * else Vite owns is `vite:`-prefixed.
 */
const INTERNAL_UNPREFIXED_PLUGINS = new Set([
  'alias',
  'commonjs',
  'node-resolve',
  'vite-browser-external',
]);

/**
 * User plugin names in resolved order.
 *
 * Vite's own plugins are filtered out for two reasons: they carry no
 * information about the user's app, and the internal set DIFFERS between
 * `serve` and `build` (`vite:build-import-analysis` and friends exist only in
 * build), which would make the manifest flip every time the user switched
 * commands. A user plugin declared with `apply: 'build'` is still a genuine
 * command-dependent difference — see the `apply` option on the plugin for how
 * that interacts with the no-churn guarantee.
 */
export function userPluginNames(config: ResolvedConfigLike): string[] {
  const out: string[] = [];
  for (const p of config.plugins ?? []) {
    const name = p?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (name.startsWith('vite:')) continue;
    if (INTERNAL_UNPREFIXED_PLUGINS.has(name)) continue;
    out.push(name);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * CSS                                                                 *
 * ------------------------------------------------------------------ */

/**
 * PostCSS config filenames, in the order PostCSS itself resolves them. Probed
 * next to `root` when Vite's resolved `css.postcss` is neither an explicit
 * path nor an inline object — i.e. when the app relies on plain discovery,
 * which is exactly the case that breaks once the sandbox re-roots into
 * `node_modules/.validity/`.
 */
const POSTCSS_CONFIG_FILES = [
  'postcss.config.js',
  'postcss.config.cjs',
  'postcss.config.mjs',
  'postcss.config.ts',
  'postcss.config.mts',
  'postcss.config.cts',
  '.postcssrc',
  '.postcssrc.json',
  '.postcssrc.js',
  '.postcssrc.cjs',
  '.postcssrc.mjs',
  '.postcssrc.yml',
  '.postcssrc.yaml',
];

/** Name of a PostCSS plugin object, however it chooses to identify itself. */
function postcssPluginName(plugin: unknown): string | null {
  if (typeof plugin === 'string') return plugin;
  if (typeof plugin === 'function') {
    const n = (plugin as { postcssPlugin?: unknown; name?: unknown }).postcssPlugin;
    if (typeof n === 'string') return n;
    const fnName = (plugin as { name?: unknown }).name;
    return typeof fnName === 'string' && fnName.length > 0 ? fnName : null;
  }
  if (plugin && typeof plugin === 'object') {
    const n = (plugin as { postcssPlugin?: unknown }).postcssPlugin;
    if (typeof n === 'string') return n;
    const alt = (plugin as { name?: unknown }).name;
    if (typeof alt === 'string') return alt;
  }
  return null;
}

/**
 * Read the PostCSS half of the config: an explicit config path (string form)
 * or an inline plugin list (object form), falling back to probing the standard
 * config filenames next to `root`.
 */
function readPostcss(
  config: ResolvedConfigLike,
  fs: ManifestFs,
): { plugins: string[]; configPath: string | null } {
  const postcss = config.css?.postcss;
  if (typeof postcss === 'string') {
    return { plugins: [], configPath: toPosix(resolve(config.root, postcss)) };
  }
  if (postcss && typeof postcss === 'object') {
    const raw = (postcss as { plugins?: unknown }).plugins;
    const plugins = Array.isArray(raw)
      ? raw.map((p) => postcssPluginName(p)).filter((n): n is string => n !== null)
      : [];
    return { plugins, configPath: null };
  }
  for (const name of POSTCSS_CONFIG_FILES) {
    const abs = resolve(config.root, name);
    if (fs.existsSync(abs)) return { plugins: [], configPath: toPosix(abs) };
  }
  return { plugins: [], configPath: null };
}

/**
 * Establish the Tailwind integration path from facts already in hand — the
 * resolved plugin list and the PostCSS plugin list. Never probes package.json:
 * a dependency entry proves installation, not wiring, and the sandbox's
 * existing v4 detection already covers the dependency angle.
 */
export function detectTailwind(
  pluginNames: readonly string[],
  postcssPlugins: readonly string[],
): AppManifestTailwind {
  // @tailwindcss/vite registers several sub-plugins, all name-prefixed.
  if (pluginNames.some((n) => n.startsWith('@tailwindcss/vite'))) {
    return { detected: true, via: 'vite-plugin', major: 4 };
  }
  if (postcssPlugins.some((n) => n === '@tailwindcss/postcss')) {
    return { detected: true, via: 'postcss', major: 4 };
  }
  if (postcssPlugins.some((n) => n === 'tailwindcss' || n.startsWith('tailwindcss/'))) {
    return { detected: true, via: 'postcss', major: 3 };
  }
  return { detected: false, via: null, major: null };
}

/* ------------------------------------------------------------------ *
 * Entry + entry CSS                                                   *
 * ------------------------------------------------------------------ */

/**
 * Flatten `build.rollupOptions.input` (string | string[] | Record) into a
 * stable, absolute list of HTML entries.
 *
 * Object form is walked in `Object.keys` order rather than sorted: that is the
 * declaration order the user wrote, it is stable for a given config object,
 * and reordering it would misrepresent which entry is "the" entry.
 */
export function htmlEntries(config: ResolvedConfigLike, fs: ManifestFs): string[] {
  const input = config.build?.rollupOptions?.input;
  const candidates: string[] = [];
  if (typeof input === 'string') candidates.push(input);
  else if (Array.isArray(input)) {
    for (const i of input) if (typeof i === 'string') candidates.push(i);
  } else if (input && typeof input === 'object') {
    for (const v of Object.values(input as Record<string, unknown>)) {
      if (typeof v === 'string') candidates.push(v);
    }
  }
  const html = candidates
    .filter((c) => c.endsWith('.html'))
    .map((c) => toPosix(resolve(config.root, c)));
  if (html.length > 0) return html;
  const fallback = toPosix(resolve(config.root, 'index.html'));
  return fs.existsSync(fallback) ? [fallback] : [];
}

/** `<script type="module" src="...">`, tolerant of attribute order. */
const MODULE_SCRIPT_RE =
  /<script\b(?=[^>]*\btype\s*=\s*["']module["'])[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i;
/** `<link rel="stylesheet" href="...">`, tolerant of attribute order. */
const STYLESHEET_LINK_RE =
  /<link\b(?=[^>]*\brel\s*=\s*["']stylesheet["'])[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
/**
 * Top-level CSS imports in the entry module — both the side-effect form
 * (`import './index.css'`) and the bound form (`import s from './a.module.css'`).
 * Deliberately a regex, not a parser: this is a provenance record, and a
 * partial-but-stable answer beats dragging a JS parser into a plugin that runs
 * inside every one of the user's dev-server boots.
 */
const CSS_IMPORT_RE =
  /^\s*import\s+(?:[^'";]*?\bfrom\s+)?["']([^"']+\.(?:css|scss|sass|less|styl|pcss))["']/gm;

/** True for anything the app loads over the network rather than from disk. */
function isRemoteRef(ref: string): boolean {
  return /^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith('data:');
}

/**
 * Resolve an HTML-authored reference. A leading `/` is root-relative (Vite's
 * dev-server convention); everything else is relative to the HTML file.
 */
function resolveHtmlRef(root: string, htmlAbs: string, ref: string): string {
  return ref.startsWith('/')
    ? toPosix(join(root, ref.slice(1)))
    : toPosix(resolve(dirname(htmlAbs), ref));
}

/**
 * Read the authoritative entry pair plus the stylesheets it pulls in.
 *
 * Scope is deliberately one HTML file and the one module it loads. A deeper
 * walk would be more complete and less trustworthy: the manifest's value comes
 * from being a record of facts Vite already resolved, not from Validity
 * re-implementing module resolution in a second place.
 */
export function readEntryFacts(
  config: ResolvedConfigLike,
  fs: ManifestFs,
): { entry: AppManifestEntry; entryCss: string[] } {
  const root = toPosix(resolve(config.root));
  const entry: AppManifestEntry = { html: null, module: null };
  const entryCss: string[] = [];

  const [htmlAbs] = htmlEntries(config, fs);
  if (!htmlAbs || !fs.existsSync(htmlAbs)) return { entry, entryCss };
  entry.html = relativeToRoot(root, htmlAbs);

  let html: string;
  try {
    html = fs.readFileSync(htmlAbs, 'utf-8');
  } catch {
    return { entry, entryCss };
  }

  for (const m of html.matchAll(STYLESHEET_LINK_RE)) {
    const href = m[1];
    if (!href || isRemoteRef(href)) continue;
    const rel = relativeToRoot(root, resolveHtmlRef(root, htmlAbs, href));
    if (rel && !entryCss.includes(rel)) entryCss.push(rel);
  }

  const scriptMatch = MODULE_SCRIPT_RE.exec(html);
  const src = scriptMatch?.[1];
  if (!src || isRemoteRef(src)) return { entry, entryCss };
  const moduleAbs = resolveHtmlRef(root, htmlAbs, src);
  entry.module = relativeToRoot(root, moduleAbs);

  if (!fs.existsSync(moduleAbs)) return { entry, entryCss };
  let source: string;
  try {
    source = fs.readFileSync(moduleAbs, 'utf-8');
  } catch {
    return { entry, entryCss };
  }
  for (const m of source.matchAll(CSS_IMPORT_RE)) {
    const spec = m[1];
    if (!spec || isRemoteRef(spec)) continue;
    // Bare specifiers (`import 'some-pkg/dist/style.css'`) live in
    // node_modules; they are real, but not a path under root, so they are
    // dropped rather than recorded as an unresolvable relative path.
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const abs = spec.startsWith('/')
      ? toPosix(join(root, spec.slice(1)))
      : toPosix(resolve(dirname(moduleAbs), spec));
    const rel = relativeToRoot(root, abs);
    if (rel && !entryCss.includes(rel)) entryCss.push(rel);
  }
  return { entry, entryCss };
}

/* ------------------------------------------------------------------ *
 * Framework                                                           *
 * ------------------------------------------------------------------ */

/**
 * TanStack Start's own Vite plugins, matched by OBSERVED name.
 *
 * These names were not guessed. A throwaway Start app was scaffolded outside
 * the repo (`@tanstack/react-start` 1.168.38 → `@tanstack/start-plugin-core`
 * 1.171.29, on Vite 8.2.1) and its resolved plugin list dumped for BOTH
 * `serve` and `build`. The Start-owned entries were, verbatim:
 *
 *   tanstack-start-core:config                 tanstack-start-core:load-env
 *   tanstack-start-core::server-fn:client      tanstack-start-core:dev-client-entry
 *   tanstack-start-core::server-fn:ssr         tanstack-start-core:dev-server
 *   tanstack-start-core:compiler-virtual-module  tanstack-start-core:preview-server
 *   tanstack-start-core:server-fn-resolver     tanstack-start-core:post-build
 *   tanstack-start-core:import-protection      tanstack-start-core:dev-base-rewrite
 *   tanstack-start:route-tree-client-plugin    tanstack-start:start-manifest-plugin
 *   tanstack-start:start-manifest-capture-client-build
 *   tanstack-react-start:config
 *
 * Three prefix families, hence the shape of the pattern: `tanstack-start:`,
 * `tanstack-start-core:`, and a per-framework `tanstack-<framework>-start:`
 * (the optional infix, so a Solid Start app's `tanstack-solid-start:config`
 * lands here too without needing a second observation).
 *
 * TANSTACK ROUTER IS DELIBERATELY EXCLUDED. The same Start app also resolved:
 *
 *   tanstack:router-generator                  tanstack:router-inline-css-defaults
 *   tanstack-router:code-splitter:compile-reference-file
 *   tanstack-router:code-splitter:compile-virtual-file
 *   tanstack-router:code-splitter:compile-shared-file
 *
 * and a plain Vite SPA using only `@tanstack/router-plugin` resolves EXACTLY
 * that set and nothing else (verified the same way). Router is a client-side
 * routing library that thousands of ordinary Vite apps use with no Start
 * server, no server functions and no Start build pipeline; labelling those
 * `tanstack-start` would assert a framework the app does not run. `router`
 * can never satisfy this pattern: the optional infix requires a trailing
 * hyphen, so neither `tanstack-router:` nor `tanstack:router-…` can reach the
 * literal `start`.
 */
const TANSTACK_START_PLUGIN_RE = /^tanstack-(?:[a-z]+-)?start(?:-core)?:/;

/**
 * Which of Validity's three Vite-side framework labels applies.
 *
 * `expo-web` is claimed only on hard evidence that React Native source is
 * being routed through `react-native-web` — an explicit alias, or a plugin
 * that exists to do exactly that. A project that merely has Expo in its
 * dependency tree (a monorepo with a sibling mobile app) is still `vite`, and
 * mislabelling it would send the sandbox down the RN-Web aliasing path for no
 * reason.
 *
 * `tanstack-start` is claimed on Start's own plugins being present in the
 * resolved pipeline — see {@link TANSTACK_START_PLUGIN_RE} for the observed
 * names and for why TanStack Router alone does NOT count.
 *
 * PRECEDENCE: the `expo-web` checks run FIRST and win outright, so an RN-Web
 * app that also runs TanStack Start (or merely TanStack Router) in the same
 * Vite pipeline stays `expo-web`. The two labels are not equally load-bearing:
 * `expo-web` is the one that says "this app's source is React Native", which
 * is a statement about what the rendered tree even is, while
 * `tanstack-start` is provenance about the build pipeline that nothing
 * consumes as a switch. Losing the RN-Web signal would misdescribe the app;
 * losing the Start signal costs a line of provenance. When both are true, keep
 * the one that would be wrong to drop.
 */
export function detectFramework(
  aliases: readonly AppManifestAlias[],
  pluginNames: readonly string[],
): 'vite' | 'expo-web' | 'tanstack-start' {
  const rnAliased = aliases.some(
    (a) => a.find === 'react-native' && a.replacement.includes('react-native-web'),
  );
  if (rnAliased) return 'expo-web';
  if (pluginNames.some((n) => /react-native-web|vite-plugin-rnw|^vite-plugin-expo/i.test(n))) {
    return 'expo-web';
  }
  if (pluginNames.some((n) => TANSTACK_START_PLUGIN_RE.test(n))) return 'tanstack-start';
  return 'vite';
}

/* ------------------------------------------------------------------ *
 * Assembly + serialization                                            *
 * ------------------------------------------------------------------ */

/** Build the manifest from a resolved Vite config. Pure apart from file reads. */
export function buildAppManifest(
  config: ResolvedConfigLike,
  options: BuildManifestOptions,
): AppManifest {
  const fs = options.fs ?? nodeFs;
  const root = toPosix(resolve(config.root));
  const { aliases, omitted } = serializeAliases(config.resolve?.alias, root);
  const plugins = userPluginNames(config);
  const postcss = readPostcss(config, fs);
  const { entry, entryCss } = readEntryFacts(config, fs);

  const css: AppManifestCss = {
    tailwind: detectTailwind(plugins, postcss.plugins),
    postcssPlugins: postcss.plugins,
    postcssConfigPath: postcss.configPath,
    entryCss,
  };

  return {
    schemaVersion: APP_MANIFEST_SCHEMA_VERSION,
    generator: { name: options.generatorName, version: options.generatorVersion },
    framework: detectFramework(aliases, plugins),
    root,
    entry,
    env: summarizeEnv(config, options.includeEnvKeys === true),
    css,
    aliases,
    aliasesOmitted: omitted,
    plugins,
  };
}

/**
 * Serialize deterministically.
 *
 * `JSON.stringify` preserves insertion order, and every object in the manifest
 * is constructed in a fixed literal order, so no key sorting is needed — and
 * sorting would in fact be WRONG for `aliases` and `plugins`, whose order is
 * load-bearing (Vite matches aliases by declaration order; plugin order is the
 * pipeline). Two spaces + a trailing newline match what Prettier would write,
 * so a committed manifest survives a repo-wide format pass unchanged.
 */
export function serializeAppManifest(manifest: AppManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
