import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readRunEvidence,
  toReportDeviceEvidence,
  toReportDivergence,
  REPLAY_DEVICE_EVIDENCE_FILE,
  REPLAY_DIVERGENCE_EVIDENCE_FILE,
  VERIFY_DEVICE_EVIDENCE_FILE,
} from './report-run-evidence.js';

/** The persisted `replay-divergence.json` payload, as `validity replay` writes it. */
function divergenceFile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    note: 'Written by `validity replay` AFTER this run was signed…',
    observedAt: '2026-08-06T09:00:00.000Z',
    runId: 'run-1',
    specId: 'spec-x',
    recording: 'recording.ad',
    divergence: {
      version: 1,
      kind: 'selector-miss',
      step: 4,
      action: 'press',
      cause: { code: 'ELEMENT_NOT_FOUND', message: 'no match', hint: 'onboarding was skipped' },
      suggestions: [
        { selector: 'id=cta', basis: 'id', role: 'button', label: 'Go' },
        { selector: 'text=Go', basis: 'label' },
      ],
      suggestionCount: 5,
      resume: { allowed: true, from: 4, planDigest: 'sha256-deadbeef' },
      repairHint: 'record-and-heal',
      screen: { state: 'available', refsGeneration: 4 },
      ...over,
    },
  };
}

describe('toReportDivergence', () => {
  it('flattens the persisted payload and assembles the resume command from the file itself', () => {
    const d = toReportDivergence(divergenceFile())!;
    expect(d.step).toBe(4);
    expect(d.kind).toBe('selector-miss');
    expect(d.action).toBe('press');
    expect(d.observedAt).toBe('2026-08-06T09:00:00.000Z');
    expect(d.recording).toBe('recording.ad');
    expect(d.causeMessage).toBe('no match');
    expect(d.causeCode).toBe('ELEMENT_NOT_FOUND');
    expect(d.causeHint).toBe('onboarding was skipped');
    expect(d.suggestionCount).toBe(5);
    expect(d.repairHint).toBe('record-and-heal');
    expect(d.resumeCommand).toBe(
      'agent-device replay recording.ad --from 4 --plan-digest sha256-deadbeef',
    );
  });

  it('preserves upstream ranking order and drops selector-less suggestions', () => {
    const d = toReportDivergence(
      divergenceFile({
        suggestions: [{ selector: 'a' }, { basis: 'id' }, { selector: 'b' }],
      }),
    )!;
    expect(d.suggestions.map((s) => s.selector)).toEqual(['a', 'b']);
  });

  it('REFUSES to build a resume command when upstream disallowed it, surfacing the reason instead', () => {
    const d = toReportDivergence(
      divergenceFile({
        resume: {
          allowed: false,
          from: 4,
          planDigest: 'sha256-x',
          reason: 'the skipped range touches runtime control flow',
        },
      }),
    )!;
    expect(d.resumeCommand).toBeUndefined();
    expect(d.resumeRefusedReason).toBe('the skipped range touches runtime control flow');
  });

  it('refuses a HALF resume handle — a command upstream would reject is worse than none', () => {
    const d = toReportDivergence(divergenceFile({ resume: { allowed: true, from: 4 } }))!;
    expect(d.resumeCommand).toBeUndefined();
  });

  it('records why the screen could not be read when upstream said so', () => {
    const d = toReportDivergence(
      divergenceFile({
        suggestions: [],
        screen: { state: 'unavailable', reason: 'the app was not foregrounded' },
      }),
    )!;
    expect(d.suggestions).toEqual([]);
    expect(d.screenUnavailableReason).toBe('the app was not foregrounded');
  });

  it('returns undefined for a payload with no divergence, and never throws on junk', () => {
    expect(toReportDivergence(undefined)).toBeUndefined();
    expect(toReportDivergence({})).toBeUndefined();
    expect(toReportDivergence({ divergence: 'nope' })).toBeUndefined();
    expect(toReportDivergence([1, 2, 3])).toBeUndefined();
    // A divergence with nothing readable still yields a record — "we saw drift
    // but could not read it" must not degrade to "no drift".
    expect(toReportDivergence({ divergence: {} })).toEqual({ suggestions: [] });
  });
});

