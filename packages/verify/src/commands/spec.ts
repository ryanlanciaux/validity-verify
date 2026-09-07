/**
 * `validity spec <sub> [id]` — the human/CLI surface over the spec store.
 *
 * Specs are durable, versioned acceptance contracts living under
 * `.validity/specs/`. The MCP tools (`validity__plan` etc.) write them; this
 * command lets a human (or CI) inspect, freeze, and export them WITHOUT a host
 * LLM in the loop. Four subcommands:
 *
 *   ls               list specs + DERIVED maturity (probation/dev/team/certified)
 *   show   <id>      print the spec YAML, the maturity backlog ("N steps from
 *                    certified"), and recent regression verdicts
 *   freeze <id>      lock content + bind the content-hash (honors specApproval)
 *   export           compile specs to drift-checked Playwright/Maestro tests:
 *                      export <id>            one spec → .validity/exports/ + manifest
 *                      export <id> --out <d>  one-shot copy elsewhere (no manifest)
 *                      export --all           every certified-eligible frozen spec
 *                      export --check [--fix] CI gate: recompile + byte-compare
 *                      export <id> --run      RUN the exported Maestro flow on a
 *                                             device (agent-device 0.20.5 engine)
 *                      export <id> --dry-run  validate it against the engine's
 *                                             supported subset, no device
 *
 * Error handling mirrors `export.ts`: clear stderr line + a non-zero exit code,
 * never a silent no-op.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  criterionIsBlocking,
  freezeSpec,
  listSpecs,
  loadSignals,
  readSpec,
  readSpecRunHistory,
  serializeSpec,
  SpecValidationError,
  type MaturityAssessment,
  type Spec,
  type SpecMaturity,
  type SpecRunSummary,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import {
  assessSpecMaturity,
  assessSpecPortability,
  checkSpecExports,
  collectExportGateWarnings,
  exportSpecToMaestro,
  exportSpecToPlaywright,
  writeSpecExport,
  type ExportCheckFinding,
  type ExportWarning,
  type PortabilityAssessment,
} from '@validity.ai/verify-web';
import {
  resolveMaestroTarget,
  runMaestroExport,
  type RunMaestroExportReport,
} from '../run-maestro-export.js';

export interface SpecOptions {
  cwd?: string;
  status?: string;
  component?: string;
  target?: string;
  out?: string;
  force?: boolean;
  baseUrl?: string;
  /** `export --all`: every certified-eligible frozen spec. */
  all?: boolean;
  /** `export --all --allow-stubs`: export lossy files too (never certifies). */
  allowStubs?: boolean;
  /** `export --check`: recompile + byte-compare every manifest entry (CI verb). */
  check?: boolean;
  /** `export --check --fix`: regenerate/prune in place instead of failing. */
  fix?: boolean;
  /** `export --run`: execute the exported Maestro flow(s) on a booted device. */
  run?: boolean;
  /** `export --dry-run`: subset-validate the exported flow(s); no device. */
  dryRun?: boolean;
  /** `--run` target binding, forwarded to agent-device. */
  platform?: string;
  /** `--run` device/udid, forwarded to agent-device. */
  device?: string;
}

const SUBCOMMANDS = ['ls', 'show', 'freeze', 'export'] as const;
type SubCommand = (typeof SUBCOMMANDS)[number];

export async function runSpec(
  sub: string | undefined,
  id: string | undefined,
  opts: SpecOptions = {},
): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();

  if (!sub || !SUBCOMMANDS.includes(sub as SubCommand)) {
    process.stderr.write(
      pc.red(
        `error: \`validity spec\` needs a subcommand: ${SUBCOMMANDS.join(' | ')}.\n` +
          `  e.g. \`validity spec ls\`, \`validity spec show spec-7f3a\`.\n`,
      ),
    );
    process.exit(2);
    return;
  }

  switch (sub as SubCommand) {
    case 'ls':
      return runSpecLs(projectRoot, opts);
    case 'show':
      return runSpecShow(projectRoot, id, opts);
    case 'freeze':
      return runSpecFreeze(projectRoot, id);
    case 'export':
      return runSpecExport(projectRoot, id, opts);
  }
}

/* ------------------------------------------------------------------ *
 * spec ls                                                             *
 * ------------------------------------------------------------------ */

function lastVerdict(history: SpecRunSummary[]): string {
  if (history.length === 0) return pc.dim('—');
  const last = history[history.length - 1]!;
  switch (last.verdict) {
    case 'pass':
      return pc.green('pass');
    case 'fail':
      return pc.red('fail');
    case 'partial':
      return pc.yellow('partial');
    default:
      return pc.dim('unknown');
  }
}

/**
 * Best-effort config load shared by the maturity/export paths. A missing or
 * invalid config never blocks a read surface — maturity derives with the
 * honest "no baseUrl/appId configured" warnings instead.
 */
