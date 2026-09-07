/**
 * agent-device driver — the device-automation layer for the native
 * playground (browse + verify on a simulator/emulator).
 *
 * We use Callstack's `agent-device` (MIT, github.com/callstackincubator/
 * agent-device) for what it documents and is uniquely good at: capturing a
 * **screenshot** and an **accessibility snapshot** (a semantic UI tree the
 * agent scores against — the native analog of Validity's web DOM inspector).
 *
 * For *opening the target* we drive the rock-solid platform CLIs
 * (`xcrun simctl openurl` / `adb … VIEW -d <url>`) via the verified deep-link
 * builder, rather than agent-device's open-URL form (whose exact syntax is
 * deferred to the in-CLI `agent-device help workflow`). Every subcommand is
 * overridable (see {@link AgentDeviceOptions.commands}) so you can realign it
 * once you've confirmed the CLI surface — and the command runner is
 * injectable, so the whole driver is unit-testable without a device.
 */
import { isAbsolute, resolve as resolvePath } from 'node:path';
import {
  buildDevClientLoadUrl,
  buildTargetUrl,
  type NativeTarget,
  type TargetSpec,
} from './deep-link.js';
import {
  diagnoseNativeEnvironment,
  NO_SESSION_SIGNATURE,
  parseInUseSessionName,
  type EnvironmentDiagnosis,
} from './environment-diagnosis.js';
import {
  noteCommandCost,
  noteDeviceOpen,
  parseAgentDeviceEventsJson,
  type AgentDeviceEvent,
} from './session-metrics.js';
import {
  armRecordingFlags,
  classifyAgentDeviceReplay,
  classifyRecordingPublish,
  destinationGuardArgs,
  fillRecordingFlags,
  isFreshSessionArmRefusal,
  publishRecordingArgs,
  replayRecordingArgs,
  NO_RECORD_FLAG,
  type AgentDeviceReplayResult,
  type RecordingPublication,
  type ReplayInvocation,
  type ResolvedSecret,
} from './replay-recording.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /**
   * Best-effort cause, attached ONLY on the failure path where both
   * `agent-device open` and the platform-CLI fallback failed (see
   * openUrlWithNativeFallback). Purely additive metadata so a caller can tell
   * the developer WHICH environment problem swallowed the run instead of
   * reporting "no mechanical verdict produced"; nothing branches on it, and its
   * absence means "could not tell", never "the environment is fine".
   */
  diagnosis?: EnvironmentDiagnosis;
  /**
   * The SETTLED DIFF a `--settle` mutation returned in its own response (see
   * {@link SettleObservation}). Purely additive evidence: absent means the
   * command did not carry `--settle`, printed no readable envelope, or upstream
   * declined to settle — never "nothing changed".
   */
  settle?: SettleObservation;
  /**
   * `cost.wallClockMs` out of a `--cost` response — the DAEMON's own measure of
   * this command, excluding Node spawn and host scheduling. Additive
   * instrumentation only (folded into session-metrics); absence means the
   * command did not ask for cost or its envelope was unreadable.
   */
  costMs?: number;
}

export interface RunOptions {
  cwd?: string;
  /** Extra env vars merged over process.env (e.g. AGENT_DEVICE_PLATFORM, CI). */
  env?: Record<string, string>;
  /**
   * Host-side wall-clock bound on the spawned process. Defaults to
   * {@link DEFAULT_COMMAND_TIMEOUT_MS}; pass `0` to disable it entirely (no
   * caller does today — see that constant for why nothing here legitimately
   * runs unbounded). On expiry {@link defaultRunner} kills the child and
   * RESOLVES with {@link COMMAND_TIMEOUT_EXIT_CODE}; it never rejects, because
   * every caller in this package treats a runner result as evidence and a
   * rejection would be an unhandled throw on a path that used to hang.
   */
  timeoutMs?: number;
}

/** Injectable command runner — defaults to a child_process spawn in {@link defaultRunner}. */
export type CommandRunner = (bin: string, args: string[], opts?: RunOptions) => Promise<ExecResult>;

/** A command the driver wants to run, in argv form (no shell quoting needed). */
export interface PlannedCommand {
  bin: string;
  args: string[];
}

/**
 * Per-call options for {@link NativeDriver.replayRecording} — replay-
 * recording.ts's `ReplayInvocation` (keepSession + `-e` env pairs) plus the
 * resolved secrets the classifier redacts out of anything the outcome quotes.
 */
export type DriverReplayOptions = ReplayInvocation & {
  secrets?: ReadonlyArray<ResolvedSecret>;
};

/** Per-call options for {@link NativeDriver.inputText}. */
export interface TypeOptions {
  /**
   * Publish this fill's value as `${VAR}` in an armed `.ad` recording instead
   * of the literal text. Ignored when nothing is armed, and ignored for
   * `@eNN` targets (those are excluded from the recording entirely).
   */
  recordAs?: string;
}

export interface AgentDeviceOptions {
  platform: 'ios' | 'android';
  /** Custom URL scheme for the deep link (required for cold-open). */
  scheme?: string;
  /** Target device/udid. Defaults to the currently booted device. */
  device?: string;
  /** Metro host:port for the Expo Go `exp://` form. */
  expoHost?: string;
  /** agent-device binary name/path. Default `agent-device`. */
  bin?: string;
  /** Injectable runner (tests pass a fake; production uses defaultRunner). */
  run?: CommandRunner;
  /**
   * Project root, used only to give a failure DIAGNOSIS its context (the
   * companion app dir and the session-metrics log). Never affects a command —
   * see {@link AgentDeviceOptions.cwd} for the field that does.
   */
  projectRoot?: string;
  /**
   * Working directory for EVERY command this driver spawns. Set it to the
   * project root.
   *
   * agent-device keys its sessions by CWD (`session list` shows
   * `cwd_<hash>_default` beside a bare `default`), so the cwd is not an
   * incidental detail — it is half the session's identity. Left unset, the
   * spawned process inherits the HOST process's cwd: the project root for a CLI
   * invoked there, but for the MCP server whatever directory the MCP host
   * (Claude Desktop, an IDE extension, …) happened to launch it with. A CLI run
   * and an MCP run against the same project then address two different
   * sessions, and the second one to arrive is refused with `Device is already
   * in use by session "…"` — the exact symptom
   * {@link AgentDeviceDriver.releaseStaleClaimAndRetryOpen} recovers, except
   * self-inflicted and reproducible rather than a daemon artifact.
   *
   * Unset preserves the previous behavior exactly (the option is simply not
   * passed through to the spawn).
   */
  cwd?: string;
  /**
   * Path to an agent-device REMOTE PROFILE (`--remote-config <path>`), appended
   * to every agent-device command this driver spawns when set.
   *
   * The profile is the USER's file, and no provider logic lives here on
   * purpose: 0.20.5 routes cloud/proxy/BrowserStack/AWS-Device-Farm/Limrun
   * through one flag (`agent-device help remote`: "For self-contained scripts,
   * pass the same --remote-config to every operational command"). Validity's
   * job is to pass it through unchanged on EVERY command — a driver that
   * remembered to pass it on `open` but not on `snapshot` would address the
   * local daemon for half the sweep, which is the failure mode this exists to
   * prevent.
   *
   * Never applied to `adb`/`xcrun` (they would reject the flag), and unset
   * leaves every argv byte-identical to before.
   */
  remoteConfigPath?: string;
  /**
   * Ask mutating commands (`press`/`click`/`fill`) for a SETTLED DIFF —
   * `--settle`, upstream's documented default loop ("mutate with --settle,
   * continue from that settled diff"). Default TRUE.
   *
   * Best-effort by upstream's own contract: it "never fails the action", so the
   * worst case is a response with no `settle` field, which reads as "could not
   * tell". Set false to restore the pre-0.20.5 argv exactly (no `--settle`, no
   * `--json`) if a device ever misbehaves under it.
   */
  settle?: boolean;
  /** Quiet window a `--settle` action must observe (ms). Default {@link DEFAULT_SETTLE_QUIET_MS}. */
  settleQuietMs?: number;
  /** Deadline for a `--settle` wait (ms). Default {@link DEFAULT_ACTION_SETTLE_TIMEOUT_MS}. */
  settleTimeoutMs?: number;
  /**
   * Ask JSON-parsed commands for `--cost` (daemon-measured `wallClockMs`).
   * Default TRUE. Only ever added to commands whose stdout Validity parses as
   * JSON — a cost line printed into the a11y snapshot's TEXT would be read as
   * tree content by every downstream parser.
   */
  cost?: boolean;
  /**
   * Overrides for subcommands whose exact syntax may drift — confirm via
   * `agent-device help workflow` and override here without code changes.
   */
  commands?: {
    /** argv after the bin for a screenshot, with `{path}` substituted. Default ['screenshot','{path}']. */
    screenshot?: string[];
    /**
     * argv for the a11y snapshot. Defaults are PER-PLATFORM (see
     * {@link defaultSnapshotArgsFor}): iOS uses `['snapshot','-i']`, Android
     * uses `['snapshot']` because `-i` filters Android's tree down to hittable
     * nodes and drops every static `<Text>`.
     */
    snapshot?: string[];
    /** argv to dismiss the RN/Expo dev overlay. Default ['react-native','dismiss-overlay']. */
    dismissOverlay?: string[];
    /** argv prefix to accept a platform alert (a timeout-seconds arg is appended). Default ['alert','accept']. */
    alert?: string[];
    /** argv prefix to wait for a UI target (a selector + timeoutMs are appended). Default ['wait']. */
    wait?: string[];
    /**
     * argv prefix to TAP a UI target (a ref/selector is appended). Default
     * {@link DEFAULT_TAP_ARGS} (`['press']`) — see that constant for why the
     * default moved off `click` in 0.20.5. The option keeps its `click` name so
     * an existing `native.agentDevice.commands.click` override in a user config
     * keeps working; it has always meant "the tap argv", not "the click verb".
     */
    click?: string[];
    /**
     * argv prefix to type text into a UI target (a ref + text are appended).
     * Default ['fill'] — agent-device's targeted text-entry verb (`fill <ref>
     * <text>` replaces the field's value). Its `type` verb takes ONLY a text
     * arg (appends to the focused field) and since 0.20.2 rejects a ref with
     * INVALID_ARGS. A failed exec is treated as `unverifiable` by the native
     * check executor.
     */
    type?: string[];
    /**
     * argv for a scroll/swipe gesture, with `{direction}` substituted
     * (`up`/`down`). Default ['scroll','{direction}']. Like `type`, the
     * agent-device binary MAY NOT support this exact verb — a failed/unsupported
     * exec degrades to today's behavior (the off-screen element stays
     * `unverifiable`, never a new false fail), so scroll-to-find is best-effort.
     */
    scroll?: string[];
  };
  /**
   * Where to write this session's `.ad` replay recording — normally
   * `<run-dir>/replay.ad`. Set it and the session-establishing `open` is armed
   * with `--save-script`; leave it unset and NOT ONE argv changes (recording is
   * purely additive, and an unrecorded run must stay byte-identical to before).
   *
   * Honored only on the open that actually establishes the session. Upstream
   * permits one recorded `open` per session, so the first driver to open wins
   * and the rest are no-ops — see {@link sessionRecordings} and
   * `replay-recording.ts` for the full contract.
   */
  recordingPath?: string;
  /** Metro URL the dev-client should load for a cold open. Default `http://localhost:8082` (companion Metro). */
  metroUrl?: string;
  /**
   * Button labels (case-insensitive substring) that dismiss the Expo dev menu /
   * launcher overlay when ref-clicked. Defaults are PER-PLATFORM (see
   * {@link defaultDevMenuLabelsFor}): iOS keeps
   * ['continue','close','resume','dismiss','reload'], Android drops 'reload'
   * because clicking it re-opens the menu rather than closing it. Only
   * consulted AFTER the dev menu is positively detected — see
   * {@link AgentDeviceOptions.devMenuAnchorLabels}.
   */
  devMenuLabels?: string[];
  /**
   * Labels that prove the Expo dev menu / dev launcher is actually on screen
   * (see {@link DEV_MENU_ANCHOR_LABELS}). dismissDevMenu refuses to click
   * anything unless at least two of these are co-present in the a11y snapshot —
   * the dismiss labels above ('close', 'continue', …) are common in USER UI
   * (modals, onboarding), and clicking them on a rendered component mutates
   * the very state under verification before the screenshot.
   */
  devMenuAnchorLabels?: string[];
}

/** What Validity needs from any device driver — lets us swap agent-device for argent later. */
/**
 * What `agent-device wait stable --json` answers on success. Shape read off the
 * live 0.20.3 binary:
 *
 *     {"success":true,"data":{"waitedMs":568,"captures":3,"nodeCount":4,
 *      "hint":"Settled on a nearly-empty tree — the app may still be loading."}}
 *
 * `settled` is OUR field, not upstream's: it carries the exit status, because a
 * wait that times out still prints a payload and the caller must not read a
 * timeout as quiescence.
 */
export interface WaitStableOutcome {
  /** Did the wait actually settle (exit 0), or time out? */
  settled: boolean;
  /** Wall-clock ms the wait spent, when reported. */
  waitedMs?: number;
  /** How many tree captures it took (>=2 when settled). */
  captures?: number;
  /** Nodes in the final INTERACTIVE capture — see the Android caveat on `waitStable`. */
  nodeCount?: number;
  /** Upstream's own advisory text, passed through verbatim when present. */
  hint?: string;
}

/**
 * What `agent-device capabilities --json` answers, reduced to what Validity
 * uses. Read off the live 0.20.3 binary on `emulator-5554`, which listed 40
 * verbs including `fill`, `type`, `scroll`, `snapshot`, `wait` and `press`.
 *
 * IMPORTANT — what this can and cannot settle. It answers "does this VERB
 * exist", not "does this verb accept the argv I am about to send". 0.20.3 lists
 * `type` as available while rejecting `type <ref> <text>` with INVALID_ARGS
 * (the fail-closed parsing change that forced the switch to `fill`). So it is
 * sound for gating a verb Validity might not be allowed to call at all, and
 * useless as a proxy for argv compatibility.
 */
export interface CapabilityProbe {
  /** Verb names the selected device supports. */
  commands: readonly string[];
  /** Device identity the probe reported, when present. */
  device?: { platform?: string; id?: string; name?: string; kind?: string; booted?: boolean };
}

