/**
 * `validity trends` — read every spec's run timeline (local
 * `specs/<id>/runs.jsonl` + opt-in committed `.validity/history/<id>.jsonl`),
 * the scorecard, and the signal queue, and render one self-contained
 * `trends.html` via the pure `renderTrendsHtml`.
 *
 * VIEWER, NEVER A GATE: exits 0 whenever the HTML was written — an all-fail
 * timeline still exits 0, so this command can't be wired into CI as a
 * bypassable gate. It writes nothing except the HTML file (no scorecard, no
 * signals, no history rows).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import pc from 'picocolors';
import {
  computeHardPropertyCoverage,
  ensureDir,
  loadScorecard,
  loadSignals,
  readHistoryRows,
  readSpecOrNull,
  readSpecRunHistory,
  reportsDir,
  scoreHistoryPath,
  type HistoryRunRow,
  type Scorecard,
  type Signal,
  type SpecRunSummary,
} from '@validity.ai/verify-spec';
import { currentValidityScore, runScoreOf } from '../score-adapter.js';
import {
  renderTrendsHtml,
  type TrendsInput,
  type TrendsSpec,
  type TrendsTimelineEntry,
} from '../trends-render.js';
import { timelineSpecIds } from './timeline-spec-ids.js';

export interface TrendsOptions {
  cwd?: string;
  out?: string;
  /** Spec ids to include (default: all with any history). */
  specs?: string[];
  /** Max timeline rows per spec (default 200). */
  limit?: number;
}

const DEFAULT_LIMIT = 200;

function normalizeLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : DEFAULT_LIMIT;
}

/**
 * Assemble the pure {@link TrendsInput} from a project's on-disk history — the
 * union of local `runs.jsonl` timelines and committed `history/` rows, the
 * scorecard, and the signal queue. Shared by the `validity trends` file
 * command AND the dashboard's served `/trends` route so both render identical
 * content from the same source.
 *
 * The caller owns the clock: `generatedAt` is passed in (the file command uses
 * `new Date()`; the served route uses the dashboard snapshot's one sanctioned
 * wall-clock read) so this builder itself stays free of `Date.now()`.
 */
export function buildTrendsInput(
  projectRoot: string,
  opts: { specs?: string[]; limit?: number; generatedAt: string },
): TrendsInput {
  const limit = normalizeLimit(opts.limit);

  // Union of local timelines and committed history files — a spec pruned on
  // this machine still charts from its committed rows.
  let specIds = timelineSpecIds(projectRoot);
  if (opts.specs && opts.specs.length > 0) {
    const requested = new Set(opts.specs);
    specIds = specIds.filter((id) => requested.has(id));
  }

  const scorecard = loadScorecard(projectRoot);
  const signals = loadSignals(projectRoot);
  const specs = specIds
    .map((id) => buildTrendsSpec(projectRoot, id, scorecard, signals, limit))
    .filter((s) => s.timeline.length > 0 || s.current || s.signals.length > 0);

  return {
    projectName: basename(projectRoot),
    generatedAt: opts.generatedAt,
    currentScore: currentValidityScore(scorecard),
    specs,
  };
}

export async function runTrends(opts: TrendsOptions = {}): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();

  const input = buildTrendsInput(projectRoot, {
    specs: opts.specs,
    limit: opts.limit,
    generatedAt: new Date().toISOString(),
  });

  const outPath = opts.out ? resolve(opts.out) : resolve(reportsDir(projectRoot), 'trends.html');
  ensureDir(dirname(outPath));
  writeFileSync(outPath, renderTrendsHtml(input));

  if (input.specs.length === 0) {
    process.stdout.write(
      'no spec history yet — run validity__verify against a frozen spec, then re-run `validity trends`.\n',
    );
  }
  process.stdout.write(pc.bold(`Trends written: ${outPath}\n`));
  process.stdout.write(pc.dim(`  file://${outPath}\n`));
  process.stdout.write(
    pc.dim('  open the file above in a browser\n'),
  );

  // History-posture nudge (W5 #17): the timeline charted above is machine-local
  // when `history/` isn't committed — a re-clone or CI checkout loses it. Only
  // surface when there's actually something to preserve (local rows exist).
  const hasLocalRows = input.specs.some((s) => s.timeline.some((e) => e.source === 'local'));
  if (hasLocalRows && !existsSync(dirname(scoreHistoryPath(projectRoot)))) {
    process.stdout.write(
      pc.yellow(
        '  note: this timeline is machine-local — set `historyCommitted: true` in ' +
          '.validity/config.ts to keep trends across clones and CI.\n',
      ),
    );
  }
}

