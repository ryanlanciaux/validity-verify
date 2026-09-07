import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSignals, saveSignals, type Signal } from '@validity.ai/verify-spec';
import { handleSignals } from './signal-tools.js';

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

describe('validity__signals', () => {
  let root: string;

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
  }

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-signals-mcp-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@validity.local']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
    mkdirSync(resolve(root, 'src'), { recursive: true });
    writeFileSync(resolve(root, 'src/a.txt'), 'a\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('list / suppress / resolve round-trip', async () => {
    saveSignals(root, [sig()]);
    const listed = await handleSignals({ action: 'list', projectRoot: root });
    const sc = listed.structuredContent as { signals: Array<{ id: string; status: string }> };
    expect(sc.signals).toHaveLength(1);
    expect(sc.signals[0]!.status).toBe('open');

    const suppressed = await handleSignals({
      action: 'suppress',
      id: 'regression:spec-a:AC-1',
      note: 'later',
      projectRoot: root,
    });
    expect(suppressed.isError).toBeUndefined();
    expect(loadSignals(root)[0]).toMatchObject({ status: 'suppressed', resolvedBy: 'suppress' });

    const listedAll = await handleSignals({ action: 'list', all: true, projectRoot: root });
    const all = listedAll.structuredContent as { signals: Array<{ status: string }> };
    expect(all.signals).toHaveLength(1);
    expect(all.signals[0]!.status).toBe('suppressed');

    const resolved = await handleSignals({
      action: 'resolve',
      id: 'regression:spec-a:AC-1',
      note: 'done',
      projectRoot: root,
    });
    expect(resolved.isError).toBeUndefined();
    expect(loadSignals(root)[0]).toMatchObject({ status: 'resolved', resolvedBy: 'manual' });
  });
});