/**
 * Does `probe` positively say `verb` is unsupported?
 *
 * Deliberately three-valued via `undefined`: a MISSING probe (old binary, probe
 * failed, test fake) must never be read as "unsupported", or Validity would
 * start withholding verdicts because it could not ask the question. Only a
 * probe that answered, with a non-empty command list that omits the verb,
 * counts as evidence.
 */
export function capabilityMissing(
  probe: CapabilityProbe | undefined,
  verb: string,
): boolean | undefined {
  if (!probe || probe.commands.length === 0) return undefined;
  return !probe.commands.includes(verb);
}

/** The `{success, data}` envelope every `--json` agent-device command prints. */
function parseJsonEnvelope(stdout: string): Record<string, unknown> | undefined {
  if (!stdout || stdout.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const data = (parsed as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  return data as Record<string, unknown>;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Stats out of `wait stable --json`. PURE — unit-tested without a device.
 * Never throws and never decides `settled`: an unreadable payload yields an
 * empty outcome, and the caller stamps `settled` from the exit code.
 */
export function parseWaitStableJson(stdout: string): Omit<WaitStableOutcome, 'settled'> {
  const data = parseJsonEnvelope(stdout);
  if (!data) return {};
  return {
    waitedMs: num(data.waitedMs),
    captures: num(data.captures),
    nodeCount: num(data.nodeCount),
    hint: str(data.hint),
  };
}

/**
 * Supported verbs out of `capabilities --json`. PURE.
 *
 * Returns undefined rather than an empty probe when the list is missing or not
 * an array of strings, so {@link capabilityMissing} can keep "could not ask"
 * distinct from "asked, and the verb is absent".
 */
export function parseCapabilitiesJson(stdout: string): CapabilityProbe | undefined {
  const data = parseJsonEnvelope(stdout);
  if (!data) return undefined;
  const raw = data.availableCommands;
  if (!Array.isArray(raw)) return undefined;
  const commands = raw.filter((c): c is string => typeof c === 'string');
  if (commands.length === 0) return undefined;
  const d = data.device;
  const device =
    d && typeof d === 'object'
      ? {
          platform: str((d as Record<string, unknown>).platform),
          id: str((d as Record<string, unknown>).id),
          name: str((d as Record<string, unknown>).name),
          kind: str((d as Record<string, unknown>).kind),
          booted:
            typeof (d as Record<string, unknown>).booted === 'boolean'
              ? ((d as Record<string, unknown>).booted as boolean)
              : undefined,
        }
      : undefined;
  return { commands, device };
}

/* -------------------------------------------------------------------------- */
/* settled diffs, ref generations, command cost (0.20.5)                       */
/* -------------------------------------------------------------------------- */

/** One line of a settled diff — `+ added` / `- removed`, as upstream renders it. */
export interface SettleDiffLine {
  kind: 'added' | 'removed';
  /** The snapshot line's text, verbatim. */
  text: string;
  /**
   * PLAIN ref body (`e12`) for ADDED lines only — minted from the settled tree
   * that became the session's stored snapshot, so it is immediately actionable.
   * Removed lines name nodes of the REPLACED tree and never carry one.
   */
  ref?: string;
}

/** One still-present interactive element from a settled diff's unchanged tail. */
export interface SettleTailEntry {
  ref: string;
  role?: string;
  label?: string;
}

/**
 * What a `--settle` mutation reports about the UI it left behind
 * (`data.settle` on press/click/fill/longpress responses in 0.20.5).
 *
 * WHAT THIS IS NOT, and the reason it is spelled out: it is a CHANGE VIEW, not
 * a snapshot. `diff.lines` carries only what was added or removed, and `tail` is
 * attached only when the diff hands over no new target (the modal-dismiss /
 * toast-only signature). An element that was on screen before the action and
 * still is may appear in NEITHER. So this can answer "what changed" and "what
 * can I act on next"; it can never answer "is X absent", and treating it as a
 * full tree would turn a `state: hidden` / `count: 0` assertion into a false
 * PASS. {@link PostActionView.complete} is the flag that keeps that distinction
 * mechanical rather than remembered.
 */
export interface SettleObservation {
  /** TRUE only when upstream said `settled: true` — absence reads as "not settled". */
  settled: boolean;
  waitedMs?: number;
  captures?: number;
  /** Quiet window upstream actually used. */
  quietMs?: number;
  /** Settle deadline upstream actually used. */
  timeoutMs?: number;
  /**
   * The session's ref-frame epoch AFTER the settled tree became the stored
   * snapshot. Present only on ref-issuing settles; this is the `n` in the
   * `@e12~s<n>` pin (see {@link pinRef}).
   */
  refsGeneration?: number;
  summary?: { additions?: number; removals?: number; unchanged?: number };
  /** Added/removed lines. Empty when upstream reported no diff at all. */
  lines: SettleDiffLine[];
  /** Were the diff lines capped by the response bound? */
  truncated?: boolean;
  /** Still-present interactive refs, when upstream attached the tail. */
  tail: SettleTailEntry[];
  tailTruncated?: boolean;
  /** Upstream's own advisory text, verbatim when present. */
  hint?: string;
}

/**
 * Parse the `settle` block out of a `--settle --json` interaction response.
 * PURE — unit-tested without a device.
 *
 * TOTAL and tolerant: an unreadable body, a missing `settle`, or a settle with
 * no diff all answer `undefined`/empty rather than throwing, because absence of
 * a settled diff must read as "could not tell" and never as "the screen did not
 * change".
 */
export function parseSettleJson(stdout: string): SettleObservation | undefined {
  const data = parseJsonEnvelope(stdout);
  const raw = data?.settle;
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  const diff = (s.diff && typeof s.diff === 'object' ? s.diff : undefined) as
    | Record<string, unknown>
    | undefined;
  const summaryRaw = (
    diff?.summary && typeof diff.summary === 'object' ? diff.summary : undefined
  ) as Record<string, unknown> | undefined;
  const lines: SettleDiffLine[] = Array.isArray(diff?.lines)
    ? (diff.lines as unknown[]).flatMap((l) => {
        if (!l || typeof l !== 'object') return [];
        const row = l as Record<string, unknown>;
        const kind =
          row.kind === 'added' ? 'added' : row.kind === 'removed' ? 'removed' : undefined;
        if (!kind) return [];
        const ref = str(row.ref);
        return [{ kind, text: str(row.text) ?? '', ...(ref ? { ref } : {}) }];
      })
    : [];
  const tail: SettleTailEntry[] = Array.isArray(s.tail)
    ? (s.tail as unknown[]).flatMap((t) => {
        if (!t || typeof t !== 'object') return [];
        const row = t as Record<string, unknown>;
        const ref = str(row.ref);
        if (!ref) return [];
        const role = str(row.role);
        const label = str(row.label);
        return [{ ref, ...(role ? { role } : {}), ...(label ? { label } : {}) }];
      })
    : [];
  return {
    settled: s.settled === true,
    waitedMs: num(s.waitedMs),
    captures: num(s.captures),
    quietMs: num(s.quietMs),
    timeoutMs: num(s.timeoutMs),
    refsGeneration: num(s.refsGeneration),
    ...(summaryRaw
      ? {
          summary: {
            additions: num(summaryRaw.additions),
            removals: num(summaryRaw.removals),
            unchanged: num(summaryRaw.unchanged),
          },
        }
      : {}),
    lines,
    ...(diff?.truncated === true ? { truncated: true } : {}),
    tail,
    ...(s.tailTruncated === true ? { tailTruncated: true } : {}),
    ...(str(s.hint) ? { hint: str(s.hint) } : {}),
  };
}

/**
 * `data.cost.wallClockMs` out of a `--cost` response. PURE. Undefined whenever
 * the field is absent or non-numeric — a missing cost is missing evidence, not
 * a zero-cost command.
 */
export function parseCommandCostMs(stdout: string): number | undefined {
  const data = parseJsonEnvelope(stdout);
  const cost = data?.cost;
  if (!cost || typeof cost !== 'object') return undefined;
  return num((cost as Record<string, unknown>).wallClockMs);
}

/**
 * A bare snapshot ref (`@e12`), unpinned. Pinned refs carry the generation that
 * minted them (`@e12~s4`) — see {@link pinRef}.
 */
export const BARE_REF_RE = /^@e\d+$/;

/**
 * Pin a ref to the ref-frame generation that MINTED it: `@e12` + 4 → `@e12~s4`.
 *
 * Why this matters on 0.20.5 (`agent-device help workflow`): "Pinned refs
 * (@e12~s4, generation from refsGeneration or settle.refsGeneration) identify
 * their source tree. On iOS, stale refs are rejected for press/fill/click/
 * longpress before dispatch." An UNPINNED ref carries no provenance, so a ref
 * that has silently gone stale can still be dispatched — and a tap that lands on
 * whatever now occupies that slot is the worst outcome available to this
 * codebase: evidence about the wrong element. A pin converts that into an
 * explicit refusal, which the check executor already reports as `unverifiable`.
 *
 * Deliberately conservative: only a BARE `@eNN` is pinned, an already-pinned or
 * selector target is returned untouched, and an unknown generation returns the
 * ref exactly as given (today's behavior). "Could not tell" must never invent a
 * generation — a WRONG pin would be rejected by a device that would have
 * accepted the action.
 *
 * PURE — unit-tested without a device.
 */
export function pinRef(ref: string, generation: number | undefined): string {
  if (generation === undefined || !Number.isFinite(generation)) return ref;
  if (!BARE_REF_RE.test(ref)) return ref;
  return `${ref}~s${generation}`;
}

/** Drop a `~s<n>` pin from a ref (`@e12~s4` → `@e12`). PURE. */
export function stripRefPin(target: string): string {
  return target.replace(/~s\d+$/, '');
}

/**
 * The post-action view of the screen, and WHERE it came from.
 *
 * The ladder is upstream's documented one, cheapest first: the settled diff the
 * mutation already returned, else `diff snapshot -i` (the purpose-built
 * before/after read), else a full `snapshot`. `complete` says which of those a
 * caller is holding, because only the last one may be used to conclude that
 * something is ABSENT — see the warning on {@link SettleObservation}.
 */
export interface PostActionView {
  source: 'settled-diff' | 'diff-snapshot' | 'full-snapshot';
  /**
   * Snapshot-shaped text for the elements this view can name. For the two diff
   * sources this is the CHANGED (and, when upstream attached it, the still-
   * present interactive) subset — never the whole tree.
   */
  text: string;
  /**
   * TRUE only for `full-snapshot`. A caller that needs to prove absence must
   * refuse to answer on a `false` view rather than read "not in this text" as
   * "not on screen".
   */
  complete: boolean;
  /** The ref-frame generation behind `text`, when the source reported one. */
  refsGeneration?: number;
  /** For `settled-diff`: did upstream actually settle? */
  settled?: boolean;
}

/**
 * Render a settled diff / `diff snapshot` payload into the same
 * `@eNN [role] "label"` line shape a snapshot prints, so one parser reads all
 * three rungs of the ladder. Added lines keep upstream's own text (it IS a
 * snapshot line); tail entries are re-rendered from their fields. REMOVED lines
 * are dropped: they describe the tree that is gone, and keeping them would let a
 * presence check match an element that just disappeared. PURE.
 */
export function renderSettleAsSnapshotText(settle: SettleObservation): string {
  const out: string[] = [];
  for (const line of settle.lines) {
    if (line.kind !== 'added') continue;
    if (line.text.trim() !== '') out.push(line.text);
  }
  for (const entry of settle.tail) {
    const ref = entry.ref.startsWith('@') ? entry.ref : `@${entry.ref}`;
    const label = entry.label === undefined ? '' : ` "${entry.label}"`;
    out.push(`${ref} [${entry.role ?? ''}]${label}`);
  }
  return out.join('\n');
}

/**
 * The `lines` of a `diff snapshot --json` result, rendered like a snapshot.
 * `added` and `unchanged` lines are kept (both describe the CURRENT tree),
 * `removed` lines are dropped for the same reason as above. PURE, and tolerant:
 * an unreadable envelope answers undefined so the caller falls through to a full
 * snapshot instead of treating "no answer" as "no elements".
 */
export function parseDiffSnapshotJson(stdout: string): string | undefined {
  const data = parseJsonEnvelope(stdout);
  if (!data) return undefined;
  // A freshly initialized baseline has nothing to diff against; upstream says so
  // explicitly, and a caller must not read the empty line list as an empty tree.
  if (data.baselineInitialized === true) return undefined;
  const raw = data.lines;
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue;
    const row = l as Record<string, unknown>;
    if (row.kind === 'removed') continue;
    const text = str(row.text);
    if (text && text.trim() !== '') out.push(text);
  }
  return out.join('\n');
}

/**
 * Resolve `native.remote.configPath` into the absolute path the driver passes
 * as `--remote-config`.
 *
 * Relative paths resolve against the PROJECT ROOT, not the spawn cwd: the
 * profile is committed next to `.validity/config.ts` and a driver's cwd is
 * whatever the host process had (see {@link AgentDeviceOptions.cwd}). Absent
 * config, absent block, or a blank path all answer undefined — a remote profile
 * is opt-in, and half-configured must behave exactly like unconfigured.
 *
 * NOT validated here, on purpose: the file is the user's and agent-device is
 * the thing that reads it. A Validity-side existence check would only be able
 * to produce a second, worse error message for the same problem.
 */
export function resolveRemoteConfigPath(
  native: { remote?: { configPath?: string } } | undefined,
  projectRoot?: string,
): string | undefined {
  const raw = native?.remote?.configPath?.trim();
  if (!raw) return undefined;
  if (!projectRoot || isAbsolute(raw)) return raw;
  return resolvePath(projectRoot, raw);
}

export interface NativeDriver {
  /** The deep-link URL this driver would open for a target (for reporting). */
  targetUrl(spec: TargetSpec): string;
  /** Open the playground at a target (deep link) on the booted device. */
  openTarget(spec: TargetSpec): Promise<ExecResult>;
  /** Open an arbitrary URL on the device in the current session. */
  openUrl(url: string): Promise<ExecResult>;
  /**
   * Guarantee an agent-device SESSION exists before any session-requiring
   * command (`snapshot`, `screenshot`, `wait`, `click`, …) is issued.
   *
   * This is a separate contract from opening a target, because the two are
   * separate resources and conflating them is what produced the bug this
   * exists for: Validity's own control bridge (a WS to the companion app) can
   * be live while the agent-device DAEMON is cold, since the companion process
   * outlives the daemon. In that state the bridge fast-path in `coldOpen`
   * confirms a render without ever issuing `agent-device open` — the ONLY call
   * that establishes a session — and every command after it answers
   * `SESSION_NOT_FOUND` for the rest of the sweep.
   *
   * Bounded (the runner's host timeout applies) and idempotent: after the first
   * success it is a no-op for the life of the process. Optional on the
   * interface so minimal drivers and test fakes need not implement it; callers
   * treat an absent method as "this driver has no session to establish".
   */
  ensureSession?(url: string): Promise<NativeSessionReadiness>;
  /**
   * Open the expo-dev-client CONTROL link so the launcher loads the bundle
   * from Metro before we route to a component. No-op-able for warm apps.
   * Resolves the Metro URL from the arg, then {@link AgentDeviceOptions.metroUrl}.
   */
  openControlLink(metroUrl?: string): Promise<ExecResult>;
  /** Dismiss the RN/Expo dev overlay (best-effort; may no-op if none present). */
  dismissOverlay(): Promise<ExecResult>;
  /**
   * Dismiss the Expo dev menu / launcher overlay by snapshotting and ref-clicking
   * a known dismiss button (Continue/Close/Resume/…). `react-native
   * dismiss-overlay` only clears RN LogBox/RedBox, NOT the Expo dev menu, which
   * must be tapped by a11y ref (label-click fails on the simulator). GATED on
   * positive dev-menu detection: when the snapshot does not show dev-menu-only
   * anchor labels (see {@link snapshotShowsDevMenu}), it must click NOTHING —
   * a rendered user modal's own 'Close'/'Continue' button would otherwise be
   * clicked before the screenshot, corrupting the evidence. Best-effort:
   * returns true if a button was clicked, false if the menu wasn't detected or
   * no dismiss button was found.
   */
  dismissDevMenu(): Promise<boolean>;
  /** Click a UI target (ref/selector/point). */
  click(target: string): Promise<ExecResult>;
  /**
   * Type `text` into a UI target (ref/selector). The underlying agent-device
   * binary may not support this verb; callers (the native check executor) treat
   * a rejected/non-zero exec as `unverifiable`, not a fail.
   *
   * `opts.recordAs` names the placeholder a SECRET value publishes as in an
   * armed `.ad` recording — the device still receives the live text. See
   * `fillRecordingFlags`.
   */
  inputText(ref: string, text: string, opts?: TypeOptions): Promise<ExecResult>;
  /** Accept a platform confirmation alert (best-effort; may no-op if none present). */
  acceptAlert(timeoutSec?: number): Promise<ExecResult>;
  /** Wait for a UI target (ref/selector/text) to appear, up to `timeoutMs`. */
  waitForRef(ref: string, timeoutMs: number): Promise<ExecResult>;
  /**
   * Scroll/swipe the screen in `direction` to bring off-screen content into the
   * a11y tree (the native analog of Playwright's scroll-into-view). The
   * agent-device binary may not support this verb; the native check executor
   * treats a rejected/non-zero exec as "couldn't scroll" and falls back to the
   * pre-scroll snapshot (off-screen content stays `unverifiable`, never a false
   * fail). Optional so test fakes / minimal drivers can omit it.
   */
  scroll?(direction: 'up' | 'down'): Promise<ExecResult>;
  /** Capture a PNG screenshot to `path`. */
  screenshot(path: string): Promise<ExecResult>;
  /** Capture the accessibility snapshot (semantic UI tree text). */
  snapshot(): Promise<string>;
  /**
   * `agent-device wait stable [quietMs] [timeoutMs]` — poll the device's
   * INTERACTIVE tree until two or more consecutive captures are unchanged for
   * `quietMs`, or give up at `timeoutMs`. Upstream defaults are 500/10000.
   *
   * This is the quiescence primitive {@link waitForSettledSnapshot} used to
   * hand-roll with a fixed 400ms sleep. It is strictly better as a WAIT: it
   * returns as soon as the tree actually stops moving instead of always paying
   * a full interval, and it reports what it saw
   * ({@link WaitStableOutcome.captures}/`nodeCount`).
   *
   * It is NOT a verdict, and must not be used as one on Android. Verified on
   * 0.20.3 (2026-07-30): it polls the interactive-only tree, which on Android
   * drops standalone static `<Text>` (see {@link ANDROID_SNAPSHOT_ARGS}). On
   * the Ignite WelcomeScreen — heading and body copy plainly on screen — it
   * answered `{"waitedMs":568,"captures":3,"nodeCount":4}` with the hint
   * "Settled on a nearly-empty tree — the app may still be loading." A gate
   * that trusted that alone would settle on a screen whose text has not
   * rendered, which is precisely the false-green the settle gate exists to
   * prevent. So the settle gate uses this to WAIT and still decides on its own
   * full-tree snapshots.
   *
   * Optional on the interface so test fakes and minimal drivers can omit it;
   * callers treat an absent method (or a rejection) as "no such primitive" and
   * fall back to a plain sleep.
   */
  waitStable?(quietMs: number, timeoutMs: number): Promise<WaitStableOutcome>;
  /**
   * `agent-device capabilities --json` — the verbs THIS device/platform
   * supports, straight from the tool, instead of inferring support from a
   * failed exec. Optional; an absent method or a rejection means "cannot tell",
   * never "unsupported" (see {@link CapabilityProbe}).
   */
  capabilities?(): Promise<CapabilityProbe | undefined>;
  /**
   * The settled diff the most recent mutation returned, if any. Cleared by the
   * next mutation, so it always describes ONE action. Optional — an absent
   * method (test fakes, minimal drivers) means "no settle evidence".
   */
  lastSettle?(): SettleObservation | undefined;
  /**
   * The post-action view of the screen, cheapest rung first (see
   * {@link PostActionView}): the settled diff this driver already holds, else
   * `diff snapshot -i`, else a full `snapshot`. Optional; a driver without it
   * simply re-snapshots.
   */
  postActionView?(): Promise<PostActionView>;
  /**
   * Run ONE arbitrary agent-device verb inside THIS driver's session.
   *
   * The seam exists so evidence collectors (`perf metrics --json`, `network
   * dump --json`, …) attach to the session the capture actually drove instead
   * of re-deriving the platform env, the cwd, the remote profile and the host
   * timeout for themselves — four things that must agree with the capture or
   * the evidence describes a different device.
   *
   * `args` is the argv AFTER the bin, exactly as this driver's own command
   * builders produce it. It rides the same {@link AgentDeviceDriver.exec} path,
   * so recording suppression, `--remote-config`, session eviction, settle and
   * cost parsing all apply unchanged. Optional on the interface so test fakes
   * and minimal drivers can omit it.
   */
  runInSession?(args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /**
   * `agent-device events --json` — this session's request timeline, used to
   * ground per-capture timings in DAEMON-measured durations instead of host
   * wall clock (see `CaptureMetricRow.snapshotDeviceMs`). Optional; an absent
   * method or an unreadable stream answers `[]`, and the host-side numbers
   * remain the primary measurement either way.
   */
  sessionEvents?(): Promise<AgentDeviceEvent[]>;
  /**
   * Kill the app process so the next open is a GENUINE cold launch. The FINAL
   * fallback for refreshing the JS bundle mid-session: the preferred path is
   * the bridge-pushed in-place `reload` (safe on splashless rev>=2 companion
   * binaries — see reloadViaBridge in capture-native.ts), and the terminate
   * ladder survives only for cold boots and OLD binaries, where an in-place
   * reload re-presents expo-splash-screen's launch screen un-dismissably but a
   * fresh process's first `hideAsync()` lands. Optional so test fakes /
   * minimal drivers can omit it.
   */
  terminateApp?(bundleId: string): Promise<ExecResult>;
  /**
   * The topmost resumed `<package>/<activity>` on the device, when the platform
   * can report one. Android only in practice (`dumpsys activity activities`);
   * iOS has no equivalent and answers `undefined`, as does any driver that
   * cannot probe.
   *
   * `undefined` means NO ANSWER, not "nothing in the foreground" — callers must
   * treat it as absence of evidence and fall back to a screen-content signal
   * (see {@link deviceOnDevLauncherHome}). Optional so test fakes / minimal
   * drivers can omit it.
   */
  foregroundActivity?(): Promise<string | undefined>;
  /**
   * Record the destination guard for an armed `.ad` — a selector wait on the
   * id-bearing render marker, which is what makes the published script
   * replayable with landmark verification. Optional; a driver without it (test
   * fakes, minimal drivers) simply never produces a recording.
   */
  recordDestinationGuard?(marker: string, timeoutMs: number): Promise<boolean>;
  /**
   * Publish the armed `.ad` without closing the session. Optional, and
   * best-effort by contract: `published:false` with a named `reason` is a
   * complete, honest answer — a verify must never fail because a recording
   * could not be written.
   */
  publishRecording?(): Promise<RecordingPublication & { path?: string }>;
  /**
   * Abandon this session's recording with a reason, so publication refuses.
   * The fail-closed path for a step that must never reach the `.ad` (a secret
   * that would be written literally). Optional; a driver without it simply has
   * no recording to abandon.
   */
  abandonRecording?(reason: string): void;
  /** The `.ad` this session armed, if any — so a capture can report the path. */
  recordingState?(): { path: string; published: boolean; abandoned?: string } | undefined;
  /** The platform this driver targets. */
  readonly platform: 'ios' | 'android';
  /** The custom URL scheme this driver deep-links with, if any. */
  readonly scheme?: string;
  /** The target device/udid/serial this driver is pinned to, if any. */
  readonly device?: string;
}

const DEFAULT_BIN = 'agent-device';

/**
 * Single-quote `s` for the DEVICE-side shell. `adb shell` joins its argv into
 * one command line that the device's `sh` re-parses, so host-side argv
 * separation is NOT enough: a bare `&` in a deep link (`?component=…&token=…`)
 * backgrounds the `am start` with the URL truncated at the `&` — the intent is
 * delivered without its token, the open exits 0, and the render can never
 * confirm. Verified live on an API 35 emulator (2026-07-28; see
 * docs/agent-device-upstream-issues.md issue 1 — agent-device's own `open` has
 * the identical flaw, which is what this fallback exists to route around).
 */
export function deviceShellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build the platform-native command that opens a deep-link URL on the booted device. */
export function openUrlCommand(
  url: string,
  platform: 'ios' | 'android',
  device?: string,
): PlannedCommand {
  if (platform === 'ios') {
    // `booted` targets the one booted sim; a udid targets a specific one.
    return { bin: 'xcrun', args: ['simctl', 'openurl', device ?? 'booted', url] };
  }
  // ONE argv entry for the whole device-side command: adb passes it verbatim,
  // so the quoting survives to the device `sh` (see deviceShellQuote).
  const base = ['shell', `am start -a android.intent.action.VIEW -d ${deviceShellQuote(url)}`];
  return { bin: 'adb', args: device ? ['-s', device, ...base] : base };
}

/* -------------------------------------------------------------------------- */
/* agent-device session registry                                               */
/* -------------------------------------------------------------------------- */

/**
 * Which agent-device sessions this PROCESS has positively established.
 *
 * Module-level rather than per-instance because the thing being tracked lives
 * OUTSIDE the process: an agent-device session belongs to the daemon, keyed by
 * platform + device + cwd, and `verify --all` builds a FRESH driver per spec
 * (native-verify-engine's makeDriver runs inside the per-spec function). An
 * instance flag would therefore re-open once per spec — the cost the bridge
 * fast-path exists to avoid — while the session it was proving is one shared
 * resource.
 *
 * The map is a positive record only: membership means "an `agent-device open`
 * returned 0 for this key in this process", never "the session is fine now".
 * {@link AgentDeviceDriver.exec} evicts a key the moment any command answers
 * with {@link NO_SESSION_SIGNATURE}, so a session that dies mid-sweep is
 * re-established by the next capture instead of poisoning the rest of the run.
 *
 * The VALUE is what {@link closeEstablishedNativeSessions} needs to hand the
 * session back at process end. It is captured at open time because the driver
 * that opened it is gone by then — `verify --all` builds one per spec — and
 * because a close addressed with a different cwd/remote profile would close a
 * different session (or none) while reporting success.
 */
const establishedSessions = new Map<string, EstablishedSession>();

/** What closing one established session requires, captured when it was opened. */
interface EstablishedSession {
  /**
   * The driver's OWN runner, already cwd-pinned by {@link withCwd}. Kept rather
   * than re-deriving a spawn: agent-device keys sessions by cwd, and a teardown
   * that spawned in the host process's cwd would address a session nobody owns.
   */
  run: CommandRunner;
  bin: string;
  /** `AGENT_DEVICE_PLATFORM`/`AGENT_DEVICE_ID`, exactly as the open carried them. */
  env: Record<string, string>;
  /** `--remote-config <path>` when set — a cloud session must not be closed locally. */
  trailingArgs: string[];
}

/** Identity of an agent-device session, as agent-device itself keys it. */
export function nativeSessionKey(opts: {
  platform: 'ios' | 'android';
  device?: string;
  cwd?: string;
}): string {
  return [opts.platform, opts.device ?? '', opts.cwd ?? ''].join(' ');
}

/**
 * Which agent-device sessions this PROCESS has ARMED a `.ad` recording on.
 *
 * Module-level for the same reason {@link establishedSessions} is: a recording
 * belongs to the SESSION, not to a driver instance, and `verify --all` builds a
 * fresh driver per spec. Upstream allows exactly one recorded `open` per
 * session, so this map is also the interlock that guarantees it — the first
 * driver to establish the session arms the recording, every later driver sees
 * an entry and arms nothing.
 */
const sessionRecordings = new Map<string, SessionRecording>();

/**
 * One session's `.ad` recording state.
 *
 * `abandoned` is the FAIL-CLOSED half of secret-safe recording: once a step has
 * been driven that must not be published (a secret that would land in the
 * script literally, a value whose placeholder could not be resolved), the
 * recording is dead for the rest of the session and publication must refuse
 * with a reason rather than write a script that is quietly unsafe. It is a
 * one-way door — nothing clears it but a new session.
 */
export interface SessionRecording {
  path: string;
  published: boolean;
  /** Why this recording must never be published, once something made it unsafe. */
  abandoned?: string;
}

/** Forget every established-session record (a fresh daemon, or a test). */
export function resetNativeSessionRegistry(): void {
  establishedSessions.clear();
  sessionRecordings.clear();
}

/** The `.ad` this process armed for `key`, if any. Read by tests and reporting. */
export function nativeRecordingFor(key: string): SessionRecording | undefined {
  return sessionRecordings.get(key);
}

/** Has this process positively established the agent-device session for `key`? */
export function nativeSessionEstablished(key: string): boolean {
  return establishedSessions.has(key);
}

/**
 * How long ONE close gets at teardown. Deliberately far below
 * {@link DEFAULT_COMMAND_TIMEOUT_MS}: this runs after the last verdict is
 * decided, so the only thing a long wait can still cost is the developer's
 * time, and a wedged daemon must not turn "the run finished" into a hang.
 */
export const SESSION_CLOSE_TIMEOUT_MS = 10_000;

/** What {@link closeEstablishedNativeSessions} did, for a log line. */
export interface NativeSessionCloseSummary {
  /** Sessions whose `close` returned 0. */
  closed: number;
  /** Sessions whose `close` failed, timed out, or threw — all non-fatal. */
  failed: number;
}

/**
 * Hand every session this process established back to the daemon.
 *
 * WHY THIS EXISTS. agent-device takes a DEVICE CLAIM when a session opens and
 * writes it to `~/.agent-device/device-claims/<hash>.json`. Validity used to
 * never close — the session is deliberately shared across a whole
 * `verify --all` sweep (see replay-recording.ts) — so every run ended with a
 * claim file whose owning daemon then exited (idle shutdown, terminal close,
 * or verify-all killing the emulator under it). The file outlived the daemon's
 * memory, and the next run's readiness pass reported a "phantom device claim"
 * that the developer was told to `rm -rf` — once per verify, forever.
 *
 * WHAT IT IS NOT: a per-capture or per-spec close. The warm-session registry
 * exists precisely to avoid re-opening per spec, and publication of a `.ad`
 * recording REFUSES a script containing a `close`. This runs once, at the end
 * of a process (or on a signal), strictly after any `session save-script`.
 *
 * Best-effort in every direction: never throws, never reports a failure through
 * an exit code, and bounded per close. The registry entries it attempted are
 * dropped either way — a session that could not be closed at teardown will not
 * be closable a second later either, and a retry loop here would trade a
 * finished run for a hang.
 */
export async function closeEstablishedNativeSessions(): Promise<NativeSessionCloseSummary> {
  const entries = [...establishedSessions.entries()];
  establishedSessions.clear();
  const summary: NativeSessionCloseSummary = { closed: 0, failed: 0 };
  for (const [, session] of entries) {
    try {
      const res = await session.run(session.bin, ['close', ...session.trailingArgs], {
        env: session.env,
        timeoutMs: SESSION_CLOSE_TIMEOUT_MS,
      });
      if (res.code === 0) summary.closed += 1;
      else summary.failed += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

/** Registered once per process; a second install is a no-op, not a second close. */
let sessionShutdownHandlersInstalled = false;

/**
 * Close established sessions when the process is SIGNALLED rather than allowed
 * to finish — Ctrl-C during a sweep, a CI runner reaping the job. Idempotent:
 * a second call installs nothing.
 *
 * Deliberately does NOT decide how the process ends. The signal disposition is
 * read SYNCHRONOUSLY (before any await, while listeners registered after this
 * one are still on the emitter): if someone else is listening — `browse`'s Vite
 * teardown, `watch`'s watcher close — they own the exit and this only does its
 * cleanup alongside them. If nobody is, the signal is re-raised once the close
 * is done, which restores exactly the default disposition that merely having a
 * listener suppressed. A teardown hook must never change what a run exits with.
 */
export function installNativeSessionShutdownHandlers(): void {
  if (sessionShutdownHandlersInstalled) return;
  sessionShutdownHandlersInstalled = true;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      const handledElsewhere = process.listenerCount(signal) > 0;
      void (async () => {
        await closeEstablishedNativeSessions();
        if (!handledElsewhere) process.kill(process.pid, signal);
      })();
    });
  }
}

/**
 * Outcome of {@link AgentDeviceDriver.ensureSession}.
 *
 * `ready:false` is NEVER fatal — the capture proceeds and degrades honestly, as
 * everything else in this package does. It exists so the failure can be NAMED
 * (see the `no-native-session` probe in environment-diagnosis.ts) instead of
 * arriving as seven consecutive specs of `cause: unknown`.
 */
export interface NativeSessionReadiness {
  ready: boolean;
  /**
   * - `already-open` — this process already established it; no command was run.
   * - `opened`       — an `agent-device open` established it just now.
   * - `failed`       — the open did not establish a session (the deep link may
   *                    still have been delivered by the platform-CLI fallback).
   */
  via: 'already-open' | 'opened' | 'failed';
  /** stdout+stderr of the failed open, for the diagnosis path. */
  errorText?: string;
  /** Cause the driver's own probes attached to a double failure, if any. */
  diagnosis?: EnvironmentDiagnosis;
}

/** Default Metro URL the companion dev-client connects to (port 8082). */
export const DEFAULT_METRO_URL = 'http://localhost:8082';

/** Button labels (case-insensitive substring) that dismiss the Expo dev menu/launcher. */
export const DEFAULT_DEV_MENU_LABELS = ['continue', 'close', 'resume', 'dismiss', 'reload'];

/**
 * The same list MINUS 'reload', used on Android.
 *
 * 'Reload' is not a dismissal there — it is the opposite. Reading
 * expo-dev-menu's source rather than inferring from the label:
 * `DevMenuFragment.onCreate` opens the menu whenever
 * `showsAtLaunch || !isOnboardingFinished`, and `isOnboardingFinished` defaults
 * to false and only flips when a human taps through the onboarding sheet — so
 * on an installer-provisioned companion it is false forever. `showMenuAtLaunch`
 * hangs a `ReactInstanceEventListener` that opens the menu on every new React
 * context. Clicking 'Reload' builds exactly such a context, so the menu comes
 * straight back, one bundle reload poorer.
 *
 * SDK 55's Android sheet exposes Reload / Go home / Performance monitor /
 * Element inspector / Open DevTools and NO close action, so with 'reload'
 * removed nothing matches and {@link AgentDeviceDriver.dismissDevMenu} clicks
 * NOTHING on Android. That is the intended outcome: the real dismissal is the
 * in-app `ExpoDevMenu.closeMenu()` the companion performs over the control
 * bridge (see NativeDismissDevMenuMessage), and a no-op here is strictly better
 * than a reload loop or a BACK press that walks the app out to the launcher.
 *
 * iOS keeps 'reload' deliberately. The same reasoning says it is not a
 * dismissal there either, but that path is load-bearing for the passing iOS
 * sweep and nothing has been OBSERVED to be wrong with it; changing it here
 * would be an unproven edit to the one platform that works. The bridge-backed
 * dismissal now runs first on both platforms, so this list is a fallback in
 * either case.
 */
export const ANDROID_DEV_MENU_LABELS = DEFAULT_DEV_MENU_LABELS.filter((l) => l !== 'reload');

/** The dismiss-label list this platform uses when no explicit override is set. */
export function defaultDevMenuLabelsFor(platform: 'ios' | 'android'): string[] {
  return platform === 'android' ? ANDROID_DEV_MENU_LABELS : DEFAULT_DEV_MENU_LABELS;
}

/**
 * `--force-full` — "re-emit the full tree even when unchanged". Required on
 * EVERY snapshot, on every platform, and the reason is not an optimization.
 *
 * agent-device keeps a per-session BASELINE and de-duplicates repeat reads.
 * The second `snapshot` of an unchanged screen does not return the tree at all;
 * it returns:
 *
 *     Snapshot unchanged since previous read 1.1s ago.
 *     Refs from the previous snapshot are still valid. Use --force-full to
 *     re-emit the tree, or use find/get/is for a targeted query.
 *
 * Validity re-snapshots constantly — the settle gate polls every 400ms, the
 * check executor re-reads while resolving, the dev-menu detector reads before
 * every dismissal — so this placeholder was landing in all three:
 *
 *  - The SETTLE GATE compares consecutive snapshots for equality. Two
 *    placeholders differ only in their elapsed-seconds text, so the gate either
 *    never settled (the times differed) or "settled" on two identical
 *    PLACEHOLDER STRINGS while never having looked at the UI at all. Both
 *    outcomes are wrong, and the second is worse: a gate that exists to prove
 *    the tree is stable was passing on a sentence about the tree.
 *  - A CHECK resolved against a placeholder finds no elements — a false red (or
 *    at best an empty-tree demotion) about a screen that rendered fine.
 *  - DEV-MENU DETECTION reads no anchors from it, so a menu that is genuinely
 *    up looks absent.
 *
 * Measured on an API 35 emulator: with `--force-full`, ten consecutive reads
 * 400ms apart are byte-identical (so the gate settles on the FIRST comparison,
 * as it should); without it, read #2 onward are placeholders.
 *
 * ANDROID ONLY — and that restriction is empirical, not timid. The reasoning
 * above is platform-independent and the flag looks purely
 * information-increasing, so it was first applied to both. A like-for-like iOS
 * control sweep on the same machine, fixture and simulator says otherwise:
 *
 *   iOS, 13 specs, `snapshot -i`              → 33 pass, 0 fail,  7 unverifiable
 *   iOS, 13 specs, `snapshot -i --force-full` → 26 pass, 1 fail, 13 unverifiable
 *
 * — including one spec whose render came back `unconfirmed` and produced no
 * verdicts at all, while that same spec passes 3/3 when run on its own. So the
 * damage is a cross-spec, whole-session effect of re-emitting iOS's tree on
 * every read, not a per-check one. The mechanism is not yet understood, and
 * "not yet understood" is precisely the condition under which this repo does
 * not ship a change to the platform that works. Android keeps it because
 * Android is measurably broken without it.
 *
 * Reproduce with `validity verify --all` against a booted iOS simulator before
 * and after adding the flag to {@link DEFAULT_SNAPSHOT_ARGS}; the follow-up is
 * to find the mechanism, not to widen this back out on the theory above.
 */
const FORCE_FULL_FLAG = '--force-full';

/**
 * iOS a11y snapshot argv: `-i` = "interactive elements only" per
 * `agent-device snapshot --help`.
 *
 * That filter is much less restrictive than its name suggests on iOS — UIKit
 * exposes static text as accessibility elements, so headings and labels come
 * through with role `other` (which is exactly why `other` had to be added to
 * TEXT_FALLBACK_ROLES). Every passing iOS sweep is built on exactly this argv,
 * and it is left byte-identical — see {@link FORCE_FULL_FLAG} for the sweep
 * that says adding to it costs 7 passing criteria.
 */
export const DEFAULT_SNAPSHOT_ARGS = ['snapshot', '-i'];

/**
 * Android a11y snapshot argv: the SAME tree, without `-i`.
 *
 * On Android `-i` means what it says. The interactive filter keeps only
 * `hittable` nodes, and a React Native `<Text>` compiles to a plain
 * `android.widget.TextView` that is not clickable or focusable — so it is
 * dropped. Measured on the Ignite WelcomeScreen (API 35), same frame, same
 * process:
 *
 *   snapshot -i  →  3 visible nodes: two Buttons and a Button's inner label.
 *   snapshot     → 27 visible nodes, including
 *                  `@e23 [text] "Your app, almost ready for launch!"`
 *                  and the render marker `validity-root:<token>`.
 *
 * The heading was on screen and in the raw hierarchy (`--raw` shows the
 * TextView with `identifier: "welcome-heading"`) the whole time. Validity was
 * asking for interactive elements and then scoring a STATIC TEXT presence
 * criterion against the answer, so `heading-visible` could only ever fail on
 * Android — a false red about an app that rendered perfectly.
 *
 * `-c` (compact) is deliberately NOT used: it prunes unlabeled nodes, which
 * drops the screen's ImageViews (the Ignite logo among them) and would trade
 * this false red for a false red on any image-presence criterion.
 *
 * The extra nodes this admits are the system status bar (clock, battery) plus
 * layout groups. That is noise, not risk: every check is a positive match
 * against a specific name/text, and the alternative — not seeing the app's own
 * text at all — is strictly worse.
 */
export const ANDROID_SNAPSHOT_ARGS = ['snapshot', FORCE_FULL_FLAG];

/** The snapshot argv this platform uses when no explicit override is set. */
export function defaultSnapshotArgsFor(platform: 'ios' | 'android'): string[] {
  return platform === 'android' ? ANDROID_SNAPSHOT_ARGS : DEFAULT_SNAPSHOT_ARGS;
}

/**
 * The TAP argv — `press`, which 0.20.5 documents as the canonical tap.
 *
 * `agent-device --help` (0.20.5, captured 2026-08-06): "Taps are press or click;
 * tap is an alias for press", and the top-level Agent Starting Point writes
 * every boundary example as `press`. `click` is not removed and still works on
 * every platform — it is the verb macOS/web reach for (`click <ref> --button
 * secondary` is the documented macOS context-menu path) — so this is an
 * alignment with the reference loop, not a capability change.
 *
 * Kept as a constant rather than inlined so the readiness checklist can assert
 * the verb it will actually issue (see NATIVE_CAPTURE_VERBS in
 * native-readiness.ts) and so a config override
 * (`native.agentDevice.commands.click`) has one documented default to diff
 * against.
 */
export const DEFAULT_TAP_ARGS = ['press'];

/**
 * Quiet window a `--settle` action asks for (ms). Upstream's own default, and
 * deliberately the same number as {@link WAIT_STABLE_QUIET_MS} in
 * snapshot-settle: both are "how long the tree must hold still", asked of the
 * same daemon.
 */
export const DEFAULT_SETTLE_QUIET_MS = 500;

/**
 * Deadline for one `--settle` wait (ms). Upstream defaults to 10s; Validity asks
 * for 5s.
 *
 * The trade, stated because it is the only place this driver shortens an
 * upstream default: `--settle` "never fails the action", so a deadline that
 * expires costs the settled DIFF, not the action — the mutation already
 * happened and the caller falls back to its own snapshot. A verify sweep issues
 * one of these per interactive criterion, so a device that never quiets would
 * pay 10s per check for evidence it is not going to get. Five seconds is longer
 * than any settle observed in practice (upstream's own quiet window is 500ms)
 * and still leaves the host command bound ({@link DEFAULT_COMMAND_TIMEOUT_MS},
 * 60s) an order of magnitude clear of it.
 */
export const DEFAULT_ACTION_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Labels that appear on the Expo dev menu / dev-launcher surfaces, used as
 * POSITIVE detection anchors before any dismiss click (see
 * {@link snapshotShowsDevMenu}). 'Reload'/'Continue'/'Close' are deliberately
 * NOT anchors — they are exactly the labels user modals and error screens
 * carry.
 *
 * Anchors are split into two tiers because a flat "any TWO distinct anchors"
 * floor is brittle against Expo's copy: SDK 55 renamed three of the menu's five
 * tool rows at once ('Toggle performance monitor' → 'Performance monitor',
 * 'Open JS debugger' + 'Open React DevTools' → 'Open DevTools'), and a flat
 * floor survived that only because 'Go home' happened to be untouched. One more
 * such rename would take detection below the floor — and the failure is SILENT:
 * an unrecognized dev menu is byte-stable and marker-free, so the settle gate
 * declares it settled and the run's first criterion resolves against the menu.
 * That is the `heading-visible` false red, back, with nothing pointing at why.
 * Requiring only ONE specific anchor means every one of them has to be renamed
 * in the same release before detection is lost.
 *
 * Anchors that are CONCLUSIVE on their own: developer-tooling copy that a
 * user's product UI has no reason to render. One of these in the tree is
 * enough to call it the dev menu/launcher.
 *
 * Stems, not the full labels: SDK 55's SwiftUI menu renders bare 'Performance
 * monitor' / 'Element inspector' where older builds render 'Toggle performance
 * monitor'. Matching the stem covers both.
 *
 * 'Open DevTools' is SDK 55's name for what earlier versions split into 'Open
 * JS debugger' and 'Open React DevTools'; those two no longer appear in
 * expo-dev-menu at all. They are kept only so an older dev-client still
 * matches.
 */
export const DEV_MENU_SPECIFIC_ANCHORS = [
  'performance monitor',
  'element inspector',
  'open devtools',
  'open js debugger',
  'open react devtools',
  'open react native dev menu',
  // Dev LAUNCHER (server picker), not the menu.
  'fetch development servers',
  'enter url manually',
];

/**
 * Anchors that are dev-menu-ish but PLAUSIBLE in a real product ('Go home' is
 * an ordinary empty-state button), so they only count toward the two-distinct
 * floor and can never fire detection alone.
 */
export const DEV_MENU_GENERIC_ANCHORS = ['go home'];

/** Every anchor, specific + generic — the set {@link countDevMenuAnchors} counts. */
export const DEV_MENU_ANCHOR_LABELS = [...DEV_MENU_GENERIC_ANCHORS, ...DEV_MENU_SPECIFIC_ANCHORS];

/**
 * The expo-dev-menu / expo-dev-launcher versions {@link DEV_MENU_ANCHOR_LABELS}
 * was last checked against, by reading the label strings those packages ship.
 * Recorded because the coupling is to Expo's COPY, not to an API: a rename
 * costs us detection, and detection loss is not self-announcing.
 *
 * To re-check after an Expo bump, grep the installed packages for the anchors:
 *
 *   grep -rhoiE '"[^"]*(devtools|performance monitor|element inspector|go home)[^"]*"' \
 *     node_modules/expo-dev-menu node_modules/expo-dev-launcher | sort -u
 *
 * The 2026-07-27 check found two dead anchors ('open js debugger', 'open react
 * devtools') — exactly the drift this constant exists to date-stamp.
 */
export const DEV_MENU_ANCHORS_VERIFIED_AGAINST =
  'expo-dev-menu@55.0.30 / expo-dev-launcher@55.0.36';

/**
 * Which anchors a snapshot's quoted node labels match, split by tier. PURE —
 * unit-tested without a device. Exported so a caller can report a NEAR-MISS
 * (some anchors present, not enough to fire) rather than only a boolean.
 */
export function matchDevMenuAnchors(
  snapshot: string,
  anchors: string[] = DEV_MENU_ANCHOR_LABELS,
): { specific: number; total: number } {
  const wanted = anchors.map((a) => a.toLowerCase());
  const specificSet = new Set(DEV_MENU_SPECIFIC_ANCHORS);
  const present = new Set<string>();
  for (const line of snapshot.split('\n')) {
    const labelMatch = line.match(/"((?:[^"\\]|\\.)*)"/);
    const label = (labelMatch?.[1] ?? '').replace(/\\(.)/g, '$1').toLowerCase();
    if (!label) continue;
    for (const a of wanted) {
      if (label.includes(a)) present.add(a);
    }
  }
  let specific = 0;
  for (const a of present) if (specificSet.has(a)) specific += 1;
  return { specific, total: present.size };
}

/** How many DISTINCT anchors (either tier) the snapshot matched. */
export function countDevMenuAnchors(
  snapshot: string,
  anchors: string[] = DEV_MENU_ANCHOR_LABELS,
): number {
  return matchDevMenuAnchors(snapshot, anchors).total;
}

/** Distinct anchors needed when NONE of them is a specific (conclusive) one. */
export const DEV_MENU_ANCHOR_THRESHOLD = 2;

/**
 * Positive dev-menu/launcher presence check over an agent-device a11y snapshot.
 * True when EITHER at least one {@link DEV_MENU_SPECIFIC_ANCHORS specific}
 * anchor is present (developer-tooling copy a product screen has no reason to
 * render — conclusive alone), OR at least
 * {@link DEV_MENU_ANCHOR_THRESHOLD} distinct anchors of any tier are, which is
 * what keeps a user component with a lone 'Go home' button off this path.
 * Exported for unit testing.
 */
export function snapshotShowsDevMenu(
  snapshot: string,
  anchors: string[] = DEV_MENU_ANCHOR_LABELS,
): boolean {
  const { specific, total } = matchDevMenuAnchors(snapshot, anchors);
  return specific >= 1 || total >= DEV_MENU_ANCHOR_THRESHOLD;
}

/**
 * Find an `@eNN` ref in an agent-device accessibility snapshot whose label
 * matches one of `labels` (case-insensitive substring). The snapshot format is
 * one node per line, e.g. `# @e3 [button] "Continue"`; we match the quoted
 * label against the dismiss labels and return the first matching ref token
 * (`@e3`), or undefined if none. Exported for unit testing.
 */
export function findDismissRef(snapshot: string, labels: string[]): string | undefined {
  const wanted = labels.map((l) => l.toLowerCase());
  for (const line of snapshot.split('\n')) {
    const refMatch = line.match(/@e\d+/);
    if (!refMatch) continue;
    // Escape-aware so a label with an embedded `\"` isn't truncated at the
    // inner quote (which could drop the anchor we're matching on).
    const labelMatch = line.match(/"((?:[^"\\]|\\.)*)"/);
    const label = (labelMatch?.[1] ?? '').replace(/\\(.)/g, '$1').toLowerCase();
    if (label && wanted.some((w) => label.includes(w))) return refMatch[0];
  }
  return undefined;
}

