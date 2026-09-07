import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  APP_MANIFEST_SCHEMA_VERSION,
  type AppManifest,
  type AppManifestAlias,
  type AppManifestCss,
  type AppManifestEnv,
  type AppManifestOmittedAlias,
  type AppManifestTailwind,
} from './schema.js';

/**
 * Derives the manifest facts for a Next.js app from Next's own on-disk
 * conventions.
 *
 * There is no `configResolved` here to read a normalized answer out of — see
 * schema.ts's header. Every function in this file therefore obeys one rule:
 * **read a convention or record nothing**. No file in this module is executed,
 * no dependency is resolved through `node_modules`, and no value from a `.env`
 * file is ever carried anywhere.
 */

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
   * Record client env variable NAMES in `env.exposedKeys`. Off by default: the
   * manifest is a committable file and names leak product surface. Values are
   * never recorded under any setting.
   */
  includeEnvKeys?: boolean;
  /** Filesystem override (tests). */
  fs?: ManifestFs;
}

/* ------------------------------------------------------------------ *
 * Path helpers                                                        *
 * ------------------------------------------------------------------ */

/**
 * Normalize to forward slashes. Every path in the manifest is POSIX-style so a
 * manifest generated on Windows and read on CI (or vice versa, via a committed
 * file) compares byte-for-byte the same way.
 */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

/* ------------------------------------------------------------------ *
 * JSONC                                                               *
 * ------------------------------------------------------------------ */

/**
 * Strip `//` and block comments and trailing commas, string-aware.
 *
 * `tsconfig.json` is JSONC by convention — `create-next-app` writes a plain
 * one, but hand-edited configs routinely carry comments, and TypeScript accepts
 * them. A strict `JSON.parse` would fail on those and silently report an app as
 * having zero path aliases, which is the exact class of quiet wrongness the
 * manifest exists to eliminate.
 */
export function stripJsonComments(text: string): string {
  const out: string[] = [];
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];

    if (inLineComment) {
      if (c === '\n') {
        inLineComment = false;
        out.push(c);
      }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out.push(c);
      if (c === '\\' && next !== undefined) {
        out.push(next);
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out.push(c);
      continue;
    }
    if (c === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '}' || c === ']') {
      // Walk back over whitespace only; a comma sitting there is trailing.
      let j = out.length - 1;
      while (j >= 0 && /^\s+$/.test(out[j]!)) j--;
      if (j >= 0 && out[j] === ',') out.splice(j, 1);
    }
    out.push(c);
  }
  return out.join('');
}

