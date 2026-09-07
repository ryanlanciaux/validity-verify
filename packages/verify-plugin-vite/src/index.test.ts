import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build, createServer } from 'vite';
import validity, {
  APP_MANIFEST_RELATIVE_PATH,
  isValidityManagedConfig,
  resolveValidityRoot,
  writeManifestIfChanged,
  type AppManifest,
} from './index.js';

/**
 * These tests drive the plugin through the REAL Vite pipeline (`createServer`
 * / `build` with an inline config) rather than hand-calling `configResolved`.
 * The manifest's whole premise is that it records what Vite actually resolved,
 * so a fixture-only test would validate the wrong thing: it would prove the
 * builder is self-consistent while saying nothing about whether Vite's
 * resolved shape is what we think it is.
 */

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write a minimal but real Vite app into a fresh temp dir. */
function scaffoldApp(files: Record<string, string> = {}): string {
  // Vite resolves entry symlinks; its root must match (macOS /var → /private/var).
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-plugin-vite-')));
  tempDirs.push(root);
  const defaults: Record<string, string> = {
    'index.html':
      '<!doctype html><html><head><link rel="stylesheet" href="/styles/reset.css"></head>' +
      '<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    'src/main.tsx': "import './index.css';\nexport const boot = () => null;\n",
    'src/index.css': 'body { margin: 0 }',
    'styles/reset.css': '*{box-sizing:border-box}',
    '.env': 'VITE_API_URL=https://api.example.com\nSECRET_TOKEN=nope\n',
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

/** Boot a dev server just far enough to trigger `configResolved`, then close it. */
async function resolveViaServe(
  root: string,
  plugins: unknown[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    // Never listen — `configResolved` fires during createServer, so binding a
    // port would only add flake.
    plugins: plugins as never,
    ...extra,
  });
  await server.close();
}

describe('validity() against a real resolved Vite config', () => {
  it('writes a manifest carrying the facts the sandbox cannot re-derive', async () => {
    const root = scaffoldApp();
    await resolveViaServe(root, [validity()], {
      resolve: { alias: { '@': './src' } },
    });

    const m = readManifest(root);
    expect(m.schemaVersion).toBe(1);
    expect(m.generator.name).toBe('@validity.ai/verify-plugin-vite');
    expect(m.framework).toBe('vite');
    expect(m.root).toBe(root.replaceAll('\\', '/'));

    // 1. The entry pair, read from index.html rather than guessed.
    expect(m.entry).toEqual({ html: 'index.html', module: 'src/main.tsx' });

    // 2. envDir — the field that makes import.meta.env.VITE_* non-empty in the
    //    sandbox. Vite exposed exactly one prefixed var from the fixture .env.
    expect(m.env.dir).toBe(root.replaceAll('\\', '/'));
    expect(m.env.prefixes).toEqual(['VITE_']);
    expect(m.env.exposedKeyCount).toBe(1);
    // 3. No secret, and no key name, may reach a committable file by default.
    const raw = readFileSync(manifestPath(root), 'utf-8');
    expect(raw).not.toContain('SECRET_TOKEN');
    expect(raw).not.toContain('api.example.com');
    expect(raw).not.toContain('VITE_API_URL');

    // 4. Entry CSS, from the html link and the entry module's import.
    expect(m.css.entryCss).toEqual(['styles/reset.css', 'src/index.css']);

    // 5. The user alias survives; Vite's own client aliases are recorded as
    //    omitted rather than mirrored into the sandbox.
    expect(m.aliases).toContainEqual({
      find: '@',
      replacement: `${root.replaceAll('\\', '/')}/src`,
    });
    expect(m.aliases.some((a) => a.find.includes('@vite/'))).toBe(false);
    expect(
      m.aliasesOmitted.every((o) => o.reason === 'vite-internal' || o.reason === 'regexp-find'),
    ).toBe(true);
  });

  it('records key names only when includeEnvKeys is set, and still never values', async () => {
    const root = scaffoldApp();
    await resolveViaServe(root, [validity({ includeEnvKeys: true })]);
    const m = readManifest(root);
    expect(m.env.exposedKeys).toEqual(['VITE_API_URL']);
    expect(readFileSync(manifestPath(root), 'utf-8')).not.toContain('api.example.com');
  });

  it('names user plugins in pipeline order and omits Vite internals', async () => {
    const root = scaffoldApp();
    await resolveViaServe(root, [
      { name: 'my-first-plugin' },
      validity(),
      { name: 'my-second-plugin' },
    ]);
    const m = readManifest(root);
    expect(m.plugins).toEqual(['my-first-plugin', 'validity:app-manifest', 'my-second-plugin']);
    expect(m.plugins.some((n) => n.startsWith('vite:'))).toBe(false);
  });

  it('labels a TanStack Start pipeline from the names Vite really resolved', async () => {
    const root = scaffoldApp();
    // Stand-ins named exactly as the real Start plugins name themselves (see
    // detectFramework's observed-name comment). Running them through the real
    // pipeline is the point: it proves the names survive `userPluginNames`'
    // internal-plugin filter rather than only satisfying a hand-built fixture.
    await resolveViaServe(root, [
      { name: 'tanstack-start-core:config' },
      { name: 'tanstack:router-generator' },
      validity(),
      { name: 'tanstack-react-start:config' },
    ]);
    const m = readManifest(root);
    expect(m.framework).toBe('tanstack-start');
    expect(m.plugins).toContain('tanstack-start-core:config');
  });

  it('leaves a TanStack Router SPA labelled vite', async () => {
    const root = scaffoldApp();
    await resolveViaServe(root, [
      { name: 'tanstack:router-generator' },
      { name: 'tanstack-router:code-splitter:compile-reference-file' },
      validity(),
    ]);
    expect(readManifest(root).framework).toBe('vite');
  });

  it('is byte-identical across repeated resolves of the same config', async () => {
    const root = scaffoldApp();
    await resolveViaServe(root, [validity()]);
    const first = readFileSync(manifestPath(root), 'utf-8');
    await resolveViaServe(root, [validity()]);
    const second = readFileSync(manifestPath(root), 'utf-8');
    expect(second).toBe(first);
  });

  it('does not touch the file when nothing changed (no watch churn)', async () => {
    const root = scaffoldApp();
    await resolveViaServe(root, [validity()]);
    const before = readFileSync(manifestPath(root), 'utf-8');

    // A sentinel proves the guard skipped the write rather than rewriting the
    // same bytes: an mtime comparison would be too coarse to trust here.
    const sentinel = `${before}`;
    writeFileSync(manifestPath(root), sentinel, 'utf-8');
    const res = writeManifestIfChanged(manifestPath(root), JSON.parse(before) as AppManifest);
    expect(res.outcome).toBe('unchanged');
  });

  it('rewrites when a fact actually changes', async () => {
    const root = scaffoldApp();
    await resolveViaServe(root, [validity()]);
    const before = readManifest(root);
    expect(before.aliases.some((a) => a.find === '@')).toBe(false);

    await resolveViaServe(root, [validity()], { resolve: { alias: { '@': './src' } } });
    const after = readManifest(root);
    expect(after.aliases).toContainEqual({
      find: '@',
      replacement: `${root.replaceAll('\\', '/')}/src`,
    });
  });

  it('defaults to serve-only: a production build writes nothing at all', async () => {
    const root = scaffoldApp();
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [validity()] as never,
      build: { write: false },
    });
    expect(existsSync(manifestPath(root))).toBe(false);
  });

  it("apply:'build' opts a build-only repo in", async () => {
    const root = scaffoldApp();
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [validity({ apply: 'build' })] as never,
      build: { write: false },
    });
    expect(existsSync(manifestPath(root))).toBe(true);
    expect(readManifest(root).entry.module).toBe('src/main.tsx');
  });

  it('enabled:false is a complete no-op', async () => {
    const root = scaffoldApp();
    await resolveViaServe(root, [validity({ enabled: false })]);
    expect(existsSync(manifestPath(root))).toBe(false);
  });

  it('honors an explicit projectRoot so a monorepo app can write to the repo root', async () => {
    const repo = scaffoldApp();
    const app = resolve(repo, 'apps/web');
    mkdirSync(resolve(app, 'src'), { recursive: true });
    writeFileSync(resolve(app, 'index.html'), '<script type="module" src="/src/m.tsx"></script>');
    writeFileSync(resolve(app, 'src/m.tsx'), 'export const x = 1;');

    await resolveViaServe(app, [validity({ projectRoot: repo })]);
    expect(existsSync(manifestPath(repo))).toBe(true);
    expect(existsSync(manifestPath(app))).toBe(false);
    expect(readManifest(repo).root).toBe(app.replaceAll('\\', '/'));
  });

  it('never breaks the dev server when the manifest cannot be written', async () => {
    const root = scaffoldApp();
    // A FILE named `.validity` makes the mkdirSync fail — the plugin must warn
    // and continue, because a Validity integration is never allowed to be the
    // reason someone's dev server won't start.
    writeFileSync(resolve(root, '.validity'), 'not a directory', 'utf-8');
    await expect(resolveViaServe(root, [validity()])).resolves.toBeUndefined();
  });
});

