import { gitWorkingTreeChanges } from './git.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse;

export interface SelectComponentsArgs {
  prompt: string;
  changedFiles?: string[];
  projectRoot: string;
  max?: number;
}

export function getChangedFilesFromGit(projectRoot: string): string[] {
  return gitWorkingTreeChanges(projectRoot);
}

export function isReactComponentFile(absolutePath: string): boolean {
  const lower = absolutePath.toLowerCase();
  if (!lower.endsWith('.tsx') && !lower.endsWith('.jsx')) return false;

  let source: string;
  try {
    source = readFileSync(absolutePath, 'utf-8');
  } catch {
    return false;
  }

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
  } catch {
    return false;
  }

  let hasComponent = false;

  // PascalCase name AND not SCREAMING_SNAKE_CASE (constants like
  // KOSAL_PIECE_PATHS look component-shaped on a first-letter check). A
  // component name has at least one lowercase letter after the leading
  // capital.
  const looksLikeComponentName = (name: string): boolean =>
    /^[A-Z]/.test(name) && /[a-z]/.test(name);

  // A function-shaped node "looks like a component" if its body contains
  // JSX or a React.createElement call. Skips PascalCase helpers like
  // `buildKosalPieces()` that return plain data objects.
  //
  // Walks the AST manually rather than via @babel/traverse on a detached
  // subtree (which needs scope/parent that's awkward to set up).
  const containsJsxOrCreateElement = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    const n = node as { type?: string } & Record<string, unknown>;
    if (n.type === 'JSXElement' || n.type === 'JSXFragment') return true;
    if (n.type === 'CallExpression') {
      const callee = n.callee as
        undefined | { type?: string; name?: string; property?: { type?: string; name?: string } };
      if (callee?.type === 'Identifier' && callee.name === 'createElement') return true;
      if (
        callee?.type === 'MemberExpression' &&
        callee.property?.type === 'Identifier' &&
        callee.property.name === 'createElement'
      )
        return true;
    }
    for (const key of Object.keys(n)) {
      if (
        key === 'loc' ||
        key === 'range' ||
        key === 'extra' ||
        key === 'leadingComments' ||
        key === 'trailingComments'
      )
        continue;
      const v = n[key];
      if (Array.isArray(v)) {
        for (const item of v) if (containsJsxOrCreateElement(item)) return true;
      } else if (v && typeof v === 'object') {
        if (containsJsxOrCreateElement(v)) return true;
      }
    }
    return false;
  };
  const fnLooksLikeComponent = (node: t.Node): boolean => {
    if (
      node.type !== 'FunctionDeclaration' &&
      node.type !== 'ArrowFunctionExpression' &&
      node.type !== 'FunctionExpression'
    ) {
      return false;
    }
    return containsJsxOrCreateElement((node as unknown as { body: unknown }).body);
  };

  // HOC wrapping (memo, forwardRef, observer, …). Accept the common HOC
  // names; reject everything else.
  const HOCS = new Set(['memo', 'forwardRef', 'observer']);

  // Shared acceptance test for the value assigned to a `const/let X = …`.
  // Used by BOTH the inline `export const X = …` path and the two-phase
  // specifier-only path (`const X = …; export { X }`), so the two can never
  // drift apart. Name-shape is checked by the caller.
  const initLooksLikeComponent = (init: t.Node | null | undefined): boolean => {
    if (!init) return false;
    if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
      return fnLooksLikeComponent(init);
    }
    if (init.type === 'CallExpression') {
      const callee = init.callee;
      const name =
        callee.type === 'Identifier'
          ? callee.name
          : callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
            ? callee.property.name
            : null;
      if (!name || !HOCS.has(name)) return false;
      const inner = init.arguments[0];
      if (
        inner &&
        (inner.type === 'ArrowFunctionExpression' || inner.type === 'FunctionExpression')
      ) {
        return fnLooksLikeComponent(inner);
      }
      // memo(SomeIdentifier) — accept; identifier resolution would require a
      // second pass we can defer.
      return true;
    }
    return false;
  };

  // Two-phase state for specifier-only exports (`const X = …; export { X }`,
  // the shadcn/ui house style). An export can lexically PRECEDE its
  // declaration, so we only collect during the traverse and decide after it
  // completes.
  const componentVars = new Set<string>();
  const exportedLocals = new Set<string>();

  traverse(ast, {
    ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
      const decl = path.node.declaration;
      if (
        decl.type === 'FunctionDeclaration' ||
        decl.type === 'ArrowFunctionExpression' ||
        decl.type === 'FunctionExpression'
      ) {
        if (fnLooksLikeComponent(decl)) hasComponent = true;
      } else if (decl.type === 'Identifier' || decl.type === 'CallExpression') {
        // Default-export of a referenced identifier (`export default Foo`)
        // or a HOC call (`export default memo(Foo)`). Without resolving
        // the reference we can't be sure, so accept — most real files
        // matching this shape ARE components.
        hasComponent = true;
      }
    },
    ExportNamedDeclaration(path: NodePath<t.ExportNamedDeclaration>) {
      const decl = path.node.declaration;
      if (!decl) {
        // Specifier-only export: `export { X }` / `export { X as default }`.
        // Record the LOCAL name and resolve it after the traverse.
        for (const spec of path.node.specifiers) {
          if (spec.type === 'ExportSpecifier') exportedLocals.add(spec.local.name);
        }
        return;
      }
      if (decl.type === 'FunctionDeclaration' && decl.id?.name) {
        if (looksLikeComponentName(decl.id.name) && fnLooksLikeComponent(decl)) {
          hasComponent = true;
        }
      } else if (decl.type === 'VariableDeclaration') {
        for (const v of decl.declarations) {
          if (v.id.type !== 'Identifier') continue;
          if (!looksLikeComponentName(v.id.name)) continue;
          // Plain identifier name isn't enough — \`KosalPieces\` is PascalCase
          // but holds a plain object. Validate the assigned value.
          if (initLooksLikeComponent(v.init)) hasComponent = true;
        }
      }
    },
    // --- Phase 1 collection for the specifier-only export pattern ---
    // Top-level `const/let X = …` whose value is component-shaped. Keying off
    // the collected SET (not name-shape alone) is what keeps
    // \`const KosalPieces = {…}; export { KosalPieces }\` rejected.
    VariableDeclaration(path: NodePath<t.VariableDeclaration>) {
      if (path.parent.type !== 'Program') return;
      for (const v of path.node.declarations) {
        if (v.id.type !== 'Identifier') continue;
        if (!looksLikeComponentName(v.id.name)) continue;
        if (initLooksLikeComponent(v.init)) componentVars.add(v.id.name);
      }
    },
    // Top-level `function X() { … }` returning JSX, for `export { X }`.
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      if (path.parent.type !== 'Program') return;
      const name = path.node.id?.name;
      if (!name || !looksLikeComponentName(name)) return;
      if (fnLooksLikeComponent(path.node)) componentVars.add(name);
    },
  });

  // Phase 2: resolve specifier-only exports against the collected set. Using
  // \`local.name\` handles both \`export { X }\` and the renaming forms
  // \`export { X as Y }\` / \`export { X as default }\`.
  if (!hasComponent) {
    hasComponent = [...exportedLocals].some((n) => componentVars.has(n));
  }

  return hasComponent;
}

