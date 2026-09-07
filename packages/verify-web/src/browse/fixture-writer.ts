/**
 * Fixture writer — persists props captured in browse mode back into
 * `.validity/config.ts` so the agent can re-render that exact state on
 * the next `validity__verify` run.
 *
 * Two write modes, chosen at runtime:
 *
 *   1. AST mode (preferred): parse the user's `.validity/config.ts`,
 *      locate `components[<componentPath>].fixtures[<fixtureName>]`,
 *      insert or update its `props` literal, and write the source back.
 *      Works when the config follows the seeded shape — an object
 *      literal (either bare `export default { … }` or
 *      `export default defineConfig({ … })`).
 *
 *   2. Sidecar JSON mode (fallback): when the AST walk can't find or
 *      mutate the target safely (computed keys, function-based config,
 *      imported merges, etc.), we write the fixture to
 *      `.validity/fixtures/<slug>.json` and the user wires it into
 *      their config manually. Plan notes this explicitly — the AST
 *      manipulation of arbitrary user code is the risky bit, so we
 *      degrade gracefully rather than mangle the file.
 *
 * The AST path uses the same Babel infrastructure already pulled in by
 * `@validity.ai/verify-spec` (parser, traverse, generator, types).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, type ParseResult } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import type { File } from '@babel/types';

const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse;
const generate = (_generate as unknown as { default: typeof _generate }).default ?? _generate;

const CONFIG_CANDIDATES = [
  '.validity/config.ts',
  '.validity/config.mts',
  '.validity/config.js',
  '.validity/config.mjs',
];

export interface WriteFixtureArgs {
  projectRoot: string;
  /** Project-relative component path. The key under `config.components`. */
  componentPath: string;
  /** Fixture name to insert/update under `components[path].fixtures`. */
  fixtureName: string;
  /** Props to record. Must be a plain JSON-serializable object. */
  props: Record<string, unknown>;
}

export type WriteFixtureMode = 'ast' | 'sidecar';

export interface WriteFixtureResult {
  ok: boolean;
  /** Path of the file that was modified or created. */
  writtenTo?: string;
  /** Which strategy succeeded. */
  mode?: WriteFixtureMode;
  /** Populated when ok=false; populated as a hint when ok=true + mode=sidecar. */
  error?: string;
}

/**
 * Top-level entry point. Returns a result object instead of throwing so
 * the HTTP middleware can shape a JSON error response cleanly. Tries the
 * AST path first; on any failure, falls through to the sidecar file.
 */
export function writeFixtureToConfig(args: WriteFixtureArgs): WriteFixtureResult {
  const configPath = findConfigPath(args.projectRoot);
  if (!configPath) {
    // No config at all — punt to sidecar so the user has *something*
    // to wire up after they run `validity init`.
    return writeSidecar(args, 'no .validity/config.{ts,js,mts,mjs} found');
  }

  // Only attempt the AST rewrite for TS/JS (not .mjs which we can also
  // parse, but the seeded config is .ts so the common path is covered).
  if (/\.(ts|mts|js|mjs)$/.test(configPath)) {
    const astResult = tryAstRewrite(configPath, args);
    if (astResult.ok) return astResult;
    return writeSidecar(args, astResult.error);
  }

  return writeSidecar(args, 'config has unrecognized extension');
}

