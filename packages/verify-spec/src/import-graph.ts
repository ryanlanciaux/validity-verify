/**
 * Reverse import graph — ripple-aware change mapping for the watcher.
 *
 * `mapChangedFilesToSpecs` matches changed-file basenames against spec target
 * names, which misses the regression class a continuous monitor exists to
 * catch: editing a shared `Button.tsx` never re-verifies the spec targeting
 * the `LoginScreen` that imports it. This module closes that gap by expanding
 * a changed-file set UPWARD through "who imports this?" edges before the
 * spec mapping runs.
 *
 * Deliberately cheap and partial:
 *   - import specifiers are extracted with a regex scan, not Babel — this
 *     runs on every watch tick over the whole source tree, and an import
 *     statement's shape is regular enough that a parser buys nothing here
 *     (the Babel pass in component-usage.ts stays where fixture-grade JSX
 *     accuracy matters);
 *   - resolution reuses the proven tsconfig-paths + relative logic from
 *     component-usage.ts; bare package specifiers and unresolvable aliases
 *     are dropped, so the graph is intentionally partial — a missed edge
 *     degrades to today's basename-only behavior, never a false re-verify;
 *   - a per-session mtime-keyed cache means steady-state rebuilds re-scan
 *     only files that actually changed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  readTsconfigPaths,
  resolveImportSpecifier,
  type TsconfigPathsMap,
} from './component-usage.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']);

/**
 * Non-JS import targets whose CONTENT change re-renders the importer: stylesheets
 * (incl. CSS Modules), images/fonts inlined by the bundler, and data assets a
 * component imports directly. `resolveImportSpecifier` only tries JS extensions,
 * so `import './Button.css'` resolves to null there and a CSS edit produces zero
 * ripple — exactly the styling-drift regression the watcher exists to catch. We
 * add a reverse edge for these so the change ripples UP to the components that
 * import them (the asset itself never maps to a spec — its importers do).
 */
const ASSET_EXTENSIONS = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.styl',
  '.pcss',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.json',
  '.graphql',
  '.gql',
]);

/** The extension of a specifier after stripping `?raw`/`?url`/`#frag` suffixes. */
function assetExtOf(specifier: string): string | null {
  const clean = specifier.replace(/[?#].*$/, '');
  const dot = clean.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = clean.slice(dot).toLowerCase();
  return ASSET_EXTENSIONS.has(ext) ? clean : null;
}

/**
 * Resolve a relative / absolute / tsconfig-aliased ASSET import to its absolute
 * path if the literal file exists in-project. Mirrors `resolveImportSpecifier`'s
 * path handling but checks the literal file (assets have no extension guessing)
 * rather than appending JS extensions. Returns null for bare package specifiers.
 */
function resolveAssetSpecifier(
  specifier: string,
  fromFile: string,
  paths: TsconfigPathsMap | null,
): string | null {
  const clean = assetExtOf(specifier);
  if (!clean) return null;
  const bare = clean.replace(/[?#].*$/, '');
  const literal = (base: string): string | null => (existsSync(base) ? base : null);
  if (bare.startsWith('.')) return literal(resolve(dirname(fromFile), bare));
  if (isAbsolute(bare)) return literal(bare);
  if (paths) {
    for (const pattern of paths.patterns) {
      if (!bare.startsWith(pattern.prefix)) continue;
      const rest = bare.slice(pattern.prefix.length);
      for (const mapping of pattern.mappings) {
        const found = literal(resolve(paths.baseUrl, mapping + rest));
        if (found) return found;
      }
    }
  }
  return null;
}

/** Build/cache/output dirs never worth walking — mirrors the watch ignore set. */
const GRAPH_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.expo',
  '.validity',
]);

/** Hard bound on graph size — a monorepo-sized tree degrades, never hangs. */
const MAX_GRAPH_FILES = 5_000;

/**
 * Match the module specifier of every static/dynamic import shape we care
 * about, one alternative per shape (capture groups 1-4):
 *   1. `import … from '…'` / `export … from '…'` — the clause between the
 *      keyword and `from` may span lines (multiline named imports) but may
 *      NOT cross a quote, semicolon, or paren, so `import('…')` and a later
 *      statement's `from` can never be swallowed into one match;
 *   2. dynamic `import('…')`;
 *   3. `require('…')`;
 *   4. bare side-effect `import '…'`.
 */
const IMPORT_SPECIFIER_RE =
  /\b(?:import|export)\s*[^'";()]*?\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]|\brequire\s*\(\s*['"]([^'"\n]+)['"]|\bimport\s*['"]([^'"\n]+)['"]/g;

/** Extract raw module specifiers from one file's source text. Pure. */
export function scanImportSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (spec) out.push(spec);
  }
  return out;
}

