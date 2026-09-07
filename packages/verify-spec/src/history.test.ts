/**
 * Committed run history (F2): append/read round-trip, runId-keyed last-wins
 * dedupe, merge-conflict tolerance, the gitattributes merge=union ensure, path
 * sanitization, and the can't-false-green passthrough (statuses are never
 * coerced).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendHistoryRow,
  historyDir,
  historyPathFor,
  listHistorySpecIds,
  readHistoryRows,
  signalTransitionRows,
  type HistoryRunRow,
} from './history.js';

describe('signalTransitionRows (shared drift-ledger row builder)', () => {
  const sig = (over: Record<string, unknown>) => ({
    id: 'regression:spec-a:AC-2',
    kind: 'regression',
    severity: 'high',
    specId: 'spec-a',
    criterionId: 'AC-2',
    detail: 'AC-2 regressed',
    ...over,
  });

  it('maps opened + resolved to open/resolved rows and prefers the signal sha', () => {
    const rows = signalTransitionRows(
      [sig({ sha: 'abc123' })],
      [sig({ id: 'regression:spec-a:AC-9', criterionId: 'AC-9' })],
      '2026-07-06T00:00:00.000Z',
      'fallbacksha',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'open', sha: 'abc123', kind: 'regression' });
    // Falls back to the tick sha when the signal carries none.
    expect(rows[1]).toMatchObject({ status: 'resolved', sha: 'fallbacksha', criterionId: 'AC-9' });
    expect(rows.every((r) => r.at === '2026-07-06T00:00:00.000Z')).toBe(true);
  });

  it('returns [] when there are no transitions (steady-state re-fires add nothing)', () => {
    expect(signalTransitionRows([], [], '2026-07-06T00:00:00.000Z')).toEqual([]);
  });
});

describe('history (committed run rows)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-history-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const rowFor = (over: Partial<HistoryRunRow>): HistoryRunRow => ({
    v: 1,
    specId: 'spec-abc',
    runId: 'run_x',
    createdAt: '2026-07-01T10:00:00.000Z',
    verdict: 'pass',
    counts: { pass: 1, fail: 0, unverifiable: 0 },
    ...over,
  });

  it('round-trips every field and sorts ascending by createdAt', () => {
    const later = rowFor({
      runId: 'run_2',
      createdAt: '2026-07-01T11:00:00.000Z',
      specVersion: 2,
      specHash: 'hash-2',
      verdict: 'fail',
      signedOff: false,
      counts: { pass: 1, fail: 1, unverifiable: 0 },
      criteria: [
        { id: 'AC-1', tier: 'hard', status: 'pass' },
        { id: 'AC-2', tier: 'soft', status: 'fail' },
      ],
      sha: 'deadbeef',
      score: 33,
      perf: { button__base__base__default: { mountMs: 12.3 } },
      origin: 'ci',
    });
    // Append newest FIRST to prove the reader re-sorts by createdAt.
    appendHistoryRow(projectRoot, later);
    appendHistoryRow(projectRoot, rowFor({ runId: 'run_1' }));

    const rows = readHistoryRows(projectRoot, 'spec-abc');
    expect(rows.map((r) => r.runId)).toEqual(['run_1', 'run_2']);
    expect(rows[1]).toEqual(later);
  });

  it('dedupes by runId, LAST occurrence in file order wins (both orders)', () => {
    // fail first, pass last → pass survives (the scored re-append).
    appendHistoryRow(projectRoot, rowFor({ specId: 'spec-a', verdict: 'fail' }));
    appendHistoryRow(projectRoot, rowFor({ specId: 'spec-a', verdict: 'pass' }));
    expect(readHistoryRows(projectRoot, 'spec-a').map((r) => r.verdict)).toEqual(['pass']);

    // pass first, fail last → fail survives (last-wins is positional, not lattice).
    appendHistoryRow(projectRoot, rowFor({ specId: 'spec-b', verdict: 'pass' }));
    appendHistoryRow(projectRoot, rowFor({ specId: 'spec-b', verdict: 'fail' }));
    expect(readHistoryRows(projectRoot, 'spec-b').map((r) => r.verdict)).toEqual(['fail']);
  });

  it('tolerates git conflict markers and malformed lines between valid rows', () => {
    appendHistoryRow(projectRoot, rowFor({ runId: 'run_1' }));
    const path = historyPathFor(projectRoot, 'spec-abc');
    writeFileSync(
      path,
      readFileSync(path, 'utf-8') +
        '<<<<<<< HEAD\n' +
        '{not json at all\n' +
        '=======\n' +
        '||||||| merged common ancestors\n' +
        '{"noRunIdHere":true}\n' +
        '>>>>>>> other-branch\n' +
        JSON.stringify(rowFor({ runId: 'run_2', createdAt: '2026-07-01T11:00:00.000Z' })) +
        '\n',
    );
    const rows = readHistoryRows(projectRoot, 'spec-abc');
    expect(rows.map((r) => r.runId)).toEqual(['run_1', 'run_2']);
  });

  it('caps reads at `limit`, keeping the newest rows', () => {
    for (let i = 0; i < 5; i += 1) {
      appendHistoryRow(
        projectRoot,
        rowFor({ runId: `run_${i}`, createdAt: `2026-07-01T10:0${i}:00.000Z` }),
      );
    }
    expect(readHistoryRows(projectRoot, 'spec-abc', 2).map((r) => r.runId)).toEqual([
      'run_3',
      'run_4',
    ]);
  });

  it('writes the merge=union gitattribute exactly once across appends', () => {
    appendHistoryRow(projectRoot, rowFor({ runId: 'run_1' }));
    appendHistoryRow(projectRoot, rowFor({ runId: 'run_2' }));
    const content = readFileSync(resolve(projectRoot, '.validity', '.gitattributes'), 'utf-8');
    expect(
      content.split('\n').filter((l) => l.trim() === 'history/*.jsonl merge=union'),
    ).toHaveLength(1);
  });

  it('adds the union line additively to an existing user .gitattributes', () => {
    const gaPath = resolve(projectRoot, '.validity', '.gitattributes');
    mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
    writeFileSync(gaPath, '*.png binary'); // user content, no trailing newline
    appendHistoryRow(projectRoot, rowFor({}));
    const content = readFileSync(gaPath, 'utf-8');
    expect(content).toContain('*.png binary');
    expect(content).toContain('history/*.jsonl merge=union');
  });

  it('sanitizes a path-traversal specId inside .validity/history/', () => {
    const path = historyPathFor(projectRoot, '../../evil');
    expect(path.startsWith(historyDir(projectRoot) + '/')).toBe(true);
    appendHistoryRow(projectRoot, rowFor({ specId: '../../evil' }));
    expect(existsSync(resolve(projectRoot, '..', 'evil.jsonl'))).toBe(false);
    expect(readHistoryRows(projectRoot, '../../evil')).toHaveLength(1);
  });

  it("can't-false-green: a fabricated criterion status round-trips uncoerced", () => {
    // Simulate a hand-edited row: an unknown status must deserialize AS-IS —
    // downstream renderers map only exact matches, so 'bogus' can't turn green.
    mkdirSync(historyDir(projectRoot), { recursive: true });
    const raw = { ...rowFor({}), criteria: [{ id: 'AC-1', tier: 'hard', status: 'bogus' }] };
    writeFileSync(historyPathFor(projectRoot, 'spec-abc'), JSON.stringify(raw) + '\n');
    const rows = readHistoryRows(projectRoot, 'spec-abc');
    expect(rows[0]!.criteria).toEqual([{ id: 'AC-1', tier: 'hard', status: 'bogus' }]);
  });

  it("listHistorySpecIds lists spec files but never F1's score.jsonl", () => {
    appendHistoryRow(projectRoot, rowFor({ specId: 'spec-a' }));
    appendHistoryRow(projectRoot, rowFor({ specId: 'spec-b' }));
    writeFileSync(resolve(historyDir(projectRoot), 'score.jsonl'), '{"at":"x","score":50}\n');
    expect(listHistorySpecIds(projectRoot)).toEqual(['spec-a', 'spec-b']);
  });

  it('missing file / missing dir read as empty, never throw', () => {
    expect(readHistoryRows(projectRoot, 'spec-none')).toEqual([]);
    expect(listHistorySpecIds(projectRoot)).toEqual([]);
  });
});
