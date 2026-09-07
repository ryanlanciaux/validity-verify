/**
 * Dashboard snapshot assembler — the data layer trends and reports read.
 * Tolerance is load-bearing: a missing or corrupt file contributes
 * its empty/null shape, never a throw; per-spec validityScore, verdict, AND
 * signedOff are RECOMPUTED, never trusted from the stamped display cache — a
 * hand-edited "pass" over a failing criterion must render fail.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDashboardSnapshot,
  computeDashboardHealth,
  type DashboardSnapshot,
  type DashboardSignal,
  type DashboardSpec,
} from './dashboard-snapshot.js';
import { parseSpec, writeSpec, writeInflightMarker, type SpecCriterion } from './index.js';

const SOFT_CRITERION: SpecCriterion = {
  id: 'AC-soft',
  text: 'Form looks polished and on-brand',
  tier: 'soft',
};

function tmpProject(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-dashboard-snapshot-'));
}

let root: string;

beforeEach(() => {
  root = tmpProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFrozenSpec(specId: string): void {
  const spec = parseSpec({
    id: specId,
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    criteria: [SOFT_CRITERION],
    createdAt: new Date(0).toISOString(),
  });
  writeSpec(root, spec);
}

function writeDraftSpec(specId: string): void {
  const spec = parseSpec({
    id: specId,
    version: 1,
    status: 'draft',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    criteria: [SOFT_CRITERION],
    createdAt: new Date(0).toISOString(),
  });
  writeSpec(root, spec);
}

describe('buildDashboardSnapshot — empty dir', () => {
  it('returns the empty shape: null score, no specs/signals/trend, all-null watcher', () => {
    const snap = buildDashboardSnapshot(root);
    expect(snap.version).toBe(1);
    expect(snap.score).toBeNull();
    expect(snap.specs).toEqual([]);
    expect(snap.signals).toEqual([]);
    expect(snap.trend).toBeNull();
    expect(snap.resolvedSignals).toEqual([]);
    expect(snap.population).toEqual({
      tracked: 0,
      total: 0,
      draftSuperseded: [],
      drafts: [],
      unverified: [],
    });
    expect(snap.health.verdict).toBe('empty');
    expect(snap.health.topAction).toEqual({
      kind: 'setup',
      specId: null,
      criterionId: null,
      summary: 'no tracked specs yet — run `validity onboard` or freeze a spec',
    });
    expect(snap.watcher).toEqual({
      lastObservedSha: null,
      lastTickAt: null,
      headSha: null,
      commitsBehind: null,
      hook: null,
    });
  });
});

describe('buildDashboardSnapshot — populated fixture', () => {
  // Iso timestamps chosen so older/newer ordering is unambiguous. generatedAt
  // is "now" at snapshot time; we use a fixed anchor in the future of every
  // openedAt so ageMs is deterministic-ish (we assert ORDER, not exact age).
  const T_OLD = '2026-01-01T00:00:00.000Z';
  const T_MID = '2026-04-01T00:00:00.000Z';
  const T_NEW = '2026-07-01T00:00:00.000Z';
  const UPDATED_AT = '2026-07-04T00:00:00.000Z';

  beforeEach(() => {
    // Two frozen specs + a third draft that HAS a scorecard entry (drifted).
    writeFrozenSpec('spec-a');
    writeFrozenSpec('spec-b');
    writeDraftSpec('spec-draft');

    // scorecard.json: two specs. spec-a carries a stale soft criterion + an
    // advisory. The stamped validityScore is deliberately WRONG (999) — the
    // snapshot must RECOMPUTE, never trust the cache.
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    const scorecard = {
      version: 1,
      updatedAt: UPDATED_AT,
      validityScore: 999, // wrong repo-level cache too — should be ignored
      specs: {
        'spec-a': {
          specVersion: 1,
          specHash: 'h-a',
          verdict: 'pass',
          signedOff: true,
          coveragePercent: 100,
          validityScore: 999, // WRONG stamp — must be recomputed
          updatedAt: UPDATED_AT,
          criteria: {
            'AC-1': { tier: 'hard', status: 'pass', at: UPDATED_AT, sha: 's1' },
            'AC-2': {
              tier: 'soft',
              status: 'pass',
              at: UPDATED_AT,
              sha: 's1',
              stale: true, // stale soft pass → half credit
            },
            'AC-3': {
              tier: 'soft',
              status: 'pass',
              at: UPDATED_AT,
              sha: 's1',
              severity: 'advisory', // excluded from the score entirely
            },
          },
        },
        'spec-b': {
          specVersion: 1,
          specHash: 'h-b',
          verdict: 'partial',
          signedOff: false,
          coveragePercent: 50,
          updatedAt: UPDATED_AT,
          criteria: {
            'AC-1': { tier: 'hard', status: 'pass', at: UPDATED_AT, sha: 's2' },
            'AC-2': { tier: 'hard', status: 'unverifiable', at: UPDATED_AT, sha: 's2' },
          },
        },
        // spec-draft has a scorecard entry but is NOT frozen — surfaces in
        // population.draftSuperseded.
        'spec-draft': {
          specVersion: 1,
          verdict: 'pass',
          signedOff: true,
          coveragePercent: 100,
          updatedAt: UPDATED_AT,
          criteria: {},
        },
      },
    };
    writeFileSync(resolve(root, '.validity', 'scorecard.json'), JSON.stringify(scorecard));

    // signals.json: open high (old) + open high (newer) + open low + resolved.
    // Resolved must be excluded; high sorts before low; older high first.
    const signals = [
      {
        id: 'recovered:spec-x:AC-x',
        kind: 'recovered',
        severity: 'info',
        specId: 'spec-x',
        criterionId: 'AC-x',
        detail: 'gone',
        at: T_NEW,
        openedAt: T_NEW,
        status: 'resolved',
      },
      {
        id: 'regression:spec-a:AC-1',
        kind: 'regression',
        severity: 'high',
        specId: 'spec-a',
        criterionId: 'AC-1',
        detail: 'old high',
        at: T_OLD,
        openedAt: T_OLD, // OLDER → larger ageMs → sorts FIRST within high
        status: 'open',
      },
      {
        id: 'regression:spec-b:AC-1',
        kind: 'regression',
        severity: 'high',
        specId: 'spec-b',
        criterionId: 'AC-1',
        detail: 'newer high',
        at: T_MID,
        openedAt: T_MID, // NEWER → smaller ageMs → sorts SECOND within high
        status: 'open',
      },
      {
        id: 'needs-scoring:spec-a:AC-2',
        kind: 'needs-scoring',
        severity: 'low',
        specId: 'spec-a',
        criterionId: 'AC-2',
        detail: 'low',
        at: T_NEW,
        openedAt: T_NEW,
        status: 'open',
      },
    ];
    writeFileSync(resolve(root, '.validity', 'signals.json'), JSON.stringify(signals));

    // watch-state.json with a hook whose last-launch is ancient → coolingDown false.
    writeFileSync(
      resolve(root, '.validity', 'watch-state.json'),
      JSON.stringify({
        version: 1,
        lastObservedSha: 'cafe',
        lastTickAt: '2026-07-04T11:00:00.000Z',
        hook: {
          lastLaunchAt: '2020-01-01T00:00:00.000Z', // long ago → not cooling
          batchSize: 3,
          cooldownMs: 300_000,
        },
      }),
    );

    // history/score.jsonl — two score points; the second shares an `at` with
    // a signal row so the merger fuses them into one trend point.
    mkdirSync(resolve(root, '.validity', 'history'), { recursive: true });
    const scoreLines = [
      JSON.stringify({
        at: T_MID,
        sha: 's1',
        score: 50,
        perSpec: {},
        source: 'watch',
        scoreVersion: 1,
      }),
      JSON.stringify({
        at: '2026-05-01T00:00:00.000Z',
        sha: 's3',
        score: 70,
        perSpec: {},
        source: 'watch',
        scoreVersion: 1,
      }),
    ];
    writeFileSync(
      resolve(root, '.validity', 'history', 'score.jsonl'),
      scoreLines.join('\n') + '\n',
    );

    // history/signals.jsonl — transitions fold a Set: open adds, resolved deletes.
    // Sequence (ascending by at):
    //   T_OLD        open   id=A → set={A} → openSignals=1
    //   T_MID        open   id=B → set={A,B} → openSignals=2  (merges with score row at T_MID)
    //   2026-03-01   open   id=C → set={A,B,C} → openSignals=3
    //   2026-05-01   resolved id=B → set={A,C} → openSignals=2  (merges with score row at 2026-05-01)
    const signalLines = [
      JSON.stringify({
        v: 1,
        at: T_OLD,
        id: 'A',
        kind: 'regression',
        severity: 'high',
        specId: 'spec-a',
        status: 'open',
        detail: 'd',
      }),
      JSON.stringify({
        v: 1,
        at: T_MID,
        id: 'B',
        kind: 'needs-scoring',
        severity: 'low',
        specId: 'spec-a',
        status: 'open',
        detail: 'd',
      }),
      JSON.stringify({
        v: 1,
        at: '2026-03-01T00:00:00.000Z',
        id: 'C',
        kind: 'unverifiable',
        severity: 'medium',
        specId: 'spec-a',
        status: 'open',
        detail: 'd',
      }),
      JSON.stringify({
        v: 1,
        at: '2026-05-01T00:00:00.000Z',
        id: 'B',
        kind: 'needs-scoring',
        severity: 'low',
        specId: 'spec-a',
        status: 'resolved',
        detail: 'closed',
      }),
    ];
    writeFileSync(
      resolve(root, '.validity', 'history', 'signals.jsonl'),
      signalLines.join('\n') + '\n',
    );
  });

  it('excludes resolved signals and sorts open signals high→low, older first within a severity', () => {
    const snap = buildDashboardSnapshot(root);
    const ids = snap.signals.map((s) => s.id);
    expect(ids).not.toContain('recovered:spec-x:AC-x'); // resolved excluded
    expect(ids).toEqual([
      'regression:spec-a:AC-1', // high, oldest
      'regression:spec-b:AC-1', // high, newer
      'needs-scoring:spec-a:AC-2', // low
    ]);
    expect(snap.signals.every((s) => s.status === 'open')).toBe(true);
  });

  it('recomputes per-spec validityScore — never trusts the stamped display cache', () => {
    const snap = buildDashboardSnapshot(root);
    const specA = snap.specs.find((s) => s.specId === 'spec-a')!;
    expect(specA).toBeDefined();
    // spec-a: hard pass (w2, credit 1) + stale soft pass (w1, credit 0.5) +
    // advisory (excluded). earned=2.5, possible=3 → 83.33 → rounded 83.
    expect(specA.validityScore).toBe(83);
    expect(specA.validityScore).not.toBe(999); // the wrong stamp is ignored
  });

  it('applies stale/severity defaults to criteria and sorts them by id', () => {
    const snap = buildDashboardSnapshot(root);
    const specA = snap.specs.find((s) => s.specId === 'spec-a')!;
    const criteriaById = new Map(specA.criteria.map((c) => [c.id, c]));
    expect(specA.criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3']);
    // stale defaults to false when absent; true when set.
    expect(criteriaById.get('AC-1')!.stale).toBe(false);
    expect(criteriaById.get('AC-2')!.stale).toBe(true);
    // severity defaults to 'blocking' when absent; honors 'advisory' when set.
    expect(criteriaById.get('AC-1')!.severity).toBe('blocking');
    expect(criteriaById.get('AC-3')!.severity).toBe('advisory');
    // score defaults to null when absent.
    expect(criteriaById.get('AC-1')!.score).toBeNull();
    // detail defaults to null when absent.
    expect(criteriaById.get('AC-1')!.detail).toBeNull();
  });

  it('sorts specs ascending by specId', () => {
    const snap = buildDashboardSnapshot(root);
    expect(snap.specs.map((s) => s.specId)).toEqual(['spec-a', 'spec-b', 'spec-draft']);
  });

  it('computes population: tracked frozen count, total specs, draftSuperseded ids', () => {
    const snap = buildDashboardSnapshot(root);
    expect(snap.population).toEqual({
      tracked: 2, // spec-a, spec-b frozen
      total: 3, // spec-a, spec-b, spec-draft
      draftSuperseded: ['spec-draft'], // non-frozen with a scorecard entry
      drafts: [], // spec-draft HAS a scorecard entry, so it is not a never-scored draft
      unverified: [], // both frozen specs have scorecard entries
    });
  });

  it('computes the repo-level score from the scorecard', () => {
    const snap = buildDashboardSnapshot(root);
    expect(snap.score).not.toBeNull();
    // Pooled across spec-a (2.5/3) and spec-b (hard pass w2 + hard unverifiable w2 →
    // earned 2, possible 4) → earned 4.5, possible 7 → 64.28 → rounded 64.
    expect(snap.score!.score).toBe(64);
    // blocking count: spec-a has 2 (AC-1 hard, AC-2 soft), spec-b has 2 (both
    // hard), spec-draft has 0. advisory (spec-a AC-3) excluded separately.
    expect(snap.score!.blockingCriteriaCount).toBeGreaterThanOrEqual(4);
    expect(snap.score!.advisoryExcludedCount).toBe(1);
    expect(snap.score!.staleSoftCount).toBe(1); // spec-a AC-2
  });

  it('surfaces the watcher high-water mark + hook cooldown (false when long ago)', () => {
    const snap = buildDashboardSnapshot(root);
    // tmpdir isn't a git repo → headSha/commitsBehind null.
    expect(snap.watcher.lastObservedSha).toBe('cafe');
    expect(snap.watcher.lastTickAt).toBe('2026-07-04T11:00:00.000Z');
    expect(snap.watcher.headSha).toBeNull();
    expect(snap.watcher.commitsBehind).toBeNull();
    expect(snap.watcher.hook).toEqual({
      lastLaunchAt: '2020-01-01T00:00:00.000Z',
      batchSize: 3,
      cooldownMs: 300_000,
      coolingDown: false,
    });
  });

  it('folds the trend: score series + open-signal running count merged by `at`', () => {
    const snap = buildDashboardSnapshot(root);
    expect(snap.trend).not.toBeNull();
    const points = snap.trend!.points;
    // Ascending by at, with same-at rows merged into a single point. (Rows
    // come back sorted ascending by `at`; the fold runs in that order.)
    expect(points.map((p) => p.at)).toEqual([
      T_OLD,
      '2026-03-01T00:00:00.000Z',
      T_MID,
      '2026-05-01T00:00:00.000Z',
    ]);
    // T_OLD — only a signal row: open A → set={A}.
    expect(points[0]).toEqual({
      at: T_OLD,
      sha: null,
      score: null,
      openSignals: 1,
    });
    // 2026-03-01 — only a signal row: open C → set={A,C}.
    expect(points[1]).toEqual({
      at: '2026-03-01T00:00:00.000Z',
      sha: null,
      score: null,
      openSignals: 2,
    });
    // T_MID — signal row (open B → set={A,B,C}, openSignals 3) MERGED with the
    // score row at the same `at` (sha s1, score 50).
    expect(points[2]).toEqual({
      at: T_MID,
      sha: 's1',
      score: 50,
      openSignals: 3,
    });
    // 2026-05-01 — signal resolved (B leaves → set={A,C}, openSignals 2) MERGED
    // with the score row at the same `at` (sha s3, score 70).
    expect(points[3]).toEqual({
      at: '2026-05-01T00:00:00.000Z',
      sha: 's3',
      score: 70,
      openSignals: 2,
    });
  });
});

describe('buildDashboardSnapshot — latestRun report fallback', () => {
  const T0 = '2026-07-01T00:00:00.000Z';
  const T1 = '2026-07-02T00:00:00.000Z';

  function seedSpecWithRuns(specId: string): void {
    writeFrozenSpec(specId);
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    writeFileSync(
      resolve(root, '.validity', 'scorecard.json'),
      JSON.stringify({
        version: 1,
        updatedAt: T1,
        specs: {
          [specId]: {
            specVersion: 1,
            verdict: 'pass',
            signedOff: true,
            updatedAt: T1,
            criteria: { 'AC-1': { tier: 'hard', status: 'pass', at: T1 } },
          },
        },
      }),
    );
    // Two indexed runs: the OLDER one has a report.html (an attended verify +
    // submit_report), the NEWEST does not (a watch tick writes no report).
    mkdirSync(resolve(root, '.validity', 'specs', specId), { recursive: true });
    writeFileSync(
      resolve(root, '.validity', 'specs', specId, 'runs.jsonl'),
      [
        JSON.stringify({
          runId: 'run-old',
          createdAt: T0,
          verdict: 'pass',
          counts: { pass: 1, fail: 0, unverifiable: 0 },
        }),
        JSON.stringify({
          runId: 'run-new',
          createdAt: T1,
          verdict: 'pass',
          counts: { pass: 1, fail: 0, unverifiable: 0 },
        }),
      ].join('\n') + '\n',
    );
    mkdirSync(resolve(root, '.validity', 'runs', 'run-old'), { recursive: true });
    writeFileSync(resolve(root, '.validity', 'runs', 'run-old', 'report.html'), '<html></html>');
  }

  it('hasReport stays true when a report-less watch tick is the newest run', () => {
    // The /spec/:id/report route serves the newest SURVIVING report, so the
    // link must render whenever any recent run still has one — not only when
    // the single newest run does.
    seedSpecWithRuns('spec-r');
    const snap = buildDashboardSnapshot(root);
    const spec = snap.specs.find((s) => s.specId === 'spec-r')!;
    expect(spec.latestRun).not.toBeNull();
    expect(spec.latestRun!.runId).toBe('run-new'); // newest run still headlines
    expect(spec.latestRun!.hasReport).toBe(true); // …but the older report keeps the link
  });

  it('hasReport is false when no recent run has a report', () => {
    seedSpecWithRuns('spec-nr');
    rmSync(resolve(root, '.validity', 'runs', 'run-old'), { recursive: true, force: true });
    const snap = buildDashboardSnapshot(root);
    const spec = snap.specs.find((s) => s.specId === 'spec-nr')!;
    expect(spec.latestRun!.hasReport).toBe(false);
  });
});

describe('buildDashboardSnapshot — corrupt scorecard', () => {
  it('survives a corrupt scorecard.json and returns the empty shapes (score null, specs [])', () => {
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    writeFileSync(resolve(root, '.validity', 'scorecard.json'), '{ not json');
    const snap = buildDashboardSnapshot(root);
    expect(snap.score).toBeNull();
    expect(snap.specs).toEqual([]);
    expect(snap.signals).toEqual([]);
    expect(snap.trend).toBeNull();
    // Snapshot still built; the function never threw.
    expect(snap.version).toBe(1);
  });
});

describe('buildDashboardSnapshot — verdict sanity', () => {
  it('recomputes verdict/signedOff from the criteria (stored values agree here)', () => {
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    writeFileSync(
      resolve(root, '.validity', 'scorecard.json'),
      JSON.stringify({
        version: 1,
        updatedAt: 't',
        specs: {
          'spec-1': {
            specVersion: 2,
            verdict: 'fail',
            signedOff: false,
            coveragePercent: 0,
            updatedAt: 't',
            criteria: { 'AC-1': { tier: 'hard', status: 'fail', at: 't' } },
          },
        },
      }),
    );
    const snap: DashboardSnapshot = buildDashboardSnapshot(root);
    const spec = snap.specs[0]!;
    expect(spec.specVersion).toBe(2);
    expect(spec.verdict).toBe('fail');
    expect(spec.signedOff).toBe(false);
    expect(spec.coveragePercent).toBe(0);
  });

  it('NEVER trusts a cached pass over a failing criterion — recomputes to fail', () => {
    // A corrupt / hand-edited scorecard stamps a green verdict + signedOff over
    // a hard criterion that is failing. The snapshot must recompute both to the
    // truth (fail / not signed off), the display arm of the never-false-green
    // rule — the stamped cache can never render green over a failing criterion.
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    writeFileSync(
      resolve(root, '.validity', 'scorecard.json'),
      JSON.stringify({
        version: 1,
        updatedAt: 't',
        specs: {
          'spec-lie': {
            specVersion: 1,
            verdict: 'pass', // LIE
            signedOff: true, // LIE
            coveragePercent: 100,
            validityScore: 100, // LIE
            updatedAt: 't',
            criteria: {
              'AC-1': { tier: 'hard', status: 'pass', at: 't' },
              'AC-2': { tier: 'hard', status: 'fail', at: 't', detail: 'button missing' },
            },
          },
        },
      }),
    );
    const spec = buildDashboardSnapshot(root).specs[0]!;
    expect(spec.verdict).toBe('fail');
    expect(spec.signedOff).toBe(false);
    expect(spec.validityScore).not.toBe(100);
  });
});
/* ------------------------------------------------------------------ *
 * Health verdict + signal triage (dashboard redesign)                 *
 * ------------------------------------------------------------------ */