async function loadConfigOrUndefined(projectRoot: string): Promise<ValidityConfig | undefined> {
  try {
    return (await loadConfig(projectRoot)).config;
  } catch {
    return undefined;
  }
}

/** Colored maturity label for the ls column / show header. */
function maturityLabel(level: SpecMaturity): string {
  switch (level) {
    case 'certified':
      return pc.green('certified');
    case 'team':
      return pc.cyan('team');
    case 'dev':
      return pc.yellow('dev');
    case 'probation':
      return pc.magenta('probation');
  }
}

async function runSpecLs(projectRoot: string, opts: SpecOptions): Promise<void> {
  const specs = listSpecs(projectRoot, (id, err) =>
    process.stderr.write(pc.yellow(`warning: skipping malformed spec ${id}: ${err.message}\n`)),
  );

  let filtered = specs;
  if (opts.status) {
    filtered = filtered.filter((s) => s.status === opts.status);
  }
  if (opts.component) {
    const needle = opts.component.toLowerCase();
    filtered = filtered.filter((s) =>
      (s.targets?.components ?? []).some((c) => c.toLowerCase().includes(needle)),
    );
  }

  if (filtered.length === 0) {
    if (specs.length === 0) {
      process.stdout.write(
        pc.dim('No specs found under .validity/specs/. Specs are created by `validity__plan`.\n'),
      );
    } else {
      process.stdout.write(pc.dim('No specs match the given filters.\n'));
    }
    return;
  }

  const config = await loadConfigOrUndefined(projectRoot);
  process.stdout.write(
    pc.bold(
      `${pad('SPEC', 14)}${pad('VER', 5)}${pad('STATUS', 12)}${pad('MATURITY', 11)}${pad(
        'RUNTIME',
        9,
      )}${pad('CRIT', 6)}LAST\n`,
    ),
  );
  const tally: Record<SpecMaturity, number> = { probation: 0, dev: 0, team: 0, certified: 0 };
  for (const spec of filtered) {
    const history = readSpecRunHistory(projectRoot, spec.id, 10);
    const maturity = assessSpecMaturity(projectRoot, spec, config);
    tally[maturity.level] += 1;
    // maturityLabel carries ANSI color codes, so pad the PLAIN name manually.
    const maturityCol =
      maturityLabel(maturity.level) + ' '.repeat(Math.max(1, 11 - maturity.level.length));
    process.stdout.write(
      `${pad(spec.id, 14)}${pad(`v${spec.version}`, 5)}${pad(spec.status, 12)}${maturityCol}${pad(
        spec.runtime,
        9,
      )}${pad(String(spec.criteria.length), 6)}${lastVerdict(history)}\n`,
    );
  }
  process.stdout.write(
    pc.dim(
      `\n${tally.certified} certified · ${tally.team} team · ${tally.dev} dev · ${tally.probation} probation` +
        ` — \`validity spec show <id>\` lists each spec's path to certified.\n`,
    ),
  );
}

/** Left-justify a plain string into `width` columns (1-space minimum gap). */
function pad(s: string, width: number): string {
  return s.length >= width ? `${s} ` : s + ' '.repeat(width - s.length);
}

/**
 * The loop stop signal at a given run: `✓` when this run was signed off
 * (computeSignedOff over its criteria), `·` otherwise. `signedOff` is optional
 * on the timeline (older appends / non-spec runs lack it), so undefined reads as
 * not-signed-off rather than a hole in the column.
 */
function signedOffMarker(run: SpecRunSummary): string {
  return run.signedOff ? pc.green('✓') : pc.dim('·');
}

/* ------------------------------------------------------------------ *
 * spec show <id>                                                      *
 * ------------------------------------------------------------------ */

/**
 * Render the optional portability badge — export health, shown ONLY when the
 * project configured an `export` stanza. Decoupled from maturity: portable is
 * an anti-lock-in property (specs compile to a conventional suite), never a
 * trust level.
 */
