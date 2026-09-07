import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureValidityConfigured, readWrapperFidelity } from './ensure-configured.js';
import {
  computeShapeSignature,
  readWrapperBodyHash,
  writeShapeSignature,
} from './shape-signature.js';
import { passthroughTemplate } from './wrapper-generator.js';

function makeProject(opts?: { withConfig?: boolean }): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-ensure-'));
  mkdirSync(resolve(root, '.validity'), { recursive: true });
  mkdirSync(resolve(root, 'src'), { recursive: true });
  writeFileSync(
    resolve(root, 'package.json'),
    JSON.stringify(
      {
        name: 'test',
        dependencies: { react: '^18', 'react-router-dom': '^7', '@tanstack/react-query': '^5' },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(root, 'src/main.tsx'),
    `import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter><App /></BrowserRouter>
);
`,
  );
  if (opts?.withConfig) {
    writeFileSync(
      resolve(root, '.validity/config.ts'),
      `export default { renderMode: 'web', framework: 'auto', wrapper: './.validity/wrapper.gen.tsx' };\n`,
    );
  }
  return root;
}

describe('ensureValidityConfigured', () => {
  let root: string;

  beforeEach(() => {
    root = makeProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('bootstraps a virgin project', async () => {
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.status).toBe('fresh');
    expect(result.bootstrapped).toBe(true);
    expect(existsSync(resolve(root, '.validity/wrapper.gen.tsx'))).toBe(true);
    expect(existsSync(resolve(root, '.validity/config.ts'))).toBe(true);
    expect(existsSync(resolve(root, '.validity/.shape-signature.json'))).toBe(true);
  });

  it('returns status:unchanged on the second call (steady state)', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.status).toBe('unchanged');
    expect(result.bootstrapped).toBe(false);
    expect(result.generatedFiles).toHaveLength(0);
  });

  it('detects entry-file drift and regenerates wrapper', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    // Modify the entry file to add a new provider.
    writeFileSync(
      resolve(root, 'src/main.tsx'),
      `import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeProvider';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter><ThemeProvider><App /></ThemeProvider></BrowserRouter>
);
`,
    );
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.status).toBe('drift-resolved');
    expect(result.driftReasons.some((d) => d.category === 'entry-file')).toBe(true);
    const wrapper = readFileSync(resolve(root, '.validity/wrapper.gen.tsx'), 'utf-8');
    expect(wrapper).toContain('ThemeProvider');
  });

  it('forks-and-warns when user has edited wrapper.gen.tsx AND drift is detected', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    // User edits the gen file.
    const edited =
      readFileSync(resolve(root, '.validity/wrapper.gen.tsx'), 'utf-8') + '\n// USER EDIT\n';
    writeFileSync(resolve(root, '.validity/wrapper.gen.tsx'), edited);
    // Then drift the entry.
    writeFileSync(
      resolve(root, 'src/main.tsx'),
      `import { createRoot } from 'react-dom/client';
import App from './App';
createRoot(document.getElementById('root')!).render(<App />);
`,
    );
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.status).toBe('manual-required');
    expect(existsSync(resolve(root, '.validity/wrapper.gen.tsx.suggested'))).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.manualSteps).toBeDefined();
    expect(result.manualSteps?.length).toBeGreaterThan(0);
    // Original file preserved.
    expect(readFileSync(resolve(root, '.validity/wrapper.gen.tsx'), 'utf-8')).toBe(edited);
  });

  it('respects an existing config.ts (does not overwrite)', async () => {
    rmSync(root, { recursive: true });
    root = makeProject({ withConfig: true });
    const before = readFileSync(resolve(root, '.validity/config.ts'), 'utf-8');
    await ensureValidityConfigured({ projectRoot: root });
    const after = readFileSync(resolve(root, '.validity/config.ts'), 'utf-8');
    expect(after).toBe(before);
  });

  it('compose-with-user-wrapper when wrapper.user.tsx exists', async () => {
    writeFileSync(
      resolve(root, '.validity/wrapper.user.tsx'),
      `import type { ReactNode } from 'react';
export default function UserWrapper({ children }: { children: ReactNode }) {
  return <div className="user-overrides">{children}</div>;
}
`,
    );
    await ensureValidityConfigured({ projectRoot: root });
    const wrapper = readFileSync(resolve(root, '.validity/wrapper.gen.tsx'), 'utf-8');
    expect(wrapper).toContain("import UserWrapper from './wrapper.user'");
    expect(wrapper).toMatch(/<UserWrapper>\s*\{children\}\s*<\/UserWrapper>/);
  });

  it('steady-state cost is well under 50ms', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    // Now measure the cheap-tier path.
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.status).toBe('unchanged');
    expect(result.durationMs).toBeLessThan(50);
  });

  it('--force triggers regen even with no drift', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    const result = await ensureValidityConfigured({ projectRoot: root, force: true });
    expect(result.status).not.toBe('unchanged');
    expect(result.generatedFiles.some((f) => f.action === 'wrote')).toBe(true);
  });

  it('stamps wrapperFidelity degraded (passthrough) when the cloner falls back', async () => {
    // No entry file → generateWrapperSource degrades to the passthrough
    // wrapper. The degradation must be machine-readable (not just a warning
    // string) so prepareVerification can taint soft verdicts with 'wrapper'.
    rmSync(resolve(root, 'src/main.tsx'));
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.wrapperFidelity).toEqual({
      status: 'degraded',
      missingProviders: [],
      expectedProviders: [],
      analyzed: 'passthrough',
      detail: 'no-entry-file',
    });
    expect(result.warnings.some((w) => w.includes('passthrough wrapper'))).toBe(true);
  });

  it('stamps wrapperFidelity verified on a clean clone and persists it in .shape-signature.json', async () => {
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.wrapperFidelity?.status).toBe('verified');
    expect(result.wrapperFidelity?.analyzed).toBe('generated');
    expect(result.wrapperFidelity?.missingProviders).toEqual([]);
    // The entry's BrowserRouter is renamed to MemoryRouter post-rewrite.
    expect(result.wrapperFidelity?.expectedProviders).toContain('MemoryRouter');
    const sig = JSON.parse(readFileSync(resolve(root, '.validity/.shape-signature.json'), 'utf-8'));
    expect(sig.wrapperFidelity).toEqual({
      status: 'verified',
      missingProviders: [],
      expectedProviders: result.wrapperFidelity?.expectedProviders,
    });
  });

  it('echoes wrapperFidelity from the signature cache on the cheap-tier path', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.status).toBe('unchanged');
    expect(result.wrapperFidelity?.status).toBe('verified');
    expect(result.wrapperFidelity?.analyzed).toBe('signature-cache');
  });

  it('computes-on-miss for a legacy signature (no schema bump), persists, then cache-echoes', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    // Simulate a pre-A1 signature file: strip the fidelity field. The cheap
    // tier still matches (project files untouched), so this exercises the
    // legacy migration path — which must NOT read as drift.
    const sigPath = resolve(root, '.validity/.shape-signature.json');
    const sig = JSON.parse(readFileSync(sigPath, 'utf-8'));
    delete sig.wrapperFidelity;
    writeFileSync(sigPath, JSON.stringify(sig, null, 2));

    const first = await ensureValidityConfigured({ projectRoot: root });
    expect(first.status).toBe('unchanged');
    expect(first.wrapperFidelity?.status).toBe('verified');
    expect(first.wrapperFidelity?.analyzed).toBe('on-disk');
    // Persisted for the next call…
    expect(JSON.parse(readFileSync(sigPath, 'utf-8')).wrapperFidelity?.status).toBe('verified');
    // …which echoes from cache without re-analyzing.
    const second = await ensureValidityConfigured({ projectRoot: root });
    expect(second.wrapperFidelity?.analyzed).toBe('signature-cache');
  });

  it('degrades when the user edits wrapper.gen.tsx to remove a provider (benign no-drift path)', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    // Swap the MemoryRouter for a bare div — the `{children}` slot survives
    // but the router context is gone. No other drift, so ensure keeps the
    // on-disk file (`skipped`) but must catch that the wrapper that renders
    // no longer matches the entry's chain.
    const genPath = resolve(root, '.validity/wrapper.gen.tsx');
    writeFileSync(genPath, readFileSync(genPath, 'utf-8').replaceAll('MemoryRouter', 'div'));

    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.status).toBe('unchanged');
    expect(result.wrapperFidelity?.status).toBe('degraded');
    expect(result.wrapperFidelity?.analyzed).toBe('on-disk');
    expect(result.wrapperFidelity?.missingProviders).toEqual(['MemoryRouter']);
  });

  it('reads a user-edited wrapper with NO {children} slot as unknown (sandbox fails loudly anyway)', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    const genPath = resolve(root, '.validity/wrapper.gen.tsx');
    const edited = readFileSync(genPath, 'utf-8').replace('{children}', '<div />');
    writeFileSync(genPath, edited);

    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.wrapperFidelity?.status).toBe('unknown');
  });

  it('router equivalence: a user-edited wrapper keeping BrowserRouter stays verified', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    const genPath = resolve(root, '.validity/wrapper.gen.tsx');
    const edited = readFileSync(genPath, 'utf-8').replaceAll('MemoryRouter', 'BrowserRouter');
    writeFileSync(genPath, edited);

    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.wrapperFidelity?.status).toBe('verified');
  });

  it('manual-required: fidelity is computed from the PRESERVED wrapper and warned about', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    // User strips the router from the gen file (slot survives)…
    const genPath = resolve(root, '.validity/wrapper.gen.tsx');
    writeFileSync(genPath, readFileSync(genPath, 'utf-8').replaceAll('MemoryRouter', 'div'));
    // …then the entry drifts (adds a provider) → manual-required fork.
    writeFileSync(
      resolve(root, 'src/main.tsx'),
      `import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './theme/ThemeProvider';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter><ThemeProvider><App /></ThemeProvider></BrowserRouter>
);
`,
    );
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.status).toBe('manual-required');
    expect(result.wrapperFidelity?.status).toBe('degraded');
    expect(result.wrapperFidelity?.analyzed).toBe('on-disk');
    // The preserved wrapper misses BOTH the router and the new provider.
    expect(result.wrapperFidelity?.missingProviders).toEqual(
      expect.arrayContaining(['MemoryRouter', 'ThemeProvider']),
    );
    expect(result.warnings.some((w) => w.startsWith('Wrapper fidelity: degraded'))).toBe(true);
  });

  it('passthrough with a detectable entry (no mount call) names the missing providers', async () => {
    writeFileSync(
      resolve(root, 'src/main.tsx'),
      `import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
// No mount call at all — the cloner cannot find a splice point.
export const tree = <BrowserRouter><QueryClientProvider client={null as never}><div /></QueryClientProvider></BrowserRouter>;
`,
    );
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.wrapperFidelity?.status).toBe('degraded');
    expect(result.wrapperFidelity?.analyzed).toBe('passthrough');
    expect(result.wrapperFidelity?.detail).toBe('no-mount-call');
    expect(result.wrapperFidelity?.missingProviders).toEqual(
      expect.arrayContaining(['QueryClientProvider', 'MemoryRouter']),
    );
  });

  it('passthrough + wrapper.user.tsx satisfying every detected provider clears the taint (documented fix path)', async () => {
    writeFileSync(
      resolve(root, 'src/main.tsx'),
      `import { QueryClientProvider } from '@tanstack/react-query';
// No mount call — passthrough. The user wrapper below supplies the provider.
export const tree = <QueryClientProvider client={null as never}><div /></QueryClientProvider>;
`,
    );
    writeFileSync(
      resolve(root, '.validity/wrapper.user.tsx'),
      `import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const client = new QueryClient();
export default function UserWrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
`,
    );
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.wrapperFidelity?.status).toBe('verified');
    expect(result.wrapperFidelity?.analyzed).toBe('passthrough');
    expect(result.wrapperFidelity?.expectedProviders).toContain('QueryClientProvider');
  });

  // REGRESSION (stale signature cache: wrapper.user.tsx CONTENT changes never
  // invalidate the cached fidelity): after a degraded verdict is persisted,
  // editing the ALREADY-EXISTING wrapper.user.tsx to add the missing provider
  // — the warning's own documented fix — must clear the taint on the very
  // next verify, not echo the stale `degraded` from the signature cache.
  it('editing wrapper.user.tsx content invalidates the cached fidelity (degraded → verified)', async () => {
    writeFileSync(
      resolve(root, 'src/main.tsx'),
      `import { QueryClientProvider } from '@tanstack/react-query';
// No mount call — passthrough fallback.
export const tree = <QueryClientProvider client={null as never}><div /></QueryClientProvider>;
`,
    );
    // The user wrapper exists but does NOT satisfy the detected provider yet.
    writeFileSync(
      resolve(root, '.validity/wrapper.user.tsx'),
      `import type { ReactNode } from 'react';
export default function UserWrapper({ children }: { children: ReactNode }) {
  return <div>{children}</div>;
}
`,
    );
    const before = await ensureValidityConfigured({ projectRoot: root });
    expect(before.wrapperFidelity?.status).toBe('degraded');
    // Steady state: the cache echoes the degraded verdict…
    const cached = await ensureValidityConfigured({ projectRoot: root });
    expect(cached.wrapperFidelity?.status).toBe('degraded');
    expect(cached.wrapperFidelity?.analyzed).toBe('signature-cache');
    // …until the user edits wrapper.user.tsx to add the provider. Only the
    // user wrapper changes — no other tracked input moves.
    writeFileSync(
      resolve(root, '.validity/wrapper.user.tsx'),
      `import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const client = new QueryClient();
export default function UserWrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
`,
    );
    const after = await ensureValidityConfigured({ projectRoot: root });
    expect(after.wrapperFidelity?.status).toBe('verified');
    // The refreshed verdict is persisted, so the cheap tier echoes VERIFIED now.
    const echoed = await ensureValidityConfigured({ projectRoot: root });
    expect(echoed.wrapperFidelity?.status).toBe('verified');
    expect(echoed.wrapperFidelity?.analyzed).toBe('signature-cache');
  });

  it('readWrapperFidelity reads the signature cache without running the orchestrator', async () => {
    expect(readWrapperFidelity(root)).toBeUndefined();
    await ensureValidityConfigured({ projectRoot: root });
    const cached = readWrapperFidelity(root);
    expect(cached?.status).toBe('verified');
    expect(cached?.analyzed).toBe('signature-cache');
  });
});