/**
 * Parse a JSONC document. Returns `undefined` on anything unparseable — the
 * caller records that as a fact (`unparsable-tsconfig`) rather than throwing,
 * because a broken tsconfig is the user's problem to fix and must never be the
 * reason `next dev` fails to start.
 */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonComments(text));
  } catch {
    return undefined;
  }
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function readJsoncFile(path: string, fs: ManifestFs): unknown {
  if (!fs.existsSync(path)) return undefined;
  try {
    return parseJsonc(fs.readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Env                                                                 *
 * ------------------------------------------------------------------ */

/**
 * The `.env` files Next loads for a dev or production run, in Next's own
 * precedence order.
 *
 * `.env.test` / `.env.test.local` are deliberately absent: Next reads those
 * only under `NODE_ENV=test`, which is a test harness's environment and not the
 * app Validity renders. Counting them would inflate the client-var count with
 * variables the real app never sees.
 */
export const NEXT_ENV_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
] as const;

/** The one prefix Next inlines into client bundles. Not configurable. */
export const NEXT_PUBLIC_PREFIX = 'NEXT_PUBLIC_';

/**
 * `NAME=` at the start of a line, optionally `export`-prefixed.
 *
 * The capture group is the NAME and nothing else — the value side is never
 * matched, never captured, and never reaches a caller. That is the mechanical
 * guarantee behind "values cannot leak into a committable file": there is no
 * code path in this module that holds one.
 */
const ENV_NAME_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Variable NAMES declared in a `.env` file's text. Values are not returned. */
export function envNamesFrom(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const name = ENV_NAME_RE.exec(line)?.[1];
    if (name) names.push(name);
  }
  return names;
}

/**
 * Summarize client env exposure from the `.env*` files at the app root.
 *
 * `dir` is what actually repairs the sandbox: without it, the sandbox (rooted
 * in `node_modules/.validity/`) loads no `.env` at all. The count is a
 * file-scan count — see {@link AppManifestEnv.exposedKeyCount} for the honest
 * limit on what a file scan can see.
 */
export function readEnvFacts(
  root: string,
  includeEnvKeys: boolean,
  fs: ManifestFs = nodeFs,
): AppManifestEnv {
  const seen = new Set<string>();
  for (const file of NEXT_ENV_FILES) {
    const abs = resolve(root, file);
    if (!fs.existsSync(abs)) continue;
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    for (const name of envNamesFrom(text)) {
      if (name.startsWith(NEXT_PUBLIC_PREFIX)) seen.add(name);
    }
  }
  const keys = [...seen].sort();
  const env: AppManifestEnv = {
    dir: toPosix(resolve(root)),
    prefixes: [NEXT_PUBLIC_PREFIX],
    exposedKeyCount: keys.length,
  };
  if (includeEnvKeys) env.exposedKeys = keys;
  return env;
}

/* ------------------------------------------------------------------ *
 * Aliases (tsconfig / jsconfig paths)                                 *
 * ------------------------------------------------------------------ */

/**
 * Config filenames probed at the app root, in TypeScript's own precedence
 * order. A JS-only Next app uses `jsconfig.json` and gets the same aliasing.
 */
export const TSCONFIG_FILES = ['tsconfig.json', 'jsconfig.json'] as const;

/** A `paths` pattern is mirrorable only in the exact `"<prefix>/*"` form. */
function isSimpleWildcard(spec: string): boolean {
  return spec.endsWith('/*') && spec.indexOf('*') === spec.length - 1;
}

/** `./x` and `../x` are followed; a bare specifier would mean resolving through node_modules. */
function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

/**
 * Resolve a relative `extends` target the way TypeScript does: the `.json`
 * extension is optional, and a directory means `<dir>/tsconfig.json`.
 */
function resolveExtendsTarget(fromDir: string, spec: string, fs: ManifestFs): string | undefined {
  const base = resolve(fromDir, spec);
  for (const candidate of [base, `${base}.json`, resolve(base, 'tsconfig.json')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Where a `compilerOptions` value came from — needed because TS resolves each relative to its OWN file. */
interface DeclaredOption<T> {
  value: T;
  /** Directory of the config file that declared it. */
  dir: string;
}

/**
 * Mirror `compilerOptions.paths` from `tsconfig.json` (or `jsconfig.json`) as
 * sandbox-usable aliases.
 *
 * Scope is deliberately narrow, in both directions:
 *
 * - Only `"@/*": ["./src/*"]`-shaped entries are mirrored. Multiple targets are
 *   a fallback CHAIN, mid-pattern wildcards need TS's longest-prefix matching,
 *   and an exact mapping is not prefix-shaped — re-implementing any of those in
 *   a second resolver is how a sandbox silently renders a different module
 *   graph than the app. Each unsupported entry is recorded, not dropped.
 * - `extends` is followed exactly ONE level, and only for a relative specifier.
 *   That covers the shape real apps use (a repo-root base config) without this
 *   package growing a config resolver. Anything beyond it is recorded as
 *   `unresolved-tsconfig-extends` so the alias list never claims to be
 *   exhaustive when it isn't.
 *
 * Target paths are resolved against `baseUrl` when one is declared (relative to
 * the file that declares IT, which may be the parent), and otherwise against
 * the directory of the config that declared `paths` — TypeScript's own rule
 * since 4.1.
 */
export function readTsconfigAliases(
  root: string,
  fs: ManifestFs = nodeFs,
): { aliases: AppManifestAlias[]; omitted: AppManifestOmittedAlias[] } {
  const aliases: AppManifestAlias[] = [];
  const omitted: AppManifestOmittedAlias[] = [];

  let configPath: string | undefined;
  for (const name of TSCONFIG_FILES) {
    const abs = resolve(root, name);
    if (fs.existsSync(abs)) {
      configPath = abs;
      break;
    }
  }
  if (!configPath) return { aliases, omitted };

  const localRaw = readJsoncFile(configPath, fs);
  const local = asObject(localRaw);
  if (!local) {
    omitted.push({ find: basename(configPath), reason: 'unparsable-tsconfig' });
    return { aliases, omitted };
  }

  const localDir = dirname(configPath);
  const localOptions = asObject(local.compilerOptions) ?? {};

  // --- one level of `extends` ------------------------------------------------
  let parentOptions: Record<string, unknown> = {};
  let parentDir = localDir;
  let parentExtendsFurther: string | undefined;
  const extendsSpec = typeof local.extends === 'string' ? local.extends : undefined;
  let unresolvedExtends: string | undefined;

  if (extendsSpec) {
    if (!isRelativeSpecifier(extendsSpec)) {
      unresolvedExtends = extendsSpec;
    } else {
      const parentPath = resolveExtendsTarget(localDir, extendsSpec, fs);
      const parent = parentPath ? asObject(readJsoncFile(parentPath, fs)) : undefined;
      if (!parent || !parentPath) {
        unresolvedExtends = extendsSpec;
      } else {
        parentOptions = asObject(parent.compilerOptions) ?? {};
        parentDir = dirname(parentPath);
        if (typeof parent.extends === 'string') parentExtendsFurther = parent.extends;
      }
    }
  }

  // --- effective paths + baseUrl (child wins per key, TS semantics) ----------
  let paths: DeclaredOption<Record<string, unknown>> | undefined;
  const localPaths = asObject(localOptions.paths);
  const parentPaths = asObject(parentOptions.paths);
  if (localPaths) paths = { value: localPaths, dir: localDir };
  else if (parentPaths) paths = { value: parentPaths, dir: parentDir };

  let baseUrl: DeclaredOption<string> | undefined;
  if (typeof localOptions.baseUrl === 'string') {
    baseUrl = { value: localOptions.baseUrl, dir: localDir };
  } else if (typeof parentOptions.baseUrl === 'string') {
    baseUrl = { value: parentOptions.baseUrl, dir: parentDir };
  }

  if (unresolvedExtends) {
    omitted.push({ find: unresolvedExtends, reason: 'unresolved-tsconfig-extends' });
  } else if (parentExtendsFurther && !paths) {
    // The one level we followed declared no `paths` either, so a config further
    // up the chain may well declare them. Say so rather than reporting "no
    // aliases" as though it were established.
    omitted.push({ find: parentExtendsFurther, reason: 'unresolved-tsconfig-extends' });
  }

  if (!paths) return { aliases, omitted };
  const baseDir = baseUrl ? resolve(baseUrl.dir, baseUrl.value) : paths.dir;

  // Object.keys order is the user's declaration order — the same stance the
  // Vite writer takes on alias order, and stable for a given file.
  for (const [pattern, rawTargets] of Object.entries(paths.value)) {
    const targets = Array.isArray(rawTargets)
      ? rawTargets.filter((t): t is string => typeof t === 'string')
      : [];
    const target = targets[0];
    if (
      targets.length !== 1 ||
      target === undefined ||
      !isSimpleWildcard(pattern) ||
      !isSimpleWildcard(target) ||
      pattern.length <= 2
    ) {
      omitted.push({ find: pattern, reason: 'unsupported-tsconfig-pattern' });
      continue;
    }
    aliases.push({
      find: pattern.slice(0, -2),
      replacement: toPosix(resolve(baseDir, target.slice(0, -2))),
    });
  }

  return { aliases, omitted };
}

/* ------------------------------------------------------------------ *
 * CSS                                                                 *
 * ------------------------------------------------------------------ */

/**
 * PostCSS config filenames, in the order PostCSS itself resolves them — the
 * same list `@validity.ai/verify-plugin-vite` probes, because the sandbox-side repair is
 * the same repair.
 */
export const POSTCSS_CONFIG_FILES = [
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
] as const;

/** First PostCSS config file present at `root`, absolute POSIX-style, or `null`. */
export function probePostcssConfig(root: string, fs: ManifestFs = nodeFs): string | null {
  for (const name of POSTCSS_CONFIG_FILES) {
    const abs = resolve(root, name);
    if (fs.existsSync(abs)) return toPosix(abs);
  }
  return null;
}

/** Dependency + devDependency names from the app's package.json. */
export function readDependencyNames(root: string, fs: ManifestFs = nodeFs): Set<string> {
  const pkg = asObject(readJsoncFile(resolve(root, 'package.json'), fs));
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const deps = asObject(pkg?.[field]);
    if (!deps) continue;
    for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

/**
 * Establish the Tailwind integration from declared dependencies plus the
 * presence of a PostCSS config.
 *
 * A Next app wires Tailwind through PostCSS or not at all — `@tailwindcss/vite`
 * is not a path it can take. The v4 signal is its own package
 * (`@tailwindcss/postcss`), which is unambiguous. The v3 signal (a bare
 * `tailwindcss` dependency) additionally requires a PostCSS config to be
 * present, because in v4 apps `tailwindcss` is still a dependency of the
 * `@tailwindcss/postcss` setup and a dependency alone proves installation, not
 * wiring. Reading the PostCSS config's CONTENTS would be better evidence still,
 * but that file is code — the writer does not execute or parse a user's build
 * config to answer a provenance question.
 */
export function detectTailwind(
  dependencyNames: ReadonlySet<string>,
  hasPostcssConfig: boolean,
): AppManifestTailwind {
  if (dependencyNames.has('@tailwindcss/postcss')) {
    return { detected: true, via: 'postcss', major: 4 };
  }
  if (dependencyNames.has('tailwindcss') && hasPostcssConfig) {
    return { detected: true, via: 'postcss', major: 3 };
  }
  return { detected: false, via: null, major: null };
}

/** CSS pipeline facts. `postcssPlugins` / `entryCss` are always empty — see schema.ts. */
export function readCssFacts(root: string, fs: ManifestFs = nodeFs): AppManifestCss {
  const postcssConfigPath = probePostcssConfig(root, fs);
  return {
    tailwind: detectTailwind(readDependencyNames(root, fs), postcssConfigPath !== null),
    postcssPlugins: [],
    postcssConfigPath,
    entryCss: [],
  };
}

/* ------------------------------------------------------------------ *
 * Assembly + serialization                                            *
 * ------------------------------------------------------------------ */

/** Build the manifest for a Next app rooted at `appRoot`. Pure apart from file reads. */
export function buildAppManifest(appRoot: string, options: BuildManifestOptions): AppManifest {
  const fs = options.fs ?? nodeFs;
  const root = toPosix(resolve(appRoot));
  const { aliases, omitted } = readTsconfigAliases(root, fs);

  return {
    schemaVersion: APP_MANIFEST_SCHEMA_VERSION,
    generator: { name: options.generatorName, version: options.generatorVersion },
    framework: 'next',
    root,
    // Next has no HTML/module entry pair. Recording `null` is what tells
    // Validity to keep using its own entry discovery — see AppManifestEntry.
    entry: { html: null, module: null },
    env: readEnvFacts(root, options.includeEnvKeys === true, fs),
    css: readCssFacts(root, fs),
    aliases,
    aliasesOmitted: omitted,
    // Next has no enumerable plugin list. Empty, never fabricated.
    plugins: [],
  };
}

/**
 * Serialize deterministically, byte-compatible with `@validity.ai/verify-plugin-vite`.
 *
 * `JSON.stringify` preserves insertion order and every object above is built in
 * a fixed literal order, so no key sorting is needed — and sorting would be
 * WRONG for `aliases`, whose order is load-bearing (a resolver matches by
 * declaration order). Two spaces plus a trailing newline match what Prettier
 * would write, so a committed manifest survives a repo-wide format pass
 * unchanged.
 */
export function serializeAppManifest(manifest: AppManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
