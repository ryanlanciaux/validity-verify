import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BASELINE_CAPTURES,
  appendCaptureMetric,
  commandCostTotals,
  deviceDurationFor,
  deviceOpenCount,
  noteCommandCost,
  noteDeviceOpen,
  resetCommandCost,
  takeCommandCost,
  parseAgentDeviceEvents,
  parseAgentDeviceEventsJson,
  percentile,
  readSessionMetrics,
  resetDeviceOpenCount,
  sessionHealthWarning,
  sessionMetricsPath,
  splitSessions,
  summarizeSessionHealth,
  type CaptureMetricRow,
} from './session-metrics.js';

const dirs: string[] = [];
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'validity-metrics-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
beforeEach(() => resetDeviceOpenCount());

const T0 = Date.parse('2026-07-28T10:00:00.000Z');

function row(over: Partial<CaptureMetricRow> = {}, minute = 0): CaptureMetricRow {
  return {
    ts: new Date(T0 + minute * 60_000).toISOString(),
    platform: 'android',
    openMs: 500,
    snapshotMs: 300,
    screenshotMs: 100,
    renderStatus: 'confirmed',
    openCallCount: 1,
    ...over,
  };
}

describe('appendCaptureMetric / readSessionMetrics', () => {
  it('appends one JSONL row per capture under .validity/runs', () => {
    const root = project();
    appendCaptureMetric(root, row({ specId: 'spec-1' }));
    appendCaptureMetric(root, row({ specId: 'spec-2', renderStatus: 'unconfirmed' }, 1));

    const raw = readFileSync(sessionMetricsPath(root), 'utf-8');
    expect(raw.trim().split('\n')).toHaveLength(2);
    expect(sessionMetricsPath(root)).toMatch(/\.validity\/runs\/native-session-metrics\.jsonl$/);

    const rows = readSessionMetrics(root);
    expect(rows.map((r) => r.specId)).toEqual(['spec-1', 'spec-2']);
    expect(rows[1]!.renderStatus).toBe('unconfirmed');
  });

  it('swallows write failures — instrumentation can never fail a capture', () => {
    const root = project();
    // A FILE where the runs directory needs to be: mkdir + append both fail.
    mkdirSync(dirname(sessionMetricsPath(root)).replace(/\/runs$/, ''), { recursive: true });
    writeFileSync(join(root, '.validity', 'runs'), 'not a directory');
    expect(() => appendCaptureMetric(root, row())).not.toThrow();
  });

  it('returns [] when the log does not exist', () => {
    expect(readSessionMetrics(project())).toEqual([]);
  });

  it('drops malformed lines instead of throwing (a half-written row must not blind the read)', () => {
    const root = project();
    appendCaptureMetric(root, row({ specId: 'good' }));
    const path = sessionMetricsPath(root);
    writeFileSync(path, `${readFileSync(path, 'utf-8')}{"ts":"broken\n{}\n`);
    appendCaptureMetric(root, row({ specId: 'also-good' }, 1));

    expect(readSessionMetrics(root).map((r) => r.specId)).toEqual(['good', 'also-good']);
  });
});

describe('open-call counter', () => {
  it('counts opens across the process', () => {
    expect(deviceOpenCount()).toBe(0);
    noteDeviceOpen();
    noteDeviceOpen();
    expect(deviceOpenCount()).toBe(2);
    resetDeviceOpenCount();
    expect(deviceOpenCount()).toBe(0);
  });
});

describe('percentile', () => {
  it('is nearest-rank: p95 is a value that was actually measured', () => {
    const values = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    expect(percentile(values, 95)).toBe(1900);
    expect(percentile(values, 50)).toBe(1000);
  });

  it('returns undefined for no samples — never 0', () => {
    expect(percentile([], 95)).toBeUndefined();
  });

  it('handles a single sample and ignores non-finite values', () => {
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([Number.NaN, 7], 95)).toBe(7);
  });
});

describe('splitSessions', () => {
  it('splits on an idle gap longer than SESSION_GAP_MS', () => {
    const rows = [row({}, 0), row({}, 1), row({}, 60), row({}, 61)];
    expect(splitSessions(rows).map((s) => s.length)).toEqual([2, 2]);
  });

  it('keeps back-to-back captures in one session', () => {
    expect(splitSessions([row({}, 0), row({}, 2), row({}, 5)])).toHaveLength(1);
  });

  // ---- 2026-07-29 regression -----------------------------------------------
  // Two sweeps minutes apart, with a daemon kill + state wipe between them, were
  // welded into ONE session: the trailing unconfirmed streak spanned the reset,
  // and decay was diagnosed on a four-minute-old daemon.
  it('splits when openCallCount REGRESSES — that is a new host process', () => {
    const rows = [
      row({ openCallCount: 11 }, 0),
      row({ openCallCount: 12 }, 1),
      row({ openCallCount: 1 }, 2), // fresh CLI/MCP process → new session
      row({ openCallCount: 2 }, 3),
    ];
    expect(splitSessions(rows).map((s) => s.length)).toEqual([2, 2]);
  });

  it('does NOT split on a repeated count — a warm re-target performs no open', () => {
    const rows = [
      row({ openCallCount: 4 }, 0),
      row({ openCallCount: 4 }, 1),
      row({ openCallCount: 4 }, 2),
    ];
    expect(splitSessions(rows)).toHaveLength(1);
  });
});

