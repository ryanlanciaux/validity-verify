import { readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isReactComponentFile } from './components.js';

export interface DiscoveredScreen {
  /** Project-relative path, forward-slash normalized. */
  path: string;
  /**
   * Derived route path for Next.js conventions. Undefined for filename/folder
   * heuristics (the user can pin it via `screens[path].routePath` in config).
   */
  routePath?: string;
  /** Which heuristic matched. */
  source: 'next-app' | 'next-pages' | 'filename' | 'folder';
}

export interface DiscoverScreensOptions {
  /** Hard cap on returned paths. Default: 500. */
  max?: number;
  /** Optional override for skip-dir set (entry-name match, no path semantics). */
  skipDirs?: Set<string>;
}

/**
 * Directories we never walk during screen discovery. Mirrors
 * `DISCOVERY_SKIP_DIRS` in `./components.ts` — kept in sync intentionally:
 * the two walks share the same noise floor (build artifacts, framework
 * caches, Validity scratch, VCS/dep stores).
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

/**
 * Filename-convention regex: PascalCase prefix + one of the screen suffixes.
 * Case-sensitive — `loginpage.tsx` is not a screen, `LoginPage.tsx` is.
 */
const FILENAME_SCREEN_RE = /^[A-Z].*(Page|Screen|View|Route)\.(tsx|jsx)$/;

/**
 * Folder-convention markers. A file is treated as a screen if its
 * project-relative path contains any of these segments. `src/pages/`
 * overlaps with the Next.js pages router — when both heuristics match
 * we keep the next-pages classification (it carries a derivable
 * routePath, which folder doesn't).
 */
const FOLDER_SCREEN_MARKERS = ['src/screens/', 'src/pages/', 'src/routes/', 'src/views/'];

/**
 * Convert a Next.js path segment list to a route string.
 * - Drops `(group)` segments (Next.js route groups).
 * - Converts `[slug]` → `:slug` and `[...rest]` → `:rest`.
 * - Empty segments (just `app/page.tsx`) → `/`.
 */
function segmentsToRoute(segments: string[]): string {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg.startsWith('(') && seg.endsWith(')')) continue;
    if (seg.startsWith('[') && seg.endsWith(']')) {
      const inner = seg.slice(1, -1).replace(/^\.\.\./, '');
      out.push(`:${inner}`);
    } else {
      out.push(seg);
    }
  }
  if (out.length === 0) return '/';
  return `/${out.join('/')}`;
}

/**
 * Classify a project-relative path against the four heuristics. Returns
 * `null` if no heuristic matches. Apply order matches the spec — first
 * match wins per file.
 */
function classifyScreen(
  relPath: string,
): { routePath?: string; source: DiscoveredScreen['source'] } | null {
  // 1) next-app: app/**/page.tsx or src/app/**/page.tsx
  const appMatch = relPath.match(/^(?:src\/)?app\/(.*)$/);
  if (appMatch) {
    const inside = appMatch[1] ?? '';
    // Skip API routes wholesale.
    if (inside.startsWith('api/') || inside === 'api') return null;
    // Skip layouts and templates for v1 — too noisy.
    const base = inside.split('/').pop() ?? '';
    if (base === 'layout.tsx' || base === 'layout.jsx') return null;
    if (base === 'template.tsx' || base === 'template.jsx') return null;
    if (base === 'page.tsx' || base === 'page.jsx') {
      const segments = inside.split('/').slice(0, -1);
      return { routePath: segmentsToRoute(segments), source: 'next-app' };
    }
    // Fall through — other files under app/ aren't screens.
  }

  // 2) next-pages: pages/**/*.tsx or src/pages/**/*.tsx
  const pagesMatch = relPath.match(/^(?:src\/)?pages\/(.*)\.(tsx|jsx)$/);
  if (pagesMatch) {
    const inside = pagesMatch[1] ?? '';
    // Skip framework specials and API routes.
    if (inside.startsWith('api/') || inside === 'api') return null;
    const base = inside.split('/').pop() ?? '';
    if (base === '_app' || base === '_document' || base === '_error' || base === '404') {
      return null;
    }
    const segments = inside.split('/');
    // `index` → root of its parent dir.
    if (segments[segments.length - 1] === 'index') {
      segments.pop();
    }
    return { routePath: segmentsToRoute(segments), source: 'next-pages' };
  }

  // 3) filename: *Page.tsx / *Screen.tsx / *View.tsx / *Route.tsx
  const basename = relPath.split('/').pop() ?? '';
  if (FILENAME_SCREEN_RE.test(basename)) {
    return { source: 'filename' };
  }

  // 4) folder: anything inside src/screens/, src/pages/, src/routes/, src/views/
  // (src/pages/ is handled by next-pages above; if we get here it didn't
  // match — e.g., a `.jsx` outside the next-pages regex's tsx-only suffix
  // pattern wouldn't happen since the regex also accepts jsx. But keep
  // the folder fallback for non-Next.js projects that still use this layout.)
  for (const marker of FOLDER_SCREEN_MARKERS) {
    if (relPath.startsWith(marker)) {
      return { source: 'folder' };
    }
  }

  return null;
}

/**
 * Walk the project tree and return every file that's likely a screen,
 * classified by the matching heuristic. Used by `validity browse` to
 * populate the Screens group above Components in the sidebar.
 *
 * Pure read — no side effects, no config writes. Mirrors the shape and
 * cost profile of `discoverComponentFiles` in `./components.ts`. Runs a
 * separate fs walk (different concern, different filter); the cost is
 * negligible on typical repos.
 */
export function discoverScreenFiles(
  projectRoot: string,
  opts: DiscoverScreensOptions = {},
): DiscoveredScreen[] {
  const max = opts.max ?? 500;
  const skip = opts.skipDirs ?? DISCOVERY_SKIP_DIRS;
  const found: DiscoveredScreen[] = [];

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
        // Skip test files — same rule as component discovery.
        if (lower.includes('.test.') || lower.includes('.spec.')) continue;
        const relPath = relative(projectRoot, full).replaceAll('\\', '/');
        const classified = classifyScreen(relPath);
        if (!classified) continue;
        if (!isReactComponentFile(full)) continue;
        found.push({
          path: relPath,
          routePath: classified.routePath,
          source: classified.source,
        });
      }
    }
  };

  walk(projectRoot);
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
