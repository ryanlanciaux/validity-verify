/**
 * The pure MCP-runtime decision logic behind doctor's "MCP server (running)"
 * check, plus the stamp reader against an injected fake home. classify /
 * describe are I/O-free so the four doctor branches are asserted directly
 * without spinning up runDoctor.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyMcpRuntime,
  describeMcpRuntime,
  isPidAlive,
  readMcpRuntimeStamp,
  type McpRuntimeStamp,
} from './mcp-runtime.js';

const STAMP = (over: Partial<McpRuntimeStamp> = {}): McpRuntimeStamp => ({
  version: '0.0.1+abc.202607081030',
  pid: 4242,
  startedAt: '2026-07-08T10:30:00.000Z',
  ...over,
});

describe('classifyMcpRuntime', () => {
  const alive = () => true;
  const dead = () => false;

  it('absent when there is no stamp', () => {
    expect(classifyMcpRuntime(null, '0.0.1+x', alive)).toEqual({ kind: 'absent' });
  });

  it('exited when the recorded pid is no longer alive', () => {
    expect(classifyMcpRuntime(STAMP(), '0.0.1+abc.202607081030', dead)).toEqual({
      kind: 'exited',
      version: '0.0.1+abc.202607081030',
    });
  });

  it('current when alive and the version matches the installed CLI', () => {
    expect(classifyMcpRuntime(STAMP(), '0.0.1+abc.202607081030', alive)).toEqual({
      kind: 'current',
      version: '0.0.1+abc.202607081030',
    });
  });

  it('stale when alive but the version differs from the installed CLI', () => {
    expect(classifyMcpRuntime(STAMP({ version: '0.0.1+old.1' }), '0.0.1+new.2', alive)).toEqual({
      kind: 'stale',
      running: '0.0.1+old.1',
      installed: '0.0.1+new.2',
    });
  });
});

describe('describeMcpRuntime', () => {
  it('absent → info, tells the user to restart the host', () => {
    const d = describeMcpRuntime({ kind: 'absent' });
    expect(d.status).toBe('info');
    expect(d.detail).toContain('no runtime stamp');
    expect(d.detail).toContain('restart your MCP host');
  });

  it('exited → info', () => {
    const d = describeMcpRuntime({ kind: 'exited', version: '0.0.1+x' });
    expect(d.status).toBe('info');
    expect(d.detail).toContain('has exited');
    expect(d.detail).toContain('v0.0.1+x');
  });

  it('current → ok, shows the version', () => {
    const d = describeMcpRuntime({ kind: 'current', version: '0.0.1+x' });
    expect(d.status).toBe('ok');
    expect(d.detail).toBe('v0.0.1+x');
  });

  it('stale → warn, names both builds and says restart', () => {
    const d = describeMcpRuntime({ kind: 'stale', running: '0.0.1+old', installed: '0.0.1+new' });
    expect(d.status).toBe('warn');
    expect(d.detail).toContain('running v0.0.1+old');
    expect(d.detail).toContain('installed v0.0.1+new');
    expect(d.detail).toContain('restart your MCP host');
  });
});

describe('readMcpRuntimeStamp', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'validity-cli-stamp-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('reads a well-formed stamp from ~/.validity/mcp-runtime.json', () => {
    mkdirSync(resolve(home, '.validity'), { recursive: true });
    writeFileSync(resolve(home, '.validity/mcp-runtime.json'), JSON.stringify(STAMP()), 'utf-8');
    expect(readMcpRuntimeStamp(home)).toEqual(STAMP());
  });

  it('returns null when the file is absent', () => {
    expect(readMcpRuntimeStamp(home)).toBeNull();
  });

  it('returns null for malformed / partial content', () => {
    mkdirSync(resolve(home, '.validity'), { recursive: true });
    writeFileSync(resolve(home, '.validity/mcp-runtime.json'), '{ nope', 'utf-8');
    expect(readMcpRuntimeStamp(home)).toBeNull();
  });
});

describe('isPidAlive', () => {
  it('true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('false for a pid that cannot exist', () => {
    // A very large pid that is not in use; process.kill throws ESRCH.
    expect(isPidAlive(2_147_483_646)).toBe(false);
  });
});
