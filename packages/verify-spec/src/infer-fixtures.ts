/**
 * Auto-infer fixtures for a React component by reading its prop types
 * out of the source.
 *
 * The first time a user runs `validity browse`, the canvas is the
 * "are my components healthy?" pane — and "healthy" means they render
 * something coherent, not a sea of `Cannot read properties of
 * undefined (reading 'length')` boxes that come from auto-rendering
 * with `{}` against props that need shape. This module statically
 * analyzes the component's TypeScript types and synthesizes plausible
 * sample props (an `auto` fixture) so first-render works without the
 * user having to write any fixture by hand.
 *
 * Scope (v1):
 *   - Default-exported function component (or first PascalCase
 *     named-exported function).
 *   - Inline parameter type, same-file interface / type alias, or
 *     React.FC<Props> (or FC<Props>) generic argument.
 *   - Primitives (string / number / boolean / Date), arrays, nested
 *     object literals, intersection + union types, literal types.
 *   - Name-based heuristics for primitive values (`email`,
 *     `title`, `imageUrl`, `count`, `isLoading`, …) so the generated
 *     props look like data, not like `'Sample text'` everywhere.
 *   - Arrays: 5 elements with index-varied content so charts plot
 *     something.
 *
 * Out of scope (v1):
 *   - Cross-file type imports (resolving `import type { Foo } from '../types'`).
 *     Requires a TS program / language service; for now we fall back
 *     to `unknown` and the prop becomes `null` (or is omitted for
 *     optional fields), which usually still beats the original crash.
 *   - PropTypes (legacy runtime declarations).
 *   - Generics on the component itself.
 *   - Default-value extraction from destructured-param defaults
 *     (`function Foo({ size = 'md' })`). Easy follow-up.
 *
 * Failure mode: ANY parse error / unsupported shape / readFileSync
 * throw returns `null`. Callers fall back to the placeholder card
 * UX — better to say "we couldn't infer this one, here's how to add
 * a fixture" than to silently render garbage.
 */
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';

const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse;

/* ------------------------ Internal representation ------------------ */

interface PropField {
  name: string;
  optional: boolean;
  type: PropType;
  /**
   * Default expression captured from a destructured parameter
   * (`function Foo({ size = 'md' })` → `defaultValue: 'md'`). Only set
   * for literal / primitive defaults — function or identifier defaults
   * are skipped because they reference values we can't statically
   * evaluate. When set, takes precedence over name-based synthesis.
   */
  defaultValue?: string | number | boolean | null;
}

type PropType =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'array'; element: PropType }
  | { kind: 'object'; fields: PropField[] }
  | { kind: 'function' }
  | { kind: 'react-node' }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'union'; types: PropType[] }
  | { kind: 'unknown' };

/** The optional `children: ReactNode` field appended when a component clearly
 * renders children that its resolvable type didn't declare (PropsWithChildren,
 * DOM prop-bag intersections, body usage). Synthesis turns it into 'Testing'. */
const CHILDREN_FIELD: PropField = {
  name: 'children',
  optional: true,
  type: { kind: 'react-node' },
};

/**
 * Does the function body reference `children` anywhere (JSX `{children}`,
 * `props.children`, a body destructure)? A cheap recursive AST-object walk —
 * no scope analysis; a false positive just adds harmless placeholder text.
 */
function referencesChildren(fn: t.Function): boolean {
  const seen = new Set<object>();
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false;
    if (seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some(walk);
    const n = node as { type?: string; name?: string };
    if ((n.type === 'Identifier' || n.type === 'JSXIdentifier') && n.name === 'children') {
      return true;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      if (walk(value)) return true;
    }
    return false;
  };
  return walk(fn.body);
}

export interface InferredFixture {
  description: string;
  /** Props ready to be passed to the component. JSON-serializable. */
  props: Record<string, unknown>;
}

export interface InferenceResult {
  /**
   * Map of fixture name → inferred fixture. Components with no enumerable
   * variant axis get a single "auto" fixture; components with string/number
   * literal-union props (`variant: 'primary' | 'ghost'`) get one fixture per
   * variant value (named `"variant: primary"`, …) so the canvas galleries
   * every variant by default.
   */
  fixtures: Record<string, InferredFixture>;
}

const MAX_TYPE_DEPTH = 6;
const MAX_VALUE_DEPTH = 4;
const ARRAY_SAMPLE_COUNT = 5;

/**
 * Sentinel the sandbox entry replaces with a deep-default Proxy at hydration
 * time (web only — see `stripProxySentinels` for surfaces that can't hydrate).
 */
export const PROXY_SENTINEL = '__VALIDITY_PROXY__';

/** Variant-axis enumeration caps — keep the gallery a gallery, not a wall. */
const MAX_VARIANT_AXES = 3;
const MAX_VALUES_PER_AXIS = 8;
const MAX_VARIANT_FIXTURES = 16;

/**
 * Axis names that most likely mean "design-system variant", in priority
 * order. Fields not on this list still enumerate, but after these.
 */
