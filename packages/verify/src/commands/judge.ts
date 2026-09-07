/**
 * `validity judge` CLI wrapper — arg parsing, console output, and exit codes
 * over the core {@link runJudge} engine (`@validity.ai/verify-spec`).
 *
 * The scoring engine itself lives in core so `verify --all --judge` and the
 * continuous watch loop can call it too; this file only adds the interactive
 * shell: it loads config, prints a per-spec summary, and maps outcomes to an
 * exit code (an explicit single-target skip is a failure; `--all` is
 * best-effort).
 */
import { resolve } from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  JudgeError,
  readRunMeta,
  readSpec,
  resolveReportConfig,
  runJudge,
  type JudgeSpecOutcome,
  type RunJudgeResult,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import { writeRunReportHtml } from '../report-render.js';
import { recentRunIds } from './recent-runs.js';

export interface RunJudgeCliOptions {
  cwd?: string;
  spec?: string;
  all?: boolean;
}

export async function runJudgeCli(
  runIdInput: string | undefined,
  opts: RunJudgeCliOptions = {},
): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();

  const selectors = [Boolean(runIdInput), Boolean(opts.spec), Boolean(opts.all)].filter(
    Boolean,
  ).length;
  if (selectors === 0) {
    process.stderr.write(
      pc.red('error: pass a run id, `--spec <id>`, or `--all`.\n') +
        pc.dim(
          '  e.g. `validity judge run_abc123`, `validity judge --spec spec-7f3a`, `validity judge --all`\n',
        ),
    );
    process.exit(2);
    return;
  }
  if (selectors > 1) {
    process.stderr.write(pc.red('error: pass only ONE of a run id, --spec, or --all.\n'));
    process.exit(2);
    return;
  }

  let config: ValidityConfig;
  try {
    config = (await loadConfig(projectRoot)).config;
  } catch (err) {
    process.stderr.write(pc.red(`error: ${(err as Error).message}\n`));
    process.exit(1);
    return;
  }

  if (!config.scoring?.judgeModel) {
    process.stderr.write(
      pc.red('error: no scoring.judgeModel configured in .validity/config.ts.\n') +
        pc.dim(
          "  Add e.g. scoring: { judgeModel: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' } }\n" +
            '  The API key is read from the environment at call time (ANTHROPIC_API_KEY / OPENAI_API_KEY),\n' +
            '  never persisted, and sent only to your chosen provider.\n',
        ),
    );
    process.exit(2);
    return;
  }

  let result: RunJudgeResult;
  try {
    result = await runJudge({
      projectRoot,
      config,
      runId: runIdInput,
      specId: opts.spec,
      all: opts.all,
      // The CLI renders skip reasons itself, so it wants structured outcomes for
      // every selector — the single-target throw is for programmatic callers.
      onFailure: 'return',
    });
  } catch (err) {
    // A JudgeError still carries a structured outcome (defensive — with
    // onFailure:'return' the engine won't throw one, but stay robust).
    if (err instanceof JudgeError) {
      result = { outcomes: [err.outcome] };
    } else {
      process.stderr.write(pc.red(`error: ${(err as Error).message}\n`));
      if (runIdInput) {
        const recent = recentRunIds(projectRoot);
        if (recent.length > 0) {
          process.stderr.write('  Recent run ids:\n');
          for (const id of recent) process.stderr.write(`    ${id}\n`);
        }
      }
      process.exit(1);
      return;
    }
  }

  printOutcomes(result.outcomes);

  // Per-run report.html (issue #18): the judge just rewrote each judged run's
  // run-meta (scored soft verdicts + per-criterion reasoning) — bake the
  // report so the run is immediately openable on the dashboard with the
  // judge's reasoning, instead of the verdict text living only in the signal
  // queue. Best-effort: a bake failure never fails the judge.
  if (resolveReportConfig(config.report).enabled) {
    for (const o of result.outcomes) {
      if (o.status !== 'judged' || !o.runId) continue;
      try {
        const spec = readSpec(projectRoot, o.specId);
        const meta = readRunMeta(projectRoot, o.runId);
        if (!spec || !meta || meta.report?.enabled === false) continue;
        writeRunReportHtml({
          projectRoot,
          spec,
          meta,
          coverageFloorPercent: config.coverageFloorPercent,
        });
      } catch (err) {
        process.stderr.write(
          pc.yellow(
            `warning: could not render report.html for ${o.runId}: ${(err as Error).message}\n`,
          ),
        );
      }
    }
  }

  // Exit code: an EXPLICIT single target (run id / --spec) that got skipped is a
  // failure (the user asked to judge and nothing scored). --all is best-effort —
  // per-spec skips are informational, so it exits 0 as long as it ran.
  const explicit = Boolean(runIdInput) || Boolean(opts.spec);
  const judged = result.outcomes.filter((o) => o.status === 'judged');
  const nothing = result.outcomes.filter((o) => o.status === 'nothing-to-judge');
  if (explicit && judged.length === 0 && nothing.length === 0) {
    process.exitCode = 1;
  }
}

function printOutcomes(outcomes: JudgeSpecOutcome[]): void {
  const judged = outcomes.filter((o) => o.status === 'judged');
  const skipped = outcomes.filter((o) => o.status === 'skipped');
  const nothing = outcomes.filter((o) => o.status === 'nothing-to-judge');

  for (const o of judged) {
    const passN = o.scores?.filter((s) => s.status === 'pass').length ?? 0;
    const failN = o.scores?.filter((s) => s.status === 'fail').length ?? 0;
    const unvN = o.scores?.filter((s) => s.status === 'unverifiable').length ?? 0;
    process.stdout.write(
      pc.bold(`${o.specId}@v${o.specVersion ?? '?'} `) +
        pc.green('judged') +
        pc.dim(` by ${o.scoredBy} — `) +
        `${pc.green(`${passN} pass`)}, ${pc.red(`${failN} fail`)}, ${pc.yellow(`${unvN} unverifiable`)}` +
        pc.dim(
          ` · rollup ${o.verdict?.toUpperCase() ?? '—'}${o.signedOff ? ' · signed off' : ''}\n`,
        ),
    );
    for (const w of o.citationWarnings ?? []) process.stdout.write(pc.yellow(`  ⚠ ${w}\n`));
    for (const r of o.rejected ?? []) process.stdout.write(pc.dim(`  ✗ ${r.id}: ${r.reason}\n`));
  }
  for (const o of nothing) {
    process.stdout.write(pc.dim(`${o.specId}: nothing to judge (no soft criteria).\n`));
  }
  for (const o of skipped) {
    process.stdout.write(
      pc.yellow(`${o.specId}${o.runId ? ` (${o.runId})` : ''}: skipped — ${o.reason}\n`),
    );
  }

  if (judged.length > 0) {
    process.stdout.write(
      pc.dim(
        `\nScored by an independent model (judge: 'model'). The report + dashboard mark these ` +
          `soft passes as model-judged, distinct from self-attested.\n`,
      ),
    );
  }
}