function findConfigPath(projectRoot: string): string | null {
  for (const rel of CONFIG_CANDIDATES) {
    const abs = resolve(projectRoot, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * Attempt to mutate the user's config file via AST. Returns ok=true on
 * success; ok=false with a human-readable reason that callers use to
 * decide whether to fall back to the sidecar file.
 */
function tryAstRewrite(configPath: string, args: WriteFixtureArgs): WriteFixtureResult {
  let source: string;
  try {
    source = readFileSync(configPath, 'utf-8');
  } catch (err) {
    return { ok: false, error: `read ${configPath} failed: ${(err as Error).message}` };
  }

  let ast: ParseResult<File>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
  } catch (err) {
    return { ok: false, error: `parse failed: ${(err as Error).message}` };
  }

  // Find the exported config object literal.
  const root = findConfigObject(ast);
  if (!root) {
    return {
      ok: false,
      error: 'could not find an object literal under `export default` / `defineConfig({...})`',
    };
  }

  // Build / locate the chain root → components → <path> → fixtures → <name>.
  const components = upsertProperty(root, 'components', () => t.objectExpression([]));
  if (!t.isObjectExpression(components)) {
    return { ok: false, error: '`components` is not an object literal' };
  }
  const componentEntry = upsertProperty(components, args.componentPath, () =>
    t.objectExpression([]),
  );
  if (!t.isObjectExpression(componentEntry)) {
    return {
      ok: false,
      error: `components[${JSON.stringify(args.componentPath)}] is not an object literal`,
    };
  }
  const fixtures = upsertProperty(componentEntry, 'fixtures', () => t.objectExpression([]));
  if (!t.isObjectExpression(fixtures)) {
    return { ok: false, error: '`fixtures` is not an object literal' };
  }

  // Replace (or insert) the named fixture with a fresh literal
  // `{ props: <literal> }`. Idempotent — re-saving the same name just
  // overwrites the existing fixture's `props`.
  const propsExpr = jsonToAst(args.props);
  if (!propsExpr) {
    return { ok: false, error: 'props payload is not JSON-serializable to an AST literal' };
  }
  const fixtureExpr = t.objectExpression([t.objectProperty(t.identifier('props'), propsExpr)]);
  setProperty(fixtures, args.fixtureName, fixtureExpr);

  const out = generate(ast, { retainLines: false, jsescOption: { quotes: 'single' } }, source).code;
  try {
    writeFileSync(configPath, ensureTrailingNewline(out));
  } catch (err) {
    return { ok: false, error: `write failed: ${(err as Error).message}` };
  }
  return { ok: true, writtenTo: configPath, mode: 'ast' };
}

/**
 * Walk the AST to find the object literal Validity should mutate. We
 * support three patterns the seeded config + common idioms produce:
 *   - `export default { … }`
 *   - `export default defineConfig({ … })` (config helper from @validity.ai/verify-spec)
 *   - `export default someIdentifier;` where `someIdentifier` is declared
 *     at the top level as `const someIdentifier = { … } satisfies ValidityConfig;`
 */
function findConfigObject(ast: ParseResult<File>): t.ObjectExpression | null {
  let result: t.ObjectExpression | null = null;
  const topLevelConsts = new Map<string, t.ObjectExpression>();

  for (const node of ast.program.body) {
    if (!t.isVariableDeclaration(node)) continue;
    for (const decl of node.declarations) {
      if (!t.isIdentifier(decl.id) || !decl.init) continue;
      const init = unwrapTsCast(decl.init);
      if (t.isObjectExpression(init)) topLevelConsts.set(decl.id.name, init);
    }
  }

  traverse(ast, {
    ExportDefaultDeclaration(path) {
      const decl = unwrapTsCast(path.node.declaration);
      if (t.isObjectExpression(decl)) {
        result = decl;
        return;
      }
      if (
        t.isCallExpression(decl) &&
        t.isIdentifier(decl.callee, { name: 'defineConfig' }) &&
        decl.arguments.length > 0
      ) {
        const arg = unwrapTsCast(decl.arguments[0] as t.Expression);
        if (t.isObjectExpression(arg)) result = arg;
        return;
      }
      if (t.isIdentifier(decl)) {
        const obj = topLevelConsts.get(decl.name);
        if (obj) result = obj;
      }
    },
  });

  return result;
}

/** Strip TS `as const` / `satisfies` / type-assertion wrappers so we can see the underlying literal. */
function unwrapTsCast<T extends t.Node | null | undefined>(node: T): T {
  let cur = node as t.Node | null | undefined;
  while (
    cur &&
    (t.isTSAsExpression(cur) ||
      t.isTSSatisfiesExpression(cur) ||
      t.isTSTypeAssertion(cur) ||
      t.isTSNonNullExpression(cur))
  ) {
    cur = (cur as t.TSAsExpression).expression;
  }
  return cur as T;
}

/**
 * Find the property named `key` on `obj` and return its value expression.
 * If absent, append a fresh `{ key: factory() }` property and return the
 * new expression. Handles both bare identifier keys (`fixtures`) and
 * string-literal keys (`'src/Foo.tsx'`).
 */
function upsertProperty(
  obj: t.ObjectExpression,
  key: string,
  factory: () => t.Expression,
): t.Expression {
  const existing = findProperty(obj, key);
  if (existing && t.isObjectProperty(existing)) {
    return existing.value as t.Expression;
  }
  const value = factory();
  const useStringKey = !/^[A-Za-z_$][\w$]*$/.test(key);
  const newProp = t.objectProperty(useStringKey ? t.stringLiteral(key) : t.identifier(key), value);
  obj.properties.push(newProp);
  return value;
}

function setProperty(obj: t.ObjectExpression, key: string, value: t.Expression): void {
  const existing = findProperty(obj, key);
  if (existing && t.isObjectProperty(existing)) {
    existing.value = value;
    return;
  }
  const useStringKey = !/^[A-Za-z_$][\w$]*$/.test(key);
  obj.properties.push(
    t.objectProperty(useStringKey ? t.stringLiteral(key) : t.identifier(key), value),
  );
}

function findProperty(obj: t.ObjectExpression, key: string): t.ObjectMember | null {
  for (const p of obj.properties) {
    if (t.isObjectProperty(p) && propertyKeyMatches(p, key)) return p;
    if (t.isObjectMethod(p) && propertyKeyMatches(p as unknown as t.ObjectProperty, key)) return p;
  }
  return null;
}

function propertyKeyMatches(p: t.ObjectProperty, key: string): boolean {
  if (p.computed) return false;
  if (t.isIdentifier(p.key)) return p.key.name === key;
  if (t.isStringLiteral(p.key)) return p.key.value === key;
  if (t.isNumericLiteral(p.key)) return String(p.key.value) === key;
  return false;
}

/**
 * Convert a JSON-ish JS value into a Babel expression literal. Returns
 * null if the value contains anything we can't safely materialize
 * (functions, symbols, undefined, BigInt). undefined is treated as
 * "leave it out" at the property level — callers shouldn't pass it in.
 */
function jsonToAst(value: unknown): t.Expression | null {
  if (value === null) return t.nullLiteral();
  switch (typeof value) {
    case 'string':
      return t.stringLiteral(value);
    case 'number':
      if (!Number.isFinite(value)) return null;
      return value >= 0
        ? t.numericLiteral(value)
        : t.unaryExpression('-', t.numericLiteral(-value));
    case 'boolean':
      return t.booleanLiteral(value);
    case 'object': {
      if (Array.isArray(value)) {
        const elems: (t.Expression | null)[] = [];
        for (const item of value) {
          const v = jsonToAst(item);
          if (v === null && item !== null) return null;
          elems.push(v ?? t.nullLiteral());
        }
        return t.arrayExpression(elems);
      }
      const obj = value as Record<string, unknown>;
      const props: t.ObjectProperty[] = [];
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        const valueExpr = jsonToAst(v);
        if (valueExpr === null) return null;
        const useStringKey = !/^[A-Za-z_$][\w$]*$/.test(k);
        props.push(
          t.objectProperty(useStringKey ? t.stringLiteral(k) : t.identifier(k), valueExpr),
        );
      }
      return t.objectExpression(props);
    }
    default:
      return null;
  }
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : s + '\n';
}

/**
 * Sidecar fallback — write the fixture as a JSON file under
 * `.validity/fixtures/`. The user can either hand-edit `.validity/config.ts`
 * to wire it up or we ship a follow-up loader. Returns ok=true so the
 * caller treats it as success (the data is captured), but includes the
 * `error` hint so the UI can mention the manual step.
 */
function writeSidecar(args: WriteFixtureArgs, reason?: string): WriteFixtureResult {
  const dir = resolve(args.projectRoot, '.validity', 'fixtures');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const slug = slugifyFixture(args.componentPath, args.fixtureName);
  const out = resolve(dir, `${slug}.json`);
  const payload = {
    componentPath: args.componentPath,
    fixtureName: args.fixtureName,
    props: args.props,
  };
  try {
    writeFileSync(out, JSON.stringify(payload, null, 2) + '\n');
  } catch (err) {
    return { ok: false, error: `sidecar write failed: ${(err as Error).message}` };
  }
  return {
    ok: true,
    writtenTo: out,
    mode: 'sidecar',
    error: reason
      ? `fell back to sidecar JSON (${reason}); add to .validity/config.ts manually`
      : 'fell back to sidecar JSON; add to .validity/config.ts manually',
  };
}

function slugifyFixture(componentPath: string, fixtureName: string): string {
  const slug = (s: string) =>
    s
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'unnamed';
  return `${slug(componentPath)}__${slug(fixtureName)}`;
}

/**
 * One item inside a View — mirrors the public `ViewItem` shape but kept
 * local so the writer doesn't need a @validity.ai/verify-spec type import at the
 * .js layer the bundled installer uses.
 */
export interface WriteViewItem {
  componentPath: string;
  fixtureName?: string;
  props?: Record<string, unknown>;
  label?: string;
  /** Frame group id — items sharing a value render in one device frame. */
  frame?: string;
}

export interface WriteViewArgs {
  projectRoot: string;
  /** Unique view name. The key under `config.views`. */
  name: string;
  view: {
    title?: string;
    description?: string;
    layout?: 'stack' | 'grid';
    items: WriteViewItem[];
  };
}

/**
 * Persist a view definition into `.validity/config.ts` under
 * `views[name]`. Same AST mechanics + sidecar fallback as fixture writing.
 * Idempotent — re-saving an existing name overwrites that view.
 *
 * Collision checks (name vs. components / screens / other views) belong to
 * the caller — this function only handles serialization.
 */
export function writeViewToConfig(args: WriteViewArgs): WriteFixtureResult {
  const configPath = findConfigPath(args.projectRoot);
  if (!configPath) {
    return writeViewSidecar(args, 'no .validity/config.{ts,js,mts,mjs} found');
  }
  if (!/\.(ts|mts|js|mjs)$/.test(configPath)) {
    return writeViewSidecar(args, 'config has unrecognized extension');
  }

  let source: string;
  try {
    source = readFileSync(configPath, 'utf-8');
  } catch (err) {
    return { ok: false, error: `read ${configPath} failed: ${(err as Error).message}` };
  }

  let ast: ParseResult<File>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
  } catch (err) {
    return writeViewSidecar(args, `parse failed: ${(err as Error).message}`);
  }

  const root = findConfigObject(ast);
  if (!root) {
    return writeViewSidecar(
      args,
      'could not find an object literal under `export default` / `defineConfig({...})`',
    );
  }

  const views = upsertProperty(root, 'views', () => t.objectExpression([]));
  if (!t.isObjectExpression(views)) {
    return writeViewSidecar(args, '`views` is not an object literal');
  }

  const viewExpr = viewToAst(args.view);
  if (!viewExpr) {
    return writeViewSidecar(
      args,
      'view payload contained values not serializable to an AST literal',
    );
  }
  setProperty(views, args.name, viewExpr);

  const out = generate(ast, { retainLines: false, jsescOption: { quotes: 'single' } }, source).code;
  try {
    writeFileSync(configPath, ensureTrailingNewline(out));
  } catch (err) {
    return { ok: false, error: `write failed: ${(err as Error).message}` };
  }
  return { ok: true, writtenTo: configPath, mode: 'ast' };
}