export function renderPortability(portability: PortabilityAssessment): string {
  if (portability.status === 'unconfigured') return '';
  const run = portability.run;
  // The run line is printed on BOTH branches: a pass is the strongest thing the
  // badge can say, and a not-run is worth naming so nobody reads "portable" as
  // "somebody executed this".
  const runLine = ((): string => {
    if (!run) return '';
    switch (run.status) {
      case 'passed':
        return pc.dim(`  [run] ${run.detail}`);
      case 'failed':
      case 'unsupported':
        return pc.dim(`  [run] ${run.detail}`);
      case 'stale':
        return pc.dim(`  [run] ${run.detail}`);
      default:
        return pc.dim(
          `  [run] never executed — \`validity spec export <id> --run\` proves it on a device, ` +
            `\`--dry-run\` checks it against the engine's subset.`,
        );
    }
  })();

  if (portability.status === 'portable') {
    const head =
      `${pc.bold('Portable:')} ${pc.green('yes')} — gate checks compile warning-free and the ` +
      `exported artifacts are byte-fresh (\`spec export --check\`).`;
    return runLine ? `${head}\n${runLine}\n` : `${head}\n`;
  }
  const lines = [`${pc.bold('Portable:')} ${pc.yellow('not yet')}:`];
  for (const w of portability.warnings) lines.push(pc.dim(`  [${w.scope}] ${w.message}`));
  if (portability.artifact && portability.artifact.status !== 'ok') {
    lines.push(
      pc.dim(
        `  [artifacts] ${portability.artifact.detail ?? `${portability.artifact.status} — run \`validity spec export\``}`,
      ),
    );
  }
  if (runLine) lines.push(runLine);
  return lines.join('\n') + '\n';
}

/** Render the maturity assessment as the spec's hardening backlog. */
export function renderMaturityAssessment(assessment: MaturityAssessment): string {
  const lines: string[] = [];
  if (assessment.level === 'certified') {
    lines.push(
      `${pc.bold('Maturity:')} ${maturityLabel('certified')} — the frozen contract is currently ` +
        `proven: every gate criterion passing on fresh, untainted evidence across consecutive ` +
        `clean verifications.`,
    );
    return lines.join('\n') + '\n';
  }
  const n = assessment.blockers.length;
  lines.push(
    `${pc.bold('Maturity:')} ${maturityLabel(assessment.level)} — ${n} step${n === 1 ? '' : 's'} from ${pc.green('certified')}:`,
  );
  for (const [i, b] of assessment.blockers.entries()) {
    const tag = pc.dim(`[${b.kind}]`);
    lines.push(`  ${i + 1}. ${tag} ${b.detail}`);
  }
  return lines.join('\n') + '\n';
}

async function runSpecShow(
  projectRoot: string,
  id: string | undefined,
  opts: SpecOptions,
): Promise<void> {
  const spec = requireSpec(projectRoot, id);

  process.stdout.write(serializeSpec(spec));

  // The hardening backlog — what stands between this spec and "runnable by any
  // CI, forever, for free". Derived, never authored (maturity.ts).
  const config = await loadConfigOrUndefined(projectRoot);
  process.stdout.write(
    '\n' + renderMaturityAssessment(assessSpecMaturity(projectRoot, spec, config)),
  );
  const portabilityLine = renderPortability(assessSpecPortability(projectRoot, spec, config));
  if (portabilityLine) process.stdout.write('\n' + portabilityLine);

  // Pending hardening candidates (maturity Phase C): machine-proposed hard
  // replacements for soft criteria that passed N consecutive runs on
  // identical evidence. Never auto-applied — paste into a spec_update.
  const candidates = loadSignals(projectRoot).filter(
    (s) => s.kind === 'hardening-candidate' && s.status === 'open' && s.specId === spec.id,
  );
  if (candidates.length > 0) {
    process.stdout.write(
      '\n' +
        pc.bold(
          `${candidates.length} pending hardening candidate${candidates.length === 1 ? '' : 's'} (machine-suggested, human-ratified):\n`,
        ),
    );
    for (const c of candidates) {
      process.stdout.write(`  ${pc.yellow('◇')} ${c.detail}\n`);
      if (c.hardening) {
        process.stdout.write(
          pc.dim(
            `    spec_update patch: ${JSON.stringify({ criteria: [c.hardening.proposal] })}\n`,
          ),
        );
      }
    }
  }

  const limit = 10;
  const history = readSpecRunHistory(projectRoot, spec.id, limit);
  process.stdout.write('\n');
  if (history.length === 0) {
    process.stdout.write(pc.dim('No verify runs recorded for this spec yet.\n'));
    return;
  }
  process.stdout.write(
    pc.bold(`Last ${history.length} run verdict${history.length === 1 ? '' : 's'}:\n`),
  );
  for (const run of history) {
    const verdict = lastVerdict([run]);
    const counts = pc.dim(
      `(${run.counts.pass} pass / ${run.counts.fail} fail / ${run.counts.unverifiable} unverifiable)`,
    );
    process.stdout.write(
      `  ${signedOffMarker(run)} ${verdict}  ${pc.dim(run.createdAt)}  ${run.runId}  ${counts}\n`,
    );
  }
  // `opts` reserved for future show flags; referenced so lint stays quiet.
  void opts;
}

/* ------------------------------------------------------------------ *
 * spec freeze <id>                                                    *
 * ------------------------------------------------------------------ */

async function runSpecFreeze(projectRoot: string, id: string | undefined): Promise<void> {
  const specId = requireId(id, 'freeze');

  let approval: 'always' | 'never' | 'auto' = 'auto';
  try {
    const { config } = await loadConfig(projectRoot);
    approval = config.specApproval ?? 'auto';
  } catch (err) {
    // A missing/invalid config shouldn't block freezing — default to `auto`,
    // but surface the reason so the user knows the gate wasn't consulted.
    process.stderr.write(
      pc.yellow(
        `warning: could not load config (${(err as Error).message}); using specApproval=auto.\n`,
      ),
    );
  }

  try {
    const { spec } = freezeSpec({ projectRoot, specId, approval });
    process.stdout.write(
      pc.bold(`Froze ${spec.id}@v${spec.version}.\n`) +
        `  hash: ${pc.green(spec.hash ?? '(none)')}\n`,
    );
  } catch (err) {
    if (err instanceof SpecValidationError) {
      process.stderr.write(pc.red(`error: ${err.message}\n`));
      process.exit(1);
      return;
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * spec export <id>                                                    *
 * ------------------------------------------------------------------ */

async function runSpecExport(
  projectRoot: string,
  id: string | undefined,
  opts: SpecOptions,
): Promise<void> {
  // Mode dispatch: --check (CI drift gate) / --all (bulk canonical export) /
  // <id> (canonical export) / <id> --out|--target (legacy one-shot scaffold).
  if (opts.check) {
    return runSpecExportCheck(projectRoot, opts);
  }
  if (opts.all) {
    const config = await runSpecExportAll(projectRoot, opts);
    // Suite form, dispatched HERE rather than inside the bulk export so a repo
    // with nothing new to export still runs (or validates) the flows already
    // committed — the CI shape of this verb.
    if (opts.run || opts.dryRun) await runExportedFlows(projectRoot, opts, undefined, config);
    return;
  }
  if (!id && (opts.run || opts.dryRun)) {
    // `spec export --run` / `--dry-run` with no id: run what is committed. No
    // export happens, so nothing can silently change under the verdict.
    return runExportedFlows(projectRoot, opts);
  }
  if (!opts.out && !opts.target) {
    return runSpecExportCanonical(projectRoot, id, opts);
  }
  return runSpecExportOneShot(projectRoot, id, opts);
}

/* -------- the Maestro preview gate (parked 2026-07) -------- */

/**
 * Maestro export is parked as a PREVIEW: the mapping is structurally lossy
 * (network/console/perf/a11y/command checks cannot be expressed as Maestro
 * steps and degrade to TODO comments — essentially only element-visibility
 * maps cleanly). A mostly-empty flow silently landing in a repo erodes trust
 * faster than an honest refusal, so native export requires an explicit
 * `export.maestro.enabled: true` opt-in.
 *
 * The OTHER half of the original parking reason — "generated flows have no
 * automated on-device validation harness yet" — is closed as of agent-device
 * 0.20.5: `--run` executes the flow through its Maestro-subset engine and
 * records the verdict on the manifest, and `--dry-run` validates the flow
 * against that engine's supported subset with no device at all. The lossiness
 * reason stands on its own, so the opt-in stays.
 */
function maestroExportEnabled(config: ValidityConfig | undefined): boolean {
  return config?.export?.maestro?.enabled === true;
}

const MAESTRO_PREVIEW_NOTICE =
  'Maestro export is a PREVIEW: only element-visibility checks map cleanly; ' +
  'network/console/perf/a11y/command checks degrade to TODO comments. Exported flows ' +
  'can now be validated (`--dry-run`) and executed (`--run`) against the agent-device ' +
  '0.20.5 Maestro engine.';

function refuseMaestroPreview(specId: string): never {
  process.stderr.write(
    pc.yellow(
      `${MAESTRO_PREVIEW_NOTICE}\n` +
        `To export ${specId} anyway, opt in with \`export: { maestro: { enabled: true } }\` in ` +
        `.validity/config.ts — every degradation still warns.\n`,
    ),
  );
  process.exit(1);
  throw new Error('unreachable');
}

