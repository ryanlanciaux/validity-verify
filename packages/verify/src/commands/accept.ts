/**
 * `validity accept <run-id>` — promote a specific run's screenshots to
 * baselines. Copies every PNG from `.validity/runs/<run-id>/screenshots/`
 * to `.validity/baselines/`, overwriting whatever was there.
 *
 * Filename contract: screenshot filenames inside a run dir are already
 * `<componentId>__<variantSlug>.png` (see render.ts), which is the exact
 * key the diff lookup uses. So the promotion is a flat copy — no slug
 * recomputation, no scenario merging.
 *
 * The render pipeline only establishes a baseline on the FIRST clean
 * (no-renderError) render of a variant (see baselines.ts →
 * `confirmBaseline()`, a write-if-missing gate); it never overwrites an
 * existing baseline. This command is the only path that RE-baselines an
 * existing variant — it unconditionally overwrites every baseline with the
 * run's screenshot (the same last-write-wins semantics as
 * `promoteBaseline()`). Use it to adopt an intended change as the new
 * baseline, revert to an older one, or force a snapshot in a verdict-driven
 * workflow.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';

export interface AcceptOptions {
  cwd?: string;
}

export async function runAccept(runId: string, opts: AcceptOptions = {}): Promise<void> {
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
  if (!runId) {
    process.stderr.write(
      pc.red('error: a runId is required (e.g. `validity accept run_abc123`).\n'),
    );
    process.exit(2);
  }

  const screenshotsDir = resolve(cwd, '.validity', 'runs', runId, 'screenshots');
  if (!existsSync(screenshotsDir)) {
    process.stderr.write(
      pc.red(`error: no screenshots dir found at ${screenshotsDir}.\n`) +
        "  Either the runId is wrong, or this project hasn't been verified yet.\n",
    );
    process.exit(1);
  }

  const baselinesDir = resolve(cwd, '.validity', 'baselines');
  if (!existsSync(baselinesDir)) mkdirSync(baselinesDir, { recursive: true });

  let promoted = 0;
  let skipped = 0;
  for (const name of readdirSync(screenshotsDir)) {
    // Skip the diff PNGs we wrote during the verify — they're not screenshots.
    if (name.endsWith('.diff.png')) {
      skipped++;
      continue;
    }
    if (!name.endsWith('.png')) continue;
    const src = resolve(screenshotsDir, name);
    if (!statSync(src).isFile()) continue;
    const dest = resolve(baselinesDir, name);
    copyFileSync(src, dest);
    promoted++;
  }

  if (promoted === 0) {
    process.stderr.write(pc.yellow(`warning: no screenshots promoted from ${screenshotsDir}.\n`));
    process.exit(1);
  }

  process.stdout.write(
    pc.green(
      `Promoted ${promoted} screenshot${promoted === 1 ? '' : 's'} from run ${runId} to .validity/baselines/.\n`,
    ),
  );
  if (skipped > 0) {
    process.stdout.write(pc.dim(`  (skipped ${skipped} diff PNGs)\n`));
  }
}