const VARIANT_AXIS_PRIORITY = [
  'variant',
  'kind',
  'appearance',
  'intent',
  'severity',
  'tone',
  'status',
  'type',
  'color',
  'size',
  'state',
  'level',
  'shape',
  'emphasis',
];

/* ============================== Public API ============================ */

/**
 * Synthesize fixtures for the component at `absolutePath`. Returns
 * `null` if the file can't be parsed, no component is detected, or
 * no fields could be extracted.
 */
export function inferFixtures(absolutePath: string): InferenceResult | null {
  let source: string;
  try {
    source = readFileSync(absolutePath, 'utf-8');
  } catch {
    return null;
  }

  let ast: t.File;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    }) as unknown as t.File;
  } catch {
    return null;
  }

  const registry = collectNamedTypes(ast);
  const comp = findComponent(ast);
  if (!comp) return null;

  // Zero-param component → render with empty props. Covers the
  // `function ContactPage() { ... }` / `const Page = () => { ... }`
  // shape that's overwhelmingly common in React-Router / Next-style
  // apps where state comes from hooks (useParams, useNavigate, context)
  // instead of props. Previously these flagged "needs fixture" — but
  // there ARE no props to fixture, so the canvas should render them.
  if (!comp.fn.params[0]) {
    return emptyPropsResult('No props required');
  }

  const fields = extractFields(comp, registry);
  if (!fields) return null;

  // Last-resort children detection: the declared type didn't surface a
  // `children` field (it lives in an unresolvable extends / imported type),
  // but the component BODY clearly consumes children. Without this, the
  // preview renders an empty shell — synthesize 'Testing' content instead.
  if (fields.length > 0 && !fields.some((f) => f.name === 'children')) {
    if (referencesChildren(comp.fn)) fields.push(CHILDREN_FIELD);
  }

  // Empty-shape props (`function Foo({}: {})` or an untyped destructure
  // with no destructured keys) ALSO have nothing to infer and render
  // safely with `{}`. Treat the same as zero-param.
  if (fields.length === 0) {
    return emptyPropsResult('No props required');
  }

  // If every declared field is optional, the user's component is
  // committing to handle a `{}` call by definition. We still synthesize
  // values so the rendered preview looks like data (an optional `title`
  // becomes "Welcome back" rather than blank space) — but the synthesis
  // step is allowed to drop a field that would otherwise be `null`
  // (see synthesizeFixtures), which keeps optional-only components
  // rendering when name-based heuristics produce nothing useful.

  return { fixtures: synthesizeFixtures(fields) };
}

function emptyPropsResult(description: string): InferenceResult {
  return {
    fixtures: {
      auto: {
        description,
        props: {},
      },
    },
  };
}

/* ----------------------- Pass 1: named types ----------------------- */

interface TypeRegistry {
  interfaces: Map<string, t.TSInterfaceDeclaration>;
  aliases: Map<string, t.TSTypeAliasDeclaration>;
}

function collectNamedTypes(ast: t.File): TypeRegistry {
  const interfaces = new Map<string, t.TSInterfaceDeclaration>();
  const aliases = new Map<string, t.TSTypeAliasDeclaration>();
  traverse(ast, {
    TSInterfaceDeclaration(path: NodePath<t.TSInterfaceDeclaration>) {
      interfaces.set(path.node.id.name, path.node);
    },
    TSTypeAliasDeclaration(path: NodePath<t.TSTypeAliasDeclaration>) {
      aliases.set(path.node.id.name, path.node);
    },
  });
  return { interfaces, aliases };
}

/* ----------------------- Pass 2: find component -------------------- */

interface ComponentInfo {
  /** The function node. */
  fn: t.Function;
  /**
   * Explicit Props type extracted from a variable annotation like
   * `const Foo: React.FC<FooProps> = (...) => ...`. When set this
   * wins over the first-param annotation in `extractFields`.
   */
  explicitPropsType?: t.TSType;
}

function findComponent(ast: t.File): ComponentInfo | null {
  let result: ComponentInfo | null = null;

  traverse(ast, {
    ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
      const decl = path.node.declaration;
      const found = resolveExportedComponent(decl, path);
      if (found) {
        result = found;
        path.stop();
      }
    },
  });
  if (result) return result;

  // Fallback: first named export that looks like a component.
  traverse(ast, {
    ExportNamedDeclaration(path: NodePath<t.ExportNamedDeclaration>) {
      const decl = path.node.declaration;
      if (!decl) return;
      if (decl.type === 'FunctionDeclaration' && decl.id?.name && /^[A-Z]/.test(decl.id.name)) {
        result = { fn: decl };
        path.stop();
        return;
      }
      if (decl.type === 'VariableDeclaration') {
        for (const v of decl.declarations) {
          const comp = componentFromVariableDeclarator(v);
          if (comp) {
            result = comp;
            path.stop();
            return;
          }
        }
      }
    },
  });

  return result;
}

