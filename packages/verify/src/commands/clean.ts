/**
 * `validity clean` (W5 #16) — prune the ever-growing `.validity/runs/` tree.
 *
 * Each run stores its screenshots roughly three times (the PNG files plus base64
 * copies inlined into report.html and report.md), so a long-running loop's runs/
 * balloons (the fixture hit ~40MB in two weeks). This command keeps, per spec,
 * the most-recent N runs (or everything newer than a cutoff) and deletes the
 * rest. The durable viewer outputs (trends.html, compare-*.html) live in a
 * SIBLING `.validity/reports/` tree (W5 #19), so run cleanup can't sweep them;
 * baselines live in a separate `.validity/baselines/` tree and likewise can't
 * be orphaned by run cleanup.
 */
import { resolve } from 'node:path';
import pc from 'picocolors';
import {
  deleteRun,
  listRunIds,
  readPerSpecRunTimelines,
  readRunMeta,
  selectRunsToPrune,
} from '@validity.ai/verify-spec';

export async function runClean(opts: {
  cwd: string;
  keep?: number;
  olderThanDays?: number;
  dryRun?: boolean;
}): Promise<void> {
  const projectRoot = resolve(opts.cwd);
  const allRunIds = listRunIds(projectRoot);
  if (allRunIds.length === 0) {
    process.stdout.write('No runs to clean.\n');
    return;
  }

  // Per-spec run timelines (oldest→newest), de-duped — shared with the
  // automatic artifact-retention pass so the two can never disagree on what
  // counts as a retention slot.
  const { perSpec: perSpecRunIds, createdAt } = readPerSpecRunTimelines(projectRoot);
  // Fill createdAt for orphan runs (no spec timeline row) from their run-meta so
  // an `--older-than` cutoff can still judge them by real age.
  for (const id of allRunIds) {
    if (createdAt[id] == null) createdAt[id] = readRunMeta(projectRoot, id)?.createdAt;
  }

  const olderThanMs =
    opts.olderThanDays != null ? opts.olderThanDays * 24 * 60 * 60 * 1000 : undefined;
  const { keep, remove } = selectRunsToPrune({
    allRunIds,
    perSpecRunIds,
    createdAt,
    keep: opts.keep,
    olderThanMs,
    now: new Date().toISOString(),
  });

  if (remove.length === 0) {
    process.stdout.write(
      pc.green(`Nothing to prune — all ${keep.length} run(s) are within retention.\n`),
    );
    return;
  }

  const verb = opts.dryRun ? 'Would remove' : 'Removing';
  process.stdout.write(
    `${verb} ${remove.length} run${remove.length === 1 ? '' : 's'} (keeping ${keep.length}):\n`,
  );
  for (const id of remove) {
    const at = createdAt[id];
    process.stdout.write(pc.dim(`  - ${id}${at ? ` (${at})` : ''}\n`));
    if (!opts.dryRun) deleteRun(projectRoot, id);
  }
  if (opts.dryRun) {
    process.stdout.write(
      pc.dim('\nDry run — nothing deleted. Re-run without --dry-run to apply.\n'),
    );
  } else {
    process.stdout.write(pc.green(`\nDone. Pruned ${remove.length} run(s).\n`));
  }
}
