/**
 * Wrapper fidelity (A1) — how faithfully the generated `.validity/wrapper.gen.tsx`
 * reproduces the real app's provider tree. A degraded wrapper (a passthrough
 * fallback, or one missing providers the app depends on) is EVIDENCE-TAINTING:
 * a render under it can look right for the wrong reason, so downstream surfaces
 * read `status === 'degraded'` and taint the verdict (`'wrapper'`).
 *
 * Static comparison, not a runtime probe: the generator's post-rewrite
 * `expectedProviderChain` (what the entry declares) is compared against the
 * provider chain actually wrapping the `{children}` slot in the wrapper source
 * that will render. Deterministic, works on any source string (including the
 * `manual-required` path where no render ever happens), and catches all four
 * real degradation paths: passthrough fallback, user-edited `wrapper.gen.tsx`,
 * preserved-wrapper-under-drift, and generator regressions. `verified` means
 * "statically identical provider chain" — never semantic correctness.
 *
 * Pure module: no IO. Callers (ensure-configured) read sources from disk.
 */
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

const traverse = (_traverse as unknown as { default: typeof _traverse }).default ?? _traverse;

/** Fidelity verdict for the generated wrapper. */
export type WrapperFidelity = 'verified' | 'degraded' | 'unknown';

export interface WrapperFidelityInfo {
  status: WrapperFidelity;
  /** Providers the app expects that the generated wrapper does NOT reproduce. */
  missingProviders: string[];
  /** Providers the app's entry tree was found to declare. */
  expectedProviders: string[];
  /** How the wrapper was analyzed to reach this verdict. */
  analyzed: 'generated' | 'on-disk' | 'passthrough' | 'signature-cache';
  detail?: string;
}

/**
 * Providers that satisfy a router-context expectation interchangeably — a
 * user-edited wrapper keeping `BrowserRouter` where the generator expects
 * `MemoryRouter` still provides router context, so it never degrades.
 */
export const ROUTER_EQUIVALENTS: ReadonlySet<string> = new Set([
  'MemoryRouter',
  'BrowserRouter',
  'HashRouter',
  'RouterProvider',
]);

/**
 * Textual provider signals the regex fallback scans an entry file for when
 * generation failed (no AST to walk). Module ids mirror the auto-mock
 * detector's known provider-bearing packages.
 */
