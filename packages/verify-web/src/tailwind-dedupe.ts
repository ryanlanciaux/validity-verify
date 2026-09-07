import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { detectsTailwindV4, findTailwindEntryCss } from './prepare.js';
import { validityDir } from './paths.js';

/**
 * Tailwind-build DEDUPE for the sandbox (web + expo-web).
 *
 * THE BUG. When the Tailwind v4 shim is active, `validity-tailwind-shim.css`
 * `@import`s the project's ENTRY stylesheet AND carries a project-wide `@source`
 * scan — one COMPLETE Tailwind build with every utility the project uses. But
 * the user's own code (the cloned `.validity/wrapper.gen.tsx`, or a component)
 * almost always ALSO imports that same entry stylesheet directly (e.g.
 * `import '../src/styles/globals.css'`). Compiled from the sandbox Vite root
 * (`node_modules/.validity/`, which has almost no source to scan), that direct
 * import produces a SECOND, PARTIAL Tailwind build: it re-declares the base
 * utilities it happened to see (`.hidden`) but omits the responsive variants it
 * didn't (`.sm:inline`). Both live in `@layer utilities` at equal specificity,
 * and the partial build loads AFTER the shim — so its `.hidden` wins the cascade
 * over the shim's `.sm:inline` media rule. Any `base + sm:variant` pair silently
 * collapses: `<span class="hidden sm:inline">` computes `display:none` at desktop
 * width, and an icon-only button trips axe's critical `button-name`. (Dogfood
 * round-2, bug 1.)
 *
 * THE INVARIANT this plugin enforces: the entry stylesheet's utilities AND its
 * custom rules must exist in the sandbox EXACTLY ONCE — via the shim's complete,
 * cascade-first build. Concretely:
 *
 *   1. A DIRECT import of the exact entry stylesheet resolves to an EMPTY module.
 *      Its content is already inside the shim, so nothing is dropped; the second
 *      partial build simply disappears. The shim's OWN `@import` of that file is
 *      left untouched (discriminated by importer), so the complete build keeps
 *      the user's `@theme` tokens and custom rules.
 *
 *   2. Any OTHER CSS file that carries `@import "tailwindcss"` and is imported
 *      directly would spawn its own partial build too. We rewrite that import to
 *      `@reference "tailwindcss"`, which gives the file Tailwind's `@apply` /
 *      `theme()` context WITHOUT emitting any utilities or preflight — so its
 *      custom rules survive (they are NOT in the shim) but it contributes no
 *      duplicate, clobbering utility layer.
 *
 * We deliberately do NOT flip the shim to load last instead: the shim is the
 * entry's FIRST import on purpose (Tailwind's preflight/base must load before
 * component styles so user rules win), and reordering it would regress that.
 */

/** `@import "tailwindcss"` in any quote/suffix form — same shape the shim detector uses. */
const TAILWIND_IMPORT_RE = /@import\s+["']tailwindcss/;

/** The full `@import "tailwindcss…";` statement, for rewriting to `@reference`. */
const TAILWIND_IMPORT_STATEMENT_RE = /@import\s+["']tailwindcss[^"']*["'][^;]*;/g;

/** Query marker appended in resolveId so load() knows to empty the direct-import copy. */
const NEUTRALIZE_MARK = 'validity-tw-dedupe';

export interface TailwindDedupeTargets {
  /** Absolute path of the project's Tailwind entry stylesheet (the file the shim @imports). */
  entryCssAbs: string;
  /** Absolute path of the generated shim, whose @import of the entry must be left intact. */
  shimCssAbs: string;
}

/**
 * The dedupe targets, or null when the plugin should be OFF: no Tailwind v4, or
 * no discoverable project entry stylesheet (a bare-`tailwindcss` fallback shim
 * has no user entry to double-import, so there is nothing to dedupe).
 */
export function sandboxTailwindDedupeTargets(projectRoot: string): TailwindDedupeTargets | null {
  if (!detectsTailwindV4(projectRoot)) return null;
  const rel = findTailwindEntryCss(projectRoot);
  if (!rel) return null;
  return {
    entryCssAbs: resolve(projectRoot, rel),
    shimCssAbs: resolve(validityDir(projectRoot), 'validity-tailwind-shim.css'),
  };
}

function stripQuery(id: string): string {
  const q = id.indexOf('?');
  return q === -1 ? id : id.slice(0, q);
}

/**
 * Resolve an import `source` (as written) against its `importer` to an absolute
 * path, but only for the relative/absolute forms a stylesheet import normally
 * takes. Alias/bare specifiers (`@/styles/globals.css`) return null — resolving
 * those needs Vite's resolver and is a documented residual; the common cloned
 * wrapper imports the entry stylesheet with a relative path.
 */
function resolveCssImport(source: string, importer: string): string | null {
  const src = stripQuery(source);
  if (src.startsWith('.')) return resolve(dirname(stripQuery(importer)), src);
  if (src.startsWith('/')) return src;
  return null;
}

/**
 * Vite plugin implementing the dedupe. `enforce: 'pre'` so our resolveId runs
 * ahead of Vite's default resolver and our transform ahead of `@tailwindcss/vite`
 * (the `@reference` rewrite must land before Tailwind processes the file).
 */
export function validityTailwindDedupePlugin(targets: TailwindDedupeTargets): Plugin {
  const { entryCssAbs, shimCssAbs } = targets;
  return {
    name: 'validity:tailwind-dedupe',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      // The shim's OWN `@import` of the entry stylesheet MUST resolve normally —
      // that is the single complete build we are keeping.
      if (stripQuery(importer) === shimCssAbs) return null;
      if (resolveCssImport(source, importer) === entryCssAbs) {
        // Mark the direct-import copy for neutralization in load(). Keep the
        // real path + .css extension so Vite still treats the JS side-effect
        // import as a (now empty) style module.
        return `${entryCssAbs}?${NEUTRALIZE_MARK}`;
      }
      return null;
    },
    load(id) {
      if (id.includes(`?${NEUTRALIZE_MARK}`) || id.includes(`&${NEUTRALIZE_MARK}`)) {
        // INVARIANT: the entry stylesheet is loaded exactly once, via the shim.
        // This is the redundant direct import — empty it so no second (partial)
        // Tailwind build is produced.
        return '';
      }
      return null;
    },
    transform(code, id) {
      const clean = stripQuery(id);
      // The entry stylesheet (neutralized above) and the shim (the one complete
      // build) are off-limits — only OTHER directly-imported CSS is rewritten.
      if (clean === entryCssAbs || clean === shimCssAbs) return null;
      if (!clean.endsWith('.css')) return null;
      if (!TAILWIND_IMPORT_RE.test(code)) return null;
      const out = code.replace(TAILWIND_IMPORT_STATEMENT_RE, '@reference "tailwindcss";');
      return out === code ? null : { code: out, map: null };
    },
  };
}
