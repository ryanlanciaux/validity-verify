/**
 * `validity judge-pack <run-id>` — emit a self-contained blind-judging bundle
 * for a verify run: screenshots + the frozen rubric + SCORING.md, and nothing
 * else. NO component source, NO diff, NO prompt history — the whole point is
 * that a fresh-context judge (a clean subagent or a human) scores blind.
 *
 * The pack writes no verdicts; scores come back through
 * `validity__record_soft_scores`, where the soft-only / reasoning gates apply.
 */
import { resolve } from 'node:path';
import pc from 'picocolors';
import { emitJudgePack, JudgePackError } from '@validity.ai/verify-spec';
import { recentRunIds } from './recent-runs.js';

export interface JudgePackOptions {
  cwd?: string;
  out?: string;
}

export async function runJudgePack(runIdInput: string, opts: JudgePackOptions = {}): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();

  if (!runIdInput) {
    process.stderr.write(
      pc.red('error: a runId is required (e.g. `validity judge-pack run_abc123`).\n'),
    );
    process.exit(2);
  }

  let result;
  try {
    result = emitJudgePack({
      projectRoot,
      runId: runIdInput,
      // --out is an export-for-hand-off: resolved against the caller's cwd,
      // deliberately allowed outside the project.
      outDir: opts.out ? resolve(opts.out) : undefined,
    });
  } catch (err) {
    if (!(err instanceof JudgePackError)) throw err;
    process.stderr.write(pc.red(`error: ${err.message}\n`));
    if (err.code === 'unknown-run') {
      const recent = recentRunIds(projectRoot);
      if (recent.length > 0) {
        process.stderr.write(`  Recent run ids:\n`);
        for (const id of recent) process.stderr.write(`    ${id}\n`);
      } else {
        process.stderr.write(
          `  No runs found under .validity/runs/. Has \`validity__verify\` been called yet?\n`,
        );
      }
    }
    process.exit(1);
    return;
  }

  if (!result) {
    process.stdout.write(
      'nothing to judge — all criteria are hard/property and were decided mechanically.\n',
    );
    return;
  }

  const dir = relativeTo(projectRoot, result.dir);
  process.stdout.write(pc.bold(`Judge pack written: ${dir}/\n`));
  process.stdout.write(
    `  rubric.json          — ${result.softCriteria} soft criteri${result.softCriteria === 1 ? 'on' : 'a'} (frozen spec ${result.specId} v${result.specVersion})\n`,
  );
  process.stdout.write(
    `  screenshots/         — ${result.screenshots} image${result.screenshots === 1 ? '' : 's'}\n`,
  );
  process.stdout.write(`  SCORING.md           — instructions for the judge\n`);
  for (const warning of result.warnings) {
    process.stdout.write(pc.yellow(`  ! ${warning}\n`));
  }
  process.stdout.write('\n');
  process.stdout.write(
    pc.dim(
      'Hand the DIRECTORY to a fresh-context agent or a human. It contains no source,\n' +
        'no diff, and no prompt history — the judge scores blind from the screenshots.\n' +
        `Scores come back via validity__record_soft_scores (specId ${result.specId}) with a\n` +
        'distinct `scoredBy`.\n',
    ),
  );
}

function relativeTo(root: string, abs: string): string {
  if (abs.startsWith(root + '/')) return abs.slice(root.length + 1);
  return abs;
}
