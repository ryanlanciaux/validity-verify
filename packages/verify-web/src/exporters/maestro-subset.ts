/**
 * The 0.20.5 Maestro-engine SUBSET LINT — "would this exported flow even run?"
 *
 * agent-device 0.20.5 ships a real Maestro-subset engine (`agent-device test
 * <path> --maestro` / `replay <flow.yaml> --maestro`). It is a SUBSET: the
 * engine "fails loudly rather than skipping" on anything it doesn't implement,
 * which means a flow carrying one unsupported command doesn't degrade — the
 * whole run aborts at parse time. That failure mode is exactly the kind of
 * thing Validity must surface at EXPORT time, not as a runtime surprise on
 * someone's device an hour later.
 *
 * So this module lints the EMITTED BYTES (not the spec) against the subset and
 * returns ordinary {@link ExportWarning}s. Because export warnings already gate
 * the portable badge and `spec export --all` eligibility, "an export that
 * cannot run does not certify" needs no new gate: an out-of-subset command is a
 * `wont-run` warning like any other degradation.
 *
 * WHY BYTES, NOT THE SPEC. Every other collector in `spec-export-warnings.ts`
 * carries an explicit "MUST be the same value the exporter computed" contract,
 * because a spec-shaped predicate can silently drift from the emitter. Linting
 * the emitter's own output removes that class of bug entirely: there is nothing
 * to keep in sync. It also means a HAND-EDITED committed flow (the `--dry-run`
 * case) is checked against the same rules as a fresh compile.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE OF THE TABLES BELOW
 * ---------------------------------------------------------------------------
 * Read off `agent-device help maestro` (0.20.5) AND cross-checked against the
 * installed 0.20.5 engine's own parser tables, so the lint agrees with the
 * binary rather than with the prose:
 *
 *   - the command dispatch table (`Maestro command "<x>" is not supported.`)
 *     → {@link MAESTRO_SUPPORTED_COMMANDS};
 *   - the per-command field allow-lists the parser enforces
 *     → {@link COMMAND_FIELDS};
 *   - the flow-config header keys → {@link CONFIG_KEYS};
 *   - the documented BOUNDARIES (repeat.while / evalScript / broader JS
 *     unsupported; launch arguments Apple-only; runScript is not a sandbox)
 *     → {@link boundaryFinding}.
 *
 * Anything the engine accepts but only on some platforms is `degraded`, never
 * `wont-run` — it parses, so the flow still runs; only its meaning narrows.
 *
 * NO CRY-WOLF. Validity's own Maestro exporter emits exactly `launchApp`,
 * `runFlow`, `tapOn`, `inputText`, `assertVisible`, `assertNotVisible`,
 * `takeScreenshot`, `openLink` and `back` — every one inside the subset with
 * in-subset fields — so a well-formed Validity export MUST lint clean. A
 * warning here always means someone (a future exporter change, or a hand edit)
 * put something in the file the engine will refuse.
 *
 * The scanner is deliberately LINE-ORIENTED rather than a YAML parse: it must
 * report a line number (the engine's own refusals carry source context, and a
 * warning a user can't locate is half a warning), it must survive the `# TODO
 * (lossy)` comment lines the exporter emits inside step blocks, and it must not
 * add a YAML dependency to this package. Block scalars are skipped wholesale so
 * their contents can never be mistaken for steps.
 */
import type { ExportWarning } from './spec-export-warnings.js';

/**
 * Every command the 0.20.5 engine implements. A `- <name>` outside this set is
 * a hard parse-time refusal (`Maestro command "<name>" is not supported.`),
 * which aborts the entire flow — hence `wont-run`.
 */
export const MAESTRO_SUPPORTED_COMMANDS: readonly string[] = [
  'launchApp',
  'stopApp',
  'openLink',
  'tapOn',
  'doubleTapOn',
  'longPressOn',
  'inputText',
  'eraseText',
  'hideKeyboard',
  'pressKey',
  'back',
  'swipe',
  'scroll',
  'scrollUntilVisible',
  'waitForAnimationToEnd',
  'takeScreenshot',
  'assertVisible',
  'assertNotVisible',
  'extendedWaitUntil',
  'runScript',
  'runFlow',
  'repeat',
  'retry',
];

/** Flow-config keys legal ABOVE the `---` separator. */
const CONFIG_KEYS: readonly string[] = [
  'name',
  'appId',
  'tags',
  'env',
  'onFlowStart',
  'onFlowComplete',
];

/** The selector keys a target mapping may carry (shared by tap-shaped verbs). */
const SELECTOR_KEYS = ['id', 'text', 'enabled', 'selected'] as const;

