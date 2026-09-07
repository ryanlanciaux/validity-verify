/**
 * Read-only design-token inspector.
 *
 * Per the "eyes, not hands" model: Validity does NOT edit tokens. It reads
 * the project's design tokens (CSS custom properties + the Tailwind theme)
 * and surfaces them so the agent knows *which token to edit in code* when a
 * designer says "make the primary color warmer." No write-back — the LLM
 * edits the source file, Validity just shows what's there and where.
 *
 * Sources, in order of reliability:
 *   1. CSS custom properties in `:root { … }` and Tailwind v4 `@theme { … }`
 *      blocks — extracted reliably with a tolerant scanner.
 *   2. A `tailwind.config.{js,ts,cjs,mjs}` file — we surface its path (and a
 *      best-effort list of top-level `theme`/`extend` color keys) so the
 *      agent can open and edit it. We deliberately DON'T fully evaluate the
 *      config (it can import JS); the pointer is the useful part.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

export interface DesignToken {
  /** Token name, e.g. `--color-primary` (CSS var) or `colors.primary` (tailwind). */
  name: string;
  /** Raw value as written in source, e.g. `#2563eb` or `hsl(220 90% 56%)`. */
  value: string;
  /** Project-relative file the token came from. */
  source: string;
  /** Coarse group derived from the name prefix (color/spacing/font/radius/shadow/other). */
  group: string;
}

export interface DesignTokenSet {
  /** CSS custom properties found in :root / @theme blocks. */
  cssVariables: DesignToken[];
  /** Best-effort top-level color keys from a tailwind config (names only). */
  tailwindColors: string[];
  /** Project-relative tailwind config path, if present (the agent edits this). */
  tailwindConfigPath?: string;
  /** Project-relative CSS files scanned. */
  cssFiles: string[];
}

const CSS_CANDIDATES = [
  'src/index.css',
  'src/main.css',
  'src/global.css',
  'src/globals.css',
  'src/styles/global.css',
  'src/styles/globals.css',
  'src/app.css',
  'app/globals.css',
  'styles/globals.css',
];

const TAILWIND_CONFIG_CANDIDATES = [
  'tailwind.config.ts',
  'tailwind.config.js',
  'tailwind.config.cjs',
  'tailwind.config.mjs',
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.validity',
  'coverage',
]);

function groupFor(name: string): string {
  const n = name.replace(/^--/, '').toLowerCase();
  if (
    /^(color|c|bg|background|fg|foreground|text|border|accent|primary|secondary|muted|destructive|ring)/.test(
      n,
    )
  )
    return 'color';
  if (/^(space|spacing|gap|size|sz)/.test(n)) return 'spacing';
  if (/^(font|text|leading|tracking|fs)/.test(n)) return 'font';
  if (/^(radius|rounded|rad)/.test(n)) return 'radius';
  if (/^(shadow|elevation)/.test(n)) return 'shadow';
  return 'other';
}

/**
 * Extract `--name: value;` declarations that live inside a `:root { … }` or
 * `@theme { … }` block. Tolerant brace matcher — it doesn't fully parse CSS,
 * it just isolates the relevant blocks and pulls custom-property lines.
 */
function extractCssVars(css: string, sourceRel: string): DesignToken[] {
  const out: DesignToken[] = [];
  const blockRe = /(?::root|@theme[^{]*)\s*\{/g;
  // We only need each match's end position (blockRe.lastIndex), not the
  // match object itself — so don't bind it.
  while (blockRe.exec(css) !== null) {
    // Walk from the opening brace to its matching close.
    let depth = 1;
    let i = blockRe.lastIndex;
    const start = i;
    while (i < css.length && depth > 0) {
      const ch = css[i]!;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = css.slice(start, i - 1);
    const declRe = /(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g;
    let d: RegExpExecArray | null;
    while ((d = declRe.exec(body)) !== null) {
      const name = d[1]!.trim();
      const value = d[2]!.trim();
      out.push({ name, value, source: sourceRel, group: groupFor(name) });
    }
    blockRe.lastIndex = i;
  }
  return out;
}

/** Find CSS files worth scanning: the well-known candidates plus a shallow walk for any *.css containing :root/@theme. */
function findCssFiles(projectRoot: string, max = 20): string[] {
  const found = new Set<string>();
  for (const rel of CSS_CANDIDATES) {
    if (existsSync(resolve(projectRoot, rel))) found.add(rel);
  }
  // Shallow walk (depth ≤ 3) to catch non-standard locations.
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || found.size >= max) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.size >= max) return;
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const abs = resolve(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, depth + 1);
      else if (entry.toLowerCase().endsWith('.css')) {
        const rel = relative(projectRoot, abs).replaceAll('\\', '/');
        if (found.has(rel)) continue;
        try {
          const text = readFileSync(abs, 'utf-8');
          if (/:root|@theme/.test(text)) found.add(rel);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(projectRoot, 0);
  return [...found];
}

/** Best-effort: pull top-level color KEYS from a tailwind config's theme/extend.colors. Names only, no value eval. */
function extractTailwindColors(text: string): string[] {
  const out = new Set<string>();
  // Find `colors: {` (possibly under theme or theme.extend) and grab the
  // immediate object keys until the matching close brace.
  const re = /colors\s*:\s*\{/g;
  while (re.exec(text) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    const start = i;
    while (i < text.length && depth > 0) {
      const ch = text[i]!;
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    const body = text.slice(start, i - 1);
    const keyRe = /(?:^|[,{])\s*['"]?([A-Za-z][\w-]*)['"]?\s*:/g;
    let k: RegExpExecArray | null;
    while ((k = keyRe.exec(body)) !== null) out.add(k[1]!);
    re.lastIndex = i;
  }
  return [...out];
}

/** Discover the project's design tokens. Pure read — never writes. */
export function discoverDesignTokens(projectRoot: string): DesignTokenSet {
  const cssFiles = findCssFiles(projectRoot);
  const cssVariables: DesignToken[] = [];
  const seen = new Set<string>();
  for (const rel of cssFiles) {
    let text = '';
    try {
      text = readFileSync(resolve(projectRoot, rel), 'utf-8');
    } catch {
      continue;
    }
    for (const tok of extractCssVars(text, rel)) {
      // De-dupe by name+source so a var declared in both :root and @theme
      // of the same file doesn't double-count.
      const key = `${tok.source}::${tok.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cssVariables.push(tok);
    }
  }

  let tailwindConfigPath: string | undefined;
  let tailwindColors: string[] = [];
  for (const rel of TAILWIND_CONFIG_CANDIDATES) {
    const abs = resolve(projectRoot, rel);
    if (!existsSync(abs)) continue;
    tailwindConfigPath = rel;
    try {
      tailwindColors = extractTailwindColors(readFileSync(abs, 'utf-8'));
    } catch {
      tailwindColors = [];
    }
    break;
  }

  cssVariables.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  return { cssVariables, tailwindColors, tailwindConfigPath, cssFiles };
}
