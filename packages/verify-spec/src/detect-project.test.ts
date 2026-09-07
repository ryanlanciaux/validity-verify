import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProjectShape, suggestWrapperSource } from './detect-project.js';

describe('detectProjectShape', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-detect-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string): void {
    const abs = resolve(projectRoot, rel);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }

  function pkg(deps: Record<string, string>): void {
    writeFile('package.json', JSON.stringify({ name: 'test', dependencies: deps }));
  }

  it('returns sensible defaults for an empty project', () => {
    const shape = detectProjectShape(projectRoot);
    expect(shape.bundler).toBe('unknown');
    expect(shape.detectedLibs).toEqual([]);
    expect(shape.entryFile).toBeUndefined();
    expect(shape.globalCssFile).toBeUndefined();
    expect(shape.providerHints).toEqual([]);
    expect(shape.wrapperStatus).toBe('missing');
    expect(shape.wrapperPath).toBe('.validity/wrapper.tsx');
  });

  it('detects vite as the bundler', () => {
    pkg({ vite: '5.0.0' });
    expect(detectProjectShape(projectRoot).bundler).toBe('vite');
  });

  it('detects next over vite when both are present', () => {
    pkg({ next: '14.0.0', vite: '5.0.0' });
    expect(detectProjectShape(projectRoot).bundler).toBe('next');
  });

  it('detects redux + react-query + tailwind from deps', () => {
    pkg({
      '@reduxjs/toolkit': '2.0.0',
      'react-redux': '9.0.0',
      '@tanstack/react-query': '5.0.0',
      tailwindcss: '3.4.0',
    });
    const shape = detectProjectShape(projectRoot);
    const kinds = shape.detectedLibs.map((l) => l.kind);
    expect(kinds).toContain('state');
    expect(kinds).toContain('data');
    expect(kinds).toContain('styling');
    const names = shape.detectedLibs.map((l) => l.packageName);
    expect(names).toContain('@reduxjs/toolkit');
    expect(names).toContain('@tanstack/react-query');
    expect(names).toContain('tailwindcss');
  });

  it('finds the entry file from a candidate path', () => {
    writeFile('src/main.tsx', 'export {}');
    expect(detectProjectShape(projectRoot).entryFile).toBe('src/main.tsx');
  });

  it('finds the global CSS file from candidate paths', () => {
    writeFile('src/index.css', 'body{}');
    expect(detectProjectShape(projectRoot).globalCssFile).toBe('src/index.css');
  });

  it('extracts <Provider> hints from the entry file', () => {
    writeFile(
      'src/main.tsx',
      `import { Provider } from 'react-redux';
       import { QueryClientProvider } from '@tanstack/react-query';
       <Provider store={store}>
         <QueryClientProvider client={qc}>
           <ThemeProvider>
             <App />
           </ThemeProvider>
         </QueryClientProvider>
       </Provider>;`,
    );
    const shape = detectProjectShape(projectRoot);
    const names = shape.providerHints.map((h) => h.jsxName).sort();
    expect(names).toEqual(['Provider', 'QueryClientProvider', 'ThemeProvider']);
  });

  it('skips StrictMode/Suspense/Fragment as non-providers', () => {
    writeFile(
      'src/main.tsx',
      `<StrictMode>
         <Suspense fallback={null}>
           <Fragment>
             <App />
           </Fragment>
         </Suspense>
       </StrictMode>`,
    );
    expect(detectProjectShape(projectRoot).providerHints).toEqual([]);
  });

  it('classifies a passthrough wrapper as such', () => {
    writeFile(
      '.validity/wrapper.tsx',
      `import type { ReactNode } from 'react';
       export default function Wrapper({ children }: { children: ReactNode }) {
         return <>{children}</>;
       }`,
    );
    expect(detectProjectShape(projectRoot).wrapperStatus).toBe('passthrough');
  });

  it('classifies a wrapper with a Provider as has-providers', () => {
    writeFile(
      '.validity/wrapper.tsx',
      `import { Provider } from 'react-redux';
       export default function Wrapper({ children }) {
         return <Provider store={store}>{children}</Provider>;
       }`,
    );
    expect(detectProjectShape(projectRoot).wrapperStatus).toBe('has-providers');
  });

  it('classifies a wrapper that imports global CSS as has-providers', () => {
    writeFile(
      '.validity/wrapper.tsx',
      `import './globals.css';
       export default function Wrapper({ children }) {
         return <>{children}</>;
       }`,
    );
    expect(detectProjectShape(projectRoot).wrapperStatus).toBe('has-providers');
  });

  it('finds a .validity/config.ts when present', () => {
    writeFile('.validity/config.ts', `export default {};`);
    expect(detectProjectShape(projectRoot).configPath).toBe('.validity/config.ts');
  });
});

