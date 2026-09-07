import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { findEntryFile } from './wrapper-generator.js';

/**
 * Best-effort detection of a project's shape so an agent (or `validity setup`)
 * can hand-tailor `.validity/wrapper.tsx` and `.validity/config.ts` for it.
 *
 * Detection is intentionally shallow:
 *   - package.json deps are looked up by name (no version range parsing).
 *   - The entry file (src/main.tsx, app/main.tsx, src/index.tsx, etc.) is
 *     scanned for `<XxxProvider>` patterns via a simple regex — good enough
 *     to flag what to wrap with; the agent does the actual wrapper authoring.
 *   - Global-CSS detection probes well-known paths.
 *
 * We deliberately *don't* parse the full AST: the alpha goal is "give the
 * agent enough signal to do the right thing," not "auto-author wrappers
 * server-side." If the heuristics miss something, the agent still has the
 * project source to read.
 */

export type LibKind =
  | 'state'
  | 'data'
  | 'styling'
  | 'router'
  | 'auth'
  | 'i18n'
  | 'forms'
  | 'animation';

export interface DetectedLib {
  /** npm package name as it appears in package.json. */
  packageName: string;
  /** Coarse classification — drives the wrapper recommendations. */
  kind: LibKind;
  /** Human-friendly label and the suggested provider/import the agent should add. */
  label: string;
  suggestedImport?: string;
  suggestedProvider?: string;
  /** Free-form note shown to the agent. */
  note?: string;
}

export type WrapperStatus = 'missing' | 'passthrough' | 'has-providers';

export interface ProviderHint {
  /** JSX element name we matched in the entry, e.g. 'Provider' or 'QueryClientProvider'. */
  jsxName: string;
  /** Source file the match came from. */
  fromFile: string;
}

export interface ProjectShape {
  bundler: 'vite' | 'next' | 'unknown';
  detectedLibs: DetectedLib[];
  /** Resolved entry file (the first candidate that exists), if any. */
  entryFile?: string;
  /** Resolved global CSS file (the first candidate that exists), if any. */
  globalCssFile?: string;
  /** Provider components found by scanning the entry file. */
  providerHints: ProviderHint[];
  /** Whether the project's existing .validity/wrapper.tsx is a no-op or already wraps providers. */
  wrapperStatus: WrapperStatus;
  /** Path to .validity/wrapper.tsx, set whether or not it exists. */
  wrapperPath: string;
  /** Project-relative path of an existing .validity/config.ts, if found. */
  configPath?: string;
}

