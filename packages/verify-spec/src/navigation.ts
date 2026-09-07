import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { discoverScreenFiles } from './screens.js';

const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse;

export interface NavigationEdge {
  /** Project-relative path of the source file (the screen file). */
  from: string;
  /** Route path string extracted from the navigation call (verbatim). */
  to: string;
  /** Short label for the trigger, e.g. '<Link to>', 'navigate()', 'router.push()'. */
  trigger: string;
  /** 1-indexed source line. */
  line: number;
  /** 1-indexed source column. */
  column: number;
}

export interface ResolvedNavigationEdge extends NavigationEdge {
  /** Project-relative path of the target screen file (resolved from `to` → routePath match). */
  toPath: string;
}

/**
 * JSX element name → list of `(attribute, trigger-label)` pairs we accept.
 * Order matters: first matching attribute wins per element.
 */
const JSX_NAV_RULES: Record<string, Array<{ attr: string; trigger: string }>> = {
  Link: [
    { attr: 'to', trigger: '<Link to>' },
    { attr: 'href', trigger: '<Link href>' },
  ],
  NavLink: [{ attr: 'to', trigger: '<NavLink to>' }],
  Navigate: [{ attr: 'to', trigger: '<Navigate to>' }],
  Redirect: [{ attr: 'to', trigger: '<Redirect to>' }],
};

/**
 * Extract a string-literal value from a JSX attribute, or `null` if the
 * attribute isn't a plain string (variable / template / expression /
 * conditional all fall through — we never guess at runtime values).
 */
function extractJsxStringAttr(
  attr: t.JSXAttribute,
): { value: string; line: number; column: number } | null {
  const value = attr.value;
  if (!value) return null;
  if (value.type === 'StringLiteral') {
    return {
      value: value.value,
      line: attr.loc?.start.line ?? 0,
      column: attr.loc?.start.column ?? 0,
    };
  }
  if (value.type === 'JSXExpressionContainer') {
    const expr = value.expression;
    if (expr.type === 'StringLiteral') {
      return {
        value: expr.value,
        line: attr.loc?.start.line ?? 0,
        column: attr.loc?.start.column ?? 0,
      };
    }
  }
  return null;
}

/**
 * Extract a string-literal first argument from a call expression. Skips
 * template literals, identifiers, member expressions, and any non-literal
 * shape.
 */
function extractFirstStringArg(
  node: t.CallExpression,
): { value: string; line: number; column: number } | null {
  const first = node.arguments[0];
  if (!first) return null;
  if (first.type !== 'StringLiteral') return null;
  return {
    value: first.value,
    line: node.loc?.start.line ?? 0,
    column: node.loc?.start.column ?? 0,
  };
}

/**
 * Babel-parse `source` and extract navigation edges. `filePath` is used
 * only to set `from` on the returned edges. Failures (parse error) return
 * an empty array — never throw.
 */
export function extractNavigationEdges(filePath: string, source: string): NavigationEdge[] {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
  } catch {
    return [];
  }

  const edges: NavigationEdge[] = [];

  traverse(ast, {
    JSXOpeningElement(path: NodePath<t.JSXOpeningElement>) {
      const name = path.node.name;
      if (name.type !== 'JSXIdentifier') return;
      const rules = JSX_NAV_RULES[name.name];
      if (!rules) return;
      for (const rule of rules) {
        const attr = path.node.attributes.find(
          (a): a is t.JSXAttribute =>
            a.type === 'JSXAttribute' &&
            a.name.type === 'JSXIdentifier' &&
            a.name.name === rule.attr,
        );
        if (!attr) continue;
        const extracted = extractJsxStringAttr(attr);
        if (!extracted) continue;
        edges.push({
          from: filePath,
          to: extracted.value,
          trigger: rule.trigger,
          line: extracted.line,
          column: extracted.column,
        });
        // First matching attribute wins per element — don't double-count
        // a `<Link to="/a" href="/b">` (illegal in practice anyway).
        return;
      }
    },
    CallExpression(path: NodePath<t.CallExpression>) {
      const callee = path.node.callee;
      let trigger: string | null = null;
      // navigate("…") / redirect("…") — bare identifier.
      if (callee.type === 'Identifier') {
        if (callee.name === 'navigate') trigger = 'navigate()';
        else if (callee.name === 'redirect') trigger = 'redirect()';
      } else if (callee.type === 'MemberExpression') {
        // router.push("…") / router.replace("…")
        const obj = callee.object;
        const prop = callee.property;
        if (
          obj.type === 'Identifier' &&
          obj.name === 'router' &&
          prop.type === 'Identifier' &&
          !callee.computed
        ) {
          if (prop.name === 'push') trigger = 'router.push()';
          else if (prop.name === 'replace') trigger = 'router.replace()';
        }
      }
      if (!trigger) return;
      const extracted = extractFirstStringArg(path.node);
      if (!extracted) return;
      edges.push({
        from: filePath,
        to: extracted.value,
        trigger,
        line: extracted.line,
        column: extracted.column,
      });
    },
  });

  return edges;
}