describe('summarizeSessionHealth', () => {
  it('summarizes only the CURRENT session', () => {
    const yesterday = [row({ snapshotMs: 9000 }, 0), row({ snapshotMs: 9000 }, 1)];
    const now = [row({ snapshotMs: 100 }, 120), row({ snapshotMs: 200 }, 121)];
    const health = summarizeSessionHealth([...yesterday, ...now]);
    expect(health.count).toBe(2);
    expect(health.p95SnapshotMs).toBe(200);
  });

  it('counts the trailing run of unconfirmed renders only', () => {
    const rows = [
      row({ renderStatus: 'unconfirmed' }, 0),
      row({ renderStatus: 'confirmed' }, 1),
      row({ renderStatus: 'unconfirmed' }, 2),
      row({ renderStatus: 'failed' }, 3),
    ];
    expect(summarizeSessionHealth(rows).consecutiveUnconfirmed).toBe(2);
  });

  it('reports 0 unconfirmed when the last render confirmed', () => {
    const rows = [row({ renderStatus: 'unconfirmed' }, 0), row({ renderStatus: 'confirmed' }, 1)];
    expect(summarizeSessionHealth(rows).consecutiveUnconfirmed).toBe(0);
  });

  it('computes an opening baseline and a recent window', () => {
    const rows = [
      ...Array.from({ length: BASELINE_CAPTURES }, (_, i) => row({ snapshotMs: 200 }, i)),
      ...Array.from({ length: BASELINE_CAPTURES }, (_, i) =>
        row({ snapshotMs: 3000 }, BASELINE_CAPTURES + i),
      ),
    ];
    const health = summarizeSessionHealth(rows);
    expect(health.openingP95SnapshotMs).toBe(200);
    expect(health.recentP95SnapshotMs).toBe(3000);
    expect(health.count).toBe(2 * BASELINE_CAPTURES);
  });

  it('leaves p95 undefined when no capture reported a snapshot time', () => {
    const health = summarizeSessionHealth([row({ snapshotMs: undefined })]);
    expect(health.p95SnapshotMs).toBeUndefined();
  });

  it('carries the newest row’s open-call count', () => {
    const health = summarizeSessionHealth([
      row({ openCallCount: 3 }, 0),
      row({ openCallCount: 9 }, 1),
    ]);
    expect(health.openCallCount).toBe(9);
  });

  // ---- 2026-07-29 regression: epochStartMs ---------------------------------
  it('drops every capture written before the supplied epoch', () => {
    const rows = [
      row({ renderStatus: 'unconfirmed' }, 0),
      row({ renderStatus: 'unconfirmed' }, 1),
      row({ renderStatus: 'unconfirmed' }, 2),
      row({ renderStatus: 'unconfirmed' }, 5),
    ];
    const health = summarizeSessionHealth(rows, { epochStartMs: T0 + 4 * 60_000 });
    expect(health.count).toBe(1);
    expect(health.consecutiveUnconfirmed).toBe(1);
    expect(health.epochStartMs).toBe(T0 + 4 * 60_000);
    expect(health.firstCaptureTs).toBe(new Date(T0 + 5 * 60_000).toISOString());
  });

  it('keeps every row when no epoch is supplied, or when the epoch is not a number', () => {
    const rows = [row({}, 0), row({}, 1)];
    expect(summarizeSessionHealth(rows).count).toBe(2);
    expect(summarizeSessionHealth(rows).epochStartMs).toBeUndefined();
    expect(summarizeSessionHealth(rows, { epochStartMs: Number.NaN }).count).toBe(2);
  });

  it('KEEPS a row whose timestamp cannot be read — an unreadable clock is not evidence', () => {
    const rows = [{ ...row({}, 0), ts: 'not-a-date' }, row({}, 5)];
    expect(summarizeSessionHealth(rows, { epochStartMs: T0 + 4 * 60_000 }).count).toBe(2);
  });
});

