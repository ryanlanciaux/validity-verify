/**
 * `validity compare <runA> <runB>` — resolve two verify runs and render one
 * self-contained side-by-side HTML via the pure `renderCompareHtml`.
 *
 * Resolution ladder per run id (the runs/ dir is gitignored, so artifacts may
 * be gone):
 *   1. `run-meta.json` on disk → full side (screenshots + criteria + perf);
 *   2. else the run's indexed timeline row (local runs.jsonl or committed
 *      history) → metadata-only side, badged "indexed summary";
 *   3. else exit 1 with recent run-id suggestions.
 *
 * VIEWER, NEVER A GATE: exits 0 whenever the HTML was written, regardless of
 * verdict content; exit 1 only on lookup/IO failure.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import pc from 'picocolors';
import {
  ensureDir,
  readHistoryRows,
  readRunMeta,
  readSpecRunHistory,
  reportsDir,
  type ComponentRender,
  type RunMeta,
} from '@validity.ai/verify-spec';
import {
  renderCompareHtml,
  type CompareInput,
  type CompareRenderCell,
  type CompareRun,
} from '../compare-render.js';
import { recentRunIds } from './recent-runs.js';
import { timelineSpecIds } from './timeline-spec-ids.js';

export interface CompareOptions {
  cwd?: string;
  out?: string;
}

/** How many timeline rows per spec the summary-resolution scan reads. */
const SCAN_LIMIT = 200;

export async function runCompare(
  runA: string,
  runB: string,
  opts: CompareOptions = {},
): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();

  if (!runA || !runB) {
    process.stderr.write(
      pc.red('error: two runIds are required (e.g. `validity compare run_a run_b`).\n'),
    );
    process.exit(2);
  }
  if (runA === runB) {
    process.stderr.write(pc.red('error: the two runIds are identical — nothing to compare.\n'));
    process.exit(1);
  }

  const a = resolveCompareRun(projectRoot, runA);
  const b = resolveCompareRun(projectRoot, runB);
  const missing = [...(a ? [] : [runA]), ...(b ? [] : [runB])];
  if (!a || !b) {
    process.stderr.write(
      pc.red(`error: no run-meta or timeline row found for ${missing.join(', ')}.\n`),
    );
    const known = knownRunIds(projectRoot);
    if (known.length > 0) {
      process.stderr.write('  Known run ids (newest first):\n');
      for (const id of known) process.stderr.write(`    ${id}\n`);
    } else {
      process.stderr.write(
        '  No runs found under .validity/. Has `validity__verify` been called yet?\n',
      );
    }
    process.exit(1);
    return;
  }

  const sameSpec = Boolean(a.specId && b.specId && a.specId === b.specId);
  const input: CompareInput = {
    generatedAt: new Date().toISOString(),
    a,
    b,
    sameSpec,
    specHashChanged: sameSpec && (a.specHash !== b.specHash || a.specVersion !== b.specVersion),
  };
  if (!sameSpec) {
    process.stdout.write(
      pc.yellow(
        'warning: these runs verified different specs — criteria are not comparable; screenshots are paired by slug only.\n',
      ),
    );
  }

  const outPath = opts.out
    ? resolve(opts.out)
    : resolve(
        reportsDir(projectRoot),
        `compare-${safeFileToken(runA)}--${safeFileToken(runB)}.html`,
      );
  ensureDir(dirname(outPath));
  writeFileSync(outPath, renderCompareHtml(input));
  process.stdout.write(pc.bold(`Compare written: ${outPath}\n`));
  process.stdout.write(pc.dim(`  file://${outPath}\n`));
}

/** runIds are `run_<ts>_<hex>` but come from argv — keep the filename path-safe. */
function safeFileToken(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 64) || 'run';
}

// ---------------------------------------------------------------------------
// Resolution ladder
// ---------------------------------------------------------------------------

function resolveCompareRun(projectRoot: string, runId: string): CompareRun | undefined {
  const meta = readRunMeta(projectRoot, runId);
  if (meta && meta.runId === runId) return fullRunOf(meta);
  return summaryRunOf(projectRoot, runId);
}

/**
 * Metadata-only degrade: find the run's LAST indexed row (local runs.jsonl
 * wins over the committed twin — machine of record) across every spec.
 */
