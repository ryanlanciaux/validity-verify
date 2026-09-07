import { describe, expect, it } from 'vitest';
import {
  analyzeWrapperProviders,
  detectProviderSignals,
  foldWrapperFidelity,
} from './wrapper-fidelity.js';

const GENERATED_LIKE = `// @validity-generated do-not-edit hash=abc at=now validity=0.0.1
// Edit .validity/wrapper.user.tsx instead — anything you put there wraps the generated tree.
// Regenerate manually with: validity init --force
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient();

export default function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}
`;

describe('analyzeWrapperProviders', () => {
  it('round-trips a generated wrapper (providers wrapping the slot)', () => {
    const out = analyzeWrapperProviders(GENERATED_LIKE);
    expect(out).not.toBeNull();
    expect([...out!.presentChain].sort()).toEqual(['MemoryRouter', 'QueryClientProvider']);
  });

  it('detects a deleted provider (swapped for an intrinsic)', () => {
    const out = analyzeWrapperProviders(GENERATED_LIKE.replaceAll('MemoryRouter', 'div'));
    expect(out!.presentChain.has('MemoryRouter')).toBe(false);
    expect(out!.presentChain.has('QueryClientProvider')).toBe(true);
  });

  it('a passthrough wrapper yields an empty set (fragment ancestors excluded)', () => {
    const out = analyzeWrapperProviders(
      `export default function Wrapper({ children }: { children: unknown }) {
  return <>{children}</>;
}`,
    );
    expect(out!.presentChain.size).toBe(0);
  });

  it('inlines <UserWrapper> from userWrapperSource', () => {
    const out = analyzeWrapperProviders(
      `import UserWrapper from './wrapper.user';
export default function Wrapper({ children }: { children: unknown }) {
  return <UserWrapper>{children}</UserWrapper>;
}`,
      {
        userWrapperSource: `import { ThemeProvider } from './theme';
export default function UserWrapper({ children }: { children: unknown }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}`,
      },
    );
    expect(out!.presentChain.has('ThemeProvider')).toBe(true);
    // UserWrapper itself is composition, not a provider.
    expect(out!.presentChain.has('UserWrapper')).toBe(false);
  });

  it('unparseable userWrapperSource contributes nothing (never throws)', () => {
    const out = analyzeWrapperProviders(
      `import UserWrapper from './wrapper.user';
export default function Wrapper({ children }: { children: unknown }) {
  return <UserWrapper>{children}</UserWrapper>;
}`,
      { userWrapperSource: 'const nope = <<<' },
    );
    expect(out!.presentChain.size).toBe(0);
  });

  it('conditional double-slot folds by INTERSECTION (over-taints, never under-taints)', () => {
    const out = analyzeWrapperProviders(
      `import { Shell } from './shell';
import { ThemeProvider } from './theme';
export default function Wrapper({ children, flag }: { children: unknown; flag: boolean }) {
  return <Shell>{flag ? <ThemeProvider>{children}</ThemeProvider> : children}</Shell>;
}`,
    );
    // ThemeProvider wraps only ONE of the two slots — not counted as present.
    expect(out!.presentChain.has('ThemeProvider')).toBe(false);
    expect(out!.presentChain.has('Shell')).toBe(true);
  });

  it('returns null on parse failure and on slot-less sources', () => {
    expect(analyzeWrapperProviders('const nope = <<<')).toBeNull();
    expect(analyzeWrapperProviders('export default function W() { return <div />; }')).toBeNull();
  });

  // REGRESSION (analyzeWrapperProviders folds ALL `children` references
  // file-wide by intersection): a helper component's own `children` slot must
  // not empty the wrapper's chain — the provider IS present.
  it('a local helper component with its own children slot does not empty the chain', () => {
    const out = analyzeWrapperProviders(
      `import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
const queryClient = new QueryClient();
function Layout({ children }: { children: ReactNode }) {
  return <div className="layout">{children}</div>;
}
export default function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <Layout>{children}</Layout>
    </QueryClientProvider>
  );
}`,
    );
    expect(out).not.toBeNull();
    expect(out!.presentChain.has('QueryClientProvider')).toBe(true);
  });

  it('providers factored into a local helper component still count (expanded like UserWrapper)', () => {
    const out = analyzeWrapperProviders(
      `import { ThemeProvider } from './theme';
import type { ReactNode } from 'react';
const Providers = ({ children }: { children: ReactNode }) => (
  <ThemeProvider>{children}</ThemeProvider>
);
export default function Wrapper({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}`,
    );
    expect(out!.presentChain.has('ThemeProvider')).toBe(true);
  });

  // REGRESSION (same finding): `useMemo(() => children, [children])` is data
  // plumbing, not a slot — the analyzer cannot see how children render, so it
  // must read as null (→ `unknown`), never contribute an empty chain (→ a
  // false `degraded` that permanently blocks signedOff).
  it('useMemo(() => children, [children]) yields null (unknown), never a false degraded', () => {
    const source = `import { useMemo } from 'react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
const queryClient = new QueryClient();
export default function Wrapper({ children }: { children: ReactNode }) {
  const memo = useMemo(() => children, [children]);
  return <QueryClientProvider client={queryClient}>{memo}</QueryClientProvider>;
}`;
    expect(analyzeWrapperProviders(source)).toBeNull();
    const fold = foldWrapperFidelity({
      expected: ['QueryClientProvider'],
      actual: null,
      generation: { ok: true },
      analyzed: 'on-disk',
    });
    expect(fold.status).toBe('unknown');
  });

  it('non-render references (hook deps, console.log args) do not poison a real slot', () => {
    const out = analyzeWrapperProviders(
      `import { useEffect } from 'react';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
const queryClient = new QueryClient();
export default function Wrapper({ children }: { children: ReactNode }) {
  useEffect(() => { console.log(children); }, [children]);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}`,
    );
    expect(out).not.toBeNull();
    expect(out!.presentChain.has('QueryClientProvider')).toBe(true);
  });

  it('a bare `return children` path still intersects (over-taint preserved, no laundering)', () => {
    const out = analyzeWrapperProviders(
      `import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
const queryClient = new QueryClient();
export default function Wrapper({ children, flag }: { children: ReactNode; flag: boolean }) {
  if (flag) return children;
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}`,
    );
    // One render path is unwrapped — QueryClientProvider must NOT count.
    expect(out).not.toBeNull();
    expect(out!.presentChain.has('QueryClientProvider')).toBe(false);
  });

  it('return-level conditional bare alternate still intersects', () => {
    const out = analyzeWrapperProviders(
      `import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
const queryClient = new QueryClient();
export default function Wrapper({ children, flag }: { children: ReactNode; flag: boolean }) {
  return flag ? <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> : children;
}`,
    );
    expect(out).not.toBeNull();
    expect(out!.presentChain.has('QueryClientProvider')).toBe(false);
  });

  it('resolves `export default Wrapper` identifiers and arrow components', () => {
    const out = analyzeWrapperProviders(
      `import { ThemeProvider } from './theme';
import type { ReactNode } from 'react';
function Wrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}
export default Wrapper;`,
    );
    expect(out!.presentChain.has('ThemeProvider')).toBe(true);
  });
});