/**
 * Match a concrete route (`/posts/hello`) against a screen's routePath
 * pattern (`/posts/:slug`). `:param` segments accept any non-empty
 * segment. Static segments must match verbatim. Trailing slashes are
 * normalized away. Returns `true` if the edge's `to` could plausibly
 * land on this screen.
 */
function routeMatches(edgeTo: string, screenRoute: string): boolean {
  const normalize = (s: string): string[] => {
    const trimmed = s.replace(/^\//, '').replace(/\/$/, '');
    if (trimmed === '') return [];
    return trimmed.split('/');
  };
  const edgeParts = normalize(edgeTo);
  const screenParts = normalize(screenRoute);
  if (edgeParts.length !== screenParts.length) return false;
  for (let i = 0; i < edgeParts.length; i++) {
    const ep = edgeParts[i] ?? '';
    const sp = screenParts[i] ?? '';
    if (sp.startsWith(':')) {
      // `:slug` matches any non-empty segment.
      if (ep.length === 0) return false;
      continue;
    }
    if (ep !== sp) return false;
  }
  return true;
}

/**
 * Resolve each edge's `to` (a route string) to a target screen file
 * using the `screens` list (each screen's `routePath`). Edges with no
 * matching target are dropped. `:slug` segments match any non-empty
 * segment (so `/posts/:slug` matches an edge to `/posts/hello`).
 *
 * When multiple screens could match (e.g., a literal `/posts/hello`
 * matches both a literal screen and a `/posts/:slug` screen) the first
 * screen in the input order wins — callers can pre-sort to control
 * preference.
 */
export function resolveNavigationEdges(
  edges: NavigationEdge[],
  screens: Array<{ path: string; routePath?: string }>,
): ResolvedNavigationEdge[] {
  const withRoutes = screens.filter(
    (s): s is { path: string; routePath: string } =>
      typeof s.routePath === 'string' && s.routePath.length > 0,
  );
  const resolved: ResolvedNavigationEdge[] = [];
  for (const edge of edges) {
    const target = withRoutes.find((s) => routeMatches(edge.to, s.routePath));
    if (!target) continue;
    resolved.push({ ...edge, toPath: target.path });
  }
  return resolved;
}

/**
 * Convenience: discover screens, parse each source, extract + resolve.
 * Reads files with fs.readFileSync.
 *
 * The `screens` argument is the caller's authoritative screen list (merged
 * with any config overrides for `routePath`); we walk the filesystem
 * separately to find files whose contents to parse for navigation edges.
 * In practice the caller passes the same list it got from
 * `discoverScreenFiles`, but decoupling lets the browse server pre-merge
 * config-pinned routes before resolution.
 */
export function buildNavigationGraph(
  projectRoot: string,
  screens: Array<{ path: string; routePath?: string }>,
): ResolvedNavigationEdge[] {
  const discovered = discoverScreenFiles(projectRoot);
  const allEdges: NavigationEdge[] = [];
  for (const screen of discovered) {
    let source: string;
    try {
      source = readFileSync(resolve(projectRoot, screen.path), 'utf-8');
    } catch {
      continue;
    }
    allEdges.push(...extractNavigationEdges(screen.path, source));
  }
  return resolveNavigationEdges(allEdges, screens);
}