const PROVIDER_MODULE_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/from\s+['"]react-router-dom['"]/, 'MemoryRouter'],
  [/from\s+['"]convex\/react['"]/, 'ConvexProvider'],
  [/from\s+['"]@tanstack\/react-query['"]/, 'QueryClientProvider'],
  [/from\s+['"]@apollo\/client['"]/, 'ApolloProvider'],
  [/from\s+['"]@clerk\/[^'"]+['"]/, 'ClerkProvider'],
  [/from\s+['"]react-redux['"]/, 'Provider'],
];

/**
 * Regex fallback for entries the generator could not parse: any `<XyzProvider>`
 * element plus known provider-bearing module imports. Best-effort — used only
 * to name what a passthrough wrapper is missing.
 */
export function detectProviderSignals(entrySourceText: string): string[] {
  const out: string[] = [];
  for (const m of entrySourceText.matchAll(/<([A-Z]\w*Provider)\b/g)) {
    if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  for (const [re, name] of PROVIDER_MODULE_SIGNALS) {
    if (re.test(entrySourceText) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Element name of a JSX opening element (last segment for member exprs). */
function jsxElementName(opening: t.JSXOpeningElement): string | null {
  const name = opening.name;
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name)) {
    let seg = name;
    while (t.isJSXMemberExpression(seg.object)) seg = seg.object;
    return t.isJSXIdentifier(seg.property) ? seg.property.name : null;
  }
  return null;
}

/**
 * Parse ANY wrapper source and return the element names wrapping the
 * `{children}` slot(s) of the component that actually renders — the
 * default-exported one. A slot is a `children` reference that (a) BINDS to the
 * component's own `children` prop and (b) sits on the component's RENDER PATH
 * (a JSX child/return value, possibly through conditionals). File-wide
 * `children` references that are data plumbing — hook deps arrays,
 * `useMemo(() => children)` bodies, `cloneElement` args, a helper component's
 * own internal slot — are NOT slots and never poison the fold (they used to
 * empty the intersection and yield a false `degraded` on healthy projects).
 *
 * Multiple slots (conditional wrappers) fold by INTERSECTION — a provider
 * counts as present only when it wraps EVERY slot (conservative: may
 * over-taint, can never under-taint). `<UserWrapper>` ancestors are expanded
 * by analyzing `userWrapperSource` recursively when provided (unparseable user
 * source contributes nothing), and locally-defined components on the render
 * path expand the same way — a provider factored into a local `Layout` helper
 * still counts. Returns null (→ `unknown`, never `degraded`) on parse failure,
 * when no default-exported function component is found, or when no render-path
 * `{children}` slot exists.
 */
export function analyzeWrapperProviders(
  wrapperSource: string,
  opts?: { userWrapperSource?: string },
): { presentChain: Set<string> } | null {
  let ast: t.File;
  try {
    ast = parse(wrapperSource, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx', 'topLevelAwait'],
    });
  } catch {
    return null;
  }

  let componentPath: NodePath<t.Function> | null = null;
  traverse(ast, {
    ExportDefaultDeclaration(path: NodePath<t.ExportDefaultDeclaration>) {
      componentPath = resolveComponentFunction(path.get('declaration'));
      path.stop();
    },
  });
  if (!componentPath) return null;

  // Lazily analyze the user wrapper ONCE; its slot chain substitutes for the
  // `UserWrapper` composition point in every gen-side chain.
  let userChain: Set<string> | null | undefined;
  const getUserChain = (): Set<string> | null => {
    if (userChain === undefined) {
      userChain = opts?.userWrapperSource
        ? (analyzeWrapperProviders(opts.userWrapperSource)?.presentChain ?? null)
        : null;
    }
    return userChain;
  };

  const present = componentProviderChain(componentPath, getUserChain, new Set());
  return present ? { presentChain: present } : null;
}

/** Default-export → the function component it exports (unwrapping `memo(…)`/`forwardRef(…)` and local identifiers). */
function resolveComponentFunction(decl: NodePath): NodePath<t.Function> | null {
  if (decl.isFunction()) return decl;
  if (decl.isCallExpression()) {
    const arg = decl.get('arguments')[0];
    return arg ? resolveComponentFunction(arg) : null;
  }
  if (decl.isIdentifier()) {
    const binding = decl.scope.getBinding(decl.node.name);
    return binding ? functionFromBindingPath(binding.path) : null;
  }
  return null;
}

/** Binding path → function component, for `export default Wrapper` and local `<Layout>` helpers. */
function functionFromBindingPath(p: NodePath): NodePath<t.Function> | null {
  if (p.isFunctionDeclaration()) return p;
  if (p.isVariableDeclarator()) {
    const init = p.get('init');
    if (init.isFunction()) return init;
  }
  return null;
}

/**
 * Provider names wrapping EVERY render-path `children` slot of `fnPath`
 * (intersection across slots), with `UserWrapper` and locally-defined
 * components expanded recursively. Returns null when the component has no
 * render-path slot at all — "can't see how children render" reads as
 * `unknown` downstream, never `degraded`. `visiting` guards recursion cycles.
 */
function componentProviderChain(
  fnPath: NodePath<t.Function>,
  getUserChain: () => Set<string> | null,
  visiting: Set<t.Node>,
): Set<string> | null {
  if (visiting.has(fnPath.node)) return new Set();
  visiting.add(fnPath.node);
  try {
    const slotSets: Array<Set<string>> = [];
    fnPath.traverse({
      Identifier(path: NodePath<t.Identifier>) {
        if (path.node.name !== 'children') return;
        if (!path.isReferencedIdentifier()) return;
        // Must be THIS component's own `children` binding — a nested helper
        // component's slot is folded only when the helper appears in a chain.
        const binding = path.scope.getBinding('children');
        if (!binding || binding.scope.getFunctionParent()?.path.node !== fnPath.node) return;
        const chain = renderPathChain(path, fnPath, getUserChain, visiting);
        if (chain) slotSets.push(chain);
      },
    });
    if (slotSets.length === 0) return null;
    let present = slotSets[0]!;
    for (const s of slotSets.slice(1)) {
      present = new Set([...present].filter((n) => s.has(n)));
    }
    return present;
  } finally {
    visiting.delete(fnPath.node);
  }
}

/**
 * Walk up from a `children` reference to the component boundary. Returns the
 * expanded wrapping-provider names when the reference is a render-path slot
 * (JSX child, or the component's return value — possibly through
 * conditionals/logical fallbacks), or null when it is data plumbing (hook
 * deps, `cloneElement`/callback args, nested-function bodies, …).
 */
function renderPathChain(
  ref: NodePath,
  fnPath: NodePath<t.Function>,
  getUserChain: () => Set<string> | null,
  visiting: Set<t.Node>,
): Set<string> | null {
  const out = new Set<string>();
  let prev: NodePath = ref;
  let cur: NodePath | null = ref.parentPath;
  while (cur && cur.node !== fnPath.node) {
    if (cur.isJSXElement()) {
      const name = jsxElementName(cur.node.openingElement);
      if (name && /^[A-Z]/.test(name)) {
        if (name === 'UserWrapper') {
          // Composition point, not a provider — substitute the user chain.
          const uc = getUserChain();
          if (uc) for (const n of uc) out.add(n);
        } else {
          out.add(name);
          // A locally-defined component on the render path may wrap ITS
          // children in providers (a `Layout` helper) — expand like UserWrapper.
          const localFn = cur.scope.getBinding(name)
            ? functionFromBindingPath(cur.scope.getBinding(name)!.path)
            : null;
          if (localFn) {
            const inner = componentProviderChain(localFn, getUserChain, visiting);
            if (inner) for (const n of inner) out.add(n);
          }
        }
      }
    } else if (
      // Value-flow / statement nodes a rendered `children` legitimately passes
      // through on its way to JSX or the component's return.
      cur.isJSXExpressionContainer() ||
      cur.isJSXFragment() ||
      cur.isJSXAttribute() ||
      cur.isJSXOpeningElement() ||
      cur.isReturnStatement() ||
      cur.isLogicalExpression() ||
      cur.isParenthesizedExpression() ||
      cur.isTSAsExpression() ||
      cur.isTSNonNullExpression() ||
      cur.isBlockStatement() ||
      cur.isIfStatement()
    ) {
      // transparent
    } else if (cur.isConditionalExpression()) {
      // `{flag ? <A>{children}</A> : children}` — both branches render; the
      // TEST position does not.
      if (prev.node === cur.node.test) return null;
    } else {
      // Function boundary (useMemo/callback body), call args, deps arrays,
      // variable inits, object props, … — not a render-path slot.
      return null;
    }
    prev = cur;
    cur = cur.parentPath;
  }
  return cur ? out : null;
}

/** Membership check with router-equivalence: any router satisfies any router. */
function providerSatisfied(expected: string, actual: Set<string>): boolean {
  if (actual.has(expected)) return true;
  if (ROUTER_EQUIVALENTS.has(expected)) {
    for (const name of actual) if (ROUTER_EQUIVALENTS.has(name)) return true;
  }
  return false;
}

/**
 * Fold expected vs actual into the fidelity verdict. Membership check for each
 * expected name; `ROUTER_EQUIVALENTS` are mutually satisfying; EXTRA providers
 * in the wrapper never degrade (user enrichment is fine).
 *
 * When generation fell back (passthrough), the expected side is regex-derived
 * from `entrySourceText`; the fold stays `degraded` (the foundation-locked
 * passthrough stamp — a passthrough renders with no cloned providers) UNLESS
 * the wrapper that renders (typically via `.validity/wrapper.user.tsx`
 * composition) satisfies every detected signal — the documented fix path.
 *
 * Monotone-safe: nothing here upgrades a verdict; `verified` produces
 * byte-identical downstream behavior to the field being absent.
 */
export function foldWrapperFidelity(args: {
  expected: string[];
  actual: Set<string> | null;
  generation: { ok: boolean; fallbackReason?: string };
  /** Raw entry-file text for the regex fallback when generation failed. */
  entrySourceText?: string;
  analyzed: WrapperFidelityInfo['analyzed'];
  /**
   * True when the generator replaced a `<RouterProvider>` with `<MemoryRouter>`
   * and discarded the route-config subtree unanalyzed. `expected` is then
   * known-incomplete — providers mounted inside a route element are invisible
   * to it — so an "all expected providers present" match cannot prove fidelity.
   * Caps the verdict at `degraded` (never `verified`) so soft evidence rendered
   * under a possibly-provider-missing wrapper stays tainted.
   */
  routerSubtreeDiscarded?: boolean;
  /**
   * Provider signals detected inside the splice target's module (App.tsx and
   * friends) by the generator's deep-clone pass. Independent of `expected`
   * (which only covers what the wrapper was BUILT to contain): any signal the
   * rendering wrapper does not satisfy caps the verdict at `degraded` and is
   * named — this is what makes "providers inside App.tsx" visible to fidelity
   * instead of silently blessing an entry-only chain as `verified`.
   */
  spliceTarget?: { module: string; signals: string[] };
}): WrapperFidelityInfo {
  const { actual, generation, analyzed } = args;

  if (!generation.ok) {
    const detected = args.entrySourceText ? detectProviderSignals(args.entrySourceText) : [];
    const missing = actual ? detected.filter((name) => !providerSatisfied(name, actual)) : detected;
    if (detected.length > 0 && missing.length === 0) {
      // wrapper.user.tsx supplies everything the entry detectably needs —
      // the taint's own advice, followed.
      return {
        status: 'verified',
        missingProviders: [],
        expectedProviders: detected,
        analyzed,
        detail: generation.fallbackReason,
      };
    }
    return {
      status: 'degraded',
      missingProviders: missing,
      expectedProviders: detected,
      analyzed,
      detail: generation.fallbackReason,
    };
  }

  if (actual === null) {
    return {
      status: 'unknown',
      missingProviders: [],
      expectedProviders: args.expected,
      analyzed,
      detail: 'wrapper source could not be analyzed (unparseable or no {children} slot)',
    };
  }

  const missing = args.expected.filter((name) => !providerSatisfied(name, actual));
  // Splice-target signals are an expectation the generator DERIVED from the
  // app module, not one the wrapper was built to satisfy — check them against
  // the wrapper that actually renders (gen + user composition). Anything
  // unsatisfied is a provider the real app mounts that the sandbox won't.
  const deepMissing = (args.spliceTarget?.signals ?? []).filter(
    (name) => !providerSatisfied(name, actual) && !missing.includes(name),
  );
  if (missing.length === 0 && deepMissing.length === 0) {
    // The chain matches — but if a RouterProvider substitution discarded an
    // unanalyzed route subtree, the expectation we just matched is itself
    // incomplete. Matching an incomplete expectation can't prove fidelity, so
    // cap at `degraded` rather than falsely blessing it `verified`.
    if (args.routerSubtreeDiscarded) {
      return {
        status: 'degraded',
        missingProviders: [],
        expectedProviders: args.expected,
        analyzed,
        detail:
          'a <RouterProvider> was replaced by <MemoryRouter>; providers mounted inside its route ' +
          'config are not cloned or analyzed, so fidelity cannot be verified (possible missing provider)',
      };
    }
    return { status: 'verified', missingProviders: [], expectedProviders: args.expected, analyzed };
  }
  const detail: string[] = [];
  if (missing.length > 0) detail.push(`wrapper is missing ${missing.join(', ')}`);
  if (deepMissing.length > 0) {
    detail.push(
      `providers declared inside ${args.spliceTarget!.module} are not reproduced by the wrapper: ` +
        `${deepMissing.join(', ')} (add them to .validity/wrapper.user.tsx)`,
    );
  }
  return {
    status: 'degraded',
    missingProviders: [...missing, ...deepMissing],
    expectedProviders: args.expected,
    analyzed,
    detail: detail.join('; '),
  };
}