describe('sessionHealthWarning', () => {
  it('warns once p95 is over 2s across enough captures', () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ snapshotMs: 2500 }, i));
    const warning = sessionHealthWarning(rows);
    expect(warning).toContain('p95 2500ms over 25 captures');
  });

  it('stays quiet on a small sample, however slow', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ snapshotMs: 9000 }, i));
    expect(sessionHealthWarning(rows)).toBeUndefined();
  });

  it('stays quiet on a fast session', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ snapshotMs: 300 }, i));
    expect(sessionHealthWarning(rows)).toBeUndefined();
  });

  it('accepts a pre-computed health summary', () => {
    expect(
      sessionHealthWarning({
        count: 30,
        p95SnapshotMs: 4000,
        consecutiveUnconfirmed: 0,
        openCallCount: 0,
      }),
    ).toContain('p95 4000ms');
  });
});
/* -------------------------------------------------------------------------- */
/* agent-device events.ndjson (per-capture timings, grounded)                  */
/* -------------------------------------------------------------------------- */

/**
 * VERBATIM records from a live `agent-device events` stream (0.20.3,
 * emulator-5554, 2026-07-30). Kept byte-faithful — including the paired
 * `request.started` and the `summary` field — so a change to the upstream shape
 * shows up here as a test failure rather than as silently absent timings in
 * production.
 */
const EVENTS_NDJSON = [
  '{"version":1,"ts":"2026-07-30T22:05:27.748Z","session":"cwd:74d3524ec52ddcb5:default","kind":"request.started","requestId":"a1","command":"wait","summary":"Started wait"}',
  '{"version":1,"ts":"2026-07-30T22:05:28.331Z","session":"cwd:74d3524ec52ddcb5:default","kind":"request.finished","requestId":"a1","command":"wait","status":"ok","summary":"Ran wait","details":{"durationMs":583}}',
  '{"version":1,"ts":"2026-07-30T22:05:28.452Z","session":"cwd:74d3524ec52ddcb5:default","kind":"request.started","requestId":"b2","command":"snapshot","summary":"Started snapshot"}',
  '{"version":1,"ts":"2026-07-30T22:05:28.511Z","session":"cwd:74d3524ec52ddcb5:default","kind":"request.finished","requestId":"b2","command":"snapshot","status":"ok","summary":"Ran snapshot","details":{"durationMs":59}}',
  '{"version":1,"ts":"2026-07-30T22:05:41.746Z","session":"cwd:74d3524ec52ddcb5:default","kind":"request.finished","requestId":"c3","command":"snapshot","status":"ok","summary":"Ran snapshot","details":{"durationMs":25}}',
].join('\n');

const AT = (iso: string): number => Date.parse(iso);

describe('parseAgentDeviceEvents', () => {
  it('keeps only finished requests, with their daemon-measured durations', () => {
    const events = parseAgentDeviceEvents(EVENTS_NDJSON);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      command: 'wait',
      status: 'ok',
      durationMs: 583,
    });
    expect(events[1]).toMatchObject({
      command: 'snapshot',
      durationMs: 59,
      requestId: 'b2',
    });
  });

  it('drops malformed lines instead of throwing — unreadable evidence is missing, not fatal', () => {
    const events = parseAgentDeviceEvents(
      ['not json at all', '', '{"kind":"request.finished"}', EVENTS_NDJSON].join('\n'),
    );
    // The three good records survive; the junk and the record carrying no
    // ts/command are dropped.
    expect(events).toHaveLength(3);
    expect(parseAgentDeviceEvents('')).toEqual([]);
  });

  it('reads the same records out of the `events --json` envelope', () => {
    const stdout = JSON.stringify({
      success: true,
      data: {
        path: '/x/events.ndjson',
        events: EVENTS_NDJSON.split('\n').map((l) => JSON.parse(l) as unknown),
      },
    });
    expect(parseAgentDeviceEventsJson(stdout).map((e) => e.durationMs)).toEqual([583, 59, 25]);
    expect(parseAgentDeviceEventsJson('{')).toEqual([]);
    expect(parseAgentDeviceEventsJson('{"success":true}')).toEqual([]);
  });
});

