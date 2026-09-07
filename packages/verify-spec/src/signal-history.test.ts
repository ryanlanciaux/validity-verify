/**
 * Signal transitions (scorecard.diffSignalTransitions) + the committed
 * signal-transition feed (history.appendSignalHistory/readSignalHistory).
 * Load-bearing: transitions fire on state CHANGES only (steady-state
 * re-fires are silent — the actuation hook and the ledger both key off
 * this), the feed is append-only and conflict-tolerant, and it never
 * pollutes the per-spec trend listing.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendSignalHistory,
  listHistorySpecIds,
  readSignalHistory,
  signalHistoryPath,
  type SignalHistoryRow,
} from './history.js';
import { diffSignalTransitions, mergeSignals, type Signal } from './scorecard.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

function sig(over: Partial<Signal>): Signal {
  return {
    id: 'regression:spec-1:AC-1',
    kind: 'regression',
    severity: 'high',
    specId: 'spec-1',
    criterionId: 'AC-1',
    detail: 'went red',
    at: T0,
    status: 'open',
    ...over,
  };
}

describe('diffSignalTransitions', () => {
  it('a brand-new open signal is a transition', () => {
    const after = [sig({})];
    expect(diffSignalTransitions([], after)).toEqual({
      opened: after,
      resolved: [],
      suppressed: [],
    });
  });

  it('a steady-state re-fire (open before, open after) is NOT a transition', () => {
    const before = [sig({ at: T0 })];
    const after = [sig({ at: T1, detail: 'still red' })];
    expect(diffSignalTransitions(before, after)).toEqual({
      opened: [],
      resolved: [],
      suppressed: [],
    });
  });

  it('open → resolved is a resolve transition; resolved → open is a re-open', () => {
    const open = sig({});
    const closed = sig({ status: 'resolved', resolvedAt: T1 });
    expect(diffSignalTransitions([open], [closed]).resolved).toEqual([closed]);
    expect(diffSignalTransitions([closed], [open]).opened).toEqual([open]);
  });

  it('a signal already resolved on both sides is silent', () => {
    const closed = sig({ status: 'resolved' });
    expect(diffSignalTransitions([closed], [closed])).toEqual({
      opened: [],
      resolved: [],
      suppressed: [],
    });
  });

  it('composes with mergeSignals: re-fire silent, resolve loud', () => {
    const existing = [sig({ at: T0 })];
    // Re-fire of the same id: merge keeps it open — no transition.
    const refired = mergeSignals(existing, [sig({ at: T1 })]);
    expect(diffSignalTransitions(existing, refired)).toEqual({
      opened: [],
      resolved: [],
      suppressed: [],
    });
    // A resolve marker closes it — one resolved transition.
    const resolvedMarker = sig({ status: 'resolved', at: T1, detail: 'recovered' });
    const merged = mergeSignals(existing, [resolvedMarker]);
    const { opened, resolved } = diffSignalTransitions(existing, merged);
    expect(opened).toEqual([]);
    expect(resolved.map((s) => s.id)).toEqual(['regression:spec-1:AC-1']);
  });
});

describe('signal history feed', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'validity-signal-history-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function row(over: Partial<SignalHistoryRow>): SignalHistoryRow {
    return {
      v: 1,
      at: T0,
      id: 'regression:spec-1:AC-1',
      kind: 'regression',
      severity: 'high',
      specId: 'spec-1',
      criterionId: 'AC-1',
      status: 'open',
      detail: 'went red',
      ...over,
    };
  }

  it('appends and reads back in at-order, events not deduped', () => {
    appendSignalHistory(root, [row({ at: T1, status: 'resolved' })]);
    appendSignalHistory(root, [row({ at: T0 })]);
    const rows = readSignalHistory(root);
    expect(rows.map((r) => [r.at, r.status])).toEqual([
      [T0, 'open'],
      [T1, 'resolved'],
    ]);
  });

  it('empty append writes nothing; missing file reads []', () => {
    appendSignalHistory(root, []);
    expect(readSignalHistory(root)).toEqual([]);
  });

  it('skips malformed lines and unresolved conflict markers', () => {
    appendSignalHistory(root, [row({})]);
    appendFileSync(signalHistoryPath(root), '<<<<<<< HEAD\nnot json\n=======\n>>>>>>> theirs\n');
    appendSignalHistory(root, [row({ at: T1, status: 'resolved' })]);
    const rows = readSignalHistory(root);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.status).toBe('resolved');
  });

  it('caps at limit, keeping the most recent rows', () => {
    for (let i = 0; i < 10; i++) {
      appendSignalHistory(root, [row({ at: `2026-01-0${(i % 9) + 1}T00:00:00.00${i}Z` })]);
    }
    expect(readSignalHistory(root, 3)).toHaveLength(3);
  });

  it('signals.jsonl never appears in the per-spec trend listing', () => {
    appendSignalHistory(root, [row({})]);
    mkdirSync(join(root, '.validity', 'history'), { recursive: true });
    writeFileSync(join(root, '.validity', 'history', 'spec-1.jsonl'), '{}\n');
    writeFileSync(join(root, '.validity', 'history', 'score.jsonl'), '{}\n');
    expect(listHistorySpecIds(root)).toEqual(['spec-1']);
  });
});
