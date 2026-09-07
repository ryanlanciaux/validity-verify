import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverScreenFiles } from './screens.js';

describe('discoverScreenFiles', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-screens-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const writeFile = (relPath: string, source: string): void => {
    const abs = resolve(projectRoot, relPath);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, source);
  };

  const goodComponent = (name: string) => `import React from 'react';
export default function ${name}() { return <div>${name}</div>; }`;

  it('classifies Next.js app router page', () => {
    writeFile('app/dashboard/page.tsx', goodComponent('Dashboard'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'app/dashboard/page.tsx', routePath: '/dashboard', source: 'next-app' },
    ]);
  });

  it('drops (group) segments from app router routes', () => {
    writeFile('app/(marketing)/about/page.tsx', goodComponent('About'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'app/(marketing)/about/page.tsx', routePath: '/about', source: 'next-app' },
    ]);
  });

  it('converts [slug] to :slug in app router routes', () => {
    writeFile('app/posts/[slug]/page.tsx', goodComponent('Post'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'app/posts/[slug]/page.tsx', routePath: '/posts/:slug', source: 'next-app' },
    ]);
  });

  it('treats app/page.tsx as /', () => {
    writeFile('app/page.tsx', goodComponent('Root'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([{ path: 'app/page.tsx', routePath: '/', source: 'next-app' }]);
  });

  it('handles app router under src/', () => {
    writeFile('src/app/blog/page.tsx', goodComponent('Blog'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'src/app/blog/page.tsx', routePath: '/blog', source: 'next-app' },
    ]);
  });

  it('classifies Next.js pages router files', () => {
    writeFile('pages/dashboard.tsx', goodComponent('Dashboard'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'pages/dashboard.tsx', routePath: '/dashboard', source: 'next-pages' },
    ]);
  });

  it('treats pages/index.tsx as /', () => {
    writeFile('pages/index.tsx', goodComponent('Home'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([{ path: 'pages/index.tsx', routePath: '/', source: 'next-pages' }]);
  });

  it('converts pages dynamic segments', () => {
    writeFile('pages/posts/[id].tsx', goodComponent('Post'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'pages/posts/[id].tsx', routePath: '/posts/:id', source: 'next-pages' },
    ]);
  });

  it('classifies *Page.tsx via filename convention with no routePath', () => {
    writeFile('src/components/LoginPage.tsx', goodComponent('LoginPage'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'src/components/LoginPage.tsx', routePath: undefined, source: 'filename' },
    ]);
  });

  it('classifies *Screen / *View / *Route via filename convention', () => {
    writeFile('src/components/SettingsScreen.tsx', goodComponent('SettingsScreen'));
    writeFile('src/components/ProfileView.tsx', goodComponent('ProfileView'));
    writeFile('src/components/AdminRoute.tsx', goodComponent('AdminRoute'));
    const found = discoverScreenFiles(projectRoot);
    expect(found.map((s) => ({ path: s.path, source: s.source }))).toEqual([
      { path: 'src/components/AdminRoute.tsx', source: 'filename' },
      { path: 'src/components/ProfileView.tsx', source: 'filename' },
      { path: 'src/components/SettingsScreen.tsx', source: 'filename' },
    ]);
  });

  it('classifies anything inside src/screens/ via folder convention', () => {
    writeFile('src/screens/Home.tsx', goodComponent('Home'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'src/screens/Home.tsx', routePath: undefined, source: 'folder' },
    ]);
  });

  it('classifies files inside src/routes/ and src/views/ via folder convention', () => {
    writeFile('src/routes/Dashboard.tsx', goodComponent('Dashboard'));
    writeFile('src/views/Profile.tsx', goodComponent('Profile'));
    const found = discoverScreenFiles(projectRoot);
    expect(found.map((s) => ({ path: s.path, source: s.source }))).toEqual([
      { path: 'src/routes/Dashboard.tsx', source: 'folder' },
      { path: 'src/views/Profile.tsx', source: 'folder' },
    ]);
  });

  it('excludes pages/api/* and app/api/*', () => {
    writeFile('pages/api/users.tsx', goodComponent('Users'));
    writeFile('app/api/route.tsx', goodComponent('ApiRoute'));
    writeFile('pages/real.tsx', goodComponent('Real'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([{ path: 'pages/real.tsx', routePath: '/real', source: 'next-pages' }]);
  });

  it('excludes pages/_app, _document, _error, 404', () => {
    writeFile('pages/_app.tsx', goodComponent('App'));
    writeFile('pages/_document.tsx', goodComponent('Document'));
    writeFile('pages/_error.tsx', goodComponent('Error'));
    writeFile('pages/404.tsx', goodComponent('NotFound'));
    writeFile('pages/index.tsx', goodComponent('Home'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([{ path: 'pages/index.tsx', routePath: '/', source: 'next-pages' }]);
  });

  it('excludes app/**/layout.tsx and app/**/template.tsx', () => {
    writeFile('app/layout.tsx', goodComponent('Layout'));
    writeFile('app/dashboard/layout.tsx', goodComponent('DashLayout'));
    writeFile('app/dashboard/template.tsx', goodComponent('DashTpl'));
    writeFile('app/dashboard/page.tsx', goodComponent('Dash'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'app/dashboard/page.tsx', routePath: '/dashboard', source: 'next-app' },
    ]);
  });

  it('skips test files', () => {
    writeFile('src/screens/Home.tsx', goodComponent('Home'));
    writeFile('src/screens/Home.test.tsx', goodComponent('Home'));
    writeFile('src/screens/Home.spec.tsx', goodComponent('Home'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'src/screens/Home.tsx', routePath: undefined, source: 'folder' },
    ]);
  });

  it('skips non-react-component files even if name/folder matches', () => {
    writeFile('src/screens/notAComponent.tsx', `export const x = 1;`);
    writeFile('src/screens/Real.tsx', goodComponent('Real'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'src/screens/Real.tsx', routePath: undefined, source: 'folder' },
    ]);
  });

  it('reports a single file matching multiple heuristics once (first wins)', () => {
    // src/pages/index.tsx matches BOTH next-pages and folder — should be next-pages.
    writeFile('src/pages/index.tsx', goodComponent('Home'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([{ path: 'src/pages/index.tsx', routePath: '/', source: 'next-pages' }]);
  });

  it('skips node_modules / dist / .next / .validity', () => {
    writeFile('src/screens/Real.tsx', goodComponent('Real'));
    writeFile('node_modules/pkg/pages/Pkg.tsx', goodComponent('Pkg'));
    writeFile('dist/pages/Build.tsx', goodComponent('Build'));
    writeFile('.next/cache/Cache.tsx', goodComponent('Cache'));
    writeFile('.validity/wrapper.tsx', goodComponent('Wrapper'));
    const found = discoverScreenFiles(projectRoot);
    expect(found).toEqual([
      { path: 'src/screens/Real.tsx', routePath: undefined, source: 'folder' },
    ]);
  });

  it('returns empty for a project with no screens', () => {
    writeFile('src/components/Button.tsx', goodComponent('Button'));
    expect(discoverScreenFiles(projectRoot)).toEqual([]);
  });

  it('returns results sorted alphabetically by path', () => {
    writeFile('app/zebra/page.tsx', goodComponent('Z'));
    writeFile('app/alpha/page.tsx', goodComponent('A'));
    writeFile('src/screens/Mid.tsx', goodComponent('M'));
    const found = discoverScreenFiles(projectRoot);
    expect(found.map((s) => s.path)).toEqual([
      'app/alpha/page.tsx',
      'app/zebra/page.tsx',
      'src/screens/Mid.tsx',
    ]);
  });
});