export interface DeleteViewArgs {
  projectRoot: string;
  name: string;
}

/**
 * Remove `views[name]` from `.validity/config.ts`. Silently succeeds if
 * the view isn't there (idempotent from the caller's perspective).
 */
export function deleteViewFromConfig(args: DeleteViewArgs): WriteFixtureResult {
  const configPath = findConfigPath(args.projectRoot);
  if (!configPath) {
    return { ok: false, error: 'no .validity/config.{ts,js,mts,mjs} found' };
  }
  if (!/\.(ts|mts|js|mjs)$/.test(configPath)) {
    return { ok: false, error: 'config has unrecognized extension' };
  }

  let source: string;
  try {
    source = readFileSync(configPath, 'utf-8');
  } catch (err) {
    return { ok: false, error: `read ${configPath} failed: ${(err as Error).message}` };
  }

  let ast: ParseResult<File>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
  } catch (err) {
    return { ok: false, error: `parse failed: ${(err as Error).message}` };
  }

  const root = findConfigObject(ast);
  if (!root) {
    return { ok: false, error: 'could not find the config object literal' };
  }

  const viewsProp = findProperty(root, 'views');
  if (!viewsProp || !t.isObjectProperty(viewsProp) || !t.isObjectExpression(viewsProp.value)) {
    // No `views` block at all → nothing to delete.
    return { ok: true, writtenTo: configPath, mode: 'ast' };
  }
  const before = viewsProp.value.properties.length;
  viewsProp.value.properties = viewsProp.value.properties.filter(
    (p) => !(t.isObjectProperty(p) && propertyKeyMatches(p, args.name)),
  );
  if (viewsProp.value.properties.length === before) {
    // Name not present → no rewrite needed.
    return { ok: true, writtenTo: configPath, mode: 'ast' };
  }

  const out = generate(ast, { retainLines: false, jsescOption: { quotes: 'single' } }, source).code;
  try {
    writeFileSync(configPath, ensureTrailingNewline(out));
  } catch (err) {
    return { ok: false, error: `write failed: ${(err as Error).message}` };
  }
  return { ok: true, writtenTo: configPath, mode: 'ast' };
}

