import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cheapTierMatches,
  compareShapeSignatures,
  computeShapeSignature,
  readShapeSignature,
  writeShapeSignature,
} from './shape-signature.js';

function makeProject(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-shape-sig-'));
  mkdirSync(resolve(root, '.validity'), { recursive: true });
  mkdirSync(resolve(root, 'src'), { recursive: true });
  writeFileSync(
    resolve(root, 'package.json'),
    JSON.stringify(
      {
        name: 'test',
        dependencies: { react: '^18', 'react-router-dom': '^7' },
        devDependencies: { eslint: '^9', vite: '^6' },
      },
      null,
      2,
    ),
  );
  writeFileSync(resolve(root, 'src/main.tsx'), 'export default 1;\n');
  return root;
}

describe('shape-signature', () => {
  let root: string;

  beforeEach(() => {
    root = makeProject();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('produces a stable signature on identical inputs', () => {
    const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    const b = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    expect(b.entryFile?.contentHash).toBe(a.entryFile?.contentHash);
    expect(b.relevantDeps).toEqual(a.relevantDeps);
  });

  it('detects no drift on identical signatures', () => {
    const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    const b = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    expect(compareShapeSignatures(a, b)).toEqual([]);
  });

  it('flags first-run when no prior signature', () => {
    const next = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    const reasons = compareShapeSignatures(null, next);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.category).toBe('schema-bump');
  });

  it('flags entry-file drift when content changes', () => {
    const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    writeFileSync(resolve(root, 'src/main.tsx'), 'export default 2;\n');
    const b = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    const reasons = compareShapeSignatures(a, b);
    expect(reasons.some((r) => r.category === 'entry-file')).toBe(true);
  });

  it('only tracks relevant deps — adding lodash does not trigger drift', () => {
    const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    const pkg = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('node:fs') as typeof import('node:fs')).readFileSync(
        resolve(root, 'package.json'),
        'utf-8',
      ),
    );
    pkg.dependencies.lodash = '^4';
    writeFileSync(resolve(root, 'package.json'), JSON.stringify(pkg, null, 2));
    const b = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    const reasons = compareShapeSignatures(a, b);
    expect(reasons.some((r) => r.category === 'relevant-deps')).toBe(false);
  });

  it('flags relevant-deps drift when adding @tanstack/react-query', () => {
    const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    const pkg = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('node:fs') as typeof import('node:fs')).readFileSync(
        resolve(root, 'package.json'),
        'utf-8',
      ),
    );
    pkg.dependencies['@tanstack/react-query'] = '^5';
    writeFileSync(resolve(root, 'package.json'), JSON.stringify(pkg, null, 2));
    const b = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    const reasons = compareShapeSignatures(a, b);
    expect(reasons.some((r) => r.category === 'relevant-deps')).toBe(true);
  });

  it('cheapTierMatches returns true for unchanged inputs, false after edit', () => {
    const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    expect(cheapTierMatches(a, root)).toBe(true);
    // Touch entry to bump mtime.
    writeFileSync(resolve(root, 'src/main.tsx'), 'export default 1; // touched\n');
    expect(cheapTierMatches(a, root)).toBe(false);
  });

  it('cheapTierMatches returns false when wrapper.user.tsx existence toggles', () => {
    // Prevents a regression where creating wrapper.user.tsx mid-session
    // didn't trigger a regen because the cheap tier ignored its
    // existence. Without this, agents follow the missing-provider hint,
    // create wrapper.user.tsx, re-run verify, and hit the same render
    // error because gen.tsx is still composeWithUserWrapper:false.
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    expect(cheapTierMatches(a, root)).toBe(true);
    writeFileSync(
      resolve(root, '.validity/wrapper.user.tsx'),
      'export default ({ children }) => children;\n',
    );
    expect(cheapTierMatches(a, root)).toBe(false);
  });

  // REGRESSION (stale signature cache: wrapper.user.tsx CONTENT changes never
  // invalidate the cached fidelity): editing an EXISTING wrapper.user.tsx —
  // the documented fix path for a degraded wrapper — must miss the cheap tier
  // so the authoritative tier re-analyzes fidelity.
  it('cheapTierMatches returns false when wrapper.user.tsx CONTENT changes (existence stable)', () => {
    writeFileSync(
      resolve(root, '.validity/wrapper.user.tsx'),
      'export default ({ children }) => children;\n',
    );
    const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    expect(a.wrapperUserFile).not.toBeNull();
    expect(cheapTierMatches(a, root)).toBe(true);
    writeFileSync(
      resolve(root, '.validity/wrapper.user.tsx'),
      `import { QueryClientProvider } from '@tanstack/react-query';
export default ({ children }) => <QueryClientProvider>{children}</QueryClientProvider>;
`,
    );
    expect(cheapTierMatches(a, root)).toBe(false);
  });

  it('cheapTierMatches misses once for a legacy signature that predates wrapperUserFile', () => {
    writeFileSync(
      resolve(root, '.validity/wrapper.user.tsx'),
      'export default ({ children }) => children;\n',
    );
    const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    // Simulate a pre-fix signature: the field was never persisted.
    delete (a as { wrapperUserFile?: unknown }).wrapperUserFile;
    expect(cheapTierMatches(a, root)).toBe(false);
    // Legacy signatures WITHOUT a wrapper.user.tsx keep short-circuiting.
    rmSync(resolve(root, '.validity/wrapper.user.tsx'));
    const b = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    delete (b as { wrapperUserFile?: unknown }).wrapperUserFile;
    b.wrapperUserExists = false;
    expect(cheapTierMatches(b, root)).toBe(true);
  });

  it('round-trips read/write', () => {
    const sig = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    writeShapeSignature(root, sig);
    const back = readShapeSignature(root);
    expect(back?.entryFile?.contentHash).toBe(sig.entryFile?.contentHash);
  });

  // REGRESSION (frozen no-entry verdict): a signature persisted with
  // `entryFile: null` used to short-circuit the cheap tier forever — the
  // Ignite fixture's degraded wrapper fidelity could never heal even after
  // entry discovery learned to find its entry.
  it('cheapTierMatches returns false when a previously-null entry is now discoverable', () => {
    rmSync(resolve(root, 'src/main.tsx'));
    const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
    expect(a.entryFile).toBeNull();
    expect(cheapTierMatches(a, root)).toBe(true);
    // The entry becomes discoverable (added, or discovery improved).
    writeFileSync(resolve(root, 'src/main.tsx'), 'export default 1;\n');
    expect(cheapTierMatches(a, root)).toBe(false);
  });

  describe('appModuleFile (entry indirection target)', () => {
    function makeIgniteShape(): void {
      writeFileSync(
        resolve(root, 'package.json'),
        JSON.stringify({ name: 'test', main: 'index.tsx', dependencies: { react: '^19' } }),
      );
      writeFileSync(
        resolve(root, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./app/*'] } } }),
      );
      writeFileSync(
        resolve(root, 'index.tsx'),
        `import { registerRootComponent } from "expo"
import { App } from "@/app"
registerRootComponent(App)
`,
      );
      mkdirSync(resolve(root, 'app'), { recursive: true });
      writeFileSync(
        resolve(root, 'app/app.tsx'),
        `import { ThemeProvider } from "./theme"
import { Screen } from "./screen"
export function App() {
  return <ThemeProvider><Screen /></ThemeProvider>
}
`,
      );
    }

    it('is captured for an Ignite-shaped project and stat-drift busts the cheap tier', () => {
      makeIgniteShape();
      const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
      expect(a.entryFile?.path).toBe('index.tsx');
      expect(a.appModuleFile?.path).toBe('app/app.tsx');
      expect(cheapTierMatches(a, root)).toBe(true);
      // Editing the app module (add/remove a provider) must re-trigger the
      // authoritative tier even though index.tsx is unchanged.
      writeFileSync(
        resolve(root, 'app/app.tsx'),
        `import { Screen } from "./screen"
export function App() {
  return <Screen />
}
`,
      );
      expect(cheapTierMatches(a, root)).toBe(false);
      const b = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
      const reasons = compareShapeSignatures(a, b);
      expect(reasons.some((r) => r.field === 'appModuleFile.content')).toBe(true);
    });

    it('legacy signatures without the field miss the cheap tier once, then match', () => {
      const a = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
      expect(a.appModuleFile).toBeNull(); // direct-mount project — no indirection
      delete (a as { appModuleFile?: unknown }).appModuleFile;
      expect(cheapTierMatches(a, root)).toBe(false);
      // A recomputed signature carries the field and short-circuits again.
      const b = computeShapeSignature({ projectRoot: root, validityVersion: '0.0.1' });
      expect(cheapTierMatches(b, root)).toBe(true);
      // …and the legacy → recomputed comparison shows no appModuleFile drift
      // (absent reads as null).
      delete (a as { appModuleFile?: unknown }).appModuleFile;
      expect(compareShapeSignatures(a, b).some((r) => r.field.startsWith('appModuleFile'))).toBe(
        false,
      );
    });
  });
});
