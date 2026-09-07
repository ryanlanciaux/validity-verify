import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildComponentUsageMap, extractScreenComponentUsage } from './component-usage.js';

function setupProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'validity-cu-'));
  for (const [path, body] of Object.entries(files)) {
    const full = resolve(root, path);
    mkdirSync(resolve(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf-8');
  }
  return root;
}

describe('extractScreenComponentUsage', () => {
  it('returns components used via JSX from relative imports', () => {
    const root = setupProject({
      'src/pages/Home.tsx': `
        import React from 'react';
        import { Card } from '../components/Card';
        import { Header } from '../components/Header';
        export default function Home() {
          return (<div><Header /><Card /></div>);
        }
      `,
      'src/components/Card.tsx': 'export function Card() { return null; }',
      'src/components/Header.tsx': 'export function Header() { return null; }',
      'src/components/Footer.tsx': 'export function Footer() { return null; }',
    });

    const result = extractScreenComponentUsage({
      projectRoot: root,
      screenPath: 'src/pages/Home.tsx',
      componentPaths: new Set([
        'src/components/Card.tsx',
        'src/components/Header.tsx',
        'src/components/Footer.tsx',
      ]),
    });

    expect(result.usedComponents).toEqual(['src/components/Card.tsx', 'src/components/Header.tsx']);
  });

  it('ignores imports that are not in the components set', () => {
    const root = setupProject({
      'src/pages/Home.tsx': `
        import { Card } from '../components/Card';
        export default function Home() { return <Card />; }
      `,
      'src/components/Card.tsx': 'export function Card() { return null; }',
    });

    const result = extractScreenComponentUsage({
      projectRoot: root,
      screenPath: 'src/pages/Home.tsx',
      componentPaths: new Set([]),
    });

    expect(result.usedComponents).toEqual([]);
  });

  it('does NOT include an imported component that is never rendered as JSX', () => {
    const root = setupProject({
      'src/pages/Home.tsx': `
        import { Card } from '../components/Card';
        export default function Home() { return null; }
      `,
      'src/components/Card.tsx': 'export function Card() { return null; }',
    });

    const result = extractScreenComponentUsage({
      projectRoot: root,
      screenPath: 'src/pages/Home.tsx',
      componentPaths: new Set(['src/components/Card.tsx']),
    });

    expect(result.usedComponents).toEqual([]);
  });

  it('resolves tsconfig path aliases like @/components/Card', () => {
    const root = setupProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '@/*': ['./src/*'] },
        },
      }),
      'src/pages/Home.tsx': `
        import { Card } from '@/components/Card';
        export default function Home() { return <Card />; }
      `,
      'src/components/Card.tsx': 'export function Card() { return null; }',
    });

    const result = extractScreenComponentUsage({
      projectRoot: root,
      screenPath: 'src/pages/Home.tsx',
      componentPaths: new Set(['src/components/Card.tsx']),
    });

    expect(result.usedComponents).toEqual(['src/components/Card.tsx']);
  });

  it('handles index.tsx re-exports via directory imports', () => {
    const root = setupProject({
      'src/pages/Home.tsx': `
        import { Card } from '../components/Card';
        export default function Home() { return <Card />; }
      `,
      'src/components/Card/index.tsx': 'export function Card() { return null; }',
    });

    const result = extractScreenComponentUsage({
      projectRoot: root,
      screenPath: 'src/pages/Home.tsx',
      componentPaths: new Set(['src/components/Card/index.tsx']),
    });

    expect(result.usedComponents).toEqual(['src/components/Card/index.tsx']);
  });

  it('survives parse errors with an empty result', () => {
    const root = setupProject({
      'src/pages/Broken.tsx': 'this is not valid TypeScript {{{',
    });

    const result = extractScreenComponentUsage({
      projectRoot: root,
      screenPath: 'src/pages/Broken.tsx',
      componentPaths: new Set([]),
    });

    expect(result.usedComponents).toEqual([]);
  });
});

describe('buildComponentUsageMap', () => {
  it('builds a screen → components map and omits screens with no matches', () => {
    const root = setupProject({
      'src/pages/Home.tsx': `
        import { Card } from '../components/Card';
        export default function Home() { return <Card />; }
      `,
      'src/pages/Empty.tsx': `
        export default function Empty() { return null; }
      `,
      'src/components/Card.tsx': 'export function Card() { return null; }',
    });

    const map = buildComponentUsageMap({
      projectRoot: root,
      screens: ['src/pages/Home.tsx', 'src/pages/Empty.tsx'],
      componentPaths: ['src/components/Card.tsx'],
    });

    expect(map).toEqual({
      'src/pages/Home.tsx': ['src/components/Card.tsx'],
    });
  });
});