/**
 * Merge a spec's local timeline with its committed rows. The LOCAL row wins
 * wholesale (machine of record); committed-only rows are included with
 * `source: 'committed'`; a local row missing `score`/`perf`/`sha` is filled
 * from its committed twin. Local rows are themselves deduped by runId
 * last-wins (verify + submit_report both append).
 */
function buildTrendsSpec(
  projectRoot: string,
  specId: string,
  scorecard: Scorecard | null,
  signals: Signal[],
  limit: number,
): TrendsSpec {
  const localByRunId = new Map<string, SpecRunSummary>();
  // Read 2× the window before deduping (W5 #20): a runId appears twice in the
  // append-only timeline (verify + submit_report scored twin), so slicing only
  // `limit` raw rows and then deduping here would silently HALVE the effective
  // window. `readSpecRunHistory` stays append-faithful; the compensation lives
  // at this deduping consumer, mirroring `readHistoryRows`' own `-limit*2`.
  for (const row of readSpecRunHistory(projectRoot, specId, limit * 2)) {
    if (typeof row?.runId !== 'string' || row.runId.length === 0) continue;
    localByRunId.set(row.runId, row);
  }
  const committedByRunId = new Map<string, HistoryRunRow>();
  for (const row of readHistoryRows(projectRoot, specId, limit)) {
    committedByRunId.set(row.runId, row);
  }

  const entries: TrendsTimelineEntry[] = [];
  for (const [runId, local] of localByRunId) {
    entries.push(entryOf(local, committedByRunId.get(runId), 'local'));
  }
  for (const [runId, committed] of committedByRunId) {
    if (!localByRunId.has(runId)) entries.push(entryOf(committed, committed, 'committed'));
  }
  entries.sort(
    (a, b) =>
      (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.runId.localeCompare(b.runId),
  );
  const timeline = entries.slice(-limit);

  const standing = scorecard?.specs[specId];
  const spec = readSpecOrNull(projectRoot, specId);
  return {
    specId,
    title: spec ? titleOf(spec.source.prompt) : undefined,
    current: standing
      ? {
          verdict: standing.verdict,
          signedOff: standing.signedOff,
          coveragePercent: standing.coveragePercent,
        }
      : undefined,
    timeline,
    signals: signals
      .filter((s) => s.specId === specId)
      .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.id.localeCompare(b.id)),
  };
}

function entryOf(
  row: SpecRunSummary | HistoryRunRow,
  committedTwin: HistoryRunRow | undefined,
  source: 'local' | 'committed',
): TrendsTimelineEntry {
  return {
    runId: row.runId,
    createdAt: row.createdAt,
    specVersion: row.specVersion,
    // A hand-edited verdict outside the known union renders as the neutral
    // glyph (verdictClassOf maps only exact matches) — pass it through.
    verdict: row.verdict,
    signedOff: row.signedOff,
    coverageRatio: row.counts ? computeHardPropertyCoverage(row.counts) : null,
    criteria: row.criteria,
    // "Score at run time" (freshness not applied): a committed row may carry
    // one; otherwise recompute from the criteria snapshot via the F1 adapter.
    score: committedTwin?.score ?? runScoreOf(row.criteria),
    perf: row.perf ?? committedTwin?.perf,
    source,
  };
}

/** First line of the spec's prompt, truncated — the closest thing to a title. */
function titleOf(prompt: string): string | undefined {
  const firstLine = prompt.split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return undefined;
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}