/**
 * Pull the foreground `<package>/<activity>` out of `adb shell dumpsys activity
 * activities`. The line looks like:
 *
 *     topResumedActivity=ActivityRecord{870b9f3 u0 ai.validity.playground/expo.modules.devlauncher.launcher.DevLauncherActivity t74}
 *
 * `mResumedActivity` is accepted as a fallback because older Android builds
 * print that name instead. Returns `undefined` when neither is present (an
 * unparseable dump must read as "no answer", never as "nothing is foreground").
 * PURE — unit-tested without a device.
 */
export function parseTopResumedActivity(dumpsys: string): string | undefined {
  // `}` is excluded from the captured token as well as whitespace: the record
  // usually continues with a task id (`… t74}`) but can close immediately after
  // the component, and a greedy `\S+` would swallow the brace into the name.
  const m = dumpsys.match(
    /(?:topResumedActivity|mResumedActivity)=ActivityRecord\{\S+\s+\S+\s+([^\s}]+\/[^\s}]+)/,
  );
  return m?.[1];
}

/**
 * Compose `<package>/<activity>` out of `agent-device appstate --json`.
 *
 * The shape is normalized to what {@link parseTopResumedActivity} returns, so
 * the two rungs are interchangeable to every caller
 * (`activityIsDevLauncher(...)` and the dev-launcher diagnosis signature both
 * substring-match this string). appstate reports the two halves separately and
 * the activity is already fully qualified
 * (`ai.validity.playground.MainActivity`), so the package prefix is added back
 * rather than assumed present.
 *
 * Returns undefined unless BOTH halves are readable — a package with no
 * activity would silently widen every `includes('devlauncher')` test to a
 * package-name match. PURE — unit-tested without a device.
 */
