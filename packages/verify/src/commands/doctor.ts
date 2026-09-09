import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import pc from 'picocolors';
import { detectFramework } from '@validity.ai/verify-web';
import {
  agentStanzaPresence,
  attestKeyPath,
  attestPublicKey,
  shortId,
  detectAppTarget,
  detectProjectShape,
  gitTracksPath,
  plansDir,
  rebuildSignalsFromHistory,
  scoreHistoryPath,
  scorecardPath,
  signalsPath,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  COMPANION_BRIDGE_PORT,
  checkNativeReadiness,
  companionBuildIdentity,
  defaultRunner,
  doctorFindings,
  probeAgentDeviceDoctor,
  probeMetroPortOwners,
  type CommandRunner,
  type MetroPortOwner,
} from '@validity.ai/verify-native';
import {
  classifyMcpRuntime,
  describeMcpRuntime,
  isPidAlive,
  readMcpRuntimeStamp,
  type McpRuntimeStamp,
} from '../mcp-runtime.js';
import { cliVersionString } from '../version.js';

export interface Check {
  name: string;
  status: 'ok' | 'info' | 'warn' | 'fail';
  detail: string;
}

export function agentStanzaCheck(cwd: string): Check {
  const { claudeMd, agentsMd } = agentStanzaPresence(cwd);
  if (claudeMd === 'present') {
    return {
      name: 'agent stanza',
      status: 'ok',
      detail:
        'CLAUDE.md managed block present' + (agentsMd === 'present' ? ' (AGENTS.md too)' : ''),
    };
  }
  return {
    name: 'agent stanza',
    status: 'info',
    detail:
      'no managed block in CLAUDE.md — `validity init` adds it; removing the block is respected (re-add with `validity init --force`)',
  };
}

/**
 * Frozen specs whose `runtime` can't be verified on this project's target.
 * Read straight off disk (no spec API) so a malformed spec is skipped rather
 * than turning a diagnostic into a crash.
 */
function specsWithRuntime(cwd: string, runtime: 'web' | 'native'): string[] {
  const dir = resolve(cwd, '.validity/specs');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  try {
    for (const id of readdirSync(dir)) {
      const yaml = resolve(dir, id, 'spec.yaml');
      if (!existsSync(yaml)) continue;
      try {
        if (
          new RegExp(`^runtime:\\s*['"]?${runtime}['"]?\\s*$`, 'm').test(
            readFileSync(yaml, 'utf-8'),
          )
        )
          out.push(id);
      } catch {
        /* unreadable spec — not this check's problem */
      }
    }
  } catch {
    /* unreadable specs dir */
  }
  return out;
}

/**
 * Does the persisted config agree with what this project actually is?
 *
 * The case that matters is a React Native / Expo project whose config still
 * says `renderMode: 'web'` — written before the device became the default,
 * and never rewritten since `validity init` leaves existing configs alone.
 */
export async function validationTargetCheck(cwd: string): Promise<Check> {
  const name = 'validation target';
  let configFramework: string | undefined;
  let renderMode: string | undefined;
  try {
    const { config } = await loadConfig(cwd);
    configFramework = config.framework;
    renderMode = config.renderMode;
  } catch {
    return { name, status: 'info', detail: 'config could not be loaded — skipped' };
  }

  const target = detectAppTarget(cwd, { configFramework });

  if (!target.nativeAvailable) {
    // A web project pinned at native can never render — worth flagging too.
    if (configFramework === 'expo-native' || renderMode === 'native') {
      return {
        name,
        status: 'warn',
        detail:
          `config targets native (renderMode: '${renderMode}', framework: '${configFramework}') but this is a ` +
          `${target.kind} web project with no device path — set renderMode: 'web' and framework: 'auto' in .validity/config.ts.`,
      };
    }
    return { name, status: 'ok', detail: `${target.kind} → web sandbox` };
  }

  if (target.webTargetExplicit) {
    return {
      name,
      status: 'ok',
      detail:
        'React Native project explicitly pinned to Expo Web (react-native-web) — a different ' +
        'runtime than the app ships on, but you asked for it.',
    };
  }

  if (renderMode !== 'native') {
    const staleSpecs = specsWithRuntime(cwd, 'web');
    return {
      name,
      status: 'warn',
      detail:
        `React Native project, but .validity/config.ts still says renderMode: '${renderMode}'. ` +
        "Verify routes to the device anyway, but new specs get stamped `runtime: 'web'` and then fail in " +
        "`validity verify --all`. Fix: set `renderMode: 'native'` and `framework: 'expo-native'` in " +
        '.validity/config.ts' +
        (staleSpecs.length
          ? `, then change \`runtime: web\` → \`runtime: native\` in ${staleSpecs.length} existing spec(s): ${staleSpecs.slice(0, 5).join(', ')}${staleSpecs.length > 5 ? ', …' : ''}.`
          : '.'),
    };
  }

  return { name, status: 'ok', detail: 'React Native project → simulator/emulator' };
}

