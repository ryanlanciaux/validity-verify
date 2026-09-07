import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverComponentFiles,
  isReactComponentFile,
  selectComponentsToRender,
} from './components.js';

describe('discoverComponentFiles', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-discover-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const writeComponent = (relPath: string, source: string): void => {
    const abs = resolve(projectRoot, relPath);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, source);
  };

  const goodComponent = (name: string) => `import React from 'react';
export default function ${name}() { return <div>${name}</div>; }`;

  it('finds .tsx components in src/ and returns project-relative paths sorted', () => {
    writeComponent('src/Button.tsx', goodComponent('Button'));
    writeComponent('src/components/Card.tsx', goodComponent('Card'));
    writeComponent('src/components/Avatar.jsx', goodComponent('Avatar'));

    const found = discoverComponentFiles(projectRoot);
    expect(found).toEqual([
      'src/Button.tsx',
      'src/components/Avatar.jsx',
      'src/components/Card.tsx',
    ]);
  });

  it('skips node_modules / dist / .next / .validity', () => {
    writeComponent('src/Real.tsx', goodComponent('Real'));
    writeComponent('node_modules/some-pkg/Lib.tsx', goodComponent('Lib'));
    writeComponent('dist/Build.tsx', goodComponent('Build'));
    writeComponent('.next/cache/Cache.tsx', goodComponent('Cache'));
    writeComponent('.validity/wrapper.tsx', goodComponent('Wrapper'));

    expect(discoverComponentFiles(projectRoot)).toEqual(['src/Real.tsx']);
  });

  it('skips test files', () => {
    writeComponent('src/Button.tsx', goodComponent('Button'));
    writeComponent('src/Button.test.tsx', goodComponent('Button'));
    writeComponent('src/Card.spec.tsx', goodComponent('Card'));

    expect(discoverComponentFiles(projectRoot)).toEqual(['src/Button.tsx']);
  });

  it('skips files that look like .tsx but contain no component (no default export, no capitalized named export)', () => {
    writeComponent('src/Real.tsx', goodComponent('Real'));
    // util — no default export, lowercase named export
    writeComponent('src/util.tsx', `export function helper() { return 1; }`);

    expect(discoverComponentFiles(projectRoot)).toEqual(['src/Real.tsx']);
  });

  it('respects the max cap', () => {
    for (let i = 0; i < 20; i++) {
      writeComponent(`src/C${i}.tsx`, goodComponent(`C${i}`));
    }
    const found = discoverComponentFiles(projectRoot, { max: 5 });
    expect(found.length).toBeLessThanOrEqual(5);
  });

  it('returns empty for an empty project', () => {
    expect(discoverComponentFiles(projectRoot)).toEqual([]);
  });

  it('isReactComponentFile sanity check (regression guard for default-export arrow)', () => {
    writeComponent(
      'src/Arrow.tsx',
      `import React from 'react';
const Arrow = () => <div>x</div>;
export default Arrow;`,
    );
    expect(isReactComponentFile(resolve(projectRoot, 'src/Arrow.tsx'))).toBe(true);
  });

  it('rejects files that export only PascalCase constants (theme/data modules)', () => {
    writeComponent(
      'src/theme.tsx',
      `export const BOARD_LIGHT_SQUARE = { backgroundColor: '#aaa' };
export const BOARD_DARK_SQUARE = { backgroundColor: '#333' };
export function buildPieces() { return { K: '/k.svg' }; }`,
    );
    // Also a real component in the same project so discovery isn't empty.
    writeComponent('src/Real.tsx', goodComponent('Real'));
    expect(isReactComponentFile(resolve(projectRoot, 'src/theme.tsx'))).toBe(false);
    expect(discoverComponentFiles(projectRoot)).toEqual(['src/Real.tsx']);
  });

  it('accepts a memo()/forwardRef() wrapped functional component', () => {
    writeComponent(
      'src/Memoed.tsx',
      `import { memo } from 'react';
interface P { label: string }
export const Memoed = memo<P>(({ label }) => <span>{label}</span>);`,
    );
    expect(isReactComponentFile(resolve(projectRoot, 'src/Memoed.tsx'))).toBe(true);
  });

  it('selectComponentsToRender excludes .validity/ infra (a dirty wrapper is never a render candidate)', () => {
    writeComponent('src/Real.tsx', goodComponent('Real'));
    // A wrapper IS a real .tsx React component — without the filter it would
    // enter the candidate set from `git diff HEAD` and render-error every tick.
    writeComponent('.validity/wrapper.user.tsx', goodComponent('Wrapper'));
    writeComponent('.validity/wrapper.gen.tsx', goodComponent('Wrapper'));

    const picked = selectComponentsToRender({
      prompt: '',
      changedFiles: ['src/Real.tsx', '.validity/wrapper.user.tsx', '.validity/wrapper.gen.tsx'],
      projectRoot,
    });
    expect(picked).toEqual([resolve(projectRoot, 'src/Real.tsx')]);
  });

  it('accepts a named-export function returning JSX (no default export)', () => {
    writeComponent('src/Named.tsx', `export function Named() { return <div>hi</div>; }`);
    expect(isReactComponentFile(resolve(projectRoot, 'src/Named.tsx'))).toBe(true);
  });

  it('rejects a PascalCase helper that returns a plain object', () => {
    writeComponent(
      'src/BuildStuff.tsx',
      `export function BuildStuff() { return { foo: 1, bar: 2 }; }`,
    );
    expect(isReactComponentFile(resolve(projectRoot, 'src/BuildStuff.tsx'))).toBe(false);
  });

  // Specifier-only exports (`const X = …; export { X }`) are the shadcn/ui
  // house style. They're an ExportNamedDeclaration with `specifiers` and NO
  // `declaration`, so the declaration-only traversal never saw them and an
  // entire ui/ kit was invisible to discovery.
  it('accepts a forwardRef component exported via a specifier-only export (shadcn pattern)', () => {
    writeComponent(
      'src/Switch.tsx',
      `const Switch = forwardRef((props, ref) => <button ref={ref} {...props} />);
export { Switch };`,
    );
    expect(isReactComponentFile(resolve(projectRoot, 'src/Switch.tsx'))).toBe(true);
  });

  it('accepts a function declaration exported via a specifier-only export', () => {
    writeComponent(
      'src/Named2.tsx',
      `function Named2() { return <div>hi</div>; }
export { Named2 };`,
    );
    expect(isReactComponentFile(resolve(projectRoot, 'src/Named2.tsx'))).toBe(true);
  });

  it('rejects a PascalCase plain object exported via a specifier-only export', () => {
    writeComponent(
      'src/KosalPieces.tsx',
      `const KosalPieces = { K: '/k.svg', Q: '/q.svg' };
export { KosalPieces };`,
    );
    expect(isReactComponentFile(resolve(projectRoot, 'src/KosalPieces.tsx'))).toBe(false);
  });

  it('accepts a renamed specifier-only export (`export { X as default }`) of a HOC-wrapped component', () => {
    writeComponent(
      'src/Renamed.tsx',
      `const Renamed = React.memo(({ label }) => <span>{label}</span>);
export { Renamed as default };`,
    );
    expect(isReactComponentFile(resolve(projectRoot, 'src/Renamed.tsx'))).toBe(true);
  });

  it('handles an export specifier that lexically precedes its declaration', () => {
    writeComponent(
      'src/Hoisted.tsx',
      `export { Hoisted };
const Hoisted = forwardRef((props, ref) => <div ref={ref} />);`,
    );
    expect(isReactComponentFile(resolve(projectRoot, 'src/Hoisted.tsx'))).toBe(true);
  });
});
