/**
 * dashboard-publish — the on-disk artifact contract. Load-bearing properties:
 *   - DETERMINISM: building the snapshot twice with the same injected clock and
 *     writing both yields byte-identical snapshot.json bytes (the artifact is
 *     committed — two publishes of an unchanged project must not diff).
 *   - TOLERANCE: a missing/corrupt/foreign-version snapshot.json reads as null,
 *     never throws (dev B's clone must open, never crash).
 *   - The default output dir is gitignored; `.validity/published/` is NOT.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDashboardSnapshot,
  buildEmbeddedHistory,
  publishedDashboardDir,
  readDashboardSnapshot,
  trimEmbeddedHistoryForCommit,
  withPublishMetadata,
  writeDashboardSnapshot,
  type PublishedSnapshot,
} from './index.js';
import { ensureValidityGitignore } from './runs.js';
import { parseSpec, writeSpec, type SpecCriterion } from './index.js';

const NOW = '2026-07-01T12:00:00.000Z';
const CRIT: SpecCriterion = {
  id: 'AC-1',
  text: 'button renders',
  tier: 'hard',
  checks: [{ expect: { console: { errors: 0 } } }],
} as unknown as SpecCriterion;

function tmpProject(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-dashboard-publish-'));
}

let root: string;

beforeEach(() => {
  root = tmpProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Minimal populated fixture: one frozen spec with a passing scorecard entry. */
function seedProject(dir: string): void {
  const spec = parseSpec({
    id: 'spec-a',
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    criteria: [CRIT],
    createdAt: '2026-06-01T00:00:00.000Z',
  });
  writeSpec(dir, spec);
  const scorecard = {
    version: 1,
    updatedAt: '2026-06-15T00:00:00.000Z',
    specs: {
      'spec-a': {
        specVersion: 1,
        specHash: 'h',
        verdict: 'pass',
        signedOff: true,
        coveragePercent: 100,
        updatedAt: '2026-06-15T00:00:00.000Z',
        criteria: { 'AC-1': { tier: 'hard', status: 'pass', at: '2026-06-15T00:00:00.000Z' } },
      },
    },
  };
  writeFileSync(resolve(dir, '.validity', 'scorecard.json'), JSON.stringify(scorecard) + '\n');
}

describe('writeDashboardSnapshot / readDashboardSnapshot', () => {
  it('is deterministic: same injected clock ⇒ byte-identical snapshot.json', () => {
    seedProject(root);
    const a = JSON.parse(
      readFileSync(
        writeDashboardSnapshot(
          root,
          withPublishMetadata(
            root,
            buildDashboardSnapshot(root, { now: NOW, includeDetail: true }),
          ),
          {
            dir: resolve(root, 'outA'),
          },
        ),
        'utf-8',
      ),
    );
    // Rebuild in a second directory — every disk read + git spawn happens again.
    const b = JSON.parse(
      readFileSync(
        writeDashboardSnapshot(
          root,
          withPublishMetadata(
            root,
            buildDashboardSnapshot(root, { now: NOW, includeDetail: true }),
          ),
          {
            dir: resolve(root, 'outB'),
          },
        ),
        'utf-8',
      ),
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.publishedBy.at).toBe(NOW);
    expect(typeof a.publishedBy.origin).toBe('string');
    // No hostname / no username anywhere in the artifact (privacy rule).
    expect(JSON.stringify(a)).not.toMatch(/hostname|username|USER=|LOGNAME/i);
  });

  it('round-trips through readDashboardSnapshot and rejects foreign versions', () => {
    seedProject(root);
    const path = writeDashboardSnapshot(
      root,
      withPublishMetadata(root, buildDashboardSnapshot(root, { now: NOW, includeDetail: true })),
    );
    const parsed = readDashboardSnapshot(path);
    expect(parsed).not.toBeNull();
    expect(parsed!.version).toBe(1);
    expect(parsed!.specs[0]!.detail).toBeDefined();

    // Default (live path): detail is NOT embedded — the server reads disk.
    const live = buildDashboardSnapshot(root);
    expect(live.specs[0]!.detail).toBeUndefined();

    writeFileSync(path, JSON.stringify({ version: 99 }) + '\n');
    expect(readDashboardSnapshot(path)).toBeNull();
    expect(readDashboardSnapshot(resolve(root, 'nope', 'missing.json'))).toBeNull();
    writeFileSync(path, '{not json');
    expect(readDashboardSnapshot(path)).toBeNull();
  });

  it('trims --commit-ready embedded history to the 90-day window', () => {
    seedProject(root);
    const snap = withPublishMetadata(
      root,
      buildDashboardSnapshot(root, { now: NOW, includeDetail: true }),
    );
    snap.embeddedHistory = {
      score: [
        {
          at: '2026-01-01T00:00:00.000Z',
          score: 50,
          perSpec: {},
          source: 'watch',
          scoreVersion: 1,
        },
        {
          at: '2026-06-30T00:00:00.000Z',
          score: 90,
          perSpec: {},
          source: 'watch',
          scoreVersion: 1,
        },
      ],
      signals: [],
      specs: {
        'spec-a': [
          {
            v: 1,
            specId: 'spec-a',
            runId: 'r-old',
            createdAt: '2026-01-01T00:00:00.000Z',
            verdict: 'pass',
            counts: { pass: 1, fail: 0, unverifiable: 0 },
          },
          {
            v: 1,
            specId: 'spec-a',
            runId: 'r-new',
            createdAt: '2026-06-30T00:00:00.000Z',
            verdict: 'pass',
            counts: { pass: 1, fail: 0, unverifiable: 0 },
          },
        ],
      },
    };
    const trimmed = trimEmbeddedHistoryForCommit(snap) as PublishedSnapshot;
    expect(trimmed.embeddedHistory!.score.map((r) => r.at)).toEqual(['2026-06-30T00:00:00.000Z']);
    expect(trimmed.embeddedHistory!.specs['spec-a']!.map((r) => r.runId)).toEqual(['r-new']);
  });

  it('buildEmbeddedHistory caps at the trend windows and tolerates missing ledgers', () => {
    seedProject(root);
    const eh = buildEmbeddedHistory(root, ['spec-a', 'spec-none']);
    expect(eh.score).toEqual([]);
    expect(eh.signals).toEqual([]);
    expect(eh.specs['spec-a']).toEqual([]);
    expect(eh.specs['spec-none']).toEqual([]);
  });
});

describe('.validity/.gitignore posture', () => {
  it('ignores /dashboard/ but NOT /published/', () => {
    ensureValidityGitignore(root);
    const gi = readFileSync(resolve(root, '.validity', '.gitignore'), 'utf-8');
    expect(gi).toContain('/dashboard/');
    expect(gi).not.toContain('/published/');
    expect(existsSync(publishedDashboardDir(root))).toBe(false);
  });

  it('retrofits /dashboard/ into an existing ignore file additively', () => {
    ensureValidityGitignore(root);
    ensureValidityGitignore(root); // idempotent
    const gi = readFileSync(resolve(root, '.validity', '.gitignore'), 'utf-8');
    expect(gi.match(/\/dashboard\//g)?.length).toBe(1);
  });
});
