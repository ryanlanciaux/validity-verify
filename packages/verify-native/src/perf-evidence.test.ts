/**
 * Perf evidence, tested where it is cheapest: argv construction and envelope
 * classification, with an injected runner and no device anywhere.
 *
 * The assertions that matter are the NEGATIVE ones. Nothing here may turn a
 * number into a verdict, and nothing here may let a missing capture read as a
 * healthy one — those two properties are what make it safe to write device
 * numbers into a run dir at all, and they are the ones a future refactor would
 * quietly break.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyDeviceEvidence,
  collectPerfEvidence,
  evidenceSummaryLine,
  perfFramesArgs,
  perfMetricsArgs,
  writeDeviceEvidence,
  DEVICE_EVIDENCE_SCHEMA,
  MAX_EVIDENCE_BYTES,
  type DeviceEvidence,
} from './perf-evidence.js';

const NOW = new Date('2026-08-06T12:00:00.000Z');
const ctx = { platform: 'android' as const, device: 'emulator-5554', now: () => NOW };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('argv', () => {
  it('uses the documented 0.20.5 first-pass and frame-health forms', () => {
    expect(perfMetricsArgs()).toEqual(['perf', 'metrics', '--json']);
    expect(perfFramesArgs()).toEqual(['perf', 'frames', '--json']);
  });

  it('never escalates to an artifact collector (heaps/traces are not run evidence)', () => {
    for (const args of [perfMetricsArgs(), perfFramesArgs()]) {
      expect(args).not.toContain('snapshot');
      expect(args).not.toContain('trace');
      expect(args).not.toContain('--out');
    }
  });
});

describe('classifyDeviceEvidence', () => {
  it('stores the payload verbatim under a provenance envelope', () => {
    const e = classifyDeviceEvidence({
      kind: 'perf-metrics',
      argv: perfMetricsArgs(),
      res: {
        code: 0,
        stdout: JSON.stringify({ success: true, data: { startupMs: 812, cpuPercent: 12.5 } }),
        stderr: '',
      },
      ctx,
    });
    expect(e).toEqual({
      schema: DEVICE_EVIDENCE_SCHEMA,
      kind: 'perf-metrics',
      source: 'agent-device',
      command: 'agent-device perf metrics --json',
      capturedAt: NOW.toISOString(),
      phase: 'post-interaction',
      platform: 'android',
      device: 'emulator-5554',
      scoring: 'advisory-evidence-only',
      status: 'captured',
      data: { startupMs: 812, cpuPercent: 12.5 },
    });
  });

  it('STAMPS the advisory posture into the artifact, not just the docs', () => {
    // A record copied out of a run dir must still say nothing scores it.
    const e = classifyDeviceEvidence({
      kind: 'perf-frames',
      argv: perfFramesArgs(),
      res: { code: 0, stdout: '{"success":true,"data":{}}', stderr: '' },
      ctx,
    });
    expect(e.scoring).toBe('advisory-evidence-only');
    expect(Object.keys(e)).not.toContain('status_verdict');
    expect(e.phase).toBe('post-interaction');
  });

  it('records a refusal as unavailable WITH the code — never as an empty capture', () => {
    const e = classifyDeviceEvidence({
      kind: 'perf-metrics',
      argv: perfMetricsArgs(),
      res: {
        code: 1,
        stdout: JSON.stringify({
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: 'Run open first' },
        }),
        stderr: '',
      },
      ctx,
    });
    expect(e.status).toBe('unavailable');
    expect(e.errorCode).toBe('SESSION_NOT_FOUND');
    expect(e.unavailableReason).toContain('Run open first');
    expect(e.data).toBeUndefined();
  });

  it('never reads unparseable stdout on exit 0 as a capture', () => {
    const e = classifyDeviceEvidence({
      kind: 'perf-metrics',
      argv: perfMetricsArgs(),
      res: { code: 0, stdout: 'not json', stderr: '' },
      ctx,
    });
    expect(e.status).toBe('unavailable');
    expect(e.unavailableReason).toContain('no readable JSON envelope');
  });

  it('withholds an oversized payload and says how big it was', () => {
    const big = { blob: 'x'.repeat(MAX_EVIDENCE_BYTES + 10) };
    const e = classifyDeviceEvidence({
      kind: 'perf-frames',
      argv: perfFramesArgs(),
      res: { code: 0, stdout: JSON.stringify({ success: true, data: big }), stderr: '' },
      ctx,
    });
    expect(e.status).toBe('captured');
    expect(e.truncated).toBe(true);
    expect(e.data).toBeUndefined();
    expect(e.note).toContain('exceeds the');
  });

  it('redacts device text on the failure path', () => {
    const e = classifyDeviceEvidence({
      kind: 'perf-metrics',
      argv: perfMetricsArgs(),
      res: { code: 1, stdout: '', stderr: 'token hunter2 rejected' },
      ctx: { ...ctx, redact: (s) => s.split('hunter2').join('${PW}') },
    });
    expect(e.unavailableReason).toContain('${PW}');
    expect(e.unavailableReason).not.toContain('hunter2');
  });
});

describe('collectPerfEvidence', () => {
  it('captures both families through the injected runner, with the device env', async () => {
    const run = vi.fn(async (_bin: string, args: string[]) => ({
      code: 0,
      stdout: JSON.stringify({ success: true, data: { via: args.join(' ') } }),
      stderr: '',
    }));
    const out = await collectPerfEvidence({ run, ...ctx, cwd: '/p' });
    expect(run).toHaveBeenNthCalledWith(1, 'agent-device', ['perf', 'metrics', '--json'], {
      env: { AGENT_DEVICE_PLATFORM: 'android', AGENT_DEVICE_ID: 'emulator-5554' },
      cwd: '/p',
      timeoutMs: 20_000,
    });
    expect(out.metrics.kind).toBe('perf-metrics');
    expect(out.frames.kind).toBe('perf-frames');
    expect(out.frames.status).toBe('captured');
  });

  it('turns a THROWN runner into evidence about the environment, not into silence', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn agent-device ENOENT');
    });
    const out = await collectPerfEvidence({ run, ...ctx });
    expect(out.metrics.status).toBe('unavailable');
    expect(out.metrics.unavailableReason).toContain('ENOENT');
  });
});

describe('writeDeviceEvidence', () => {
  it('writes a bundle and reports success', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'validity-perf-'));
    dirs.push(dir);
    const record: DeviceEvidence = {
      schema: DEVICE_EVIDENCE_SCHEMA,
      kind: 'perf-metrics',
      source: 'agent-device',
      command: 'agent-device perf metrics --json',
      capturedAt: NOW.toISOString(),
      phase: 'post-interaction',
      platform: 'ios',
      scoring: 'advisory-evidence-only',
      status: 'captured',
      data: { startupMs: 1 },
    };
    const path = resolve(dir, 'nested', 'evidence.json');
    expect(writeDeviceEvidence(path, [record])).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { records: DeviceEvidence[] };
    expect(parsed.records[0]!.scoring).toBe('advisory-evidence-only');
  });

  it('answers false instead of throwing when the path is unwritable', () => {
    // Evidence collection can never be allowed to fail the thing it documents.
    // The unwritable path is a FILE standing where a directory would have to be
    // (ENOTDIR) — portable, and it stays inside the test's own temp dir.
    const dir = mkdtempSync(resolve(tmpdir(), 'validity-perf-'));
    dirs.push(dir);
    const blocker = resolve(dir, 'not-a-dir');
    writeFileSync(blocker, 'i am a file');
    expect(writeDeviceEvidence(resolve(blocker, 'evidence.json'), [])).toBe(false);
  });
});

describe('evidenceSummaryLine', () => {
  const base: DeviceEvidence = {
    schema: DEVICE_EVIDENCE_SCHEMA,
    kind: 'perf-metrics',
    source: 'agent-device',
    command: 'agent-device perf metrics --json',
    capturedAt: NOW.toISOString(),
    phase: 'post-interaction',
    platform: 'ios',
    scoring: 'advisory-evidence-only',
    status: 'captured',
  };

  it('says what was captured, never what it means', () => {
    const line = evidenceSummaryLine(base);
    expect(line).toContain('captured');
    expect(line).not.toMatch(/pass|fail|slow|regress/i);
  });

  it('names the reason a capture is missing', () => {
    const line = evidenceSummaryLine({
      ...base,
      status: 'unavailable',
      errorCode: 'SESSION_NOT_FOUND',
      unavailableReason: 'no session',
    });
    expect(line).toContain('not captured');
    expect(line).toContain('SESSION_NOT_FOUND');
  });
});
