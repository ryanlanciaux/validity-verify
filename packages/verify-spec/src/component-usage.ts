/**
 * "Components used inside a screen" graph.
 *
 * The browse-redesign needs a quick way to say, given a screen file, which
 * of the project's known components are imported and rendered inside it.
 * That powers the "Used in this screen" list on the detail view — clicking
 * a row jumps to that component's own detail view without the user having
 * to grep for the import.
 *
 * Heuristic, not a type-checker:
 *
 *   1. Parse the screen source with Babel.
 *   2. Collect every imported identifier and the module specifier it came
 *      from (e.g., `import { Card } from '@/components/Card'` →
 *      `Card → @/components/Card`).
 *   3. Resolve each module specifier against the project's tsconfig paths
 *      OR plain relative resolution.
 *   4. For every JSX usage of an imported identifier, look up its resolved
 *      path. If that path is in the `componentPaths` set, record it.
 *
 * Path-alias resolution is deliberately limited — we look at `tsconfig.json`
 * `compilerOptions.paths` (the common `@/*` → `src/*` setup). Anything more
 * exotic (Vite aliases, custom resolvers) is out of scope; the user can
 * always pin a component in `.validity/config.ts`.
 *
 * Failure modes are all silent (empty result), never thrown — this is
 * decorative metadata, not load-bearing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse;

const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];

export interface TsconfigPathsMap {
  baseUrl: string;
  patterns: Array<{ prefix: string; mappings: string[] }>;
}

/**
 * Best-effort `tsconfig.json` paths reader. Looks for `tsconfig.json` at
 * the project root, then `compilerOptions.paths` + `compilerOptions.baseUrl`.
 * Returns null if anything is missing or malformed — caller falls back to
 * relative-only resolution.
 *
 * Supports the very common `"@/*": ["./src/*"]` shape. Multiple mappings
 * per pattern are honored (first existing one wins).
 */