/** Match: dep name → classification + suggested wiring snippets. */
const LIB_REGISTRY: Record<string, Omit<DetectedLib, 'packageName'>> = {
  // State management
  '@reduxjs/toolkit': {
    kind: 'state',
    label: 'Redux Toolkit',
    suggestedImport:
      "import { Provider } from 'react-redux';\nimport { store } from '../<your-store-path>';",
    suggestedProvider: '<Provider store={store}>{children}</Provider>',
    note: "Point '../<your-store-path>' at where the project constructs its store. Read src/main.tsx (or wherever <Provider> is mounted in the real app) to copy the import.",
  },
  'react-redux': {
    kind: 'state',
    label: 'react-redux',
    suggestedImport:
      "import { Provider } from 'react-redux';\nimport { store } from '../<your-store-path>';",
    suggestedProvider: '<Provider store={store}>{children}</Provider>',
  },
  zustand: {
    kind: 'state',
    label: 'Zustand',
    note: 'Zustand stores are usually module-singletons — no Provider needed unless you use the React Context flavor. If the component reads `useStore` directly, it works as-is.',
  },
  jotai: {
    kind: 'state',
    label: 'Jotai',
    suggestedImport: "import { Provider } from 'jotai';",
    suggestedProvider: '<Provider>{children}</Provider>',
    note: 'Wrap with <Provider> to scope atoms to this render. Without it, atoms use the global default store.',
  },
  recoil: {
    kind: 'state',
    label: 'Recoil',
    suggestedImport: "import { RecoilRoot } from 'recoil';",
    suggestedProvider: '<RecoilRoot>{children}</RecoilRoot>',
  },
  // Data fetching
  '@tanstack/react-query': {
    kind: 'data',
    label: 'TanStack Query',
    suggestedImport:
      "import { QueryClient, QueryClientProvider } from '@tanstack/react-query';\nconst qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });",
    suggestedProvider: '<QueryClientProvider client={qc}>{children}</QueryClientProvider>',
    note: 'Disable retry + use staleTime: Infinity in the sandbox so screenshots are deterministic.',
  },
  '@tanstack/query-core': {
    kind: 'data',
    label: 'TanStack Query (core)',
    note: 'Likely used through @tanstack/react-query — see that entry.',
  },
  swr: {
    kind: 'data',
    label: 'SWR',
    suggestedImport: "import { SWRConfig } from 'swr';",
    suggestedProvider:
      '<SWRConfig value={{ revalidateOnFocus: false, dedupingInterval: 1_000_000 }}>{children}</SWRConfig>',
    note: 'Disable focus revalidation in the sandbox to keep screenshots stable.',
  },
  '@apollo/client': {
    kind: 'data',
    label: 'Apollo Client',
    suggestedImport:
      "import { ApolloClient, ApolloProvider, InMemoryCache, HttpLink } from '@apollo/client';\nconst client = new ApolloClient({ cache: new InMemoryCache(), link: new HttpLink({ uri: '/graphql' }) });",
    suggestedProvider: '<ApolloProvider client={client}>{children}</ApolloProvider>',
    note: 'Point HttpLink at /graphql so MSW handlers can match. Subscriptions over WebSocket are NOT intercepted in the sandbox.',
  },
  urql: {
    kind: 'data',
    label: 'urql',
    suggestedImport:
      "import { Provider as UrqlProvider, createClient, fetchExchange, cacheExchange } from 'urql';\nconst urqlClient = createClient({ url: '/graphql', exchanges: [cacheExchange, fetchExchange] });",
    suggestedProvider: '<UrqlProvider value={urqlClient}>{children}</UrqlProvider>',
  },
  // Styling
  tailwindcss: {
    kind: 'styling',
    label: 'Tailwind CSS',
    note: "Make sure .validity/wrapper.tsx imports the project's global CSS file (Tailwind directives + theme) so resets and fonts apply. See `globalCssFile` in the report.",
  },
  'styled-components': {
    kind: 'styling',
    label: 'styled-components',
    note: 'Works at runtime. If you have a <ThemeProvider>, mirror it in .validity/wrapper.tsx.',
  },
  '@emotion/react': {
    kind: 'styling',
    label: 'Emotion',
    note: 'Works at runtime. If you have a <ThemeProvider>, mirror it in .validity/wrapper.tsx.',
  },
  // Routing
  'react-router-dom': {
    kind: 'router',
    label: 'react-router',
    suggestedImport: "import { MemoryRouter } from 'react-router-dom';",
    suggestedProvider: "<MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>",
    note: "Use MemoryRouter (not BrowserRouter) — the sandbox URL is `?component=…`, not your app's routes.",
  },
  '@tanstack/react-router': {
    kind: 'router',
    label: 'TanStack Router',
    note: 'Provide your router instance via RouterProvider. May require a router instance suited for the sandbox (memory history).',
  },
  // i18n
  'react-i18next': {
    kind: 'i18n',
    label: 'react-i18next',
    note: 'Provide an i18n instance with bundled (not fetched) translations to keep screenshots reproducible.',
  },
  // Forms
  'react-hook-form': {
    kind: 'forms',
    label: 'React Hook Form',
    note: 'Works without a provider; nothing to wrap.',
  },
  // Animation
  'framer-motion': {
    kind: 'animation',
    label: 'Framer Motion',
    note: 'Animations may be mid-flight at screenshot time. Consider passing `transition={{ duration: 0 }}` for sandbox renders.',
  },
};

