import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectGitBinding,
  collectGitInfo,
  gitChangedFilesSince,
  gitCommitsBehind,
  gitDiffNames,
  gitHeadSha,
  gitIsAncestor,
  gitWorkingTreeChanges,
} from './git.js';

import { getChangedFilesFromGit } from './components.js';

describe('collectGitInfo', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'validity-git-test-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns undefined in a non-git directory', () => {
    const info = collectGitInfo(tmpRoot);
    expect(info).toBeUndefined();
  });

  function gitInit(): void {
    // Configure a fresh repo with deterministic identity so commits succeed.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'user.email', 'test@validity.local'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRoot });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpRoot });
  }

  it('returns sha + branch + dirty=false for a clean repo', () => {
    gitInit();
    writeFileSync(resolve(tmpRoot, 'README.md'), 'hi\n');
    execFileSync('git', ['add', 'README.md'], { cwd: tmpRoot });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpRoot });

    const info = collectGitInfo(tmpRoot);
    expect(info).toBeDefined();
    expect(info!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(info!.branch).toBe('main');
    expect(info!.dirty).toBe(false);
  });

  it('reports dirty=true when there are untracked files', () => {
    gitInit();
    writeFileSync(resolve(tmpRoot, 'README.md'), 'hi\n');
    execFileSync('git', ['add', 'README.md'], { cwd: tmpRoot });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpRoot });
    writeFileSync(resolve(tmpRoot, 'untracked.txt'), 'noise\n');

    const info = collectGitInfo(tmpRoot);
    expect(info?.dirty).toBe(true);
  });

  it('omits branch when HEAD is detached', () => {
    gitInit();
    writeFileSync(resolve(tmpRoot, 'a.txt'), '1\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: tmpRoot });
    execFileSync('git', ['commit', '-q', '-m', 'one'], { cwd: tmpRoot });
    writeFileSync(resolve(tmpRoot, 'b.txt'), '2\n');
    execFileSync('git', ['add', 'b.txt'], { cwd: tmpRoot });
    execFileSync('git', ['commit', '-q', '-m', 'two'], { cwd: tmpRoot });
    // Detach: checkout the commit SHA directly.
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: tmpRoot,
      encoding: 'utf-8',
    }).trim();
    execFileSync('git', ['checkout', '-q', sha], { cwd: tmpRoot });

    const info = collectGitInfo(tmpRoot);
    expect(info?.branch).toBeUndefined();
    expect(info?.sha).toBe(sha);
  });

  it('finds staged and untracked files before the first commit, preserving whitespace', () => {
    expect(gitWorkingTreeChanges(tmpRoot)).toEqual([]);
    expect(getChangedFilesFromGit(tmpRoot)).toEqual([]);
    gitInit();
    expect(getChangedFilesFromGit(tmpRoot)).toEqual([]);
    writeFileSync(resolve(tmpRoot, ' staged.tsx'), 'staged');
    execFileSync('git', ['add', '.'], { cwd: tmpRoot });
    writeFileSync(resolve(tmpRoot, 'untracked.tsx'), 'untracked');
    expect(getChangedFilesFromGit(tmpRoot).sort()).toEqual([' staged.tsx', 'untracked.tsx']);
  });

  it('returns undefined for a repo with no commits (no HEAD)', () => {
    gitInit();
    // No commit yet — `git rev-parse HEAD` fails.
    mkdirSync(resolve(tmpRoot, 'src'), { recursive: true });
    const info = collectGitInfo(tmpRoot);
    expect(info).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Temporal-binding helpers (B2). Real temp repos, no mocks.           *
 * ------------------------------------------------------------------ */

describe('collectGitBinding / gitIsAncestor / gitDiffNames', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'validity-git-binding-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: tmpRoot, encoding: 'utf-8' }).trim();
  }

  function gitInit(): void {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@validity.local']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
  }

  function commit(file: string, content: string, message: string): string {
    writeFileSync(resolve(tmpRoot, file), content);
    git(['add', file]);
    git(['commit', '-q', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  }

  it('collectGitBinding returns undefined in a non-git directory', () => {
    expect(collectGitBinding(tmpRoot)).toBeUndefined();
  });

  it('collectGitBinding returns undefined in a repo with no commits', () => {
    gitInit();
    expect(collectGitBinding(tmpRoot)).toBeUndefined();
  });

  it('clean repo → dirty:false, changedFiles empty, no truncation flag', () => {
    gitInit();
    const sha = commit('README.md', 'hi\n', 'init');
    const binding = collectGitBinding(tmpRoot)!;
    expect(binding.sha).toBe(sha);
    expect(binding.dirty).toBe(false);
    expect(binding.changedFiles).toEqual([]);
    expect(binding.changedFilesTruncated).toBeUndefined();
  });

  it('modified + untracked files both land in changedFiles', () => {
    gitInit();
    commit('a.txt', '1\n', 'init');
    writeFileSync(resolve(tmpRoot, 'a.txt'), '2\n'); // modified
    writeFileSync(resolve(tmpRoot, 'new.txt'), 'x\n'); // untracked
    const binding = collectGitBinding(tmpRoot)!;
    expect(binding.dirty).toBe(true);
    expect(binding.changedFiles).toContain('a.txt');
    expect(binding.changedFiles).toContain('new.txt');
  });

  it('a staged rename records BOTH the old and new paths', () => {
    gitInit();
    commit('old-name.txt', 'same content\n', 'init');
    renameSync(resolve(tmpRoot, 'old-name.txt'), resolve(tmpRoot, 'new-name.txt'));
    git(['add', '-A']);
    const binding = collectGitBinding(tmpRoot)!;
    expect(binding.changedFiles).toContain('new-name.txt');
    expect(binding.changedFiles).toContain('old-name.txt');
  });

  it('paths with spaces survive the -z parse un-mangled', () => {
    gitInit();
    commit('a.txt', '1\n', 'init');
    writeFileSync(resolve(tmpRoot, 'file with spaces.txt'), 'x\n');
    const binding = collectGitBinding(tmpRoot)!;
    expect(binding.changedFiles).toContain('file with spaces.txt');
  });

  it("REGRESSION (canonical-workflow misclassification): Validity's own .validity/ writes are excluded from changedFiles AND dirty", () => {
    gitInit();
    commit('Button.tsx', 'old\n', 'init');
    // Simulate spec_create/spec_freeze having just written the spec store —
    // the exact state collectGitBinding sees at freeze time.
    mkdirSync(resolve(tmpRoot, '.validity/specs/spec-x'), { recursive: true });
    writeFileSync(resolve(tmpRoot, '.validity/specs/spec-x/spec.yaml'), 'id: spec-x\n');
    const binding = collectGitBinding(tmpRoot)!;
    expect(binding.changedFiles).toEqual([]);
    expect(binding.dirty).toBe(false);
    // A real user edit alongside the spec-store noise still registers.
    writeFileSync(resolve(tmpRoot, 'Button.tsx'), 'new\n');
    const binding2 = collectGitBinding(tmpRoot)!;
    expect(binding2.changedFiles).toEqual(['Button.tsx']);
    expect(binding2.dirty).toBe(true);
  });

  it('REGRESSION (non-ASCII path mismatch): gitDiffNames emits raw -z paths byte-identical to porcelain -z, never C-quoted', () => {
    gitInit();
    // Force the default even when the host's global config disables quoting.
    git(['config', 'core.quotePath', 'true']);
    const a = commit('plain.txt', '0\n', 'init');
    // Dirty at freeze time…
    writeFileSync(resolve(tmpRoot, 'café.tsx'), 'x\n');
    const binding = collectGitBinding(tmpRoot)!;
    expect(binding.changedFiles).toContain('café.tsx');
    // …then committed as the run's work: both sides must carry the SAME bytes.
    const b = commit('café.tsx', 'x\n', 'work');
    const names = gitDiffNames(tmpRoot, a, b);
    expect(names).toContain('café.tsx');
    expect(names.some((n) => n.includes('"') || n.includes('\\'))).toBe(false);
  });

  it('over 500 dirty files → list capped at 500 + changedFilesTruncated', () => {
    gitInit();
    commit('README.md', 'hi\n', 'init');
    for (let i = 0; i < 501; i++) {
      writeFileSync(resolve(tmpRoot, `f${String(i).padStart(3, '0')}.txt`), `${i}\n`);
    }
    const binding = collectGitBinding(tmpRoot)!;
    expect(binding.changedFiles).toHaveLength(500);
    expect(binding.changedFilesTruncated).toBe(true);
    expect(binding.dirty).toBe(true);
  });

  it('gitIsAncestor: linear history → true; equal shas → true', () => {
    gitInit();
    const a = commit('a.txt', '1\n', 'one');
    const b = commit('b.txt', '2\n', 'two');
    expect(gitIsAncestor(tmpRoot, a, b)).toBe(true);
    expect(gitIsAncestor(tmpRoot, a, a)).toBe(true);
    // Descendant is NOT an ancestor of its parent.
    expect(gitIsAncestor(tmpRoot, b, a)).toBe(false);
  });

  it('gitIsAncestor: sibling-branch commit → false (clean exit-1)', () => {
    gitInit();
    const base = commit('base.txt', '0\n', 'base');
    const onMain = commit('main.txt', 'm\n', 'main work');
    git(['checkout', '-q', '-b', 'side', base]);
    const onSide = commit('side.txt', 's\n', 'side work');
    expect(gitIsAncestor(tmpRoot, onMain, onSide)).toBe(false);
    expect(gitIsAncestor(tmpRoot, onSide, onMain)).toBe(false);
  });

  it('gitIsAncestor: nonexistent sha / non-git dir → undefined (cannot answer)', () => {
    gitInit();
    const a = commit('a.txt', '1\n', 'one');
    const bogus = '0'.repeat(40);
    expect(gitIsAncestor(tmpRoot, bogus, a)).toBeUndefined();
    const nonGit = mkdtempSync(resolve(tmpdir(), 'validity-nongit-'));
    try {
      expect(gitIsAncestor(nonGit, a, a)).toBeUndefined();
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('gitDiffNames returns the committed file names between two shas; [] on failure', () => {
    gitInit();
    const a = commit('a.txt', '1\n', 'one');
    commit('b.txt', '2\n', 'two');
    const c = commit('c.txt', '3\n', 'three');
    expect(gitDiffNames(tmpRoot, a, c).sort()).toEqual(['b.txt', 'c.txt']);
    expect(gitDiffNames(tmpRoot, '0'.repeat(40), c)).toEqual([]);
  });
});

describe('gitHeadSha / gitChangedFilesSince (watch catch-up)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'validity-git-catchup-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: tmpRoot, encoding: 'utf-8' }).trim();
  }

  function gitInit(): void {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@validity.local']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
  }

  function commit(file: string, content: string, message: string): string {
    writeFileSync(resolve(tmpRoot, file), content);
    git(['add', file]);
    git(['commit', '-q', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  }

  it('gitHeadSha: undefined in a non-git dir, sha in a repo', () => {
    expect(gitHeadSha(tmpRoot)).toBeUndefined();
    gitInit();
    expect(gitHeadSha(tmpRoot)).toBeUndefined(); // zero commits
    const sha = commit('a.txt', '1\n', 'one');
    expect(gitHeadSha(tmpRoot)).toBe(sha);
  });

  it('returns the files changed between the mark and HEAD', () => {
    gitInit();
    const mark = commit('a.txt', '1\n', 'one');
    commit('b.txt', '2\n', 'two');
    commit('c.txt', '3\n', 'three');
    expect(gitChangedFilesSince(tmpRoot, mark)?.sort()).toEqual(['b.txt', 'c.txt']);
  });

  it('returns [] when the mark IS HEAD (nothing landed)', () => {
    gitInit();
    const mark = commit('a.txt', '1\n', 'one');
    expect(gitChangedFilesSince(tmpRoot, mark)).toEqual([]);
  });

  it('returns null — never [] — for an unresolvable mark', () => {
    gitInit();
    commit('a.txt', '1\n', 'one');
    // A well-formed sha that exists in no object store: "unknown, full tick",
    // deliberately distinct from "no changes".
    expect(gitChangedFilesSince(tmpRoot, 'f'.repeat(40))).toBeNull();
  });

  it('returns null in a non-git directory', () => {
    expect(gitChangedFilesSince(tmpRoot, 'f'.repeat(40))).toBeNull();
  });

  it('abbreviated marks resolve (rev-parse verify handles short shas)', () => {
    gitInit();
    const mark = commit('a.txt', '1\n', 'one');
    commit('b.txt', '2\n', 'two');
    expect(gitChangedFilesSince(tmpRoot, mark.slice(0, 12))).toEqual(['b.txt']);
  });
});

describe('gitCommitsBehind (dashboard watcher-status)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'validity-git-behind-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: tmpRoot, encoding: 'utf-8' }).trim();
  }

  function gitInit(): void {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@validity.local']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
  }

  function commit(file: string, content: string, message: string): string {
    writeFileSync(resolve(tmpRoot, file), content);
    git(['add', file]);
    git(['commit', '-q', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  }

  it('counts the commits between a mark and HEAD', () => {
    gitInit();
    const mark = commit('a.txt', '1\n', 'one');
    commit('b.txt', '2\n', 'two');
    commit('c.txt', '3\n', 'three');
    expect(gitCommitsBehind(tmpRoot, mark)).toBe(2);
  });

  it('returns 0 when the mark IS HEAD', () => {
    gitInit();
    const mark = commit('a.txt', '1\n', 'one');
    expect(gitCommitsBehind(tmpRoot, mark)).toBe(0);
  });

  it('returns null for a bogus / unresolvable sha (never 0)', () => {
    gitInit();
    commit('a.txt', '1\n', 'one');
    expect(gitCommitsBehind(tmpRoot, 'f'.repeat(40))).toBeNull();
  });

  it('returns null in a non-git directory', () => {
    expect(gitCommitsBehind(tmpRoot, 'f'.repeat(40))).toBeNull();
  });

  it('returns null in a repo with no commits', () => {
    gitInit();
    expect(gitCommitsBehind(tmpRoot, 'f'.repeat(40))).toBeNull();
  });
});