/* -------- canonical: .validity/exports/ + manifest (the default) -------- */

async function runSpecExportCanonical(
  projectRoot: string,
  id: string | undefined,
  opts: SpecOptions,
): Promise<void> {
  const spec = requireSpec(projectRoot, id);
  const config = await loadConfigOrUndefined(projectRoot);
  if (spec.runtime === 'native' && !maestroExportEnabled(config)) {
    refuseMaestroPreview(spec.id);
  }
  const result = writeSpecExport(projectRoot, spec, config, { baseUrl: opts.baseUrl });

  for (const abs of result.written) {
    process.stdout.write(`  ${pc.green('+')} ${relativeTo(projectRoot, abs)}\n`);
  }
  for (const abs of result.pruned) {
    process.stdout.write(
      `  ${pc.red('-')} ${relativeTo(projectRoot, abs)} ${pc.dim('(older version pruned)')}\n`,
    );
  }
  // Target-aware run hint: the export dir + concrete runner differ by runtime
  // (native → Maestro, web → Playwright), so the copy must not hardcode either.
  const runHint =
    spec.runtime === 'native'
      ? 'run the Maestro flow dir (`maestro test .validity/exports/maestro/`, or ' +
        '`agent-device test .validity/exports/maestro --maestro`)'
      : 'run the Playwright dir (`npx playwright test .validity/exports/playwright/`)';
  process.stdout.write(
    pc.bold(`\nExported ${spec.id}@v${spec.version} → .validity/exports/ (manifest updated).\n`) +
      pc.dim(
        'Commit these files — they are the team’s tests. CI can gate on ' +
          `\`validity spec export --check\` and ${runHint} with no Validity binary.\n`,
      ),
  );
  printWarnings(result.warnings);
  if (spec.runtime === 'native') {
    process.stdout.write(pc.yellow(`\npreview: ${MAESTRO_PREVIEW_NOTICE}\n`));
  }
  if (spec.status !== 'frozen') {
    process.stdout.write(
      pc.yellow(
        `\nnote: ${spec.id} is '${spec.status}', not frozen — the artifact is bound to an ` +
          `unfrozen contract and \`--check\` will flag it until the spec is frozen and re-exported.\n`,
      ),
    );
  }
  // Run-the-export executes the bytes THIS invocation just wrote, so the
  // recorded verdict can never describe a stale artifact. Config is threaded
  // through rather than re-read: the run must bind against the same config the
  // export just compiled from.
  if (opts.run || opts.dryRun) {
    await runExportedFlows(projectRoot, opts, spec, config);
  }
}

