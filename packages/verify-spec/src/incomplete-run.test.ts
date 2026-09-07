/**
 * Incomplete-run marker (B5).
 *
 * A verify child killed mid-render (OOM, Ctrl-C, CI timeout) used to leave a
 * run directory with screenshots and no run-meta — invisible to every reader,
 * indistinguishable from a run that never started. The start marker makes the
 * crash a fact on disk; the rule that matters is that it is SURFACED and never
 * counted as a pass or a fail, and that it leaves the scorecard alone.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearInflightMarker,
  inflightDir,
  readIncompleteRuns,
  readRunMeta,
  readSpecRunHistory,
  writeInflightMarker,
  writeStartRunMeta,
} from './index.js';
import { loadScorecard } from './scorecard.js';

const RUN_ID = 'run_1700000000000_aaaa1111';

describe('writeStartRunMeta + readIncompleteRuns', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-incomplete-'));
  });

  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  function startRun(): void {
    writeInflightMarker(projectRoot, {
      runId: RUN_ID,
      mode: 'isolation',
      specId: 'spec-x',
      startedAt: '2026-04-01T00:00:00.000Z',
    });
    writeStartRunMeta({
      projectRoot,
      runId: RUN_ID,
      mode: 'isolation',
      prompt: 'verify the card',
      specId: 'spec-x',
    });
  }

  it('CRASH: a start marker with no in-flight marker reads as incomplete', () => {
    startRun();
    // The child dies here — its `finally` never runs… except the marker IS
    // removed by the parent process's finally / submit_report backstop.
    clearInflightMarker(projectRoot, RUN_ID);

    const rows = readIncompleteRuns(projectRoot);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runId).toBe(RUN_ID);
    expect(rows[0]!.status).toBe('incomplete');
    // NEVER a pass or a fail: an incomplete run decided nothing.
    expect(rows[0]!.verdict).toBe('unknown');
    expect(rows[0]!.counts).toEqual({ pass: 0, fail: 0, unverifiable: 0 });
    // …and the scorecard was never touched — the fold only runs at the end.
    expect(loadScorecard(projectRoot)).toBeNull();
  });

  it('STILL RUNNING: an in-progress run keeping its in-flight marker is NOT incomplete', () => {
    startRun();
    expect(readIncompleteRuns(projectRoot)).toEqual([]);
    // The live "◍ verifying" state is the in-flight marker's job, not this one's.
    expect(readRunMeta(projectRoot, RUN_ID)!.status).toBe('in-progress');
  });

  it('FINISHED: the mode handler overwriting run-meta clears the marker semantics', () => {
    startRun();
    clearInflightMarker(projectRoot, RUN_ID);
    // The real run-meta omits `status` entirely — absence means complete.
    const meta = readRunMeta(projectRoot, RUN_ID)!;
    delete meta.status;
    writeFileSync(
      resolve(projectRoot, '.validity', 'runs', RUN_ID, 'run-meta.json'),
      JSON.stringify(meta, null, 2),
    );
    expect(readIncompleteRuns(projectRoot)).toEqual([]);
  });

  it('filters by spec, and tolerates a missing runs dir / corrupt run-meta', () => {
    startRun();
    clearInflightMarker(projectRoot, RUN_ID);
    expect(readIncompleteRuns(projectRoot, { specId: 'spec-x' })).toHaveLength(1);
    expect(readIncompleteRuns(projectRoot, { specId: 'spec-other' })).toEqual([]);

    const fresh = mkdtempSync(resolve(tmpdir(), 'validity-incomplete-empty-'));
    try {
      expect(readIncompleteRuns(fresh)).toEqual([]);
      const corruptDir = resolve(fresh, '.validity', 'runs', 'run_1700000000001_bbbb2222');
      mkdirSync(corruptDir, { recursive: true });
      writeFileSync(resolve(corruptDir, 'run-meta.json'), '{ not json');
      expect(readIncompleteRuns(fresh)).toEqual([]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('readSpecRunHistory SURFACES the crashed run alongside the completed timeline', () => {
    startRun();
    clearInflightMarker(projectRoot, RUN_ID);
    const history = readSpecRunHistory(projectRoot, 'spec-x', 5);
    expect(history.map((r) => r.runId)).toContain(RUN_ID);
    const row = history.find((r) => r.runId === RUN_ID)!;
    expect(row.status).toBe('incomplete');
    expect(row.verdict).toBe('unknown');
    // Nothing else invented a row for a spec with no timeline of its own.
    expect(readSpecRunHistory(projectRoot, 'spec-unrelated', 5)).toEqual([]);
  });

  it('the in-flight directory is left alone by the start marker', () => {
    startRun();
    expect(inflightDir(projectRoot).endsWith('inflight')).toBe(true);
  });
});