/** Per-session scan cache: absolute path → its last-seen mtime + specifiers. */
export type ImportScanCache = Map<string, { mtimeMs: number; specifiers: string[] }>;

export function createImportScanCache(): ImportScanCache {
  return new Map();
}

/** importee (project-relative) → set of importer files (project-relative). */
export type ReverseImportGraph = Map<string, Set<string>>;

function isSourceFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  // Skip declaration files — they never re-render anything.
  if (name.endsWith('.d.ts')) return false;
  return SOURCE_EXTENSIONS.has(name.slice(dot));
}

/** Walk the project tree collecting source files, bounded and tolerant. */
export function discoverSourceFiles(projectRoot: string, max = MAX_GRAPH_FILES): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= max) return;
      if (entry.startsWith('.') || GRAPH_SKIP_DIRS.has(entry)) continue;
      const full = resolve(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
      } else if (stats.isFile() && isSourceFile(entry)) {
        found.push(full);
      }
    }
  };
  walk(projectRoot);
  return found;
}

/**
 * Build the reverse graph for a project. `files` defaults to a fresh
 * bounded walk; pass `cache` (kept across ticks) to skip re-scanning files
 * whose mtime hasn't moved. All keys/values are project-relative with `/`
 * separators (the same shape `mapChangedFilesToSpecs` consumes).
 */
export function buildReverseImportGraph(args: {
  projectRoot: string;
  files?: string[];
  cache?: ImportScanCache;
}): ReverseImportGraph {
  const { projectRoot } = args;
  const files = args.files ?? discoverSourceFiles(projectRoot);
  const tsconfigPaths = readTsconfigPaths(projectRoot);
  const graph: ReverseImportGraph = new Map();

  const toRel = (abs: string): string => relative(projectRoot, abs).split(sep).join('/');

  for (const file of files) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    let specifiers: string[];
    const cached = args.cache?.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
      specifiers = cached.specifiers;
    } else {
      try {
        specifiers = scanImportSpecifiers(readFileSync(file, 'utf-8'));
      } catch {
        continue;
      }
      args.cache?.set(file, { mtimeMs, specifiers });
    }
    const importerRel = toRel(file);
    for (const spec of specifiers) {
      // JS/TS import first; fall back to an asset import (css/svg/json/…) so a
      // stylesheet or asset edit ripples up to the components that import it.
      const resolved =
        resolveImportSpecifier(spec, file, tsconfigPaths) ??
        resolveAssetSpecifier(spec, file, tsconfigPaths);
      if (!resolved) continue;
      const importeeRel = toRel(resolved);
      // Only project-internal edges — a resolution that escaped the root
      // (../../elsewhere) is not ours to track.
      if (importeeRel.startsWith('..')) continue;
      let importers = graph.get(importeeRel);
      if (!importers) {
        importers = new Set();
        graph.set(importeeRel, importers);
      }
      importers.add(importerRel);
    }
  }
  return graph;
}

export interface ExpandedChanges {
  /** Changed files plus every (transitive) importer, project-relative. */
  files: string[];
  /** True when a cap tripped — callers must log it, never silently narrow. */
  truncated: boolean;
}

/**
 * Upward transitive closure: the changed files plus everything that
 * (transitively) imports them. Cycle-safe by construction (visited set);
 * bounded by `maxDepth` hops and `maxFiles` total so a hub file (a barrel
 * `index.ts` imported everywhere) degrades to "re-verify a lot, and say
 * so" rather than an unbounded sweep.
 */
export function expandChangedFiles(
  graph: ReverseImportGraph,
  changedFiles: string[],
  opts: { maxDepth?: number; maxFiles?: number } = {},
): ExpandedChanges {
  const maxDepth = opts.maxDepth ?? 8;
  const maxFiles = opts.maxFiles ?? 500;
  const normalized = changedFiles.map((f) => f.replace(/^\.\//, ''));
  const visited = new Set<string>(normalized);
  let frontier = normalized;
  let truncated = false;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      for (const importer of graph.get(file) ?? []) {
        if (visited.has(importer)) continue;
        if (visited.size >= maxFiles) {
          truncated = true;
          return { files: Array.from(visited), truncated };
        }
        visited.add(importer);
        next.push(importer);
      }
    }
    frontier = next;
  }
  // Frontier still had unexplored importers when depth ran out.
  if (frontier.some((f) => Array.from(graph.get(f) ?? []).some((i) => !visited.has(i)))) {
    truncated = true;
  }
  return { files: Array.from(visited), truncated };
}
