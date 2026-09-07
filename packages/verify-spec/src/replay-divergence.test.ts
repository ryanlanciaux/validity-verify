/**
 * `replay-divergence` — the signal kind that only exists because it has a
 * RESOLVER.
 *
 * Phase 1 deliberately shipped the divergence ledger without a signal: a kind
 * nothing can close inflates the dashboard's open count forever, and that count
 * is what `buildTrend` folds into the trend line. So the assertions that matter
 * here are the fold assertions — open makes the count rise, and BOTH close
 * paths bring it back to baseline:
 *
 *   (a) a later replay of the same recording reproduces;
 *   (b) a fresh verify publishes a new signed `.ad` for the spec.
 *
 * Plus the one that keeps the count honest in between: the same journey
 * diverging twice is ONE signal, not two.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordReplayDivergence, supersedeReplayDivergence } from './replay-divergence.js';
import {
  loadSignals,
  replayDivergenceSignalId,
  replayDivergenceSignals,
  saveSignals,
  supersededReplayDivergenceSignals,
  type Signal,
} from './scorecard.js';
import { readSignalHistory } from './history.js';
import { buildDashboardSnapshot } from './dashboard-snapshot.js';
import { attestRecording, attestRun, REPLAY_RECORDING_FILENAME } from './attest.js';
import { runDir } from './runs.js';
import { runMetaPathFor, type RunMeta } from './run.js';

const SPEC = 'spec-checkout';
const AD = 'replay.ad';
const T1 = '2026-08-01T00:00:00.000Z';
const T2 = '2026-08-02T00:00:00.000Z';
const T3 = '2026-08-03T00:00:00.000Z';

let root: string;

beforeEach(() => {
  // realpath: macOS tmpdir is a symlink, and the attestation relativizes paths
  // against what run-meta recorded (same fix as the attest suite).
  root = realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-replay-divergence-')));
  mkdirSync(resolve(root, '.validity'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The open-signal running count at the newest trend point (what buildTrend folds). */
function openCountFromTrend(): number | null {
  const snap = buildDashboardSnapshot(root);
  const points = snap.trend?.points ?? [];
  return points.length === 0 ? null : (points.at(-1)!.openSignals ?? null);
}

function diverge(now: string, recording = AD): Signal[] {
  return recordReplayDivergence(root, {
    specId: SPEC,
    recording,
    outcome: 'diverged',
    detail: `the recorded on-device journey \`${recording}\` no longer reaches its landmark at step 4`,
    now,
    runId: 'run-1',
    historyCommitted: true,
  });
}

function reproduce(now: string, recording = AD): Signal[] {
  return recordReplayDivergence(root, {
    specId: SPEC,
    recording,
    outcome: 'reproduced',
    detail: `the recorded on-device journey \`${recording}\` reached its landmark again on replay`,
    now,
    historyCommitted: true,
  });
}

/* ------------------------------------------------------------------ *
 * The pure builders.                                                  *
 * ------------------------------------------------------------------ */

describe('replayDivergenceSignals (pure)', () => {
  it('keys the id on specId + recording file, and carries the file in its OWN field', () => {
    const [s] = replayDivergenceSignals({
      specId: SPEC,
      recording: AD,
      outcome: 'diverged',
      detail: 'd',
      now: T1,
    });
    expect(s!.id).toBe(`replay-divergence:${SPEC}:${AD}`);
    expect(s!.id).toBe(replayDivergenceSignalId(SPEC, AD));
    expect(s!.recording).toBe(AD);
    // Not criterionId: staleSignalReason's criterion-scoped rules would report
    // "criterion no longer exists in the current spec" and auto-close every one
    // of these on the next tick.
    expect(s!.criterionId).toBeUndefined();
  });

  it('grades medium — drift evidence, and never the severity --fail-on-signal gates on', () => {
    const [s] = replayDivergenceSignals({
      specId: SPEC,
      recording: AD,
      outcome: 'diverged',
      detail: 'd',
      now: T1,
    });
    expect(s!.severity).toBe('medium');
    expect(s!.severity).not.toBe('high');
    expect(s!.status).toBe('open');
  });

  it('emits a resolution marker on reproduced', () => {
    const [s] = replayDivergenceSignals({
      specId: SPEC,
      recording: AD,
      outcome: 'reproduced',
      detail: 'back',
      now: T2,
    });
    expect(s!.status).toBe('resolved');
    expect(s!.resolvedAt).toBe(T2);
    expect(s!.id).toBe(replayDivergenceSignalId(SPEC, AD));
  });
});

