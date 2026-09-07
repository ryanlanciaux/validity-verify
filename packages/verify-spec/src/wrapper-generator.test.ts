import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findEntryFile,
  generateWrapperSource,
  isManagedAndUntouched,
  parseMarker,
  resolveEntryAppModule,
} from './wrapper-generator.js';

function makeProject(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-wrapper-gen-'));
  mkdirSync(resolve(root, 'src'), { recursive: true });
  return root;
}

function writeEntry(root: string, source: string, rel = 'src/main.tsx'): void {
  const abs = resolve(root, rel);
  mkdirSync(resolve(root, rel.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(abs, source);
}

describe('wrapper-generator', () => {
  let root: string;

  beforeEach(() => {
    root = makeProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('clones the canonical Vite + React Query + Router + Theme entry', () => {
    writeEntry(
      root,
      `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { ThemeProvider } from './theme/ThemeProvider';
import App from './App';
import './styles/globals.css';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
`,
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.entryFile).toBe('src/main.tsx');
    // BrowserRouter swapped for MemoryRouter with initialEntries.
    expect(result.source).toContain('MemoryRouter');
    expect(result.source).toContain('initialEntries');
    // <App/> spliced for {children}.
    expect(result.source).not.toContain('<App />');
    expect(result.source).toContain('{children}');
    // Hoisted const + side-effect CSS preserved.
    expect(result.source).toContain('const queryClient');
    expect(result.source).toContain("import '../src/styles/globals.css'");
    // Project-relative paths rewritten from .validity/ → ../src/...
    expect(result.source).toContain("from '../src/theme/ThemeProvider'");
  });

  it('strips RouterProvider and replaces with MemoryRouter children', () => {
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import App from './App';

const router = createBrowserRouter([
  { path: '/', element: <App /> },
]);

createRoot(document.getElementById('root')!).render(
  <RouterProvider router={router} />
);
`,
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    // The const router and createBrowserRouter import should NOT have
    // been hoisted because RouterProvider was stripped before identifier
    // collection.
    expect(result.source).not.toContain('const router');
    expect(result.source).not.toContain('createBrowserRouter');
    expect(result.source).not.toContain('RouterProvider');
    // The {children} slot should live inside <MemoryRouter>.
    expect(result.source).toMatch(/MemoryRouter[^>]*>[\s\S]*?\{children\}[\s\S]*?<\/MemoryRouter>/);
    // The route-config subtree was discarded unanalyzed — flag it so fidelity
    // never reports `verified` off the now-incomplete expected chain.
    expect(result.routerSubtreeDiscarded).toBe(true);
  });

  it('handles ViteReactSSG (vite-react-ssg) mount calls', () => {
    writeEntry(
      root,
      `import { StrictMode } from 'react';
import { ViteReactSSG } from 'vite-react-ssg';
import { AuthProvider } from './contexts/AuthContext';
import App from './App';
import './styles/globals.css';

export const createRoot = ViteReactSSG(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
`,
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.source).toContain('AuthProvider');
    expect(result.source).toContain('{children}');
    expect(result.source).not.toContain('ViteReactSSG');
  });

  it('handles React 17 ReactDOM.render', () => {
    writeEntry(
      root,
      `import ReactDOM from 'react-dom';
import App from './App';

ReactDOM.render(<App />, document.getElementById('root'));
`,
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.source).toContain('{children}');
  });

  it('handles hydrateRoot', () => {
    writeEntry(
      root,
      `import { hydrateRoot } from 'react-dom/client';
import App from './App';

hydrateRoot(document.getElementById('root')!, <App />);
`,
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.source).toContain('{children}');
  });

  it('wraps {children} in MemoryRouter when Router lives inside App.tsx', () => {
    // Reproduces the blunders.ai shape: main.tsx mounts <App/> behind
    // some context providers, but the actual router (`createBrowserRouter`
    // + `<RouterProvider/>`) lives one level down inside App.tsx. The
    // entry imports nothing from react-router-dom, so the existing
    // BrowserRouter/RouterProvider rewrite path doesn't fire. The
    // cloner should detect the App.tsx-side import and wrap the splice
    // point in <MemoryRouter> so hooks like useNavigate resolve.
    writeEntry(
      root,
      `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './contexts/AuthContext';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>
);
`,
    );
    writeEntry(
      root,
      `import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { HomePage } from './pages/HomePage';

const router = createBrowserRouter([
  { path: '/', element: <HomePage /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
`,
      'src/App.tsx',
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.source).toContain('MemoryRouter');
    expect(result.source).toContain('initialEntries');
    expect(result.source).toContain("from 'react-router-dom'");
    // {children} should now sit inside <MemoryRouter>.
    expect(result.source).toMatch(
      /<MemoryRouter[^>]*>[\s\S]*?\{children\}[\s\S]*?<\/MemoryRouter>/,
    );
  });

  it('does not double-wrap MemoryRouter when entry already has BrowserRouter', () => {
    // Sanity: when BrowserRouter is already in the entry tree, the
    // existing rewrite path swaps it for <MemoryRouter>. The new
    // App.tsx-detection path should NOT fire on top of that.
    writeEntry(
      root,
      `import { BrowserRouter } from 'react-router-dom';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
`,
    );
    writeEntry(
      root,
      `import { Routes, Route } from 'react-router-dom';
export default function App() {
  return <Routes><Route path="/" element={<div/>} /></Routes>;
}
`,
      'src/App.tsx',
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    // Exactly one <MemoryRouter — the swapped BrowserRouter, not a
    // double-wrap from the App.tsx detector.
    const memoryRouterMatches = result.source.match(/<MemoryRouter\b/g) ?? [];
    expect(memoryRouterMatches.length).toBe(1);
  });

  it('falls back to passthrough on no-mount-call entries', () => {
    writeEntry(root, `console.log('not a mount file');\n`);
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(false);
    expect(result.fallbackReason).toBe('no-mount-call');
    expect(result.source).toContain('return <>{children}</>');
  });

  it('falls back to passthrough when no entry file exists', () => {
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(false);
    expect(result.fallbackReason).toBe('no-entry-file');
    expect(result.source).toContain('return <>{children}</>');
  });

  it('composeWithUserWrapper wraps children in <UserWrapper> at the splice point', () => {
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
`,
    );
    const result = generateWrapperSource({
      projectRoot: root,
      composeWithUserWrapper: true,
    });
    expect(result.ok).toBe(true);
    expect(result.source).toContain("import UserWrapper from './wrapper.user'");
    expect(result.source).toMatch(/<UserWrapper>\s*\{children\}\s*<\/UserWrapper>/);
  });

  it('emits a marker header whose hash matches the body', () => {
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
`,
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    const marker = parseMarker(result.source);
    expect(marker).toBeDefined();
    expect(marker?.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(isManagedAndUntouched(result.source)).toBe(true);
  });

  it('isManagedAndUntouched returns false when the body is edited', () => {
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
`,
    );
    const result = generateWrapperSource({ projectRoot: root });
    const tampered = result.source + '\n// user edit\n';
    expect(isManagedAndUntouched(tampered)).toBe(false);
  });
});

describe('wrapper-generator — entry discovery (package.json main + root index)', () => {
  let root: string;

  beforeEach(() => {
    root = makeProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('honors package.json main naming a source file that contains a mount call', () => {
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'x', main: 'index.tsx' }));
    writeEntry(root, `export default 1;\n`, 'src/main.tsx');
    writeEntry(
      root,
      `import { registerRootComponent } from 'expo';
import { App } from './app/app';
registerRootComponent(App);
`,
      'index.tsx',
    );
    expect(findEntryFile(root)).toBe('index.tsx');
  });

  it('does NOT let a mountless package.json main shadow the candidate list', () => {
    // Publish-from-source library: main names a barrel, the demo app's real
    // entry is src/main.tsx. The barrel must lose.
    writeFileSync(
      resolve(root, 'package.json'),
      JSON.stringify({ name: 'x', main: 'src/index.ts' }),
    );
    writeEntry(root, `export * from './lib';\nexport { default } from './lib';\n`, 'src/index.ts');
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
`,
      'src/main.tsx',
    );
    expect(findEntryFile(root)).toBe('src/main.tsx');
  });

  it('does NOT let an Electron main-process bundle (dist-electron/main.js) shadow src/main.tsx', () => {
    // vite-plugin-electron layout: `main` points at the built Electron
    // main-process bundle, which exists after any dev/build run.
    writeFileSync(
      resolve(root, 'package.json'),
      JSON.stringify({ name: 'x', main: 'dist-electron/main.js' }),
    );
    writeEntry(
      root,
      `"use strict";const {app,BrowserWindow}=require("electron");app.whenReady().then(()=>{new BrowserWindow()});\n`,
      'dist-electron/main.js',
    );
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import App from './App';
const queryClient = new QueryClient();
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
`,
      'src/main.tsx',
    );
    expect(findEntryFile(root)).toBe('src/main.tsx');
    // End-to-end: the clone keeps the provider tree instead of falling back
    // to a passthrough that would read `degraded`.
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.entryFile).toBe('src/main.tsx');
    expect(result.expectedProviderChain).toContain('QueryClientProvider');
  });

  it('does NOT let a fullstack server main (server.js) shadow src/main.tsx', () => {
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'x', main: 'server.js' }));
    writeEntry(
      root,
      `const express = require('express');
const app = express();
app.listen(3000);
`,
      'server.js',
    );
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
`,
      'src/main.tsx',
    );
    expect(findEntryFile(root)).toBe('src/main.tsx');
  });

  it('honors a mount-bearing main over an earlier candidate (main is authoritative when trustworthy)', () => {
    // Both index.tsx (main, has the mount) and src/main.tsx (candidate,
    // mountless leftover) exist — the mount gate keeps main first.
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'x', main: 'index.tsx' }));
    writeEntry(root, `export const unused = true;\n`, 'src/main.tsx');
    writeEntry(
      root,
      `import { AppRegistry } from 'react-native';
import { App } from './app/app';
AppRegistry.registerComponent('main', () => App);
`,
      'index.tsx',
    );
    expect(findEntryFile(root)).toBe('index.tsx');
  });

  it('falls back to a mountless source main when no candidate exists', () => {
    // Nothing in ENTRY_CANDIDATES exists; the source-file main is still the
    // best concrete file to report `no-mount-call` against.
    writeFileSync(
      resolve(root, 'package.json'),
      JSON.stringify({ name: 'x', main: 'src/boot/entry.ts' }),
    );
    writeEntry(root, `export const boot = () => {};\n`, 'src/boot/entry.ts');
    expect(findEntryFile(root)).toBe('src/boot/entry.ts');
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(false);
    expect(result.fallbackReason).toBe('no-mount-call');
    expect(result.entryFile).toBe('src/boot/entry.ts');
  });

  it('ignores node-module-style mains (expo/AppEntry) and falls back to the static list', () => {
    writeFileSync(
      resolve(root, 'package.json'),
      JSON.stringify({ name: 'x', main: 'expo/AppEntry' }),
    );
    writeEntry(root, `export default 1;\n`, 'App.tsx');
    expect(findEntryFile(root)).toBe('App.tsx');
  });

  it('ignores mains pointing at build output (dist/index.js)', () => {
    writeFileSync(
      resolve(root, 'package.json'),
      JSON.stringify({ name: 'x', main: 'dist/index.js' }),
    );
    writeEntry(root, `console.log('built');\n`, 'dist/index.js');
    writeEntry(root, `export default 1;\n`, 'src/main.tsx');
    expect(findEntryFile(root)).toBe('src/main.tsx');
  });

  it('discovers a root index.tsx without a package.json main (listed after src/main.tsx)', () => {
    writeEntry(root, `export default 1;\n`, 'index.tsx');
    expect(findEntryFile(root)).toBe('index.tsx');
    // …but never shadows a canonical web entry.
    writeEntry(root, `export default 1;\n`, 'src/main.tsx');
    expect(findEntryFile(root)).toBe('src/main.tsx');
  });
});

describe('wrapper-generator — Expo/Ignite mount patterns', () => {
  let root: string;

  beforeEach(() => {
    root = makeProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const igniteAppTsx = `import { KeyboardProvider } from "react-native-keyboard-controller"
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context"

import { AuthProvider } from "./context/AuthContext"
import { AppNavigator } from "./navigators/AppNavigator"
import { ThemeProvider } from "./theme/context"
import "./utils/gestureHandler"

export function App() {
  const isReady = true
  if (!isReady) {
    return null
  }
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <KeyboardProvider>
        <AuthProvider>
          <ThemeProvider>
            <AppNavigator />
          </ThemeProvider>
        </AuthProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  )
}
`;

  function makeIgniteProject(): void {
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'x', main: 'index.tsx' }));
    writeFileSync(
      resolve(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./app/*'] } },
        include: ['**/*.ts', '**/*.tsx'],
      }),
    );
    writeEntry(
      root,
      `import { registerRootComponent } from "expo"

import { App } from "@/app"

registerRootComponent(App)
`,
      'index.tsx',
    );
    writeEntry(root, igniteAppTsx, 'app/app.tsx');
  }

  it('handles registerRootComponent with a JSX argument', () => {
    writeEntry(
      root,
      `import { registerRootComponent } from 'expo';
import { ThemeProvider } from './theme';
import App from './App';

registerRootComponent(<ThemeProvider><App /></ThemeProvider>);
`,
      'index.tsx',
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.expectedProviderChain).toEqual(['ThemeProvider']);
    expect(result.source).toContain('{children}');
    expect(result.source).not.toContain('<App');
  });

  it('handles AppRegistry.registerComponent with a local component factory', () => {
    writeEntry(
      root,
      `import { AppRegistry } from 'react-native';
import { StoreProvider } from './store';
import { Main } from './Main';

function Root() {
  return <StoreProvider><Main /></StoreProvider>;
}

AppRegistry.registerComponent('app', () => Root);
`,
      'index.js',
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.expectedProviderChain).toEqual(['StoreProvider']);
    expect(result.source).toContain('{children}');
    expect(result.source).not.toContain('Main');
  });

  it('clones the Ignite provider tree through registerRootComponent(App) + tsconfig alias', () => {
    // The exact fixture shape that used to produce a permanent
    // `no-entry-file` passthrough → degraded fidelity → all soft criteria
    // tainted unverifiable: package.json main index.tsx, entry registers a
    // NAMED import resolved through the `@/*` alias, provider tree one hop
    // away in app/app.tsx (whose App returns null while fonts load).
    makeIgniteProject();
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.entryFile).toBe('index.tsx');
    expect(result.resolvedAppModule).toBe('app/app.tsx');
    expect(result.expectedProviderChain).toEqual([
      'SafeAreaProvider',
      'KeyboardProvider',
      'AuthProvider',
      'ThemeProvider',
    ]);
    // Splice replaced the deepest leaf (<AppNavigator/>), and its
    // function-local props went with it — nothing to hoist.
    expect(result.source).toContain('{children}');
    expect(result.source).not.toContain('AppNavigator');
    // Relative imports rewritten from app/ to .validity/-relative.
    expect(result.source).toContain("from '../app/context/AuthContext'");
    expect(result.source).toContain("from '../app/theme/context'");
    expect(result.source).toContain("import '../app/utils/gestureHandler'");
    // Bare imports untouched.
    expect(result.source).toContain("from 'react-native-keyboard-controller'");
  });

  it('resolveEntryAppModule reports the indirection target (and undefined for direct mounts)', () => {
    makeIgniteProject();
    expect(resolveEntryAppModule(root)).toBe('app/app.tsx');

    rmSync(resolve(root, 'index.tsx'));
    rmSync(resolve(root, 'package.json'));
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
`,
    );
    expect(resolveEntryAppModule(root)).toBeUndefined();
  });

  it('falls back to passthrough with mount-target-unresolved when the import cannot be resolved', () => {
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'x', main: 'index.tsx' }));
    // No tsconfig paths and no app/app.tsx — '@/app' resolves nowhere.
    writeEntry(
      root,
      `import { registerRootComponent } from 'expo';
import { App } from '@/app';
registerRootComponent(App);
`,
      'index.tsx',
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(false);
    expect(result.fallbackReason).toBe("mount-target-unresolved: '@/app'");
    expect(result.source).toContain('return <>{children}</>');
  });

  it('follows a re-export barrel to the app module', () => {
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'x', main: 'index.tsx' }));
    writeEntry(
      root,
      `import { registerRootComponent } from 'expo';
import { App } from './app';
registerRootComponent(App);
`,
      'index.tsx',
    );
    writeEntry(root, `export { App } from './app';\n`, 'app/index.ts');
    writeEntry(root, igniteAppTsx, 'app/app.tsx');
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.resolvedAppModule).toBe('app/app.tsx');
    expect(result.expectedProviderChain).toEqual([
      'SafeAreaProvider',
      'KeyboardProvider',
      'AuthProvider',
      'ThemeProvider',
    ]);
  });
});

describe('wrapper-generator — expectedProviderChain (A1)', () => {
  let root: string;

  beforeEach(() => {
    root = makeProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('captures the post-rewrite chain for the canonical entry (BrowserRouter → MemoryRouter)', () => {
    writeEntry(
      root,
      `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { ThemeProvider } from './theme/ThemeProvider';
import App from './App';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
`,
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.expectedProviderChain).toEqual([
      'StrictMode',
      'QueryClientProvider',
      'MemoryRouter',
      'ThemeProvider',
    ]);
  });

  it('captures MemoryRouter for the RouterProvider strip-and-replace path', () => {
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import App from './App';

const router = createBrowserRouter([{ path: '/', element: <App /> }]);

createRoot(document.getElementById('root')!).render(
  <RouterProvider router={router} />
);
`,
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.expectedProviderChain).toEqual(['MemoryRouter']);
  });

  it('includes the injected MemoryRouter when Router lives inside App.tsx', () => {
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
`,
    );
    writeEntry(
      root,
      `import { BrowserRouter } from 'react-router-dom';
export default function App() { return <BrowserRouter><div /></BrowserRouter>; }
`,
      'src/App.tsx',
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.expectedProviderChain).toEqual(['MemoryRouter']);
  });

  it('is empty for a bare render(<App/>) entry', () => {
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
`,
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.expectedProviderChain).toEqual([]);
  });

  it('excludes fragment roots and lowercase intrinsics from the chain', () => {
    writeEntry(
      root,
      `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(
  <>
    <StrictMode>
      <div className="shell">
        <App />
      </div>
    </StrictMode>
  </>
);
`,
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    expect(result.expectedProviderChain).toEqual(['StrictMode']);
  });

  it('captures the chain for an Expo default-export entry (splice at the leaf)', () => {
    writeEntry(
      root,
      `import { ThemeProvider } from './theme';
import { Slot } from 'expo-router';
export default function RootLayout() {
  return (
    <ThemeProvider>
      <Slot />
    </ThemeProvider>
  );
}
`,
      'app/_layout.tsx',
    );
    const result = generateWrapperSource({
      projectRoot: root,
      entryFileOverride: 'app/_layout.tsx',
    });
    expect(result.ok).toBe(true);
    expect(result.expectedProviderChain).toEqual(['ThemeProvider']);
  });

  it('is empty on every fallback path', () => {
    const result = generateWrapperSource({ projectRoot: root }); // no entry file
    expect(result.ok).toBe(false);
    expect(result.expectedProviderChain).toEqual([]);
  });
});

describe('wrapper-generator — deep provider cloning (splice-target module)', () => {
  let root: string;

  beforeEach(() => {
    root = makeProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const bareEntry = `import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<App />);
`;

  it('clones providers declared inside App.tsx around the slot', () => {
    writeEntry(root, bareEntry);
    writeEntry(
      root,
      `import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { ThemeProvider } from './theme/ThemeProvider';
import { Routes, Route } from 'react-router-dom';
import { HomePage } from './pages/HomePage';

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
        </Routes>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
`,
      'src/App.tsx',
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    // App's own providers now wrap the slot.
    expect(result.source).toContain('<QueryClientProvider client={queryClient}>');
    expect(result.source).toContain('<ThemeProvider>');
    expect(result.source).toContain('{children}');
    // The routed content stays behind: no Routes/Route/HomePage in the wrapper.
    expect(result.source).not.toContain('Routes');
    expect(result.source).not.toContain('HomePage');
    // Imports hoisted from the APP module, path-rewritten from its dir.
    expect(result.source).toContain("from '../src/theme/ThemeProvider'");
    // Top-level const referenced by a kept attribute hoisted from App.tsx.
    expect(result.source).toContain('const queryClient');
    // App imports react-router-dom → MemoryRouter still provides router context.
    expect(result.source).toContain('MemoryRouter');
    expect(result.expectedProviderChain).toEqual([
      'QueryClientProvider',
      'ThemeProvider',
      'MemoryRouter',
    ]);
    expect(result.spliceTargetModule).toBe('src/App.tsx');
    expect(result.resolvedAppModule).toBe('src/App.tsx');
  });

  it('follows conditional returns, local indirections, and a data-router root layout', () => {
    writeEntry(
      root,
      `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AuthProvider } from './contexts/AuthContext';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>
);
`,
    );
    writeEntry(
      root,
      `import { Suspense } from 'react';
import { createBrowserRouter, RouterProvider, Outlet } from 'react-router-dom';
import { SubscriptionProvider } from './contexts/SubscriptionContext';
import { ToastProvider } from './components/ui';
import { AudioProvider } from './contexts/AudioContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HomePage } from './pages/HomePage';
import { LandingPage } from './pages/LandingPage';
import { useAuth } from './contexts/AuthContext';

function PageLoadingFallback() {
  return <div>Loading…</div>;
}

function RootLayout() {
  return (
    <AudioProvider>
      <ToastProvider>
        <Suspense fallback={<PageLoadingFallback />}>
          <Outlet />
        </Suspense>
      </ToastProvider>
    </AudioProvider>
  );
}

const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [{ path: '/', element: <HomePage /> }],
  },
]);

function AuthenticatedApp() {
  return (
    <SubscriptionProvider>
      <ErrorBoundary>
        <RouterProvider router={router} />
      </ErrorBoundary>
    </SubscriptionProvider>
  );
}

export default function App() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <PageLoadingFallback />;
  return isSignedIn ? <AuthenticatedApp /> : <LandingPage />;
}
`,
      'src/App.tsx',
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    // The real tree behind the auth conditional was found and cloned:
    // entry chain, then App's provider prefix, RouterProvider → MemoryRouter,
    // then the root route layout's providers down to its <Outlet/>.
    expect(result.expectedProviderChain).toEqual([
      'StrictMode',
      'AuthProvider',
      'SubscriptionProvider',
      'ErrorBoundary',
      'MemoryRouter',
      'AudioProvider',
      'ToastProvider',
      'Suspense',
    ]);
    // Exactly one MemoryRouter (no detector double-wrap).
    expect(result.source.match(/<MemoryRouter/g)).toHaveLength(1);
    expect(result.source).not.toContain('RouterProvider');
    // Route config stays behind; local components are never emitted.
    expect(result.source).not.toContain('createBrowserRouter');
    expect(result.source).not.toContain('HomePage');
    expect(result.source).not.toContain('PageLoadingFallback');
    // Suspense survives but its unhoistable local fallback attr is dropped.
    expect(result.source).toContain('<Suspense>');
    expect(result.routerSubtreeDiscarded).toBeUndefined();
    expect(result.spliceTargetProviderSignals).toContain('SubscriptionProvider');
  });

  it('falls back honestly when the app module cannot be analyzed', () => {
    writeEntry(root, bareEntry);
    writeEntry(
      root,
      `import { createApp } from './factory';
import { ToastProvider } from './components/ui';

function Shell({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

const App = createApp(Shell);
export default App;
`,
      'src/App.tsx',
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    // No clone happened…
    expect(result.source).not.toContain('ToastProvider');
    // …but the module's provider signals surface for the fidelity fold.
    expect(result.spliceTargetModule).toBe('src/App.tsx');
    expect(result.spliceTargetProviderSignals).toContain('ToastProvider');
  });

  it('bails to the honesty path on an entry/app local-name conflict', () => {
    writeEntry(
      root,
      `import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './theme/EntryTheme';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
`,
    );
    writeEntry(
      root,
      `import { ThemeProvider } from './other/AppTheme';

export default function App() {
  return (
    <ThemeProvider>
      <div>app</div>
    </ThemeProvider>
  );
}
`,
      'src/App.tsx',
    );
    const result = generateWrapperSource({ projectRoot: root });
    expect(result.ok).toBe(true);
    // Two different ThemeProvider bindings can't merge — the entry's clone
    // stands alone and the app-side signal keeps fidelity honest.
    expect(result.expectedProviderChain).toEqual(['ThemeProvider']);
    expect(result.source).not.toContain('AppTheme');
    expect(result.spliceTargetProviderSignals).toContain('ThemeProvider');
  });

  it('resolveEntryAppModule resolves the JSX-mount splice target', () => {
    writeEntry(root, bareEntry);
    writeEntry(root, `export default function App() { return <div/>; }`, 'src/App.tsx');
    expect(resolveEntryAppModule(root)).toBe('src/App.tsx');
  });
});
