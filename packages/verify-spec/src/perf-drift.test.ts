/**
 * End-to-end tests for `refreshPerfDrift` — the IO composition between the
 * per-spec runs.jsonl timeline and signals.json. The pure detector's rules are
 * covered in scorecard.test.ts; here we prove the file plumbing: signals
 * persist, re-fires update in place, recoveries flip the same id, and IO
 * failure is silent (advisory data must never break a verify).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refreshPerfDrift } from './perf-drift.js';
import { loadSignals } from './scorecard.js';
import type { SpecRunSummary } from './run.js';

const SPEC_ID = 'spec-perf';

function seedRuns(projectRoot: string, rows: Array<Partial<SpecRunSummary>>): void {
  const dir = resolve(projectRoot, '.validity', 'specs', SPEC_ID);
  mkdirSync(dir, { recursive: true });
  const lines = rows.map((r, i) =>
    JSON.stringify({
      runId: `run_${i}`,
      createdAt: `2026-01-0${(i % 9) + 1}T00:00:00.000Z`,
      verdict: 'pass',
      counts: { pass: 1, fail: 0, unverifiable: 0 },
      ...r,
    }),
  );
  writeFileSync(resolve(dir, 'runs.jsonl'), lines.join('\n') + '\n');
}

const perfRow = (mountMs: number): Partial<SpecRunSummary> => ({
  perf: { Button__base__base__default: { mountMs } },
});

describe('refreshPerfDrift', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-perf-drift-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('persists one open perf-drift signal for a degraded latest run, updating in place on re-fire', () => {
    seedRuns(projectRoot, [
      perfRow(5),
      perfRow(5),
      perfRow(5),
      perfRow(5),
      perfRow(5),
      perfRow(20),
    ]);
    const fresh = refreshPerfDrift(projectRoot, SPEC_ID);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.kind).toBe('perf-drift');
    expect(fresh[0]!.severity).toBe('low');
    expect(fresh[0]!.perfKey).toBe('Button__base__base__default');

    let stored = loadSignals(projectRoot);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe('open');

    // Unchanged timeline → same-id re-fire, still exactly one stored signal.
    refreshPerfDrift(projectRoot, SPEC_ID);
    stored = loadSignals(projectRoot);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(fresh[0]!.id);
  });

  it('flips the same signal id to resolved when the latest run recovers', () => {
    seedRuns(projectRoot, [
      perfRow(5),
      perfRow(5),
      perfRow(5),
      perfRow(5),
      perfRow(5),
      perfRow(20),
    ]);
    const [open] = refreshPerfDrift(projectRoot, SPEC_ID);

    seedRuns(projectRoot, [
      perfRow(5),
      perfRow(5),
      perfRow(5),
      perfRow(5),
      perfRow(20),
      perfRow(5),
    ]);
    const fresh = refreshPerfDrift(projectRoot, SPEC_ID);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.id).toBe(open!.id);
    expect(fresh[0]!.status).toBe('resolved');

    const stored = loadSignals(projectRoot);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe('resolved');
  });

  it('returns [] (and writes nothing) when there is no history, and never throws on a missing project dir', () => {
    expect(refreshPerfDrift(projectRoot, SPEC_ID)).toEqual([]);
    expect(loadSignals(projectRoot)).toEqual([]);
    expect(refreshPerfDrift(resolve(projectRoot, 'does-not-exist'), SPEC_ID)).toEqual([]);
  });

  it('a perf-less latest row (URL run / pre-feature) fires nothing and launders nothing', () => {
    seedRuns(projectRoot, [
      perfRow(5),
      perfRow(5),
      perfRow(5),
      perfRow(5),
      perfRow(5),
      perfRow(20),
    ]);
    refreshPerfDrift(projectRoot, SPEC_ID);
    // Latest becomes an unmeasured row: the open signal must stay open.
    seedRuns(projectRoot, [perfRow(5), perfRow(5), perfRow(5), perfRow(5), perfRow(20), {}]);
    expect(refreshPerfDrift(projectRoot, SPEC_ID)).toEqual([]);
    const stored = loadSignals(projectRoot);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe('open');
  });
});