function resolveExportedComponent(
  decl: t.ExportDefaultDeclaration['declaration'],
  path: NodePath<t.ExportDefaultDeclaration>,
): ComponentInfo | null {
  if (
    decl.type === 'FunctionDeclaration' ||
    decl.type === 'ArrowFunctionExpression' ||
    decl.type === 'FunctionExpression'
  ) {
    return { fn: decl as t.Function };
  }
  if (decl.type === 'Identifier') {
    const binding = path.scope.getBinding(decl.name);
    if (binding) {
      const node = binding.path.node;
      if (node.type === 'VariableDeclarator') {
        return componentFromVariableDeclarator(node);
      }
      if (node.type === 'FunctionDeclaration') {
        return { fn: node };
      }
    }
  }
  return null;
}

function componentFromVariableDeclarator(v: t.VariableDeclarator): ComponentInfo | null {
  if (v.id.type !== 'Identifier') return null;
  if (!v.init) return null;
  if (!/^[A-Z]/.test(v.id.name)) return null;
  // Unwrap HOC wrappers like memo(...), forwardRef(...), observer(...) etc.
  // so `export const Foo = memo<FooProps>(props => ...)` still surfaces its
  // inner callback as the component function.
  const unwrapped = unwrapHocCall(v.init);
  const fnNode = unwrapped?.fn ?? v.init;
  if (fnNode.type !== 'ArrowFunctionExpression' && fnNode.type !== 'FunctionExpression') {
    return null;
  }
  const explicit = extractExplicitPropsType(v.id) ?? unwrapped?.genericPropsType ?? null;
  return {
    fn: fnNode as t.Function,
    explicitPropsType: explicit ?? undefined,
  };
}

const HOC_NAMES = new Set(['memo', 'forwardRef', 'observer', 'React.memo', 'React.forwardRef']);

/**
 * Unwrap a CallExpression that looks like a React HOC wrapping a function
 * component. Returns the inner function node and the generic type argument
 * if the call had one (`memo<Props>(callback)`).
 *
 * Recurses through nested HOCs (memo(forwardRef(...))) up to a small depth
 * to avoid pathological loops. Returns null when the expression isn't a
 * recognized HOC call shape.
 */
function unwrapHocCall(
  node: t.Expression,
  depth = 0,
): { fn: t.Expression; genericPropsType?: t.TSType } | null {
  if (depth > 3) return null;
  if (node.type !== 'CallExpression') return null;
  const callee = node.callee;
  let name: string | null = null;
  if (callee.type === 'Identifier') name = callee.name;
  else if (
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.property.type === 'Identifier'
  ) {
    name = `${callee.object.name}.${callee.property.name}`;
  }
  if (!name || !HOC_NAMES.has(name)) return null;
  const firstArg = node.arguments[0];
  if (!firstArg || firstArg.type === 'SpreadElement') return null;
  // memo<Props>(callback) — Babel exposes generics via typeParameters.
  const typeParams = (
    node as t.CallExpression & {
      typeParameters?: t.TSTypeParameterInstantiation;
    }
  ).typeParameters;
  const genericPropsType = typeParams?.params[0];
  if (firstArg.type === 'ArrowFunctionExpression' || firstArg.type === 'FunctionExpression') {
    return { fn: firstArg, genericPropsType: genericPropsType ?? undefined };
  }
  // Nested HOC: memo(forwardRef(callback))
  const nested = unwrapHocCall(firstArg as t.Expression, depth + 1);
  if (nested) {
    return {
      fn: nested.fn,
      genericPropsType: genericPropsType ?? nested.genericPropsType,
    };
  }
  return null;
}

/**
 * If the variable is annotated as `React.FC<Props>` / `FC<Props>` /
 * `React.FunctionComponent<Props>` / `ComponentType<Props>`, return
 * the generic parameter `Props`. Otherwise null.
 */
function extractExplicitPropsType(id: t.Identifier): t.TSType | null {
  const ann = id.typeAnnotation;
  if (!ann || ann.type !== 'TSTypeAnnotation') return null;
  const inner = ann.typeAnnotation;
  if (inner.type !== 'TSTypeReference') return null;
  const name = typeRefName(inner.typeName);
  if (
    name === 'React.FC' ||
    name === 'FC' ||
    name === 'React.FunctionComponent' ||
    name === 'FunctionComponent' ||
    name === 'React.ComponentType' ||
    name === 'ComponentType' ||
    name === 'React.VoidFunctionComponent' ||
    name === 'VoidFunctionComponent'
  ) {
    return inner.typeParameters?.params[0] ?? null;
  }
  return null;
}

type TypeNameNode = t.Identifier | t.TSQualifiedName;

function typeRefName(name: TypeNameNode): string {
  if (name.type === 'Identifier') return name.name;
  // TSQualifiedName: `React.FC`
  return `${typeRefName(name.left as TypeNameNode)}.${name.right.name}`;
}

/* ----------------------- Pass 3: extract fields -------------------- */