describe('supersededReplayDivergenceSignals (pure)', () => {
  const open = (specId: string, recording: string): Signal =>
    replayDivergenceSignals({ specId, recording, outcome: 'diverged', detail: 'd', now: T1 })[0]!;

  it('closes every OPEN divergence for the spec, whatever the recording was called', () => {
    const existing = [open(SPEC, 'replay.ad'), open(SPEC, 'journey-2.ad'), open('spec-other', AD)];
    const markers = supersededReplayDivergenceSignals({
      existing,
      specId: SPEC,
      recording: 'replay.ad',
      now: T3,
    });
    expect(markers.map((m) => m.id)).toEqual([
      `replay-divergence:${SPEC}:replay.ad`,
      `replay-divergence:${SPEC}:journey-2.ad`,
    ]);
    expect(markers.every((m) => m.status === 'resolved')).toBe(true);
    expect(markers[0]!.detail).toContain('superseded');
  });

  it('touches nothing when no divergence is open (and never another spec)', () => {
    const resolved: Signal = { ...open(SPEC, AD), status: 'resolved', resolvedAt: T2 };
    expect(
      supersededReplayDivergenceSignals({
        existing: [resolved],
        specId: SPEC,
        recording: AD,
        now: T3,
      }),
    ).toEqual([]);
    expect(
      supersededReplayDivergenceSignals({ existing: [], specId: SPEC, recording: AD, now: T3 }),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The fold: open → count rises, both close paths → back to baseline.  *
 * ------------------------------------------------------------------ */

describe('buildTrend open-count fold', () => {
  it('rises by one when a journey diverges', () => {
    expect(openCountFromTrend()).toBeNull(); // baseline: no feed at all
    diverge(T1);

    const signals = loadSignals(root);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.status).toBe('open');
    expect(signals[0]!.kind).toBe('replay-divergence');
    expect(openCountFromTrend()).toBe(1);
  });

  it('does NOT double-count the same recording diverging twice', () => {
    diverge(T1);
    diverge(T2);

    const signals = loadSignals(root);
    expect(signals).toHaveLength(1);
    // Re-fires update in place and keep the original episode start.
    expect(signals[0]!.openedAt).toBe(T1);
    expect(signals[0]!.at).toBe(T2);
    expect(openCountFromTrend()).toBe(1);

    // The transition feed carries ONE open row: a steady-state re-fire is not a
    // transition, so the running count cannot drift above the real one.
    const opens = readSignalHistory(root).filter((r) => r.status === 'open');
    expect(opens).toHaveLength(1);
  });

  it('returns to baseline when a later replay of the same recording reproduces (path a)', () => {
    diverge(T1);
    expect(openCountFromTrend()).toBe(1);

    reproduce(T2);

    const signals = loadSignals(root);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.status).toBe('resolved');
    expect(signals[0]!.resolvedAt).toBe(T2);
    expect(openCountFromTrend()).toBe(0);
  });

  it('returns to baseline when a fresh verify publishes a new signed recording (path b)', () => {
    diverge(T1);
    expect(openCountFromTrend()).toBe(1);

    supersedeReplayDivergence(root, {
      specId: SPEC,
      recording: AD,
      now: T2,
      historyCommitted: true,
    });

    const signals = loadSignals(root);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.status).toBe('resolved');
    expect(signals[0]!.detail).toContain('superseded');
    expect(openCountFromTrend()).toBe(0);
  });

  it('counts two different recordings of one spec separately, and drains both on publication', () => {
    diverge(T1, 'replay.ad');
    diverge(T1, 'journey-2.ad');
    expect(openCountFromTrend()).toBe(2);

    supersedeReplayDivergence(root, {
      specId: SPEC,
      recording: 'replay.ad',
      now: T3,
      historyCommitted: true,
    });
    expect(openCountFromTrend()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The no-launder rule + write discipline.                             *
 * ------------------------------------------------------------------ */

describe('write discipline', () => {
  it('a reproducing replay of a journey nobody reported writes nothing at all', () => {
    expect(reproduce(T1)).toEqual([]);
    expect(loadSignals(root)).toEqual([]);
    expect(readSignalHistory(root)).toEqual([]);
    expect(openCountFromTrend()).toBeNull();
  });

  it('always appends the local transition feed, even without historyCommitted', () => {
    recordReplayDivergence(root, {
      specId: SPEC,
      recording: AD,
      outcome: 'diverged',
      detail: 'd',
      now: T1,
      // historyCommitted omitted — the local feed is still the rebuild source.
    });
    expect(loadSignals(root)).toHaveLength(1);
    expect(readSignalHistory(root)).toHaveLength(1);
    expect(readSignalHistory(root)[0]!.status).toBe('open');
  });

  it('keeps an EXISTING feed complete even without an explicit opt-in', () => {
    diverge(T1); // opts in, creating the feed
    const before = readSignalHistory(root).length;
    // A close arriving from a surface with no config in scope (attestRecording)
    // must still reach the feed, or the next tick reads the signal as already
    // resolved and the transition is lost forever.
    supersedeReplayDivergence(root, { specId: SPEC, recording: AD, now: T2 });
    expect(readSignalHistory(root).length).toBe(before + 1);
    expect(openCountFromTrend()).toBe(0);
  });

  it('leaves unrelated signals untouched', () => {
    const other: Signal = {
      id: 'regression:spec-other:AC-1',
      kind: 'regression',
      severity: 'high',
      specId: 'spec-other',
      criterionId: 'AC-1',
      detail: 'broke',
      at: T1,
      openedAt: T1,
      status: 'open',
    };
    saveSignals(root, [other]);
    diverge(T2);
    reproduce(T3);
    const ids = loadSignals(root)
      .filter((s) => s.status === 'open')
      .map((s) => s.id);
    expect(ids).toEqual(['regression:spec-other:AC-1']);
  });
});

/* ------------------------------------------------------------------ *
 * Path (b) end-to-end: the hook inside `attestRecording`.             *
 * ------------------------------------------------------------------ */

describe('attestRecording supersession hook', () => {
  const RUN_ID = 'run-supersede-1';

  function seedRun(): string {
    const dir = runDir(root, RUN_ID);
    mkdirSync(resolve(dir, 'screenshots'), { recursive: true });
    const shot = resolve(dir, 'screenshots', 'form__base.png');
    writeFileSync(shot, Buffer.from('PNG-BYTES'));
    const meta: RunMeta = {
      runId: RUN_ID,
      createdAt: T1,
      mode: 'isolation',
      prompt: 'checkout',
      scenarios: [],
      diff: { files: [] },
      report: { enabled: true, brand: 'validity' },
      specId: SPEC,
      specVersion: 1,
      components: [{ id: 'form', filePath: 'src/Form.tsx', screenshotPath: shot }],
    } as unknown as RunMeta;
    writeFileSync(runMetaPathFor(root, RUN_ID), JSON.stringify(meta, null, 2));
    return dir;
  }

  it('resolves the open divergence when a NEW signed `.ad` is published for the spec', () => {
    diverge(T1);
    expect(openCountFromTrend()).toBe(1);

    const dir = seedRun();
    expect(attestRun(root, RUN_ID)).not.toBeNull();
    writeFileSync(
      resolve(dir, REPLAY_RECORDING_FILENAME),
      'context platform=android\nwait id="x"\n',
    );
    const record = attestRecording(root, RUN_ID)!;
    expect(record.recording?.file).toBe(REPLAY_RECORDING_FILENAME);

    const signals = loadSignals(root);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.status).toBe('resolved');
    expect(signals[0]!.detail).toContain('superseded');
    expect(openCountFromTrend()).toBe(0);
  });

  it('re-signing the SAME recording bytes supersedes nothing', () => {
    const dir = seedRun();
    attestRun(root, RUN_ID);
    writeFileSync(
      resolve(dir, REPLAY_RECORDING_FILENAME),
      'context platform=android\nwait id="x"\n',
    );
    attestRecording(root, RUN_ID);

    // The divergence is observed AFTER publication — that is the real ordering:
    // verify signs the journey, a later replay finds it broken.
    diverge(T2);
    expect(openCountFromTrend()).toBe(1);

    // Re-rendering the run's report re-signs the identical bytes. That is a
    // republication of the SAME journey and must not read as a fresh recording.
    attestRecording(root, RUN_ID);
    expect(loadSignals(root)[0]!.status).toBe('open');
    expect(openCountFromTrend()).toBe(1);
  });

  it('signing a run whose payload carries no specId never touches the queue', () => {
    diverge(T1);
    const dir = runDir(root, 'run-no-spec');
    mkdirSync(resolve(dir, 'screenshots'), { recursive: true });
    writeFileSync(
      runMetaPathFor(root, 'run-no-spec'),
      JSON.stringify({
        runId: 'run-no-spec',
        createdAt: T1,
        mode: 'isolation',
        prompt: 'p',
        scenarios: [],
        diff: { files: [] },
        report: { enabled: true, brand: 'validity' },
        components: [],
      }),
    );
    attestRun(root, 'run-no-spec');
    writeFileSync(resolve(dir, REPLAY_RECORDING_FILENAME), 'context platform=android\n');
    attestRecording(root, 'run-no-spec');
    expect(loadSignals(root)[0]!.status).toBe('open');
    expect(openCountFromTrend()).toBe(1);
  });

  it('the attestation itself is unaffected by the hook', () => {
    const dir = seedRun();
    const before = attestRun(root, RUN_ID)!;
    writeFileSync(resolve(dir, REPLAY_RECORDING_FILENAME), 'context platform=android\n');
    const after = attestRecording(root, RUN_ID)!;
    // Third signature only — the payload digest is untouched (adding the
    // recording there would re-digest every run ever signed).
    expect(after.digest).toBe(before.digest);
    expect(after.signature).toBe(before.signature);
    expect(after.recording?.sha256).toMatch(/^[0-9a-f]{64}$/);
    // And nothing was written to a queue that had nothing open.
    expect(loadSignals(root)).toEqual([]);
    expect(readSignalHistory(root)).toEqual([]);
  });
});
