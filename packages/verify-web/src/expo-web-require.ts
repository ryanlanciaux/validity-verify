/**
 * Vite plugin (Expo Web target only): rewrite CommonJS `require('literal')`
 * calls found in the USER's own source into hoisted ESM bindings.
 *
 * Why this exists:
 *   React Native / Expo source is transformed by Metro, which allows
 *   `require()` anywhere — even inside otherwise-ESM modules. The Ignite
 *   boilerplate's `app/theme/context.utils.ts` is the canonical example:
 *
 *       import type { Theme } from "./types"
 *       const systemui = require("expo-system-ui")
 *
 *   Vite serves user source as ESM and does NOT provide a `require` global,
 *   so that line throws `ReferenceError: require is not defined` at runtime
 *   and the whole render dies — even though the file's real ESM imports
 *   (react-native, reanimated, …) linked fine. This plugin bridges that
 *   gap so real Expo screens render instead of red-screening on a Metro-ism.
 *
 * What it does (surgically, no full re-generation):
 *   - Parses the file with @babel/parser (typescript + jsx) — TS/JSX are
 *     preserved untouched; Vite's own esbuild transform runs AFTER us
 *     (enforce: 'pre').
 *   - Finds `require('<string-literal>')` CALL expressions whose callee is
 *     the global `require` identifier (so `require.resolve(...)`, member
 *     calls, and locally-shadowed `require` bindings are left alone).
 *   - Classifies each call site into one of two tiers, then hoists ONE
 *     binding per unique specifier and splices every call site to it:
 *
 *     Tier A — unconditional module scope (top-level `const x = require(y)`,
 *     object-literal asset maps, export initializers, …): a static
 *     `import * as ns` plus a `ns?.default ?? ns` interop const, exactly
 *     matching what `require()` returns under Metro. Static imports keep
 *     Vite's dep scanner / optimizer aware of the module.
 *
 *     Tier B — guarded or function-scoped (`if (__DEV__) require(x)`,
 *     Platform.OS branches, requires inside functions or switch-cases): a
 *     crash-proof top-level-await binding —
 *     `let id; try { const ns = await import(spec); id = ns?.default ?? ns } catch {}`
 *     — so a native-only module that THROWS at import time (e.g.
 *     TurboModuleRegistry.getEnforcing) can no longer red-screen the whole
 *     file, while function-scoped requires (date-fns locales in a formatter)
 *     still resolve before module evaluation completes.
 *
 *   Residual semantic: a Tier B module's non-throwing side effects still run
 *   EAGERLY on web (at module load, not when the guard passes) — truly lazy
 *   evaluation is impossible in synchronous ESM without a far bigger rewrite.
 *   Only import-time throws are contained.
 *
 * Scope:
 *   - USER source only (under projectRoot, never node_modules / .validity).
 *   - Only files that actually contain `require(` (cheap early-out).
 *   - Dynamic `require(expr)` (non-string arg) is left as-is.
 */
import { parse } from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import type { Plugin } from 'vite';

// @babel/traverse ships a CJS default-export; under ESM/Node the callable
// lands on `.default`. Normalize both shapes.
const traverse = ((_traverse as unknown as { default?: unknown }).default ??
  _traverse) as typeof _traverse;

const USER_SOURCE_EXT = /\.(?:jsx?|tsx?|mjs|cjs)$/;

interface Rewrite {
  start: number;
  end: number;
  ident: string;
}

interface SpecInfo {
  ident: string;
  /** True when at least one call site is unconditional module scope. */
  hasStaticSite: boolean;
}

/**
 * True when the require() call site would NOT be evaluated unconditionally
 * during module evaluation under Metro: it sits inside a function, or is
 * reached only through a lazily/conditionally-evaluated position (if/switch/
 * try/loop bodies, ternary branches, the short-circuited side of && / || /
 * ??). Positions like variable initializers, object/array literals, member
 * expressions, call arguments, and export declarations stay "static" — those
 * DO evaluate at module scope.
 */
