/**
 * Tests for run-retention planning (W5 #16) and the `.validity/.gitignore`
 * contract (W5 #15). `selectRunsToPrune` is pure, so it's exercised without
 * touching disk; the gitignore test uses a temp project root.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ensureValidityGitignore, selectRunsToPrune } from './runs.js';

const NOW = '2026-07-02T00:00:00.000Z';
const daysAgo = (n: number): string =>
  new Date(Date.parse(NOW) - n * 24 * 60 * 60 * 1000).toISOString();

describe('selectRunsToPrune (W5 #16)', () => {
  it('keeps the most-recent N per spec and prunes the rest (default keep=10)', () => {
    const runIds = Array.from({ length: 15 }, (_, i) => `run_${i}`); // oldest→newest
    const { keep, remove } = selectRunsToPrune({
      allRunIds: runIds,
      perSpecRunIds: { 'spec-a': runIds },
      createdAt: {},
      now: NOW,
    });
    expect(keep).toHaveLength(10);
    expect(remove).toHaveLength(5);
    // The five OLDEST are pruned; the ten newest kept.
    expect(remove).toEqual(['run_0', 'run_1', 'run_2', 'run_3', 'run_4']);
    expect(keep).toContain('run_14');
  });

  it('honors an explicit keep count', () => {
    const runIds = ['a', 'b', 'c', 'd'];
    const { keep, remove } = selectRunsToPrune({
      allRunIds: runIds,
      perSpecRunIds: { s: runIds },
      createdAt: {},
      keep: 2,
      now: NOW,
    });
    expect(keep).toEqual(['c', 'd']);
    expect(remove).toEqual(['a', 'b']);
  });

  it('always keeps at least the newest run per spec (keep clamped to >= 1)', () => {
    const { keep, remove } = selectRunsToPrune({
      allRunIds: ['old', 'new'],
      perSpecRunIds: { s: ['old', 'new'] },
      createdAt: {},
      keep: 0,
      now: NOW,
    });
    expect(keep).toContain('new');
    expect(remove).toEqual(['old']);
  });

  it('--older-than spares runs newer than the cutoff even beyond the keep count', () => {
    const runIds = ['r_old', 'r_recent', 'r_new'];
    const { keep, remove } = selectRunsToPrune({
      allRunIds: runIds,
      perSpecRunIds: { s: runIds },
      createdAt: {
        r_old: daysAgo(30),
        r_recent: daysAgo(3),
        r_new: daysAgo(1),
      },
      keep: 1, // keep-count alone would drop r_old AND r_recent
      olderThanMs: 7 * 24 * 60 * 60 * 1000, // but only >7d-old runs are eligible
      now: NOW,
    });
    // r_recent is 3d old → spared by the cutoff; only the 30d-old run is pruned.
    expect(remove).toEqual(['r_old']);
    expect(keep).toEqual(expect.arrayContaining(['r_recent', 'r_new']));
  });

  it('prunes orphan runs (in no spec timeline) with unknown age', () => {
    const { keep, remove } = selectRunsToPrune({
      allRunIds: ['tracked', 'orphan'],
      perSpecRunIds: { s: ['tracked'] },
      createdAt: {},
      now: NOW,
    });
    expect(keep).toEqual(['tracked']);
    expect(remove).toEqual(['orphan']);
  });
});

describe('ensureValidityGitignore — native-app is ignored (W5 #15)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-gi-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a fresh .gitignore excludes /native-app/', () => {
    ensureValidityGitignore(root);
    const gi = readFileSync(resolve(root, '.validity', '.gitignore'), 'utf-8');
    expect(gi).toContain('/native-app/');
  });

  it('retrofits /native-app/ into an existing .gitignore that lacks it', () => {
    const dir = resolve(root, '.validity');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, '.gitignore'), '/runs/\n/baselines/\n');
    ensureValidityGitignore(root);
    const gi = readFileSync(resolve(dir, '.gitignore'), 'utf-8');
    expect(gi).toContain('/native-app/');
    // Existing lines are preserved (additive, never clobbered).
    expect(gi).toContain('/runs/');
  });
});

describe('ensureValidityGitignore — scorecard/signals are derived, not committed (W6 #21)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-gi-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a fresh .gitignore excludes scorecard.json + signals.json', () => {
    ensureValidityGitignore(root);
    const gi = readFileSync(resolve(root, '.validity', '.gitignore'), 'utf-8');
    expect(gi).toContain('scorecard.json');
    expect(gi).toContain('signals.json');
    expect(gi).toContain('history/signals.jsonl');
  });

  it('historyCommitted: true does not ignore history/signals.jsonl', () => {
    ensureValidityGitignore(root, { historyCommitted: true });
    const gi = readFileSync(resolve(root, '.validity', '.gitignore'), 'utf-8');
    const entries = gi
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(entries).not.toContain('history/signals.jsonl');
  });

  it('with historyCommitted: true, alternating with/without opts never re-adds the feed line', () => {
    ensureValidityGitignore(root, { historyCommitted: true });
    ensureValidityGitignore(root);
    ensureValidityGitignore(root, { historyCommitted: true });
    ensureValidityGitignore(root);
    const entries = readFileSync(resolve(root, '.validity', '.gitignore'), 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(entries).not.toContain('history/signals.jsonl');
  });

  it('retrofits the derived-state lines into a pre-derive .gitignore', () => {
    const dir = resolve(root, '.validity');
    mkdirSync(dir, { recursive: true });
    // A .gitignore from before the derive posture — had no scorecard/signals lines.
    writeFileSync(resolve(dir, '.gitignore'), '/runs/\n/baselines/\n/native-app/\n');
    ensureValidityGitignore(root);
    const gi = readFileSync(resolve(dir, '.gitignore'), 'utf-8');
    expect(gi).toContain('scorecard.json');
    expect(gi).toContain('signals.json');
    expect(gi).toContain('/runs/');
  });
});