/* -------------------------------------------------------------------------- */
/* native control-bridge port                                                  */
/* -------------------------------------------------------------------------- */

export interface BridgePortInput {
  /** Processes LISTENING on the bridge port (see probeMetroPortOwners). */
  holders: MetroPortOwner[];
  /** `~/.validity/mcp-runtime.json` — the MCP server this machine last started. */
  mcpStamp: McpRuntimeStamp | null;
  /** This project's root, to tell our own CLI/MCP from another project's. */
  projectRoot: string;
  /** The port checked (default {@link COMPANION_BRIDGE_PORT}). */
  port?: number;
  /** Is `pid` a live process? Injectable for tests. */
  isAlive?: (pid: number) => boolean;
}

/** Command lines that look like a Validity process (CLI, MCP server, or a dev run). */
const VALIDITY_PROCESS_RE = /\bvalidity(-mcp)?\b|validity[/\\](cli|mcp-server)\b|validity\.ai\b/i;

/** Is `cwd` inside `root`? Trailing-slash tolerant, no symlink resolution. */
function isUnder(cwd: string, root: string): boolean {
  const norm = (s: string): string => s.replace(/\/+$/, '');
  return norm(cwd) === norm(root) || norm(cwd).startsWith(`${norm(root)}/`);
}

/**
 * Who owns the native control-bridge port?
 *
 * Port 8083 is a FIXED, single-bind resource shared by the CLI and the MCP
 * server, and that is exactly what makes it dangerous. On 2026-07-29 a
 * validity-mcp process left running from a PREVIOUS DAY still held it with an
 * Android device attached; an iOS run delegated its navigations through that
 * bridge, the Android companion acked every one of them, and the iOS simulator
 * under test never attached a thing. Every criterion came back unverifiable and
 * every other probe read clean — the bridge was healthy, and pointed elsewhere.
 * Nothing in doctor mentioned the port at all.
 *
 * PURE (all I/O is done by the caller) and conservative in the direction that
 * matters: identifying the holder as OURS requires positive evidence (it is the
 * pid the running MCP stamped, or its cwd is inside this project), so an
 * unreadable holder is reported as unknown-and-suspect rather than waved
 * through. The reverse mistake — a clean row over a stale holder — is the bug.
 *
 * Never `fail`: a held port is a warn with a kill hint. `validity doctor` must
 * not exit(1) over a process the developer may have started on purpose.
 */
export function classifyBridgePortHolder(input: BridgePortInput): Check {
  const port = input.port ?? COMPANION_BRIDGE_PORT;
  const alive = input.isAlive ?? isPidAlive;
  const name = 'native: control bridge port';
  const { holders } = input;
  if (holders.length === 0) {
    return { name, status: 'ok', detail: `port ${port} is free — the next run will bind it` };
  }

  const stampPid = input.mcpStamp && alive(input.mcpStamp.pid) ? input.mcpStamp.pid : undefined;
  const describe = (h: MetroPortOwner): string =>
    `pid ${h.pid}${h.command ? ` (${h.command.trim().slice(0, 80)})` : ''}${h.cwd ? ` [cwd ${h.cwd}]` : ''}`;

  const ours = holders.filter(
    (h) =>
      (stampPid !== undefined && (h.pid === stampPid || h.pgid === stampPid)) ||
      (h.cwd !== undefined && isUnder(h.cwd, input.projectRoot)),
  );
  if (ours.length === holders.length) {
    return {
      name,
      status: 'ok',
      detail: `port ${port} held by this project's Validity bridge — ${ours.map(describe).join('; ')}`,
    };
  }

  const foreign = holders.filter((h) => !ours.includes(h));
  const looksValidity = foreign.some((h) => h.command && VALIDITY_PROCESS_RE.test(h.command));
  const what = looksValidity
    ? 'a Validity CLI/MCP process from another session or another project'
    : 'a process Validity did not start';
  return {
    name,
    status: 'warn',
    detail:
      `port ${port} (the native control bridge) is held by ${what}: ${foreign.map(describe).join('; ')}. ` +
      'A stale holder silently misroutes navigations — renders get acked by ITS device while the ' +
      'device under test never attaches, and every criterion comes back unverifiable with nothing ' +
      `pointing here — fix: kill ${foreign.map((h) => h.pid).join(' ')}` +
      (looksValidity ? ', then restart your MCP host' : '') +
      `   # verify with: lsof -ti tcp:${port} -sTCP:LISTEN`,
  };
}

