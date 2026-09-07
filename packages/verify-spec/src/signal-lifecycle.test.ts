/**
 * Signal lifecycle: resolvedBy on close paths, suppress/reopen, rebuild from
 * the transition feed. Can't-false-green: a suppressed signal whose condition
 * has cleared resolves as pass and never reopens.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSignalHistory, type SignalHistoryRow } from './history.js';
import {
  loadSignals,
  mergeSignals,
  pruneResolvedSignals,
  saveSignals,
  sweepStaleSignals,
  type Signal,
  type SignalStateContext,
} from './scorecard.js';
import {
  applySnapshotTieBreakers,
  applySuppressionLifecycle,
  persistSignalTransitions,
  rebuildSignalsFromHistory,
  replaySignalRows,
  resolveSignalManual,
  suppressSignal,
} from './signal-lifecycle.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const T2 = '2026-01-03T00:00:00.000Z';

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

function row(over: Partial<SignalHistoryRow> = {}): SignalHistoryRow {
  return {
    v: 1,
    at: T0,
    id: 'regression:spec-a:AC-1',
    kind: 'regression',
    severity: 'high',
    specId: 'spec-a',
    criterionId: 'AC-1',
    status: 'open',
    detail: 'went red',
    ...over,
  };
}

describe('resolvedBy on close paths', () => {
  it('mergeSignals copies resolvedBy from a pass-close marker', () => {
    const marker = sig({
      status: 'resolved',
      at: T1,
      resolvedAt: T1,
      resolvedBy: 'pass',
      detail: 'recovered',
    });
    const merged = mergeSignals([sig()], [marker]);
    expect(merged[0]).toMatchObject({ status: 'resolved', resolvedBy: 'pass' });
  });

  it('sweep markers carry resolvedBy: sweep', () => {
    const ctx: SignalStateContext = {
      scorecard: {
        version: 1,
        updatedAt: T0,
        specs: {
          'spec-a': {
            specVersion: 1,
            verdict: 'pass',
            coveragePercent: 100,
            updatedAt: T0,
            criteria: { 'AC-1': { tier: 'hard', status: 'pass', at: T0 } },
          },
        },
      },
      specs: [
        {
          id: 'spec-a',
          version: 1,
          status: 'frozen',
          source: { prompt: 'p', createdBy: 'agent' },
          runtime: 'web',
          criteria: [{ id: 'AC-1', text: 'ok', tier: 'hard', checks: [] }],
          createdAt: T0,
        },
      ],
    };
    const markers = sweepStaleSignals([sig()], ctx, T1, 'abc');
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ status: 'resolved', resolvedBy: 'sweep' });
  });

  it('a recovered close of a matching open regression is resolvedBy: pass', () => {
    const recovered: Signal = {
      id: 'recovered:spec-a:AC-1',
      kind: 'recovered',
      severity: 'info',
      specId: 'spec-a',
      criterionId: 'AC-1',
      detail: 'back to green',
      at: T1,
      openedAt: T1,
      resolvedAt: T1,
      status: 'resolved',
      resolvedBy: 'pass',
    };
    const merged = mergeSignals([sig()], [recovered]);
    const closed = merged.find((s) => s.id === 'regression:spec-a:AC-1');
    expect(closed).toMatchObject({ status: 'resolved', resolvedBy: 'pass' });
  });
});

describe('suppress hides from the open set', () => {
  it('suppressSignal parks with resolvedBy suppress and stays out of open', () => {
    const parked = suppressSignal(sig(), { now: T1, sha: 'abc123', note: 'looking later' });
    expect(parked.status).toBe('suppressed');
    expect(parked.resolvedBy).toBe('suppress');
    expect(parked.suppressedUntil).toEqual({ sha: 'abc123', note: 'looking later' });
    const merged = mergeSignals([sig()], [parked]);
    expect(merged.filter((s) => s.status === 'open')).toHaveLength(0);
    expect(merged[0]!.status).toBe('suppressed');
  });

  it('pruneResolvedSignals keeps every suppressed row', () => {
    const parked = suppressSignal(sig(), { now: T1, sha: 'abc' });
    const pruned = pruneResolvedSignals([parked]);
    expect(pruned).toHaveLength(1);
    expect(pruned[0]!.status).toBe('suppressed');
  });

  it('a re-fire does not reopen a suppressed signal but keeps the fresh detail', () => {
    const parked = suppressSignal(sig(), { now: T1, sha: 'abc' });
    const merged = mergeSignals([parked], [sig({ at: T2, detail: 'still red' })]);
    expect(merged[0]!.status).toBe('suppressed');
    expect(merged[0]!.detail).toBe('still red');
  });
});

describe('suppress reopen vs condition-cleared', () => {
  it('code change past the sha reopens with the canonical detail', () => {
    const parked = suppressSignal(sig(), { now: T1, sha: 'abc' });
    const next = applySuppressionLifecycle(parked, {
      now: T2,
      sha: 'def',
      specRelevantChange: true,
      conditionCleared: false,
      freshDetail: 'still red after the edit',
    });
    expect(next.status).toBe('open');
    expect(next.detail).toBe('reopened: code changed since suppression — still red after the edit');
    expect(next.resolvedBy).toBeUndefined();
    expect(next.suppressedUntil).toBeUndefined();
    expect(next.openedAt).toBe(T0);
  });

  it('reopen falls back to the parked detail when no fresh claim is available', () => {
    const parked = suppressSignal(sig(), { now: T1, sha: 'abc' });
    const next = applySuppressionLifecycle(parked, {
      now: T2,
      specRelevantChange: true,
      conditionCleared: false,
    });
    expect(next.detail).toBe('reopened: code changed since suppression — went red');
  });

  it('CANNOT-FALSE-GREEN: condition cleared while suppressed resolves pass and never reopens', () => {
    const parked = suppressSignal(sig(), { now: T1, sha: 'abc' });
    const next = applySuppressionLifecycle(parked, {
      now: T2,
      specRelevantChange: true,
      conditionCleared: true,
    });
    expect(next.status).toBe('resolved');
    expect(next.resolvedBy).toBe('pass');
    expect(next.suppressedUntil).toBeUndefined();
  });

  it('no relevant change and still failing stays suppressed', () => {
    const parked = suppressSignal(sig(), { now: T1, sha: 'abc' });
    const next = applySuppressionLifecycle(parked, {
      now: T2,
      specRelevantChange: false,
      conditionCleared: false,
    });
    expect(next.status).toBe('suppressed');
  });

  it('manual resolve sets resolvedBy: manual', () => {
    const closed = resolveSignalManual(sig(), { now: T1, sha: 'abc', note: 'wontfix' });
    expect(closed).toMatchObject({ status: 'resolved', resolvedBy: 'manual' });
    expect(closed.detail).toContain('wontfix');
  });
});

describe('replaySignalRows (rebuildable open-set)', () => {
  it('replays open → resolve → reopen', () => {
    const rebuilt = replaySignalRows([
      row({ at: T0, status: 'open' }),
      row({ at: T1, status: 'resolved', resolvedBy: 'pass', detail: 'recovered' }),
      row({ at: T2, status: 'open', detail: 'red again' }),
    ]);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({
      status: 'open',
      detail: 'red again',
      openedAt: T0,
    });
    expect(rebuilt[0]!.resolvedBy).toBeUndefined();
  });

  it('replays a suppress and keeps it parked', () => {
    const rebuilt = replaySignalRows([
      row({ at: T0, status: 'open' }),
      row({
        at: T1,
        status: 'suppressed',
        resolvedBy: 'suppress',
        suppressedUntil: { sha: 'abc', note: 'later' },
        detail: 'parked',
      }),
    ]);
    expect(rebuilt[0]).toMatchObject({
      status: 'suppressed',
      resolvedBy: 'suppress',
      suppressedUntil: { sha: 'abc', note: 'later' },
    });
  });

  it('signals.json tie-breaker wins when newer than the feed', () => {
    const replayed = replaySignalRows([row({ at: T0, status: 'open' })]);
    const snapshot = [sig({ at: T2, status: 'resolved', resolvedAt: T2, resolvedBy: 'manual' })];
    const last = new Map([['regression:spec-a:AC-1', T0]]);
    const mixed = applySnapshotTieBreakers(replayed, snapshot, last);
    expect(mixed[0]!.status).toBe('resolved');
    expect(mixed[0]!.resolvedBy).toBe('manual');
  });

  it('feed wins when snapshot is older', () => {
    const replayed = replaySignalRows([
      row({ at: T0, status: 'open' }),
      row({ at: T2, status: 'resolved', resolvedBy: 'pass' }),
    ]);
    const snapshot = [sig({ at: T1 })];
    const last = new Map([['regression:spec-a:AC-1', T2]]);
    const mixed = applySnapshotTieBreakers(replayed, snapshot, last);
    expect(mixed[0]!.status).toBe('resolved');
  });
});

describe('rebuildSignalsFromHistory (IO wrapper)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'validity-rebuild-sig-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('replays the feed into a fresh signals.json and reports opened/resolved counts', () => {
    appendSignalHistory(root, [
      row({ at: T0, status: 'open' }),
      row({ at: T1, status: 'resolved', resolvedBy: 'pass' }),
    ]);
    saveSignals(root, [sig()]);
    const result = rebuildSignalsFromHistory(root);
    expect(result.opened).toBe(0);
    expect(result.resolved).toBe(1);
    expect(result.rebuilt[0]!.status).toBe('resolved');
  });
});

describe('reconcileSuppressedSignals against a real git range', () => {
  let root: string;

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
  }

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-suppress-git-'));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@validity.local']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
    mkdirSync(resolve(root, 'src'), { recursive: true });
    writeFileSync(resolve(root, 'src/Button.tsx'), 'export const Button = () => null;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a later commit of the spec target reopens (specRelevantChange via file list)', () => {
    const sha = git(['rev-parse', 'HEAD']);
    const parked = suppressSignal(sig({ specId: 'spec-a' }), { now: T1, sha });
    writeFileSync(resolve(root, 'src/Button.tsx'), 'export const Button = () => "x";\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'edit']);
    // Pure path: files changed since sha include the target.
    const next = applySuppressionLifecycle(parked, {
      now: T2,
      specRelevantChange: true,
      conditionCleared: false,
    });
    expect(next.status).toBe('open');
  });
});

describe('persistSignalTransitions observedSpecIds (pass-close gating)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'validity-persist-obs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('suppress then persist with empty observedSpecIds stays suppressed', () => {
    const parked = suppressSignal(sig(), { now: T1, sha: 'abc' });
    saveSignals(root, [parked]);
    persistSignalTransitions(root, [], [parked], T2);
    expect(loadSignals(root)[0]).toMatchObject({
      status: 'suppressed',
      resolvedBy: 'suppress',
    });
  });

  it('fold of an unrelated spec does not pass-close a parked row', () => {
    const parked = suppressSignal(sig({ specId: 'spec-a' }), { now: T1, sha: 'abc' });
    saveSignals(root, [parked]);
    persistSignalTransitions(root, [], [parked], T2, undefined, new Set(['spec-b']));
    expect(loadSignals(root)[0]!.status).toBe('suppressed');
  });

  it('fold of the same spec pass-closes when the claim is gone', () => {
    const parked = suppressSignal(sig({ specId: 'spec-a' }), { now: T1, sha: 'abc' });
    saveSignals(root, [parked]);
    persistSignalTransitions(root, [], [parked], T2, undefined, new Set(['spec-a']));
    expect(loadSignals(root)[0]).toMatchObject({
      status: 'resolved',
      resolvedBy: 'pass',
    });
  });
});