/**
 * Per-command field allow-lists, keyed by command. ONLY commands whose parser
 * allow-list was read off the 0.20.5 engine appear here; every other supported
 * command is checked by NAME only. That asymmetry is deliberate: inventing an
 * allow-list from prose would produce false `wont-run` warnings on syntax the
 * engine actually accepts, and a cry-wolf warning that blocks the portable
 * badge is worse than a missing one (the engine still fails loudly at run time,
 * and {@link classifyMaestroRun}'s `unsupported` verdict catches it there).
 */
const COMMAND_FIELDS: Record<string, readonly string[]> = {
  launchApp: ['appId', 'stopApp', 'clearState', 'arguments', 'launchArguments'],
  tapOn: [
    ...SELECTOR_KEYS,
    'point',
    'retryTapIfNoChange',
    'repeat',
    'delay',
    'optional',
    'index',
    'childOf',
    'label',
  ],
  doubleTapOn: [
    ...SELECTOR_KEYS,
    'point',
    'retryTapIfNoChange',
    'repeat',
    'delay',
    'optional',
    'index',
    'childOf',
    'label',
  ],
  inputText: ['text', 'label'],
  openLink: ['link'],
  assertVisible: ['id', 'text', 'enabled', 'selected', 'optional', 'childOf'],
  assertNotVisible: ['id', 'text', 'enabled', 'selected', 'optional', 'childOf'],
  extendedWaitUntil: ['visible', 'notVisible', 'timeout', 'optional'],
  scrollUntilVisible: ['element', 'direction', 'timeout', 'optional'],
  swipe: ['start', 'end', 'direction', 'duration', 'from', 'label', 'optional'],
  runFlow: ['file', 'commands', 'env', 'when', 'label'],
};

/** `runFlow.when` sub-keys the engine's condition parser accepts. */
const WHEN_KEYS: readonly string[] = ['platform', 'visible', 'notVisible', 'true'];

/** Commands whose `commands:` field holds a nested step sequence. */
const NESTS_COMMANDS = new Set(['runFlow', 'repeat', 'retry']);

/* ------------------------------------------------------------------ *
 * The scanner.                                                         *
 * ------------------------------------------------------------------ */

/** One scanned line's shape, after comments/blank/block-scalar filtering. */
interface ScanLine {
  /** 1-based line number in the source flow. */
  line: number;
  indent: number;
  /** Set when the line opens a step (`- tapOn:` / `- back`). */
  step?: string;
  /** Set when the line is a mapping key (`text: "Send"` / `when:`). */
  key?: string;
  /** The raw text after `key:` / `- step:`, trimmed (may be ''). */
  value: string;
}

const STEP_RE = /^(\s*)-\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(.*))?$/;
const KEY_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/;
const BLOCK_SCALAR_RE = /^[|>][+-]?\d*$/;

/** Config keys whose VALUE is a command list, not a scalar — linted as steps. */
const COMMAND_LIST_CONFIG_KEYS = new Set(['onFlowStart', 'onFlowComplete']);

interface Scanned {
  /** Top-level (indent 0) keys above the `---`. */
  config: ScanLine[];
  /** Steps + fields under `onFlowStart` / `onFlowComplete`, above the `---`. */
  configCommands: ScanLine[];
  /** Everything below the `---`. */
  body: ScanLine[];
  sawSeparator: boolean;
}

/**
 * Split a flow into its linted regions. Full-line comments, blanks, and the
 * bodies of block scalars are dropped — a block scalar's contents are user data
 * (a script body, a long string) and must never be read as structure.
 *
 * Sequence items above the `---` are scalars for most config keys (`tags: [-
 * smoke]`) but COMMANDS for `onFlowStart`/`onFlowComplete`, so they are routed
 * apart: linting a tag as a Maestro command would be a spectacular cry-wolf.
 */
function scan(yaml: string): Scanned {
  const config: ScanLine[] = [];
  const configCommands: ScanLine[] = [];
  const body: ScanLine[] = [];
  let sawSeparator = false;
  /** The last indent-0 config key — decides how its nested lines are read. */
  let configKey: string | null = null;
  /** When set, every line indented deeper than this belongs to a block scalar. */
  let blockScalarIndent: number | null = null;

  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    const indent = raw.length - raw.trimStart().length;

    if (blockScalarIndent !== null) {
      if (trimmed === '' || indent > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === '---' || trimmed === '...') {
      // The FIRST separator ends the config document; later ones (multi-doc
      // flows) are structural noise for our purposes.
      sawSeparator = true;
      continue;
    }

    const stepMatch = STEP_RE.exec(raw);
    if (stepMatch) {
      const value = (stepMatch[3] ?? '').trim();
      if (BLOCK_SCALAR_RE.test(value)) blockScalarIndent = indent;
      const entry: ScanLine = { line: i + 1, indent, step: stepMatch[2]!, value };
      if (sawSeparator) body.push(entry);
      else if (configKey && COMMAND_LIST_CONFIG_KEYS.has(configKey)) configCommands.push(entry);
      continue;
    }
    const keyMatch = KEY_RE.exec(raw);
    if (keyMatch) {
      const value = keyMatch[3]!.trim();
      if (BLOCK_SCALAR_RE.test(value)) blockScalarIndent = indent;
      const entry: ScanLine = { line: i + 1, indent, key: keyMatch[2]!, value };
      if (sawSeparator) body.push(entry);
      else if (indent === 0) {
        config.push(entry);
        configKey = entry.key!;
      } else if (configKey && COMMAND_LIST_CONFIG_KEYS.has(configKey)) {
        configCommands.push(entry);
      }
      continue;
    }
    // Sequence items that are bare scalars (`- "Continue"`), inline flow
    // mappings, and anything else are not structure we lint.
  }
  return { config, configCommands, body, sawSeparator };
}