function viewToAst(view: WriteViewArgs['view']): t.Expression | null {
  const props: t.ObjectProperty[] = [];
  if (view.title !== undefined) {
    props.push(t.objectProperty(t.identifier('title'), t.stringLiteral(view.title)));
  }
  if (view.description !== undefined) {
    props.push(t.objectProperty(t.identifier('description'), t.stringLiteral(view.description)));
  }
  if (view.layout !== undefined) {
    props.push(t.objectProperty(t.identifier('layout'), t.stringLiteral(view.layout)));
  }
  const itemExprs: t.Expression[] = [];
  for (const item of view.items) {
    const itemProps: t.ObjectProperty[] = [
      t.objectProperty(t.identifier('componentPath'), t.stringLiteral(item.componentPath)),
    ];
    if (item.fixtureName !== undefined) {
      itemProps.push(
        t.objectProperty(t.identifier('fixtureName'), t.stringLiteral(item.fixtureName)),
      );
    }
    if (item.label !== undefined) {
      itemProps.push(t.objectProperty(t.identifier('label'), t.stringLiteral(item.label)));
    }
    if (item.frame !== undefined) {
      itemProps.push(t.objectProperty(t.identifier('frame'), t.stringLiteral(item.frame)));
    }
    if (item.props !== undefined) {
      const propsExpr = jsonToAst(item.props);
      if (!propsExpr) return null;
      itemProps.push(t.objectProperty(t.identifier('props'), propsExpr));
    }
    itemExprs.push(t.objectExpression(itemProps));
  }
  props.push(t.objectProperty(t.identifier('items'), t.arrayExpression(itemExprs)));
  return t.objectExpression(props);
}

