/**
 * Reverse import graph (import-graph.ts). The load-bearing behaviors:
 * ripple expansion finds transitive importers (the shared-Button case the
 * basename mapping misses), cycles terminate, caps trip loudly (truncated
 * flag, never silent narrowing), tsconfig aliases resolve, and the mtime
 * cache skips unchanged files.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReverseImportGraph,
  createImportScanCache,
  discoverSourceFiles,
  expandChangedFiles,
  scanImportSpecifiers,
} from './import-graph.js';

let root: string;

function write(rel: string, content: string): string {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'validity-import-graph-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scanImportSpecifiers', () => {
  it('extracts every import shape', () => {
    const src = [
      `import { Button } from './Button';`,
      `import Default from "../ui/Default";`,
      `import * as ns from '@/lib/ns';`,
      `import './side-effect.css';`,
      `export { thing } from './re-export';`,
      `const lazy = import('./lazy');`,
      `const cjs = require('./cjs');`,
      `import {`,
      `  A,`,
      `  B,`,
      `} from './multiline';`,
    ].join('\n');
    expect(scanImportSpecifiers(src)).toEqual([
      './Button',
      '../ui/Default',
      '@/lib/ns',
      './side-effect.css',
      './re-export',
      './lazy',
      './cjs',
      './multiline',
    ]);
  });

  it('returns [] for import-free source', () => {
    expect(scanImportSpecifiers('const x = 1;\nexport default x;')).toEqual([]);
  });
});

describe('buildReverseImportGraph + expandChangedFiles', () => {
  it('finds transitive importers: Button ← LoginForm ← LoginScreen', () => {
    write('src/components/Button.tsx', 'export const Button = () => null;');
    write(
      'src/components/LoginForm.tsx',
      `import { Button } from './Button';\nexport const LoginForm = () => Button;`,
    );
    write(
      'src/screens/LoginScreen.tsx',
      `import { LoginForm } from '../components/LoginForm';\nexport const LoginScreen = () => LoginForm;`,
    );
    const graph = buildReverseImportGraph({ projectRoot: root });
    const { files, truncated } = expandChangedFiles(graph, ['src/components/Button.tsx']);
    expect(truncated).toBe(false);
    expect(files).toContain('src/components/Button.tsx');
    expect(files).toContain('src/components/LoginForm.tsx');
    expect(files).toContain('src/screens/LoginScreen.tsx');
  });

  it('ripples a CSS-module edit up to the component that imports it', () => {
    write('src/components/Button.module.css', '.btn { color: red; }');
    write(
      'src/components/Button.tsx',
      `import styles from './Button.module.css';\nexport const Button = () => styles;`,
    );
    write(
      'src/screens/Login.tsx',
      `import { Button } from '../components/Button';\nexport const Login = () => Button;`,
    );
    const graph = buildReverseImportGraph({ projectRoot: root });
    const { files } = expandChangedFiles(graph, ['src/components/Button.module.css']);
    // The stylesheet itself + its importer + the screen that uses the importer.
    expect(files).toContain('src/components/Button.tsx');
    expect(files).toContain('src/screens/Login.tsx');
  });

  it('ripples a bare side-effect CSS import and a non-CSS asset (svg) to their importer', () => {
    write('src/theme.css', 'body { margin: 0; }');
    write('src/logo.svg', '<svg></svg>');
    write(
      'src/App.tsx',
      `import './theme.css';\nimport logo from './logo.svg';\nexport const App = () => logo;`,
    );
    const graph = buildReverseImportGraph({ projectRoot: root });
    expect(expandChangedFiles(graph, ['src/theme.css']).files).toContain('src/App.tsx');
    expect(expandChangedFiles(graph, ['src/logo.svg']).files).toContain('src/App.tsx');
  });

  it('resolves tsconfig path aliases', () => {
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    );
    write('src/components/Card.tsx', 'export const Card = () => null;');
    write(
      'src/screens/Home.tsx',
      `import { Card } from '@/components/Card';\nexport const Home = () => Card;`,
    );
    const graph = buildReverseImportGraph({ projectRoot: root });
    const { files } = expandChangedFiles(graph, ['src/components/Card.tsx']);
    expect(files).toContain('src/screens/Home.tsx');
  });

  it('terminates on import cycles', () => {
    write('src/a.ts', `import './b';`);
    write('src/b.ts', `import './a';`);
    const graph = buildReverseImportGraph({ projectRoot: root });
    const { files, truncated } = expandChangedFiles(graph, ['src/a.ts']);
    expect(truncated).toBe(false);
    expect(files.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('trips the maxFiles cap loudly instead of narrowing silently', () => {
    write('src/hub.ts', 'export const hub = 1;');
    for (let i = 0; i < 10; i++) {
      write(`src/user${i}.ts`, `import './hub';`);
    }
    const graph = buildReverseImportGraph({ projectRoot: root });
    const { files, truncated } = expandChangedFiles(graph, ['src/hub.ts'], { maxFiles: 5 });
    expect(truncated).toBe(true);
    expect(files.length).toBe(5);
  });

  it('marks truncation when maxDepth cuts an unexplored frontier', () => {
    write('src/l0.ts', 'export const x = 1;');
    write('src/l1.ts', `import './l0';`);
    write('src/l2.ts', `import './l1';`);
    const graph = buildReverseImportGraph({ projectRoot: root });
    const { files, truncated } = expandChangedFiles(graph, ['src/l0.ts'], { maxDepth: 1 });
    expect(files).toContain('src/l1.ts');
    expect(files).not.toContain('src/l2.ts');
    expect(truncated).toBe(true);
  });

  it('skips node_modules, dot-dirs, and declaration files', () => {
    write('node_modules/pkg/index.ts', `import './dep';`);
    write('.validity/specs/spec-1/thing.ts', `import './x';`);
    write('src/types.d.ts', `import './phantom';`);
    write('src/real.ts', 'export const r = 1;');
    const files = discoverSourceFiles(root);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('.validity'))).toBe(false);
    expect(files.some((f) => f.endsWith('.d.ts'))).toBe(false);
    expect(files.some((f) => f.endsWith('real.ts'))).toBe(true);
  });

  it('reuses cached scans for unchanged mtimes and re-scans on touch', () => {
    const abs = write('src/a.ts', `import './b';`);
    write('src/b.ts', 'export const b = 1;');
    const cache = createImportScanCache();
    buildReverseImportGraph({ projectRoot: root, cache });
    const before = cache.get(abs);
    expect(before?.specifiers).toEqual(['./b']);
    // Poison the cache entry, keep the mtime — a rebuild that trusts the
    // cache sees no './b' import, so the b edge disappears.
    cache.set(abs, { mtimeMs: before!.mtimeMs, specifiers: [] });
    const cached = buildReverseImportGraph({ projectRoot: root, cache });
    expect(cached.get('src/b.ts')).toBeUndefined();
    // Bump the mtime — the rebuild must re-scan and restore the real edge.
    const later = new Date(Date.now() + 5_000);
    utimesSync(abs, later, later);
    const rescanned = buildReverseImportGraph({ projectRoot: root, cache });
    expect(Array.from(rescanned.get('src/b.ts') ?? [])).toEqual(['src/a.ts']);
  });
});