function extractFields(comp: ComponentInfo, registry: TypeRegistry): PropField[] | null {
  // When the variable was annotated `React.FC<Props>`, that wins for the field
  // TYPES — but the component's destructuring params can still carry defaults
  // (`const Login: FC<Props> = ({ initialInfoVisible = false }) => …`). Merge
  // those onto the resolved fields so a prop with an explicit default renders
  // in its real default state instead of a name-synthesized guess. Without
  // this, a boolean like `initialInfoVisible` synthesizes to `true` (see
  // generateBoolean's affirmative-default rule), silently opening a modal that
  // masks the component's base UI — and every base-state assertion with it.
  if (comp.explicitPropsType) {
    const resolved = resolveType(comp.explicitPropsType, registry, 0);
    if (resolved.kind === 'object') {
      const firstParam = comp.fn.params[0];
      if (firstParam && firstParam.type === 'ObjectPattern') {
        const defaults = collectDestructuringDefaults(firstParam);
        if (defaults.size > 0) {
          return resolved.fields.map((f) =>
            defaults.has(f.name) ? { ...f, defaultValue: defaults.get(f.name)! } : f,
          );
        }
      }
      return resolved.fields;
    }
  }

  const firstParam = comp.fn.params[0];
  if (!firstParam) return null;

  if (firstParam.type === 'ObjectPattern') {
    // Collect destructuring defaults so they can override name-based
    // synthesis later. `{ size = 'md' }` becomes a default of "md" on
    // the `size` field — much more accurate than guessing from the name.
    const defaults = collectDestructuringDefaults(firstParam);
    const typeAnn = firstParam.typeAnnotation;
    if (typeAnn && typeAnn.type === 'TSTypeAnnotation') {
      const resolved = resolveType(typeAnn.typeAnnotation, registry, 0);
      if (resolved.kind === 'object') {
        return resolved.fields.map((f) =>
          defaults.has(f.name) ? { ...f, defaultValue: defaults.get(f.name)! } : f,
        );
      }
    }
    // Untyped destructuring: keep the names so the component at least
    // gets all expected keys (set to `null`).
    return firstParam.properties.flatMap((p): PropField[] => {
      if (p.type === 'ObjectProperty' && p.key.type === 'Identifier') {
        const name = p.key.name;
        return [
          {
            name,
            optional: true,
            type: { kind: 'unknown' },
            ...(defaults.has(name) ? { defaultValue: defaults.get(name)! } : {}),
          },
        ];
      }
      if (p.type === 'RestElement') return [];
      return [];
    });
  }

  if (firstParam.type === 'Identifier') {
    const typeAnn = firstParam.typeAnnotation;
    if (typeAnn && typeAnn.type === 'TSTypeAnnotation') {
      const resolved = resolveType(typeAnn.typeAnnotation, registry, 0);
      if (resolved.kind === 'object') return resolved.fields;
    }
  }

  return null;
}

/**
 * Walk an ObjectPattern's properties and collect any literal default
 * expressions ({ key = 'val' }). Only primitives — null, true, false,
 * strings, numbers — survive the static extraction; identifier or
 * function defaults reference values we can't evaluate at static-analysis
 * time, so we skip them and fall back to name-based heuristics.
 */
function collectDestructuringDefaults(
  pattern: t.ObjectPattern,
): Map<string, string | number | boolean | null> {
  const out = new Map<string, string | number | boolean | null>();
  for (const p of pattern.properties) {
    if (p.type !== 'ObjectProperty') continue;
    if (p.key.type !== 'Identifier') continue;
    const name = p.key.name;
    const value = p.value;
    if (value.type !== 'AssignmentPattern') continue;
    const right = value.right;
    if (right.type === 'StringLiteral') out.set(name, right.value);
    else if (right.type === 'NumericLiteral') out.set(name, right.value);
    else if (right.type === 'BooleanLiteral') out.set(name, right.value);
    else if (right.type === 'NullLiteral') out.set(name, null);
    // Identifiers, calls, member access default to skip — those reference
    // values we can't statically evaluate.
  }
  return out;
}

function resolveType(node: t.TSType, registry: TypeRegistry, depth: number): PropType {
  if (depth > MAX_TYPE_DEPTH) return { kind: 'unknown' };

  switch (node.type) {
    case 'TSStringKeyword':
      return { kind: 'string' };
    case 'TSNumberKeyword':
      return { kind: 'number' };
    case 'TSBooleanKeyword':
      return { kind: 'boolean' };
    case 'TSNullKeyword':
    case 'TSUndefinedKeyword':
    case 'TSVoidKeyword':
      return { kind: 'unknown' };
    case 'TSArrayType':
      return { kind: 'array', element: resolveType(node.elementType, registry, depth + 1) };
    case 'TSTypeLiteral': {
      const fields = membersToFields(node.members, registry, depth);
      return { kind: 'object', fields };
    }
    case 'TSTypeReference':
      return resolveTypeReference(node, registry, depth);
    case 'TSUnionType':
      return {
        kind: 'union',
        types: node.types.map((sub) => resolveType(sub, registry, depth + 1)),
      };
    case 'TSIntersectionType': {
      const fields: PropField[] = [];
      for (const sub of node.types) {
        const resolved = resolveType(sub, registry, depth + 1);
        if (resolved.kind === 'object') {
          for (const f of resolved.fields) fields.push(f);
        }
      }
      if (fields.length > 0) return { kind: 'object', fields };
      return { kind: 'unknown' };
    }
    case 'TSLiteralType': {
      const lit = node.literal;
      if (
        lit.type === 'StringLiteral' ||
        lit.type === 'NumericLiteral' ||
        lit.type === 'BooleanLiteral'
      ) {
        return { kind: 'literal', value: lit.value };
      }
      return { kind: 'unknown' };
    }
    case 'TSFunctionType':
    case 'TSConstructorType':
      return { kind: 'function' };
    case 'TSParenthesizedType':
      return resolveType(node.typeAnnotation, registry, depth + 1);
    default:
      return { kind: 'unknown' };
  }
}