/* ------------------------------------------------------------------ *
 * Findings.                                                            *
 * ------------------------------------------------------------------ */

/** Scope prefix so a reader can jump straight to the offending line. */
function at(line: number, what: string): string {
  return `flow line ${line} (${what})`;
}

/**
 * The documented 0.20.5 BOUNDARIES that are not expressible as a name/field
 * allow-list. Returns a warning when `key` under `command` crosses one.
 */
function boundaryFinding(command: string, key: string, line: number): ExportWarning | null {
  if (command === 'repeat' && key === 'while') {
    return {
      scope: at(line, 'repeat.while'),
      severity: 'wont-run',
      message:
        `\`repeat.while\` is outside the agent-device 0.20.5 Maestro subset (only ` +
        `\`repeat.times\` is supported) — the engine refuses the flow at parse time, so ` +
        `nothing in it runs. Use \`repeat.times\`, or drive the loop from the spec.`,
    };
  }
  if (command === 'launchApp' && (key === 'launchArguments' || key === 'arguments')) {
    return {
      scope: at(line, `launchApp.${key}`),
      severity: 'degraded',
      message:
        `launch arguments are Apple-only in the agent-device 0.20.5 Maestro engine — ` +
        `the flow still runs on Android, but this argument is ignored there, so the ` +
        `Android run is not asserting what the iOS run asserts.`,
    };
  }
  return null;
}

/** One `runFlow.when.true` term: a boolean literal or a platform comparison. */
const WHEN_TRUE_TERM = /^(true|false|maestro\.platform\s*[=!]=\s*["'][^"']*["'])$/;

/**
 * `runFlow.when.true` accepts boolean literals and `maestro.platform`
 * comparisons joined by `&&`/`||` — nothing else. Parenthesised grouping is
 * tolerated; anything with a JS call, member access, or `evalScript` is not.
 */
function whenTrueFinding(value: string, line: number): ExportWarning | null {
  // Unwrap ONLY a fully-quoted scalar. A naive strip would eat the closing
  // quote of `maestro.platform == "ios"` and make a legal expression look
  // illegal — the cry-wolf that would block a perfectly good flow.
  const trimmed = value.trim();
  const quoted = /^"(.*)"$/.exec(trimmed) ?? /^'(.*)'$/.exec(trimmed);
  const expr = (quoted?.[1] ?? trimmed).trim();
  if (expr === '') return null;
  const terms = expr
    .split(/\|\||&&/)
    .map((t) => t.replace(/[()]/g, '').trim())
    .filter((t) => t !== '');
  if (terms.length > 0 && terms.every((t) => WHEN_TRUE_TERM.test(t))) return null;
  return {
    scope: at(line, 'runFlow.when.true'),
    severity: 'wont-run',
    message:
      `\`runFlow.when.true\` only supports boolean literals and \`maestro.platform\` ` +
      `comparisons in the agent-device 0.20.5 subset — \`evalScript\` and broader ` +
      `JavaScript expressions are unsupported and the engine refuses the whole flow. ` +
      `Express the condition as \`when.visible\` / \`when.platform\` instead.`,
  };
}

/**
 * Lint an exported Maestro flow against the agent-device 0.20.5 supported
 * subset. PURE — text in, warnings out; no device, no filesystem.
 *
 * Returns `[]` for a flow the engine will accept. Every warning names a line so
 * the user can open the file at the exact spot the engine would refuse.
 */
