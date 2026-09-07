/**
 * Week-simulation (loop-hardening verification protocol). One integrated run of
 * the durable loop the way it plays out over days — freeze → verify → score →
 * re-freeze with a RENAMED-because-failing criterion → tick — asserting the
 * whole-loop invariants the per-transition unit tests only prove in isolation:
 *
 *   1. signals CLOSE (W1): the daily needs-scoring row resolves on score; the
 *      renamed criterion's regression does NOT wedge open forever (W2 #6).
 *   2. no ZOMBIES (W2 #6): a criterion that left the spec at re-freeze is dropped
 *      from the criteria map, not carried forward.
 *   3. the dashboard reaches "no open signals" — the queue actually drains.
 *
 * Runs against a real `.validity/` temp dir so the IO shell (atomic writes +
 * the derive-posture gitignore) is on the path too, not just the pure reducer.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySoftScores,
  loadScorecard,
  loadSignals,
  mergeSignals,
  reconcileScorecard,
  saveScorecard,
  saveSignals,
  type SpecObservation,
} from './scorecard.js';

const SPEC = 'spec-buttons';

/** Open signals only — what the dashboard's "no open signals" line keys off. */
function openSignals(root: string): string[] {
  return loadSignals(root)
    .filter((s) => s.status === 'open')
    .map((s) => s.id)
    .sort();
}

describe('week simulation — freeze → verify → score → re-freeze(renamed) → tick', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-week-sim-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Persist a reducer/soft-score result the way watch/verify do. */
  function persist(
    scorecard: ReturnType<typeof reconcileScorecard>['scorecard'],
    fresh: Parameters<typeof mergeSignals>[1],
  ): void {
    saveScorecard(root, scorecard);
    saveSignals(root, mergeSignals(loadSignals(root), fresh));
  }

  it('drains to no open signals, no zombies, signed off', () => {
    // ── Day 1: freeze v1 and run the first deterministic tick. ──────────────
    // AC-2 is the criterion that fails today and gets RENAMED tomorrow.
    const v1: SpecObservation = {
      specId: SPEC,
      specVersion: 1,
      specHash: 'hash-v1',
      criteria: [
        { id: 'AC-1', tier: 'hard', status: 'pass' },
        { id: 'AC-2', tier: 'hard', status: 'fail', detail: 'button does not pop' },
        { id: 'AC-3', tier: 'soft', status: 'unscored' },
      ],
    };
    const tick1 = reconcileScorecard({
      prev: null,
      observations: [v1],
      now: '2026-07-01T09:00:00.000Z',
    });
    persist(tick1.scorecard, tick1.signals);

    // A failing hard criterion opens a regression; the un-scored soft opens
    // needs-scoring. Not signed off.
    expect(openSignals(root)).toEqual([`needs-scoring:${SPEC}:AC-3`, `regression:${SPEC}:AC-2`]);
    expect(loadScorecard(root)!.specs[SPEC].signedOff).toBe(false);

    // ── Day 1, later: the agent scores the soft criterion pass. ─────────────
    const scored = applySoftScores({
      prev: loadScorecard(root)!,
      specId: SPEC,
      scores: [{ id: 'AC-3', status: 'pass', score: 0.9 }],
      now: '2026-07-01T15:00:00.000Z',
    });
    persist(scored.scorecard, scored.signals);

    // needs-scoring resolved; the failing-AC-2 regression is still open (real).
    expect(openSignals(root)).toEqual([`regression:${SPEC}:AC-2`]);

    // ── Day 3: the failing criterion is renamed AC-2 → AC-2b and fixed. ─────
    // Re-freeze bumps the version + content hash. The deterministic tick reads
    // the NEW spec: AC-2 is gone, AC-2b passes, AC-3 unchanged (its files did
    // not move, so its day-1 soft pass carries forward FRESH).
    const v2: SpecObservation = {
      specId: SPEC,
      specVersion: 2,
      specHash: 'hash-v2',
      codeChanged: false,
      criteria: [
        { id: 'AC-1', tier: 'hard', status: 'pass' },
        { id: 'AC-2b', tier: 'hard', status: 'pass' },
        { id: 'AC-3', tier: 'soft', status: 'unscored' },
      ],
    };
    const tick2 = reconcileScorecard({
      prev: loadScorecard(root)!,
      observations: [v2],
      now: '2026-07-03T09:00:00.000Z',
    });
    persist(tick2.scorecard, tick2.signals);

    // (1)+(3): the queue is fully drained — the renamed-because-failing
    // criterion's regression was swept as a zombie, not left wedged open.
    expect(openSignals(root)).toEqual([]);

    const sc = loadScorecard(root)!;
    // (2): no zombies — AC-2 is GONE, replaced by AC-2b; AC-3 kept its pass.
    expect(Object.keys(sc.specs[SPEC].criteria).sort()).toEqual(['AC-1', 'AC-2b', 'AC-3']);
    expect(sc.specs[SPEC].criteria['AC-3'].status).toBe('pass');
    expect(sc.specs[SPEC].criteria['AC-3'].stale).toBeUndefined();

    // Everything blocking now passes → the loop's stop signal is green.
    expect(sc.specs[SPEC].signedOff).toBe(true);
    expect(sc.specs[SPEC].verdict).toBe('pass');

    // The re-freeze itself is recorded as a standalone RESOLVED notice — it
    // documents the baseline rebuild without ever counting as an open task.
    const specChanged = loadSignals(root).find((s) => s.kind === 'spec-changed');
    expect(specChanged?.status).toBe('resolved');
  });
});
