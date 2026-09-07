/**
 * Next.js RSC classification (E2.4) — which files the web sandbox can honestly
 * verify. The load-bearing direction is the FALSE-NEGATIVE one: calling a
 * client component "excluded" would hide a target the user asked about, so the
 * directive test has to be strict about what counts as a directive and the
 * App-Router test strict about what counts as App Router.
 */
import { describe, expect, it } from 'vitest';
import {
  RSC_EXCLUSION_REASON,
  classifyNextSources,
  formatRscBlock,
  hasUseClientDirective,
  isAppRouterPath,
} from './rsc.js';

describe('hasUseClientDirective', () => {
  it('accepts both quote styles, with or without a semicolon', () => {
    expect(hasUseClientDirective("'use client'\nexport default function P() {}")).toBe(true);
    expect(hasUseClientDirective('"use client";\nexport default function P() {}')).toBe(true);
  });

  it('looks past a comment prologue and a BOM', () => {
    expect(hasUseClientDirective("// eslint-disable-next-line\n'use client';\n")).toBe(true);
    expect(hasUseClientDirective("/* banner */\n'use client';\n")).toBe(true);
    expect(hasUseClientDirective("\uFEFF'use client';\n")).toBe(true);
  });

  it('rejects a "use client" that is not the directive prologue', () => {
    expect(hasUseClientDirective("import x from 'y';\n'use client';")).toBe(false);
    expect(hasUseClientDirective("const s = 'use client';")).toBe(false);
  });

  // A prologue may hold several directives, and Next honours 'use client' in
  // any of them. Reading only the first would call these files server
  // components and hide a target the user asked to verify.
  it('finds the directive when another directive precedes it', () => {
    expect(hasUseClientDirective("'use strict';\n'use client';\nexport function C() {}")).toBe(
      true,
    );
    expect(hasUseClientDirective('"use strict"; "use client";')).toBe(true);
    expect(hasUseClientDirective("'use strict'\n'use server'\n'use client'\n")).toBe(true);
  });

  it('finds it across comments interleaved BETWEEN directives', () => {
    expect(hasUseClientDirective("'use strict';\n// why\n/* and */\n'use client';")).toBe(true);
  });

  it('still stops at the first real statement in a multi-directive prologue', () => {
    expect(hasUseClientDirective("'use strict';\nconst a = 1;\n'use client';")).toBe(false);
  });

  it('rejects a file with no directive', () => {
    expect(hasUseClientDirective('export default async function Page() {}')).toBe(false);
  });
});

describe('isAppRouterPath', () => {
  it('is true under app/ and src/app/', () => {
    expect(isAppRouterPath('app/page.tsx')).toBe(true);
    expect(isAppRouterPath('src/app/dashboard/page.tsx')).toBe(true);
  });

  it('is false for Pages Router and plain component dirs', () => {
    expect(isAppRouterPath('pages/index.tsx')).toBe(false);
    expect(isAppRouterPath('components/Button.tsx')).toBe(false);
    // A directory that merely CONTAINS "app" is not the App Router.
    expect(isAppRouterPath('src/application/Shell.tsx')).toBe(false);
  });
});

describe('classifyNextSources — a fixture with both kinds', () => {
  const classification = classifyNextSources([
    { path: 'app/page.tsx', source: 'export default async function Page() {}' },
    { path: 'app/Counter.tsx', source: "'use client';\nexport function Counter() {}" },
    { path: 'components/Button.tsx', source: 'export function Button() {}' },
    { path: 'pages/legacy.tsx', source: 'export default function Legacy() {}' },
  ]);

  it('excludes only the App Router file without the directive', () => {
    expect(classification.excluded).toEqual([
      { path: 'app/page.tsx', reason: RSC_EXCLUSION_REASON },
    ]);
  });

  it('keeps the client component, the plain component, and the Pages Router file verifiable', () => {
    expect(classification.verifiable).toEqual([
      'app/Counter.tsx',
      'components/Button.tsx',
      'pages/legacy.tsx',
    ]);
  });

  it('the catalog message names what was excluded, why, and what IS verifiable', () => {
    const block = formatRscBlock(classification)!;
    expect(block).toContain(`Excluded (${RSC_EXCLUSION_REASON}): app/page.tsx`);
    expect(block).toContain('Verifiable: app/Counter.tsx, components/Button.tsx, pages/legacy.tsx');
    expect(block).toContain("'use client'");
  });

  it('the verify message does NOT claim exclusion — those targets did render, just wrongly', () => {
    const block = formatRscBlock(classification, { context: 'verify' })!;
    expect(block).toContain('CLIENT runtime');
    expect(block).toContain('indicative, not proof');
    expect(block).not.toContain('Excluded (');
  });

  it('emits nothing when every file is client-verifiable', () => {
    const clean = classifyNextSources([
      { path: 'components/Button.tsx', source: 'export function Button() {}' },
    ]);
    expect(clean.excluded).toEqual([]);
    expect(formatRscBlock(clean)).toBeUndefined();
  });
});