/* -------- --all: every certified-eligible frozen spec -------- */

/** Returns the loaded config so a following `--run` binds against the same one. */
async function runSpecExportAll(
  projectRoot: string,
  opts: SpecOptions,
): Promise<ValidityConfig | undefined> {
  const config = await loadConfigOrUndefined(projectRoot);
  const specs = listSpecs(projectRoot, (sid, err) =>
    process.stderr.write(pc.yellow(`warning: skipping malformed spec ${sid}: ${err.message}\n`)),
  );
  const allFrozen = specs.filter((s) => s.status === 'frozen');
  // Maestro preview gate: without the explicit opt-in, native specs are parked
  // out of the sweep entirely (one honest notice, not a per-spec refusal row).
  const parkedNative = maestroExportEnabled(config)
    ? []
    : allFrozen.filter((s) => s.runtime === 'native');
  const frozen = allFrozen.filter((s) => !parkedNative.includes(s));
  if (parkedNative.length > 0) {
    process.stdout.write(
      pc.yellow(
        `${parkedNative.length} native spec${parkedNative.length === 1 ? '' : 's'} skipped — ` +
          `${MAESTRO_PREVIEW_NOTICE} Opt in with \`export: { maestro: { enabled: true } }\`.\n`,
      ),
    );
  }
  if (frozen.length === 0) {
    process.stdout.write(pc.dim('No frozen specs to export. Freeze a spec first.\n'));
    return config;
  }

  let exported = 0;
  const refused: Array<{ spec: Spec; warnings: ExportWarning[]; reason: string }> = [];
  for (const spec of frozen) {
    const gateWarnings = collectExportGateWarnings(spec, config);
    const hasGate = spec.criteria.some((c) => criterionIsBlocking(c) && c.tier !== 'soft');
    const eligible = hasGate && gateWarnings.length === 0;
    if (!eligible && !opts.allowStubs) {
      refused.push({
        spec,
        warnings: gateWarnings,
        reason: hasGate
          ? `${gateWarnings.length} export warning${gateWarnings.length === 1 ? '' : 's'} over the gate`
          : 'no blocking hard/property criteria (nothing mechanical to export)',
      });
      continue;
    }
    const result = writeSpecExport(projectRoot, spec, config);
    exported += 1;
    process.stdout.write(
      `  ${pc.green('+')} ${spec.id}@v${spec.version} → ${result.entry.files.map((f) => f.path).join(', ')}` +
        (eligible ? '' : pc.yellow(' (stubs — not portable)')) +
        '\n',
    );
  }

  process.stdout.write(
    pc.bold(
      `\nExported ${exported}/${frozen.length} frozen spec${frozen.length === 1 ? '' : 's'}.\n`,
    ),
  );
  if (refused.length > 0) {
    process.stdout.write(
      pc.yellow(
        `\n${refused.length} spec${refused.length === 1 ? '' : 's'} refused (would emit stubs/TODOs — ` +
          `not export-eligible). Pass --allow-stubs to export lossy files anyway; they never earn ` +
          `the portable badge:\n`,
      ),
    );
    for (const r of refused) {
      process.stdout.write(`  ${pc.bold(r.spec.id)} — ${r.reason}\n`);
      for (const w of r.warnings) {
        process.stdout.write(pc.dim(`      [${w.scope}] ${w.message}\n`));
      }
    }
  }
  return config;
}