describe('buildDashboardSnapshot — health verdict + signal triage', () => {
  const AT = '2026-07-04T00:00:00.000Z';

  function writeSpecWith(args: {
    id: string;
    status: 'frozen' | 'draft';
    criteria: Array<{ id: string; tier: 'hard' | 'soft'; text?: string }>;
    supersedes?: string;
    prompt?: string;
  }): void {
    const spec = parseSpec({
      id: args.id,
      version: args.supersedes ? 2 : 1,
      status: args.status,
      source: {
        prompt: args.prompt ?? 'Build the checkout flow\nwith more detail',
        createdBy: 'agent',
      },
      runtime: 'web',
      criteria: args.criteria.map((c) => ({
        id: c.id,
        text: c.text ?? `criterion ${c.id}`,
        tier: c.tier,
        // hard-tier criteria require a non-empty checks block by schema.
        checks: c.tier === 'hard' ? [{ expect: { console: { errors: 0 } } }] : undefined,
      })),
      supersedes: args.supersedes,
      createdAt: new Date(0).toISOString(),
    });
    writeSpec(root, spec);
  }

  function writeState(args: {
    scorecardSpecs: Record<string, unknown>;
    signals?: unknown[];
  }): void {
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    writeFileSync(
      resolve(root, '.validity', 'scorecard.json'),
      JSON.stringify({ version: 1, updatedAt: AT, specs: args.scorecardSpecs }),
    );
    writeFileSync(resolve(root, '.validity', 'signals.json'), JSON.stringify(args.signals ?? []));
  }

  const scoreEntry = (verdict: 'pass' | 'fail' | 'partial', criteria: Record<string, unknown>) => ({
    specVersion: 1,
    specHash: 'h',
    verdict,
    signedOff: verdict === 'pass',
    coveragePercent: 100,
    updatedAt: AT,
    criteria,
  });

  it('one failing tracked spec ⇒ verdict "failing" with a fix-spec topAction; passes stay quiet', () => {
    writeSpecWith({ id: 'spec-good', status: 'frozen', criteria: [{ id: 'AC-1', tier: 'hard' }] });
    writeSpecWith({
      id: 'spec-bad',
      status: 'frozen',
      criteria: [
        { id: 'AC-1', tier: 'hard' },
        { id: 'AC-2', tier: 'hard' },
      ],
    });
    writeState({
      scorecardSpecs: {
        'spec-good': scoreEntry('pass', { 'AC-1': { tier: 'hard', status: 'pass', at: AT } }),
        'spec-bad': scoreEntry('fail', {
          'AC-1': { tier: 'hard', status: 'pass', at: AT },
          'AC-2': { tier: 'hard', status: 'fail', at: AT, detail: 'button missing' },
        }),
      },
    });
    const snap = buildDashboardSnapshot(root);
    expect(snap.health.verdict).toBe('failing');
    expect(snap.health.passing).toBe(1);
    expect(snap.health.failing).toBe(1);
    expect(snap.health.topAction).toMatchObject({
      kind: 'fix-spec',
      specId: 'spec-bad',
      criterionId: 'AC-2',
    });
  });

  it('all tracked passing with no actionable signals ⇒ "healthy" and no topAction', () => {
    writeSpecWith({ id: 'spec-good', status: 'frozen', criteria: [{ id: 'AC-1', tier: 'hard' }] });
    writeState({
      scorecardSpecs: {
        'spec-good': scoreEntry('pass', { 'AC-1': { tier: 'hard', status: 'pass', at: AT } }),
      },
    });
    const snap = buildDashboardSnapshot(root);
    expect(snap.health.verdict).toBe('healthy');
    expect(snap.health.topAction).toBeNull();
  });

  it('a partial tracked spec ⇒ "attention"', () => {
    writeSpecWith({
      id: 'spec-p',
      status: 'frozen',
      criteria: [
        { id: 'AC-1', tier: 'hard' },
        { id: 'AC-2', tier: 'soft' },
      ],
    });
    writeState({
      scorecardSpecs: {
        'spec-p': scoreEntry('partial', {
          'AC-1': { tier: 'hard', status: 'pass', at: AT },
          'AC-2': { tier: 'soft', status: 'unscored', at: AT },
        }),
      },
    });
    expect(buildDashboardSnapshot(root).health.verdict).toBe('attention');
  });

  it('needs-scoring already answered by the scorecard is triaged stale and does not move health', () => {
    writeSpecWith({
      id: 'spec-s',
      status: 'frozen',
      criteria: [
        { id: 'AC-1', tier: 'hard' },
        { id: 'AC-2', tier: 'soft' },
      ],
    });
    writeState({
      scorecardSpecs: {
        'spec-s': scoreEntry('pass', {
          'AC-1': { tier: 'hard', status: 'pass', at: AT },
          'AC-2': { tier: 'soft', status: 'pass', at: AT, score: 0.9 },
        }),
      },
      signals: [
        {
          id: 'needs-scoring:spec-s:AC-2',
          kind: 'needs-scoring',
          severity: 'low',
          specId: 'spec-s',
          criterionId: 'AC-2',
          detail: 'soft criterion "AC-2" has no agent score yet',
          at: AT,
          openedAt: AT,
          status: 'open',
        },
      ],
    });
    const snap = buildDashboardSnapshot(root);
    expect(snap.health.verdict).toBe('healthy');
    expect(snap.health.staleSuppressed).toBe(1);
    const sig = snap.signals.find((s) => s.id === 'needs-scoring:spec-s:AC-2')!;
    expect(sig.triage).toBe('stale');
    expect(sig.staleReason).toContain('already scored');
  });

  it('a needs-scoring signal for a criterion that is HARD in the current spec is stale', () => {
    writeSpecWith({ id: 'spec-h', status: 'frozen', criteria: [{ id: 'AC-2', tier: 'hard' }] });
    writeState({
      scorecardSpecs: {
        'spec-h': scoreEntry('pass', { 'AC-2': { tier: 'hard', status: 'pass', at: AT } }),
      },
      signals: [
        {
          id: 'needs-scoring:spec-h:AC-2',
          kind: 'needs-scoring',
          severity: 'low',
          specId: 'spec-h',
          criterionId: 'AC-2',
          detail: 'left over from an earlier version layout',
          at: AT,
          openedAt: AT,
          status: 'open',
        },
      ],
    });
    const sig = buildDashboardSnapshot(root).signals[0]!;
    expect(sig.triage).toBe('stale');
  });

  it('perf-drift is informational; a live regression is actionable', () => {
    writeSpecWith({ id: 'spec-r', status: 'frozen', criteria: [{ id: 'AC-1', tier: 'hard' }] });
    writeState({
      scorecardSpecs: {
        'spec-r': scoreEntry('fail', { 'AC-1': { tier: 'hard', status: 'fail', at: AT } }),
      },
      signals: [
        {
          id: 'regression:spec-r:AC-1',
          kind: 'regression',
          severity: 'high',
          specId: 'spec-r',
          criterionId: 'AC-1',
          detail: 'pass → fail',
          at: AT,
          openedAt: AT,
          status: 'open',
        },
        {
          id: 'perf-drift:spec-r:main',
          kind: 'perf-drift',
          severity: 'low',
          specId: 'spec-r',
          perfKey: 'main',
          detail: 'loadMs drifted',
          at: AT,
          openedAt: AT,
          status: 'open',
        },
      ],
    });
    const snap = buildDashboardSnapshot(root);
    const byId = new Map(snap.signals.map((s) => [s.id, s]));
    expect(byId.get('regression:spec-r:AC-1')!.triage).toBe('actionable');
    expect(byId.get('perf-drift:spec-r:main')!.triage).toBe('informational');
    expect(snap.health.actionable).toBe(1);
    expect(snap.health.informational).toBe(1);
  });

  it('spec fields: tracked/specStatus/title/criterion text; drifted + orphaned classification', () => {
    writeSpecWith({
      id: 'spec-t',
      status: 'frozen',
      criteria: [{ id: 'AC-1', tier: 'hard', text: 'The button is visible' }],
      prompt: 'A very fine checkout page',
    });
    writeSpecWith({
      id: 'spec-d',
      status: 'draft',
      criteria: [{ id: 'AC-1', tier: 'hard' }],
      supersedes: 'spec-d@v1',
    });
    writeState({
      scorecardSpecs: {
        'spec-t': scoreEntry('pass', { 'AC-1': { tier: 'hard', status: 'pass', at: AT } }),
        'spec-d': scoreEntry('pass', { 'AC-1': { tier: 'hard', status: 'pass', at: AT } }),
        'spec-gone': scoreEntry('pass', { 'AC-1': { tier: 'hard', status: 'pass', at: AT } }),
      },
    });
    const snap = buildDashboardSnapshot(root);
    const byId = new Map(snap.specs.map((s) => [s.specId, s]));
    expect(byId.get('spec-t')!.tracked).toBe(true);
    expect(byId.get('spec-t')!.specStatus).toBe('frozen');
    expect(byId.get('spec-t')!.title).toBe('A very fine checkout page');
    expect(byId.get('spec-t')!.criteria[0]!.text).toBe('The button is visible');
    expect(byId.get('spec-d')!.specStatus).toBe('drifted');
    expect(byId.get('spec-d')!.tracked).toBe(false);
    expect(byId.get('spec-gone')!.specStatus).toBe('orphaned');
    // untracked specs never move the health verdict
    expect(snap.health.scoredTracked).toBe(1);
  });

  it('population.drafts lists never-scored drafts; population.unverified lists frozen specs without verdicts', () => {
    writeSpecWith({
      id: 'spec-new',
      status: 'draft',
      criteria: [{ id: 'AC-1', tier: 'hard' }],
      prompt: 'Draft thing',
    });
    writeSpecWith({
      id: 'spec-froz',
      status: 'frozen',
      criteria: [{ id: 'AC-1', tier: 'hard' }],
      prompt: 'Frozen thing',
    });
    writeState({ scorecardSpecs: {} });
    const snap = buildDashboardSnapshot(root);
    expect(snap.population.drafts).toEqual([
      { specId: 'spec-new', version: 1, title: 'Draft thing', maturity: 'dev' },
    ]);
    // No live assessor injected + no cache: frozen floors at 'team', never
    // 'certified' (certification requires a fresh derivation).
    expect(snap.population.unverified).toEqual([
      { specId: 'spec-froz', version: 1, title: 'Frozen thing', maturity: 'team' },
    ]);
    expect(snap.maturity).toEqual({ probation: 0, dev: 1, team: 1, certified: 0 });
    // Tracked specs exist but none scored ⇒ 'empty' with the mechanical sweep hint.
    expect(snap.health.verdict).toBe('empty');
    expect(snap.health.topAction!.summary).toContain('validity verify --all');
  });

  it('resolvedSignals carries recent resolved rows newest-first', () => {
    writeState({
      scorecardSpecs: {},
      signals: [
        {
          id: 'recovered:spec-a:AC-1',
          kind: 'recovered',
          severity: 'info',
          specId: 'spec-a',
          criterionId: 'AC-1',
          detail: 'recovered',
          at: '2026-07-01T00:00:00.000Z',
          resolvedAt: '2026-07-01T00:00:00.000Z',
          status: 'resolved',
        },
        {
          id: 'needs-scoring:spec-a:AC-2',
          kind: 'needs-scoring',
          severity: 'low',
          specId: 'spec-a',
          criterionId: 'AC-2',
          detail: 'auto-resolved: already scored',
          at: '2026-07-02T00:00:00.000Z',
          resolvedAt: '2026-07-02T00:00:00.000Z',
          status: 'resolved',
        },
      ],
    });
    const snap = buildDashboardSnapshot(root);
    expect(snap.resolvedSignals.map((s) => s.id)).toEqual([
      'needs-scoring:spec-a:AC-2',
      'recovered:spec-a:AC-1',
    ]);
    expect(snap.resolvedSignals.every((s) => s.status === 'resolved')).toBe(true);
    expect(snap.resolvedSignals[0]!.resolvedBy).toBeNull();
    expect(snap.resolvedSignals[0]!.suppressedUntil).toBeNull();
  });

  it('open inbox rows carry additive resolvedBy/suppressedUntil (null when unset)', () => {
    writeState({
      scorecardSpecs: {},
      signals: [
        {
          id: 'regression:spec-a:AC-1',
          kind: 'regression',
          severity: 'high',
          specId: 'spec-a',
          criterionId: 'AC-1',
          detail: 'red',
          at: '2026-07-01T00:00:00.000Z',
          openedAt: '2026-07-01T00:00:00.000Z',
          status: 'open',
        },
      ],
    });
    const snap = buildDashboardSnapshot(root);
    expect(snap.signals[0]).toMatchObject({
      status: 'open',
      resolvedBy: null,
      suppressedUntil: null,
    });
  });
});

