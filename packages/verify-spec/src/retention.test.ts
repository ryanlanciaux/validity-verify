/**
 * Tests for per-spec run-ARTIFACT retention (`config.retention`) — the
 * automatic companion to `validity clean`. The planner is pure; the apply and
 * window checks use a temp project root with real spec dirs + runs.jsonl
 * timelines, asserting the durable invariants: run-meta.json and timelines are
 * NEVER touched, the newest run always keeps everything, and off-timeline runs
 * are out of jurisdiction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  applyArtifactRetention,
  readPerSpecRunTimelines,
  selectArtifactsToPrune,
  withinReportRetention,
} from './retention.js';
import { writeSpec } from './specs.js';
import { parseSpec } from './spec-schema.js';
import { runDir } from './runs.js';

describe('selectArtifactsToPrune (pure planner)', () => {
  it('prunes runs older than the window, newest-first per spec', () => {
    const plan = selectArtifactsToPrune({
      perSpecRunIds: { 'spec-a': ['r1', 'r2', 'r3', 'r4'] },
      retention: { images: 2, reports: 3 },
    });
    expect(plan.pruneImages).toEqual(['r1', 'r2']);
    expect(plan.pruneReports).toEqual(['r1']);
  });

  it('an unset window prunes nothing for that artifact class', () => {
    const plan = selectArtifactsToPrune({
      perSpecRunIds: { 'spec-a': ['r1', 'r2', 'r3'] },
      retention: { reports: 1 },
    });
    expect(plan.pruneImages).toEqual([]);
    expect(plan.pruneReports).toEqual(['r1', 'r2']);
  });

  it('clamps the window to >= 1 — the newest run always keeps its artifacts', () => {
    const plan = selectArtifactsToPrune({
      perSpecRunIds: { 'spec-a': ['r1', 'r2'] },
      retention: { images: 0, reports: 0 },
    });
    expect(plan.pruneImages).toEqual(['r1']);
    expect(plan.pruneReports).toEqual(['r1']);
  });

  it('union-keep: a run on two timelines survives if ANY spec window keeps it', () => {
    const plan = selectArtifactsToPrune({
      // r-shared is old for spec-a but the NEWEST run of spec-b.
      perSpecRunIds: { 'spec-a': ['r-shared', 'r2', 'r3'], 'spec-b': ['r-shared'] },
      retention: { images: 1 },
    });
    expect(plan.pruneImages).toEqual(['r2']);
  });
});

describe('applyArtifactRetention + withinReportRetention (temp project)', () => {
  let projectRoot: string;

  const spec = (id: string) =>
    parseSpec({
      id,
      version: 1,
      status: 'frozen',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      criteria: [{ id: 'AC-1', text: 'renders', tier: 'soft' }],
      createdAt: '2026-07-01T00:00:00.000Z',
    });

  /** One run dir with every prunable artifact + the untouchable run-meta. */
  const seedRun = (runId: string): void => {
    const dir = runDir(projectRoot, runId);
    mkdirSync(resolve(dir, 'screenshots'), { recursive: true });
    writeFileSync(resolve(dir, 'screenshots', 'a.png'), 'png');
    mkdirSync(resolve(dir, 'judge-pack'), { recursive: true });
    writeFileSync(resolve(dir, 'report.html'), '<!doctype html>');
    writeFileSync(resolve(dir, 'report.md'), '# report');
    writeFileSync(resolve(dir, 'run-meta.json'), JSON.stringify({ runId }));
  };

  const appendTimeline = (specId: string, runIds: string[]): void => {
    const path = resolve(projectRoot, '.validity', 'specs', specId, 'runs.jsonl');
    const rows = runIds.map((runId) =>
      JSON.stringify({
        runId,
        createdAt: '2026-07-01T00:00:00.000Z',
        verdict: 'pass',
        counts: { pass: 1, fail: 0, unverifiable: 0 },
      }),
    );
    writeFileSync(path, `${rows.join('\n')}\n`);
  };

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-retention-'));
    mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('prunes artifacts per window but never run-meta or the timeline', () => {
    writeSpec(projectRoot, spec('spec-a'));
    for (const id of ['r1', 'r2', 'r3']) seedRun(id);
    appendTimeline('spec-a', ['r1', 'r2', 'r3']);

    const pruned = applyArtifactRetention(projectRoot, { images: 1, reports: 2 });
    expect(pruned).toEqual({ imagesPruned: 2, reportsPruned: 1 });

    // r1 (oldest): loses images AND report; r2: keeps report, loses images;
    // r3 (newest): keeps everything.
    expect(existsSync(resolve(runDir(projectRoot, 'r1'), 'screenshots'))).toBe(false);
    expect(existsSync(resolve(runDir(projectRoot, 'r1'), 'report.html'))).toBe(false);
    expect(existsSync(resolve(runDir(projectRoot, 'r2'), 'screenshots'))).toBe(false);
    expect(existsSync(resolve(runDir(projectRoot, 'r2'), 'report.html'))).toBe(true);
    expect(existsSync(resolve(runDir(projectRoot, 'r3'), 'screenshots'))).toBe(true);
    expect(existsSync(resolve(runDir(projectRoot, 'r3'), 'report.html'))).toBe(true);

    // The invariants: run-meta and the timeline survive for every run.
    for (const id of ['r1', 'r2', 'r3']) {
      expect(existsSync(resolve(runDir(projectRoot, id), 'run-meta.json'))).toBe(true);
    }
    expect(readPerSpecRunTimelines(projectRoot).perSpec['spec-a']).toEqual(['r1', 'r2', 'r3']);
  });

  it('is idempotent and leaves off-timeline runs alone', () => {
    writeSpec(projectRoot, spec('spec-a'));
    for (const id of ['r1', 'r2', 'orphan']) seedRun(id);
    appendTimeline('spec-a', ['r1', 'r2']); // orphan has no timeline row

    applyArtifactRetention(projectRoot, { images: 1 });
    // Second pass finds nothing left to remove.
    expect(applyArtifactRetention(projectRoot, { images: 1 })).toEqual({
      imagesPruned: 0,
      reportsPruned: 0,
    });
    // The orphan (in-flight / clean's jurisdiction) is untouched.
    expect(existsSync(resolve(runDir(projectRoot, 'orphan'), 'screenshots'))).toBe(true);
  });

  it('withinReportRetention: inside window / outside window / unset window', () => {
    writeSpec(projectRoot, spec('spec-a'));
    appendTimeline('spec-a', ['r1', 'r2', 'r3']);

    expect(withinReportRetention(projectRoot, 'r3', { reports: 2 })).toBe(true);
    expect(withinReportRetention(projectRoot, 'r2', { reports: 2 })).toBe(true);
    expect(withinReportRetention(projectRoot, 'r1', { reports: 2 })).toBe(false);
    // No window configured → always persistable.
    expect(withinReportRetention(projectRoot, 'r1', undefined)).toBe(true);
    expect(withinReportRetention(projectRoot, 'r1', {})).toBe(true);
    // A run on no timeline has nothing worth persisting either.
    expect(withinReportRetention(projectRoot, 'r-nowhere', { reports: 2 })).toBe(false);
  });

  it('de-dupes the verify + scored-twin rows so a duplicate never eats a slot', () => {
    writeSpec(projectRoot, spec('spec-a'));
    // r2 appears twice (verify append + submit twin); the images: 2 window
    // must still cover BOTH unique runs, not r2 twice.
    appendTimeline('spec-a', ['r1', 'r2', 'r2']);
    expect(readPerSpecRunTimelines(projectRoot).perSpec['spec-a']).toEqual(['r1', 'r2']);
    const plan = selectArtifactsToPrune({
      perSpecRunIds: readPerSpecRunTimelines(projectRoot).perSpec,
      retention: { images: 2 },
    });
    expect(plan.pruneImages).toEqual([]);
  });
});
