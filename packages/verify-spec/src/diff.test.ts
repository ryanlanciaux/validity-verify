import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectDiff, parseGitDiff } from './diff.js';

describe('collectDiff — secret redaction', () => {
  let root: string;
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, stdio: 'ignore' });

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-diff-'));
    git('init');
    git('config user.email t@t.co');
    git('config user.name t');
    writeFileSync(resolve(root, 'README.md'), '# base\n');
    git('add -A');
    git('commit -m base');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('redacts Git-quoted non-ASCII/control-character secrets and safely reads ordinary quoted paths', () => {
    const dirs = ['café', 'with\ttab', 'with\nnewline', 'with"quote'];
    for (const dir of dirs) {
      mkdirSync(resolve(root, dir));
      writeFileSync(resolve(root, dir, '.env'), 'TOKEN=OLD_PRIVATE_SENTINEL\n');
    }
    git('add -A');
    git('commit -m quoted-envs');
    for (const dir of dirs)
      writeFileSync(resolve(root, dir, '.env'), 'TOKEN=NEW_PRIVATE_SENTINEL\n');
    writeFileSync(resolve(root, 'café', 'visible.txt'), 'visible ordinary file');
    const { files } = collectDiff({ projectRoot: root });
    expect(JSON.stringify(files)).not.toContain('PRIVATE_SENTINEL');
    expect(files.filter((file) => file.path.endsWith('/.env'))).toHaveLength(dirs.length);
    expect(JSON.stringify(files)).toContain('visible ordinary file');
  });

  it('does not inline untracked symlinks to ignored secrets or outside files', () => {
    const outside = mkdtempSync(resolve(tmpdir(), 'validity-diff-outside-'));
    try {
      writeFileSync(resolve(root, '.gitignore'), '.env\n');
      writeFileSync(resolve(root, '.env'), 'IGNORED_PRIVATE_SENTINEL');
      writeFileSync(resolve(outside, 'ordinary.txt'), 'OUTSIDE_PRIVATE_SENTINEL');
      symlinkSync(resolve(root, '.env'), resolve(root, 'innocent.txt'));
      symlinkSync(resolve(outside, 'ordinary.txt'), resolve(root, 'outside.txt'));
      symlinkSync(outside, resolve(root, 'linked-parent'));
      expect(JSON.stringify(collectDiff({ projectRoot: root }))).not.toContain('PRIVATE_SENTINEL');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('redacts an untracked .env.local instead of inlining the secret', () => {
    writeFileSync(resolve(root, '.env.local'), 'API_KEY=super-secret-value-123\n');
    writeFileSync(resolve(root, 'ok.ts'), 'export const x = 1;\n');
    const { files } = collectDiff({ projectRoot: root });
    const env = files.find((f) => f.path === '.env.local');
    const ok = files.find((f) => f.path === 'ok.ts');
    expect(env).toBeDefined();
    // The secret value must NOT appear anywhere in the collected diff.
    expect(JSON.stringify(files)).not.toContain('super-secret-value-123');
    expect(env!.hunks[0].header).toMatch(/redacted/i);
    // A normal untracked file is still inlined in full.
    expect(JSON.stringify(ok)).toContain('export const x = 1;');
  });

  it('redacts a TRACKED secret file that was modified', () => {
    writeFileSync(resolve(root, '.env'), 'TOKEN=old\n');
    git('add -A');
    git('commit -m add-env');
    writeFileSync(resolve(root, '.env'), 'TOKEN=new-leaked-token\n');
    const { files } = collectDiff({ projectRoot: root });
    expect(JSON.stringify(files)).not.toContain('new-leaked-token');
    const env = files.find((f) => f.path === '.env');
    expect(env?.hunks[0].header).toMatch(/redacted/i);
  });

  it('redacts *.pem and service-account json by pattern', () => {
    writeFileSync(resolve(root, 'server.pem'), '-----BEGIN PRIVATE KEY-----\nabc\n');
    writeFileSync(resolve(root, 'my-service-account.json'), '{"private_key":"leak"}\n');
    const { files } = collectDiff({ projectRoot: root });
    const dump = JSON.stringify(files);
    expect(dump).not.toContain('BEGIN PRIVATE KEY');
    expect(dump).not.toContain('leak');
    expect(files.find((f) => f.path === 'server.pem')?.hunks[0].header).toMatch(/redacted/i);
  });
});

describe('parseGitDiff', () => {
  it('returns [] for empty input', () => {
    expect(parseGitDiff('')).toEqual([]);
  });

  it('parses a single-file modification', () => {
    const blob = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index 0000000..1111111 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '+const c = 4;',
      ' const d = 5;',
    ].join('\n');

    const files = parseGitDiff(blob);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('src/foo.ts');
    expect(files[0]!.hunks).toHaveLength(1);
    const hunk = files[0]!.hunks[0]!;
    expect(hunk.header).toBe('@@ -1,3 +1,4 @@');
    expect(hunk.lines).toEqual([
      { kind: 'context', text: 'const a = 1;' },
      { kind: 'del', text: 'const b = 2;' },
      { kind: 'add', text: 'const b = 3;' },
      { kind: 'add', text: 'const c = 4;' },
      { kind: 'context', text: 'const d = 5;' },
    ]);
  });

  it('parses two files into separate records', () => {
    const blob = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -10,1 +10,1 @@',
      '-foo',
      '+bar',
    ].join('\n');

    const files = parseGitDiff(blob);
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(files[0]!.hunks[0]!.lines).toEqual([
      { kind: 'del', text: 'x' },
      { kind: 'add', text: 'y' },
    ]);
  });

  it('marks binary files and skips their hunks', () => {
    const blob = [
      'diff --git a/img.png b/img.png',
      'index 1234567..abcdefg 100644',
      'Binary files a/img.png and b/img.png differ',
    ].join('\n');

    const files = parseGitDiff(blob);
    expect(files).toHaveLength(1);
    expect(files[0]!.binary).toBe(true);
    expect(files[0]!.hunks).toEqual([]);
  });

  it('ignores +++/--- header lines (not treated as add/del)', () => {
    const blob = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');

    const files = parseGitDiff(blob);
    const hunk = files[0]!.hunks[0]!;
    // Only one '-' and one '+' line — the `---`/`+++` headers must NOT show up.
    expect(hunk.lines.filter((l) => l.kind === 'del')).toHaveLength(1);
    expect(hunk.lines.filter((l) => l.kind === 'add')).toHaveLength(1);
  });

  it('handles a rename via the b/ side path', () => {
    const blob = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n');

    const files = parseGitDiff(blob);
    // No hunks for a pure rename, but the file record should exist with the
    // post-rename path.
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('new.ts');
  });

  it('handles multiple hunks within one file', () => {
    const blob = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+A',
      '@@ -10,1 +10,1 @@',
      '-b',
      '+B',
    ].join('\n');

    const files = parseGitDiff(blob);
    expect(files[0]!.hunks).toHaveLength(2);
    expect(files[0]!.hunks[1]!.header).toBe('@@ -10,1 +10,1 @@');
  });
});

it('withholds both sides of secret renames and fails closed on malformed Git path quoting', () => {
  for (const header of [
    'a/.env b/ordinary.txt',
    'a/ordinary.txt b/.env',
    String.raw`"a/caf\303\251/.env" b/ordinary.txt`,
    String.raw`a/ordinary.txt "b/caf\303\251/.env"`,
    String.raw`"a/invalid\q" "b/invalid\q"`,
    String.raw`"a/invalid\777" "b/invalid\777"`,
    'unparseable header',
  ]) {
    const files = parseGitDiff(
      `diff --git ${header}\n@@ -1 +1 @@\n-OLD_PRIVATE_SENTINEL\n+NEW_PRIVATE_SENTINEL`,
    );
    expect(files).toHaveLength(1);
    expect(JSON.stringify(files)).not.toContain('PRIVATE_SENTINEL');
    expect(files[0]!.hunks[0]!.header).toMatch(/redacted/);
  }
});
