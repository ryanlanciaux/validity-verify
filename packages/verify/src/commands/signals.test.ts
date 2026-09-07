import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSignals, saveSignals, type Signal } from '@validity.ai/verify-spec';
import { runSignals } from './signals.js';

const T0 = '2026-01-01T00:00:00.000Z';

function sig(over: Partial<Signal> = {}): Signal {
  return {
    id: 'regression:spec-a:AC-1',
    kind: 'regression',
    severity: 'high',
    specId: 'spec-a',
    criterionId: 'AC-1',
    detail: 'went red',
    at: T0,
    openedAt: T0,
    status: 'open',
    ...over,
  };
}

describe('validity signals CLI', () => {
  let root: string;
  let stdout: string;

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
  }

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-signals-cli-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@validity.local']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
    mkdirSync(resolve(root, 'src'), { recursive: true });
    writeFileSync(resolve(root, 'src/a.txt'), 'a\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('list shows open only; --all includes suppressed', async () => {
    saveSignals(root, [
      sig(),
      sig({
        id: 'perf-drift:spec-a:load',
        kind: 'perf-drift',
        status: 'resolved',
        resolvedAt: T0,
        resolvedBy: 'pass',
        severity: 'low',
      }),
    ]);
    await runSignals('list', undefined, { cwd: root });
    expect(stdout).toContain('Open signals (1)');
    expect(stdout).toContain('regression:spec-a:AC-1');
    stdout = '';
    await runSignals('list', undefined, { cwd: root, all: true });
    expect(stdout).toContain('Signals (2)');
  });

  it('suppress then resolve round-trip', async () => {
    saveSignals(root, [sig()]);
    await runSignals('suppress', 'regression:spec-a:AC-1', { cwd: root, note: 'later' });
    expect(stdout).toContain('suppressed regression:spec-a:AC-1');
    const parked = loadSignals(root);
    expect(parked[0]).toMatchObject({
      status: 'suppressed',
      resolvedBy: 'suppress',
    });
    expect(parked[0]!.suppressedUntil?.note).toBe('later');
    stdout = '';
    await runSignals('resolve', 'regression:spec-a:AC-1', { cwd: root, note: 'wontfix' });
    const closed = loadSignals(root);
    expect(closed[0]).toMatchObject({ status: 'resolved', resolvedBy: 'manual' });
  });
});
