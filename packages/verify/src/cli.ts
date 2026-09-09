#!/usr/bin/env node
import { cac } from 'cac';
import pc from 'picocolors';
import {
  closeEstablishedNativeSessions,
  installNativeSessionShutdownHandlers,
} from '@validity.ai/verify-native';
import { runAccept } from './commands/accept.js';
import { runAttestVerify } from './commands/attest.js';
import { runReplay } from './commands/replay.js';
import { runBrowse } from './commands/browse.js';
import { runClean } from './commands/clean.js';
import { runCompare } from './commands/compare.js';
import { runExport } from './commands/export.js';
import { runInit } from './commands/init.js';
import { runInstallBrowser } from './commands/install-browser.js';
import { runJudgePack } from './commands/judge-pack.js';
import { runJudgeCli } from './commands/judge.js';
import { runInstallWizard } from './commands/install-wizard.js';
import { runSpec } from './commands/spec.js';
import { runStart } from './commands/start.js';
import { runTrends } from './commands/trends.js';
import { runOnboard } from './commands/onboard.js';
import { runVerifyAll } from './commands/verify-all.js';
import { runDoctor } from './commands/doctor.js';
import { runSignals } from './commands/signals.js';
import { runHelp } from './commands/help.js';
import { cliVersionString } from './version.js';

const cli = cac('validity');

cli
  .command('install-browser', 'Install Chromium matching this Validity installation')
  .option('--with-deps', 'Also install system browser dependencies (Linux CI)')
  .action((opts: { withDeps?: boolean }) => runInstallBrowser(opts));

cli
  .command(
    'init',
    'Auto-configure .validity/ — clones providers from your entry, seeds config + scenarios',
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--force', 'Force a fresh regen even when nothing has drifted')
  .option('--no-agent-stanza', 'Skip writing the CLAUDE.md/AGENTS.md agent-stanza block')
  .option(
    '--plugins [target]',
    'Scope plugin wiring (web: @validity.ai/verify-plugin-vite or @validity.ai/verify-plugin-next depending on the app, native: @validity.ai/verify-plugin-expo): web | native | all. Default: auto-detect and wire — pass --no-plugins to skip.',
  )
  .option(
    '--no-plugins',
    'Explicitly skip plugin wiring (same as omitting --plugins; also silences the hint)',
  )
  .action(
    async (opts: {
      cwd: string;
      force?: boolean;
      agentStanza: boolean;
      plugins?: string | boolean;
    }) => {
      await runInit({
        cwd: opts.cwd,
        force: opts.force,
        agentStanza: opts.agentStanza,
        plugins: opts.plugins,
      });
    },
  );

cli
  .command('start', 'Get set up — shows the one next step, with the command to run')
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option(
    '--prompt',
    'Print a single copy-pasteable prompt covering every remaining setup step plus a smoke test, for handing to your coding agent',
  )
  .action(async (opts: { cwd: string; prompt?: boolean }) => {
    await runStart({ cwd: opts.cwd, prompt: opts.prompt });
  });

cli
  .command('doctor', 'Diagnose your local Validity setup')
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option(
    '--rebuild-signals',
    'Replay .validity/history/signals.jsonl into a fresh signals.json and print a diff',
  )
  .action(async (opts: { cwd: string; rebuildSignals?: boolean }) => {
    await runDoctor({ cwd: opts.cwd, rebuildSignals: opts.rebuildSignals });
  });

cli
  .command(
    'install-wizard',
    'Re-run the post-install setup: pick MCP hosts, install skills, resolve PATH conflicts',
  )
  .option('--non-interactive', 'Skip prompts (for CI / unattended installs)')
  .option(
    '--skip-banner',
    'Skip the intro banner (used when a parent installer already printed it)',
  )
  .action(async (opts: { nonInteractive?: boolean; skipBanner?: boolean }) => {
    await runInstallWizard({
      nonInteractive: opts.nonInteractive,
      skipBanner: opts.skipBanner,
    });
  });

cli
  .command('help', 'Print a curated, skill-sized reference (used by the Validity skill)')
  .action(() => {
    runHelp();
  });

cli
  .command('accept <run-id>', "Promote a run's screenshots to baselines for future diffs")
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .action(async (runId: string, opts: { cwd: string }) => {
    await runAccept(runId, { cwd: opts.cwd });
  });

cli
  .command(
    'export <run-id>',
    'Generate Playwright .spec.ts scaffolds from a verify run. SCAFFOLDS, not tests — each test.step is a TODO assertion you replace.',
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--target <name>', 'Export target. Only `playwright` is supported.', {
    default: 'playwright',
  })
  .option('--out <dir>', 'Output directory (project-relative)', { default: 'tests/e2e' })
  .option('--base-url <url>', 'Base URL hint for the generated specs')
  .option('--include-visual', 'Emit `await expect(page).toHaveScreenshot()` per test')
  .option('--force', 'Overwrite existing .spec.ts files')
  .action(
    async (
      runId: string,
      opts: {
        cwd: string;
        target?: string;
        out?: string;
        baseUrl?: string;
        includeVisual?: boolean;
        force?: boolean;
      },
    ) => {
      await runExport(runId, {
        cwd: opts.cwd,
        target: opts.target,
        out: opts.out,
        baseUrl: opts.baseUrl,
        includeVisual: opts.includeVisual,
        force: opts.force,
      });
    },
  );