export function parseAppstateJson(stdout: string): string | undefined {
  const data = parseJsonEnvelope(stdout);
  if (!data) return undefined;
  const pkg = str(data.package);
  const activity = str(data.activity);
  if (!pkg || !activity) return undefined;
  return activity.includes('/') ? activity : `${pkg}/${activity}`;
}

/**
 * Host-side wall-clock bound on any command spawned by {@link defaultRunner}.
 *
 * The failure it exists for is the worst one this package can produce. Every
 * agent-device call resolves only on the child's `close`, so a wedged daemon or
 * device — the documented decayed-session shape (handoff-2026-07-28: the
 * companion ACKs the bridge navigate, the RN root never attaches, nothing in
 * logcat) — parks the settle gate, the check executor, `verify --all` or an MCP
 * tool call FOREVER, with no error and no diagnosis. Everything else here
 * degrades to a bounded, honest `unverifiable`; this one takes the process down
 * silently.
 *
 * 60s, and the number is chosen to be un-trippable by a device that is merely
 * slow, because a false kill turns a working (if decayed) run into a red one —
 * the trade this codebase never makes:
 *
 *  - the slowest routine command is the Android snapshot, and agent-device
 *    0.20.1's own decay warning measured it at "p95 2934ms over 209 captures".
 *    60s is ~20x the p95 of the worst-behaved command on the worst-behaved
 *    platform at its worst observed moment.
 *  - the longest in-CLI wait the driver issues is 8s
 *    (capture-native's DEFAULT_RENDER_WAIT_MS; `alert accept` is 2s), and a
 *    caller asking for MORE than the host bound widens it rather than racing it
 *    (see {@link hostTimeoutForInnerWait}).
 *  - nothing legitimately long-lived rides this runner. Metro and the emulator
 *    — the two processes that genuinely stream for minutes — have their own
 *    spawns in companion-metro.ts and ci-device-boot.ts. Every caller here
 *    (agent-device subcommands, `adb`, `xcrun simctl`, `curl … -m 2`) is a
 *    bounded probe or a single device action.
 *
 * Known overrun, accepted: the settle gate's whole budget is 10s cold
 * (DEFAULT_SETTLE_GATE_COLD_MS) and 2.5s warm, so ONE wedged snapshot still
 * blows through the gate by up to ~50s before the run continues. Bounding at
 * the gate's own budget instead would start killing snapshots on a decayed-
 * but-working device, converting slow passes into false reds. Late and honest
 * beats fast and wrong; the gate is advisory either way.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Exit code a host-side timeout resolves with — GNU `timeout`'s own 124, so it
 * reads as what it is and can't be confused with the spawn-failure 127 the
 * `error` handler uses or with any exit code agent-device produces.
 */