function writeViewSidecar(args: WriteViewArgs, reason?: string): WriteFixtureResult {
  const dir = resolve(args.projectRoot, '.validity', 'views');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const slug = args.name.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || 'unnamed';
  const out = resolve(dir, `${slug}.json`);
  try {
    writeFileSync(out, JSON.stringify({ name: args.name, ...args.view }, null, 2) + '\n');
  } catch (err) {
    return { ok: false, error: `sidecar write failed: ${(err as Error).message}` };
  }
  return {
    ok: true,
    writtenTo: out,
    mode: 'sidecar',
    error: reason
      ? `fell back to sidecar JSON (${reason}); wire it into .validity/config.ts manually`
      : 'fell back to sidecar JSON; wire it into .validity/config.ts manually',
  };
}

export interface WriteComponentScenariosArgs {
  projectRoot: string;
  componentPath: string;
  /** Allow-list of scenario ids. Pass [] to mean "no scenarios apply"; omit
   *  the field entirely (pass undefined) to delete the override and fall
   *  back to "all scenarios" behaviour. */
  scenarios: string[] | undefined;
}

/**
 * Persist a per-component `scenarios` allow-list into `.validity/config.ts`.
 * Same AST mechanics + sidecar fallback as fixture writing — the only
 * difference is the target property (`components[path].scenarios` instead
 * of `components[path].fixtures[name].props`).
 */
