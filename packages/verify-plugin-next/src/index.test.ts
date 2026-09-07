import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import withValidityDefault, {
  APP_MANIFEST_RELATIVE_PATH,
  NEXT_PHASE,
  isValidityManagedRoot,
  resolveAppRoot,
  resolveValidityRoot,
  shouldWriteManifest,
  withValidity,
  writeManifestIfChanged,
  type AppManifest,
} from './index.js';
import { buildAppManifest } from './build-manifest.js';

/**
 * The wrapper's contract has two halves and both are tested here: the config
 * that comes back must be indistinguishable from the config that went in, and
 * the manifest must appear only when it is supposed to.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write a minimal but realistic Next app into a fresh temp dir. */
function scaffoldApp(files: Record<string, string> = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-plugin-next-'));
  tempDirs.push(root);
  const defaults: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'fixture-app',
      dependencies: { next: '15.0.0', react: '19.0.0' },
    }),
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
    }),
    '.env':
      'NEXT_PUBLIC_API_URL=https://api.example.com\nSTRIPE_SECRET_KEY=not-a-real-credential\n',
  };
  for (const [rel, content] of Object.entries({ ...defaults, ...files })) {
    const abs = resolve(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

function manifestPath(root: string): string {
  return resolve(root, APP_MANIFEST_RELATIVE_PATH);
}

function readManifest(root: string): AppManifest {
  return JSON.parse(readFileSync(manifestPath(root), 'utf-8')) as AppManifest;
}

/** Run `fn` with env overrides, restoring the previous values afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('withValidity — the config it returns', () => {
  it('returns the very same object, untouched', () => {
    const root = scaffoldApp();
    const config = { reactStrictMode: true, images: { domains: ['example.com'] } };
    const before = JSON.parse(JSON.stringify(config)) as typeof config;

    const returned = withValidity(config, { appDir: root });

    // Identity, not equivalence: no clone, no merge, no added key. A Next
    // config that behaves differently because Validity is installed would
    // invalidate every verify run performed against it.
    expect(returned).toBe(config);
    expect(returned).toEqual(before);
    expect(Object.keys(returned)).toEqual(['reactStrictMode', 'images']);
  });

  it('wraps the function form without changing what Next receives', () => {
    const root = scaffoldApp();
    const produced = { reactStrictMode: true };
    const userFn = vi.fn(() => produced);

    const wrapped = withValidity(userFn, { appDir: root });
    expect(typeof wrapped).toBe('function');

    const context = { defaultConfig: { poweredByHeader: true } };
    const result = (wrapped as (p: string, c: unknown) => unknown)(
      NEXT_PHASE.developmentServer,
      context,
    );

    expect(result).toBe(produced);
    expect(userFn).toHaveBeenCalledTimes(1);
    expect(userFn).toHaveBeenCalledWith(NEXT_PHASE.developmentServer, context);
  });

  it("lets the user's own config function throw, and writes nothing when it does", () => {
    const root = scaffoldApp();
    const wrapped = withValidity(
      () => {
        throw new Error('boom from the user config');
      },
      { appDir: root },
    );
    expect(() => (wrapped as (p: string) => unknown)(NEXT_PHASE.developmentServer)).toThrow(
      'boom from the user config',
    );
    expect(existsSync(manifestPath(root))).toBe(false);
  });

  it('is exported both as default and by name', () => {
    expect(withValidityDefault).toBe(withValidity);
  });
});

describe('withValidity — the manifest it writes', () => {
  it('records the facts the sandbox cannot re-derive, and no secrets', () => {
    const root = scaffoldApp({ 'postcss.config.mjs': 'export default { plugins: {} };\n' });
    withValidity({}, { appDir: root });

    const m = readManifest(root);
    expect(m.schemaVersion).toBe(1);
    expect(m.generator.name).toBe('@validity.ai/verify-plugin-next');
    expect(m.framework).toBe('next');
    expect(m.root).toBe(root.replaceAll('\\', '/'));

    // 1. env dir + prefix — the fields that make NEXT_PUBLIC_* non-empty in a
    //    re-rooted sandbox. One public var in the fixture .env.
    expect(m.env.dir).toBe(root.replaceAll('\\', '/'));
    expect(m.env.prefixes).toEqual(['NEXT_PUBLIC_']);
    expect(m.env.exposedKeyCount).toBe(1);

    // 2. Neither a value nor a key name may reach a committable file by default.
    const raw = readFileSync(manifestPath(root), 'utf-8');
    expect(raw).not.toContain('not-a-real-credential');
    expect(raw).not.toContain('api.example.com');
    expect(raw).not.toContain('NEXT_PUBLIC_API_URL');
    expect(raw).not.toContain('STRIPE_SECRET_KEY');

    // 3. tsconfig paths, absolutized here because only this side knows the root.
    expect(m.aliases).toEqual([{ find: '@', replacement: `${root.replaceAll('\\', '/')}/src` }]);

    // 4. The honest nulls/empties — Next has no entry pair and no plugin list.
    expect(m.entry).toEqual({ html: null, module: null });
    expect(m.plugins).toEqual([]);
    expect(m.css.postcssConfigPath).toBe(`${root.replaceAll('\\', '/')}/postcss.config.mjs`);
  });

  it('records key names only under includeEnvKeys, and still never values', () => {
    const root = scaffoldApp();
    withValidity({}, { appDir: root, includeEnvKeys: true });
    expect(readManifest(root).env.exposedKeys).toEqual(['NEXT_PUBLIC_API_URL']);
    expect(readFileSync(manifestPath(root), 'utf-8')).not.toContain('api.example.com');
  });

  it('is byte-identical across repeated evaluations of the same config', () => {
    const root = scaffoldApp();
    withValidity({}, { appDir: root });
    const first = readFileSync(manifestPath(root), 'utf-8');
    withValidity({}, { appDir: root });
    expect(readFileSync(manifestPath(root), 'utf-8')).toBe(first);
  });

  it('does not touch the file when nothing changed (no dev-server churn)', () => {
    const root = scaffoldApp();
    withValidity({}, { appDir: root });
    const manifest = buildAppManifest(root, {
      generatorName: '@validity.ai/verify-plugin-next',
      generatorVersion: readManifest(root).generator.version,
    });
    // The guard is what makes writing on every config evaluation safe: `next
    // dev` re-evaluates next.config on every edit to it.
    expect(writeManifestIfChanged(manifestPath(root), manifest).outcome).toBe('unchanged');
  });

  it('rewrites when a fact actually changes', () => {
    const root = scaffoldApp({ 'tsconfig.json': JSON.stringify({ compilerOptions: {} }) });
    withValidity({}, { appDir: root });
    expect(readManifest(root).aliases).toEqual([]);

    writeFileSync(
      resolve(root, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '~/*': ['./lib/*'] } } }),
      'utf-8',
    );
    withValidity({}, { appDir: root });
    expect(readManifest(root).aliases).toEqual([
      { find: '~', replacement: `${root.replaceAll('\\', '/')}/lib` },
    ]);
  });

  it('writes to the directory that owns .validity, keeping root as the app dir', () => {
    const repo = scaffoldApp();
    mkdirSync(resolve(repo, '.validity'), { recursive: true });
    const app = resolve(repo, 'apps/web');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      resolve(app, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'utf-8',
    );

    withValidity({}, { appDir: app });

    expect(existsSync(manifestPath(repo))).toBe(true);
    expect(existsSync(manifestPath(app))).toBe(false);
    expect(readManifest(repo).root).toBe(app.replaceAll('\\', '/'));
  });

  it('never breaks the config when the manifest cannot be written', () => {
    const root = scaffoldApp();
    // A FILE named `.validity` makes the mkdir fail. The wrapper must warn and
    // return the config anyway — Validity is never allowed to be the reason
    // `next dev` won't start.
    writeFileSync(resolve(root, '.validity'), 'not a directory', 'utf-8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = { reactStrictMode: true };

    expect(withValidity(config, { appDir: root })).toBe(config);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[validity] could not write');
  });

  it('enabled:false is a complete no-op', () => {
    const root = scaffoldApp();
    withValidity({}, { appDir: root, enabled: false });
    expect(existsSync(manifestPath(root))).toBe(false);
  });
});

describe('write gating', () => {
  it("writes on next dev and skips next build by default ('dev')", () => {
    expect(shouldWriteManifest('dev', NEXT_PHASE.developmentServer)).toBe(true);
    expect(shouldWriteManifest('dev', NEXT_PHASE.productionBuild)).toBe(false);
    expect(shouldWriteManifest('dev', NEXT_PHASE.export)).toBe(false);
  });

  it("inverts under 'build'", () => {
    expect(shouldWriteManifest('build', NEXT_PHASE.developmentServer)).toBe(false);
    expect(shouldWriteManifest('build', NEXT_PHASE.productionBuild)).toBe(true);
    expect(shouldWriteManifest('build', NEXT_PHASE.export)).toBe(true);
  });

  it("covers both commands under 'both'", () => {
    expect(shouldWriteManifest('both', NEXT_PHASE.developmentServer)).toBe(true);
    expect(shouldWriteManifest('both', NEXT_PHASE.productionBuild)).toBe(true);
  });

  it('never writes during next start, next info or a next/jest run', () => {
    for (const apply of ['dev', 'build', 'both'] as const) {
      expect(shouldWriteManifest(apply, NEXT_PHASE.productionServer)).toBe(false);
      expect(shouldWriteManifest(apply, NEXT_PHASE.info)).toBe(false);
      expect(shouldWriteManifest(apply, NEXT_PHASE.test)).toBe(false);
    }
  });

  it('falls back to NODE_ENV when there is no phase (the object config form)', () => {
    withEnv({ NODE_ENV: 'development' }, () => {
      expect(shouldWriteManifest('dev', undefined)).toBe(true);
      expect(shouldWriteManifest('build', undefined)).toBe(false);
    });
    withEnv({ NODE_ENV: 'production' }, () => {
      expect(shouldWriteManifest('dev', undefined)).toBe(false);
      expect(shouldWriteManifest('build', undefined)).toBe(true);
      expect(shouldWriteManifest('both', undefined)).toBe(true);
    });
  });

  it('degrades to the NODE_ENV fallback for a phase it does not recognize', () => {
    // A future Next phase must not silently disable the write.
    withEnv({ NODE_ENV: 'development' }, () => {
      expect(shouldWriteManifest('dev', 'phase-something-new')).toBe(true);
    });
  });

  it('applies the gate end to end through the function form', () => {
    const root = scaffoldApp();
    const wrapped = withValidity(() => ({}), { appDir: root });
    (wrapped as (p: string) => unknown)(NEXT_PHASE.productionBuild);
    expect(existsSync(manifestPath(root))).toBe(false);

    (wrapped as (p: string) => unknown)(NEXT_PHASE.developmentServer);
    expect(existsSync(manifestPath(root))).toBe(true);
  });

  it("opts a build-only repo in with apply:'build'", () => {
    const root = scaffoldApp();
    const wrapped = withValidity(() => ({}), { appDir: root, apply: 'build' });
    (wrapped as (p: string) => unknown)(NEXT_PHASE.productionBuild);
    expect(readManifest(root).framework).toBe('next');
  });

  it('leaves a production build clean when the object form is used', () => {
    const root = scaffoldApp();
    withEnv({ NODE_ENV: 'production' }, () => withValidity({}, { appDir: root }));
    expect(existsSync(manifestPath(root))).toBe(false);
  });
});

describe('sandbox guard', () => {
  it("writes nothing when running inside Validity's own sandbox", () => {
    const root = scaffoldApp();
    withEnv({ VALIDITY_SANDBOX: '1' }, () => {
      const config = { reactStrictMode: true };
      expect(withValidity(config, { appDir: root })).toBe(config);
    });
    expect(existsSync(manifestPath(root))).toBe(false);
  });

  it('also recognizes a root inside node_modules/.validity', () => {
    expect(isValidityManagedRoot('/app/node_modules/.validity/sandbox')).toBe(true);
    expect(isValidityManagedRoot('/app')).toBe(false);
  });
});

describe('root resolution', () => {
  it('defaults the app root to the process cwd', () => {
    expect(resolveAppRoot()).toBe(process.cwd().replaceAll('\\', '/'));
    expect(resolveAppRoot('/tmp/somewhere')).toBe('/tmp/somewhere');
  });

  it('walks up to an existing .validity directory', () => {
    const repo = scaffoldApp();
    mkdirSync(resolve(repo, '.validity'), { recursive: true });
    const app = resolve(repo, 'apps/web');
    mkdirSync(app, { recursive: true });
    expect(resolveValidityRoot(app)).toBe(repo.replaceAll('\\', '/'));
  });

  it('falls back to the app root on a first run', () => {
    const repo = scaffoldApp();
    expect(resolveValidityRoot(repo)).toBe(repo.replaceAll('\\', '/'));
  });
});