/** True when a path lives under a `.validity/` directory (any depth). */
function isValidityInfraPath(path: string): boolean {
  return path.split(/[\\/]/).includes('.validity');
}

/**
 * Pick up to `max` React components to render. Pure heuristic: take the
 * changed-file list (passed in or pulled from `git diff HEAD` + untracked),
 * filter to .tsx/.jsx that look like real components, slice. The host LLM
 * (Claude Code's agent) decides what's interesting if the user wants to be
 * selective — they can pass `changedFiles` explicitly.
 *
 * `.validity/` infra (wrapper.gen.tsx / wrapper.user.tsx / config.ts) is
 * excluded: a dirty wrapper is a real `.tsx` React component that would enter
 * the candidate set via `git diff HEAD` and render-error every tick — it is
 * Validity's own scaffolding, never a user component to verify. This is the
 * RENDER-candidate filter only; spec-staleness and global-style detection
 * (watch.ts) key off `.validity/specs/` + config paths separately and are
 * untouched.
 */
export function selectComponentsToRender(args: SelectComponentsArgs): string[] {
  const max = args.max ?? 3;
  const candidates = (
    args.changedFiles && args.changedFiles.length > 0
      ? args.changedFiles
      : getChangedFilesFromGit(args.projectRoot)
  )
    .filter((f) => f.endsWith('.tsx') || f.endsWith('.jsx'))
    .filter((f) => !isValidityInfraPath(f))
    .map((f) => resolve(args.projectRoot, f))
    .filter(isReactComponentFile);

  return candidates.slice(0, max);
}

/**
 * Directories we never walk during component discovery. These are
 * either build artifacts (dist, build), framework caches (.next, .turbo,
 * .astro), Validity's own scratch space (.validity), or VCS/dep stores
 * (node_modules, .git). Skipping them keeps discovery snappy on large
 * monorepos and avoids false positives (e.g., bundled .tsx in dist/).
 */
const DISCOVERY_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.validity',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.astro',
  '.vercel',
  '.wrangler',
  'coverage',
  '.vite',
  '.svelte-kit',
  'public',
]);

export interface DiscoverComponentsOptions {
  /** Hard cap on returned paths. Default: 500. */
  max?: number;
  /** Optional override for skip-dir set (entry-name match, no path semantics). */
  skipDirs?: Set<string>;
}

/**
 * Walk the project tree and return every file that's likely a real React
 * component, as project-relative paths. Used by `validity browse` to
 * populate the sidebar when the user hasn't (yet) added explicit entries
 * to `components` in `.validity/config.ts`.
 *
 * Pure read — no side effects, no config writes. The browse server merges
 * the result into the config response so the sidebar shows discovered
 * components alongside explicitly-configured ones; the user can promote
 * any of them to a real config entry via "Save as fixture" at any time.
 *
 * Cheap: ~50-100ms on a typical 200-component repo (single fs walk +
 * Babel parse per .tsx). For larger repos the `max` cap bounds the cost.
 */
export function discoverComponentFiles(
  projectRoot: string,
  opts: DiscoverComponentsOptions = {},
): string[] {
  const max = opts.max ?? 500;
  const skip = opts.skipDirs ?? DISCOVERY_SKIP_DIRS;
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
      // Skip hidden dirs (dotfiles) and known build / cache dirs.
      if (entry.startsWith('.') && entry !== '.') {
        if (skip.has(entry)) continue;
        // Allow well-known config dirs like `.storybook/` only if they're
        // not in skip — for now, skip ALL dotfiles to stay conservative.
        continue;
      }
      if (skip.has(entry)) continue;
      const full = resolve(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
      } else if (stats.isFile()) {
        const lower = entry.toLowerCase();
        if (!lower.endsWith('.tsx') && !lower.endsWith('.jsx')) continue;
        // Skip test files — they're almost never the "component" the user
        // wants to browse, and parsing them all is wasted work.
        if (lower.includes('.test.') || lower.includes('.spec.')) continue;
        if (!isReactComponentFile(full)) continue;
        found.push(relative(projectRoot, full).replaceAll('\\', '/'));
      }
    }
  };

  walk(projectRoot);
  return found.sort();
}
