/**
 * `validity trends` at the JS function boundary (export.test.ts conventions):
 * fixture `.validity/` trees → assert the written HTML + the viewer-not-gate
 * posture (exit 0 on an all-fail timeline; the command never writes under
 * `.validity/history/`).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendHistoryRow,
  saveScorecard,
  saveSignals,
  type HistoryRunRow,
  type Scorecard,
  type Signal,
  type SpecRunSummary,
} from '@validity.ai/verify-spec';
import { runTrends } from './trends.js';

function makeProject(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-trends-cli-'));
}

function seedLocalRows(root: string, specId: string, rows: Array<Partial<SpecRunSummary>>): void {
  const dir = resolve(root, '.validity', 'specs', specId);
  mkdirSync(dir, { recursive: true });
  const lines = rows.map((over, i) =>
    JSON.stringify({
      runId: `run_${i}`,
      createdAt: `2026-07-01T10:0${i}:00.000Z`,
      verdict: 'pass',
      counts: { pass: 1, fail: 0, unverifiable: 0 },
      ...over,
    }),
  );
  writeFileSync(resolve(dir, 'runs.jsonl'), lines.join('\n') + '\n');
  // A spec.yaml is NOT written — trends must work from the timeline alone.
}

function committedRow(specId: string, over: Partial<HistoryRunRow>): HistoryRunRow {
  return {
    v: 1,
    specId,
    runId: 'run_c',
    createdAt: '2026-07-01T09:00:00.000Z',
    verdict: 'fail',
    counts: { pass: 0, fail: 1, unverifiable: 0 },
    ...over,
  };
}

describe('runTrends', () => {
  let root: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stdoutBuf: string;

  beforeEach(() => {
    root = makeProject();
    stdoutBuf = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutBuf += String(chunk);
      return true;
    }) as never;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('writes a friendly empty-state trends.html (exit 0) when there is no history', async () => {
    await runTrends({ cwd: root });
    const out = resolve(root, '.validity', 'reports', 'trends.html');
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf-8')).toContain('No spec history yet');
    expect(stdoutBuf).toContain('no spec history yet');
    // Points the reader at the served counterpart when relevant.
    expect(stdoutBuf).toContain('/trends');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('renders local-only timelines and honors --out and --limit', async () => {
    seedLocalRows(root, 'spec-a', [
      { runId: 'run_0', verdict: 'fail', counts: { pass: 0, fail: 1, unverifiable: 0 } },
      { runId: 'run_1', verdict: 'pass' },
      { runId: 'run_2', verdict: 'pass', signedOff: true },
    ]);
    const out = resolve(root, 'custom-trends.html');
    await runTrends({ cwd: root, out, limit: 2 });
    const html = readFileSync(out, 'utf-8');
    expect(html).toContain('spec-a');
    // limit=2 keeps the NEWEST rows: run_1/run_2 chart, run_0 does not.
    expect(html).toContain('run_2');
    expect(html).not.toContain('run_0');
    expect(stdoutBuf).toContain(out);
  });

  it('filters to --spec ids', async () => {
    seedLocalRows(root, 'spec-a', [{ runId: 'run_a' }]);
    seedLocalRows(root, 'spec-b', [{ runId: 'run_b' }]);
    await runTrends({ cwd: root, specs: ['spec-b'] });
    const html = readFileSync(resolve(root, '.validity', 'reports', 'trends.html'), 'utf-8');
    expect(html).toContain('spec-b');
    expect(html).not.toContain('spec-a');
  });

  it('merges committed history: local wins on shared runIds, committed-only rows/specs appear', async () => {
    // Shared runId: local says pass, committed (stale twin) says fail — local wins.
    seedLocalRows(root, 'spec-a', [{ runId: 'run_shared', verdict: 'pass' }]);
    appendHistoryRow(
      root,
      committedRow('spec-a', { runId: 'run_shared', createdAt: '2026-07-01T10:00:00.000Z' }),
    );
    // Committed-only run for the same spec.
    appendHistoryRow(root, committedRow('spec-a', { runId: 'run_committed_only' }));
    // Committed-only SPEC (no specs/<id>/ dir on this machine).
    appendHistoryRow(root, committedRow('spec-gone', { runId: 'run_gone' }));

    await runTrends({ cwd: root });
    const html = readFileSync(resolve(root, '.validity', 'reports', 'trends.html'), 'utf-8');

    // Dedupe: the shared run appears exactly once, with the LOCAL verdict.
    expect(html.split('run_shared').length - 1).toBe(1);
    expect(html).toContain('run_shared · 2026-07-01T10:00:00.000Z · pass');
    expect(html).toContain('run_committed_only');
    // The pruned spec still charts, badged as committed-history-only.
    expect(html).toContain('spec-gone');
    expect(html).toContain('spec file not present on this machine');
  });

  it('viewer, never a gate: an all-fail timeline still exits 0 and writes nothing to history/', async () => {
    seedLocalRows(root, 'spec-red', [
      { runId: 'run_0', verdict: 'fail', counts: { pass: 0, fail: 2, unverifiable: 0 } },
      { runId: 'run_1', verdict: 'fail', counts: { pass: 0, fail: 2, unverifiable: 0 } },
    ]);
    await runTrends({ cwd: root });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(existsSync(resolve(root, '.validity', 'reports', 'trends.html'))).toBe(true);
    // Read-only over .validity/history/ — the viewer never changes repo posture.
    expect(existsSync(resolve(root, '.validity', 'history'))).toBe(false);
    // And the only artifact written is the HTML itself, in the sibling
    // reports/ tree (W5 #19) — never into the prunable runs/ tree.
    expect(readdirSync(resolve(root, '.validity', 'reports'))).toEqual(['trends.html']);
    expect(existsSync(resolve(root, '.validity', 'runs'))).toBe(false);
  });

  it('renders the scorecard standing and the signal history (including recovered)', async () => {
    seedLocalRows(root, 'spec-a', [{ runId: 'run_0', signedOff: true }]);
    const scorecard: Scorecard = {
      version: 1,
      updatedAt: '2026-07-01T12:00:00.000Z',
      specs: {
        'spec-a': {
          specVersion: 1,
          verdict: 'pass',
          signedOff: true,
          coveragePercent: 100,
          criteria: {
            'AC-1': { id: 'AC-1', tier: 'hard', status: 'pass', updatedAt: 'x' },
          } as Scorecard['specs'][string]['criteria'],
          updatedAt: '2026-07-01T12:00:00.000Z',
        },
      },
    };
    saveScorecard(root, scorecard);
    const signals: Signal[] = [
      {
        id: 'recovered:spec-a:AC-1',
        kind: 'recovered',
        severity: 'info',
        specId: 'spec-a',
        criterionId: 'AC-1',
        detail: 'AC-1 is passing again',
        at: '2026-07-01T11:00:00.000Z',
        status: 'resolved',
      },
    ];
    saveSignals(root, signals);

    await runTrends({ cwd: root });
    const html = readFileSync(resolve(root, '.validity', 'reports', 'trends.html'), 'utf-8');
    expect(html).toContain('signed off');
    expect(html).toContain('AC-1 is passing again');
    // The scorecard feeds the current Validity Score header.
    expect(html).toContain('Validity Score');
  });
});