/* -------- --run / --dry-run: execute what we exported -------- */

/**
 * Run (or statically validate) the exported Maestro flows and print the result.
 *
 * `spec` present ⇒ the single-flow form (`agent-device replay <flow> --maestro`);
 * absent ⇒ the suite form over `.validity/exports/maestro/`.
 *
 * Refuses on a web spec rather than quietly doing nothing: `--run` executes
 * MAESTRO flows, and a Playwright export has its own runner the user already
 * owns. A silent no-op here would read as "it ran and was fine".
 *
 * The target binding comes from `--platform`/`--device` first and
 * `export.maestro.run` second (`resolveMaestroTarget` owns the rule). Where the
 * binding came from is PRINTED, because "which device did this verdict come
 * from" is the one question a recorded run must never leave ambiguous — a
 * committed config silently redirecting a run to another device would be a
 * provenance hole, not a convenience.
 */
async function runExportedFlows(
  projectRoot: string,
  opts: SpecOptions,
  spec?: Spec,
  loaded?: ValidityConfig,
): Promise<void> {
  if (spec && spec.runtime !== 'native') {
    process.stderr.write(
      pc.red(
        `error: \`--run\`/\`--dry-run\` execute exported MAESTRO flows, and ${spec.id} is a ` +
          `'${spec.runtime}' spec (it exports to Playwright). Run its export with the runner ` +
          `you already have: \`npx playwright test .validity/exports/playwright/\`.\n`,
      ),
    );
    process.exit(2);
    return;
  }
  const config = loaded ?? (await loadConfigOrUndefined(projectRoot));
  const target = resolveMaestroTarget({
    flags: { platform: opts.platform, device: opts.device },
    ...(config?.export?.maestro?.run ? { config: config.export.maestro.run } : {}),
  });
  for (const notice of target.notices) process.stderr.write(pc.yellow(`warning: ${notice}.\n`));
  if (target.platformSource === 'config' || target.deviceSource === 'config') {
    const fromConfig = [
      ...(target.platformSource === 'config' ? [`platform=${target.platform}`] : []),
      ...(target.deviceSource === 'config' ? [`device=${target.device}`] : []),
    ].join(', ');
    process.stdout.write(pc.dim(`Target binding from export.maestro.run: ${fromConfig}\n`));
  }
  const report = await runMaestroExport({
    projectRoot,
    specId: spec?.id,
    dryRun: opts.dryRun === true,
    ...(target.platform ? { platform: target.platform } : {}),
    ...(target.device ? { device: target.device } : {}),
  });
  process.stdout.write(renderMaestroRun(report));
  if (!report.ok) process.exit(1);
}

/**
 * Render a run-the-export report. Deliberately explicit about the difference
 * between "it failed" and "it did not run": the second is not a verdict about
 * the export, and the copy must never let it read as one.
 */
export function renderMaestroRun(report: RunMaestroExportReport): string {
  const lines: string[] = [''];
  if (report.mode === 'dry-run') {
    lines.push(
      pc.bold(
        `Subset check — ${report.flows.length} exported flow${report.flows.length === 1 ? '' : 's'} ` +
          `vs the agent-device 0.20.5 Maestro engine (no device):`,
      ),
    );
    for (const flow of report.flows) {
      if (flow.warnings.length === 0) {
        lines.push(`  ${pc.green('ok')}  ${flow.relPath}`);
        continue;
      }
      lines.push(`  ${pc.red('no')}  ${flow.relPath}`);
      for (const w of flow.warnings) lines.push(pc.dim(`        [${w.scope}] ${w.message}`));
    }
    for (const notice of report.notices) lines.push(pc.yellow(`  ${notice}`));
    lines.push('');
    lines.push(
      report.ok
        ? pc.dim(
            'Every emitted command is inside the engine’s supported subset. That is a ' +
              'parse-time guarantee, not a passing test — run it on a device with `--run`.',
          )
        : pc.red(
            'This export cannot run: the engine fails loudly on unsupported syntax, so the ' +
              'whole flow would refuse rather than partially assert.',
          ),
    );
    return lines.join('\n') + '\n';
  }

  lines.push(pc.bold('Run the export (agent-device Maestro engine):'));
  lines.push(pc.dim(`  $ ${report.command.bin} ${report.command.args.join(' ')}`));
  const verdict = report.verdict;
  if (verdict) {
    const label =
      verdict.status === 'passed'
        ? pc.green('passed     ')
        : verdict.status === 'failed'
          ? pc.red('failed     ')
          : verdict.status === 'unsupported'
            ? pc.red('unsupported')
            : pc.yellow('not run    ');
    lines.push(`  ${label} ${verdict.detail}`);
    if (verdict.counts) {
      const c = verdict.counts;
      lines.push(
        pc.dim(
          `        ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped, ` +
            `${c.notRun} not run (of ${c.total})`,
        ),
      );
    }
    for (const flow of verdict.flows ?? []) {
      const glyph =
        flow.status === 'passed'
          ? pc.green('+')
          : flow.status === 'failed'
            ? pc.red('-')
            : pc.dim('·');
      lines.push(
        `        ${glyph} ${flow.file}${flow.message ? pc.dim(` — ${flow.message}`) : ''}`,
      );
    }
  }
  for (const notice of report.notices) lines.push(pc.yellow(`  ${notice}`));
  if (report.recorded.length > 0) {
    lines.push(
      pc.dim(
        `  recorded on the exports manifest for ${report.recorded.join(', ')} — pinned to the ` +
          `artifact bytes that ran, so a re-export voids it rather than inheriting it.`,
      ),
    );
  }
  if (verdict?.status === 'not-run') {
    lines.push('');
    lines.push(
      pc.dim(
        'Not run is not a pass and not a failure. Nothing was proven here, and nothing about ' +
          'the export is implicated.',
      ),
    );
  }
  return lines.join('\n') + '\n';
}

