/**
 * writeMcpRuntimeStamp / readMcpRuntimeStamp roundtrip against an injected fake
 * home, plus the best-effort contract (a failed write must not throw).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMcpRuntimeStamp, writeMcpRuntimeStamp } from './runtime-stamp.js';

describe('mcp runtime stamp', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'validity-mcp-stamp-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('writes ~/.validity/mcp-runtime.json and reads it back', () => {
    writeMcpRuntimeStamp({ version: '0.0.1+abc.202607081030' }, home);
    expect(existsSync(resolve(home, '.validity/mcp-runtime.json'))).toBe(true);
    const stamp = readMcpRuntimeStamp(home);
    expect(stamp).not.toBeNull();
    expect(stamp!.version).toBe('0.0.1+abc.202607081030');
    expect(stamp!.pid).toBe(process.pid);
    expect(typeof stamp!.startedAt).toBe('string');
    // startedAt is a valid ISO timestamp.
    expect(Number.isNaN(Date.parse(stamp!.startedAt))).toBe(false);
  });

  it('returns null when no stamp exists', () => {
    expect(readMcpRuntimeStamp(home)).toBeNull();
  });

  it('returns null for a malformed stamp file', () => {
    const p = resolve(home, '.validity/mcp-runtime.json');
    writeMcpRuntimeStamp({ version: 'seed' }, home); // creates the dir
    writeFileSync(p, '{ not valid json', 'utf-8');
    expect(readMcpRuntimeStamp(home)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const p = resolve(home, '.validity/mcp-runtime.json');
    writeMcpRuntimeStamp({ version: 'seed' }, home);
    writeFileSync(p, JSON.stringify({ version: 'x' }), 'utf-8'); // no pid / startedAt
    expect(readMcpRuntimeStamp(home)).toBeNull();
  });

  it('is best-effort: an unwritable home does not throw', () => {
    // A path whose parent is a FILE (not a dir) makes mkdir/write fail; the
    // helper must swallow it rather than crash server startup.
    const filePath = resolve(home, 'a-file');
    writeFileSync(filePath, 'x', 'utf-8');
    expect(() => writeMcpRuntimeStamp({ version: 'x' }, filePath)).not.toThrow();
  });
});