cli
  .command(
    'judge-pack <run-id>',
    'Emit a self-contained blind-judging bundle (screenshots + frozen rubric + SCORING.md) for a fresh-context judge. No source, no diff, no prompt history.',
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--out <dir>', 'Output directory (default .validity/runs/<run-id>/judge-pack)')
  .action(async (runId: string, opts: { cwd: string; out?: string }) => {
    await runJudgePack(runId, { cwd: opts.cwd, out: opts.out });
  });

cli
  .command(
    'judge [run-id]',
    'Score soft criteria with an INDEPENDENT LLM judge (configured via scoring.judgeModel). Sends the blind judge-pack to your provider; folds scores through the same citation gate as record_soft_scores. Never a false green.',
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--spec <id>', 'Judge the latest run of this spec instead of a run id')
  .option('--all', 'Judge every frozen spec whose soft criteria need (re)scoring')
  .action(
    async (runId: string | undefined, opts: { cwd: string; spec?: string; all?: boolean }) => {
      await runJudgeCli(runId, { cwd: opts.cwd, spec: opts.spec, all: opts.all });
    },
  );

cli
  .command(
    'browse [component]',
    "Storybook-style component browser. Runs Validity's own Vite over node_modules/.validity/ — does NOT require `npm run dev`. Pass a component path (or partial name) as the positional arg to open that file directly.",
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option(
    '--component <path>',
    'Alternate to the positional arg: project-relative path or fuzzy name',
  )
  .option('--fixtures <names>', 'Comma-separated fixture names for stacked render')
  .option(
    '--scenario <name>',
    'Scenario id to render under (drives cookies / localStorage / network)',
  )
  .option('--port <n>', 'Preferred port (default: pick a free one)')
  .option('--no-open', 'Print the URL but do not open a browser tab')
  .option(
    '--native',
    'React Native playground: mount the component in a booted iOS Simulator / Android emulator instead of the web sandbox. Automatic on React Native / Expo projects',
  )
  .option(
    '--web',
    'React Native / Expo only: browse through the Expo Web (react-native-web) proxy instead of a device. A different runtime than your app ships on — opt in deliberately',
  )
  .option(
    '--platform <ios|android>',
    'Native platform (with --native). Defaults to native.target in config, else ios',
  )
  .option(
    '--scheme <scheme>',
    'URL scheme for the native deep link (with --native). Defaults to native.scheme in config',
  )
  .action(
    async (
      component: string | undefined,
      opts: {
        cwd: string;
        component?: string;
        fixtures?: string;
        scenario?: string;
        port?: string | number;
        open?: boolean;
        native?: boolean;
        web?: boolean;
        platform?: string;
        scheme?: string;
      },
    ) => {
      await runBrowse({
        cwd: opts.cwd,
        // Positional wins; --component is the fallback for back-compat.
        component: component ?? opts.component,
        fixtures: opts.fixtures,
        scenario: opts.scenario,
        port: opts.port != null ? Number(opts.port) : undefined,
        open: opts.open,
        native: opts.native,
        web: opts.web,
        platform:
          opts.platform === 'android' ? 'android' : opts.platform === 'ios' ? 'ios' : undefined,
        scheme: opts.scheme,
      });
    },
  );

cli
  .command(
    'signals <sub> [id]',
    'Inspect/close the local signal queue. Subcommands: list [--all] | suppress <id> [--note] | resolve <id> [--note].',
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--all', '`list`: include resolved and suppressed rows')
  .option('--note <text>', '`suppress` / `resolve`: optional note stored on the transition')
  .action(
    async (
      sub: string,
      id: string | undefined,
      opts: { cwd: string; all?: boolean; note?: string },
    ) => {
      await runSignals(sub, id, { cwd: opts.cwd, all: opts.all, note: opts.note });
    },
  );

cli
  .command(
    'spec <sub> [id]',
    'Inspect/freeze/export durable specs. Subcommands: ls | show <id> | freeze <id> | export [id].',
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--status <status>', 'Filter `ls` by status (draft/reviewed/approved/frozen/superseded)')
  .option('--component <name>', 'Filter `ls` by a target component name (substring match)')
  .option(
    '--target <name>',
    'One-shot `export` target override: playwright | maestro (default: by runtime)',
  )
  .option(
    '--out <dir>',
    'One-shot `export` output dir (skips the drift-checked .validity/exports/ layout)',
  )
  .option('--base-url <url>', 'Base URL for the Playwright export (default: config export.baseUrl)')
  .option('--force', 'Overwrite existing files on one-shot `export`')
  .option('--all', '`export`: every export-eligible frozen spec → .validity/exports/')
  .option('--allow-stubs', '`export --all`: also export lossy specs (stubs are never portable)')
  .option('--check', '`export`: recompile every manifest entry + byte-compare (the CI drift gate)')
  .option('--fix', '`export --check`: regenerate drifted artifacts / prune dead ones in place')
  .option('--run', '`export`: RUN the exported Maestro flow(s) on a booted device via agent-device')
  .option(
    '--dry-run',
    '`export`: validate the exported Maestro flow(s) against the engine subset (no device)',
  )
  .option(
    '--platform <ios|android>',
    '`export --run`: bind the agent-device target platform (default: export.maestro.run.platform)',
  )
  .option(
    '--device <id>',
    '`export --run`: bind a specific device/udid (default: export.maestro.run.device)',
  )
  .action(
    async (
      sub: string,
      id: string | undefined,
      opts: {
        cwd: string;
        status?: string;
        component?: string;
        target?: string;
        out?: string;
        baseUrl?: string;
        force?: boolean;
        all?: boolean;
        allowStubs?: boolean;
        check?: boolean;
        fix?: boolean;
        run?: boolean;
        dryRun?: boolean;
        platform?: string;
        device?: string;
      },
    ) => {
      await runSpec(sub, id, {
        cwd: opts.cwd,
        status: opts.status,
        component: opts.component,
        target: opts.target,
        out: opts.out,
        baseUrl: opts.baseUrl,
        force: opts.force,
        all: opts.all,
        allowStubs: opts.allowStubs,
        check: opts.check,
        fix: opts.fix,
        run: opts.run,
        dryRun: opts.dryRun,
        platform: opts.platform,
        device: opts.device,
      });
    },
  );

cli
  .command(
    'onboard <subcommand>',
    'Review and batch-freeze bulk-created specs (one approval action per batch)',
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--batch <id>', 'Only review specs minted under this bulk-batch id')
  .option(
    '--approve',
    'Approve AND freeze every pending spec in one action (the single human gate)',
  )
  .option('--json', 'Print a machine-readable report instead of tables')
  .action(
    async (
      subcommand: string,
      opts: { cwd: string; batch?: string; approve?: boolean; json?: boolean },
    ) => {
      await runOnboard(subcommand, {
        cwd: opts.cwd,
        batch: opts.batch,
        approve: opts.approve,
        json: opts.json,
      });
    },
  );

cli
  .command(
    'verify',
    'Re-run frozen specs’ mechanical (hard/property) checks for CI. Requires --all. Interactive verify is the MCP tool validity__verify.',
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--all', 'Verify every frozen spec (the regression sweep)')
  .option('--changed', 'Only specs whose target components changed in the working tree')
  .option('--specs <ids>', 'Comma-separated spec ids to verify (overrides --all/--changed)')
  .option(
    '--report <kind>',
    'Report format: table (default) | junit (aliases: ci, xml) | markdown',
    { default: 'table' },
  )
  .option('--out <file>', 'Write the --report output to this file instead of stdout')
  .option(
    '--summary <file>',
    'Also write a Markdown summary to this file (point at $GITHUB_STEP_SUMMARY in CI)',
  )
  .option(
    '--report-html <file>',
    'Render a self-contained report.html (screenshots + proven + soft-advisory) to this file. ' +
      'This is YOUR artifact — it stays in your storage (CI uploads it as a GitHub artifact).',
  )
  .option(
    '--check-output <file>',
    'Write check metadata JSON (verdict/coverage/counts; no report bytes) for the GitHub Action',
  )
  .option(
    '--native-avd <name>',
    'Boot this Android AVD to verify runtime:native specs on-device (requires --native-apk). ' +
      'Omit BOTH --native-avd/--native-apk to auto-detect a running device + the newest companion APK.',
  )
  .option('--native-apk <path>', 'Companion APK to install on the booted emulator')
  .option('--native-port <port>', 'Emulator console port (default 5554)')
  .option(
    '--native-boot-timeout <seconds>',
    'Max seconds to wait for the emulator to boot (default 120)',
  )
  .option(
    '--lean',
    'No-op for the CI sweep — it never emits screenshots. Accepted so the same flag works across MCP + CLI.',
  )
  .option(
    '--judge',
    'Score soft criteria with the automated LLM judge (needs scoring.judgeModel + its API key env). Without it, soft stays skipped. Judge failures are skipped-with-reason, never a pass; the exit gate stays hard/property-only.',
  )
  .action(
    async (opts: {
      cwd: string;
      all?: boolean;
      changed?: boolean;
      specs?: string;
      report?: string;
      out?: string;
      summary?: string;
      reportHtml?: string;
      checkOutput?: string;
      nativeAvd?: string;
      nativeApk?: string;
      nativePort?: string;
      nativeBootTimeout?: string;
      lean?: boolean;
      judge?: boolean;
    }) => {
      // `--specs` is PRESENT when cac handed back a string (even `""`), absent
      // when it's undefined. We track presence separately from the parsed list
      // so a present-but-empty value (`--specs ""`, `--specs ,`) is an explicit
      // — if empty — selection rather than a fall-through to the full sweep.
      const specsProvided = typeof opts.specs === 'string';
      const explicit = specsProvided
        ? opts
            .specs!.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      if (!opts.all && !opts.changed && !specsProvided) {
        process.stdout.write(
          pc.bold('Interactive verify lives in your host agent.\n') +
            pc.dim(
              '  Ask your MCP agent (Claude Code, Cursor, etc.) to run `validity__verify`.\n' +
                '  For CI/regression, pass --all (or --changed / --specs id,id) to re-run frozen\n' +
                '  specs’ mechanical checks here without an LLM.\n',
            ),
        );
        return;
      }
      // A present-but-empty `--specs` selects nothing on purpose — say so and
      // run nothing, rather than silently expanding to the full frozen sweep.
      if (specsProvided && explicit!.length === 0) {
        process.stdout.write(pc.yellow('no spec ids parsed from --specs — nothing to verify.\n'));
        return;
      }
      // `--lean` is a documented no-op here: `validity verify` runs only the
      // mechanical sweep (verify-all), which never emits screenshots — the flag
      // exists so the same invocation works against the MCP tool too. Threading
      // it would imply behavior that doesn't exist.
      if (opts.lean) {
        process.stdout.write(
          pc.dim('--lean has no effect on the CI sweep (it never emits screenshots).\n'),
        );
      }
      // Native CI verify: `--native-avd` and `--native-apk` are required
      // together — installCompanion needs the APK, so booting an emulator we
      // then can't install onto would just fail later, more expensively.
      if (Boolean(opts.nativeAvd) !== Boolean(opts.nativeApk)) {
        process.stderr.write(
          pc.red('--native-avd and --native-apk must be provided together.\n') +
            pc.dim('  Pass both to boot an emulator and install the companion APK.\n'),
        );
        // Fail the build: the user asked for a native gate but mis-specified it.
        // A bare return would exit 0 and silently skip the native specs.
        process.exitCode = 1;
        return;
      }
      const native = opts.nativeAvd
        ? {
            avdName: opts.nativeAvd,
            apkPath: opts.nativeApk!,
            port: opts.nativePort ? Number(opts.nativePort) : undefined,
            bootTimeoutSec: opts.nativeBootTimeout ? Number(opts.nativeBootTimeout) : undefined,
          }
        : undefined;
      const reportKinds = ['table', 'junit', 'markdown', 'ci', 'xml'] as const;
      const report = (reportKinds as readonly string[]).includes(opts.report ?? 'table')
        ? (opts.report as (typeof reportKinds)[number])
        : 'table';
      await runVerifyAll({
        cwd: opts.cwd,
        all: opts.all,
        changed: opts.changed,
        specs: explicit,
        report,
        out: opts.out,
        summary: opts.summary,
        reportHtml: opts.reportHtml,
        checkOutput: opts.checkOutput,
        native,
        // A lone --native-port (no avd/apk) is for the auto-discovery path: it
        // overrides the port parsed from an `emulator-<port>` serial. When
        // `native` is set the port already lives inside it, so don't double-pass.
        nativePort: !native && opts.nativePort ? Number(opts.nativePort) : undefined,
        judge: opts.judge,
      });
    },
  );

cli
  .command(
    'trends',
    'Render spec history (runs.jsonl + committed history) into a self-contained trends.html — verdict/coverage timelines, signals, perf sparklines. Local only; a viewer, never a gate.',
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--out <file>', 'Output path (default .validity/reports/trends.html)')
  .option('--spec <ids>', 'Comma-separated spec ids to include (default: all)')
  .option('--limit <n>', 'Max timeline rows per spec (default 200)')
  .action(async (opts: { cwd: string; out?: string; spec?: string; limit?: string }) => {
    const specs = opts.spec
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const limit = opts.limit != null && opts.limit !== '' ? Number(opts.limit) : undefined;
    await runTrends({
      cwd: opts.cwd,
      out: opts.out,
      specs,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
  });

cli
  .command(
    'compare <runA> <runB>',
    'Side-by-side compare of two verify runs: screenshots paired by render slug, criteria verdict deltas, perf deltas. Writes compare HTML; a viewer, never a gate.',
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--out <file>', 'Output path (default .validity/reports/compare-<runA>--<runB>.html)')
  .action(async (runA: string, runB: string, opts: { cwd: string; out?: string }) => {
    await runCompare(runA, runB, { cwd: opts.cwd, out: opts.out });
  });

cli
  .command(
    'attest verify <run-dir>',
    "Re-check a run's attestation chain: attestation.json, run-meta, every screenshot's sha256, the signed report, and the frozen spec. Exits non-zero naming the field or file that changed.",
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option(
    '--public-key <base64>',
    "Verify against this key instead of the record's own (proves WHICH machine signed it)",
  )
  .action(async (runDirArg: string, opts: { cwd: string; publicKey?: string }) => {
    await runAttestVerify(runDirArg, { cwd: opts.cwd, publicKey: opts.publicKey });
  });

cli
  .command(
    'replay <run-dir>',
    "Re-execute a run's DETERMINISTIC lane (hard + property checks from the frozen spec it cited) against the current working tree and diff the verdicts per criterion: reproduced / regressed / improved / unverifiable-now. Verifies the attestation first and stops if it fails. Soft criteria are never re-scored. Exits 1 on regression, 3 when the lane could not be fully re-executed.",
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--json', 'Emit the structured result instead of the console view')
  .option(
    '--public-key <base64>',
    "Verify the attestation against this key instead of the record's own",
  )
  .option(
    '--keep-session',
    'Leave the device session up after the recorded `.ad` journey (agent-device --keep-session) so you can keep inspecting the screen it landed on — and so perf/network evidence can be captured after it. Native `.ad` only; ignored with a note on web runs.',
  )
  .action(
    async (
      runDirArg: string,
      opts: { cwd: string; json?: boolean; publicKey?: string; keepSession?: boolean },
    ) => {
      await runReplay(runDirArg, {
        cwd: opts.cwd,
        json: opts.json,
        publicKey: opts.publicKey,
        keepSession: opts.keepSession,
      });
    },
  );

cli
  .command(
    'clean',
    'Prune old runs under .validity/runs/ (keeps the most-recent N per spec). Durable trends/compare HTML and baselines are never touched.',
  )
  .option('--cwd <path>', 'Project root', { default: process.cwd() })
  .option('--keep <n>', 'Runs to keep per spec (default 10)')
  .option('--older-than <days>', 'Only prune runs older than this many days')
  .option('--dry-run', 'Show what would be removed without deleting')
  .action(async (opts: { cwd: string; keep?: string; olderThan?: string; dryRun?: boolean }) => {
    const keep = opts.keep != null && opts.keep !== '' ? Number(opts.keep) : undefined;
    const olderThanDays =
      opts.olderThan != null && opts.olderThan !== '' ? Number(opts.olderThan) : undefined;
    await runClean({
      cwd: opts.cwd,
      keep: Number.isFinite(keep) ? keep : undefined,
      olderThanDays: Number.isFinite(olderThanDays) ? olderThanDays : undefined,
      dryRun: opts.dryRun,
    });
  });

cli.help();
cli.version(cliVersionString());

// Commands that used to exist but no longer do — surface a clear error
// rather than letting cac silently no-op. Validity is now driven by the MCP
// `validity__verify` tool from the host agent (Claude Code, Cursor, etc.);
// these commands never had an Anthropic-key-free path.
const REMOVED_COMMANDS: Record<string, string> = {
  validate: 'Use the MCP `validity__verify` tool from your host agent instead.',
  lock: 'Removed. The host agent extracts criteria from the prompt directly.',
  report: 'Removed. The host agent emits the verdict inline; reports are no longer persisted.',
  setup: 'Removed. Run `validity init` (or `validity init --force` to re-scaffold).',
  watch: 'Removed. Re-run `validity verify --all` for a mechanical sweep.',
  dashboard: 'Removed. Use `validity signals list` and `validity trends`.',
  upgrade: 'Removed. Update this checkout and `pnpm build`.',
};

/**
 * Hand back every agent-device session this command established.
 *
 * COMMAND-END, not per-spec: the warm-session registry exists so a `verify
 * --all` sweep opens once, and closing between specs would undo it. What it
 * buys is the DEVICE CLAIM — agent-device writes one per session, and a claim
 * whose daemon later exits is the "phantom device claim" the next run's
 * readiness pass used to report after every single native verify.
 *
 * Never throws and never touches `process.exitCode`: teardown must not be able
 * to change what the run already decided.
 */
async function releaseNativeSessions(): Promise<void> {
  try {
    await closeEstablishedNativeSessions();
  } catch {
    // Best-effort by construction; the close itself already swallows failures.
  }
}

async function main() {
  try {
    // Signals reach the same teardown the normal path takes. Installed before
    // any command runs, so a Ctrl-C mid-sweep releases the claim too; the
    // handler defers the exit decision to whatever else is listening (browse's
    // Vite teardown, watch's watcher close) and re-raises only when nothing is.
    installNativeSessionShutdownHandlers();
    // Bare `validity` is the same thing as `validity start` — a user who types
    // the binary name with nothing after it is asking "what now?", and that is
    // the only question the onboarding checklist answers.
    if (process.argv.length <= 2) {
      await runStart();
    } else {
      const firstArg = process.argv[2];
      if (firstArg && Object.prototype.hasOwnProperty.call(REMOVED_COMMANDS, firstArg)) {
        process.stderr.write(
          pc.red(`error: \`${firstArg}\` was removed in this version of validity.\n`),
        );
        process.stderr.write(`  ${REMOVED_COMMANDS[firstArg]}\n`);
        process.exit(2);
      }
      cli.parse(process.argv, { run: false });
      await cli.runMatchedCommand();
    }
  } catch (err) {
    await releaseNativeSessions();
    process.stderr.write(pc.red(`error: ${(err as Error).message}\n`));
    process.exit(1);
  }
  await releaseNativeSessions();
}

main();
