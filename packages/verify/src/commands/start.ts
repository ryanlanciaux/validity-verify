/**
 * `validity start` — the post-install runway.
 *
 * Installing Validity leaves a user with a binary, an MCP server, a skill, and
 * no idea what to type. This command is the answer to "ok, now what": it reads
 * the real state of the machine and the current directory, works out which of
 * a handful of setup steps is the FIRST one still outstanding, and prints that
 * one step with the literal command to run. Everything already done collapses
 * to a single ✓ line; everything not yet reachable stays greyed out.
 *
 * Design constraints, learned from watching someone bounce off onboarding:
 *   - Exactly ONE step is live at a time. A menu of everything you could do is
 *     what people bounce off; a single step with an obvious end is not.
 *   - That step offers two labelled paths — a prompt to hand a coding agent,
 *     and the manual commands. Two ways to do ONE thing isn't the kind of
 *     choice that stalls people; it's the kind that unblocks whichever way
 *     they work. Steps a human must do (choosing a directory) show only
 *     the manual path, because an agent prompt that cannot succeed is
 *     worse than no prompt at all.
 *   - Every step is something to paste, not a concept to understand.
 *   - Progress is visible, so re-running after each step feels like movement.
 *   - Nothing is explained before it is needed.
 *
 * `--prompt` ({@link fullSetupPrompt}) is the same content as one hand-off:
 * every remaining step in order, ending in a smoke test.
 *
 * The state → plan mapping is pure ({@link buildStartPlan}) so the ordering
 * rules are unit-testable without a filesystem.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import pc from 'picocolors';
import {
  detectAppTarget,
  loadConfig,
  runsDir,
  listSpecs,
  type AppKind,
} from '@validity.ai/verify-spec';
import { companionBuildIdentity, isCompanionBuildFresh } from '@validity.ai/verify-native';
import { detectWiredHosts } from './install-wizard.js';
import { readInstallMeta } from '../install-meta.js';

export type StepStatus = 'done' | 'current' | 'todo';

/**
 * One numbered instruction in the do-it-yourself path. A `label` of `''` means
 * "just run this" — a single bare command that needs no narration.
 */
export interface ManualStep {
  label: string;
  commands: string[];
}

export interface StartStep {
  /** Stable id — what the step IS, independent of its position in the list. */
  id: 'connect' | 'project' | 'init' | 'retarget' | 'companion' | 'first-run';
  /** Short imperative title, shown on every line. */
  title: string;
  status: StepStatus;
  /** Shown after the title once done — the evidence it's done. */
  doneNote?: string;
  /** Rough time cost, shown only while the step is current. */
  eta: string;
  /**
   * Copy-pasteable instruction for a coding agent. Absent only where a human
   * is genuinely required (choosing a directory) — an agent prompt that
   * can't succeed is worse than none.
   */
  agentPrompt?: string;
  /** The do-it-yourself path. Always populated; the agent path is the option. */
  manual: ManualStep[];
  /**
   * Overrides the heading above {@link manual}. Needed where the manual path
   * isn't the same job done by hand but a different thing entirely — "look
   * around without changing code" is not "run your first check, yourself".
   */
  manualHeading?: string;
  /** One or two sentences: what this does and why. Shown only when current. */
  why: string;
  /** Optional extra line shown under the instructions. */
  hint?: string;
}