export const COMMAND_TIMEOUT_EXIT_CODE = 124;

/** How long a killed child gets to die on SIGTERM before SIGKILL. */
const TIMEOUT_KILL_GRACE_MS = 2_000;

/**
 * Extra host budget over a command's OWN internal timeout. The host bound must
 * never be the thing that ends a wait the CLI was told to make — that would
 * report a timeout for a command doing exactly what it was asked to.
 */
const HOST_TIMEOUT_MARGIN_MS = 10_000;

/**
 * Host bound for a command carrying its own in-CLI timeout (`wait`, `alert
 * accept`). Returns undefined when the default already clears it with margin,
 * which is every call the driver makes today — so the common path passes no
 * `timeoutMs` at all and only an unusually long caller-supplied wait widens it.
 */
function hostTimeoutForInnerWait(innerMs: number): number | undefined {
  const needed = innerMs + HOST_TIMEOUT_MARGIN_MS;
  return needed > DEFAULT_COMMAND_TIMEOUT_MS ? needed : undefined;
}

/**
 * Wrap `run` so every command it spawns lands in `cwd` (see
 * {@link AgentDeviceOptions.cwd} for why agent-device cares). An explicit
 * per-call `cwd` still wins; no cwd returns the runner untouched, so the
 * un-configured path is byte-identical to before.
 */
function withCwd(run: CommandRunner, cwd: string | undefined): CommandRunner {
  if (!cwd) return run;
  return (bin, args, opts) => run(bin, args, { ...opts, cwd: opts?.cwd ?? cwd });
}

/** `e12` or `@e12` → `@e12`. Upstream mints plain bodies in diffs, `@`-prefixed elsewhere. */
function normalizeRef(ref: string): string {
  return ref.startsWith('@') ? ref : `@${ref}`;
}

export class AgentDeviceDriver implements NativeDriver {
  readonly platform: 'ios' | 'android';
  private readonly opts: AgentDeviceOptions;
  private readonly run: CommandRunner;
  private readonly bin: string;
  /**
   * The ref-frame epoch this driver last saw a settled diff mint refs from —
   * the `n` in `@e12~s<n>`. Per-INSTANCE (unlike the session registry): a
   * generation belongs to one stream of commands, and a second driver's
   * mutations invalidate it, so sharing it across instances would hand out pins
   * that name someone else's tree.
   */
  private refsGeneration?: number;
  /** Refs {@link refsGeneration} vouches for. Replaced wholesale by each settle. */
  private settleMintedRefs = new Set<string>();
  /** The settled diff of the most recent mutation (see {@link lastSettle}). */
  private lastSettleObservation?: SettleObservation;

  constructor(opts: AgentDeviceOptions) {
    this.opts = opts;
    this.platform = opts.platform;
    // Pinned at the RUNNER, not at each call site, so the cwd cannot be missed
    // by a path that builds its own RunOptions: the platform-CLI fallback, the
    // stale-claim `close --session`, and — the one that would have been easiest
    // to forget — the environment-diagnosis probes, which ride this same runner
    // and read `agent-device session list`, a command whose answer IS
    // cwd-scoped. With no cwd configured this is the original runner,
    // unwrapped.
    this.run = withCwd(opts.run ?? defaultRunner, opts.cwd);
    this.bin = opts.bin ?? DEFAULT_BIN;
  }

  get scheme(): string | undefined {
    return this.opts.scheme;
  }

  /** The target device/udid/serial this driver is pinned to, if any. */
  get device(): string | undefined {
    return this.opts.device;
  }

