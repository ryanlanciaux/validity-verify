import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { discoverDesignTokens } from './design-tokens.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-tokens-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('discoverDesignTokens', () => {
  it('extracts :root custom properties and groups them', () => {
    const dir = project({
      'src/index.css': `:root {
        --color-primary: #2563eb;
        --spacing-md: 1rem;
        --font-sans: Inter, sans-serif;
        --radius-lg: 12px;
      }`,
    });
    const set = discoverDesignTokens(dir);
    const byName = Object.fromEntries(set.cssVariables.map((t) => [t.name, t]));
    expect(byName['--color-primary']?.value).toBe('#2563eb');
    expect(byName['--color-primary']?.group).toBe('color');
    expect(byName['--spacing-md']?.group).toBe('spacing');
    expect(byName['--font-sans']?.group).toBe('font');
    expect(byName['--radius-lg']?.group).toBe('radius');
    expect(set.cssFiles).toContain('src/index.css');
  });

  it('reads Tailwind v4 @theme blocks', () => {
    const dir = project({
      'src/app.css': `@theme {
        --color-brand: oklch(0.7 0.2 250);
      }`,
    });
    const set = discoverDesignTokens(dir);
    expect(set.cssVariables.find((t) => t.name === '--color-brand')?.value).toBe(
      'oklch(0.7 0.2 250)',
    );
  });

  it('surfaces the tailwind config path and best-effort color keys', () => {
    const dir = project({
      'tailwind.config.ts': `export default {
        theme: { extend: { colors: { brand: '#f00', accent: { DEFAULT: '#0f0' } } } },
      };`,
    });
    const set = discoverDesignTokens(dir);
    expect(set.tailwindConfigPath).toBe('tailwind.config.ts');
    expect(set.tailwindColors).toEqual(expect.arrayContaining(['brand', 'accent']));
  });

  it('returns an empty set for a project with no tokens', () => {
    const dir = project({ 'src/App.tsx': 'export default function App(){return null}' });
    const set = discoverDesignTokens(dir);
    expect(set.cssVariables).toEqual([]);
    expect(set.tailwindConfigPath).toBeUndefined();
  });

  it('does not pick up custom properties outside :root/@theme', () => {
    const dir = project({
      'src/index.css': `.button { --local: 1px; color: red; }
      :root { --color-ok: blue; }`,
    });
    const set = discoverDesignTokens(dir);
    const names = set.cssVariables.map((t) => t.name);
    expect(names).toContain('--color-ok');
    expect(names).not.toContain('--local');
  });
});