export function lintMaestroSubset(yaml: string): ExportWarning[] {
  const warnings: ExportWarning[] = [];
  const { config, configCommands, body, sawSeparator } = scan(yaml);

  if (!sawSeparator) {
    warnings.push({
      scope: 'flow document',
      severity: 'wont-run',
      message:
        `the flow has no \`---\` separator between its config header and its command ` +
        `list — Maestro (and the agent-device 0.20.5 engine) cannot tell the two apart, ` +
        `so the file does not parse as a flow. Regenerate with \`validity spec export\`.`,
    });
  }

  // Without a separator EVERY line landed in `config`; flagging each of them as
  // a bad config key would bury the one finding that matters (above).
  for (const entry of sawSeparator ? config : []) {
    if (entry.indent !== 0) continue; // nested config values, not header keys
    if (CONFIG_KEYS.includes(entry.key!)) continue;
    warnings.push({
      scope: at(entry.line, `config key \`${entry.key}\``),
      severity: 'wont-run',
      message:
        `\`${entry.key}\` is not a flow-config key the agent-device 0.20.5 Maestro engine ` +
        `accepts (supported: ${CONFIG_KEYS.join(', ')}) — it refuses the flow at parse ` +
        `time rather than ignoring the key.`,
    });
  }

  // `onFlowStart`/`onFlowComplete` hold real command lists; they run on the
  // device exactly like the main sequence and so face the same subset.
  warnings.push(...walkCommands(configCommands));
  warnings.push(...walkCommands(body));

  return warnings;
}

/**
 * Walk one command sequence, checking command names, field allow-lists, and the
 * documented boundaries. Each sequence gets its OWN stack — a config command
 * list and the main flow are independent regions and must not nest into each
 * other through indentation coincidence.
 */
function walkCommands(entries: ScanLine[]): ExportWarning[] {
  const warnings: ExportWarning[] = [];
  /**
   * Enclosing-command stack. A step at indent N owns every deeper key line
   * until a line at indent <= N; `commands:` re-enters step context, so nested
   * `- tapOn:` inside a `runFlow` is linted as a command, not as a field.
   */
  const stack: Array<{ indent: number; command: string; field?: string }> = [];

  for (const entry of entries) {
    while (stack.length > 0 && entry.indent <= stack[stack.length - 1]!.indent) stack.pop();
    const parent = stack[stack.length - 1];

    if (entry.step) {
      const name = entry.step;
      if (!MAESTRO_SUPPORTED_COMMANDS.includes(name)) {
        warnings.push({
          scope: at(entry.line, name),
          severity: 'wont-run',
          message:
            `\`${name}\` is outside the agent-device 0.20.5 Maestro subset — the engine ` +
            `fails loudly on unsupported commands rather than skipping them, so the ENTIRE ` +
            `flow refuses to run (nothing in it is asserted). Supported commands: ` +
            `${MAESTRO_SUPPORTED_COMMANDS.join(', ')}. Run \`agent-device help maestro\` for ` +
            `the boundaries.`,
        });
      }
      if (name === 'runScript') {
        warnings.push({
          scope: at(entry.line, 'runScript'),
          severity: 'needs-setup',
          message:
            `\`runScript\` executes a TRUSTED script and may make \`http.post\` network ` +
            `requests — the agent-device 0.20.5 engine states plainly that it is not a ` +
            `security sandbox. Review the script before running this flow in CI.`,
        });
      }
      stack.push({ indent: entry.indent, command: name });
      continue;
    }

    if (!entry.key || !parent) continue;

    // Inside `commands:` the children are STEPS, handled by the branch above.
    if (parent.field === 'commands') continue;

    if (parent.field === 'when' && parent.command === 'runFlow') {
      if (!WHEN_KEYS.includes(entry.key)) {
        warnings.push({
          scope: at(entry.line, `runFlow.when.${entry.key}`),
          severity: 'wont-run',
          message:
            `\`when.${entry.key}\` is not a condition the agent-device 0.20.5 Maestro engine ` +
            `evaluates (supported: ${WHEN_KEYS.join(', ')}) — it refuses the flow rather ` +
            `than ignoring the condition.`,
        });
      }
      if (entry.key === 'true') {
        const finding = whenTrueFinding(entry.value, entry.line);
        if (finding) warnings.push(finding);
      }
      continue;
    }

    // A direct child of a command.
    const boundary = boundaryFinding(parent.command, entry.key, entry.line);
    if (boundary) warnings.push(boundary);

    const allowed = COMMAND_FIELDS[parent.command];
    if (allowed && !allowed.includes(entry.key) && !boundary) {
      warnings.push({
        scope: at(entry.line, `${parent.command}.${entry.key}`),
        severity: 'wont-run',
        message:
          `\`${parent.command}\` has no \`${entry.key}\` field in the agent-device 0.20.5 ` +
          `Maestro subset (supported: ${allowed.join(', ')}) — unsupported fields fail with ` +
          `source context instead of being ignored, so the whole flow refuses to run.`,
      });
    }

    // Descend: `when:` and `commands:` open a new context for their children.
    if (entry.key === 'when' || (entry.key === 'commands' && NESTS_COMMANDS.has(parent.command))) {
      stack.push({ indent: entry.indent, command: parent.command, field: entry.key });
    }
  }

  return warnings;
}