describe('detectProviderSignals', () => {
  it('matches <XyzProvider> elements and known module imports', () => {
    const signals = detectProviderSignals(`
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ConvexProvider } from 'convex/react';
render(<BrowserRouter><QueryClientProvider>x</QueryClientProvider></BrowserRouter>);
`);
    expect(signals).toContain('QueryClientProvider');
    expect(signals).toContain('MemoryRouter'); // react-router-dom import → router expectation
    expect(signals).toContain('ConvexProvider');
  });

  it('returns [] when nothing provider-shaped is present', () => {
    expect(detectProviderSignals(`render(<App />);`)).toEqual([]);
  });
});

describe('foldWrapperFidelity', () => {
  const okGen = { ok: true } as const;
  const failedGen = { ok: false, fallbackReason: 'no-mount-call' } as const;

  it('generation ok + expected ⊆ actual → verified; extras never degrade', () => {
    const out = foldWrapperFidelity({
      expected: ['QueryClientProvider'],
      actual: new Set(['QueryClientProvider', 'ThemeProvider', 'ExtraProvider']),
      generation: okGen,
      analyzed: 'generated',
    });
    expect(out.status).toBe('verified');
    expect(out.missingProviders).toEqual([]);
  });

  it('routerSubtreeDiscarded caps a full chain match at degraded (never verified)', () => {
    // Chain matches exactly — but a RouterProvider substitution discarded the
    // route-config subtree, so the expectation itself is incomplete. Providers
    // mounted inside a route element would be invisible → must not read verified.
    const out = foldWrapperFidelity({
      expected: ['MemoryRouter'],
      actual: new Set(['MemoryRouter']),
      generation: okGen,
      routerSubtreeDiscarded: true,
      analyzed: 'generated',
    });
    expect(out.status).toBe('degraded');
    expect(out.missingProviders).toEqual([]);
    expect(out.detail).toMatch(/replaced by <MemoryRouter>/);
  });

  it('without routerSubtreeDiscarded the same match stays verified (no false degrade)', () => {
    const out = foldWrapperFidelity({
      expected: ['MemoryRouter'],
      actual: new Set(['MemoryRouter']),
      generation: okGen,
      analyzed: 'generated',
    });
    expect(out.status).toBe('verified');
  });

  it('generation ok + missing member → degraded with names', () => {
    const out = foldWrapperFidelity({
      expected: ['QueryClientProvider', 'MemoryRouter'],
      actual: new Set(['MemoryRouter']),
      generation: okGen,
      analyzed: 'on-disk',
    });
    expect(out.status).toBe('degraded');
    expect(out.missingProviders).toEqual(['QueryClientProvider']);
  });

  it('router equivalence: BrowserRouter satisfies an expected MemoryRouter', () => {
    const out = foldWrapperFidelity({
      expected: ['MemoryRouter'],
      actual: new Set(['BrowserRouter']),
      generation: okGen,
      analyzed: 'on-disk',
    });
    expect(out.status).toBe('verified');
  });

  it('generation ok + unanalyzable wrapper → unknown (never degraded, never verified)', () => {
    const out = foldWrapperFidelity({
      expected: ['QueryClientProvider'],
      actual: null,
      generation: okGen,
      analyzed: 'on-disk',
    });
    expect(out.status).toBe('unknown');
  });

  it('generation failed + detectable entry signals unmet → degraded with the matched names', () => {
    const out = foldWrapperFidelity({
      expected: [],
      actual: new Set<string>(),
      generation: failedGen,
      entrySourceText: `import { QueryClientProvider } from '@tanstack/react-query';
export const tree = <QueryClientProvider>x</QueryClientProvider>;`,
      analyzed: 'passthrough',
    });
    expect(out.status).toBe('degraded');
    expect(out.missingProviders).toEqual(['QueryClientProvider']);
    expect(out.detail).toBe('no-mount-call');
  });

  it('generation failed + no entry text → degraded with empty lists (foundation-locked passthrough stamp)', () => {
    const out = foldWrapperFidelity({
      expected: [],
      actual: new Set<string>(),
      generation: { ok: false, fallbackReason: 'no-entry-file' },
      analyzed: 'passthrough',
    });
    expect(out).toEqual({
      status: 'degraded',
      missingProviders: [],
      expectedProviders: [],
      analyzed: 'passthrough',
      detail: 'no-entry-file',
    });
  });

  it('generation failed + wrapper.user.tsx satisfying every detected signal → verified (fix path)', () => {
    const out = foldWrapperFidelity({
      expected: [],
      actual: new Set(['QueryClientProvider', 'BrowserRouter']),
      generation: failedGen,
      entrySourceText: `import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
export const tree = <BrowserRouter><QueryClientProvider>x</QueryClientProvider></BrowserRouter>;`,
      analyzed: 'passthrough',
    });
    expect(out.status).toBe('verified');
    expect(out.expectedProviders).toEqual(expect.arrayContaining(['QueryClientProvider']));
  });
});

