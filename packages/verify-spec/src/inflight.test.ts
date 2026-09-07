/**
 * In-flight verify markers — the on-disk liveness signal the live dashboard
 * reads to show "◍ verifying" before any report exists. Covers the round-trip
 * (write → read → clear), tolerance (missing dir, corrupt marker), and the
 * schema guard.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearInflightMarker,
  inflightDir,
  readInflightMarkers,
  writeInflightMarker,
} from './inflight.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'validity-inflight-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('inflight markers', () => {
  it('writes a marker (creating the dir) and reads it back', () => {
    writeInflightMarker(root, {
      runId: 'run_1',
      specId: 'spec-abc',
      planId: 'spec-abc',
      mode: 'isolation',
      startedAt: '2026-07-18T00:00:00.000Z',
    });
    const markers = readInflightMarkers(root);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      runId: 'run_1',
      specId: 'spec-abc',
      mode: 'isolation',
      startedAt: '2026-07-18T00:00:00.000Z',
    });
  });

  it('clears a marker (idempotent — a second clear is a no-op)', () => {
    writeInflightMarker(root, {
      runId: 'run_1',
      mode: 'url',
      startedAt: '2026-07-18T00:00:00.000Z',
    });
    expect(readInflightMarkers(root)).toHaveLength(1);
    clearInflightMarker(root, 'run_1');
    expect(readInflightMarkers(root)).toHaveLength(0);
    // idempotent — clearing a gone marker throws nothing
    expect(() => clearInflightMarker(root, 'run_1')).not.toThrow();
  });

  it('reads every marker and each clear only removes its own', () => {
    for (const runId of ['run_a', 'run_b', 'run_c']) {
      writeInflightMarker(root, { runId, mode: 'native', startedAt: '2026-07-18T00:00:00.000Z' });
    }
    expect(
      readInflightMarkers(root)
        .map((m) => m.runId)
        .sort(),
    ).toEqual(['run_a', 'run_b', 'run_c']);
    clearInflightMarker(root, 'run_b');
    expect(
      readInflightMarkers(root)
        .map((m) => m.runId)
        .sort(),
    ).toEqual(['run_a', 'run_c']);
  });

  it('returns [] when the inflight dir does not exist (no throw)', () => {
    expect(readInflightMarkers(root)).toEqual([]);
  });

  it('skips a corrupt / half-written marker, keeps the valid ones', () => {
    mkdirSync(inflightDir(root), { recursive: true });
    writeFileSync(
      resolve(inflightDir(root), 'run_ok.json'),
      JSON.stringify({ runId: 'run_ok', mode: 'isolation', startedAt: '2026-07-18T00:00:00.000Z' }),
    );
    writeFileSync(resolve(inflightDir(root), 'run_bad.json'), '{ not valid json');
    // a JSON file that parses but fails the schema guard (bad `mode`)
    writeFileSync(
      resolve(inflightDir(root), 'run_shape.json'),
      JSON.stringify({ runId: 'x', mode: 'sideways', startedAt: 'z' }),
    );
    // a non-json sibling is ignored entirely
    writeFileSync(resolve(inflightDir(root), 'note.txt'), 'ignore me');
    const markers = readInflightMarkers(root);
    expect(markers.map((m) => m.runId)).toEqual(['run_ok']);
    // the noise files are still on disk — read is non-destructive
    expect(readdirSync(inflightDir(root)).sort()).toEqual([
      'note.txt',
      'run_bad.json',
      'run_ok.json',
      'run_shape.json',
    ]);
  });
});