export interface StartState {
  /** Display names of coding agents already wired to the MCP server. */
  wiredHosts: string[];
  /** cwd looks like a JS project (package.json present). */
  inProject: boolean;
  /** `.validity/config.ts` (or a sibling) exists in cwd. */
  configured: boolean;
  /** The project has at least one run under `.validity/runs/`. */
  hasRun: boolean;
  /** Detected toolchain, used to phrase the "first check" step. */
  appKind: AppKind;
  /** True when this project validates on a device (React Native / Expo). */
  nativeDefault: boolean;
  /** Matching recorded build hash (not evidence of live device readiness). */
  companionBuilt: boolean;
  /** At least one frozen spec exists (native first-run gate). */
  hasFrozenSpec: boolean;
  /**
   * A React Native project whose existing `.validity/config.ts` still targets
   * the web — written before the device became the default. `validity init`
   * never rewrites an existing config, so this can only be fixed by hand, and
   * it's invisible until `verify --all` fails on a spec stamped `runtime:
   * 'web'`.
   */
  configTargetsWeb: boolean;
  /** cwd, for the `cd` hint. */
  cwd: string;
  /** The binary name this install chose (users may rename it). */
  binName: string;
  /**
   * Host platform. Only iOS Simulator instructions make sense on macOS, so the
   * device step doesn't tell a Linux user to open Xcode.
   */
  platform: NodeJS.Platform;
}

/**
 * How to get a device running, for the platforms this machine can actually
 * reach. Android works everywhere; the iOS Simulator is macOS-only, and
 * offering it elsewhere just sends someone chasing a tool they can't install.
 */
function bootDeviceCommands(platform: NodeJS.Platform): string[] {
  const android = 'emulator -list-avds     # then: emulator -avd <name>';
  if (platform === 'darwin') {
    return ['open -a Simulator             # iOS — needs Xcode', `${android}   # Android`];
  }
  return [android];
}

/**
 * Turn observed state into an ordered checklist with exactly one `current`
 * step — the first unmet one. Steps after it are `todo`; steps before it are
 * `done` regardless of whether they were satisfied in order (someone who ran
 * `validity init` before connecting an agent should not be told to un-init).
 */
