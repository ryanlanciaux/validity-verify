import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './util.js';

describe('writeFileAtomic', () => {
  it('a crash mid-write (temp written, no rename) leaves the old file intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-atomic-'));
    const p = join(dir, 'state.json');
    writeFileAtomic(p, '{"v":1}\n');

    // Simulate the crash: write the temp sibling the way writeFileAtomic does,
    // then "die" before the rename.
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, '{"v":2,"torn":');

    // The target still parses to the OLD contents — never a torn file.
    expect(JSON.parse(readFileSync(p, 'utf-8'))).toEqual({ v: 1 });
    expect(existsSync(tmp)).toBe(true);

    // A subsequent clean write replaces the target atomically and consumes
    // the same pid-scoped temp name.
    writeFileAtomic(p, '{"v":3}\n');
    expect(JSON.parse(readFileSync(p, 'utf-8'))).toEqual({ v: 3 });
    expect(existsSync(tmp)).toBe(false);
  });

  it('unlinks the temp when rename fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'write-atomic-'));
    const p = join(dir, 'state.json');
    mkdirSync(p); // target is a directory — renameSync onto it throws EISDIR
    expect(() => writeFileAtomic(p, '{"v":1}\n')).toThrow();
    expect(existsSync(`${p}.${process.pid}.tmp`)).toBe(false);
  });
});