function resolveTypeReference(
  node: t.TSTypeReference,
  registry: TypeRegistry,
  depth: number,
): PropType {
  const name =
    node.typeName.type === 'Identifier' ? node.typeName.name : typeRefName(node.typeName);

  // Built-in / well-known names.
  if (name === 'Date') return { kind: 'date' };
  // PropsWithChildren<T> = T & { children?: ReactNode }. Unwrap T and append
  // the children field — otherwise a `<Button>{text}</Button>`-style component
  // renders EMPTY (no children synthesized) on the canvas.
  if (name === 'PropsWithChildren' || name === 'React.PropsWithChildren') {
    const inner = node.typeParameters?.params[0];
    const fields: PropField[] = [];
    if (inner) {
      const resolved = resolveType(inner, registry, depth + 1);
      if (resolved.kind === 'object') fields.push(...resolved.fields);
    }
    if (!fields.some((f) => f.name === 'children')) {
      fields.push(CHILDREN_FIELD);
    }
    return { kind: 'object', fields };
  }
  // DOM/lib prop bags (ButtonHTMLAttributes<...>, ComponentProps<'button'>,
  // HTMLProps<...>): we can't enumerate their hundreds of members statically,
  // but they all include `children` — and children is the one member whose
  // absence visibly breaks the preview (empty buttons/cards). Surface just
  // that, optional, so intersections like `ComponentProps<'button'> & {…}`
  // pick it up.
  if (
    /(^|\.)((\w+)?HTMLAttributes|DOMAttributes|HTMLProps|ComponentProps(WithRef|WithoutRef)?)$/.test(
      name,
    )
  ) {
    return { kind: 'object', fields: [CHILDREN_FIELD] };
  }
  if (
    name === 'ReactNode' ||
    name === 'React.ReactNode' ||
    name === 'ReactElement' ||
    name === 'React.ReactElement' ||
    name === 'JSX.Element' ||
    name === 'Element'
  ) {
    return { kind: 'react-node' };
  }
  if ((name === 'Array' || name === 'ReadonlyArray') && node.typeParameters?.params[0]) {
    return {
      kind: 'array',
      element: resolveType(node.typeParameters.params[0], registry, depth + 1),
    };
  }
  if (
    (name === 'Record' || name === 'Partial') &&
    node.typeParameters?.params[node.typeParameters.params.length - 1]
  ) {
    // Partial<T> still uses T's fields (just makes them optional).
    // Record<K, V>: we don't know any keys, so return unknown-shaped object.
    if (name === 'Partial') {
      const inner = node.typeParameters.params[0];
      if (inner) {
        const resolvedInner = resolveType(inner, registry, depth + 1);
        if (resolvedInner.kind === 'object') return resolvedInner;
      }
    }
    return { kind: 'object', fields: [] };
  }

  // Same-file interface / type alias.
  if (node.typeName.type === 'Identifier') {
    const iface = registry.interfaces.get(node.typeName.name);
    if (iface) {
      const fields = membersToFields(iface.body.body, registry, depth);
      // Pull in extends (e.g. `interface Foo extends Bar`).
      if (iface.extends) {
        for (const ext of iface.extends) {
          if (ext.expression.type === 'Identifier') {
            const parent = registry.interfaces.get(ext.expression.name);
            if (parent) {
              const parentFields = membersToFields(parent.body.body, registry, depth + 1);
              for (const f of parentFields) {
                if (!fields.find((existing) => existing.name === f.name)) {
                  fields.push(f);
                }
              }
            }
          }
        }
      }
      return { kind: 'object', fields };
    }
    const alias = registry.aliases.get(node.typeName.name);
    if (alias) {
      return resolveType(alias.typeAnnotation, registry, depth + 1);
    }
  }

  return { kind: 'unknown' };
}

function membersToFields(
  members: t.TSTypeElement[],
  registry: TypeRegistry,
  depth: number,
): PropField[] {
  const fields: PropField[] = [];
  for (const member of members) {
    if (member.type !== 'TSPropertySignature') continue;
    if (member.key.type !== 'Identifier') continue;
    const ann = member.typeAnnotation;
    fields.push({
      name: member.key.name,
      optional: member.optional === true,
      type:
        ann && ann.type === 'TSTypeAnnotation'
          ? resolveType(ann.typeAnnotation, registry, depth + 1)
          : { kind: 'unknown' },
    });
  }
  return fields;
}

