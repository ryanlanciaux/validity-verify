/**
 * In-flight verify markers — the on-disk signal that a verify run is CURRENTLY
 * executing, so the live dashboard can show "◍ verifying <spec>" BEFORE any
 * report or verdict exists on disk.
 *
 * One tiny JSON file per run at `.validity/inflight/<runId>.json`, written when
 * a verify starts (after config checks) and removed in a `finally`
 * on every exit path — success, early return, and throw. `submit_report` clears
 * any leftover marker for its runId as a backstop, so a crash between verify and
 * submit can't leave a permanently "verifying" row.
 *
 * The schema is deliberately minimal and append-only: the dashboard snapshot
 * reads the whole directory, ages each marker against its ONE sanctioned
 * wall-clock read (`generatedAt`), and treats a marker older than the
 * abandonment window as a crashed/killed verify (see `dashboard-snapshot.ts`).
 * These marker files + `generatedAt` are the only sanctioned dynamic inputs to
 * the otherwise-pure dashboard render pipeline.
 *
 * Tolerance contract (mirrors the rest of the `.validity/` state layer): every
 * function here is best-effort and NEVER throws. A verify must not fail because
 * its progress marker couldn't be written or removed, and a half-written or
 * corrupt marker must not take the dashboard down — it is simply skipped.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * One in-progress verify. Written at verify start; the reader ages `startedAt`
 * against the snapshot clock. `specId`/`planId` are optional because unplanned
 * and URL-mode runs have neither.
 */
export interface InflightMarker {
  runId: string;
  /** Frozen spec id under verification, when the run is spec-scoped. */
  specId?: string;
  /** Plan/spec id the caller passed, when any. */
  planId?: string;
  mode: 'isolation' | 'url' | 'native';
  /** ISO-8601 UTC timestamp the verify started. */
  startedAt: string;
}

/** `<projectRoot>/.validity/inflight` — the marker directory. */
export function inflightDir(projectRoot: string): string {
  return resolve(projectRoot, '.validity', 'inflight');
}

function markerPath(projectRoot: string, runId: string): string {
  return resolve(inflightDir(projectRoot), `${runId}.json`);
}

/**
 * Record a verify as in-progress. Best-effort: a write failure is swallowed so
 * the verify proceeds regardless (the marker is a UI nicety, never a gate).
 */
export function writeInflightMarker(projectRoot: string, marker: InflightMarker): void {
  try {
    mkdirSync(inflightDir(projectRoot), { recursive: true });
    writeFileSync(markerPath(projectRoot, marker.runId), JSON.stringify(marker, null, 2));
  } catch {
    // best-effort — never fail a verify because its progress marker didn't write
  }
}

/**
 * Remove a run's in-progress marker. Idempotent + best-effort: an already-gone
 * marker (or an unremovable one) is fine — the reader ages any survivor out via
 * the abandonment window.
 */
export function clearInflightMarker(projectRoot: string, runId: string): void {
  try {
    rmSync(markerPath(projectRoot, runId), { force: true });
  } catch {
    // best-effort — a leftover marker ages out via the abandonment window
  }
}

/**
 * Read every valid marker under the inflight directory. Missing directory ⇒
 * empty; a corrupt or partially-written marker file is skipped, never thrown.
 */
export function readInflightMarkers(projectRoot: string): InflightMarker[] {
  const dir = inflightDir(projectRoot);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const markers: InflightMarker[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(resolve(dir, name), 'utf-8')) as unknown;
      if (isInflightMarker(parsed)) markers.push(parsed);
    } catch {
      // skip a partially-written or corrupt marker
    }
  }
  return markers;
}

function isInflightMarker(v: unknown): v is InflightMarker {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.runId === 'string' &&
    typeof m.startedAt === 'string' &&
    (m.mode === 'isolation' || m.mode === 'url' || m.mode === 'native') &&
    (m.specId === undefined || typeof m.specId === 'string') &&
    (m.planId === undefined || typeof m.planId === 'string')
  );
}