function isGuardedOrFunctionScoped(path: NodePath): boolean {
  if (path.getFunctionParent() != null) return true;
  let current: NodePath = path;
  while (current.parentPath) {
    const parent = current.parentPath;
    switch (parent.node.type) {
      case 'IfStatement':
      case 'SwitchCase':
      case 'TryStatement':
      case 'CatchClause':
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
        return true;
      case 'ConditionalExpression':
        if (current.key === 'consequent' || current.key === 'alternate') return true;
        break;
      case 'LogicalExpression':
        if (current.key === 'right') return true;
        break;
      default:
        break;
    }
    current = parent;
  }
  return false;
}

export function expoWebRequirePlugin(projectRoot: string): Plugin {
  const normalizedRoot = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';

  return {
    name: 'validity:expo-web-require-to-import',
    // Run before Vite's core esbuild TS/JSX transform so we operate on raw
    // source and hand it plain ESM afterwards.
    enforce: 'pre',
    transform(code, id) {
      // Strip any Vite query suffix (?v=, ?import, ?raw, …).
      const cleanId = id.split('?')[0] ?? id;
      if (!USER_SOURCE_EXT.test(cleanId)) return null;
      if (cleanId.includes('/node_modules/') || cleanId.includes('/.validity/')) return null;
      if (!cleanId.startsWith(normalizedRoot)) return null;
      // Cheap early-out: no CJS require call, nothing to do.
      if (!code.includes('require(')) return null;

      let ast;
      try {
        ast = parse(code, {
          sourceType: 'module',
          // Broadly permissive so we can parse the same syntax esbuild will.
          plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties'],
        });
      } catch {
        // If we can't parse it, leave it for Vite's own pipeline to report.
        return null;
      }

      const rewrites: Rewrite[] = [];
      const specs = new Map<string, SpecInfo>();

      traverse(ast, {
        CallExpression(path) {
          const { node } = path;
          const callee = node.callee;
          if (callee.type !== 'Identifier' || callee.name !== 'require') return;
          if (node.arguments.length !== 1) return;
          const arg = node.arguments[0];
          if (!arg || arg.type !== 'StringLiteral') return;
          // Respect a user-defined local `require` (don't rewrite it).
          if (path.scope.getBinding('require')) return;
          if (typeof node.start !== 'number' || typeof node.end !== 'number') return;

          const spec = arg.value;
          let info = specs.get(spec);
          if (!info) {
            info = { ident: `__validityRequire$${specs.size}`, hasStaticSite: false };
            specs.set(spec, info);
          }
          // One unconditional site is enough to force the static import —
          // the module evaluates eagerly no matter what, so the eager form
          // is faithful, and one spec must map to exactly one binding.
          if (!isGuardedOrFunctionScoped(path)) info.hasStaticSite = true;
          rewrites.push({ start: node.start, end: node.end, ident: info.ident });
        },
      });

      if (rewrites.length === 0) return null;

      // Splice call sites from the end so earlier offsets stay valid.
      let out = code;
      for (const r of rewrites.sort((a, b) => b.start - a.start)) {
        out = out.slice(0, r.start) + r.ident + out.slice(r.end);
      }

      // Hoist one binding per unique specifier, then derive the value
      // `require()` would have returned. `require(x)` yields:
      //   - a CJS module's `module.exports` — which Vite's optimizer exposes
      //     as the namespace's `default`; or
      //   - an ESM module's namespace object (named exports, no `default`).
      // `ns?.default ?? ns` covers both: CJS → module.exports, ESM → namespace.
      let header = '';
      let nsN = 0;
      for (const [spec, info] of specs) {
        const ns = `__validityRequireNs$${nsN++}`;
        if (info.hasStaticSite) {
          header +=
            `import * as ${ns} from ${JSON.stringify(spec)};\n` +
            `const ${info.ident} = ${ns}?.default ?? ${ns};\n`;
        } else {
          // Tier B: top-level await keeps the binding resolved before this
          // module finishes evaluating, while the try/catch contains modules
          // that throw at import time (native-only TurboModule lookups).
          header +=
            `let ${info.ident};\n` +
            `try { const ${ns} = await import(${JSON.stringify(spec)}); ` +
            `${info.ident} = ${ns}?.default ?? ${ns}; } catch {}\n`;
        }
      }

      // Map is dropped: offsets shifted and Vite's esbuild transform re-maps
      // this module afterwards; a stale map would be worse than none here.
      return { code: header + out, map: null };
    },
  };
}