/* ----------------------- Value synthesis --------------------------- */

function synthesizeFixtures(fields: PropField[]): Record<string, InferredFixture> {
  const props: Record<string, unknown> = {};
  for (const field of fields) {
    // Captured destructuring default wins — the user already told us
    // what value the component expects when the caller omits the prop.
    let v: unknown;
    if (field.defaultValue !== undefined) {
      v = field.defaultValue;
    } else {
      v = synthesizeValue(field.name, field.type, 0, 0);
    }
    // Skip every undefined — that's how we drop functions, react-nodes,
    // and any value we couldn't synthesize. The component receives no
    // key at all, not `null`; for an `onClick` prop, that means React
    // simply doesn't pass an event handler (most components tolerate
    // that better than `null`, which throws when invoked).
    if (v === undefined) continue;
    props[field.name] = v;
  }

  // Variant enumeration: a literal-union prop ("variant", "size", …) is a
  // design-system axis, and "show me my Button" should gallery EVERY value,
  // not collapse to the first. One fixture per (axis, value) — base props
  // with that single axis swapped — so the canvas renders each variant as
  // its own frame. No axis → single "auto" fixture, as before.
  const axes = findVariantAxes(fields);
  if (axes.length === 0) {
    return {
      auto: {
        description: 'Auto-inferred from prop types',
        props,
      },
    };
  }
  const fixtures: Record<string, InferredFixture> = {};
  for (const axis of axes) {
    for (const value of axis.values) {
      if (Object.keys(fixtures).length >= MAX_VARIANT_FIXTURES) return fixtures;
      fixtures[`${axis.name}: ${String(value)}`] = {
        description: `Auto-enumerated from \`${axis.name}\` prop type`,
        props: { ...props, [axis.name]: value },
      };
    }
  }
  return fixtures;
}

interface VariantAxis {
  name: string;
  values: Array<string | number>;
}

/**
 * Fields whose type is a union containing ≥2 distinct string/number literals.
 * Non-literal union members (an open `'a' | 'b' | string`) are ignored — the
 * literal subset still enumerates. Sorted by VARIANT_AXIS_PRIORITY (stable, so
 * unranked axes keep declaration order), capped at MAX_VARIANT_AXES.
 */
function findVariantAxes(fields: PropField[]): VariantAxis[] {
  const axes: VariantAxis[] = [];
  for (const field of fields) {
    if (field.type.kind !== 'union') continue;
    const seen = new Set<string | number>();
    const values: Array<string | number> = [];
    for (const sub of field.type.types) {
      if (sub.kind !== 'literal') continue;
      if (typeof sub.value !== 'string' && typeof sub.value !== 'number') continue;
      if (seen.has(sub.value)) continue;
      seen.add(sub.value);
      values.push(sub.value);
      if (values.length >= MAX_VALUES_PER_AXIS) break;
    }
    if (values.length < 2) continue;
    axes.push({ name: field.name, values });
  }
  const rank = (name: string): number => {
    const i = VARIANT_AXIS_PRIORITY.indexOf(name.toLowerCase());
    return i === -1 ? VARIANT_AXIS_PRIORITY.length : i;
  };
  axes.sort((a, b) => rank(a.name) - rank(b.name));
  return axes.slice(0, MAX_VARIANT_AXES);
}

/**
 * Remove every prop whose value is (or deeply contains) the PROXY_SENTINEL.
 * The web entry hydrates the sentinel into a deep-default Proxy; surfaces
 * that can't (the native companion ships props verbatim over the bridge)
 * must drop those keys or the component renders the literal sentinel string.
 */
export function stripProxySentinels(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    const cleaned = cleanSentinelValue(value);
    if (cleaned !== STRIP) out[key] = cleaned;
  }
  return out;
}

const STRIP = Symbol('strip');