const ENTRY_CANDIDATES = [
  'src/main.tsx',
  'src/main.jsx',
  'src/index.tsx',
  'src/index.jsx',
  'src/main.ts',
  'app/main.tsx',
  'app/index.tsx',
  // Expo entries — App.tsx is the canonical bare entry,
  // app/_layout.tsx is the Expo Router 50+ root.
  'App.tsx',
  'App.jsx',
  'app/_layout.tsx',
  'app/_layout.jsx',
];

const GLOBAL_CSS_CANDIDATES = [
  'src/index.css',
  'src/main.css',
  'src/global.css',
  'src/globals.css',
  'src/styles/global.css',
  'src/styles/globals.css',
  'src/app.css',
  'app/globals.css',
];

const CONFIG_CANDIDATES = ['.validity/config.ts', '.validity/config.mts', '.validity/config.js'];

/** Strip out the small false-positive set of "looks like a provider but isn't." */
const NON_PROVIDER_NAMES = new Set([
  'StrictMode',
  'Suspense',
  'Fragment',
  'ErrorBoundary', // technically a provider-shape but not auto-wrappable
]);

/**
 * Matches a JSX tag whose name is `Provider` / `Root` / ends in `Provider` /
 * ends in `Root`. The negative lookahead `(?!\w)` keeps `Providerless`
 * from matching as `Provider`. Two-phase: capture the bare name, then
 * filter via NON_PROVIDER_NAMES + the suffix check.
 */
const JSX_NAME_REGEX = /<([A-Z][A-Za-z0-9_]*)(?=[\s/>])/g;

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function existsAt(projectRoot: string, rel: string): string | undefined {
  const abs = resolve(projectRoot, rel);
  try {
    if (statSync(abs).isFile()) return rel;
  } catch {
    // not present
  }
  return undefined;
}

function detectBundler(deps: Record<string, string>): ProjectShape['bundler'] {
  if (deps.next) return 'next';
  if (deps.vite) return 'vite';
  return 'unknown';
}

function detectLibsFromPackageJson(deps: Record<string, string>): DetectedLib[] {
  const out: DetectedLib[] = [];
  for (const [pkg, info] of Object.entries(LIB_REGISTRY)) {
    if (deps[pkg]) {
      out.push({ packageName: pkg, ...info });
    }
  }
  return out;
}

function scanEntryForProviders(projectRoot: string, entryRel: string): ProviderHint[] {
  const text = readTextSafe(resolve(projectRoot, entryRel));
  if (!text) return [];
  const hits = new Map<string, ProviderHint>();
  JSX_NAME_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JSX_NAME_REGEX.exec(text)) !== null) {
    const name = m[1]!;
    if (NON_PROVIDER_NAMES.has(name)) continue;
    // Heuristic shape: name is exactly Provider/Root, ends in Provider/Root,
    // or contains the word in its tail. Skip everything else (App, div-cased
    // components, layout names, etc. — too noisy).
    if (!/(Provider|Root)$/.test(name)) continue;
    if (!hits.has(name)) hits.set(name, { jsxName: name, fromFile: entryRel });
  }
  return Array.from(hits.values());
}

function classifyWrapper(text: string | null): WrapperStatus {
  if (text == null) return 'missing';
  // Heuristic: passthrough is a wrapper that just returns its children, with
  // no other JSX wrapping or imports beyond React/types. We look for any
  // <XxxProvider /> or <Suspense or other JSX wrapping; if absent, it's a
  // passthrough.
  const hasProviderJsx =
    /<[A-Z][A-Za-z0-9_]*Provider/.test(text) || /<[A-Z][A-Za-z0-9_]*Root/.test(text);
  if (hasProviderJsx) return 'has-providers';
  // Also accept hand-rolled wrappers that import a real CSS file or theme.
  const hasGlobalCssImport = /import\s+['"][^'"]*\.css['"]/.test(text);
  const hasNonTrivialChild =
    /<\w+[^>]*>\s*\{children\}\s*<\/\w+>/.test(text) && !/^\s*<>\s*\{children\}\s*<\/>/m.test(text);
  if (hasGlobalCssImport || hasNonTrivialChild) return 'has-providers';
  return 'passthrough';
}