describe('toReportDeviceEvidence', () => {
  it('reads a bundle, preserving record order', () => {
    const records = toReportDeviceEvidence({
      schema: 1,
      records: [
        {
          schema: 1,
          kind: 'perf-metrics',
          source: 'agent-device',
          command: 'agent-device perf metrics --json',
          capturedAt: '2026-08-06T08:00:00.000Z',
          phase: 'post-interaction',
          platform: 'ios',
          device: 'iPhone 17 Pro',
          scoring: 'advisory-evidence-only',
          status: 'captured',
          data: { fps: 60 },
        },
        {
          kind: 'network-dump',
          status: 'unavailable',
          errorCode: 'SESSION_NOT_FOUND',
          unavailableReason: 'no attached session',
        },
      ],
    });
    expect(records.map((r) => r.kind)).toEqual(['perf-metrics', 'network-dump']);
    expect(records[0]).toMatchObject({
      status: 'captured',
      command: 'agent-device perf metrics --json',
      platform: 'ios',
      device: 'iPhone 17 Pro',
      scoring: 'advisory-evidence-only',
    });
    expect(records[1]).toMatchObject({
      status: 'unavailable',
      errorCode: 'SESSION_NOT_FOUND',
      unavailableReason: 'no attached session',
    });
  });

  it('carries the truncation note through instead of dropping the record', () => {
    const [r] = toReportDeviceEvidence({
      records: [{ kind: 'perf-frames', status: 'captured', truncated: true, note: '90000 bytes' }],
    });
    expect(r).toMatchObject({ truncated: true, note: '90000 bytes' });
  });

  it('treats ANY unrecognised status as `unavailable` — never as a successful capture', () => {
    const [a] = toReportDeviceEvidence({ records: [{ kind: 'k', status: 'partial' }] });
    const [b] = toReportDeviceEvidence({ records: [{ kind: 'k' }] });
    expect(a.status).toBe('unavailable');
    expect(b.status).toBe('unavailable');
  });

  it('drops records with no kind, and never throws on junk', () => {
    expect(toReportDeviceEvidence({ records: [{ status: 'captured' }] })).toEqual([]);
    expect(toReportDeviceEvidence(undefined)).toEqual([]);
    expect(toReportDeviceEvidence({ records: 'nope' })).toEqual([]);
    expect(toReportDeviceEvidence([])).toEqual([]);
  });
});

describe('readRunEvidence (run-dir sidecars)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'validity-run-evidence-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (file: string, payload: unknown): void =>
    writeFileSync(resolve(dir, file), JSON.stringify(payload));

  it('returns {} for an empty run dir — absence adds no report fields at all', () => {
    expect(readRunEvidence(dir)).toEqual({});
  });

  it('reads the divergence report', () => {
    write(REPLAY_DIVERGENCE_EVIDENCE_FILE, divergenceFile());
    expect(readRunEvidence(dir).replayDivergence?.step).toBe(4);
  });

  it('groups both bundles in a FIXED order — verify-time before replay-time', () => {
    // Written replay-first on purpose: the output order must come from this
    // module's constant, not from write order or a directory listing.
    write(REPLAY_DEVICE_EVIDENCE_FILE, { records: [{ kind: 'perf-frames', status: 'captured' }] });
    write(VERIFY_DEVICE_EVIDENCE_FILE, { records: [{ kind: 'perf-metrics', status: 'captured' }] });
    const groups = readRunEvidence(dir).deviceEvidence!;
    expect(groups.map((g) => g.file)).toEqual([
      VERIFY_DEVICE_EVIDENCE_FILE,
      REPLAY_DEVICE_EVIDENCE_FILE,
    ]);
    expect(groups.map((g) => g.phase)).toEqual(['verify', 'replay']);
  });

  it('omits a bundle whose records list is empty rather than rendering an empty group', () => {
    write(VERIFY_DEVICE_EVIDENCE_FILE, { records: [] });
    expect(readRunEvidence(dir).deviceEvidence).toBeUndefined();
  });

  it('degrades to "no evidence" on malformed JSON, never throwing', () => {
    writeFileSync(resolve(dir, REPLAY_DIVERGENCE_EVIDENCE_FILE), '{ not json');
    writeFileSync(resolve(dir, VERIFY_DEVICE_EVIDENCE_FILE), 'nope');
    expect(readRunEvidence(dir)).toEqual({});
  });

  it('degrades to "no evidence" for a run dir that does not exist', () => {
    expect(readRunEvidence(resolve(dir, 'nope'))).toEqual({});
  });
});