function cleanSentinelValue(value: unknown): unknown {
  if (value === PROXY_SENTINEL) return STRIP;
  if (Array.isArray(value)) {
    return value.map(cleanSentinelValue).filter((v) => v !== STRIP);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = cleanSentinelValue(v);
      if (cleaned !== STRIP) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

/**
 * Whether a `children`-typed prop is plain renderable text — i.e. `string`,
 * `ReactNode`, an unresolved type, or a union containing any of those. Literal
 * unions and structured shapes return false so they keep their normal
 * synthesis.
 */
function childrenRendersText(type: PropType): boolean {
  switch (type.kind) {
    case 'string':
    case 'react-node':
    case 'unknown':
      return true;
    case 'union':
      return type.types.some(
        (sub) => sub.kind === 'string' || sub.kind === 'react-node' || sub.kind === 'unknown',
      );
    default:
      return false;
  }
}

function synthesizeValue(name: string, type: PropType, depth: number, index: number): unknown {
  if (depth > MAX_VALUE_DEPTH) return null;
  const lc = name.toLowerCase();

  // `children` typed as text or ReactNode otherwise resolves to `undefined`
  // (see the react-node case below), so the component renders with no visible
  // content — an empty button, a text-less card, a critical a11y button-name
  // violation. Seed it with placeholder copy so auto-mocked components
  // actually show something. Only when the type is genuinely renderable text
  // (string / ReactNode / unknown, or a union containing those); a children
  // prop with a specific shape falls through to normal synthesis.
  if (lc === 'children' && childrenRendersText(type)) {
    return 'Testing';
  }

  switch (type.kind) {
    case 'string':
      return generateString(lc, index);
    case 'number':
      return generateNumber(lc, index);
    case 'boolean':
      return generateBoolean(lc);
    case 'date':
      return generateDate(index);
    case 'literal':
      return type.value;
    case 'array': {
      const out: unknown[] = [];
      for (let i = 0; i < ARRAY_SAMPLE_COUNT; i++) {
        const v = synthesizeValue(singularize(name), type.element, depth + 1, i);
        // Drop both undefined AND null. A null array element typically
        // crashes consumers with \`.map(x => x.foo)\`, and a 5-element array
        // with one null is a strictly noisier preview than a 4-element
        // array of populated objects.
        if (v !== undefined && v !== null) out.push(v);
      }
      return out;
    }
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const f of type.fields) {
        // Use the captured destructuring default if present, otherwise
        // synthesize.
        const v =
          f.defaultValue !== undefined
            ? f.defaultValue
            : synthesizeValue(f.name, f.type, depth + 1, index);
        if (v === undefined && f.optional) continue;
        obj[f.name] = v ?? null;
      }
      return obj;
    }
    case 'union': {
      // Prefer the first non-null/undefined/unknown member. String
      // literal unions ("primary" | "ghost") collapse to the first.
      for (const sub of type.types) {
        if (sub.kind === 'literal') return sub.value;
        if (sub.kind !== 'unknown') {
          return synthesizeValue(name, sub, depth + 1, index);
        }
      }
      return null;
    }
    case 'function':
    case 'react-node':
      return undefined;
    case 'unknown':
      // Sentinel string the sandbox entry.tsx replaces with a deep-default
      // Proxy at hydration time. JSON can't carry a Proxy, but a Proxy is
      // the only value that satisfies arbitrary downstream property access
      // (`prop.foo.bar.length`) without crashing — which is exactly what
      // an unresolvable type means we have to support. Bare null would
      // crash the first \`.something\` read.
      return PROXY_SENTINEL;
  }
}

/* ------------------- Name-based value generators ------------------- */

function generateString(name: string, index: number): string {
  // Domain-specific shapes that crash consumers when given a generic
  // "Sample text". Chess components want a parseable FEN; markdown
  // consumers want valid markdown; codes want short tokens.
  if (name === 'fen' || name === 'position' || name.endsWith('fen') || name.endsWith('position')) {
    return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  }
  if (name === 'pgn' || name.endsWith('pgn')) {
    return '[Event "Sample"]\n[White "White"]\n[Black "Black"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 *';
  }
  if (name === 'square' || name.endsWith('square')) {
    return ['e4', 'd4', 'c4', 'f3', 'b5'][index % 5]!;
  }
  if (name === 'move' || name.endsWith('move')) {
    return ['e2e4', 'g1f3', 'b1c3', 'f1c4', 'd2d4'][index % 5]!;
  }
  if (name === 'side' || (name === 'color' && index % 2 === 0)) {
    // Chess-style side
    if (name === 'side') return ['white', 'black'][index % 2]!;
  }
  if (name === 'theme' || name === 'variant') {
    return ['default', 'primary', 'secondary', 'ghost', 'outline'][index % 5]!;
  }
  if (name === 'size' || name === 'variant' || name.endsWith('size')) {
    return ['md', 'sm', 'lg', 'xs', 'xl'][index % 5]!;
  }
  if (name === 'code' || name.endsWith('code') || name === 'sku') {
    return ['ABC-' + (1000 + index), 'XYZ-' + (2000 + index)][index % 2]!;
  }
  if (name === 'markdown' || name.endsWith('markdown') || name === 'md') {
    return '# Heading\n\nLorem **ipsum** dolor _sit_ amet.';
  }
  if (name === 'role') return ['admin', 'editor', 'viewer', 'guest', 'owner'][index % 5]!;
  if (name === 'lang') return 'en';
  if (name.includes('email'))
    return ['jane@example.com', 'alice@example.com', 'bob@example.com'][index % 3]!;
  if (name.includes('url') || name.includes('href') || name.includes('link') || name === 'src') {
    return name.includes('image') || name.includes('avatar') || name.includes('photo')
      ? 'https://i.pravatar.cc/300?img=' + ((index % 70) + 1)
      : 'https://example.com';
  }
  if (name.includes('avatar') || name.includes('photo'))
    return 'https://i.pravatar.cc/300?img=' + ((index % 70) + 1);
  if (name.includes('image') || name.includes('icon') || name.includes('thumbnail')) {
    return 'https://picsum.photos/seed/' + (index + 1) + '/400/300';
  }
  if (name === 'title' || name.endsWith('title') || name.includes('heading') || name === 'header') {
    return ['Welcome back', 'Project overview', 'Latest updates', 'Quick stats', 'Recent activity'][
      index % 5
    ]!;
  }
  if (
    name.includes('description') ||
    name.includes('body') ||
    name.includes('content') ||
    name === 'text' ||
    name === 'subtitle'
  ) {
    return 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt.';
  }
  if (name === 'name' || name === 'username' || name === 'fullname' || name.endsWith('name')) {
    return ['Jane Doe', 'Alice Carter', 'Bob Singh', 'Yuki Tanaka', 'Marcus Chen'][index % 5]!;
  }
  if (name.includes('date') || name.includes('time') || name.endsWith('at'))
    return generateDate(index);
  if (name.includes('phone') || name.includes('tel'))
    return '+1 555 0' + (100 + index).toString().padStart(3, '0');
  if (name === 'id' || name.endsWith('id') || name === 'key') return `id-${1000 + index}`;
  if (name.includes('color'))
    return ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#a855f7'][index % 5]!;
  if (name === 'label' || name.endsWith('label') || name === 'placeholder') {
    return ['Label', 'Field', 'Value', 'Option', 'Choice'][index % 5]!;
  }
  if (name === 'status') return ['active', 'pending', 'completed', 'archived', 'draft'][index % 5]!;
  if (name.includes('country'))
    return ['United States', 'Canada', 'Germany', 'Japan', 'Brazil'][index % 5]!;
  if (name.includes('city'))
    return ['San Francisco', 'Tokyo', 'Berlin', 'São Paulo', 'Toronto'][index % 5]!;
  if (name === 'currency') return 'USD';
  if (name === 'locale' || name === 'language') return 'en-US';
  return ['Sample text', 'Another value', 'Lorem ipsum', 'Dolor sit', 'Amet consectetur'][
    index % 5
  ]!;
}