export function readTsconfigPaths(projectRoot: string): TsconfigPathsMap | null {
  const candidates = ['tsconfig.json', 'tsconfig.base.json', 'jsconfig.json'];
  for (const name of candidates) {
    const full = resolve(projectRoot, name);
    if (!existsSync(full)) continue;
    try {
      const raw = readFileSync(full, 'utf-8');
      // tsconfig allows comments + trailing commas. Strip both before
      // JSON.parse. Comment stripping is a character scanner, NOT a regex —
      // path globs like `"@/*"` and include globs like a recursive `.ts`
      // double-star contain comment-open/close sequences, and a regex
      // stripper eats from one glob to the next, silently corrupting the
      // JSON so every `paths` alias disappears (mirrors the fixed parseJsonc
      // in @validity.ai/verify-native).
      const stripped = stripJsonComments(raw).replace(/,(\s*[}\]])/g, '$1');
      const json = JSON.parse(stripped) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const opts = json.compilerOptions ?? {};
      if (!opts.paths) continue;
      const baseUrl = resolve(projectRoot, opts.baseUrl ?? '.');
      const patterns: TsconfigPathsMap['patterns'] = [];
      for (const [pattern, mappings] of Object.entries(opts.paths)) {
        // Only the common `prefix/*` shape — exact-name aliases are rare
        // and not worth the special-case.
        if (!pattern.endsWith('/*')) continue;
        const prefix = pattern.slice(0, -2);
        const cleanedMappings = mappings.filter((m) => m.endsWith('/*')).map((m) => m.slice(0, -2));
        if (cleanedMappings.length === 0) continue;
        patterns.push({ prefix, mappings: cleanedMappings });
      }
      if (patterns.length === 0) continue;
      return { baseUrl, patterns };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Strip line (`//`) and block comments from JSONC without touching those
 * sequences inside string literals.
 */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        // Preserve the escaped character verbatim.
        out += next ?? '';
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Try every extension + `/index` variant on a base path. Returns the first
 * existing file (without extension still appended) or null.
 */
function resolveWithExtensions(baseAbs: string): string | null {
  if (existsSync(baseAbs)) {
    const lower = baseAbs.toLowerCase();
    if (
      lower.endsWith('.tsx') ||
      lower.endsWith('.ts') ||
      lower.endsWith('.jsx') ||
      lower.endsWith('.js')
    ) {
      return baseAbs;
    }
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = baseAbs + ext;
    if (existsSync(candidate)) return candidate;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = resolve(baseAbs, 'index' + ext);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve a module specifier (as written in the import) to an absolute
 * filesystem path. Handles:
 *   - relative paths (`./Card`, `../components/Card`)
 *   - tsconfig path aliases (`@/components/Card`)
 *   - absolute paths (rare in practice — accepted for completeness)
 *
 * Returns null for node_modules-style bare specifiers (`react`, `lodash`)
 * since those are never user components.
 */
export function resolveImportSpecifier(
  specifier: string,
  fromFile: string,
  paths: TsconfigPathsMap | null,
): string | null {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(fromFile), specifier);
    return resolveWithExtensions(base);
  }
  if (isAbsolute(specifier)) {
    return resolveWithExtensions(specifier);
  }
  if (paths) {
    for (const pattern of paths.patterns) {
      if (!specifier.startsWith(pattern.prefix)) continue;
      const rest = specifier.slice(pattern.prefix.length);
      for (const mapping of pattern.mappings) {
        const base = resolve(paths.baseUrl, mapping + rest);
        const found = resolveWithExtensions(base);
        if (found) return found;
      }
    }
  }
  // Bare specifier — not a user file.
  return null;
}

export interface ComponentUsageResult {
  /** Project-relative paths of components used inside the screen. */
  usedComponents: string[];
}

/**
 * Walk one screen file's AST and return the project-relative paths of any
 * known components used inside (where "known" means the path is in
 * `componentPaths`). The check is purely lexical — we don't try to follow
 * re-exports or detect runtime-conditional rendering.
 *
 * `componentPaths` is a Set for O(1) lookup; pass the same set you used to
 * build the sidebar.
 */
export function extractScreenComponentUsage(args: {
  projectRoot: string;
  screenPath: string;
  componentPaths: Set<string>;
  tsconfigPaths?: TsconfigPathsMap | null;
}): ComponentUsageResult {
  const { projectRoot, screenPath, componentPaths } = args;
  const tsconfigPaths = args.tsconfigPaths ?? readTsconfigPaths(projectRoot);
  const screenAbs = resolve(projectRoot, screenPath);
  let source: string;
  try {
    source = readFileSync(screenAbs, 'utf-8');
  } catch {
    return { usedComponents: [] };
  }
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
  } catch {
    return { usedComponents: [] };
  }

  // Local-name → resolved component path. Built by walking imports.
  const importMap = new Map<string, string>();

  traverse(ast, {
    ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
      const sourceValue = path.node.source.value;
      const resolved = resolveImportSpecifier(sourceValue, screenAbs, tsconfigPaths);
      if (!resolved) return;
      const relPath = relative(projectRoot, resolved).replaceAll('\\', '/');
      if (!componentPaths.has(relPath)) return;
      for (const spec of path.node.specifiers) {
        const local = spec.local.name;
        importMap.set(local, relPath);
      }
    },
  });

  if (importMap.size === 0) return { usedComponents: [] };

  const used = new Set<string>();
  traverse(ast, {
    JSXOpeningElement(path: NodePath<t.JSXOpeningElement>) {
      const name = path.node.name;
      if (name.type !== 'JSXIdentifier') return;
      const resolved = importMap.get(name.name);
      if (resolved) used.add(resolved);
    },
    // `React.createElement(SomeComp, ...)` style — rare, but cheap to support.
    CallExpression(path: NodePath<t.CallExpression>) {
      const callee = path.node.callee;
      if (callee.type !== 'MemberExpression') return;
      const obj = callee.object;
      const prop = callee.property;
      if (obj.type !== 'Identifier' || prop.type !== 'Identifier') return;
      if (obj.name !== 'React' || prop.name !== 'createElement') return;
      const first = path.node.arguments[0];
      if (!first || first.type !== 'Identifier') return;
      const resolved = importMap.get(first.name);
      if (resolved) used.add(resolved);
    },
  });

  return { usedComponents: Array.from(used).sort() };
}

/**
 * Convenience: bulk-build a `{ screenPath: usedComponents[] }` map. Skips
 * screens whose files can't be read or parsed (returned as absent keys).
 */
export function buildComponentUsageMap(args: {
  projectRoot: string;
  screens: string[];
  componentPaths: string[];
}): Record<string, string[]> {
  const componentSet = new Set(args.componentPaths);
  const tsconfigPaths = readTsconfigPaths(args.projectRoot);
  const out: Record<string, string[]> = {};
  for (const screen of args.screens) {
    const { usedComponents } = extractScreenComponentUsage({
      projectRoot: args.projectRoot,
      screenPath: screen,
      componentPaths: componentSet,
      tsconfigPaths,
    });
    if (usedComponents.length > 0) out[screen] = usedComponents;
  }
  return out;
}