describe('isValidityManagedConfig', () => {
  it("refuses to write from inside Validity's own sandbox", () => {
    // The sandbox merges the user's vite.config — including THIS plugin — into
    // its own server. Without the guard, `validity verify` would overwrite the
    // real manifest with a description of Validity's scaffolding.
    expect(isValidityManagedConfig({ root: '/app/node_modules/.validity' })).toBe(true);
    expect(
      isValidityManagedConfig({
        root: '/app',
        cacheDir: '/app/node_modules/.validity/.vite-cache',
      }),
    ).toBe(true);
    expect(isValidityManagedConfig({ root: '/app' })).toBe(false);
  });

  it('honors the VALIDITY_SANDBOX escape hatch', () => {
    const prev = process.env.VALIDITY_SANDBOX;
    process.env.VALIDITY_SANDBOX = '1';
    try {
      expect(isValidityManagedConfig({ root: '/app' })).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.VALIDITY_SANDBOX;
      else process.env.VALIDITY_SANDBOX = prev;
    }
  });
});

describe('resolveValidityRoot', () => {
  it('walks up to an existing .validity directory', () => {
    const repo = scaffoldApp();
    mkdirSync(resolve(repo, '.validity'), { recursive: true });
    const app = resolve(repo, 'apps/web');
    mkdirSync(app, { recursive: true });
    expect(resolveValidityRoot(app)).toBe(repo.replaceAll('\\', '/'));
  });

  it("falls back to Vite's root on a first run", () => {
    const repo = scaffoldApp();
    expect(resolveValidityRoot(repo)).toBe(repo.replaceAll('\\', '/'));
  });
});
