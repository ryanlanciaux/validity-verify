import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildCatalog, summarizeProps } from './catalog.js';

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-catalog-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fix', dependencies: {} }));
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

const BUTTON = `export default function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}`;
const DASHBOARD = `export default function DashboardPage() {
  return <div>dashboard</div>;
}`;

describe('buildCatalog', () => {
  it('classifies components and Next.js app-router screens', () => {
    const dir = project({
      'src/components/Button.tsx': BUTTON,
      'app/dashboard/page.tsx': DASHBOARD,
    });
    const cat = buildCatalog(dir);
    const button = cat.entries.find((e) => e.name === 'Button');
    const dash = cat.entries.find((e) => e.path === 'app/dashboard/page.tsx');

    expect(button?.kind).toBe('component');
    expect(button?.discovered).toBe(true);
    expect(dash?.kind).toBe('screen');
    expect(dash?.routePath).toBe('/dashboard');
    expect(cat.counts.components).toBeGreaterThanOrEqual(1);
    expect(cat.counts.screens).toBe(1);
  });

  it('surfaces explicit config fixtures and marks the entry non-discovered', () => {
    const dir = project({ 'src/Button.tsx': BUTTON });
    const cat = buildCatalog(dir, {
      components: {
        'src/Button.tsx': { fixtures: { primary: { props: { label: 'Hi' } } } },
      },
    } as never);
    const button = cat.entries.find((e) => e.path === 'src/Button.tsx');
    expect(button?.discovered).toBe(false);
    expect(button?.fixtures.map((f) => f.name)).toContain('primary');
  });

  it('includes views from config as view entries', () => {
    const dir = project({ 'src/Button.tsx': BUTTON });
    const cat = buildCatalog(dir, {
      views: {
        'Button states': { items: [{ componentPath: 'src/Button.tsx', fixtureName: 'primary' }] },
      },
    } as never);
    const view = cat.entries.find((e) => e.kind === 'view');
    expect(view?.name).toBe('Button states');
    expect(view?.usesComponents).toContain('src/Button.tsx');
    expect(cat.counts.views).toBe(1);
  });

  it('extracts props only when includeProps is set', () => {
    const dir = project({ 'src/Button.tsx': BUTTON });
    const without = buildCatalog(dir).entries.find((e) => e.name === 'Button');
    const withProps = buildCatalog(dir, {}, { includeProps: true }).entries.find(
      (e) => e.name === 'Button',
    );
    expect(without?.props).toBeUndefined();
    expect(withProps?.props?.some((p) => p.name === 'label')).toBe(true);
  });

  it('never lets a path be both a screen and a component', () => {
    const dir = project({ 'src/screens/HomeScreen.tsx': DASHBOARD });
    const cat = buildCatalog(dir);
    const home = cat.entries.filter((e) => e.path === 'src/screens/HomeScreen.tsx');
    expect(home).toHaveLength(1);
    expect(home[0]!.kind).toBe('screen');
  });
});

describe('summarizeProps', () => {
  it('formats a one-line summary with optionality', () => {
    expect(
      summarizeProps([
        { name: 'label', type: 'string', optional: false },
        { name: 'disabled', type: 'boolean', optional: true },
      ]),
    ).toBe('label: string, disabled?: boolean');
  });
  it('truncates past the cap', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      name: `p${i}`,
      type: 'string',
      optional: false,
    }));
    expect(summarizeProps(many)).toMatch(/…$/);
  });
  it('returns empty string for no props', () => {
    expect(summarizeProps(undefined)).toBe('');
    expect(summarizeProps([])).toBe('');
  });
});