describe('deviceDurationFor', () => {
  const events = parseAgentDeviceEvents(EVENTS_NDJSON);

  it('returns the daemon-side duration of a command inside the window', () => {
    expect(
      deviceDurationFor(
        events,
        'snapshot',
        AT('2026-07-30T22:05:28.000Z'),
        AT('2026-07-30T22:05:29.000Z'),
      ),
    ).toBe(59);
    expect(
      deviceDurationFor(
        events,
        'wait',
        AT('2026-07-30T22:05:27.000Z'),
        AT('2026-07-30T22:05:29.000Z'),
      ),
    ).toBe(583);
  });

  it('takes the LAST match — a capture snapshots repeatedly and the row wants its final read', () => {
    // The settle gate alone issues several snapshots; the number that belongs
    // on the row is the one the host-side `snapshotMs` timed, i.e. the last.
    expect(
      deviceDurationFor(
        events,
        'snapshot',
        AT('2026-07-30T22:05:00.000Z'),
        AT('2026-07-30T22:06:00.000Z'),
      ),
    ).toBe(25);
  });

  it('answers undefined outside the window, for an unknown verb, or with no events', () => {
    expect(
      deviceDurationFor(
        events,
        'snapshot',
        AT('2026-07-30T21:00:00.000Z'),
        AT('2026-07-30T21:00:01.000Z'),
      ),
    ).toBeUndefined();
    expect(deviceDurationFor(events, 'screenshot', 0, Date.now())).toBeUndefined();
    expect(deviceDurationFor([], 'snapshot', 0, Date.now())).toBeUndefined();
  });

  it('ignores failed requests — a command that errored did not measure the device', () => {
    const failed = parseAgentDeviceEvents(
      '{"version":1,"ts":"2026-07-30T22:05:28.511Z","kind":"request.finished","command":"snapshot","status":"error","details":{"durationMs":9999}}',
    );
    expect(deviceDurationFor(failed, 'snapshot', 0, Date.now())).toBeUndefined();
  });
});

describe('readSessionMetrics — device-side timings are additive', () => {
  it('parses the new fields when present', () => {
    const dir = project();
    appendCaptureMetric(dir, {
      ts: new Date().toISOString(),
      platform: 'android',
      openMs: 100,
      snapshotMs: 900,
      snapshotDeviceMs: 59,
      screenshotDeviceMs: 120,
      renderStatus: 'confirmed',
      openCallCount: 1,
    });
    expect(readSessionMetrics(dir)[0]).toMatchObject({
      snapshotDeviceMs: 59,
      screenshotDeviceMs: 120,
    });
  });

  it('still parses rows written BEFORE the events stream was consumed', () => {
    // The compatibility guarantee: an old log carries no device-side fields and
    // must read exactly as it always did rather than being dropped.
    const dir = project();
    const path = sessionMetricsPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        ts: '2026-07-29T10:00:00.000Z',
        platform: 'android',
        openMs: 100,
        snapshotMs: 900,
        renderStatus: 'confirmed',
        openCallCount: 1,
      })}\n`,
    );
    const rows = readSessionMetrics(dir);
    expect(rows[0]).toMatchObject({
      snapshotMs: 900,
      renderStatus: 'confirmed',
    });
    expect(rows[0]!.snapshotDeviceMs).toBeUndefined();
  });
});

describe('daemon-reported command cost (agent-device 0.20.5 `--cost`)', () => {
  beforeEach(() => resetCommandCost());

  it('accumulates wall-clock across commands and reports the sample count', () => {
    noteCommandCost(120);
    noteCommandCost(80);
    expect(commandCostTotals()).toEqual({ totalMs: 200, samples: 2 });
  });

  it('ignores unusable numbers rather than quietly moving the total', () => {
    noteCommandCost(Number.NaN);
    noteCommandCost(-5);
    noteCommandCost(Number.POSITIVE_INFINITY);
    expect(commandCostTotals()).toEqual({ totalMs: 0, samples: 0 });
  });

  it('takeCommandCost returns the delta and resets, so rows cannot double-count', () => {
    noteCommandCost(300);
    expect(takeCommandCost()).toEqual({ totalMs: 300, samples: 1 });
    expect(commandCostTotals()).toEqual({ totalMs: 0, samples: 0 });
    noteCommandCost(50);
    expect(takeCommandCost()).toEqual({ totalMs: 50, samples: 1 });
  });

  it('reads the additive row fields back, and leaves them ABSENT when unwritten', () => {
    const rows = readSessionMetrics('/p', () =>
      [
        JSON.stringify({
          ts: '2026-08-06T10:00:00.000Z',
          platform: 'ios',
          openMs: 10,
          renderStatus: 'confirmed',
          openCallCount: 1,
          deviceCostMs: 812,
          deviceCostSamples: 3,
        }),
        // A row written before `--cost` existed: no cost fields at all.
        JSON.stringify({
          ts: '2026-08-06T10:00:01.000Z',
          platform: 'ios',
          openMs: 11,
          renderStatus: 'confirmed',
          openCallCount: 1,
        }),
      ].join('\n'),
    );
    expect(rows[0]!.deviceCostMs).toBe(812);
    expect(rows[0]!.deviceCostSamples).toBe(3);
    // Never defaulted to 0 — "no cost reported" and "a free capture" are
    // different claims.
    expect(rows[1]!.deviceCostMs).toBeUndefined();
    expect(rows[1]!.deviceCostSamples).toBeUndefined();
  });
});