export function writeComponentScenariosToConfig(
  args: WriteComponentScenariosArgs,
): WriteFixtureResult {
  const configPath = findConfigPath(args.projectRoot);
  if (!configPath) {
    return {
      ok: false,
      error: 'no .validity/config.{ts,js,mts,mjs} found — run `validity init`',
    };
  }
  if (!/\.(ts|mts|js|mjs)$/.test(configPath)) {
    return { ok: false, error: 'config has unrecognized extension' };
  }

  let source: string;
  try {
    source = readFileSync(configPath, 'utf-8');
  } catch (err) {
    return { ok: false, error: `read ${configPath} failed: ${(err as Error).message}` };
  }

  let ast: ParseResult<File>;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
  } catch (err) {
    return { ok: false, error: `parse failed: ${(err as Error).message}` };
  }

  const root = findConfigObject(ast);
  if (!root) {
    return {
      ok: false,
      error: 'could not find an object literal under `export default` / `defineConfig({...})`',
    };
  }

  const components = upsertProperty(root, 'components', () => t.objectExpression([]));
  if (!t.isObjectExpression(components)) {
    return { ok: false, error: '`components` is not an object literal' };
  }
  const componentEntry = upsertProperty(components, args.componentPath, () =>
    t.objectExpression([]),
  );
  if (!t.isObjectExpression(componentEntry)) {
    return {
      ok: false,
      error: `components[${JSON.stringify(args.componentPath)}] is not an object literal`,
    };
  }

  if (args.scenarios === undefined) {
    // Delete the `scenarios` property entirely.
    componentEntry.properties = componentEntry.properties.filter(
      (p) => !(t.isObjectProperty(p) && propertyKeyMatches(p, 'scenarios')),
    );
  } else {
    const arrExpr = t.arrayExpression(args.scenarios.map((s) => t.stringLiteral(s)));
    setProperty(componentEntry, 'scenarios', arrExpr);
  }

  const out = generate(ast, { retainLines: false, jsescOption: { quotes: 'single' } }, source).code;
  try {
    writeFileSync(configPath, ensureTrailingNewline(out));
  } catch (err) {
    return { ok: false, error: `write failed: ${(err as Error).message}` };
  }
  return { ok: true, writtenTo: configPath, mode: 'ast' };
}