function summaryRunOf(projectRoot: string, runId: string): CompareRun | undefined {
  for (const specId of timelineSpecIds(projectRoot)) {
    const local = readSpecRunHistory(projectRoot, specId, SCAN_LIMIT)
      .filter((r) => r.runId === runId)
      .at(-1);
    const committed = readHistoryRows(projectRoot, specId, SCAN_LIMIT)
      .filter((r) => r.runId === runId)
      .at(-1);
    const row = local ?? committed;
    if (!row) continue;
    return {
      runId,
      createdAt: row.createdAt,
      specId,
      specVersion: row.specVersion,
      specHash: row.specHash,
      verdict: row.verdict,
      signedOff: row.signedOff,
      detail: 'summary',
      renders: [],
      criteria: (row.criteria ?? []).map((c) => ({ id: c.id, tier: c.tier, status: c.status })),
    };
  }
  return undefined;
}

/** "Did you mean" pool: run dirs on disk + the newest timeline rows per spec. */
function knownRunIds(projectRoot: string): string[] {
  const ids: string[] = [...recentRunIds(projectRoot)];
  for (const specId of timelineSpecIds(projectRoot)) {
    for (const row of readSpecRunHistory(projectRoot, specId, 20)) ids.push(row.runId);
    for (const row of readHistoryRows(projectRoot, specId, 20)) ids.push(row.runId);
  }
  return [...new Set(ids)].slice(0, 20);
}

// ---------------------------------------------------------------------------
// Full run mapping (run-meta on disk)
// ---------------------------------------------------------------------------

function fullRunOf(meta: RunMeta): CompareRun {
  const mode = meta.mode ?? 'isolation';
  return {
    runId: meta.runId,
    createdAt: meta.createdAt,
    specId: meta.specId,
    specVersion: meta.specVersion,
    specHash: meta.specHash,
    mode,
    verdict: meta.verdict,
    signedOff: meta.signedOff,
    detail: 'full',
    renders: mode === 'url' ? pageCells(meta) : componentCells(meta),
    criteria: (meta.criterionVerdicts ?? []).map((v) => ({
      id: v.id,
      tier: v.tier,
      status: v.status,
      detail: v.detail,
    })),
  };
}

function pageCells(meta: RunMeta): CompareRenderCell[] {
  return (meta.pages ?? []).map((p) => ({
    // URL runs pair by the page slug (already `pathId[__scenario]`).
    key: p.id,
    label: [p.url, p.scenarioId].filter(Boolean).join(' · '),
    ...(p.errorMessage
      ? { renderError: p.errorMessage }
      : shotOf(p.screenshotPath, /* skipped */ false)),
  }));
}

function componentCells(meta: RunMeta): CompareRenderCell[] {
  return (meta.components ?? []).map((c) => ({
    key: componentKeyOf(c),
    label: [c.id, c.scenarioId, c.fixtureId, c.viewport?.name, c.dataState]
      .filter(Boolean)
      .join(' · '),
    performance: c.performance,
    ...(c.renderError
      ? { renderError: c.renderError }
      : shotOf(c.screenshotPath, c.screenshotSkipped === true)),
  }));
}

/**
 * Pairing key for isolation/native renders: the screenshot basename minus
 * `.png` IS `componentId__variantSlug` by construction (both the web capture
 * and the native writer mint it), so it matches the same render slot across
 * runs. Defensive fallback when the path is empty.
 */
function componentKeyOf(c: ComponentRender): string {
  const base = c.screenshotPath ? basename(c.screenshotPath) : '';
  if (base.endsWith('.png') && base.length > 4) return base.slice(0, -4);
  return `${c.id}__${c.scenarioId ?? 'base'}__${c.fixtureId ?? 'base'}`;
}

function shotOf(
  screenshotPath: string,
  skipped: boolean,
): Pick<CompareRenderCell, 'screenshotDataUrl' | 'missingReason'> {
  if (skipped) {
    // Intentionally-unwritten screenshot (definitively-red render) — never
    // treat as evidence, never fall through to a stale file on disk.
    return { missingReason: 'screenshot skipped (definitively-red render)' };
  }
  try {
    return {
      screenshotDataUrl: `data:image/png;base64,${readFileSync(screenshotPath).toString('base64')}`,
    };
  } catch {
    return { missingReason: 'screenshot file no longer on disk' };
  }
}