export function detectProjectShape(projectRoot: string): ProjectShape {
  const pkg =
    readJsonSafe<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(resolve(projectRoot, 'package.json')) ?? {};
  const deps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  const bundler = detectBundler(deps);
  const detectedLibs = detectLibsFromPackageJson(deps);
  // Fall back to the wrapper generator's discovery (package.json `main`,
  // root index.*) so Ignite-style entries get providerHints too.
  const entryFile =
    ENTRY_CANDIDATES.map((c) => existsAt(projectRoot, c)).find(Boolean) ??
    findEntryFile(projectRoot);
  const globalCssFile = GLOBAL_CSS_CANDIDATES.map((c) => existsAt(projectRoot, c)).find(Boolean);
  const providerHints = entryFile ? scanEntryForProviders(projectRoot, entryFile) : [];
  const configPath = CONFIG_CANDIDATES.map((c) => existsAt(projectRoot, c)).find(Boolean);

  // Prefer .validity/wrapper.gen.tsx (current init default) and fall back
  // to the legacy .validity/wrapper.tsx for projects that initialized
  // before the gen/user split. Whichever exists is the one validity
  // actually renders through, so classifyWrapper needs its body — using
  // a hardcoded `wrapper.tsx` here made the `wrapper appropriate` check
  // a false-negative on every fresh install.
  const wrapperCandidates = ['.validity/wrapper.gen.tsx', '.validity/wrapper.tsx'];
  const wrapperRel =
    wrapperCandidates.find((c) => existsAt(projectRoot, c)) ?? '.validity/wrapper.tsx';
  const wrapperAbs = resolve(projectRoot, wrapperRel);
  const wrapperText = readTextSafe(wrapperAbs);
  const wrapperStatus = classifyWrapper(wrapperText);

  return {
    bundler,
    detectedLibs,
    entryFile,
    globalCssFile,
    providerHints,
    wrapperStatus,
    wrapperPath: wrapperRel,
    configPath,
  };
}

/**
 * Render the suggested wrapper as a single TSX string the agent can write
 * (or the user can copy-paste). Layered as: imports → setup constants →
 * function body composing the providers in a sensible order:
 *   Router  →  State (Redux/Recoil/Jotai) → Data (Query/SWR/Apollo) → Theme
 * The agent is expected to review this — the inserted "<your-store-path>"
 * etc. require a quick edit before it'll compile.
 */
export function suggestWrapperSource(shape: ProjectShape): string {
  const imports: string[] = [`import type { ReactNode } from 'react';`];
  const setupLines: string[] = [];
  const wraps: string[] = []; // each is a JSX template containing `__INNER__`

  if (shape.globalCssFile) {
    imports.push(`import '../${shape.globalCssFile}';   // global CSS / Tailwind / theme`);
  }

  // Prefer one wrap per kind, in nesting order (outermost first).
  const order: LibKind[] = ['router', 'state', 'data', 'styling', 'i18n', 'auth'];
  const seenKinds = new Set<LibKind>();
  for (const kind of order) {
    for (const lib of shape.detectedLibs) {
      if (lib.kind !== kind) continue;
      if (seenKinds.has(kind)) continue;
      if (!lib.suggestedProvider) continue;
      seenKinds.add(kind);
      if (lib.suggestedImport) imports.push(lib.suggestedImport);
      wraps.push(lib.suggestedProvider);
    }
  }

  let inner = '{children}';
  // Apply wraps from innermost to outermost (reverse order from the loop above).
  for (const tpl of [...wraps].reverse()) {
    inner = tpl.replace('{children}', inner);
  }

  const lines: string[] = [
    '// Generated suggestion from `validity setup`. Review before saving — the',
    '// `<your-store-path>` placeholder is intentional; replace it with the real',
    '// import path where your store/router/etc. is constructed in src/main.tsx.',
    ...imports,
    '',
    ...setupLines,
    `export default function Wrapper({ children }: { children: ReactNode }) {`,
    `  return (`,
    `    ${inner}`,
    `  );`,
    `}`,
    '',
  ];
  return lines.join('\n');
}