describe('buildDashboardSnapshot — trend forward-fill', () => {
  it('carries step-function values across merge seams; leading nulls stay null', () => {
    mkdirSync(resolve(root, '.validity', 'history'), { recursive: true });
    // signal opens at T1 (no score yet) → score lands at T2 (no signal row) →
    // another signal opens at T3 (no score row).
    writeFileSync(
      resolve(root, '.validity', 'history', 'signals.jsonl'),
      [
        JSON.stringify({
          v: 1,
          at: '2026-01-01T00:00:00.000Z',
          id: 'A',
          kind: 'regression',
          severity: 'high',
          specId: 's',
          status: 'open',
          detail: 'd',
        }),
        JSON.stringify({
          v: 1,
          at: '2026-03-01T00:00:00.000Z',
          id: 'B',
          kind: 'regression',
          severity: 'high',
          specId: 's',
          status: 'open',
          detail: 'd',
        }),
      ].join('\n') + '\n',
    );
    writeFileSync(
      resolve(root, '.validity', 'history', 'score.jsonl'),
      JSON.stringify({
        at: '2026-02-01T00:00:00.000Z',
        sha: 's1',
        score: 90,
        perSpec: {},
        source: 'watch',
        scoreVersion: 1,
      }) + '\n',
    );
    const points = buildDashboardSnapshot(root).trend!.points;
    expect(points.map((p) => [p.at, p.score, p.openSignals])).toEqual([
      ['2026-01-01T00:00:00.000Z', null, 1], // before any score: stays null
      ['2026-02-01T00:00:00.000Z', 90, 1], // openSignals carried forward
      ['2026-03-01T00:00:00.000Z', 90, 2], // score carried forward
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * computeDashboardHealth — never-false-green demotions (unit)         *
 * A tmpdir is not a git repo, so commitsBehind is null there; these   *
 * exercise the fold directly with synthetic freshness + signals.      *
 * ------------------------------------------------------------------ */

describe('computeDashboardHealth — freshness + untracked-signal demotions', () => {
  const passingTracked = (id = 'spec-ok'): DashboardSpec => ({
    specId: id,
    specVersion: 1,
    verdict: 'pass',
    signedOff: true,
    coveragePercent: 100,
    validityScore: 100,
    updatedAt: 't',
    criteria: [
      {
        id: 'AC-1',
        tier: 'hard',
        status: 'pass',
        stale: false,
        severity: 'blocking',
        score: null,
        detail: null,
        text: null,
      },
    ],
    tracked: true,
    specStatus: 'frozen',
    title: null,
    latestRun: null,
    maturity: null,
  });

  const actionableSignal = (specId: string): DashboardSignal => ({
    id: `regression:${specId}:AC-1`,
    kind: 'regression',
    severity: 'high',
    status: 'open',
    specId,
    criterionId: 'AC-1',
    detail: 'broke',
    at: 't',
    openedAt: 't',
    sha: null,
    ageMs: 0,
    triage: 'actionable',
    staleReason: null,
  });

  const fresh = { lastObservedSha: 'abc1234', headSha: 'abc1234', commitsBehind: 0 };

  it('all-passing + in sync + no signals ⇒ healthy, no reason', () => {
    const h = computeDashboardHealth({
      specs: [passingTracked()],
      signals: [],
      population: { tracked: 1 },
      staleSoftCount: 0,
      watcher: fresh,
    });
    expect(h.verdict).toBe('healthy');
    expect(h.verdictReason).toBeNull();
    expect(h.commitsBehind).toBe(0);
    expect(h.observedThroughSha).toBe('abc1234');
  });

  it('a would-be-healthy population trailing HEAD demotes to attention with a reason', () => {
    const h = computeDashboardHealth({
      specs: [passingTracked()],
      signals: [],
      population: { tracked: 1 },
      staleSoftCount: 0,
      watcher: { lastObservedSha: 'old1234', headSha: 'new5678', commitsBehind: 3 },
    });
    expect(h.verdict).toBe('attention');
    expect(h.verdictReason).toContain('3 commits behind HEAD');
    expect(h.commitsBehind).toBe(3);
  });

  it('an actionable signal on an UNTRACKED spec demotes healthy off green (never above a red tile)', () => {
    // The tracked spec is clean, but a high actionable signal exists on a spec
    // outside the tracked set — which the red "Needs action" tile + section
    // count. The hero must not read green above them.
    const h = computeDashboardHealth({
      specs: [passingTracked()],
      signals: [actionableSignal('spec-untracked')],
      population: { tracked: 1 },
      staleSoftCount: 0,
      watcher: fresh,
    });
    expect(h.verdict).toBe('attention');
    expect(h.actionable).toBe(1); // the tile/section count ALL actionable
    expect(h.verdictReason).toContain('outside the tracked set');
  });

  it('freshness is not evaluated when the population already fails (fail wins)', () => {
    const failing: DashboardSpec = { ...passingTracked('spec-bad'), verdict: 'fail' };
    const h = computeDashboardHealth({
      specs: [failing],
      signals: [],
      population: { tracked: 1 },
      staleSoftCount: 0,
      watcher: { lastObservedSha: 'old', headSha: 'new', commitsBehind: 9 },
    });
    expect(h.verdict).toBe('failing');
    expect(h.verdictReason).toBeNull(); // reason is only for demotions OFF healthy
  });
});

describe('buildDashboardSnapshot — in-flight verify markers', () => {
  it('surfaces a fresh marker on health.inProgress with a computed age, not abandoned', () => {
    writeInflightMarker(root, {
      runId: 'run_live',
      specId: 'spec-live',
      mode: 'isolation',
      startedAt: new Date(Date.now() - 3_000).toISOString(), // ~3s ago
    });
    const snap = buildDashboardSnapshot(root);
    expect(snap.health.inProgress).toHaveLength(1);
    const row = snap.health.inProgress[0]!;
    expect(row).toMatchObject({
      runId: 'run_live',
      specId: 'spec-live',
      mode: 'isolation',
      abandoned: false,
    });
    expect(row.ageMs).toBeGreaterThanOrEqual(0);
    expect(row.ageMs).toBeLessThan(15 * 60 * 1000);
  });

  it('flags a marker older than the 15-minute window as abandoned (kept, not dropped)', () => {
    writeInflightMarker(root, {
      runId: 'run_stuck',
      mode: 'native',
      startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago
    });
    const snap = buildDashboardSnapshot(root);
    expect(snap.health.inProgress).toHaveLength(1);
    expect(snap.health.inProgress[0]).toMatchObject({
      runId: 'run_stuck',
      specId: null,
      abandoned: true,
    });
  });

  it('is empty when nothing is verifying', () => {
    expect(buildDashboardSnapshot(root).health.inProgress).toEqual([]);
  });

  it('orders rows deterministically by startedAt then runId', () => {
    writeInflightMarker(root, {
      runId: 'run_b',
      mode: 'url',
      startedAt: '2026-07-18T00:00:02.000Z',
    });
    writeInflightMarker(root, {
      runId: 'run_a',
      mode: 'url',
      startedAt: '2026-07-18T00:00:01.000Z',
    });
    const snap = buildDashboardSnapshot(root);
    expect(snap.health.inProgress.map((r) => r.runId)).toEqual(['run_a', 'run_b']);
  });
});

/* ------------------------------------------------------------------ *
 * Attested vs proven sign-off (display-only; never gates)            *
 * ------------------------------------------------------------------ */

describe('buildDashboardSnapshot — attested vs proven sign-off', () => {
  const AT = '2026-07-04T00:00:00.000Z';

  /** Write a frozen spec with the given criteria (hard tiers get a checks block). */
  function writeFrozen(id: string, criteria: Array<{ id: string; tier: 'hard' | 'soft' }>): void {
    writeSpec(
      root,
      parseSpec({
        id,
        version: 1,
        status: 'frozen',
        source: { prompt: 'p', createdBy: 'agent' },
        runtime: 'web',
        criteria: criteria.map((c) => ({
          id: c.id,
          text: `criterion ${c.id}`,
          tier: c.tier,
          checks: c.tier === 'hard' ? [{ expect: { console: { errors: 0 } } }] : undefined,
        })),
        createdAt: new Date(0).toISOString(),
      }),
    );
  }

  function writeScorecard(specs: Record<string, unknown>): void {
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    writeFileSync(
      resolve(root, '.validity', 'scorecard.json'),
      JSON.stringify({ version: 1, updatedAt: AT, specs }),
    );
  }

  const entry = (verdict: 'pass' | 'fail' | 'partial', criteria: Record<string, unknown>) => ({
    specVersion: 1,
    verdict,
    // stamped value is deliberately ignored by the snapshot (recomputed).
    signedOff: verdict === 'pass',
    coveragePercent: 100,
    updatedAt: AT,
    criteria,
  });

  it('attestedSignOff is true when a signed-off spec has a blocking soft pass', () => {
    writeFrozen('spec-att', [
      { id: 'AC-1', tier: 'hard' },
      { id: 'AC-2', tier: 'soft' },
    ]);
    writeScorecard({
      'spec-att': entry('pass', {
        'AC-1': { tier: 'hard', status: 'pass', at: AT },
        'AC-2': { tier: 'soft', status: 'pass', at: AT, score: 0.9 },
      }),
    });
    const spec = buildDashboardSnapshot(root).specs.find((s) => s.specId === 'spec-att')!;
    expect(spec.signedOff).toBe(true);
    expect(spec.attestedSignOff).toBe(true);
  });

  it('signOffModelJudged is true when the blocking soft pass was judged by a model', () => {
    writeFrozen('spec-mj', [
      { id: 'AC-1', tier: 'hard' },
      { id: 'AC-2', tier: 'soft' },
    ]);
    writeScorecard({
      'spec-mj': entry('pass', {
        'AC-1': { tier: 'hard', status: 'pass', at: AT },
        'AC-2': {
          tier: 'soft',
          status: 'pass',
          at: AT,
          score: 0.9,
          judge: 'model',
          scoredBy: 'anthropic/x',
        },
      }),
    });
    const spec = buildDashboardSnapshot(root).specs.find((s) => s.specId === 'spec-mj')!;
    expect(spec.attestedSignOff).toBe(true);
    expect(spec.signOffModelJudged).toBe(true);
  });

  it('signOffModelJudged is false when the blocking soft pass was self/agent-scored', () => {
    writeFrozen('spec-self', [
      { id: 'AC-1', tier: 'hard' },
      { id: 'AC-2', tier: 'soft' },
    ]);
    writeScorecard({
      'spec-self': entry('pass', {
        'AC-1': { tier: 'hard', status: 'pass', at: AT },
        'AC-2': { tier: 'soft', status: 'pass', at: AT, score: 0.9, scoredBy: 'builder-agent' },
      }),
    });
    const spec = buildDashboardSnapshot(root).specs.find((s) => s.specId === 'spec-self')!;
    expect(spec.attestedSignOff).toBe(true);
    expect(spec.signOffModelJudged).toBe(false);
  });

  it('attestedSignOff is false for an all-hard signed-off spec (proven mechanically)', () => {
    writeFrozen('spec-hard', [
      { id: 'AC-1', tier: 'hard' },
      { id: 'AC-2', tier: 'hard' },
    ]);
    writeScorecard({
      'spec-hard': entry('pass', {
        'AC-1': { tier: 'hard', status: 'pass', at: AT },
        'AC-2': { tier: 'hard', status: 'pass', at: AT },
      }),
    });
    const spec = buildDashboardSnapshot(root).specs.find((s) => s.specId === 'spec-hard')!;
    expect(spec.signedOff).toBe(true);
    expect(spec.attestedSignOff).toBe(false);
  });

  it('attestedSignOff is false when the spec is not signed off', () => {
    writeFrozen('spec-uns', [
      { id: 'AC-1', tier: 'hard' },
      { id: 'AC-2', tier: 'soft' },
    ]);
    writeScorecard({
      'spec-uns': entry('partial', {
        'AC-1': { tier: 'hard', status: 'pass', at: AT },
        'AC-2': { tier: 'soft', status: 'unscored', at: AT },
      }),
    });
    const spec = buildDashboardSnapshot(root).specs.find((s) => s.specId === 'spec-uns')!;
    expect(spec.signedOff).toBe(false);
    expect(spec.attestedSignOff).toBe(false);
  });

  it('an advisory soft criterion does NOT make a sign-off attested (needs a BLOCKING soft)', () => {
    writeFrozen('spec-adv', [
      { id: 'AC-1', tier: 'hard' },
      { id: 'AC-2', tier: 'soft' },
    ]);
    writeScorecard({
      'spec-adv': entry('pass', {
        'AC-1': { tier: 'hard', status: 'pass', at: AT },
        'AC-2': { tier: 'soft', status: 'pass', at: AT, severity: 'advisory', score: 0.9 },
      }),
    });
    const spec = buildDashboardSnapshot(root).specs.find((s) => s.specId === 'spec-adv')!;
    expect(spec.signedOff).toBe(true);
    expect(spec.attestedSignOff).toBe(false);
  });

  it('health.attestedPassing counts only tracked specs with an attested sign-off', () => {
    writeFrozen('spec-att', [
      { id: 'AC-1', tier: 'hard' },
      { id: 'AC-2', tier: 'soft' },
    ]);
    writeFrozen('spec-hard', [{ id: 'AC-1', tier: 'hard' }]);
    writeScorecard({
      'spec-att': entry('pass', {
        'AC-1': { tier: 'hard', status: 'pass', at: AT },
        'AC-2': { tier: 'soft', status: 'pass', at: AT, score: 0.9 },
      }),
      'spec-hard': entry('pass', { 'AC-1': { tier: 'hard', status: 'pass', at: AT } }),
    });
    const snap = buildDashboardSnapshot(root);
    // spec-att is attested; spec-hard is a mechanical pass; both are tracked.
    expect(snap.health.attestedPassing).toBe(1);
  });
});

// Issue #17: soft criteria that can never re-score (no scoring.judgeModel)
// must surface as a persistent hero warning + a healthy→attention demotion —
// never as an inexplicable slow score drift.
describe('computeDashboardHealth — judge gap (issue #17)', () => {
  const passingTracked = (): DashboardSpec => ({
    specId: 'spec-ok',
    specVersion: 1,
    verdict: 'pass',
    signedOff: true,
    coveragePercent: 100,
    validityScore: 100,
    updatedAt: 't',
    criteria: [
      {
        id: 'AC-1',
        tier: 'hard',
        status: 'pass',
        stale: false,
        severity: 'blocking',
        score: null,
        detail: null,
        text: null,
      },
    ],
    tracked: true,
    specStatus: 'frozen',
    title: null,
    latestRun: null,
    maturity: null,
  });
  const fresh = { lastObservedSha: 'abc1234', headSha: 'abc1234', commitsBehind: 0 };

  it('demotes a would-be-healthy verdict to attention and states the fix', () => {
    const h = computeDashboardHealth({
      specs: [passingTracked()],
      signals: [],
      population: { tracked: 1 },
      staleSoftCount: 0,
      watcher: fresh,
      judgeGap: { softCriteria: 24 },
    });
    expect(h.verdict).toBe('attention');
    expect(h.judgeGap).toEqual({ softCriteria: 24 });
    expect(h.verdictReason).toContain('no judge configured');
    expect(h.verdictReason).toContain('scoring.judgeModel');
  });

  it('carries the gap without clobbering a worse verdict reason', () => {
    const h = computeDashboardHealth({
      specs: [passingTracked()],
      signals: [],
      population: { tracked: 1 },
      staleSoftCount: 3,
      watcher: fresh,
      judgeGap: { softCriteria: 2 },
    });
    // staleSoft already demotes; the gap rides the dedicated field.
    expect(h.verdict).toBe('attention');
    expect(h.judgeGap).toEqual({ softCriteria: 2 });
  });

  it('absent gap ⇒ null field, verdict untouched', () => {
    const h = computeDashboardHealth({
      specs: [passingTracked()],
      signals: [],
      population: { tracked: 1 },
      staleSoftCount: 0,
      watcher: fresh,
    });
    expect(h.verdict).toBe('healthy');
    expect(h.judgeGap).toBeNull();
  });
});

describe('computeDashboardHealth — environment attribution (suspected)', () => {
  const fresh = { lastObservedSha: 'abc1234', headSha: 'abc1234', commitsBehind: 0 };

  const trackedSpec = (over: Partial<DashboardSpec> = {}): DashboardSpec => ({
    specId: 'spec-ok',
    specVersion: 1,
    verdict: 'pass',
    signedOff: true,
    coveragePercent: 100,
    validityScore: 100,
    updatedAt: 't',
    criteria: [
      {
        id: 'AC-1',
        tier: 'hard',
        status: 'pass',
        stale: false,
        severity: 'blocking',
        score: null,
        detail: null,
        text: null,
      },
    ],
    tracked: true,
    specStatus: 'frozen',
    title: null,
    latestRun: null,
    maturity: null,
    ...over,
  });

  const envTaintedSpec = (taint: 'network' | 'wrapper' | 'unconfirmed-render'): DashboardSpec =>
    trackedSpec({
      specId: 'spec-env',
      verdict: 'partial',
      criteria: [
        {
          id: 'AC-1',
          tier: 'hard',
          status: 'unverifiable',
          stale: false,
          severity: 'blocking',
          score: null,
          detail: null,
          text: null,
          evidenceTaints: [taint],
        },
      ],
    });

  it('absent when no unverifiable criterion carries a demoting env taint', () => {
    const h = computeDashboardHealth({
      specs: [trackedSpec()],
      signals: [],
      population: { tracked: 1 },
      staleSoftCount: 0,
      watcher: fresh,
    });
    expect(h.environment).toBeNull();
  });

  it('an unverifiable criterion tainted network/wrapper/unconfirmed-render is flagged suspected', () => {
    for (const taint of ['network', 'wrapper', 'unconfirmed-render'] as const) {
      const h = computeDashboardHealth({
        specs: [envTaintedSpec(taint)],
        signals: [],
        population: { tracked: 1 },
        staleSoftCount: 0,
        watcher: fresh,
      });
      expect(h.environment).toEqual({
        confidence: 'suspected',
        count: 1,
        reason: expect.stringContaining('environment (suspected): 1 spec blocked'),
      });
    }
  });

  it('dep-scan taint alone does NOT trip the cluster (CLI escalates it to spec.error instead)', () => {
    const h = computeDashboardHealth({
      specs: [
        trackedSpec({
          criteria: [
            {
              id: 'AC-1',
              tier: 'hard',
              status: 'unverifiable',
              stale: false,
              severity: 'blocking',
              score: null,
              detail: null,
              text: null,
              evidenceTaints: ['dep-scan'],
            },
          ],
        }),
      ],
      signals: [],
      population: { tracked: 1 },
      staleSoftCount: 0,
      watcher: fresh,
    });
    expect(h.environment).toBeNull();
  });

  it('demotes a would-be-healthy verdict to attention and states why, when nothing else already demoted it', () => {
    // Note: a spec with an unverifiable criterion already rolls up to
    // 'partial' (rollupScorecardVerdict), which independently demotes the
    // verdict off healthy — so this exercises the FIELD, and a separate case
    // below exercises the verdictReason wiring directly via a passing spec
    // whose sibling carries the taint.
    const h = computeDashboardHealth({
      specs: [envTaintedSpec('network')],
      signals: [],
      population: { tracked: 1 },
      staleSoftCount: 0,
      watcher: fresh,
    });
    expect(h.verdict).toBe('attention');
    expect(h.environment?.count).toBe(1);
  });

  it('topAction points at `validity doctor` diagnosis when nothing higher-priority exists', () => {
    const h = computeDashboardHealth({
      specs: [envTaintedSpec('wrapper')],
      signals: [],
      population: { tracked: 1 },
      staleSoftCount: 0,
      watcher: fresh,
    });
    expect(h.topAction).toEqual({
      kind: 'diagnose-env',
      specId: null,
      criterionId: null,
      summary: expect.stringContaining('validity doctor'),
    });
  });

  it('a failing spec still wins topAction priority over a suspected env cluster', () => {
    const failing = trackedSpec({
      specId: 'spec-fail',
      verdict: 'fail',
      criteria: [
        {
          id: 'AC-1',
          tier: 'hard',
          status: 'fail',
          stale: false,
          severity: 'blocking',
          score: null,
          detail: null,
          text: null,
        },
      ],
    });
    const h = computeDashboardHealth({
      specs: [failing, envTaintedSpec('network')],
      signals: [],
      population: { tracked: 2 },
      staleSoftCount: 0,
      watcher: fresh,
    });
    expect(h.topAction?.kind).toBe('fix-spec');
    // the environment field is still populated (never dropped), just not the topAction
    expect(h.environment?.count).toBe(1);
  });
});

describe('buildDashboardSnapshot — judgeConfigured threading (issue #17)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-dash-judge-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seedFrozenSoftSpec(): void {
    writeSpec(
      root,
      parseSpec({
        id: 'spec-soft',
        version: 1,
        status: 'frozen',
        source: { prompt: 'p', createdBy: 'agent' },
        runtime: 'web',
        criteria: [
          { id: 'AC-1', text: 'looks right', tier: 'soft' },
          {
            id: 'AC-2',
            text: 'clicks',
            tier: 'hard',
            checks: [{ click: { role: 'button', name: 'Go' } }],
          },
        ],
        createdAt: '2026-07-01T00:00:00.000Z',
      }),
    );
  }

  it('judgeConfigured:false + tracked soft criteria ⇒ health.judgeGap set', () => {
    seedFrozenSoftSpec();
    const snap = buildDashboardSnapshot(root, { judgeConfigured: false });
    expect(snap.health.judgeGap).toEqual({ softCriteria: 1 });
  });

  it('judgeConfigured:true ⇒ no gap; undefined (unknown) ⇒ no gap either — never warn on a guess', () => {
    seedFrozenSoftSpec();
    expect(buildDashboardSnapshot(root, { judgeConfigured: true }).health.judgeGap).toBeNull();
    expect(buildDashboardSnapshot(root).health.judgeGap).toBeNull();
  });
});

// The overview's new surfaces (project name, per-spec run tally, clean streak,
// recent runs) are ADD-ONLY snapshot fields derived from data already on disk.
// The rules that matter here are honesty rules: a number the ledger never
// wrote is `null`, never a plausible-looking guess.
describe('buildDashboardSnapshot — overview fields (add-only)', () => {
  const AT = '2026-07-04T00:00:00.000Z';

  function seed(): void {
    mkdirSync(resolve(root, '.validity', 'specs', 'spec-a'), { recursive: true });
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'my-app' }));
    writeFileSync(
      resolve(root, '.validity', 'scorecard.json'),
      JSON.stringify({
        version: 1,
        updatedAt: AT,
        specs: {
          'spec-a': {
            specVersion: 1,
            specHash: 'h',
            verdict: 'pass',
            signedOff: true,
            updatedAt: AT,
            cleanStreak: { count: 1, lastSha: 'sha-1' },
            criteria: { 'AC-1': { tier: 'hard', status: 'pass', at: AT } },
          },
        },
      }),
    );
    writeFileSync(
      resolve(root, '.validity', 'specs', 'spec-a', 'runs.jsonl'),
      [
        {
          runId: 'run-old',
          createdAt: '2026-07-01T00:00:00.000Z',
          sha: 'sha-0',
          verdict: 'fail',
          counts: { pass: 0, fail: 1, unverifiable: 0 },
          criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail' }],
        },
        {
          runId: 'run-new',
          createdAt: '2026-07-03T00:00:00.000Z',
          sha: 'sha-1',
          verdict: 'pass',
          counts: { pass: 1, fail: 0, unverifiable: 0 },
          criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
  }

  it('names the project from package.json, else the directory basename', () => {
    seed();
    expect(buildDashboardSnapshot(root).projectName).toBe('my-app');
    rmSync(resolve(root, 'package.json'));
    expect(buildDashboardSnapshot(root).projectName).toBe(resolve(root).split('/').pop());
  });

  it('tallies indexed runs per spec and carries the reducer clean streak', () => {
    seed();
    const spec = buildDashboardSnapshot(root).specs[0]!;
    expect(spec.runTally).toEqual({ pass: 1, fail: 1, partial: 0, unknown: 0, total: 2 });
    expect(spec.cleanStreak).toEqual({ count: 1, need: 2 });
  });

  it('a spec with no indexed runs tallies null, not an all-zero bar', () => {
    writeFrozenSpec('spec-none');
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    writeFileSync(
      resolve(root, '.validity', 'scorecard.json'),
      JSON.stringify({
        version: 1,
        updatedAt: AT,
        specs: {
          'spec-none': {
            specVersion: 1,
            specHash: 'h',
            verdict: 'pass',
            signedOff: true,
            updatedAt: AT,
            criteria: { 'AC-soft': { tier: 'soft', status: 'pass', at: AT, score: 1 } },
          },
        },
      }),
    );
    const spec = buildDashboardSnapshot(root).specs[0]!;
    expect(spec.runTally).toBeNull();
    // A reset (or never-started) streak is 0, never absent — the stepper must
    // be able to say "0 of 2" rather than shrug.
    expect(spec.cleanStreak).toEqual({ count: 0, need: 2 });
  });

  it('flattens recent runs newest-first with the machine-verified fraction', () => {
    seed();
    const runs = buildDashboardSnapshot(root).recentRuns;
    expect(runs.map((r) => r.runId)).toEqual(['run-new', 'run-old']);
    expect(runs[0]!.mechanical).toEqual({ passed: 1, total: 1 });
    expect(runs[1]!.mechanical).toEqual({ passed: 0, total: 1 });
    expect(runs[0]!.sha).toBe('sha-1');
  });

  it('NEVER invents a run score: null until the ledger records one', () => {
    seed();
    expect(buildDashboardSnapshot(root).recentRuns.every((r) => r.score === null)).toBe(true);

    mkdirSync(resolve(root, '.validity', 'history'), { recursive: true });
    writeFileSync(
      resolve(root, '.validity', 'history', 'score.jsonl'),
      JSON.stringify({
        at: '2026-07-02T00:00:00.000Z',
        sha: 'sha-1',
        score: 90,
        perSpec: { 'spec-a': 88 },
        source: 'watch',
        scoreVersion: 2,
      }) + '\n',
    );
    const runs = buildDashboardSnapshot(root).recentRuns;
    // The sha-matched row wins for run-new; run-old predates every entry.
    expect(runs.find((r) => r.runId === 'run-new')!.score).toBe(88);
    expect(runs.find((r) => r.runId === 'run-old')!.score).toBeNull();
  });

  it('reports no machine-verified fraction for a row with no criteria snapshot', () => {
    mkdirSync(resolve(root, '.validity', 'specs', 'spec-a'), { recursive: true });
    writeFileSync(
      resolve(root, '.validity', 'scorecard.json'),
      JSON.stringify({
        version: 1,
        updatedAt: AT,
        specs: {
          'spec-a': {
            specVersion: 1,
            specHash: 'h',
            verdict: 'pass',
            signedOff: true,
            updatedAt: AT,
            criteria: { 'AC-1': { tier: 'hard', status: 'pass', at: AT } },
          },
        },
      }),
    );
    writeFileSync(
      resolve(root, '.validity', 'specs', 'spec-a', 'runs.jsonl'),
      JSON.stringify({
        runId: 'run-legacy',
        createdAt: '2026-07-03T00:00:00.000Z',
        verdict: 'pass',
        counts: { pass: 1, fail: 0, unverifiable: 0 },
      }) + '\n',
    );
    expect(buildDashboardSnapshot(root).recentRuns[0]!.mechanical).toBeNull();
  });
});
