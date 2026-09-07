import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { planAutoMock, renderAutoMockConfigSource } from './auto-mock.js';

function makeProject(deps: Record<string, string>, entry?: { file: string; body: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-automock-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: deps }));
  if (entry) writeFileSync(join(dir, entry.file), entry.body);
  return dir;
}

describe('planAutoMock', () => {
  const dirs: string[] = [];
  const project = (deps: Record<string, string>, entry?: { file: string; body: string }) => {
    const d = makeProject(deps, entry);
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('returns an empty-but-valid plan when nothing is detected', () => {
    const plan = planAutoMock(project({ react: '18' }));
    expect(plan.libs).toEqual([]);
    expect(plan.baseHandlers).toEqual([]);
    expect(plan.scenarios).toEqual({});
    expect(plan.manualNotes).toEqual([]);
  });

  it('seeds a /graphql handler for Apollo', () => {
    const plan = planAutoMock(project({ '@apollo/client': '3' }));
    expect(plan.libs.map((l) => l.label)).toContain('Apollo Client');
    expect(plan.baseHandlers.some((h) => h.url === '/graphql' && h.method === 'POST')).toBe(true);
  });

  it('does not duplicate /graphql when both Apollo and urql are present', () => {
    const plan = planAutoMock(project({ '@apollo/client': '3', urql: '4' }));
    expect(plan.baseHandlers.filter((h) => h.url === '/graphql')).toHaveLength(1);
  });

  it('seeds a tRPC batch handler', () => {
    const plan = planAutoMock(project({ '@trpc/client': '11' }));
    expect(plan.baseHandlers.some((h) => h.url === '/api/trpc')).toBe(true);
  });

  it('builds logged-in / logged-out scenarios when an auth lib is present', () => {
    const plan = planAutoMock(project({ 'next-auth': '4' }));
    expect(Object.keys(plan.scenarios).sort()).toEqual(['logged-in', 'logged-out']);
    const session = plan.scenarios['logged-in']!.handlers!.find(
      (h) => h.url === '/api/auth/session',
    );
    expect(session?.json).toMatchObject({
      user: expect.objectContaining({ id: expect.any(String) }),
    });
    expect(
      plan.scenarios['logged-out']!.handlers!.find((h) => h.url === '/api/auth/session')?.json,
    ).toEqual({});
  });

  it('biases the logged-in session to a cookie for cookie-based auth (Clerk)', () => {
    const plan = planAutoMock(project({ '@clerk/clerk-react': '5' }));
    expect(plan.scenarios['logged-in']!.cookies).toMatchObject({ session: 'mock-session' });
  });

  it('biases the logged-in session to localStorage for bearer auth (Auth0)', () => {
    const plan = planAutoMock(project({ '@auth0/auth0-react': '2' }));
    expect(plan.scenarios['logged-in']!.localStorage).toMatchObject({
      authToken: expect.any(String),
    });
  });

  it('prefers the entry-file signal over the dep heuristic for auth transport', () => {
    // Auth0 dep would normally bias bearer, but a cookie-reading entry wins.
    const plan = planAutoMock(
      project(
        { '@auth0/auth0-react': '2' },
        {
          file: 'App.tsx',
          body: 'const x = document.cookie;\nexport default function App(){return null}',
        },
      ),
    );
    expect(plan.scenarios['logged-in']!.cookies).toMatchObject({ session: 'mock-session' });
  });

  it('flags provider-stub libraries (Convex) in manualNotes', () => {
    const plan = planAutoMock(project({ convex: '1' }));
    expect(plan.manualNotes.join(' ')).toMatch(/Convex/);
    expect(plan.manualNotes.join(' ')).toMatch(/WebSocket/);
  });

  it('does not emit auth scenarios for a data-only stack', () => {
    const plan = planAutoMock(project({ '@tanstack/react-query': '5' }));
    expect(plan.scenarios).toEqual({});
  });
});

describe('renderAutoMockConfigSource', () => {
  const dirs: string[] = [];
  const project = (deps: Record<string, string>) => {
    const d = makeProject(deps);
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const assertParses = (src: string) => {
    // The generated config is a TS module — it must parse cleanly so Vite's
    // jiti loader doesn't choke on it at runtime.
    expect(() => parse(src, { sourceType: 'module', plugins: ['typescript'] })).not.toThrow();
  };

  it('emits a parseable minimal config when nothing is detected', () => {
    const src = renderAutoMockConfigSource(project({ react: '18' }));
    assertParses(src);
    expect(src).toContain("renderMode: 'web' as const");
    expect(src).toContain("fallback: 'permissive' as const");
    // Falls back to the canonical logged-in/logged-out scaffold.
    expect(src).toContain("'logged-in'");
    expect(src).toContain("'logged-out'");
  });

  it('pins a React Native project to the device, not to react-native-web', () => {
    // `framework: 'auto'` here would be how a mobile app silently ends up
    // validated in a browser — the generated config states the target instead.
    const src = renderAutoMockConfigSource(project({ expo: '51', 'react-native': '0.74' }));
    assertParses(src);
    expect(src).toContain("renderMode: 'native' as const");
    expect(src).toContain("framework: 'expo-native' as const");
    expect(src).not.toContain("framework: 'auto' as const");
    // And it says how to opt into Expo Web, so the pin isn't a dead end.
    expect(src).toContain("framework: 'expo-web'");
  });

  it('leaves web projects on auto-detection', () => {
    const src = renderAutoMockConfigSource(project({ vite: '6', react: '18' }));
    assertParses(src);
    expect(src).toContain("framework: 'auto' as const");
    expect(src).toContain("renderMode: 'web' as const");
  });

  it('emits a parseable config with seeded handlers for a detected stack', () => {
    const src = renderAutoMockConfigSource(project({ '@apollo/client': '3', 'next-auth': '4' }));
    assertParses(src);
    expect(src).toContain('Auto-detected:');
    expect(src).toContain('/graphql');
    expect(src).toContain('/api/auth/session');
  });

  it('documents provider-stub libs in the header comment', () => {
    const src = renderAutoMockConfigSource(project({ convex: '1' }));
    assertParses(src);
    expect(src).toContain('wrapper.user.tsx');
    expect(src).toMatch(/Convex/);
  });

  it('seeds commands.typecheck for a TypeScript project (tsconfig + typescript dep) — A5', () => {
    const dir = project({ react: '18', typescript: '5' });
    writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": {} }');
    const src = renderAutoMockConfigSource(dir);
    assertParses(src);
    expect(src).toContain('commands: {');
    expect(src).toContain("typecheck: 'tsc --noEmit'");
  });

  it('does NOT seed commands without a tsconfig or without the typescript dep', () => {
    // typescript dep but no tsconfig.json.
    expect(renderAutoMockConfigSource(project({ react: '18', typescript: '5' }))).not.toContain(
      'commands:',
    );
    // tsconfig.json but no typescript dep.
    const dir = project({ react: '18' });
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    expect(renderAutoMockConfigSource(dir)).not.toContain('commands:');
  });

  it('does not seed a watch.onSignal dispatch command', () => {
    const dir = project({ react: '18' });
    expect(renderAutoMockConfigSource(dir)).not.toContain('watch:');
    expect(renderAutoMockConfigSource(dir)).not.toContain('onSignal');
    expect(renderAutoMockConfigSource(dir)).not.toContain('claude -p');
  });

  it('scaffolds export.appId from app.json (Android package) — C1', () => {
    const dir = project({ expo: '51' });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({ expo: { android: { package: 'com.validitytestapp' } } }),
    );
    const src = renderAutoMockConfigSource(dir);
    assertParses(src);
    expect(src).toContain("export: { appId: 'com.validitytestapp' }");
    expect(src).not.toContain('TODO(validity): set export.appId');
  });

  it('uses the iOS bundle id when no Android package is present — C1', () => {
    const dir = project({ expo: '51' });
    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.acme.ios' } } }),
    );
    const src = renderAutoMockConfigSource(dir);
    assertParses(src);
    expect(src).toContain("export: { appId: 'com.acme.ios' }");
  });

  it('reads the app id from a dynamic app.config.ts — C1', () => {
    const dir = project({ expo: '51' });
    writeFileSync(
      join(dir, 'app.config.ts'),
      'export default { expo: { android: { package: "com.dyn.app" } } };',
    );
    const src = renderAutoMockConfigSource(dir);
    assertParses(src);
    expect(src).toContain("export: { appId: 'com.dyn.app' }");
  });

  it('leaves a commented TODO stub for a native project with no discoverable app id — C1', () => {
    // app.json present (→ nativeAvailable) but carrying no android/ios id.
    const dir = project({ expo: '51' });
    writeFileSync(join(dir, 'app.json'), JSON.stringify({ expo: {} }));
    const src = renderAutoMockConfigSource(dir);
    assertParses(src);
    expect(src).toContain('TODO(validity): set export.appId');
    expect(src).toContain("// export: { appId: 'com.example.app' }");
  });

  it('emits no export stanza for a pure-web project — C1', () => {
    const src = renderAutoMockConfigSource(project({ vite: '6', react: '18' }));
    assertParses(src);
    expect(src).not.toContain('export: {');
    expect(src).not.toContain('appId');
  });
});
