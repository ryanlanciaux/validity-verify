/**
 * `validity export <run-id> --target=playwright` — turn a finished
 * verify run into Playwright `.spec.ts` scaffolds.
 *
 * **This is NOT test generation.** It's boilerplate elimination: the
 * scaffold's `mockNetwork → page.route()`, `cookies → addCookies()`,
 * `play → inlined body`, and `criteria → test.step('TODO assertion: …')`
 * all need a human's "replace TODO with the real expect()" pass before
 * the spec is a real test. The framing in the user-facing output keeps
 * that distinction honest.
 *
 * Cypress / Maestro targets are NOT supported. We refuse them with a
 * clear error rather than silently fall back. They're on the roadmap only
 * when a user actually asks.
 */
import { resolve } from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '@validity.ai/verify-spec';
import { readRunMeta, runDir } from '@validity.ai/verify-spec';
import { exportPlaywright, loadReportCriteria } from '@validity.ai/verify-web';
import { recentRunIds } from './recent-runs.js';

export interface ExportOptions {
  cwd?: string;
  target?: string;
  out?: string;
  baseUrl?: string;
  includeVisual?: boolean;
  force?: boolean;
}

export async function runExport(runIdInput: string, opts: ExportOptions = {}): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();
  const target = opts.target ?? 'playwright';

  // DEPRECATED (2026-07): the run-based scaffolder predates the spec compiler
  // and its TODO-placeholder output is easily mistaken for `spec export`'s
  // real assertions. Kept working for compat; steer everyone to the compiler.
  process.stderr.write(
    pc.yellow(
      'deprecated: `validity export <run-id>` emits TODO scaffolds, not tests. ' +
        'Use `validity spec export <spec-id>` — it compiles a frozen spec into real, ' +
        'drift-checked assertions under .validity/exports/.\n',
    ),
  );

  if (!runIdInput) {
    process.stderr.write(
      pc.red(
        'error: a runId is required (e.g. `validity export run_abc123 --target=playwright`).\n',
      ),
    );
    process.exit(2);
  }

  if (target !== 'playwright') {
    process.stderr.write(
      pc.red(
        `error: only --target=playwright is supported in this version. ` +
          `Cypress / Maestro export is on the roadmap; ask in an issue if you need them.\n`,
      ),
    );
    process.exit(2);
  }

  const meta = readRunMeta(projectRoot, runIdInput);
  if (!meta) {
    process.stderr.write(pc.red(`error: no run-meta found for "${runIdInput}".\n`));
    const recent = recentRunIds(projectRoot);
    if (recent.length > 0) {
      process.stderr.write(`  Recent run ids:\n`);
      for (const id of recent) process.stderr.write(`    ${id}\n`);
    } else {
      process.stderr.write(
        `  No runs found under .validity/runs/. Has \`validity__verify\` been called yet?\n`,
      );
    }
    process.exit(1);
  }

  let config;
  try {
    config = (await loadConfig(projectRoot)).config;
  } catch (err) {
    process.stderr.write(pc.red(`error: ${(err as Error).message}\n`));
    process.exit(1);
    return;
  }

  const outDir = resolve(projectRoot, opts.out ?? 'tests/e2e');
  const criteria = loadReportCriteria(runDir(projectRoot, runIdInput)) ?? undefined;

  const result = exportPlaywright({
    runMeta: meta,
    config,
    outDir,
    baseUrl: opts.baseUrl,
    includeVisualAssertions: opts.includeVisual === true,
    force: opts.force === true,
    criteria,
  });

  // Framing belt: remind the user this is a scaffold every time we
  // print "wrote N files." Skipping this line was tempting (fewer
  // lines of output is friendlier) but the wrong incentive — the
  // exporter exists to save 15 minutes of boilerplate, not to claim
  // we wrote your tests.
  process.stdout.write(
    pc.bold(
      `Wrote ${result.written.length} Playwright scaffold${result.written.length === 1 ? '' : 's'}.\n`,
    ),
  );
  for (const path of result.written) {
    process.stdout.write(`  ${pc.green('+')} ${relativeTo(projectRoot, path)}\n`);
  }
  if (result.skipped.length > 0) {
    process.stdout.write(pc.yellow(`Skipped ${result.skipped.length}:\n`));
    for (const reason of result.skipped) {
      process.stdout.write(`  ${pc.dim('-')} ${reason}\n`);
    }
  }
  process.stdout.write('\n');
  process.stdout.write(
    pc.dim(
      "These are SCAFFOLDS, not tests. Each `test.step('TODO assertion: …')` " +
        'needs a real `expect(...)` before the spec is worth running. ' +
        'Harden selectors and review the inlined play body before committing.\n',
    ),
  );

  if (result.written.length === 0 && result.skipped.length > 0) {
    process.exit(1);
  }
}

function relativeTo(root: string, abs: string): string {
  if (abs.startsWith(root + '/')) return abs.slice(root.length + 1);
  return abs;
}