function generateNumber(name: string, index: number): number {
  if (name === 'index' || name === 'i' || name === 'idx') return index;
  if (
    name.includes('count') ||
    name.includes('total') ||
    name.includes('quantity') ||
    name === 'qty'
  ) {
    return [12, 47, 8, 153, 23][index % 5]!;
  }
  if (name.includes('age')) return [24, 31, 45, 19, 58][index % 5]!;
  if (
    name.includes('price') ||
    name.includes('cost') ||
    name.includes('amount') ||
    name.includes('balance')
  ) {
    return [9.99, 24.5, 99.0, 12.75, 149.99][index % 5]!;
  }
  if (
    name.includes('percentage') ||
    name.includes('percent') ||
    name.includes('rate') ||
    name.includes('progress') ||
    name.includes('ratio') ||
    name.includes('share')
  ) {
    return [0.18, 0.42, 0.65, 0.81, 0.93][index % 5]!;
  }
  if (name.includes('width')) return [320, 480, 640, 800, 1024][index % 5]!;
  if (name.includes('height')) return [120, 240, 320, 480, 640][index % 5]!;
  if (name === 'year') return 2020 + (index % 5);
  if (name === 'month') return (index % 12) + 1;
  if (name === 'day') return (index % 28) + 1;
  if (name.includes('rating') || name.includes('score') || name.includes('stars')) {
    return [3.5, 4.2, 4.8, 2.7, 4.5][index % 5]!;
  }
  if (name.includes('value') || name.includes('measure') || name.includes('reading')) {
    return [12, 18, 24, 31, 27][index % 5]!;
  }
  if (name === 'id') return index + 1;
  // Default: monotonic-ish sample data so charts plot something.
  return [10, 18, 24, 31, 27][index % 5]!;
}

function generateBoolean(name: string): boolean {
  // "Negative" names — indicate the unusual / failure state — default
  // to false so the rendered component shows the happy path. Affirmative
  // names default to true.
  const negative = [
    'disabled',
    'loading',
    'error',
    'hidden',
    'empty',
    'invalid',
    'busy',
    'pending',
    'readonly',
    'deleted',
    'closed',
    'archived',
    'muted',
    'collapsed',
  ];
  for (const keyword of negative) {
    if (name.includes(keyword)) return false;
  }
  return true;
}

function generateDate(index: number): string {
  // Date strings spaced a week apart so timeseries data charts as a
  // smooth line, not a single dot.
  const d = new Date('2024-01-01T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + index * 7);
  return d.toISOString();
}

/**
 * Naively singularize an English plural. Used so sample array elements
 * pick up name-based heuristics from the element's "type" (e.g.,
 * `users: User[]` → element name `user`, which then hits the `name`
 * heuristic for sub-fields). Imperfect but unblocks the common case.
 */
function singularize(name: string): string {
  if (name.endsWith('ies') && name.length > 3) return name.slice(0, -3) + 'y';
  if (name.endsWith('ses') && name.length > 3) return name.slice(0, -2);
  if (name.endsWith('s') && name.length > 1 && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}
