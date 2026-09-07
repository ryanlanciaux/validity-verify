/**
 * Put a dashboard snapshot on disk so a team can share it through git.
 * Validity ships the renderer; the project owns the data: one machine writes
 * the snapshot and commits it, another opens it with a static file server.
 *
 * This module owns the artifact contract:
 *   - `snapshot.json` — a {@link DashboardSnapshot} plus two ADD-ONLY publish
 *     fields (`publishedBy`, `embeddedHistory`), written deterministically
 *     (same input ⇒ byte-identical bytes);
 *   - `readDashboardSnapshot` — the tolerant reader for dev B's clone;
 *   - `trimEmbeddedHistoryForCommit` — the 90-day window applied by
 *     `--commit-ready` so committed artifacts don't grow forever.
 *
 * Default output is `.validity/dashboard/` (per-machine, gitignored);
 * `--commit-ready` writes `.validity/published/` (tracked).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectGitInfo } from './git.js';
import { detectRunOrigin } from './run-origin.js';
import { readHistoryRows, readSignalHistory, type HistoryRunRow } from './history.js';
import {
  DASHBOARD_SNAPSHOT_VERSION,
  type DashboardSnapshot,
  type EmbeddedHistory,
  type SnapshotPublishedBy,
} from './dashboard-snapshot.js';
import { readScoreHistory } from './scorecard.js';
import { ensureDir, validityDir } from './runs.js';

// The publish-field types are DEFINED on DashboardSnapshot (the add-only
// contract) and re-exported here so publish consumers import one module.
export type { SnapshotPublishedBy, EmbeddedHistory } from './dashboard-snapshot.js';

/** A snapshot with its publish metadata attached (the exact artifact bytes). */
export type PublishedSnapshot = DashboardSnapshot & {
  publishedBy?: SnapshotPublishedBy;
  embeddedHistory?: EmbeddedHistory;
};

/** Per-machine publish output (gitignored alongside runs/ + reports/). */
export function dashboardPublishDir(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'dashboard');
}

/** Commit-ready publish output (tracked — this IS the shared artifact). */
export function publishedDashboardDir(projectRoot: string): string {
  return resolve(validityDir(projectRoot), 'published');
}

/**
 * Stamp WHO published (sha/branch/origin — never hostname or username) and
 * WHEN (`at` = the snapshot's own sanctioned clock read, which also anchors
 * every relative age in the static render). The history ledgers are embedded
 * at their existing trend-window caps. Pure: returns a new object; the input
 * snapshot is untouched (the live server must never see publish fields).
 */
export function withPublishMetadata(
  projectRoot: string,
  snapshot: DashboardSnapshot,
): PublishedSnapshot {
  const git = collectGitInfo(projectRoot);
  return {
    ...snapshot,
    publishedBy: {
      sha: git?.sha ?? '',
      ...(git?.branch ? { branch: git.branch } : {}),
      at: snapshot.generatedAt,
      origin: detectRunOrigin(),
    },
    embeddedHistory: buildEmbeddedHistory(
      projectRoot,
      snapshot.specs.map((s) => s.specId),
    ),
  };
}

/**
 * The local history ledgers, embedded verbatim at their existing trend-window
 * caps: score.jsonl 200 rows, signals.jsonl 500 rows, per-spec history 200
 * rows — exactly what `buildTrend` / `buildTrendsInput` read.
 */
export function buildEmbeddedHistory(projectRoot: string, specIds: string[]): EmbeddedHistory {
  const specs: Record<string, HistoryRunRow[]> = {};
  for (const id of specIds) specs[id] = readHistoryRows(projectRoot, id, 200);
  return {
    score: readScoreHistory(projectRoot, 200),
    signals: readSignalHistory(projectRoot, 500),
    specs,
  };
}

/**
 * How deep `--commit-ready` trims embedded history rows (days). The artifact
 * stays useful for a quarter of trends; git keeps everything older anyway via
 * previous commits when `historyCommitted` is on.
 */
const COMMIT_WINDOW_DAYS = 90;

/**
 * Drop `embeddedHistory` rows older than {@link COMMIT_WINDOW_DAYS} relative to
 * `publishedBy.at`. Pure: returns a new snapshot; the original is untouched.
 */
export function trimEmbeddedHistoryForCommit(snapshot: PublishedSnapshot): PublishedSnapshot {
  const eh = snapshot.embeddedHistory;
  if (!eh) return snapshot;
  const anchorMs = Date.parse(snapshot.publishedBy?.at ?? snapshot.generatedAt);
  if (Number.isNaN(anchorMs)) return snapshot;
  const cutoff = anchorMs - COMMIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const inWindow = (iso: string | undefined): boolean =>
    typeof iso === 'string' && !Number.isNaN(Date.parse(iso)) && Date.parse(iso) >= cutoff;
  const specs: Record<string, HistoryRunRow[]> = {};
  for (const [id, rows] of Object.entries(eh.specs)) {
    specs[id] = rows.filter((r) => inWindow(r.createdAt));
  }
  return {
    ...snapshot,
    embeddedHistory: {
      score: eh.score.filter((r) => inWindow(r.at)),
      signals: eh.signals.filter((r) => inWindow(r.at)),
      specs,
    },
  };
}

/**
 * Write `snapshot.json` into `dir` (default `.validity/dashboard/`),
 * deterministically: pretty-printed JSON + trailing newline, no clock, no
 * locale. Returns the path written. Creates `dir` when missing.
 */
export function writeDashboardSnapshot(
  projectRoot: string,
  snapshot: PublishedSnapshot,
  opts?: { dir?: string },
): string {
  const dir = opts?.dir ?? dashboardPublishDir(projectRoot);
  ensureDir(dir);
  const path = resolve(dir, 'snapshot.json');
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n');
  return path;
}

/**
 * Tolerant reader (dev B's clone). Returns the parsed snapshot, or `null` when
 * the file is missing / corrupt / a foreign version — never throws, matching
 * the module-wide tolerance posture. Only version 1 parses today; a future
 * version renders nothing rather than something wrong (never false green).
 */
export function readDashboardSnapshot(path: string): DashboardSnapshot | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (parsed?.version !== DASHBOARD_SNAPSHOT_VERSION) return null;
    return parsed as unknown as DashboardSnapshot;
  } catch {
    return null;
  }
}
