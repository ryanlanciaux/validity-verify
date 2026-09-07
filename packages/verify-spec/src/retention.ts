/**
 * Per-spec run-ARTIFACT retention (issue #18 follow-up) — the automatic
 * companion to `validity clean`'s manual whole-directory pruning.
 *
 * With watch baking a report.html every tick, `.validity/runs/` grows by
 * megabytes per minute on a short interval. Retention bounds that per spec:
 * keep raw images for the newest `images` runs and baked reports for the
 * newest `reports` runs, delete the rest. What it NEVER touches:
 *
 *   - `run-meta.json` — the run's record (verdicts, judge reasoning, git,
 *     screenshot hashes). History and the dashboard's bake-on-demand view
 *     depend on it.
 *   - `runs.jsonl` timelines / scorecard — "when did this spec last run"
 *     stays answerable forever; pruning artifacts must never make a spec
 *     look never-run.
 *   - Runs OUTSIDE any spec timeline (in-flight renders have no timeline row
 *     until they complete; orphans are `validity clean`'s jurisdiction).
 *
 * The newest run per spec ALWAYS keeps everything (counts clamp to ≥1), so
 * "show me the last run" can never dangle.
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { readSpecRunHistory } from './run.js';
import { runDir } from './runs.js';
import { listSpecs } from './specs.js';
import type { RetentionConfig } from './types.js';

/** How many run rows to read per spec when planning (effectively "all"). */
const ALL_RUNS = 100_000;

/**
 * Per-spec run timelines OLDEST→NEWEST, de-duped — a runId appears twice in
 * runs.jsonl (verify + scored twin), and a duplicate must not consume a
 * retention slot. Shared by `validity clean` and the artifact retention pass;
 * `createdAt` rides along (last row wins) so clean's `--older-than` cutoff can
 * reuse the same read.
 */
export function readPerSpecRunTimelines(projectRoot: string): {
  perSpec: Record<string, string[]>;
  createdAt: Record<string, string | undefined>;
} {
  const perSpec: Record<string, string[]> = {};
  const createdAt: Record<string, string | undefined> = {};
  for (const spec of listSpecs(projectRoot)) {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const row of readSpecRunHistory(projectRoot, spec.id, ALL_RUNS)) {
      createdAt[row.runId] = row.createdAt;
      if (!seen.has(row.runId)) {
        seen.add(row.runId);
        ordered.push(row.runId);
      }
    }
    perSpec[spec.id] = ordered;
  }
  return { perSpec, createdAt };
}

export interface ArtifactPrunePlan {
  /** Runs losing screenshots/ + judge-pack/ + videos/. */
  pruneImages: string[];
  /** Runs losing report.html (+ report.md). */
  pruneReports: string[];
}

/**
 * PURE planner. A run referenced by MORE than one spec timeline is kept if ANY
 * window keeps it (union-keep — never prune what one spec still shows). Runs
 * absent from every timeline are untouched.
 */
export function selectArtifactsToPrune(args: {
  /** spec id → run ids OLDEST→NEWEST (see readPerSpecRunTimelines). */
  perSpecRunIds: Record<string, string[]>;
  retention: RetentionConfig;
}): ArtifactPrunePlan {
  const plan = (window: number | undefined): string[] => {
    if (window == null) return [];
    const keepN = Math.max(1, window);
    const keep = new Set<string>();
    const seen = new Set<string>();
    for (const runIds of Object.values(args.perSpecRunIds)) {
      for (const id of runIds) seen.add(id);
      for (const id of runIds.slice(-keepN)) keep.add(id);
    }
    return [...seen].filter((id) => !keep.has(id));
  };
  return {
    pruneImages: plan(args.retention.images),
    pruneReports: plan(args.retention.reports),
  };
}

/** Artifact names pruned by each window. Directories and files both rm -rf'd. */
const IMAGE_ARTIFACTS = ['screenshots', 'judge-pack', 'videos'] as const;
const REPORT_ARTIFACTS = ['report.html', 'report.md'] as const;

/**
 * Apply the plan on disk. Best-effort per artifact (a locked file skips, the
 * next pass retries); returns counts of RUNS that actually lost something so
 * the watch tick can log one honest line.
 */
export function applyArtifactRetention(
  projectRoot: string,
  retention: RetentionConfig,
): { imagesPruned: number; reportsPruned: number } {
  const plan = selectArtifactsToPrune({
    perSpecRunIds: readPerSpecRunTimelines(projectRoot).perSpec,
    retention,
  });
  const rmAll = (runId: string, names: readonly string[]): boolean => {
    let removed = false;
    for (const name of names) {
      const p = resolve(runDir(projectRoot, runId), name);
      if (!existsSync(p)) continue;
      try {
        rmSync(p, { recursive: true, force: true });
        removed = true;
      } catch {
        // Non-fatal — retention is idempotent; the next pass retries.
      }
    }
    return removed;
  };
  let imagesPruned = 0;
  let reportsPruned = 0;
  for (const id of plan.pruneImages) if (rmAll(id, IMAGE_ARTIFACTS)) imagesPruned += 1;
  for (const id of plan.pruneReports) if (rmAll(id, REPORT_ARTIFACTS)) reportsPruned += 1;
  return { imagesPruned, reportsPruned };
}

/**
 * Is `runId` inside the spec's `reports` retention window? Decides whether the
 * dashboard's bake-on-demand PERSISTS its result: inside the window (or no
 * retention configured) a baked report may stay; outside it, persisting would
 * just be re-pruned next tick — serve transiently instead.
 */
export function withinReportRetention(
  projectRoot: string,
  runId: string,
  retention: RetentionConfig | undefined,
): boolean {
  const window = retention?.reports;
  if (window == null) return true;
  const keepN = Math.max(1, window);
  for (const runIds of Object.values(readPerSpecRunTimelines(projectRoot).perSpec)) {
    if (runIds.slice(-keepN).includes(runId)) return true;
  }
  // Not in any keep window — including runs on no timeline yet (in-flight):
  // those have no report to persist either, so transient is correct there too.
  return false;
}
