/**
 * Network evidence — argv, capture, and the deliberately-tolerant summary.
 *
 * The load-bearing assertion in this file is the one about an UNRECOGNIZED
 * payload: it must summarize as `undefined`, never as "0 requests". "0
 * requests" would be read as "the app made no network calls" — a claim the
 * parser did not earn, and exactly the false green this package exists to
 * refuse.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  collectNetworkEvidence,
  networkDumpArgs,
  networkSummaryLine,
  summarizeNetworkDump,
} from './network-evidence.js';
import { DEVICE_EVIDENCE_SCHEMA, type DeviceEvidence } from './perf-evidence.js';

const NOW = new Date('2026-08-06T12:00:00.000Z');
const ctx = { platform: 'ios' as const, device: 'iPhone-15', now: () => NOW };

describe('networkDumpArgs', () => {
  it('is the plain --json form', () => {
    expect(networkDumpArgs()).toEqual(['network', 'dump', '--json']);
  });

  it('passes a record limit as the positional upstream accepts', () => {
    expect(networkDumpArgs({ limit: 25 })).toEqual(['network', 'dump', '25', '--json']);
  });

  it('ignores a nonsense limit rather than sending it', () => {
    expect(networkDumpArgs({ limit: 0 })).toEqual(['network', 'dump', '--json']);
    expect(networkDumpArgs({ limit: -3 })).toEqual(['network', 'dump', '--json']);
    expect(networkDumpArgs({ limit: 1.5 })).toEqual(['network', 'dump', '--json']);
  });

  it('NEVER asks for headers or bodies — this lands in a shareable run dir', () => {
    // `Authorization: Bearer …` is exactly what `--include headers` returns.
    const args = networkDumpArgs({ limit: 10 });
    expect(args).not.toContain('--include');
    expect(args).not.toContain('headers');
    expect(args).not.toContain('all');
  });
});

describe('collectNetworkEvidence', () => {
  it('captures through the injected runner and labels the record', async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        success: true,
        data: { requests: [{ url: 'https://api.example.com/items', status: 200 }] },
      }),
      stderr: '',
    }));
    const e = await collectNetworkEvidence({ run, ...ctx, cwd: '/p', limit: 25 });
    expect(run).toHaveBeenCalledWith('agent-device', ['network', 'dump', '25', '--json'], {
      env: { AGENT_DEVICE_PLATFORM: 'ios', AGENT_DEVICE_ID: 'iPhone-15' },
      cwd: '/p',
      timeoutMs: 20_000,
    });
    expect(e.kind).toBe('network-dump');
    expect(e.schema).toBe(DEVICE_EVIDENCE_SCHEMA);
    expect(e.status).toBe('captured');
    expect(e.scoring).toBe('advisory-evidence-only');
  });

  it('records "could not tell" when the session is gone', async () => {
    const run = vi.fn(async () => ({
      code: 1,
      stdout: JSON.stringify({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'Run open first' },
      }),
      stderr: '',
    }));
    const e = await collectNetworkEvidence({ run, ...ctx });
    expect(e.status).toBe('unavailable');
    expect(e.errorCode).toBe('SESSION_NOT_FOUND');
  });
});

describe('summarizeNetworkDump', () => {
  it('counts requests and lists distinct hosts', () => {
    const summary = summarizeNetworkDump({
      requests: [
        { url: 'https://api.example.com/items' },
        { url: 'https://api.example.com/items/2' },
        { url: 'http://localhost:8081/status' },
      ],
    })!;
    expect(summary.requests).toBe(3);
    expect(summary.hosts).toEqual(['api.example.com', 'localhost:8081']);
  });

  it('finds records under an unfamiliar wrapper (shape tolerance)', () => {
    const summary = summarizeNetworkDump({
      log: { entries: [{ request: { uri: 'https://a.b/c' } }] },
    })!;
    expect(summary.requests).toBe(1);
    expect(summary.hosts).toEqual(['a.b']);
  });

  it('answers UNDEFINED for a payload it cannot read — never "0 requests"', () => {
    expect(summarizeNetworkDump({ summary: 'nothing recognizable' })).toBeUndefined();
    expect(summarizeNetworkDump(undefined)).toBeUndefined();
    expect(summarizeNetworkDump([])).toBeUndefined();
  });

  it('caps the host list and says it did', () => {
    const requests = Array.from({ length: 14 }, (_, i) => ({ url: `https://h${i}.example/x` }));
    const summary = summarizeNetworkDump({ requests })!;
    expect(summary.hosts).toHaveLength(10);
    expect(summary.moreHosts).toBe(true);
  });

  it('survives a self-referential payload without hanging', () => {
    const node: Record<string, unknown> = { url: 'https://a.b/c' };
    node.self = node;
    expect(summarizeNetworkDump(node)!.requests).toBe(1);
  });
});

describe('networkSummaryLine', () => {
  const base: DeviceEvidence = {
    schema: DEVICE_EVIDENCE_SCHEMA,
    kind: 'network-dump',
    source: 'agent-device',
    command: 'agent-device network dump --json',
    capturedAt: NOW.toISOString(),
    phase: 'post-interaction',
    platform: 'ios',
    scoring: 'advisory-evidence-only',
    status: 'captured',
  };

  it('describes the traffic without judging it', () => {
    const line = networkSummaryLine({
      ...base,
      data: { requests: [{ url: 'https://api.example.com/a' }] },
    })!;
    expect(line).toBe('1 request observed across api.example.com');
    expect(line).not.toMatch(/leak|fail|unmocked|violation/i);
  });

  it('says nothing at all when there is nothing captured or nothing parseable', () => {
    expect(networkSummaryLine({ ...base, status: 'unavailable' })).toBeUndefined();
    expect(networkSummaryLine({ ...base, data: { note: 'unknown shape' } })).toBeUndefined();
  });
});
