/**
 * Next.js React Server Components — say which files Validity can actually
 * verify, and which it can't (E2.4).
 *
 * Validity renders Next projects through the standard web sandbox: Vite +
 * React + the `next/*` DOM aliases. That covers Pages Router components and
 * App Router components carrying the `'use client'` directive. It does NOT
 * cover Server Components — they need Next's server runtime (async component
 * bodies, server-only data access, `next/headers`, RSC serialization), and no
 * amount of aliasing produces one in a browser.
 *
 * Until now that limit lived only in code comments (`sandbox/src/detect.ts`,
 * `next-web-aliases.ts`), so an agent asking "why didn't `app/page.tsx` get
 * verified?" got silence — the least trustworthy answer available. This module
 * is the honest, mechanical answer: which files are client-verifiable, which
 * were excluded as server components, and why.
 *
 * The classification is DIRECTIVE-BASED and deliberately narrow: only a file
 * under an App Router `app/` directory that lacks `'use client'` is called a
 * server component. Everything else (Pages Router, `components/`, `src/lib/`,
 * anything with the directive) is reported verifiable. That errs toward
 * claiming LESS exclusion than a full module-graph analysis would — a file we
 * wrongly call verifiable simply renders and reports its own render error,
 * whereas wrongly excluding one would hide a target the user asked about.
 *
 * Pure except for `classifyNextSources`' optional reader; unit-tested on
 * fixture strings.
 */

/** One file Validity refused to render, with the reason a human needs. */
export interface RscExclusion {
  /** Project-relative path. */
  path: string;
  /** Why it can't be rendered in the web sandbox. */
  reason: string;
}

/** The client-verifiable / server-excluded split for a Next.js project. */
export interface RscClassification {
  /** Project-relative paths that render through the web sandbox. */
  verifiable: string[];
  /** Project-relative paths held out, each with its reason. */
  excluded: RscExclusion[];
}

/** The one reason string. Single-sourced so every surface says it identically. */
export const RSC_EXCLUSION_REASON = "server component, no 'use client'";

/** A directive prologue entry: a bare string literal, optionally `;`-terminated. */
const DIRECTIVE_RE = /^(['"])([^'"\n]*)\1\s*;?/;

/**
 * Does a source file's directive prologue contain `'use client'`?
 *
 * A prologue is the run of bare string-literal statements at the top of a file,
 * preceded only by comments and blank lines. It may hold SEVERAL directives —
 * `'use strict'; 'use client';` is valid and Next honours it — so this walks
 * every directive in the prologue rather than testing only the first. Stopping
 * at the first one would misclassify such a file as a server component and hide
 * a target the user asked to verify.
 *
 * It stops at the first non-directive statement: a `'use client'` appearing
 * after real code is not a directive, Next ignores it, and counting it would be
 * the false positive that lets an actual server component through.
 */
export function hasUseClientDirective(source: string): boolean {
  let rest = source.replace(/^\uFEFF/, '');
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '');
    // Comments may appear anywhere in the prologue, including between two
    // directives, so this runs each time round rather than once up front.
    if (trimmed.startsWith('//')) {
      const nl = trimmed.indexOf('\n');
      if (nl === -1) return false;
      rest = trimmed.slice(nl + 1);
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      if (end === -1) return false;
      rest = trimmed.slice(end + 2);
      continue;
    }
    const directive = DIRECTIVE_RE.exec(trimmed);
    if (!directive) return false;
    if (directive[2] === 'use client') return true;
    rest = trimmed.slice(directive[0].length);
  }
}

/**
 * Is this project-relative path inside a Next.js App Router tree (`app/` or
 * `src/app/`)? Pages Router files (`pages/…`) are client-rendered by default
 * and are NOT App Router, so they never reach the server-component branch.
 */
export function isAppRouterPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized.startsWith('app/') || normalized.startsWith('src/app/');
}

/**
 * Classify a set of already-read Next.js sources. `files` is the ordered list
 * of (project-relative path, source) pairs to consider — typically the catalog
 * entries or a verify run's targets.
 */
export function classifyNextSources(
  files: Array<{ path: string; source: string }>,
): RscClassification {
  const verifiable: string[] = [];
  const excluded: RscExclusion[] = [];
  for (const { path, source } of files) {
    if (isAppRouterPath(path) && !hasUseClientDirective(source)) {
      excluded.push({ path, reason: RSC_EXCLUSION_REASON });
    } else {
      verifiable.push(path);
    }
  }
  return { verifiable, excluded };
}

/** How many verifiable paths a message names before it says "…". */
const MAX_LISTED = 8;

function listPaths(paths: string[]): string {
  if (paths.length <= MAX_LISTED) return paths.join(', ');
  return `${paths.slice(0, MAX_LISTED).join(', ')}, … (+${paths.length - MAX_LISTED} more)`;
}

/**
 * The agent-facing message for a classification, or undefined when nothing was
 * excluded (a Next project that is entirely client components needs no
 * caveat, and an empty line would just be noise).
 *
 * `context` picks the honest lead, because the two surfaces are in different
 * situations and must not borrow each other's claim:
 *
 *   - `'catalog'` — nothing was rendered, so these files are genuinely OUT of
 *     what isolation mode can verify;
 *   - `'verify'`  — the sandbox DID render them, but through the client
 *     runtime, which is not how Next runs a server component. Saying
 *     "excluded" there would be a lie in the other direction; the evidence
 *     exists, it just isn't authoritative.
 */
export function formatRscBlock(
  classification: RscClassification,
  opts: { context?: 'catalog' | 'verify' } = {},
): string | undefined {
  const { verifiable, excluded } = classification;
  if (excluded.length === 0) return undefined;
  const n = excluded.length;
  const plural = n === 1 ? '' : 's';
  const lines =
    opts.context === 'verify'
      ? [
          `Next.js: ${n} target${plural} ${n === 1 ? 'is a' : 'are'} Server Component${plural} ` +
            `(${RSC_EXCLUSION_REASON}). The sandbox rendered ${n === 1 ? 'it' : 'them'} through ` +
            `the CLIENT runtime — not how Next runs ${n === 1 ? 'it' : 'them'} — so treat that ` +
            `evidence as indicative, not proof:`,
          `  Server component${plural} (${RSC_EXCLUSION_REASON}): ${listPaths(
            excluded.map((e) => e.path),
          )}`,
        ]
      : [
          `Next.js: ${n} file${plural} cannot be rendered in the web sandbox — Server ` +
            `Components need Next's server runtime:`,
          `  Excluded (${RSC_EXCLUSION_REASON}): ${listPaths(excluded.map((e) => e.path))}`,
        ];
  lines.push(
    verifiable.length > 0
      ? `  Verifiable: ${listPaths(verifiable)}`
      : '  Verifiable: none — every candidate here is a server component.',
  );
  lines.push(
    "  → To verify a server component's UI, extract the interactive part into a " +
      "`'use client'` component and target that, or verify the rendered page in URL mode " +
      '(`validity__verify({ url })`) against your running `next dev`.',
  );
  return lines.join('\n');
}