  /** The deep-link target for a component, using the same contract as web. */
  targetUrl(spec: TargetSpec): string {
    const target: NativeTarget = this.platform === 'ios' ? 'ios' : 'android';
    return buildTargetUrl(spec, {
      target,
      scheme: this.opts.scheme,
      expoHost: this.opts.expoHost,
    });
  }

  /**
   * Env that pins agent-device to the right device. With several devices
   * booted (an Android emulator + multiple iOS sims + a physical phone),
   * agent-device can't auto-pick — `AGENT_DEVICE_PLATFORM` narrows it, and an
   * explicit `device` udid narrows further.
   */
  private agentEnv(): Record<string, string> {
    const env: Record<string, string> = { AGENT_DEVICE_PLATFORM: this.platform };
    if (this.opts.device) env.AGENT_DEVICE_ID = this.opts.device;
    return env;
  }

  /**
   * `agent-device open <url>` BOTH starts the device session and opens the
   * deep link — agent-device requires an open session before screenshot /
   * snapshot ("Run open first"), so this is the session-establishing call.
   */
  openUrlCommand(url: string): PlannedCommand {
    return { bin: this.bin, args: ['open', url] };
  }

  openTargetCommand(spec: TargetSpec): PlannedCommand {
    return this.openUrlCommand(this.targetUrl(spec));
  }

  /** The dev-client control link that loads the companion bundle from Metro. */
  controlLinkCommand(metroUrl?: string): PlannedCommand {
    if (!this.opts.scheme) {
      throw new Error(
        'A custom URL scheme is required to cold-open the dev-client. ' +
          'Validity derives a companion-unique scheme automatically (prepareNativeApp); ' +
          "pass that app.scheme here. Do NOT reuse your own app's scheme — both apps " +
          'would register it and deep links would nondeterministically open the wrong one.',
      );
    }
    const url = buildDevClientLoadUrl(
      this.opts.scheme,
      metroUrl ?? this.opts.metroUrl ?? DEFAULT_METRO_URL,
    );
    return this.openUrlCommand(url);
  }

  dismissOverlayCommand(): PlannedCommand {
    return {
      bin: this.bin,
      args: this.opts.commands?.dismissOverlay ?? ['react-native', 'dismiss-overlay'],
    };
  }

  acceptAlertCommand(timeoutSec = 2): PlannedCommand {
    const prefix = this.opts.commands?.alert ?? ['alert', 'accept'];
    return { bin: this.bin, args: [...prefix, String(timeoutSec)] };
  }

  waitForRefCommand(ref: string, timeoutMs: number): PlannedCommand {
    const prefix = this.opts.commands?.wait ?? ['wait'];
    return { bin: this.bin, args: [...prefix, ref, String(timeoutMs)] };
  }

  screenshotCommand(path: string): PlannedCommand {
    const tpl = this.opts.commands?.screenshot ?? ['screenshot', '{path}'];
    return { bin: this.bin, args: tpl.map((a) => a.replace('{path}', path)) };
  }

  snapshotCommand(): PlannedCommand {
    return {
      bin: this.bin,
      args: this.opts.commands?.snapshot ?? defaultSnapshotArgsFor(this.platform),
    };
  }

  clickCommand(target: string): PlannedCommand {
    const override = this.opts.commands?.click;
    const prefix = override ?? DEFAULT_TAP_ARGS;
    return {
      bin: this.bin,
      args: [...prefix, this.pinTarget(target), ...this.settleFlags(override !== undefined)],
    };
  }

  typeCommand(ref: string, text: string, opts?: TypeOptions): PlannedCommand {
    const override = this.opts.commands?.type;
    const prefix = override ?? ['fill'];
    // Secret-safe recording. `fillRecordingFlags` is where the policy lives:
    // unarmed → nothing (argv unchanged); `@eNN` target → `--no-record`
    // (publication refuses session-local refs, so a recorded literal would buy
    // nothing and cost the whole script); portable selector + a secret → the
    // live text goes to the device while `${VAR}` goes to the `.ad`.
    //
    // Decided on the UNPINNED target: a pin (`@e12~s4`) is transport detail for
    // this one dispatch, and the recording policy is about what KIND of target
    // it is. `startsWith('@')` holds for both spellings, so the two agree today
    // — passing the raw ref keeps them agreeing if either side tightens.
    const record = fillRecordingFlags({
      armed: sessionRecordings.has(this.sessionKey()),
      target: ref,
      ...(opts?.recordAs ? { secretVar: opts.recordAs } : {}),
    });
    return {
      bin: this.bin,
      args: [
        ...prefix,
        this.pinTarget(ref),
        text,
        ...record,
        ...this.settleFlags(override !== undefined),
      ],
    };
  }

  /**
   * `agent-device diff snapshot -i --json` — the compact added/removed/changed
   * read against the session's last snapshot. Rung 2 of {@link postActionView}.
   */
  diffSnapshotCommand(): PlannedCommand {
    return { bin: this.bin, args: ['diff', 'snapshot', '-i', '--json', ...this.costFlags()] };
  }

  /**
   * `--settle` (+ its window/deadline, + `--json` so the settled diff is
   * PARSEABLE rather than prose) for a mutating command.
   *
   * `--json` is safe to add here and nowhere near the snapshot path: nothing
   * reads a tap's or a fill's stdout as text (callers branch on the exit code
   * only), whereas the a11y snapshot IS its stdout. Empty when settle is
   * disabled, which restores the pre-0.20.5 argv byte for byte.
   *
   * `overridden` empties it too, and that is the point of the parameter: a
   * `commands.click`/`commands.type` override exists precisely because the CLI
   * surface drifted out from under this driver, so decorating an argv Validity
   * does not recognise with flags it may not accept would turn an escape hatch
   * into a new failure. An override opts out of the settled diff and keeps
   * exactly the argv it asked for.
   */
  private settleFlags(overridden = false): string[] {
    if (overridden) return [];
    if (this.opts.settle === false) return [];
    return [
      '--settle',
      '--settle-quiet',
      String(this.opts.settleQuietMs ?? DEFAULT_SETTLE_QUIET_MS),
      '--timeout',
      String(this.opts.settleTimeoutMs ?? DEFAULT_ACTION_SETTLE_TIMEOUT_MS),
      '--json',
      ...this.costFlags(),
    ];
  }

  /** `--cost`, for commands whose stdout is parsed as JSON. See {@link AgentDeviceOptions.cost}. */
  private costFlags(): string[] {
    return this.opts.cost === false ? [] : ['--cost'];
  }

  /**
   * Pin a bare `@eNN` to the generation that minted it, when this driver KNOWS
   * that generation and knows the ref came from it.
   *
   * The knowledge is narrow on purpose. A plain-text `snapshot` does not print
   * its `refsGeneration` (only `--json` responses and the settle/find text
   * renderers carry it), so refs resolved out of the a11y snapshot stay
   * unpinned — exactly today's behavior. The refs this driver CAN vouch for are
   * the ones a settled diff minted from the settled tree, and those are pinned,
   * which is upstream's own advice: "prefer a known selector directly … or the
   * @ref from the latest snapshot/settle diff".
   *
   * Every unknown case returns the target unchanged. A guessed generation would
   * be worse than none: iOS rejects a mismatched pin before dispatch, so a wrong
   * guess would fail an action the device would have performed.
   */
  private pinTarget(target: string): string {
    if (!BARE_REF_RE.test(target)) return target;
    if (this.refsGeneration === undefined) return target;
    if (!this.settleMintedRefs.has(target)) return target;
    return pinRef(target, this.refsGeneration);
  }

  /**
   * Record what a settled diff just told us: the new ref-frame generation, and
   * WHICH refs were minted from it (added-line refs + the unchanged-interactive
   * tail, both of which upstream states are actionable on the settled tree).
   *
   * Replaces rather than merges — a ref minted two generations ago is exactly
   * the stale ref iOS rejects, so carrying it forward would re-create the
   * problem pinning exists to expose.
   */
  private noteSettle(settle: SettleObservation): void {
    this.lastSettleObservation = settle;
    if (settle.refsGeneration === undefined) return;
    this.refsGeneration = settle.refsGeneration;
    const refs = new Set<string>();
    for (const line of settle.lines) {
      if (line.kind === 'added' && line.ref) refs.add(normalizeRef(line.ref));
    }
    for (const entry of settle.tail) refs.add(normalizeRef(entry.ref));
    this.settleMintedRefs = refs;
  }

  scrollCommand(direction: 'up' | 'down'): PlannedCommand {
    const tpl = this.opts.commands?.scroll ?? ['scroll', '{direction}'];
    return { bin: this.bin, args: tpl.map((a) => a.replace('{direction}', direction)) };
  }

  /** Platform-native kill of the app process (simctl terminate / am force-stop). */
  terminateAppCommand(bundleId: string): PlannedCommand {
    if (this.platform === 'ios') {
      return {
        bin: 'xcrun',
        args: ['simctl', 'terminate', this.opts.device ?? 'booted', bundleId],
      };
    }
    const base = ['shell', 'am', 'force-stop', bundleId];
    return { bin: 'adb', args: this.opts.device ? ['-s', this.opts.device, ...base] : base };
  }

  /**
   * `dumpsys activity activities`, whose `topResumedActivity=` line names the
   * foreground `<package>/<activity>`. Android only — `xcrun simctl` exposes no
   * equivalent, so iOS callers get `undefined` and fall back to screen content.
   *
   * This is now the FALLBACK rung, behind {@link appstateCommand}. It is kept —
   * not deleted — for the reason it was written: it must stay answerable when
   * the agent-device session is exactly what is broken (a phantom claim, a cold
   * daemon), which is one of the states this probe is used to EXPLAIN. A
   * diagnosis that can only run when the thing being diagnosed is healthy is
   * not a diagnosis.
   */
  foregroundActivityCommand(): PlannedCommand {
    const base = ['shell', 'dumpsys', 'activity', 'activities'];
    return { bin: 'adb', args: this.opts.device ? ['-s', this.opts.device, ...base] : base };
  }

  /**
   * `agent-device appstate --json` — the foreground app/activity, straight from
   * the tool. Verified live on 0.20.3 (`emulator-5554`, 2026-07-30):
   *
   *     {"success":true,"data":{"platform":"android",
   *      "package":"ai.validity.playground",
   *      "activity":"ai.validity.playground.MainActivity"}}
   *
   * Preferred over the `dumpsys` scrape because it is a supported contract
   * rather than a regex over a debug dump whose format is Android's to change
   * (the existing parser already carries an `mResumedActivity` fallback for one
   * such change), and because it is device-selection aware.
   */
  appstateCommand(): PlannedCommand {
    return { bin: this.bin, args: ['appstate', '--platform', this.platform, '--json'] };
  }

  /** This driver's agent-device session identity (see {@link nativeSessionKey}). */
  private sessionKey(): string {
    return nativeSessionKey({
      platform: this.platform,
      device: this.opts.device,
      cwd: this.opts.cwd,
    });
  }

  /**
   * What the process-end close needs from THIS driver
   * (see {@link closeEstablishedNativeSessions}).
   *
   * The runner is the cwd-pinned one, and the close is UNQUALIFIED — the same
   * shape as the `open` that established the session, and deliberately NOT
   * `close --session default`.
   *
   * Read off the 0.20.5 dist (2026-08-24): a request with no `--session` is
   * scoped to the caller's cwd (the store key is `cwd:<sha256(gitRoot|cwd)
   * [0:16]>:default`, on disk `cwd_<hash>_default`), while passing `--session`
   * sets `sessionExplicit` and turns cwd scoping OFF entirely. So naming the
   * session Validity opened would address a DIFFERENT session — the global
   * `default` — which is precisely the 2026-07-28 state where a close reported
   * `Closed: default` and the device stayed claimed. The pinned cwd is the
   * session's identity here; the name the daemon minted is not knowable from
   * this side, and inventing one closes someone else's session.
   * ({@link releaseStaleClaimAndRetryOpen} closes BY NAME because upstream
   * handed it one in the refusal text — a name is used when given, never
   * guessed.)
   */
  private closeRecord(): EstablishedSession {
    const remote = this.opts.remoteConfigPath;
    return {
      run: this.run,
      bin: this.bin,
      env: this.agentEnv(),
      trailingArgs: remote ? ['--remote-config', remote] : [],
    };
  }

  /**
   * Keep a command OUT of the armed `.ad`.
   *
   * Applied centrally rather than in each command builder on purpose: the
   * publication guard refuses a script containing a second `open`, a `close`,
   * or any `@eNN`-targeted step, and Validity issues all three routinely
   * (per-capture deep links, the dev-menu ref-click, the check executor's
   * ref-targeted click/fill). A builder-by-builder opt-out is a rule you can
   * forget; suppressing here means the ONLY commands that can enter a recording
   * are the two that explicitly opt in — the establishing `open` and the
   * destination guard.
   *
   * Three things it must not do, hence the three guards:
   *   - touch a non-agent-device bin (adb/xcrun reject unknown flags);
   *   - fire when nothing is armed (an unrecorded run keeps its exact argv);
   *   - collide with `--record-as`, which upstream rejects alongside
   *     `--no-record` because no step would be published at all.
   */
  private suppressRecording(cmd: PlannedCommand): PlannedCommand {
    if (cmd.bin !== this.bin) return cmd;
    if (!sessionRecordings.has(this.sessionKey())) return cmd;
    if (cmd.args.includes(NO_RECORD_FLAG) || cmd.args.includes('--record-as')) return cmd;
    return { ...cmd, args: [...cmd.args, NO_RECORD_FLAG] };
  }

  /**
   * Append the user's remote profile to an agent-device command
   * (see {@link AgentDeviceOptions.remoteConfigPath}).
   *
   * Applied centrally, for the same reason recording suppression is: `help
   * remote` says to pass the same `--remote-config` to EVERY operational
   * command, and a per-builder opt-in is a rule you can forget — the command
   * that forgets it silently addresses the LOCAL daemon while the rest of the
   * sweep drives a cloud device. Never touches `adb`/`xcrun` (they would reject
   * the flag), and never doubles up.
   */
  private withRemoteConfig(cmd: PlannedCommand): PlannedCommand {
    const path = this.opts.remoteConfigPath;
    if (!path) return cmd;
    if (cmd.bin !== this.bin) return cmd;
    if (cmd.args.includes('--remote-config')) return cmd;
    return { ...cmd, args: [...cmd.args, '--remote-config', path] };
  }

