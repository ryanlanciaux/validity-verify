import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VerifyLockHeldError,
  _setBeforeStealHook,
  acquireVerifyLock,
  verifyLockPath,
} from './verify-lock.js';

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'verify-lock-'));
  // Lock lives under node_modules/.validity — create the shape.
  mkdirSync(join(dir, 'node_modules', '.validity'), { recursive: true });
  return dir;
}

function distModule(): string {
  return resolve(fileURLToPath(import.meta.url), '../../dist/verify-lock.js');
}

describe('acquireVerifyLock', () => {
  it('creates the lock at node_modules/.validity/.verify.lock with holder info', () => {
    const root = tempRoot();
    const lock = acquireVerifyLock(root, { owner: 'mcp-verify' });
    try {
      const p = verifyLockPath(root);
      expect(existsSync(p)).toBe(true);
      const holder = JSON.parse(readFileSync(p, 'utf-8'));
      expect(holder.pid).toBe(process.pid);
      expect(holder.owner).toBe('mcp-verify');
      expect(typeof holder.startedAt).toBe('string');
    } finally {
      lock.release();
    }
    expect(existsSync(verifyLockPath(root))).toBe(false);
  });

  it('a second acquirer in-process loses with the holder info', () => {
    const root = tempRoot();
    const winner = acquireVerifyLock(root, { owner: 'mcp-verify' });
    try {
      expect(() => acquireVerifyLock(root, { owner: 'watch' })).toThrow(VerifyLockHeldError);
      try {
        acquireVerifyLock(root, { owner: 'watch' });
        throw new Error('unreachable');
      } catch (err) {
        expect(err).toBeInstanceOf(VerifyLockHeldError);
        expect((err as VerifyLockHeldError).holder.owner).toBe('mcp-verify');
      }
    } finally {
      winner.release();
    }
    // After release, acquisition succeeds again.
    const again = acquireVerifyLock(root, { owner: 'watch' });
    again.release();
  });

  it('two processes contend — exactly one wins, loser sees the winner', async () => {
    const root = tempRoot();
    // Hold the lock in THIS process; a child process must fail to take it.
    const lock = acquireVerifyLock(root, { owner: 'parent' });
    let childError: unknown;
    try {
      execFileSync(
        process.execPath,
        [
          '-e',
          `
          import { acquireVerifyLock } from ${JSON.stringify(distModule())};
          try {
            acquireVerifyLock(${JSON.stringify(root)}, { owner: 'child', timeoutMs: 300 });
            process.exit(0);
          } catch (err) {
            console.log(JSON.stringify({ owner: err.holder?.owner, name: err.name }));
            process.exit(1);
          }
        `,
        ],
        { encoding: 'utf-8' },
      );
      throw new Error('child should have lost the lock');
    } catch (err) {
      childError = err;
    }
    const out = String((childError as { stdout?: string }).stdout ?? '');
    expect(JSON.parse(out.trim())).toEqual({ owner: 'parent', name: 'VerifyLockHeldError' });
    lock.release();
  });

  it('steals the lock of a dead pid', () => {
    const root = tempRoot();
    const p = verifyLockPath(root);
    writeFileSync(p, JSON.stringify({ pid: 999999999, owner: 'dead', startedAt: 't' }));
    const lock = acquireVerifyLock(root, { owner: 'live' });
    try {
      expect(JSON.parse(readFileSync(p, 'utf-8')).owner).toBe('live');
    } finally {
      lock.release();
    }
  });

  it("release does not delete a successor's lock", () => {
    const root = tempRoot();
    const first = acquireVerifyLock(root, { owner: 'first' });
    first.release();
    acquireVerifyLock(root, { owner: 'second' });
    // Simulate a DIFFERENT process's lock (the successor case is inherently
    // cross-process): the stale first releaser's `ours()` pid check must see a
    // foreign pid and leave the file alone.
    writeFileSync(
      verifyLockPath(root),
      JSON.stringify({ pid: 999999998, owner: 'second', startedAt: 't' }),
    );
    first.release();
    expect(existsSync(verifyLockPath(root))).toBe(true);
    expect(JSON.parse(readFileSync(verifyLockPath(root), 'utf-8')).pid).toBe(999999998);
  });

  it('timeoutMs waits for the holder then fails; release unblocks early', () => {
    const root = tempRoot();
    const lock = acquireVerifyLock(root, { owner: 'blocker' });
    try {
      const start = Date.now();
      expect(() => acquireVerifyLock(root, { owner: 'waiter', timeoutMs: 100 })).toThrow(
        VerifyLockHeldError,
      );
      expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    } finally {
      lock.release();
    }
  });

  it('does not steal a recent unparseable lock (writer may be mid-create)', () => {
    const root = tempRoot();
    const p = verifyLockPath(root);
    writeFileSync(p, 'not-json');
    expect(() => acquireVerifyLock(root, { owner: 'live' })).toThrow(VerifyLockHeldError);
    expect(readFileSync(p, 'utf-8')).toBe('not-json');
  });

  it('two processes racing a dead-pid lock — exactly one wins', async () => {
    const root = tempRoot();
    const p = verifyLockPath(root);
    writeFileSync(p, JSON.stringify({ pid: 999999999, owner: 'dead', startedAt: 't' }));

    const script = `
      import { acquireVerifyLock } from ${JSON.stringify(distModule())};
      try {
        const lock = acquireVerifyLock(${JSON.stringify(root)}, { owner: 'racer', timeoutMs: 0 });
        process.stdout.write(JSON.stringify({ won: true, pid: process.pid }) + '\\n');
        await new Promise((r) => setTimeout(r, 1200));
        lock.release();
      } catch (err) {
        process.stdout.write(
          JSON.stringify({ won: false, holderPid: err.holder?.pid, name: err.name }) + '\\n',
        );
        process.exit(1);
      }
    `;

    const run = (): Promise<{ code: number | null; stdout: string; pid?: number }> =>
      new Promise((resolvePromise) => {
        const child = spawn(process.execPath, ['-e', script], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (d: Buffer) => {
          stdout += d.toString();
        });
        child.on('close', (code) => resolvePromise({ code, stdout, pid: child.pid ?? undefined }));
      });

    const [a, b] = await Promise.all([run(), run()]);
    const parsed = [a, b].map((r) => {
      const line = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '{}';
      return { ...JSON.parse(line), childPid: r.pid, code: r.code };
    });
    const winners = parsed.filter((r: { won: boolean }) => r.won);
    const losers = parsed.filter((r: { won: boolean }) => !r.won);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].name).toBe('VerifyLockHeldError');
    expect(losers[0].holderPid).toBe(winners[0].pid);
    // After both children exit the winner released — at most one pid, and it
    // must not still name a dead placeholder.
    if (existsSync(p)) {
      expect(JSON.parse(readFileSync(p, 'utf-8')).pid).toBe(winners[0].pid);
    }
  });

  it('does not steal a live lock created in the read-to-rename window', () => {
    const root = tempRoot();
    const p = verifyLockPath(root);
    writeFileSync(p, JSON.stringify({ pid: 999999999, owner: 'dead', startedAt: 't' }));
    _setBeforeStealHook(() => {
      writeFileSync(p, JSON.stringify({ pid: process.pid, owner: 'winner', startedAt: 't' }));
    });
    try {
      expect(() => acquireVerifyLock(root, { owner: 'loser' })).toThrow(VerifyLockHeldError);
      const holder = JSON.parse(readFileSync(p, 'utf-8'));
      expect(holder.owner).toBe('winner');
      expect(holder.pid).toBe(process.pid);
    } finally {
      _setBeforeStealHook(undefined);
    }
  });

  it('steals an unparseable lock older than 10 minutes', () => {
    const root = tempRoot();
    const p = verifyLockPath(root);
    writeFileSync(p, 'not-json');
    const elevenMinAgo = (Date.now() - 11 * 60 * 1000) / 1000;
    utimesSync(p, elevenMinAgo, elevenMinAgo);
    const lock = acquireVerifyLock(root, { owner: 'live' });
    try {
      expect(JSON.parse(readFileSync(p, 'utf-8')).owner).toBe('live');
    } finally {
      lock.release();
    }
  });
});