describe('suggestWrapperSource', () => {
  it('produces an empty (passthrough-style) wrapper when no libs detected', () => {
    const src = suggestWrapperSource({
      bundler: 'unknown',
      detectedLibs: [],
      providerHints: [],
      wrapperStatus: 'missing',
      wrapperPath: '.validity/wrapper.tsx',
    });
    expect(src).toContain('export default function Wrapper');
    expect(src).toContain('{children}');
    // No imports beyond the type-only React import.
    expect(src).toMatch(/import type \{ ReactNode \} from 'react';/);
  });

  it('imports the global CSS file when one was detected', () => {
    const src = suggestWrapperSource({
      bundler: 'vite',
      detectedLibs: [],
      providerHints: [],
      wrapperStatus: 'missing',
      wrapperPath: '.validity/wrapper.tsx',
      globalCssFile: 'src/index.css',
    });
    expect(src).toContain("import '../src/index.css';");
  });

  it('nests router → state → data in the correct order', () => {
    const src = suggestWrapperSource({
      bundler: 'vite',
      providerHints: [],
      wrapperStatus: 'missing',
      wrapperPath: '.validity/wrapper.tsx',
      detectedLibs: [
        {
          packageName: 'react-router-dom',
          kind: 'router',
          label: 'react-router',
          suggestedImport: "import { MemoryRouter } from 'react-router-dom';",
          suggestedProvider: "<MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>",
        },
        {
          packageName: 'react-redux',
          kind: 'state',
          label: 'react-redux',
          suggestedImport: "import { Provider } from 'react-redux';",
          suggestedProvider: '<Provider store={store}>{children}</Provider>',
        },
        {
          packageName: '@tanstack/react-query',
          kind: 'data',
          label: 'TanStack Query',
          suggestedImport:
            "import { QueryClient, QueryClientProvider } from '@tanstack/react-query';",
          suggestedProvider: '<QueryClientProvider client={qc}>{children}</QueryClientProvider>',
        },
      ],
    });
    // MemoryRouter is the outermost wrap; QueryClientProvider is the innermost.
    const memIdx = src.indexOf('<MemoryRouter');
    const provIdx = src.indexOf('<Provider');
    const qcIdx = src.indexOf('<QueryClientProvider');
    expect(memIdx).toBeGreaterThan(0);
    expect(memIdx).toBeLessThan(provIdx);
    expect(provIdx).toBeLessThan(qcIdx);
  });

  it('includes only one wrap per kind even if multiple libs of that kind are detected', () => {
    const src = suggestWrapperSource({
      bundler: 'vite',
      providerHints: [],
      wrapperStatus: 'missing',
      wrapperPath: '.validity/wrapper.tsx',
      detectedLibs: [
        {
          packageName: '@reduxjs/toolkit',
          kind: 'state',
          label: 'RTK',
          suggestedImport: "import { Provider } from 'react-redux';",
          suggestedProvider: '<Provider store={store}>{children}</Provider>',
        },
        {
          packageName: 'jotai',
          kind: 'state',
          label: 'Jotai',
          suggestedImport: "import { Provider as JotaiProvider } from 'jotai';",
          suggestedProvider: '<JotaiProvider>{children}</JotaiProvider>',
        },
      ],
    });
    // Whichever 'state' lib appears first in detectedLibs wins.
    expect(src).toContain('<Provider store={store}>');
    expect(src).not.toContain('<JotaiProvider');
  });
});