/* -------- --check: the CI drift gate -------- */

function checkStatusLabel(finding: ExportCheckFinding): string {
  switch (finding.status) {
    case 'ok':
      return pc.green('ok        ');
    case 'hand-edit':
      return pc.red('hand-edit ');
    case 'stale-spec':
      return pc.red('stale-spec');
    case 'toolchain':
      return pc.yellow('toolchain ');
    case 'config':
      return pc.yellow('config    ');
    case 'missing-file':
      return pc.red('missing   ');
    default:
      return pc.yellow(pad(finding.status, 10));
  }
}

async function runSpecExportCheck(projectRoot: string, opts: SpecOptions): Promise<void> {
  const config = await loadConfigOrUndefined(projectRoot);
  const { ok, findings } = checkSpecExports(projectRoot, { config, fix: opts.fix });

  if (findings.length === 0) {
    process.stdout.write(pc.dim('No exported specs in the manifest — nothing to check (ok).\n'));
    return;
  }
  for (const f of findings) {
    const fixedTag = f.fixed ? pc.green(' [fixed]') : '';
    const pathTag = f.path ? pc.dim(` ${f.path}`) : '';
    process.stdout.write(`  ${checkStatusLabel(f)} ${pc.bold(f.specId)}${pathTag}${fixedTag}\n`);
    if (f.status !== 'ok') process.stdout.write(pc.dim(`      ${f.detail}\n`));
  }
  const drifted = findings.filter((f) => f.status !== 'ok' && !f.fixed).length;
  const fixed = findings.filter((f) => f.fixed).length;
  process.stdout.write(
    pc.bold(
      `\n${findings.filter((f) => f.status === 'ok').length} ok` +
        (fixed > 0 ? `, ${fixed} fixed` : '') +
        (drifted > 0 ? `, ${pc.red(`${drifted} drifted`)}` : '') +
        '.\n',
    ),
  );
  if (!ok) {
    process.stdout.write(
      pc.dim(
        'Exported tests are DERIVED files — regenerate with `validity spec export <id>` ' +
          '(or `--check --fix`), or edit the spec, never the test.\n',
      ),
    );
    process.exit(1);
  }
}

/* -------- legacy one-shot scaffold (--out / --target) -------- */