  private async exec(planned: PlannedCommand, timeoutMs?: number): Promise<ExecResult> {
    const cmd = this.withRemoteConfig(this.suppressRecording(planned));
    // `timeoutMs` is omitted rather than passed as undefined so an unwidened
    // command's RunOptions stay exactly what they were: this object is what
    // every injected/faked runner is asserted against.
    const res = await this.run(cmd.bin, cmd.args, {
      env: this.agentEnv(),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    // SELF-HEALING EVICTION. A session can die under a run (the daemon is
    // killed, the device is reset), and a registry that only ever grows would
    // then assert readiness for a session that is gone — turning the gate into
    // the very silence it removes. Any command answering agent-device's
    // no-session signature is proof, so drop the key and let the next
    // ensureSession re-open. Non-zero exit is NOT required: agent-device is
    // free to report this in a `{ok:false}` JSON body on exit 0.
    if (cmd.bin === this.bin && NO_SESSION_SIGNATURE.test(`${res.stderr}\n${res.stdout}`)) {
      establishedSessions.delete(this.sessionKey());
    }
    if (cmd.bin !== this.bin) return res;
    // ADDITIVE READS off the same stdout, both best-effort and both silent on
    // anything they cannot parse: a settled diff (only ever present on a
    // `--settle` mutation) and the daemon's own wall-clock for this command.
    // Nothing branches on either — they are evidence and instrumentation.
    const settle = parseSettleJson(res.stdout);
    if (settle) this.noteSettle(settle);
    const costMs = parseCommandCostMs(res.stdout);
    if (costMs !== undefined) noteCommandCost(costMs);
    return {
      ...res,
      ...(settle ? { settle } : {}),
      ...(costMs === undefined ? {} : { costMs }),
    };
  }

  /**
   * Open a URL via `agent-device open`, falling back to the PLATFORM-NATIVE
   * deep-link command when that fails.
   *
   * This is the module header's stated design finally being honored: opening a
   * target rides `xcrun simctl openurl` / `adb … VIEW -d <url>`, which are
   * rock-solid, while `agent-device open` is kept because it ALSO establishes
   * the session that `snapshot`/`wait` require ("Run open first").
   *
   * The failure it exists for is deterministic and upstream. On Android, only
   * the FIRST `agent-device open` of a session works; every later one exits 127:
   *
   *     $ agent-device open 'validity://…?component=…&token=r1'   → Opened: …
   *     $ agent-device open 'validity://…?component=…&token=r2'
   *       Error (COMMAND_FAILED): /system/bin/sh: -p: inaccessible or not found
   *
   * Reproduced on agent-device 0.20.1 against an API 35 emulator, from a
   * freshly-restarted daemon, with the identical URL — while the equivalent
   * `adb shell am start -a android.intent.action.VIEW -d <url>` succeeds every
   * time. A verify sweep re-targets constantly, so from the second capture
   * onward every deep-link rung was failing and its spec reported
   * "no mechanical verdict produced" — a whole sweep of silence for a device
   * that was working fine.
   *
   * The session survives the failed call (`snapshot` still answers immediately
   * afterwards), so falling back costs nothing downstream.
   *
   * FAILURE-PATH ONLY, both platforms: it cannot change what a successful
   * `agent-device open` already does, so it can only convert a hard error into
   * a working open. If agent-device fixes the bug, this simply stops firing.
   *
   * Caveat worth knowing: when the FIRST open of a session is the one that
   * fails, the fallback still delivers the deep link but no agent-device
   * session exists, so a later `snapshot` reports SESSION_NOT_FOUND and the
   * capture degrades to `unconfirmed`. That is strictly better than today's
   * hard failure, and it is still honest — never a false verdict.
   * {@link ensureSession} is what turns that caveat from a silent degrade into
   * a named one, which is why {@link openUrlAttempt} keeps the agent-device
   * result the fallback would otherwise discard.
   */
  private async openUrlWithNativeFallback(url: string): Promise<ExecResult> {
    return (await this.openUrlAttempt(url)).result;
  }

  /**
   * The open, with BOTH outcomes kept: `result` is what the caller acts on (the
   * platform-CLI fallback's success included), `viaAgent` is what agent-device
   * itself said. They differ exactly when the fallback rescued a failed
   * `agent-device open` — the case where the deep link lands but no session
   * exists, and where reporting `result` alone hands the diagnosis a code-0
   * result with empty streams to reason from.
   */
  private async openUrlAttempt(
    url: string,
    arm = false,
  ): Promise<{ result: ExecResult; viaAgent: ExecResult }> {
    noteDeviceOpen();
    const open = arm ? this.armedOpenCommand(url) : this.openUrlCommand(url);
    const firstTry = await this.exec(open);
    // Only an `agent-device open` that RETURNED 0 proves a session exists. The
    // platform-CLI fallback below deliberately does not record one — that is
    // the whole caveat this method documents, and treating it as established
    // would re-create the bug the registry exists to close.
    if (firstTry.code === 0) {
      establishedSessions.set(this.sessionKey(), this.closeRecord());
      this.noteArmed(open);
      return { result: firstTry, viaAgent: firstTry };
    }
    // ARMING REFUSED ON A REUSED SESSION. `establishedSessions` is per-process,
    // but the daemon's session outlives a failed run (Validity never closes its
    // verify session) — so the RETRY after a failure is exactly where an armed
    // open meets an existing session and 0.20.3 refuses it (INVALID_ARGS: "can
    // only arm a fresh session"). Take upstream's own first suggestion: reuse
    // the session without --save-script. The open is the one command that must
    // never fail for a cosmetic reason, and a run without a recording is a
    // normal run; closing instead could tear down a session a live watch/MCP
    // process owns. Re-entering unarmed keeps the full recovery ladder
    // (stale-claim release, platform-CLI fallback, diagnosis) for the retry.
    if (arm && isFreshSessionArmRefusal(`${firstTry.stderr}\n${firstTry.stdout}`)) {
      console.warn(
        '[validity] `.ad` recording skipped: the agent-device session was already open ' +
          '(likely left by an earlier run), and only a fresh session can be armed — reusing it',
      );
      return this.openUrlAttempt(url, false);
    }
    // A claim that outlived its own `close` is releasable in-band — try that
    // before the platform CLI, because the fallback opens WITHOUT an
    // agent-device session and every later snapshot/wait then reports
    // SESSION_NOT_FOUND. A recovered open keeps the session.
    const viaAgent = (await this.releaseStaleClaimAndRetryOpen(firstTry, url, arm)) ?? firstTry;
    if (viaAgent.code === 0) {
      establishedSessions.set(this.sessionKey(), this.closeRecord());
      this.noteArmed(open);
      return { result: viaAgent, viaAgent };
    }
    const native = openUrlCommand(url, this.platform, this.opts.device);
    const viaNative = await this.run(native.bin, native.args, { env: this.agentEnv() });
    if (viaNative.code !== 0) {
      // BOTH paths failed — the run is over for this target and, historically,
      // this is where the developer got "no mechanical verdict produced" with
      // no idea why. Keep surfacing the ORIGINAL agent-device error (it is the
      // more specific of the two) and ATTACH a cause: a phantom device claim, a
      // dead daemon, a stale CLI, a device that was never ready. Best-effort
      // and non-throwing — the failure is already the failure; the diagnosis
      // just stops it from being silent. Probes ride THIS driver's runner, so
      // an injected/faked runner (tests) never reaches a real device.
      const diagnosis = await diagnoseNativeEnvironment({
        run: this.run,
        platform: this.platform,
        openErrorText: `${viaAgent.stderr}\n${viaAgent.stdout}\n${viaNative.stderr}`,
        projectRoot: this.opts.projectRoot,
      }).catch(() => undefined);
      const failed = diagnosis ? { ...viaAgent, diagnosis } : viaAgent;
      return { result: failed, viaAgent: failed };
    }
    return { result: viaNative, viaAgent };
  }

  /**
   * Release a stale device claim named by a refused open, then retry the open
   * EXACTLY ONCE. Returns the retry's result, or undefined when the failure was
   * not an in-use refusal (nothing was run in that case).
   *
   * The state this recovers was captured live on 2026-07-28: `agent-device
   * close` printed `Closed: default` and the very next `open` was refused with
   * `Device is already in use by session "default"`, while `session list` still
   * showed a bare `default` session next to the cwd-scoped
   * `cwd_<hash>_default` one the CLI was writing to. Sessions are keyed by CWD,
   * so the unqualified close closed the wrong one and reported success;
   * `agent-device close --session default` released the claim and the next open
   * succeeded, with no daemon kill needed.
   *
   * ONE attempt, no loop. If the retry fails too, the caller falls through to
   * the platform-CLI fallback and the diagnosis path exactly as before — a
   * device that is genuinely held by a live session must not be closed out from
   * under its owner repeatedly, and a recovery that can spin is worse than the
   * failure it is healing.
   *
   * SILENT since 2026-07-30, when {@link MIN_AGENT_DEVICE_VERSION} rose to
   * 0.20.3. Upstream fixed claim GC in 0.20.2 — `close` now releases the device
   * claim, verified live by watching `~/.agent-device/device-claims/` go from
   * one file to zero across a single `close`. So at or above the floor this
   * retry is pure defense-in-depth against a state that should no longer occur,
   * and the `console.warn` it used to print was, in practice, fired at people
   * running a BELOW-floor agent-device — who now get the readiness checklist's
   * `agent-device CLI` row telling them to upgrade, which is a better channel
   * than a warning mid-capture that names a session they never created. The
   * retry stays because it is nearly free and the failure it heals is total
   * (every open refused); the noise goes because a recovery that works is not
   * news, and one that does not still surfaces through the normal failure +
   * diagnosis path below.
   */
  private async releaseStaleClaimAndRetryOpen(
    failed: ExecResult,
    url: string,
    arm = false,
  ): Promise<ExecResult | undefined> {
    const session = parseInUseSessionName(`${failed.stderr}\n${failed.stdout}`);
    if (!session) return undefined;
    await this.exec({ bin: this.bin, args: ['close', '--session', session] });
    noteDeviceOpen();
    // The retry re-arms: the refused first attempt never reached the daemon, so
    // nothing was recorded and this open is still the session's FIRST one.
    return this.exec(arm ? this.armedOpenCommand(url) : this.openUrlCommand(url));
  }

  async openUrl(url: string): Promise<ExecResult> {
    return this.openUrlWithNativeFallback(url);
  }

  /* ---------------------------------------------------------------- *
   * `.ad` replay recording. See replay-recording.ts for the contract.  *
   * ---------------------------------------------------------------- */

  /** Should THIS driver arm the session-establishing open? */
  private shouldArmRecording(): boolean {
    return Boolean(this.opts.recordingPath) && !sessionRecordings.has(this.sessionKey());
  }

  /** The session-establishing `open`, with `--save-script` attached. */
  armedOpenCommand(url: string): PlannedCommand {
    const base = this.openUrlCommand(url);
    const path = this.opts.recordingPath;
    return path ? { ...base, args: [...base.args, ...armRecordingFlags(path)] } : base;
  }

  /**
   * Register the recording once the arming open has actually returned 0. Keyed
   * off the ARGV rather than a flag, so a retry that lost its arming (or a
   * driver with no `recordingPath`) can never register a recording that was
   * never requested.
   */
  private noteArmed(open: PlannedCommand): void {
    const path = this.opts.recordingPath;
    if (!path) return;
    if (!open.args.includes('--save-script')) return;
    if (sessionRecordings.has(this.sessionKey())) return;
    sessionRecordings.set(this.sessionKey(), { path, published: false });
  }

  /** The recording this session armed, if any (undefined = nothing to publish). */
  recordingState(): SessionRecording | undefined {
    return sessionRecordings.get(this.sessionKey());
  }

  /**
   * Kill this session's recording for good, with a reason.
   *
   * The FAIL-CLOSED half of secret-safe recording: a caller that has just
   * driven a step which must not be published (a secret that would have landed
   * in the `.ad` literally, a placeholder whose value could not be resolved)
   * calls this, and every later {@link publishRecording} refuses with the
   * reason instead of writing a script that is quietly unsafe.
   *
   * One-way and idempotent — the FIRST reason is kept, because it names what
   * actually made the recording unsafe; a later, vaguer one must not overwrite
   * it. A no-op when nothing was armed: there is no recording to abandon, and
   * inventing one would make `recordingState()` report a recording that never
   * existed.
   */
  abandonRecording(reason: string): void {
    const state = this.recordingState();
    if (!state) return;
    if (state.abandoned) return;
    sessionRecordings.set(this.sessionKey(), { ...state, abandoned: reason });
  }

  /**
   * Record the DESTINATION GUARD — a selector wait on the id-bearing render
   * marker — so the published script ends on a landmark whose identity replay
   * can re-verify. Deliberately a SECOND wait rather than a reshaping of the
   * existing render-marker wait: that one is a bare positional and records as a
   * text wait (which does not qualify), and rewriting it would put a
   * publication concern inside the gate that decides whether a render happened.
   *
   * Best-effort and never a verdict: a guard that does not resolve simply means
   * this run publishes no recording. Returns false when nothing was armed, when
   * the recording is already published, or when the wait failed.
   */
  async recordDestinationGuard(marker: string, timeoutMs: number): Promise<boolean> {
    const state = this.recordingState();
    if (!state || state.published) return false;
    // NOT routed through `exec`'s suppression — this is one of exactly two
    // commands that are supposed to land in the script.
    const cmd: PlannedCommand = { bin: this.bin, args: destinationGuardArgs(marker, timeoutMs) };
    const res = await this.run(cmd.bin, cmd.args, {
      env: this.agentEnv(),
      ...(hostTimeoutForInnerWait(timeoutMs) === undefined
        ? {}
        : { timeoutMs: hostTimeoutForInnerWait(timeoutMs) as number }),
    });
    return res.code === 0;
  }

  /**
   * Publish the armed script WITHOUT closing the session (`session
   * save-script`). See the module header of replay-recording.ts for why closing
   * is not an option here. Idempotent: once published, later calls no-op.
   */
  async publishRecording(): Promise<RecordingPublication & { path?: string }> {
    const state = this.recordingState();
    if (!state) return { published: false, reason: 'no recording was armed for this session' };
    // ABANDONED: refuse, and say why. Checked before the `published` short
    // circuit is irrelevant (a published recording was never abandoned) but
    // before the command absolutely matters — publishing an unsafe script and
    // then reporting the reason would be the opposite of fail-closed.
    if (state.abandoned) {
      return { published: false, reason: state.abandoned, path: state.path };
    }
    if (state.published) return { published: true, path: state.path };
    const res = await this.exec({ bin: this.bin, args: publishRecordingArgs(state.path) });
    const outcome = classifyRecordingPublish(res);
    if (outcome.published) sessionRecordings.set(this.sessionKey(), { ...state, published: true });
    return { ...outcome, path: state.path };
  }

  /**
   * Re-execute a published recording. ATTACH-ONLY by construction: this issues
   * `agent-device replay <path>` and nothing else — no boot, no install. The
   * caller (`validity replay`) is responsible for proving a booted device and a
   * current companion BEFORE calling, because `replay` will otherwise happily
   * boot a simulator on its own.
   *
   * `opts` carries the 0.20.5 invocation surface: `--keep-session` (suppress an
   * authored terminal close and hand the live session back to the caller) and
   * `-e NAME=value` pairs (the live values behind a secret-safe recording's
   * `${NAME}` placeholders). `secrets` is passed to the classifier so those
   * values are redacted out of anything the outcome quotes. An invocation with
   * NO options is byte-identical to the pre-0.20.5 argv.
   */
  async replayRecording(
    path: string,
    opts: DriverReplayOptions = {},
  ): Promise<AgentDeviceReplayResult> {
    const res = await this.exec({ bin: this.bin, args: replayRecordingArgs(path, opts) });
    return classifyAgentDeviceReplay(res, opts.secrets ?? []);
  }

  /**
   * Establish the agent-device session if this process has not already done so
   * (see {@link NativeDriver.ensureSession} for WHY this is separate from
   * opening a target, and {@link establishedSessions} for why the record is
   * process-wide rather than per-instance).
   *
   * Rides {@link openUrlWithNativeFallback} rather than a bare `open`, so it
   * inherits — for free — the stale-claim release + single retry, the
   * platform-CLI fallback (which still delivers the deep link when agent-device
   * refuses), and the host command timeout. What it adds is a HONEST answer
   * about the session: the fallback's success does not count, because a deep
   * link delivered by `xcrun simctl openurl` leaves `snapshot`/`wait`/
   * `screenshot` with nothing to talk to.
   *
   * Never throws: a driver failure here must degrade the run to an honest
   * `unconfirmed`, never replace it with a stack trace.
   */
  async ensureSession(url: string): Promise<NativeSessionReadiness> {
    if (establishedSessions.has(this.sessionKey())) {
      return { ready: true, via: 'already-open' };
    }
    let viaAgent: ExecResult;
    try {
      // THIS is the session-establishing open, so this is the one — and the
      // only one — that may arm the `.ad` recording.
      viaAgent = (await this.openUrlAttempt(url, this.shouldArmRecording())).viaAgent;
    } catch (err) {
      return { ready: false, via: 'failed', errorText: String((err as Error)?.message ?? err) };
    }
    if (establishedSessions.has(this.sessionKey())) return { ready: true, via: 'opened' };
    // Report what AGENT-DEVICE said, not what the fallback returned: the
    // fallback's success is the whole problem here, and its result carries a
    // code 0 with empty streams that the diagnosis cannot reason from.
    const streams = `${viaAgent.stderr}\n${viaAgent.stdout}`.trim();
    return {
      ready: false,
      via: 'failed',
      errorText:
        streams ||
        '`agent-device open` did not establish a session (the deep link was delivered by the ' +
          'platform CLI fallback instead), so no session-scoped command can run',
      ...(viaAgent.diagnosis ? { diagnosis: viaAgent.diagnosis } : {}),
    };
  }

  async openTarget(spec: TargetSpec): Promise<ExecResult> {
    return this.openUrlWithNativeFallback(this.targetUrl(spec));
  }

  async openControlLink(metroUrl?: string): Promise<ExecResult> {
    // Deliberately NOT falling back: the control link is what boots the
    // dev-client and establishes the session in the first place, so there is no
    // session for a native-only open to ride on — and a control link delivered
    // without a session leaves every later snapshot/wait blind.
    return this.exec(this.controlLinkCommand(metroUrl));
  }

  async dismissOverlay(): Promise<ExecResult> {
    return this.exec(this.dismissOverlayCommand());
  }

  async terminateApp(bundleId: string): Promise<ExecResult> {
    return this.exec(this.terminateAppCommand(bundleId));
  }

  async click(target: string): Promise<ExecResult> {
    // Cleared FIRST so `lastSettle()` can never answer with the previous
    // action's diff when this one returns none (settle disabled, an older
    // binary, an upstream decline). A stale settled diff read as "what this tap
    // changed" would be fabricated evidence.
    this.lastSettleObservation = undefined;
    return this.exec(this.clickCommand(target));
  }

  async inputText(ref: string, text: string, opts?: TypeOptions): Promise<ExecResult> {
    this.lastSettleObservation = undefined;
    return this.exec(this.typeCommand(ref, text, opts));
  }

  async scroll(direction: 'up' | 'down'): Promise<ExecResult> {
    // `scroll` takes no `--settle` in 0.20.5 (SettleCommandOptions covers
    // press/click/fill/longpress only), so it clears the previous observation
    // and adds none of its own — the screen moved, and no settled diff
    // describes it.
    this.lastSettleObservation = undefined;
    return this.exec(this.scrollCommand(direction));
  }

  /** The settled diff of the most recent mutation, if it produced one. */
  lastSettle(): SettleObservation | undefined {
    return this.lastSettleObservation;
  }

  /**
   * The post-action view of the screen, cheapest rung first (see
   * {@link PostActionView}):
   *
   *   1. the SETTLED DIFF the last mutation already returned — free, and the
   *      loop 0.20.5 documents as the default ("continue from that settled
   *      diff");
   *   2. `diff snapshot -i` — one bounded command, "only the added/removed/
   *      changed lines since the last snapshot in this session";
   *   3. a full `snapshot` — the legacy path, and the ONLY rung that may be
   *      used to conclude something is absent (`complete: true`).
   *
   * Rungs 1 and 2 are skipped when they have nothing to say: a settle that did
   * not settle, or a `diff` that just initialized its baseline, would otherwise
   * hand back an empty view that reads like an empty screen.
   */
  async postActionView(): Promise<PostActionView> {
    const settle = this.lastSettleObservation;
    if (settle?.settled) {
      const text = renderSettleAsSnapshotText(settle);
      if (text.trim() !== '') {
        return {
          source: 'settled-diff',
          text,
          complete: false,
          settled: true,
          ...(settle.refsGeneration === undefined ? {} : { refsGeneration: settle.refsGeneration }),
        };
      }
    }
    const diff = await this.exec(this.diffSnapshotCommand()).catch(() => undefined);
    if (diff?.code === 0) {
      const text = parseDiffSnapshotJson(diff.stdout);
      if (text !== undefined && text.trim() !== '') {
        return { source: 'diff-snapshot', text, complete: false };
      }
    }
    return { source: 'full-snapshot', text: await this.snapshot(), complete: true };
  }

  async dismissDevMenu(): Promise<boolean> {
    const labels = this.opts.devMenuLabels ?? defaultDevMenuLabelsFor(this.platform);
    const snap = await this.snapshot();
    // POSITIVE detection first: without the dev menu/launcher actually on
    // screen, the snapshot is of the rendered component — and the dismiss
    // labels below ('close', 'continue', …) are exactly what user modals /
    // onboarding flows name their own buttons. Clicking one would mutate the
    // state under verification before the screenshot, so no anchors → no-op.
    if (!snapshotShowsDevMenu(snap, this.opts.devMenuAnchorLabels)) return false;
    // ANDROID: no label on the SDK-55 sheet dismisses it — 'Reload' is excluded
    // from the label list on purpose (see ANDROID_DEV_MENU_LABELS: it rebuilds
    // the React context, which re-opens the menu), and the sheet exposes no
    // close action at all. So this method deliberately clicks NOTHING on
    // Android and returns false. The dismissal that works is the companion's
    // own `ExpoDevMenu.closeMenu()`, pushed over the control bridge — see
    // makeDevMenuDismisser, which tries the bridge FIRST on both platforms and
    // only falls back here.
    //
    // BACK is not, and must not become, the fallback: it was tried and
    // reverted because once the menu is gone a BACK lands on the app root and
    // exits to the launcher (observed on an API 35 emulator — the app dropped
    // to the home screen mid-verify). A dismissal that can navigate the app
    // out from under the run is worse than no dismissal, because the run's own
    // evidence then describes the launcher.
    const ref = findDismissRef(snap, labels);
    if (!ref) return false;
    const res = await this.click(ref);
    return res.code === 0;
  }

  async acceptAlert(timeoutSec = 2): Promise<ExecResult> {
    return this.exec(
      this.acceptAlertCommand(timeoutSec),
      hostTimeoutForInnerWait(timeoutSec * 1000),
    );
  }

  async waitForRef(ref: string, timeoutMs: number): Promise<ExecResult> {
    return this.exec(this.waitForRefCommand(ref, timeoutMs), hostTimeoutForInnerWait(timeoutMs));
  }

  async screenshot(path: string): Promise<ExecResult> {
    return this.exec(this.screenshotCommand(path));
  }

  async snapshot(): Promise<string> {
    const res = await this.exec(this.snapshotCommand());
    return res.stdout;
  }

  waitStableCommand(quietMs: number, timeoutMs: number): PlannedCommand {
    // Positionals then flags, per agent-device's documented command shape:
    //   agent-device wait stable [quietMs] [timeoutMs]
    return {
      bin: this.bin,
      args: ['wait', 'stable', String(quietMs), String(timeoutMs), '--json', ...this.costFlags()],
    };
  }

  async waitStable(quietMs: number, timeoutMs: number): Promise<WaitStableOutcome> {
    const res = await this.exec(
      this.waitStableCommand(quietMs, timeoutMs),
      hostTimeoutForInnerWait(timeoutMs),
    );
    // A timed-out wait still prints a payload, so the exit code — not the
    // presence of data — decides `settled`. Stats are best-effort colour: a
    // wait that worked is still a working wait if the JSON shape drifts.
    return { ...parseWaitStableJson(res.stdout), settled: res.code === 0 };
  }

  /**
   * Run one agent-device verb in this driver's session — see
   * {@link NativeDriver.runInSession}. Deliberately NOT a general escape hatch
   * for other bins: `bin` is this driver's agent-device, so a caller cannot use
   * it to reach adb/xcrun and bypass the platform plumbing.
   */
  async runInSession(args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
    return this.exec({ bin: this.bin, args }, opts.timeoutMs);
  }

  sessionEventsCommand(): PlannedCommand {
    return { bin: this.bin, args: ['events', '--json'] };
  }

  async sessionEvents(): Promise<AgentDeviceEvent[]> {
    const res = await this.exec(this.sessionEventsCommand()).catch(() => undefined);
    if (!res || res.code !== 0) return [];
    return parseAgentDeviceEventsJson(res.stdout);
  }

  capabilitiesCommand(): PlannedCommand {
    return {
      bin: this.bin,
      args: ['capabilities', '--platform', this.platform, '--json', ...this.costFlags()],
    };
  }

  async capabilities(): Promise<CapabilityProbe | undefined> {
    const res = await this.exec(this.capabilitiesCommand());
    if (res.code !== 0) return undefined;
    return parseCapabilitiesJson(res.stdout);
  }

  async foregroundActivity(): Promise<string | undefined> {
    // Android-only BY CONTRACT, not by accident, and deliberately unchanged now
    // that `appstate` can also answer on iOS. `deviceOnDevLauncherHome` treats a
    // non-undefined answer as authoritative in BOTH directions and skips its
    // a11y-copy rung; an iOS bundle id would always parse as "not the dev
    // launcher", silently disabling launcher detection on the platform where
    // the copy signature is the only real evidence. iOS keeps answering
    // undefined so it keeps falling through to that check.
    if (this.platform !== 'android') return undefined;
    // agent-device first, dumpsys second. Both are best-effort; `undefined`
    // means NO ANSWER, never "nothing is foreground".
    const viaAgent = await this.exec(this.appstateCommand()).catch(() => undefined);
    if (viaAgent?.code === 0) {
      const parsed = parseAppstateJson(viaAgent.stdout);
      if (parsed) return parsed;
    }
    const res = await this.exec(this.foregroundActivityCommand());
    if (res.code !== 0) return undefined;
    return parseTopResumedActivity(res.stdout);
  }
}

/**
 * Default runner — spawns the command, collects stdout/stderr, and bounds it in
 * wall-clock time (see {@link DEFAULT_COMMAND_TIMEOUT_MS}).
 *
 * The timeout resolves; it does not reject and it does not wait for the kill to
 * land. Both are deliberate: callers here read an ExecResult as evidence (a
 * rejection would be an unhandled throw on a path whose whole bug was hanging),
 * and a caller freed at T+timeout only to block on a child ignoring SIGTERM
 * would have re-created the hang it was rescued from. The SIGKILL escalation
 * therefore runs unattended, mirroring the verified kill in companion-metro.ts.
 */
export const defaultRunner: CommandRunner = async (bin, args, opts) => {
  const { spawn } = await import('node:child_process');
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const startedAt = Date.now();
  return new Promise<ExecResult>((resolveExec) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (res: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveExec(res);
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const elapsed = Date.now() - startedAt;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_KILL_GRACE_MS);
        killTimer.unref?.();
        // Omit argv (fills can contain secrets). This string is what a
        // developer (and the diagnosis paths that quote openErrorText) will have
        // to reason from: it must not read like a device verdict.
        finish({
          code: COMMAND_TIMEOUT_EXIT_CODE,
          stdout,
          stderr:
            (stderr ? `${stderr}\n` : '') +
            `[validity] host timeout after ${elapsed}ms: command ` +
            `never exited, so it was killed (SIGTERM, then SIGKILL). This bound is ` +
            `enforced by Validity on the HOST, not by the device — it means the command ` +
            `stopped responding (a wedged agent-device daemon or device is the usual ` +
            `cause), NOT that the UI under test failed.`,
        });
      }, timeoutMs);
      timer.unref?.();
    }
    child.stdout?.on('data', (d) => (stdout += String(d)));
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) => finish({ code: 127, stdout, stderr: stderr + String(err) }));
    child.on('close', (code) => {
      // A child that died to the SIGTERM above has nothing left to escalate to.
      if (killTimer) clearTimeout(killTimer);
      finish({ code: code ?? 0, stdout, stderr });
    });
  });
};