/**
 * `checkNativeReadiness` (packages/native/src/native-readiness.ts) is the
 * same walkthrough `validity browse --native` and `verify --all` run before
 * touching a device — agent-device CLI present/current, a booted simulator/
 * emulator, the companion app installed and fresh, `adb reverse` on Android.
 * Doctor previously never called it, so a stale agent-device / no booted
 * device / missing companion produced a clean doctor while every verify came
 * back `unverifiable` with no diagnostic pointing here.
 *
 * Zero rows on a web-only project (no `nativeAvailable`) or one explicitly
 * pinned to the Expo Web proxy (`webTargetExplicit`) — this is native-only
 * signal, not noise for the common case. A `todo` readiness step maps to
 * `warn`, never `fail`: a powered-off simulator is a nudge, not a reason to
 * exit(1) out of `validity doctor`. Any failure to even determine readiness
 * (config won't load, the native package throws) collapses to a single
 * `info` row instead of crashing doctor — this is a diagnostic, not a gate.
 */
export async function nativeReadinessChecks(
  cwd: string,
  opts: {
    checkReadiness?: typeof checkNativeReadiness;
    /** Command runner for the bridge-port probe (tests inject; never spawns then). */
    run?: CommandRunner;
    /** Skip the bridge-port probe entirely (it shells out to lsof/ps). */
    skipBridgePort?: boolean;
    /** Skip the advisory `agent-device doctor` relay (it shells out). */
    skipAgentDeviceDoctor?: boolean;
    /** Injectable for tests — defaults to the real `agent-device doctor --json` probe. */
    probeDoctor?: typeof probeAgentDeviceDoctor;
  } = {},
): Promise<Check[]> {
  const checkReadiness = opts.checkReadiness ?? checkNativeReadiness;

  let config: Partial<ValidityConfig> | undefined;
  let configError: Error | undefined;
  try {
    config = (await loadConfig(cwd)).config;
  } catch (err) {
    configError = err as Error;
  }

  // Deps-only detection works even without a loaded config (configFramework
  // just refines the Expo-web opt-in decision) — so a missing/broken config
  // still lets us tell a native project from a web one, and a web project
  // never sees a stray "could not be checked" row.
  const target = detectAppTarget(cwd, { configFramework: config?.framework });
  // A `native:` block overrides the Expo-web suppression: a project can pin
  // `framework: 'expo-web'` for its web specs while its native specs still run
  // on a device (the dogfood fixture does exactly this — expo-web pin, native
  // fonts block, 10 native specs) — and a device that verify WILL drive
  // deserves readiness rows, or doctor reads clean while every native verify
  // comes back unverifiable.
  const nativeIntent = config?.native !== undefined;
  if (!target.nativeAvailable || (target.webTargetExplicit && !nativeIntent)) {
    return [];
  }

  if (configError) {
    return [
      {
        name: 'native readiness',
        status: 'info',
        detail: `native readiness could not be checked — ${configError.message}`,
      },
    ];
  }

  try {
    const platform: 'ios' | 'android' = config?.native?.target === 'android' ? 'android' : 'ios';
    // Cheap, write-free (see companionBuildIdentity's own comment) — the same
    // scheme/bundleId/buildHash resolution `verify --all` uses, so doctor's
    // readiness read can never disagree with what verify actually checks.
    const identity = companionBuildIdentity({ projectRoot: cwd, config });
    const readiness = await checkReadiness({
      projectRoot: cwd,
      platform,
      scheme: identity.scheme,
      bundleId: identity.bundleId,
      buildHash: identity.buildHash,
      buildMarkerPath: identity.buildMarkerPath,
      buildInputs: identity.buildInputs,
    });

    const checks: Check[] = readiness.steps.map((step) => ({
      name: `native: ${step.label}`,
      status: step.status === 'ok' ? 'ok' : 'warn',
      detail: step.detail + (step.action ? ` — fix: ${step.action}` : ''),
    }));

    // Who holds the control-bridge port. NOT part of `checkNativeReadiness`
    // (that gate is about reaching a device at all; this is about reaching the
    // RIGHT one), and best-effort: any failure to probe yields no row rather
    // than a scary one, because an unprobeable lsof is not evidence of a stale
    // holder.
    if (!opts.skipBridgePort) {
      try {
        const holders = await probeMetroPortOwners(
          opts.run ?? defaultRunner,
          COMPANION_BRIDGE_PORT,
        );
        checks.push(
          classifyBridgePortHolder({
            holders,
            mcpStamp: readMcpRuntimeStamp(),
            projectRoot: cwd,
          }),
        );
      } catch {
        /* diagnostics are never load-bearing */
      }
    }

    // UPSTREAM'S OWN DIAGNOSTIC, relayed. `agent-device doctor` checks a
    // different surface than `checkNativeReadiness` does — the RN/Expo
    // toolchain, Metro reachability inferred from cwd, the iOS runner cache —
    // and none of it is reachable from Validity's probes. Purely ADVISORY:
    // every row is `info` or `warn`, never `fail`, so nothing here can exit(1)
    // out of `validity doctor` on a judgement Validity did not make. A clean or
    // unreadable doctor prints nothing at all: "upstream is happy" is not
    // evidence that a verify will work, and a row saying so would read as a
    // guarantee.
    if (!opts.skipAgentDeviceDoctor) {
      try {
        const report = await (opts.probeDoctor ?? probeAgentDeviceDoctor)({
          run: opts.run ?? defaultRunner,
          platform,
        });
        for (const finding of report ? doctorFindings(report) : []) {
          checks.push({
            name: `agent-device: ${finding.id}`,
            status: finding.status === 'fail' ? 'warn' : 'info',
            detail:
              `${finding.summary}${finding.hint ? ` — ${finding.hint}` : ''}` +
              `${finding.command ? ` (fix: ${finding.command})` : ''}` +
              ' [advisory: reported by `agent-device doctor`]',
          });
        }
      } catch {
        /* a diagnostic that cannot run is not a finding */
      }
    }

    checks.push({
      name: 'native readiness',
      status: readiness.ready ? 'ok' : 'warn',
      detail: readiness.ready
        ? `all ${readiness.steps.length} steps ready`
        : `blocked at: ${readiness.nextAction?.label ?? 'unmet prerequisite'} — ${
            readiness.nextAction?.action ?? readiness.nextAction?.detail ?? ''
          }`,
    });

    return checks;
  } catch (err) {
    return [
      {
        name: 'native readiness',
        status: 'info',
        detail: `native readiness could not be checked — ${(err as Error).message}`,
      },
    ];
  }
}

