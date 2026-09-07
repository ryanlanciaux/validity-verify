import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_MANIFEST_RELATIVE_PATH,
  appManifestEntryFile,
  describeAppManifest,
  readAppManifest,
} from './app-manifest.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-app-manifest-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = resolve(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

/** A complete, valid v1 manifest for `root`. */
function validManifest(root: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    generator: { name: '@validity.ai/verify-plugin-vite', version: '0.0.1' },
    framework: 'vite',
    root,
    entry: { html: 'index.html', module: 'src/main.tsx' },
    env: { dir: root, prefixes: ['VITE_'], exposedKeyCount: 2 },
    css: {
      tailwind: { detected: true, via: 'postcss', major: 3 },
      postcssPlugins: ['tailwindcss'],
      postcssConfigPath: `${root}/postcss.config.js`,
      entryCss: ['src/index.css'],
    },
    aliases: [{ find: '@', replacement: `${root}/src` }],
    aliasesOmitted: [{ find: '/^~/', reason: 'regexp-find' }],
    plugins: ['vite-plugin-svgr'],
    ...overrides,
  };
}

function write(root: string, value: unknown): void {
  const abs = resolve(root, APP_MANIFEST_RELATIVE_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf-8');
}

describe('readAppManifest', () => {
  it('reads a complete v1 manifest', () => {
    const root = project();
    write(root, validManifest(root));
    const read = readAppManifest(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.manifest.env.dir).toBe(root.replaceAll('\\', '/'));
    expect(read.manifest.css.tailwind).toEqual({ detected: true, via: 'postcss', major: 3 });
    expect(read.manifest.aliases).toEqual([{ find: '@', replacement: `${root}/src` }]);
    expect(read.manifest.plugins).toEqual(['vite-plugin-svgr']);
  });

  it('tolerates unknown fields — the writer may be newer than this reader', () => {
    const root = project();
    write(root, {
      ...validManifest(root),
      somethingFromTheFuture: { nested: true },
      env: { dir: root, prefixes: ['VITE_'], exposedKeyCount: 2, futureField: 7 },
    });
    const read = readAppManifest(root);
    expect(read.ok).toBe(true);
  });

  it('refuses a schemaVersion it does not know rather than guessing', () => {
    const root = project();
    write(root, validManifest(root, { schemaVersion: 2 }));
    expect(readAppManifest(root)).toMatchObject({ ok: false, reason: 'unsupported-version' });
  });

  it('names each failure mode instead of degrading silently', () => {
    const absent = project();
    expect(readAppManifest(absent)).toMatchObject({ ok: false, reason: 'absent' });

    const broken = project();
    write(broken, '{ not json');
    expect(readAppManifest(broken)).toMatchObject({ ok: false, reason: 'malformed-json' });

    const arrayRoot = project();
    write(arrayRoot, [1, 2, 3]);
    expect(readAppManifest(arrayRoot)).toMatchObject({ ok: false, reason: 'not-an-object' });
  });

  it("refuses a manifest whose root is outside the project — a stale sibling's copy", () => {
    const root = project();
    write(root, validManifest('/somewhere/else/app'));
    expect(readAppManifest(root)).toMatchObject({ ok: false, reason: 'root-outside-project' });
  });

  it('drops individual malformed fields while keeping the rest of the manifest', () => {
    const root = project();
    write(root, {
      ...validManifest(root),
      aliases: [
        { find: '@ok', replacement: `${root}/src` },
        { find: 42, replacement: 'nope' },
        { replacement: 'no find' },
        'not an object',
      ],
      plugins: ['good', 7, null],
      env: { dir: root, prefixes: 'not-an-array', exposedKeyCount: 'lots' },
      css: { tailwind: { detected: 'yes', via: 'carrier-pigeon', major: 9 } },
    });
    const read = readAppManifest(root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.manifest.aliases).toEqual([{ find: '@ok', replacement: `${root}/src` }]);
    expect(read.manifest.plugins).toEqual(['good']);
    expect(read.manifest.env.prefixes).toEqual(['VITE_']);
    expect(read.manifest.env.exposedKeyCount).toBe(0);
    // A non-boolean `detected` and an unrecognized `via`/`major` all normalize
    // to "we don't know", never to an invented positive.
    expect(read.manifest.css.tailwind).toEqual({ detected: false, via: null, major: null });
  });
});

describe('appManifestEntryFile', () => {
  it('returns the authoritative entry when the file exists', () => {
    const root = project({ 'src/bootstrap/client.tsx': 'export const x = 1;' });
    write(
      root,
      validManifest(root, { entry: { html: 'index.html', module: 'src/bootstrap/client.tsx' } }),
    );
    expect(appManifestEntryFile(root)).toBe('src/bootstrap/client.tsx');
  });

  it('refuses a STALE entry — a path recorded before a rename is worse than none', () => {
    const root = project();
    write(
      root,
      validManifest(root, { entry: { html: 'index.html', module: 'src/renamed-away.tsx' } }),
    );
    expect(appManifestEntryFile(root)).toBeUndefined();
  });

  it('refuses an entry that escapes the project root', () => {
    const root = project();
    write(root, validManifest(root, { entry: { html: null, module: '../../etc/passwd' } }));
    expect(appManifestEntryFile(root)).toBeUndefined();
  });

  it('is undefined when there is no manifest at all', () => {
    expect(appManifestEntryFile(project())).toBeUndefined();
  });
});

describe('describeAppManifest', () => {
  it('separates what was mirrored from what was only recorded', () => {
    const root = project();
    write(root, validManifest(root));
    const line = describeAppManifest(readAppManifest(root), ['envDir (2 client vars)']);
    expect(line).toContain('app manifest present (v1, @validity.ai/verify-plugin-vite@0.0.1)');
    expect(line).toContain('mirrored: envDir (2 client vars)');
    expect(line).toContain('recorded: plugins (1), tailwind v3 via postcss');
    expect(line).toContain('unmirrored aliases (1)');
  });

  it('says "nothing" rather than implying a mirror that did not happen', () => {
    const root = project();
    write(
      root,
      validManifest(root, {
        plugins: [],
        aliasesOmitted: [],
        css: {
          tailwind: { detected: false, via: null, major: null },
          postcssPlugins: [],
          postcssConfigPath: null,
          entryCss: [],
        },
        env: { dir: root, prefixes: ['VITE_'], exposedKeyCount: 0 },
      }),
    );
    const line = describeAppManifest(readAppManifest(root), []);
    expect(line).toContain('mirrored: nothing');
    expect(line).toContain('recorded: nothing');
  });

  it('reports the rejection reason for an unusable manifest', () => {
    expect(describeAppManifest({ ok: false, reason: 'absent', path: '/x' }, [])).toBe(
      'app manifest absent',
    );
  });
});
