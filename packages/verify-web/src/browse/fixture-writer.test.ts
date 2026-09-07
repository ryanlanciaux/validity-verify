/**
 * Babel-AST round-trip tests for the fixture writer.
 *
 * What we care about:
 *   - Insert into a config that already declares `components: {}` → fixture lands.
 *   - Insert into a config that has no `components` key at all → key created.
 *   - Insert into a config that uses `defineConfig({...})` (the helper exported
 *     from `@validity.ai/verify-spec`) — the AST walker needs to descend into the call
 *     argument.
 *   - Idempotency: saving the same fixture name twice updates rather than
 *     duplicates.
 *   - Quoted vs. bare keys: component path with `/` and `.` MUST be quoted;
 *     fixture name without special chars stays bare.
 *   - Sidecar fallback when there's no config file — we still capture the
 *     state under `.validity/fixtures/<slug>.json`.
 *   - AST mode preserves other top-level keys (`scenarios`, `mockNetwork`)
 *     verbatim.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteViewFromConfig, writeFixtureToConfig, writeViewToConfig } from './fixture-writer.js';

function makeProjectRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-fixture-writer-test-'));
  mkdirSync(resolve(root, '.validity'), { recursive: true });
  return root;
}

function writeConfig(projectRoot: string, source: string): string {
  const p = resolve(projectRoot, '.validity', 'config.ts');
  writeFileSync(p, source);
  return p;
}

describe('writeFixtureToConfig (AST mode)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectRoot();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('inserts a fixture into a bare object-literal config that already has components', () => {
    const cfg = writeConfig(
      projectRoot,
      `export default {
  renderMode: 'web' as const,
  framework: 'auto' as const,
  wrapper: './.validity/wrapper.gen.tsx',
  components: {
    'src/Foo.tsx': {},
  },
};
`,
    );
    const result = writeFixtureToConfig({
      projectRoot,
      componentPath: 'src/Foo.tsx',
      fixtureName: 'primary',
      props: { label: 'Hello', count: 3 },
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('ast');
    const after = readFileSync(cfg, 'utf-8');
    expect(after).toContain("'src/Foo.tsx'");
    expect(after).toMatch(
      /fixtures:\s*\{\s*primary:\s*\{\s*props:\s*\{[\s\S]*label:\s*'Hello'[\s\S]*count:\s*3/,
    );
  });

  it('creates the components key when absent', () => {
    const cfg = writeConfig(
      projectRoot,
      `export default {
  renderMode: 'web' as const,
  framework: 'auto' as const,
  wrapper: './.validity/wrapper.gen.tsx',
};
`,
    );
    const result = writeFixtureToConfig({
      projectRoot,
      componentPath: 'src/Bar.tsx',
      fixtureName: 'empty',
      props: {},
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('ast');
    const after = readFileSync(cfg, 'utf-8');
    expect(after).toContain('components:');
    expect(after).toContain("'src/Bar.tsx'");
    expect(after).toContain('fixtures:');
    expect(after).toContain('empty:');
  });

  it('handles defineConfig({...}) wrapper around the literal', () => {
    const cfg = writeConfig(
      projectRoot,
      `import { defineConfig } from '@validity.ai/verify-spec';

export default defineConfig({
  renderMode: 'web',
  framework: 'auto',
  wrapper: './.validity/wrapper.gen.tsx',
  components: {},
});
`,
    );
    const result = writeFixtureToConfig({
      projectRoot,
      componentPath: 'src/Defined.tsx',
      fixtureName: 'with-data',
      props: { items: [1, 2, 3] },
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('ast');
    const after = readFileSync(cfg, 'utf-8');
    expect(after).toContain('defineConfig(');
    expect(after).toContain('with-data');
    expect(after).toMatch(/items:\s*\[\s*1,\s*2,\s*3\s*\]/);
  });

  it('is idempotent: re-saving the same fixture name overwrites instead of duplicating', () => {
    const cfg = writeConfig(
      projectRoot,
      `export default {
  renderMode: 'web' as const,
  framework: 'auto' as const,
  wrapper: './.validity/wrapper.gen.tsx',
  components: {},
};
`,
    );
    writeFixtureToConfig({
      projectRoot,
      componentPath: 'src/Foo.tsx',
      fixtureName: 'one',
      props: { v: 1 },
    });
    writeFixtureToConfig({
      projectRoot,
      componentPath: 'src/Foo.tsx',
      fixtureName: 'one',
      props: { v: 2 },
    });
    const after = readFileSync(cfg, 'utf-8');
    // Only one `one:` key under fixtures.
    const occurrences = after.match(/\bone:\s*\{/g) ?? [];
    expect(occurrences.length).toBe(1);
    expect(after).toContain('v: 2');
    expect(after).not.toContain('v: 1');
  });

  it('preserves other top-level keys', () => {
    const cfg = writeConfig(
      projectRoot,
      `export default {
  renderMode: 'web' as const,
  framework: 'auto' as const,
  wrapper: './.validity/wrapper.gen.tsx',
  mockNetwork: {
    fallback: 'permissive' as const,
    handlers: [{ url: '/api/me', json: { id: '1' } }],
  },
  scenarios: {
    'logged-in': { mockNetwork: { cookies: { session: 'mock' } } },
  },
  components: {},
};
`,
    );
    const result = writeFixtureToConfig({
      projectRoot,
      componentPath: 'src/Profile.tsx',
      fixtureName: 'default',
      props: {},
    });
    expect(result.ok).toBe(true);
    const after = readFileSync(cfg, 'utf-8');
    // The scenarios + mockNetwork keys are still present.
    expect(after).toContain("'logged-in'");
    expect(after).toContain("'/api/me'");
    expect(after).toContain('session:');
  });

  it('quotes component paths with slashes (would otherwise be invalid ident keys)', () => {
    writeConfig(
      projectRoot,
      `export default {
  renderMode: 'web' as const,
  framework: 'auto' as const,
  wrapper: './.validity/wrapper.gen.tsx',
};
`,
    );
    writeFixtureToConfig({
      projectRoot,
      componentPath: 'src/components/Header.tsx',
      fixtureName: 'mounted',
      props: {},
    });
    const after = readFileSync(resolve(projectRoot, '.validity', 'config.ts'), 'utf-8');
    expect(after).toContain("'src/components/Header.tsx'");
  });
});

describe('writeFixtureToConfig (sidecar fallback)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectRoot();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes a sidecar JSON when there is no config file', () => {
    const result = writeFixtureToConfig({
      projectRoot,
      componentPath: 'src/Foo.tsx',
      fixtureName: 'sidecar',
      props: { x: 1 },
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('sidecar');
    expect(result.writtenTo).toBeTruthy();
    expect(existsSync(result.writtenTo!)).toBe(true);
    const body = JSON.parse(readFileSync(result.writtenTo!, 'utf-8')) as {
      componentPath: string;
      fixtureName: string;
      props: Record<string, unknown>;
    };
    expect(body.componentPath).toBe('src/Foo.tsx');
    expect(body.fixtureName).toBe('sidecar');
    expect(body.props).toEqual({ x: 1 });
  });

  it("falls back to sidecar when the config is something we can't mutate (function-based)", () => {
    writeConfig(
      projectRoot,
      `// Function-style config — we don't try to mutate this safely.
const make = () => ({ renderMode: 'web' as const, framework: 'auto' as const, wrapper: 'x' });
export default make();
`,
    );
    const result = writeFixtureToConfig({
      projectRoot,
      componentPath: 'src/Foo.tsx',
      fixtureName: 'name',
      props: {},
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('sidecar');
  });
});

describe('writeViewToConfig + deleteViewFromConfig (AST mode)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeProjectRoot();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('inserts a view into a bare object-literal config without a views key', () => {
    const cfgPath = writeConfig(
      projectRoot,
      `export default {
  renderMode: 'web' as const,
  framework: 'auto' as const,
  wrapper: './.validity/wrapper.gen.tsx',
};
`,
    );
    const result = writeViewToConfig({
      projectRoot,
      name: 'text-sizes',
      view: {
        title: 'Text Sizes',
        layout: 'stack',
        items: [
          { componentPath: 'src/Text.tsx', props: { size: 'sm' } },
          { componentPath: 'src/Text.tsx', props: { size: 'md' }, label: 'Medium' },
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('ast');
    const after = readFileSync(cfgPath, 'utf-8');
    expect(after).toMatch(/views:\s*\{/);
    // String keys preserve view name (the writer uses bare identifier for
    // simple names and quoted for everything else).
    expect(after).toMatch(/['"]text-sizes['"]:\s*\{/);
    expect(after).toMatch(/title:\s*'Text Sizes'/);
    expect(after).toMatch(/layout:\s*'stack'/);
    expect(after).toMatch(/componentPath:\s*'src\/Text\.tsx'/);
    expect(after).toMatch(/size:\s*'sm'/);
    expect(after).toMatch(/label:\s*'Medium'/);
  });

  it('overwrites an existing view of the same name (idempotency)', () => {
    const cfgPath = writeConfig(
      projectRoot,
      `export default {
  renderMode: 'web' as const,
  framework: 'auto' as const,
  wrapper: 'w',
  views: {
    overview: { items: [{ componentPath: 'src/Old.tsx' }] },
  },
};
`,
    );
    const result = writeViewToConfig({
      projectRoot,
      name: 'overview',
      view: { items: [{ componentPath: 'src/New.tsx' }] },
    });
    expect(result.ok).toBe(true);
    const after = readFileSync(cfgPath, 'utf-8');
    // The previous entry is gone; the new one is in.
    expect(after).not.toContain('src/Old.tsx');
    expect(after).toMatch(/componentPath:\s*'src\/New\.tsx'/);
    // Only one `overview` key remains (no duplication).
    expect(after.match(/overview:/g)?.length).toBe(1);
  });

  it('descends into defineConfig({...}) just like the fixture writer', () => {
    const cfgPath = writeConfig(
      projectRoot,
      `import { defineConfig } from '@validity.ai/verify-spec';
export default defineConfig({
  renderMode: 'web',
  framework: 'auto',
  wrapper: 'w',
});
`,
    );
    const result = writeViewToConfig({
      projectRoot,
      name: 'hi',
      view: { items: [{ componentPath: 'src/A.tsx' }] },
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('ast');
    const after = readFileSync(cfgPath, 'utf-8');
    expect(after).toMatch(/views:\s*\{/);
    expect(after).toMatch(/componentPath:\s*'src\/A\.tsx'/);
  });

  it('quotes view names that are not valid identifiers (with spaces or hyphens at start)', () => {
    const cfgPath = writeConfig(
      projectRoot,
      `export default { renderMode: 'web' as const, framework: 'auto' as const, wrapper: 'w' };\n`,
    );
    const result = writeViewToConfig({
      projectRoot,
      name: 'Hero Section',
      view: { items: [{ componentPath: 'src/Hero.tsx' }] },
    });
    expect(result.ok).toBe(true);
    const after = readFileSync(cfgPath, 'utf-8');
    // 'Hero Section' has a space — must be quoted.
    expect(after).toMatch(/['"]Hero Section['"]:\s*\{/);
  });

  it('preserves other top-level keys verbatim when inserting views', () => {
    const cfgPath = writeConfig(
      projectRoot,
      `export default {
  renderMode: 'web' as const,
  framework: 'auto' as const,
  wrapper: 'w',
  scenarios: { 'logged-in': { description: 'auth seeded' } },
  components: { 'src/Foo.tsx': {} },
};
`,
    );
    writeViewToConfig({
      projectRoot,
      name: 'overview',
      view: { items: [{ componentPath: 'src/Foo.tsx' }] },
    });
    const after = readFileSync(cfgPath, 'utf-8');
    expect(after).toContain('logged-in');
    expect(after).toContain('auth seeded');
    expect(after).toMatch(/components:\s*\{[\s\S]*src\/Foo\.tsx/);
  });

  it('deletes a view by name and leaves the rest intact', () => {
    const cfgPath = writeConfig(
      projectRoot,
      `export default {
  renderMode: 'web' as const,
  framework: 'auto' as const,
  wrapper: 'w',
  views: {
    keepme: { items: [{ componentPath: 'src/A.tsx' }] },
    drop: { items: [{ componentPath: 'src/B.tsx' }] },
  },
};
`,
    );
    const result = deleteViewFromConfig({ projectRoot, name: 'drop' });
    expect(result.ok).toBe(true);
    const after = readFileSync(cfgPath, 'utf-8');
    expect(after).toContain('keepme');
    expect(after).not.toMatch(/\bdrop\b:/);
    expect(after).toContain('src/A.tsx');
    expect(after).not.toContain('src/B.tsx');
  });

  it('delete is idempotent — no-op when the view is absent', () => {
    const cfgPath = writeConfig(
      projectRoot,
      `export default {
  renderMode: 'web' as const,
  framework: 'auto' as const,
  wrapper: 'w',
  views: { other: { items: [{ componentPath: 'src/A.tsx' }] } },
};
`,
    );
    const before = readFileSync(cfgPath, 'utf-8');
    const result = deleteViewFromConfig({ projectRoot, name: 'not-there' });
    expect(result.ok).toBe(true);
    const after = readFileSync(cfgPath, 'utf-8');
    // No rewrite because the name wasn't present.
    expect(after).toBe(before);
  });

  it('delete is idempotent — succeeds when there is no views block at all', () => {
    writeConfig(
      projectRoot,
      `export default { renderMode: 'web' as const, framework: 'auto' as const, wrapper: 'w' };\n`,
    );
    const result = deleteViewFromConfig({ projectRoot, name: 'whatever' });
    expect(result.ok).toBe(true);
  });

  it('falls back to sidecar when there is no config file', () => {
    // No config written — writer punts to .validity/views/<slug>.json.
    const result = writeViewToConfig({
      projectRoot,
      name: 'fallback view',
      view: { items: [{ componentPath: 'src/Z.tsx' }] },
    });
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('sidecar');
    expect(result.writtenTo).toBeTruthy();
    expect(existsSync(result.writtenTo!)).toBe(true);
    const body = JSON.parse(readFileSync(result.writtenTo!, 'utf-8')) as {
      name: string;
      items: Array<{ componentPath: string }>;
    };
    expect(body.name).toBe('fallback view');
    expect(body.items[0]?.componentPath).toBe('src/Z.tsx');
    // Slug should be filesystem-safe (lowercase, no spaces).
    expect(result.writtenTo).toMatch(/fallback-view\.json$/);
  });
});