export async function runDoctor(
  opts: { cwd?: string; rebuildSignals?: boolean } = {},
): Promise<void> {
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();

  if (opts.rebuildSignals) {
    const result = rebuildSignalsFromHistory(cwd);
    const openAfter = result.rebuilt.filter((s) => s.status === 'open').length;
    const resolvedAfter = result.rebuilt.filter((s) => s.status === 'resolved').length;
    const suppressedAfter = result.rebuilt.filter((s) => s.status === 'suppressed').length;
    process.stdout.write(
      `rebuilt signals.json from history/signals.jsonl\n` +
        `  opened: ${result.opened}  resolved: ${result.resolved}\n` +
        `  now: ${openAfter} open · ${resolvedAfter} resolved · ${suppressedAfter} suppressed\n` +
        `  note: payload fields (hardening proposals, perfKey) of rows older than signals.json are not reconstructed.\n`,
    );
  }

  const checks: Check[] = [];

  // Node version
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js >= 20',
    status: nodeMajor >= 20 ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
  });

  // Attestation key. Printing the PUBLIC half is how a reviewer learns which
  // key to expect from this machine (`attest verify --public-key`); reading it
  // also creates the pair on first run, so the first report is already signed.
  try {
    checks.push({
      name: 'attestation key',
      status: 'ok',
      detail: `${shortId(attestPublicKey())} (${attestKeyPath()})`,
    });
  } catch (err) {
    checks.push({
      name: 'attestation key',
      status: 'warn',
      detail: `could not read or create the signing key (${(err as Error).message}) — reports will be written unsigned`,
    });
  }

  // Git
  try {
    const v = execSync('git --version', { encoding: 'utf-8' }).trim();
    checks.push({ name: 'git available', status: 'ok', detail: v });
  } catch {
    checks.push({
      name: 'git available',
      status: 'warn',
      detail: 'not found — git diff fallback for changed files will be unavailable',
    });
  }

  // Framework
  const framework = detectFramework(cwd);
  checks.push({
    name: `Framework in ${cwd}`,
    status:
      framework === 'vite' || framework === 'expo' || framework === 'next'
        ? 'ok'
        : framework === 'unknown'
          ? 'fail'
          : 'warn',
    detail:
      framework === 'vite'
        ? 'Vite'
        : framework === 'expo'
          ? 'Expo — validated on a simulator/emulator by default; Expo Web (react-native-web) only ' +
            "when you pin framework: 'expo-web'"
          : framework === 'next'
            ? 'Next.js (client components render through the web path)'
            : framework === 'unknown'
              ? 'no framework detected (Validity v1 supports Vite, Expo, and Next.js)'
              : `${framework} (Validity v1 supports Vite, Expo, and Next.js)`,
  });

  // Validity config
  const configCandidates = ['.validity/config.ts', '.validity/config.mts', '.validity/config.js'];
  const config = configCandidates.find((c) => existsSync(resolve(cwd, c)));
  checks.push({
    name: '.validity/config',
    status: config ? 'ok' : 'fail',
    detail: config ? config : 'not found — run `validity init`',
  });

  // Validation target vs. config (the upgrade path). A project configured
  // before RN/Expo defaulted to the device still carries `renderMode: 'web'`,
  // and `validity init` never rewrites an existing config. Interactive verify
  // self-heals (it routes on detection), but the stale value is not harmless:
  // it is what `spec_create` reads to stamp a spec's runtime, so NEW specs are
  // minted as `runtime: 'web'` and then fail in `verify --all`. That failure
  // arrives in CI, far from the cause — so name it here instead.
  if (config) {
    checks.push(await validationTargetCheck(cwd));
  }

  // Agent stanza (Phase A informational line). Never fail/warn — points
  // teammates who never installed Validity at the spec library.
  checks.push(agentStanzaCheck(cwd));

  // Wrapper presence. The `wrapper appropriate` check below also flags
  // wrappers that exist but won't render the project realistically (e.g. a
  // passthrough wrapper in a Redux + Tailwind project).
  //
  // We resolve the wrapper path the same way the runtime does — load the
  // user's config and read the `wrapper` field — instead of probing a
  // hardcoded `.validity/wrapper.tsx`. Since `validity init` defaults to
  // `.validity/wrapper.gen.tsx`, the hardcoded probe was a false-negative
  // on every fresh install. Falls back to the legacy hardcoded candidates
  // when no config is loadable (so we still surface something useful before
  // `validity init` runs).
  let wrapper: string | undefined;
  if (config) {
    try {
      const loaded = await loadConfig(cwd);
      const wrapperRel = loaded.config.wrapper;
      const wrapperAbs = isAbsolute(wrapperRel) ? wrapperRel : resolve(cwd, wrapperRel);
      if (existsSync(wrapperAbs)) {
        wrapper = wrapperRel.startsWith('./') ? wrapperRel.slice(2) : wrapperRel;
      }
    } catch {
      // Config exists but fails to load — surface the legacy probe so the
      // user at least sees the wrapper-file check report something.
    }
  }
  if (!wrapper) {
    const wrapperCandidates = [
      '.validity/wrapper.gen.tsx',
      '.validity/wrapper.tsx',
      '.validity/wrapper.jsx',
    ];
    wrapper = wrapperCandidates.find((c) => existsSync(resolve(cwd, c)));
  }
  checks.push({
    name: 'wrapper component',
    status: wrapper ? 'ok' : 'warn',
    detail: wrapper ?? 'not found — run `validity init` or set wrapper path in config',
  });

  // Wrapper appropriateness. If the project clearly uses providers
  // (Redux/React Query/etc.) or has a global CSS file, but the wrapper is
  // a passthrough, screenshots will be unstyled / context-less. Surface as
  // a warn pointing at `validity init --force`.
  if (wrapper) {
    const shape = detectProjectShape(cwd);
    const needsRealWrapper =
      shape.detectedLibs.some(
        (l) => l.kind === 'state' || l.kind === 'data' || l.kind === 'router',
      ) || Boolean(shape.globalCssFile);
    if (needsRealWrapper && shape.wrapperStatus === 'passthrough') {
      const reasons: string[] = [];
      const stateLibs = shape.detectedLibs.filter((l) => l.kind === 'state').map((l) => l.label);
      const dataLibs = shape.detectedLibs.filter((l) => l.kind === 'data').map((l) => l.label);
      const routerLibs = shape.detectedLibs.filter((l) => l.kind === 'router').map((l) => l.label);
      if (stateLibs.length) reasons.push(`state: ${stateLibs.join(', ')}`);
      if (dataLibs.length) reasons.push(`data: ${dataLibs.join(', ')}`);
      if (routerLibs.length) reasons.push(`router: ${routerLibs.join(', ')}`);
      if (shape.globalCssFile) reasons.push(`global CSS at ${shape.globalCssFile}`);
      checks.push({
        name: 'wrapper appropriate',
        status: 'warn',
        detail:
          `wrapper.tsx is a passthrough but project uses ${reasons.join('; ')}. ` +
          `Run \`validity init --force\` to regenerate a wrapper that mirrors your real entry's providers.`,
      });
    } else if (needsRealWrapper) {
      checks.push({
        name: 'wrapper appropriate',
        status: 'ok',
        detail: 'wrapper.tsx wraps providers / imports global CSS',
      });
    }
  }

  // Derived-state hygiene (W6 #21): scorecard.json + signals.json are now
  // rebuilt per-machine and gitignored. A project onboarded under an older
  // Validity may still be TRACKING them — which reintroduces the merge
  // conflicts + score-loss the derive posture removed. Nudge to untrack.
  const derivedTracked = [scorecardPath(cwd), signalsPath(cwd)].filter(
    (p) => existsSync(p) && gitTracksPath(cwd, p),
  );
  if (derivedTracked.length > 0) {
    const rels = derivedTracked.map((p) => `.validity/${relative(resolve(cwd, '.validity'), p)}`);
    checks.push({
      name: 'derived state untracked',
      status: 'warn',
      detail:
        `${rels.join(' + ')} ${derivedTracked.length === 1 ? 'is' : 'are'} committed but now ` +
        `derived per-machine — run \`git rm --cached ${rels.join(' ')}\` to stop the merge churn (.gitignore already excludes them).`,
    });
  }

  // Legacy plan store (W2 #8): `.validity/plans/` predates the durable spec
  // store. Orphaned plan files linger with no product surface. Point at the
  // spec migration or deletion.
  const legacyPlans = (() => {
    const dir = plansDir(cwd);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  })();
  if (legacyPlans.length > 0) {
    checks.push({
      name: 'legacy plans migrated',
      status: 'warn',
      detail:
        `${legacyPlans.length} legacy plan file(s) in .validity/plans/ (superseded by specs/). ` +
        `Recreate them as specs with \`validity__spec_create\`, then delete the folder — it's already gitignored.`,
    });
  }

  // History posture nudge (W5 #17): with historyCommitted off, the trend
  // timeline is machine-local and lost on re-clone / invisible in CI. If the
  // project has clearly been running (a scorecard exists) but history/ isn't
  // committed, surface the opt-in.
  if (config) {
    let historyCommitted = false;
    try {
      historyCommitted = (await loadConfig(cwd)).config.historyCommitted === true;
    } catch {
      // Config unreadable — the config check above already flags that.
    }
    const hasRun = existsSync(scorecardPath(cwd));
    const historyTracked = gitTracksPath(cwd, scoreHistoryPath(cwd));
    if (hasRun && !historyCommitted && !historyTracked) {
      checks.push({
        name: 'trend history posture',
        status: 'warn',
        detail:
          'score/trend history is machine-local (historyCommitted off) — set `historyCommitted: true` in .validity/config.ts to keep trends across clones and CI (rows are privacy-scrubbed + merge-union).',
      });
    }
  }

  // Playwright Chromium — probe the executable path AND that the binary exists on disk.
  // `executablePath()` returns a string even when the browser hasn't been downloaded,
  // so we have to existsSync() it to know it'll actually launch.
  let playwrightOk = false;
  let playwrightDetail = 'not detected — run `validity install-browser`';
  try {
    const playwright = await import('playwright');
    const exe = playwright.chromium.executablePath?.();
    if (exe && existsSync(exe)) {
      playwrightOk = true;
      playwrightDetail = `installed (${exe})`;
    } else if (exe) {
      playwrightDetail = `path resolved but binary missing — run \`validity install-browser\``;
    }
  } catch {
    // module not installed — playwright is a CLI dep so this should never fire,
    // but the warn message is the same either way.
  }
  checks.push({
    name: 'Playwright Chromium',
    status: playwrightOk ? 'ok' : 'warn',
    detail: playwrightDetail,
  });

  // Validity skill installed (Anthropic Skills format, picked up by Claude Code, Cursor, Codex).
  const home = homedir();
  const skillCandidates = [
    resolve(home, '.claude/skills/validity/SKILL.md'),
    resolve(home, '.cursor/skills/validity/SKILL.md'),
    resolve(home, '.codex/skills/validity/SKILL.md'),
  ];
  const installedSkills = skillCandidates.filter((p) => existsSync(p));
  checks.push({
    name: 'Validity skill installed',
    status: installedSkills.length > 0 ? 'ok' : 'warn',
    detail:
      installedSkills.length > 0
        ? `${installedSkills.length} of ${skillCandidates.length} hosts (~/.claude, ~/.cursor, ~/.codex)`
        : 're-run `validity install-wizard` to drop SKILL.md into ~/.claude/skills/validity/',
  });

  // Claude Code MCP registration. Skip the check entirely if the `claude` CLI isn't
  // on PATH — we don't want to nag users who use Cursor or Codex instead.
  try {
    execSync('command -v claude', { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const list = execSync('claude mcp list', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const registered = /^validity\b/m.test(list);
      checks.push({
        name: 'Claude Code MCP',
        status: registered ? 'ok' : 'warn',
        detail: registered
          ? 'validity MCP registered'
          : 'not registered — run `claude mcp add validity validity-mcp`',
      });
    } catch (err) {
      checks.push({
        name: 'Claude Code MCP',
        status: 'warn',
        detail: `claude mcp list failed (${(err as Error).message.slice(0, 80)})`,
      });
    }
  } catch {
    // claude CLI not installed — skip silently.
  }

  // Running MCP build vs. installed build. After a reinstall, a host that keeps
  // the old MCP process connected serves stale code until it restarts; the
  // server stamps ~/.validity/mcp-runtime.json on startup so we can flag drift.
  {
    const state = classifyMcpRuntime(readMcpRuntimeStamp(), cliVersionString(), isPidAlive);
    const { status, detail } = describeMcpRuntime(state);
    checks.push({ name: 'MCP server (running)', status, detail });
  }

  // Native readiness (React Native / Expo projects only — see
  // nativeReadinessChecks doc comment). Runs the same checklist
  // `validity browse --native` / `verify --all` gate on, so a stale
  // agent-device or missing companion app shows up here instead of only as
  // downstream `unverifiable` verdicts.
  checks.push(...(await nativeReadinessChecks(cwd)));

  let failed = 0;
  const failedNames: string[] = [];
  for (const c of checks) {
    const mark =
      c.status === 'ok'
        ? pc.green('✓')
        : c.status === 'info'
          ? pc.dim('·')
          : c.status === 'warn'
            ? pc.yellow('!')
            : pc.red('✗');
    process.stdout.write(`${mark} ${c.name.padEnd(32)} ${pc.dim(c.detail)}\n`);
    if (c.status === 'fail') {
      failed++;
      failedNames.push(c.name);
    }
  }
  if (failed > 0) {
    process.stdout.write(
      `\n${pc.red('Blocked on:')} ${failedNames.join(', ')}. Fix the failing check(s) above before running validity.\n` +
        pc.dim('Not sure where to start? `validity start` gives you one step at a time.\n'),
    );
    process.exit(1);
  }
}