async function runSpecExportOneShot(
  projectRoot: string,
  id: string | undefined,
  opts: SpecOptions,
): Promise<void> {
  const spec = requireSpec(projectRoot, id);

  // Target derives from the spec's runtime unless explicitly overridden.
  const derived = spec.runtime === 'native' ? 'maestro' : 'playwright';
  const target = (opts.target ?? derived).toLowerCase();
  if (target !== 'playwright' && target !== 'maestro') {
    process.stderr.write(
      pc.red(
        `error: unknown --target "${target}". Supported: playwright | maestro ` +
          `(default derives from the spec's runtime: web→playwright, native→maestro).\n`,
      ),
    );
    process.exit(2);
    return;
  }

  const defaultOut = target === 'maestro' ? '.maestro' : 'tests/e2e';
  const outDir = resolve(projectRoot, opts.out ?? defaultOut);
  const config = await loadConfigOrUndefined(projectRoot);
  if (target === 'maestro' && !maestroExportEnabled(config)) {
    refuseMaestroPreview(spec.id);
  }

  let files;
  let warnings: ExportWarning[] = [];
  if (target === 'maestro') {
    const result = exportSpecToMaestro({
      spec,
      appId: config?.export?.appId,
      maestro: config?.export?.maestro,
    });
    files = result.files;
    warnings = result.warnings;
  } else {
    const result = exportSpecToPlaywright({
      spec,
      config,
      baseUrl: opts.baseUrl ?? config?.export?.baseUrl,
    });
    files = result.files;
    warnings = result.warnings;
  }

  process.stdout.write(
    pc.dim(
      `One-shot export to ${relativeTo(projectRoot, outDir)} — NOT drift-checked. The canonical, ` +
        `drift-checked location is .validity/exports/ (run without --out/--target).\n`,
    ),
  );

  let written = 0;
  let skipped = 0;
  for (const file of files) {
    // Defense-in-depth: the spec id is already schema-constrained, but a buggy
    // or hostile exporter handing back a `file.path` like `../../etc/foo` would
    // let `resolve(outDir, file.path)` escape the output dir. Refuse — never
    // write — when the resolved destination is not contained under `outDir`.
    const dest = resolveWithin(outDir, file.path);
    if (dest === null) {
      process.stderr.write(
        pc.red(
          `error: refusing to write outside the output dir: "${file.path}" ` +
            `escapes ${relativeTo(projectRoot, resolve(outDir))}.\n`,
        ),
      );
      process.exit(1);
      return;
    }
    if (existsSync(dest) && !opts.force) {
      process.stdout.write(
        `  ${pc.dim('-')} ${relativeTo(projectRoot, dest)} ${pc.dim('(exists — pass --force to overwrite)')}\n`,
      );
      skipped += 1;
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.contents);
    process.stdout.write(`  ${pc.green('+')} ${relativeTo(projectRoot, dest)}\n`);
    written += 1;
  }

  process.stdout.write(
    pc.bold(
      `\nWrote ${written} ${target} file${written === 1 ? '' : 's'}` +
        (skipped > 0 ? `, skipped ${skipped}` : '') +
        `.\n`,
    ),
  );
  process.stdout.write(
    pc.dim(
      'These files carry a regenerate-don’t-hand-edit header. ' +
        (target === 'maestro'
          ? 'Maestro is lossy for network/console checks — read the inline TODOs.\n'
          : 'Set baseURL in playwright.config.ts before running.\n'),
    ),
  );

  printWarnings(warnings);

  if (written === 0 && skipped > 0) {
    process.exit(1);
  }
}

/**
 * Severity-grouped warnings: announce every lossy mapping LOUDLY here instead
 * of burying it in inline `# TODO (lossy)` comments. Order is fixed
 * worst-first (wont-run = not a real assertion → needs-setup → degraded) so
 * the most dangerous degradations are read first.
 */
function printWarnings(warnings: ExportWarning[]): void {
  if (warnings.length === 0) return;
  const groups: { severity: ExportWarning['severity']; label: (s: string) => string }[] = [
    { severity: 'wont-run', label: pc.red },
    { severity: 'needs-setup', label: pc.yellow },
    { severity: 'degraded', label: pc.dim },
  ];
  process.stdout.write(
    '\n' + pc.yellow(`${warnings.length} export warning${warnings.length === 1 ? '' : 's'}:\n`),
  );
  for (const group of groups) {
    const inGroup = warnings.filter((w) => w.severity === group.severity);
    if (inGroup.length === 0) continue;
    process.stdout.write(`  ${group.label(`${group.severity} (${inGroup.length}):`)}\n`);
    for (const w of inGroup) {
      process.stdout.write(`    ${pc.bold(w.scope)} — ${w.message}\n`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Shared helpers.                                                     *
 * ------------------------------------------------------------------ */

function requireId(id: string | undefined, sub: string): string {
  if (!id) {
    process.stderr.write(
      pc.red(`error: \`validity spec ${sub}\` needs a spec id (e.g. \`spec-7f3a\`).\n`),
    );
    process.exit(2);
  }
  return id as string;
}

function requireSpec(projectRoot: string, id: string | undefined): Spec {
  const specId = requireId(id, 'show');
  let spec: Spec | null;
  try {
    spec = readSpec(projectRoot, specId);
  } catch (err) {
    process.stderr.write(pc.red(`error: ${(err as Error).message}\n`));
    process.exit(1);
    throw err; // unreachable; satisfies the type checker
  }
  if (!spec) {
    process.stderr.write(pc.red(`error: spec "${specId}" not found under .validity/specs/.\n`));
    process.exit(1);
    throw new Error('unreachable');
  }
  return spec;
}

function relativeTo(root: string, abs: string): string {
  if (abs.startsWith(root + '/')) return abs.slice(root.length + 1);
  return abs;
}

/**
 * Resolve `filePath` against `outDir` and assert the result stays inside
 * `outDir` (path-traversal guard). Returns the resolved absolute destination
 * when contained, or `null` when it would escape (so the caller can refuse).
 */
export function resolveWithin(outDir: string, filePath: string): string | null {
  const base = resolve(outDir);
  const dest = resolve(base, filePath);
  if (dest !== base && !dest.startsWith(base + sep)) return null;
  return dest;
}