describe('ensureValidityConfigured — Ignite-shaped projects (entry indirection)', () => {
  let root: string;

  function makeIgniteProject(): string {
    const dir = mkdtempSync(resolve(tmpdir(), 'validity-ensure-ignite-'));
    mkdirSync(resolve(dir, '.validity'), { recursive: true });
    mkdirSync(resolve(dir, 'app'), { recursive: true });
    writeFileSync(
      resolve(dir, 'package.json'),
      JSON.stringify(
        { name: 'ignite-test', main: 'index.tsx', dependencies: { react: '^19', expo: '~55' } },
        null,
        2,
      ),
    );
    writeFileSync(
      resolve(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['./app/*'] } },
        include: ['**/*.ts', '**/*.tsx'],
      }),
    );
    writeFileSync(
      resolve(dir, 'index.tsx'),
      `import { registerRootComponent } from "expo"

import { App } from "@/app"

registerRootComponent(App)
`,
    );
    writeFileSync(
      resolve(dir, 'app/app.tsx'),
      `import { SafeAreaProvider } from "react-native-safe-area-context"
import { AuthProvider } from "./context/AuthContext"
import { ThemeProvider } from "./theme/context"
import { AppNavigator } from "./navigators/AppNavigator"

export function App() {
  const isReady = true
  if (!isReady) {
    return null
  }
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <ThemeProvider>
          <AppNavigator />
        </ThemeProvider>
      </AuthProvider>
    </SafeAreaProvider>
  )
}
`,
    );
    return dir;
  }

  beforeEach(() => {
    root = makeIgniteProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('bootstraps with a real provider clone and verified fidelity (not a degraded passthrough)', async () => {
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.status).toBe('fresh');
    expect(result.wrapperFidelity?.status).toBe('verified');
    expect(result.wrapperFidelity?.analyzed).toBe('generated');
    expect(result.wrapperFidelity?.expectedProviders).toEqual([
      'SafeAreaProvider',
      'AuthProvider',
      'ThemeProvider',
    ]);
    const wrapper = readFileSync(resolve(root, '.validity/wrapper.gen.tsx'), 'utf-8');
    expect(wrapper).toContain('SafeAreaProvider');
    expect(wrapper).toContain("from '../app/context/AuthContext'");
    expect(wrapper).not.toContain('AppNavigator');
  });

  it('editing the app module (not the entry) re-triggers regen with the new provider chain', async () => {
    await ensureValidityConfigured({ projectRoot: root });
    // Drop AuthProvider from app/app.tsx — index.tsx is untouched.
    writeFileSync(
      resolve(root, 'app/app.tsx'),
      `import { SafeAreaProvider } from "react-native-safe-area-context"
import { ThemeProvider } from "./theme/context"
import { AppNavigator } from "./navigators/AppNavigator"

export function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AppNavigator />
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
`,
    );
    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.status).toBe('drift-resolved');
    expect(result.driftReasons.some((d) => d.field === 'appModuleFile.content')).toBe(true);
    expect(result.wrapperFidelity?.expectedProviders).toEqual([
      'SafeAreaProvider',
      'ThemeProvider',
    ]);
    const wrapper = readFileSync(resolve(root, '.validity/wrapper.gen.tsx'), 'utf-8');
    expect(wrapper).not.toContain('AuthProvider');
  });

  // REGRESSION (the fixture scenario): a project initialized by a Validity
  // that couldn't find the Ignite entry has `.shape-signature.json` with
  // `entryFile: null` + a cached degraded fidelity, and a passthrough
  // wrapper.gen.tsx. The cheap tier used to echo that verdict forever; it
  // must now self-heal without `validity init --force`.
  it('self-heals a stale entryFile:null degraded signature cache', async () => {
    // Seed the exact stale state the old build left behind.
    const genPath = resolve(root, '.validity/wrapper.gen.tsx');
    writeFileSync(
      genPath,
      passthroughTemplate({
        validityVersion: '0.0.1',
        reason: 'no entry file found in src/main.tsx and friends',
      }),
    );
    writeFileSync(
      resolve(root, '.validity/config.ts'),
      `export default { renderMode: 'web', framework: 'auto', wrapper: './.validity/wrapper.gen.tsx' };\n`,
    );
    const sig = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    sig.entryFile = null;
    delete (sig as { appModuleFile?: unknown }).appModuleFile;
    sig.wrapperFidelity = { status: 'degraded', missingProviders: [], expectedProviders: [] };
    sig.wrapperGenContentHash = readWrapperBodyHash(genPath);
    writeShapeSignature(root, sig);

    const result = await ensureValidityConfigured({ projectRoot: root });
    expect(result.status).toBe('drift-resolved');
    expect(result.driftReasons.some((d) => d.field === 'entryFile.path')).toBe(true);
    expect(result.wrapperFidelity?.status).toBe('verified');
    expect(result.wrapperFidelity?.analyzed).toBe('generated');
    const wrapper = readFileSync(genPath, 'utf-8');
    expect(wrapper).toContain('SafeAreaProvider');

    // Steady state afterwards: the cheap tier echoes the HEALED verdict.
    const echoed = await ensureValidityConfigured({ projectRoot: root });
    expect(echoed.status).toBe('unchanged');
    expect(echoed.wrapperFidelity?.status).toBe('verified');
    expect(echoed.wrapperFidelity?.analyzed).toBe('signature-cache');
  });
});