export function buildStartPlan(state: StartState): StartStep[] {
  const bin = state.binName;
  const steps: Array<Omit<StartStep, 'status'> & { satisfied: boolean }> = [];

  steps.push({
    id: 'connect',
    title: 'Connect your coding agent',
    satisfied: state.wiredHosts.length > 0,
    doneNote: state.wiredHosts.join(', '),
    eta: '~1 min',
    // The wizard is an interactive picker, so the agent path uses the
    // non-interactive registration its Claude Code branch would have run.
    agentPrompt:
      "Register the Validity MCP server with this machine's coding agent, then confirm it is connected. " +
      'For Claude Code that is `claude mcp add --scope user validity validity-mcp`; for other hosts, ' +
      'add a `validity` server running `validity-mcp` to their MCP config. ' +
      'Then run `validity doctor` and tell me what it reports for the MCP lines.',
    manual: [{ label: '', commands: [`${bin} install-wizard`] }],
    why: 'Registers the Validity MCP server with Claude Code / Cursor / Codex so your agent can call it. The wizard asks which agents you use.',
  });

  steps.push({
    id: 'project',
    title: 'Open your project',
    satisfied: state.inProject,
    doneNote: state.cwd,
    eta: '~5 sec',
    // No agent prompt: only the user knows which directory they meant.
    manual: [{ label: '', commands: ['cd /path/to/your-app'] }],
    why: `There's no package.json in ${state.cwd}, so this isn't an app directory. Everything below runs from your project root.`,
    hint: `Then run \`${bin} start\` again.`,
  });

  steps.push({
    id: 'init',
    title: 'Set up this project',
    satisfied: state.configured,
    doneNote: '.validity/config.ts',
    eta: '~15 sec',
    agentPrompt: setupPrompt(state),
    manual: [{ label: '', commands: [`${bin} init`] }],
    why: "Writes .validity/config.ts and a wrapper that mirrors your app's providers, so Validity can render your components on their own — without running your dev server.",
  });

  // The upgrade path: a project set up before RN/Expo defaulted to the device.
  // Only shown when the config actually disagrees, so nobody who configured
  // this project today ever sees it.
  if (state.nativeDefault && state.configTargetsWeb) {
    steps.push({
      id: 'retarget',
      title: 'Point this project at the device',
      satisfied: false,
      eta: '~1 min',
      agentPrompt:
        'This project was set up before Validity validated React Native on a device. Edit ' +
        ".validity/config.ts: change `renderMode: 'web'` to `renderMode: 'native'` and " +
        "`framework: 'auto'` to `framework: 'expo-native'`. Leave everything else (mocks, " +
        'scenarios, components) exactly as it is. Then check .validity/specs/*/spec.yaml for any ' +
        '`runtime: web` and change those to `runtime: native`, and run `validity doctor` to ' +
        'confirm the validation-target line is clean.',
      manual: [
        {
          label: 'In .validity/config.ts, change these two lines:',
          commands: ["renderMode: 'native' as const,", "framework: 'expo-native' as const,"],
        },
        {
          label:
            'Then in any .validity/specs/*/spec.yaml, change `runtime: web` to `runtime: native`.',
          commands: [],
        },
      ],
      why: "Your config predates the device default, so it still says 'web'. Verify already routes to the simulator regardless — but this value is what stamps a spec's runtime, so new specs would be created as web specs and then fail in `validity verify --all`.",
      hint: `\`${bin} doctor\` confirms it once you've made the change.`,
    });
  }

  // Device projects need a recorded companion build before anything renders.
  // Only surfaced for React Native / Expo; web projects never see this line.
  // The marker records the build hash; it is NOT evidence the companion is live
  // on a device (Metro may be down, device may be detached). The readiness
  // gate in `browse --native` / doctor is authoritative for live readiness.
  //
  // This is the step people got stuck on, so it spells out the whole sequence
  // rather than just naming the command: a simulator has to be booted FIRST
  // (the build has nothing to install onto otherwise), and `browse --native`
  // reports its remaining prerequisites as a checklist you work down.
  if (state.nativeDefault) {
    steps.push({
      id: 'companion',
      title: 'Build the device companion (one time)',
      satisfied: state.companionBuilt,
      doneNote: 'recorded companion build',
      eta: '~3–5 min, once',
      agentPrompt: companionPrompt(state),
      manual: [
        {
          label: 'Boot a simulator or emulator (Validity installs onto a running device):',
          commands: bootDeviceCommands(state.platform),
        },
        {
          label: 'Build + install the companion app:',
          commands: [`${bin} browse --native`],
        },
        {
          label:
            'That prints a readiness checklist for THIS project. Run whatever it asks for (usually a dev-dependency install), then run it again until every line is a ✓.',
          commands: [],
        },
      ],
      why: 'Your app is React Native, so Validity renders it on a real simulator/emulator — the runtime it ships on. The companion is a separate dev app that hosts your components; your own app is never edited or replaced.',
      hint: 'Built once. Later renders reuse it and take seconds.',
    });
  }

  steps.push({
    id: 'first-run',
    title: 'Run your first check',
    satisfied: state.nativeDefault ? state.hasRun && state.hasFrozenSpec : state.hasRun,
    doneNote: 'first run recorded',
    eta: '~30 sec',
    agentPrompt: firstRunPrompt(state),
    manualHeading: 'Not ready to change code yet? Look around first:',
    manual: [{ label: '', commands: [`${bin} browse${state.nativeDefault ? ' --native' : ''}`] }],
    why: 'Validity renders the result and your agent scores the screenshots against what you asked for — that scored run is the thing you are setting up to get.',
  });

  const firstUnmet = steps.findIndex((s) => !s.satisfied);
  return steps.map((s, i) => {
    const { satisfied: _satisfied, ...rest } = s;
    const status: StepStatus =
      firstUnmet === -1 ? 'done' : i < firstUnmet ? 'done' : i === firstUnmet ? 'current' : 'todo';
    return { ...rest, status };
  });
}

