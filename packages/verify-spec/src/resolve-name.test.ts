import { describe, expect, it } from 'vitest';
import type { Catalog, CatalogEntry } from './catalog.js';
import { resolveName } from './resolve-name.js';

function cat(entries: Partial<CatalogEntry>[]): Catalog {
  return {
    entries: entries.map((e) => ({
      path: e.path!,
      name:
        e.name ??
        e
          .path!.split('/')
          .pop()!
          .replace(/\.\w+$/, ''),
      kind: e.kind ?? 'component',
      routePath: e.routePath,
      discovered: e.discovered ?? false,
      fixtures: e.fixtures ?? [],
      usedByScreens: e.usedByScreens,
      usesComponents: e.usesComponents,
    })),
    navigation: [],
    counts: { components: 0, screens: 0, views: 0 },
  };
}

describe('resolveName', () => {
  it('matches a casual basename case-insensitively', () => {
    const r = resolveName('button', cat([{ path: 'src/components/Button.tsx' }]));
    expect(r.best?.path).toBe('src/components/Button.tsx');
    expect(r.ambiguous).toBe(false);
  });

  it('matches an exact project-relative path', () => {
    const r = resolveName(
      'src/ui/Button.tsx',
      cat([{ path: 'src/ui/Button.tsx' }, { path: 'src/other/Button.tsx', name: 'Button' }]),
    );
    expect(r.best?.path).toBe('src/ui/Button.tsx');
  });

  it('handles spaces/casing: "login form" → LoginForm', () => {
    const r = resolveName('login form', cat([{ path: 'src/LoginForm.tsx' }]));
    expect(r.best?.name).toBe('LoginForm');
  });

  it('flags ambiguity when two distinct paths share the same basename', () => {
    const r = resolveName(
      'button',
      cat([{ path: 'src/ui/Button.tsx' }, { path: 'src/legacy/Button.tsx' }]),
    );
    expect(r.ambiguous).toBe(true);
    expect(r.best).toBeUndefined();
    expect(r.matches).toHaveLength(2);
  });

  it('returns no match for an unknown name', () => {
    const r = resolveName('nonexistent', cat([{ path: 'src/Button.tsx' }]));
    expect(r.matches).toHaveLength(0);
    expect(r.best).toBeUndefined();
    expect(r.ambiguous).toBe(false);
  });

  it('resolves a screen by its route path', () => {
    const r = resolveName(
      '/dashboard',
      cat([{ path: 'app/dashboard/page.tsx', kind: 'screen', routePath: '/dashboard' }]),
    );
    expect(r.best?.path).toBe('app/dashboard/page.tsx');
  });

  it('supports fuzzy subsequence as a floor (lgnfrm → LoginForm)', () => {
    const r = resolveName('lgnfrm', cat([{ path: 'src/LoginForm.tsx' }]));
    expect(r.best?.name).toBe('LoginForm');
  });

  it('prefers a startsWith match over a mere contains match', () => {
    const r = resolveName(
      'card',
      cat([{ path: 'src/CardHeader.tsx' }, { path: 'src/PricingCard.tsx' }]),
    );
    // CardHeader starts with "card" (600) > PricingCard contains "card" (400).
    expect(r.best?.name).toBe('CardHeader');
    expect(r.ambiguous).toBe(false);
  });
});