describe('foldWrapperFidelity — splice-target signals (deep-clone honesty)', () => {
  const okGen = { ok: true } as const;

  it('unsatisfied app-module signals cap a matching chain at degraded, named', () => {
    const out = foldWrapperFidelity({
      expected: ['StrictMode', 'AuthProvider'],
      actual: new Set(['StrictMode', 'AuthProvider', 'MemoryRouter']),
      generation: okGen,
      spliceTarget: {
        module: 'src/App.tsx',
        signals: ['SubscriptionProvider', 'ToastProvider', 'RouterProvider'],
      },
      analyzed: 'generated',
    });
    expect(out.status).toBe('degraded');
    // RouterProvider is satisfied by the MemoryRouter equivalent; the rest are named.
    expect(out.missingProviders).toEqual(['SubscriptionProvider', 'ToastProvider']);
    expect(out.detail).toContain('src/App.tsx');
    expect(out.detail).toContain('wrapper.user.tsx');
  });

  it('signals satisfied by the rendering wrapper (user composition included) → verified', () => {
    const out = foldWrapperFidelity({
      expected: ['StrictMode'],
      actual: new Set(['StrictMode', 'SubscriptionProvider', 'ToastProvider', 'MemoryRouter']),
      generation: okGen,
      spliceTarget: {
        module: 'src/App.tsx',
        signals: ['SubscriptionProvider', 'ToastProvider', 'RouterProvider'],
      },
      analyzed: 'generated',
    });
    expect(out.status).toBe('verified');
    expect(out.missingProviders).toEqual([]);
  });
});