/** The sentence to paste at your agent, phrased for the detected toolchain. */
export function firstRunPrompt(state: StartState): string {
  if (state.nativeDefault) {
    return 'Plan a spec with a meaningful criterion that includes at least one hard/mechanical check (soft criteria are skipped by verify --all), verify the existing UI and show the screenshot/verdict, then freeze that spec via validity__plan freeze:true or validity spec freeze <id>, then validity verify --all.';
  }
  return 'Add a logout button to the header, then verify it with Validity and show me the screenshot and the verdict.';
}

/** Configure-this-project prompt: what `validity init` does, plus its aftermath. */
function setupPrompt(state: StartState): string {
  const lines = [
    'Set up Validity in this project. Run `validity init`, then tell me what it wrote.',
    'If it prints anything under "Manual steps required", walk me through those —',
  ];
  if (state.nativeDefault) {
    lines.push(
      'they usually mean a provider it could not clone. Native isolation reuses',
      '.validity/wrapper.gen.tsx (do not edit it). Customize .validity/wrapper.native.tsx',
      'to override — import gen if you still want the cloned providers.',
      '',
      'This is a React Native app, so the generated config pins it to a',
      "simulator/emulator (renderMode 'native'). Leave it that way — do not switch",
      "it to the react-native-web target ('expo-web') to avoid a device build.",
    );
  } else {
    lines.push(
      'they usually mean a provider it could not clone automatically, which goes in',
      '.validity/wrapper.user.tsx.',
    );
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

/** Device-companion prompt — the step that has the most ways to go sideways. */
function companionPrompt(state: StartState): string {
  const ios = state.platform === 'darwin' ? 'an iOS simulator or ' : '';
  return [
    `Set up Validity's React Native companion app in this project.`,
    `First make sure ${ios}an Android emulator is actually booted — the build installs onto a running device.`,
    'Then run `validity browse --native`. It prints a readiness checklist for this project;',
    'work down it, running whatever it asks for (usually a dev-dependency install),',
    'and re-run the command until every line passes.',
    'Do NOT switch to the Expo Web / react-native-web target to get around a device or build problem —',
    'that renders a different runtime than the app ships on. If something needs me (Xcode, an Android SDK,',
    'a device image), stop and tell me exactly what.',
  ].join(' ');
}

/**
 * The whole remaining setup as ONE prompt to hand an agent, ending in a smoke
 * test. Printed by `validity start --prompt`. Only the outstanding steps go in
 * — telling an agent to redo work that's already done invites it to "fix"
 * things that were fine.
 */
export function fullSetupPrompt(state: StartState, steps: StartStep[]): string {
  const pending = steps.filter((s) => s.status !== 'done');
  const out: string[] = [
    'Help me finish setting up Validity in this project. Validity renders my UI and scores it against what I asked for, so I can check your work instead of taking it on faith.',
    '',
  ];

  const numbered: string[] = [];
  for (const s of pending) {
    if (s.id === 'first-run') {
      numbered.push(
        `Smoke test: ${firstRunPrompt(state)} Treat a failing or unverifiable criterion as a real result — tell me about it, don't paper over it.`,
      );
    } else if (s.agentPrompt) {
      numbered.push(s.agentPrompt);
    } else {
      // Steps only I can do (picking a directory) — the agent needs to know
      // they're blocking rather than silently skip them.
      numbered.push(
        `I have to do this one myself: ${s.title.toLowerCase()} (\`${s.manual[0]?.commands[0] ?? ''}\`). If it isn't done yet, stop and tell me.`,
      );
    }
  }

  out.push(...numbered.map((t, i) => `${i + 1}. ${t}`));
  out.push('', 'Work through them in order and stop at anything that needs me.');
  return out.join('\n');
}

/**
 * Wrap prose to a fixed width with a fixed indent. Terminal-width detection is
 * deliberately skipped — the checklist should look the same everywhere, and a
 * step whose explanation reflows differently per window is harder to re-scan
 * after each re-run.
 */
function wrap(text: string, indent = '  ', width = 76): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (indent + line + ' ' + word).length > width) {
      out.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(indent + line);
  return out;
}

/** Renders the plan. Returns lines so tests can assert on shape, not colour. */
export function renderStartPlan(state: StartState, steps: StartStep[]): string[] {
  const lines: string[] = [];
  const done = steps.filter((s) => s.status === 'done').length;
  const current = steps.find((s) => s.status === 'current');

  lines.push(pc.bold('Validity') + pc.dim(' — verify what your agent claimed to build.'));
  lines.push('');

  for (const [i, s] of steps.entries()) {
    const n = i + 1;
    if (s.status === 'done') {
      lines.push(
        `  ${pc.green('✓')} ${n}. ${s.title}${s.doneNote ? pc.dim(`  — ${s.doneNote}`) : ''}`,
      );
    } else if (s.status === 'current') {
      lines.push(`  ${pc.cyan('▶')} ${pc.bold(`${n}. ${s.title}`)}   ${pc.dim(`(${s.eta})`)}`);
    } else {
      lines.push(pc.dim(`    ${n}. ${s.title}`));
    }
  }
  lines.push('');

  if (!current) {
    // Everything's set up — hand over the day-to-day loop instead of a step.
    lines.push(pc.green(pc.bold("You're set up.")) + ' Three things to do next:');
    lines.push('');
    lines.push(
      `  1. ${pc.cyan(`${state.binName} verify --all`)}   ${pc.dim('— re-run frozen hard checks')}`,
    );
    lines.push(
      `  2. ${pc.cyan(`${state.binName} browse${state.nativeDefault ? ' --native' : ''}`)}   ${pc.dim('— poke at your components yourself')}`,
    );
    lines.push(
      `  3. ${pc.dim('Keep asking your agent to verify UI changes — that’s the whole loop.')}`,
    );
    lines.push('');
    lines.push(pc.dim(`Something looks off? \`${state.binName} doctor\`.`));
    return lines;
  }

  lines.push(pc.dim('─'.repeat(60)));
  lines.push(pc.bold(`Do this now — step ${steps.indexOf(current) + 1}: ${current.title}`));
  lines.push('');

  // Two labelled paths, agent first. It's one action either way — the label
  // exists so nobody has to work out for themselves whether their agent could
  // have handled it. Steps with no agent path (choosing a directory)
  // simply skip that block rather than offer a prompt that fails.
  const bothPaths = Boolean(current.agentPrompt);
  if (current.agentPrompt) {
    lines.push(`  ${pc.bold('Paste this to your coding agent:')}`);
    lines.push('');
    for (const l of wrap(current.agentPrompt, '    ', 78)) lines.push(pc.cyan(l));
    lines.push('');
  }

  const manualHeading = current.manualHeading ?? (bothPaths ? 'Or do it yourself:' : 'Run this:');
  const numbered = current.manual.length > 1;
  if (current.manual.some((m) => m.label || m.commands.length)) {
    lines.push(`  ${pc.bold(manualHeading)}`);
    lines.push('');
    for (const [i, m] of current.manual.entries()) {
      if (m.label) {
        const prefix = numbered ? `  ${i + 1}. ` : '  ';
        const body = wrap(m.label, '', 70);
        lines.push(pc.dim(prefix + body[0]));
        for (const cont of body.slice(1)) lines.push(pc.dim('     ' + cont));
      }
      for (const c of m.commands) lines.push(`     ${pc.cyan(c)}`);
    }
    lines.push('');
  }

  for (const l of wrap(current.why)) lines.push(pc.dim(l));
  if (current.hint) for (const l of wrap(current.hint)) lines.push(pc.dim(l));

  lines.push('');
  lines.push(
    pc.dim(
      `${done}/${steps.length} done · re-run \`${state.binName} start\` after each step to pick up where you left off.`,
    ),
  );
  // The all-at-once escape hatch, mentioned but not inlined — a wall of prompt
  // above the current step would bury the one action this screen is for.
  if (steps.some((s) => s.status !== 'done' && s.agentPrompt)) {
    lines.push(
      pc.dim(
        `Rather hand the whole thing to your agent? \`${state.binName} start --prompt\` prints one prompt for every remaining step, ending in a smoke test.`,
      ),
    );
  }
  return lines;
}

/** Read the machine + project state the plan is built from. */
export async function readStartState(cwd: string): Promise<StartState> {
  const binName = readInstallMeta()?.binaryName || 'validity';

  const wired = detectWiredHosts(binName, { home: homedir() });
  const hostLabels: Record<keyof typeof wired, string> = {
    claude: 'Claude Code',
    cursor: 'Cursor',
    opencode: 'OpenCode',
    codex: 'Codex',
  };
  const wiredHosts = (Object.keys(wired) as Array<keyof typeof wired>)
    .filter((h) => wired[h])
    .map((h) => hostLabels[h]);

  const configured = ['.validity/config.ts', '.validity/config.mts', '.validity/config.js'].some(
    (c) => existsSync(resolve(cwd, c)),
  );

  let configFramework: string | undefined;
  let configRenderMode: string | undefined;
  let loadedConfig: import('@validity.ai/verify-spec').ValidityConfig | undefined;
  if (configured) {
    try {
      const loaded = await loadConfig(cwd);
      loadedConfig = loaded.config;
      configFramework = loadedConfig.framework;
      configRenderMode = loadedConfig.renderMode;
    } catch {
      // Unreadable config — detection alone decides the target.
    }
  }
  const appTarget = detectAppTarget(cwd, { configFramework });

  let companionBuilt = false;
  if (appTarget.recommended === 'native' && configured && loadedConfig) {
    try {
      const identity = companionBuildIdentity({ projectRoot: cwd, config: loadedConfig });
      companionBuilt = isCompanionBuildFresh(identity.buildMarkerPath, identity.buildHash);
    } catch {
      companionBuilt = false;
    }
  }

  let hasFrozenSpec = false;
  try {
    hasFrozenSpec = listSpecs(cwd).some((s) => s.status === 'frozen');
  } catch {
    hasFrozenSpec = false;
  }

  return {
    wiredHosts,
    inProject: existsSync(resolve(cwd, 'package.json')),
    configured,
    hasRun: hasAnyRun(cwd),
    appKind: appTarget.kind,
    nativeDefault: appTarget.recommended === 'native',
    companionBuilt,
    hasFrozenSpec,
    // Only meaningful once a config exists AND detection says device: a config
    // that explicitly pinned Expo Web already flipped `recommended` to web, so
    // it never reads as stale.
    configTargetsWeb:
      configured && appTarget.recommended === 'native' && configRenderMode !== 'native',
    cwd,
    binName,
    platform: process.platform,
  };
}

function hasAnyRun(cwd: string): boolean {
  const dir = runsDir(cwd);
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((e) => !e.startsWith('.'));
  } catch {
    return false;
  }
}

export async function runStart(opts: { cwd?: string; prompt?: boolean } = {}): Promise<void> {
  const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
  const state = await readStartState(cwd);
  const steps = buildStartPlan(state);

  // `--prompt` prints the prompt and NOTHING else — no banner, no checklist,
  // no colour. Its whole job is to be selected and pasted, and anything else
  // in the buffer comes along for the ride.
  if (opts.prompt) {
    if (steps.every((s) => s.status === 'done')) {
      process.stdout.write(
        `Validity is already set up in ${cwd} — nothing left to hand off.\n` +
          `Ask your agent for a UI change and to verify it with Validity.\n`,
      );
      return;
    }
    process.stdout.write(fullSetupPrompt(state, steps) + '\n');
    return;
  }

  process.stdout.write(renderStartPlan(state, steps).join('\n') + '\n');
}
