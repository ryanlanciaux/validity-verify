/**
 * `.ad` replay recordings — the native half of the trust story.
 *
 * A web run is replayable because the sandbox can be rebuilt from source. A
 * NATIVE run had nothing equivalent: the evidence was a screenshot and an a11y
 * snapshot taken on a device that no reviewer has. agent-device 0.20.x closes
 * that gap — it can record a session as a portable `.ad` script and re-execute
 * it later with LANDMARK VERIFICATION, i.e. it re-checks the recorded element's
 * identity rather than merely finding something with the same label.
 *
 * So a native verify now leaves an `open-to-destination` script beside its
 * screenshots: "deep-link to this component and prove its render marker
 * appeared". `validity replay` re-runs it. That is a real, hostile-reviewer
 * artifact — and the whole reason it can be trusted is that its sha256 joins
 * the run's attestation (`attestRecording` in `@validity.ai/verify-spec`), so replaying a
 * swapped script is not possible without the swap being named.
 *
 * ---------------------------------------------------------------------------
 * THE UPSTREAM CONTRACT THIS MODULE ENCODES
 * ---------------------------------------------------------------------------
 * Read off `agent-device help workflow` and the 0.20.3 binary's own publication
 * guard (`snapshot-diagnostics.js`), and RE-VERIFIED against the 0.20.5
 * reference (`agent-device help workflow` + `replay --help`, captured
 * 2026-08-06) — all four rules below are unchanged in 0.20.5. Every rule is a
 * hard refusal at publish time, not a style preference:
 *
 *   1. EXACTLY ONE recorded `open`, and it must be the FIRST recorded step.
 *      "A second successful open aborts publication." Validity re-opens
 *      constantly (one deep link per capture, plus the dev-client control
 *      link), so every open except the session-establishing one must carry
 *      `--no-record`.
 *   2. NO recorded `close`. Publication of an active session refuses a script
 *      containing one. Nothing on the capture path closes a verify session (the
 *      one close Validity issues runs at PROCESS END, after publication — see
 *      RECORDING LIFECYCLE below), which is what makes `session save-script`
 *      the right publish verb.
 *   3. NO recorded step may target a session-local `@eNN` ref — "the
 *      session-local ref was not converted to a portable selector". Validity's
 *      check executor clicks and fills BY REF (they come from a live snapshot),
 *      and so does the dev-menu dismisser. All of them are therefore
 *      `--no-record`.
 *   4. A DESTINATION GUARD must be the last thing after the final mutating
 *      action: a selector `wait` on a labeled or id-bearing landmark. A
 *      duration wait, `wait stable`, `wait @ref`, or a selector wait on an
 *      unlabeled element does NOT qualify.
 *
 * Rule 4 is why {@link destinationGuardArgs} exists at all. Validity already
 * waits for the render marker — but as `wait validity-root:<token>`, a BARE
 * positional, and agent-device's wait parser falls through to `{kind:'text'}`
 * for anything that is not a selector expression, `@ref`, `stable`, or a
 * duration. A text wait is not a destination guard, so the existing wait does
 * not qualify and a second, explicitly-selector-shaped wait is recorded. It
 * targets the same marker by `id=` — the harness renders it as BOTH a `testID`
 * and an `accessibilityLabel` (see native-root-template), so the node is
 * id-bearing and landmark identity can be captured.
 *
 * ---------------------------------------------------------------------------
 * RECORDING LIFECYCLE: `session save-script`, not `close --save-script`
 * ---------------------------------------------------------------------------
 * Validity never issues `agent-device close` ANYWHERE ON THIS PATH. The session
 * is established once per PROCESS (`establishedSessions` in
 * agent-device-driver.ts) and deliberately outlives every capture, because
 * `verify --all` builds a fresh driver per spec and re-opening per spec is the
 * exact cost that registry exists to avoid.
 *
 * The full close contract, since 2026-08-24: never per capture, never per spec,
 * and never before publication — but ONCE at the end of the process, after any
 * `session save-script`, via `closeEstablishedNativeSessions`. That teardown is
 * what hands the DEVICE CLAIM back; without it every run left a claim file
 * behind whose daemon later exited, and the next run's readiness pass reported
 * a phantom claim. It cannot reach a recording: it runs outside the driver, on
 * a registry the publication path has already been served from. The other
 * `close` in the codebase is the stale-claim recovery, which closes a session
 * that is already wedged.
 *
 * `close --save-script` would therefore mean ENDING the shared session mid-run
 * to publish a file — tearing down the device claim and the iOS XCTest runner
 * under the remaining specs. `session save-script [path] --force` publishes the
 * armed script WITHOUT teardown, which is precisely the shape Validity needs.
 *
 * ONE RECORDING PER SESSION, and that is an upstream constraint, not a choice:
 * rule 1 above means a session can only ever author one open-to-destination
 * script. In a `verify --all` sweep the recording therefore lands in the run
 * dir of the spec that ESTABLISHED the session, and later specs' runs carry no
 * recording. `validity replay` says so by name rather than pretending the
 * absence is a failure.
 *
 * ---------------------------------------------------------------------------
 * VERIFIED ON DEVICE (agent-device 0.20.3, emulator-5554, 2026-07-30)
 * ---------------------------------------------------------------------------
 * The whole round trip was executed against a booted Android emulator, and the
 * shapes below are read off that run, not inferred. Kept AT ITS ORIGINAL
 * VERSION deliberately: it is a record of an observation, and re-stamping it
 * "0.20.5" would claim a device run nobody has done since. The 0.20.5 argv for
 * every command below is identical (re-checked against the captured
 * `replay --help` / `help workflow`, 2026-08-06); what 0.20.5 ADDS is in the
 * next section.
 *
 *   open <app> --save-script <path> --force   → session opened, recording armed
 *   snapshot --no-record                      → excluded from the script
 *   wait 'label="…"' 3000                     → recorded WITH landmark identity
 *   session save-script <path> --force        → {"success":true,
 *                                                "savedScript":"…","actionCount":3}
 *                                               and `session list` still showed
 *                                               the session — no teardown.
 *
 * The published file is exactly the shape this module aims for:
 *
 *     context platform=android device="…" kind=emulator theme=unknown
 *     open "ai.validity.playground"
 *     # agent-device:target-v1 {"id":"android:id/aerr_close","role":"button",
 *       "label":"Close app",…,"verification":"verified"}
 *     wait "label=\"Close app\"" 3000
 *
 * Note `verification:"verified"` on the guard — that captured identity is what
 * replay re-checks, which is why a reshuffled screen carrying the same label
 * elsewhere fails closed instead of false-passing.
 *
 * Replaying it answered `{"success":true,"data":{"replayed":3,…}}`
 * ({@link classifyAgentDeviceReplay} → `reproduced`). Replaying a copy whose
 * landmark had been renamed answered `{"success":false,"error":{"code":
 * "REPLAY_DIVERGENCE","message":"Replay failed at step 2 …: wait timed out for
 * selector: …","details":{"step":2,"action":"wait"}}}` (→ `regressed`, step 2).
 * Both envelopes are the fixtures in replay-recording.test.ts.
 *
 * ---------------------------------------------------------------------------
 * 0.20.5 (2026-08-06): WHAT A DIVERGENCE NOW CARRIES, AND WHAT WE DO WITH IT
 * ---------------------------------------------------------------------------
 * The 0.20.3 envelope above is a strict SUBSET of what 0.20.5 sends: the same
 * `REPLAY_DIVERGENCE` code and `details.step`, plus a bounded
 * `details.divergence` REPORT — screen digest with blessed `@ref`s, ranked
 * selector suggestions, a `resume` handle (`--from <n> --plan-digest <sha>`)
 * and a `repairHint`. Field names below are read off the shipped 0.20.5
 * `dist/src/session.js` (the report builders around `divergence:{version:1,…}`
 * and the `wp()` resume validator), not guessed:
 *
 *     details.divergence = {
 *       version: 1,
 *       kind: 'action-failure' | 'identity-mismatch' | 'selector-miss' | …,
 *       step: { index, source: { path, line } },
 *       action: 'wait id="validity-root:…"',
 *       cause: { code, message, hint? },
 *       screen: { state:'available', refsGeneration?, refs:[{ref,role,label?}],
 *                 truncated? } | { state:'unavailable', reason?, hint? },
 *       suggestions: [{ selector, basis:'id'|'role-label'|'label'|'other',
 *                       ref?, role, label? }]   // upstream caps at 5, ranked
 *       suggestionCount, resume: { allowed, from, planDigest, reason? },
 *       repairHint: 'record-and-heal'|'state-repair'|'caution'|'manual',
 *     }
 *
 * Validity CAPTURES this and NEVER ACTS ON IT. `--save-script` heal-by-doing
 * (ADR 0012) rewrites the journey a run was attested against, so automating it
 * would mean Validity silently repairing its own evidence and then reporting
 * green — the exact provenance break the attestation exists to make
 * impossible. The suggestions and the resume line are printed FOR THE USER,
 * and {@link repairTransactionLines} spells out the commands they would run.
 * Nothing in this module ever issues them.
 *
 * `--update`/`-u` is a no-op in 0.20.5 (ADR 0012) and is never sent.
 */
import { resolve } from 'node:path';
import { REPLAY_RECORDING_FILENAME, type ScenarioSecretConfig } from '@validity.ai/verify-spec';

export { REPLAY_RECORDING_FILENAME };

/** Excludes a command from the armed recording. Global flag on every verb. */
export const NO_RECORD_FLAG = '--no-record';

/** The `.ad` a run dir carries, when its capture recorded one. */
export function recordingPathFor(runDir: string): string {
  return resolve(runDir, REPLAY_RECORDING_FILENAME);
}

/**
 * Flags that ARM the recording on the session-establishing `open`.
 *
 * `--force` is not optional in practice: a run dir is fresh, but a retried
 * capture (the native verify engine's `attemptCapture` runs twice on a stale
 * bundle) can re-open against the same path, and upstream REFUSES to overwrite
 * an existing target without it. Refusing there would abort the open, which is
 * the one command that must never fail for a cosmetic reason.
 */
export function armRecordingFlags(path: string): string[] {
  return ['--save-script', path, '--force'];
}

/**
 * The destination guard's selector expression: an id-bearing landmark.
 *
 * `JSON.stringify` supplies the quoting agent-device's selector parser expects
 * (`id="…"`), and the marker contains a `:` and a hex token, so quoting is
 * required rather than decorative.
 */
export function destinationGuardSelector(marker: string): string {
  return `id=${JSON.stringify(marker)}`;
}

/** `wait 'id="validity-root:<token>"' <timeoutMs>` — the qualifying guard. */
export function destinationGuardArgs(marker: string, timeoutMs: number): string[] {
  return ['wait', destinationGuardSelector(marker), String(timeoutMs)];
}

/**
 * Did an ARMED open get refused because the daemon already holds this session?
 *
 * Upstream (0.20.3, `session.js`; the same refusal text is still in 0.20.5's
 * `dist/src/session.js`): a session that survives in the daemon —
 * exactly what a failed or interrupted run leaves behind, since Validity never
 * closes its verify session — refuses `open --save-script` with
 *
 *     INVALID_ARGS: open --save-script can only arm a fresh session. Use the
 *     current session without --save-script, or close it and start a fresh
 *     session.
 *
 * The process-wide `establishedSessions` registry cannot see a session another
 * PROCESS established, so the retry after a failed run is precisely where this
 * fires — and before this predicate existed, that retry lost its open to the
 * platform-CLI fallback and the whole run degraded to `unconfirmed`. The
 * driver's answer is upstream's own first suggestion: reuse the session
 * without arming. Closing instead would tear down a session a live `watch` or
 * MCP process may own, which this codebase never does to a session it cannot
 * prove is stale.
 */
export function isFreshSessionArmRefusal(text: string): boolean {
  return /can only arm a fresh session/.test(text);
}

/** Publish the armed script without closing the session. */
export function publishRecordingArgs(path: string): string[] {
  return ['session', 'save-script', path, '--force', '--json'];
}

/* ------------------------------------------------------------------ *
 * Replay invocation.                                                  *
 * ------------------------------------------------------------------ */

/**
 * `--keep-session` — 0.20.5, native `.ad` ONLY.
 *
 * Upstream (`replay --help`): "leave the session active by suppressing exactly
 * an authored terminal close in a native .ad script; replay only, not test or
 * Maestro YAML". Two consequences this module encodes rather than discovers at
 * runtime:
 *
 *   - A Validity-published script has NO terminal close (publication refuses
 *     one — rule 2), so the flag suppresses nothing and is a NO-OP for the
 *     journey itself. What it buys is the SURVIVING SESSION: post-replay
 *     evidence (`perf metrics`, `network dump`) has something to attach to,
 *     and a reviewer can keep poking at the screen the recording landed on.
 *   - `test` and `--maestro` REJECT it. `validity replay` never runs either,
 *     but the refusal is checked here so the user gets our sentence instead of
 *     an upstream INVALID_ARGS after a device was already claimed.
 */
export const KEEP_SESSION_FLAG = '--keep-session';

/**
 * Why `--keep-session` cannot be honored for `path`, or undefined when it can.
 *
 * Extension-based on purpose: `.yaml`/`.yml` is the Maestro compatibility lane
 * (`replay <flow.yaml> --maestro`), which upstream rejects the flag on. Anything
 * that is not a `.ad` is refused rather than tried — a fail-closed refusal is
 * one sentence, a device-side INVALID_ARGS is a lost session claim.
 */
export function keepSessionRefusal(path: string): string | undefined {
  if (/\.ad$/i.test(path)) return undefined;
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  const lane =
    ext === 'yaml' || ext === 'yml'
      ? 'a Maestro YAML flow'
      : ext
        ? `a .${ext} script`
        : 'a script with no .ad extension';
  return (
    `--keep-session applies to native \`.ad\` recordings only — ${path} is ${lane}. ` +
    'agent-device rejects the flag on `test` and on the Maestro compatibility lane, so it is ' +
    'not forwarded (the replay itself is unaffected).'
  );
}

/** How `agent-device replay` should be invoked for one recording. */
export interface ReplayInvocation {
  /** Suppress an authored terminal close and leave the session up (native `.ad` only). */
  keepSession?: boolean;
  /**
   * `-e NAME=value` pairs — the live values for the `${NAME}` placeholders a
   * secret-safe recording published instead of the literals. Never logged.
   */
  env?: ReadonlyArray<{ name: string; value: string }>;
}

/**
 * Re-execute a published recording against an ALREADY-CONNECTED device.
 *
 * Flag order is fixed (path, `--json`, env pairs, `--keep-session`) so the argv
 * is assertable byte-for-byte in tests; upstream does not care about order. An
 * invocation with no options is BYTE-IDENTICAL to the pre-0.20.5 argv, which is
 * what keeps every existing replay path unchanged.
 */
export function replayRecordingArgs(path: string, opts: ReplayInvocation = {}): string[] {
  const args = ['replay', path, '--json'];
  for (const pair of opts.env ?? []) args.push('-e', `${pair.name}=${pair.value}`);
  if (opts.keepSession) args.push(KEEP_SESSION_FLAG);
  return args;
}

/* ------------------------------------------------------------------ *
 * Secret-safe fills.                                                  *
 * ------------------------------------------------------------------ */

/**
 * Normalize a criterion/field id into the uppercase replay-variable name
 * `--record-as` accepts. Non-alphanumerics collapse to `_`; a leading digit is
 * prefixed, because `${1PASSWORD}` is not a legal placeholder.
 */
export function recordAsVarName(id: string): string {
  const upper = id
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!upper) return 'VALIDITY_SECRET';
  return /^[0-9]/.test(upper) ? `V_${upper}` : upper;
}

export interface FillRecordingPolicy {
  /** Is a recording armed on this session right now? */
  armed: boolean;
  /** The target as it will be sent — `@eNN` or a selector expression. */
  target: string;
  /** When set, the value is a secret and must publish as `${VAR}`. */
  secretVar?: string;
}

/**
 * Decide how a `fill` participates in the recording.
 *
 * Three-way, and the ORDER matters:
 *
 *   - not armed          → no flags at all (byte-identical to pre-recording
 *                          argv, so an unrecorded run cannot change behavior);
 *   - `@eNN` target      → `--no-record`. Rule 3: publication REFUSES a
 *                          recorded step carrying a session-local ref, so
 *                          recording it would not produce a safer script, it
 *                          would produce NO script. This is the live path today
 *                          — the check executor resolves fill targets from a
 *                          snapshot — which means a spec's literal `fill` value
 *                          never reaches the `.ad` at all;
 *   - selector + secret  → `--record-as VAR`. The device receives the live
 *                          text; the script publishes `${VAR}`.
 *
 * `--record-as` and `--no-record` are mutually exclusive upstream ("no script
 * step would be published"), so the branches are exclusive here too.
 */
export function fillRecordingFlags(policy: FillRecordingPolicy): string[] {
  if (!policy.armed) return [];
  if (policy.target.startsWith('@')) return [NO_RECORD_FLAG];
  if (policy.secretVar) return ['--record-as', recordAsVarName(policy.secretVar)];
  return [];
}

/* ------------------------------------------------------------------ *
 * Declared secrets: config → env → `--record-as` → `-e`.              *
 * ------------------------------------------------------------------ */

/**
 * A secret as the run actually resolved it: a replay VARIABLE name, the
 * environment variable it came from, and (when present) the live value.
 *
 * The value is carried, never persisted. Everything that writes — the `.ad`,
 * the divergence report, the evidence files, the printed notices — goes through
 * {@link redactSecrets} or publishes the `${NAME}` placeholder instead.
 */
export interface ResolvedSecret {
  name: string;
  env: string;
  value: string;
}

export interface SecretResolution {
  /** Secrets whose environment variable was set (non-empty). */
  resolved: ResolvedSecret[];
  /** Declared secrets with nothing in the environment — the fail-closed set. */
  missing: Array<{ name: string; env: string }>;
}

/**
 * Normalize `scenarios[].secrets` (string shorthand or `{ name, env }`) into
 * `{ name, env }` pairs, de-duplicated by NAME with the first declaration
 * winning.
 *
 * The name is normalized through {@link recordAsVarName} so a config that says
 * `'login password'` and a `.ad` that says `${LOGIN_PASSWORD}` describe the same
 * variable; the ENV var name is taken verbatim (it is the user's own
 * environment, and silently upper-casing it would look for a variable they
 * never exported).
 */
export function normalizeScenarioSecrets(
  declared: ReadonlyArray<ScenarioSecretConfig> | undefined,
): Array<{ name: string; env: string }> {
  const out: Array<{ name: string; env: string }> = [];
  const seen = new Set<string>();
  for (const entry of declared ?? []) {
    const raw = typeof entry === 'string' ? { name: entry } : entry;
    if (!raw || typeof raw.name !== 'string' || raw.name.trim() === '') continue;
    const name = recordAsVarName(raw.name);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, env: raw.env && raw.env.trim() !== '' ? raw.env : name });
  }
  return out;
}

/**
 * Collect every scenario's declared secrets across a whole config. Scenario
 * scoping is deliberately COLLAPSED: a `.ad` is published per device session,
 * not per scenario, so the placeholders it carries can come from any scenario
 * that ran in that session — and refusing to supply a value we do have would
 * fail a replay for a bookkeeping reason.
 */
export function configuredSecrets(
  scenarios: Record<string, { secrets?: ReadonlyArray<ScenarioSecretConfig> }> | undefined,
): Array<{ name: string; env: string }> {
  const merged: ScenarioSecretConfig[] = [];
  for (const scenario of Object.values(scenarios ?? {})) {
    for (const s of scenario?.secrets ?? []) merged.push(s);
  }
  return normalizeScenarioSecrets(merged);
}

/**
 * Read the live values out of an environment. PURE — the env is passed in.
 *
 * An empty string counts as MISSING: `export TOKEN=` is how a shell reports "I
 * do not have this", and filling a password field with the empty string would
 * produce a confident red about the app.
 */
export function resolveSecrets(
  declared: ReadonlyArray<{ name: string; env: string }>,
  env: Record<string, string | undefined>,
): SecretResolution {
  const resolved: ResolvedSecret[] = [];
  const missing: Array<{ name: string; env: string }> = [];
  for (const d of declared) {
    const value = env[d.env];
    if (typeof value === 'string' && value !== '') resolved.push({ ...d, value });
    else missing.push(d);
  }
  return { resolved, missing };
}

/**
 * The `${NAME}` variables a `.ad` script actually references — the authoritative
 * statement of what a replay NEEDS, read off the artifact rather than inferred
 * from config. A script recorded before secrets existed references none, and a
 * config declaring secrets the script never used demands nothing.
 *
 * Names are returned as written (upper-cased for comparison against
 * {@link recordAsVarName} output), de-duplicated, in first-seen order.
 */
export function recordingVariableNames(adText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of adText.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const name = m[1]!.toUpperCase();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** `-e NAME=value` pairs for {@link replayRecordingArgs}. */
export function replayEnvArgs(
  secrets: ReadonlyArray<ResolvedSecret>,
): Array<{ name: string; value: string }> {
  return secrets.map((s) => ({ name: s.name, value: s.value }));
}

/**
 * Replace every live secret value in `text` with its `${NAME}` placeholder.
 *
 * Applied to EVERY string this module or its callers surface from a device —
 * upstream error messages quote the text they typed, and a divergence on a
 * login screen is exactly where a password would otherwise be printed into a
 * terminal, a report, and a run-dir JSON file. Longest value first so a secret
 * that contains another secret cannot leave a fragment behind.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<ResolvedSecret>): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.value.length - a.value.length)) {
    if (s.value === '') continue;
    out = out.split(s.value).join(`\${${s.name}}`);
  }
  return out;
}

/** What a `fill` should send, and whether the recording survives it. */
export interface RecordedFillPlan {
  /** The value handed to the device (the LIVE secret, never the placeholder). */
  value: string;
  /** Recording flags for this fill — see {@link fillRecordingFlags}. */
  flags: string[];
  /**
   * False when this fill cannot be published safely. The caller MUST NOT
   * publish the session's recording; it must not "fix" the fill.
   */
  publishable: boolean;
  /** Why publication was abandoned, or why a fill cannot run. Safe to print. */
  reason?: string;
  /** True when the fill itself cannot be executed (a secret with no value). */
  blocked?: boolean;
}

/**
 * Plan one `fill` under an armed recording — the FAIL-CLOSED half of the
 * secret contract.
 *
 * Inputs are the spec's authored value (which may be a `${NAME}` placeholder or
 * a literal) and the resolved secrets. Outcomes, in the order they are decided:
 *
 *   1. `${NAME}` with a resolved value → send the LIVE value, record as
 *      `--record-as NAME`. The device gets the secret, the `.ad` gets `${NAME}`.
 *   2. `${NAME}` with NO value → BLOCKED. Typing the literal string
 *      `"${NAME}"` into a password field and scoring the result would be a
 *      verdict about a typo, so the fill does not run at all.
 *   3. A LITERAL that equals a resolved secret value, targeted by selector
 *      under an armed recording → the recording is abandoned (`publishable:
 *      false`). The fill still runs — the run's verdicts are not the problem —
 *      but no `.ad` is published, because publishing it would write the secret
 *      to disk. `--no-record` would hide the literal too, yet it would publish
 *      a login journey with the login step missing: a script that replays to
 *      the wrong screen is a worse artifact than no script.
 *   4. Anything else → today's behavior exactly, byte for byte.
 *
 * A secret is only ever a publication concern when a recording is ARMED and the
 * target is a portable selector; an `@eNN` fill is excluded from the script by
 * rule 3 (see {@link fillRecordingFlags}) and can never leak.
 */
export function planRecordedFill(args: {
  armed: boolean;
  target: string;
  value: string;
  secrets: ReadonlyArray<ResolvedSecret>;
}): RecordedFillPlan {
  const placeholder = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(args.value.trim());
  if (placeholder) {
    const name = placeholder[1]!.toUpperCase();
    const secret = args.secrets.find((s) => s.name === name);
    if (!secret) {
      return {
        value: args.value,
        flags: args.armed && args.target.startsWith('@') ? [NO_RECORD_FLAG] : [],
        publishable: false,
        blocked: true,
        reason:
          `this fill needs the secret \${${name}}, and nothing in the environment supplies it. ` +
          `Declare it in \`scenarios[].secrets\` and export the variable; the fill was NOT run ` +
          `(typing the literal "\${${name}}" would score a typo, not the app).`,
      };
    }
    return {
      value: secret.value,
      flags: fillRecordingFlags({ armed: args.armed, target: args.target, secretVar: secret.name }),
      publishable: true,
    };
  }

  const leaked = args.secrets.find((s) => s.value !== '' && args.value.includes(s.value));
  if (leaked && args.armed && !args.target.startsWith('@')) {
    return {
      value: args.value,
      flags: [NO_RECORD_FLAG],
      publishable: false,
      reason:
        `a fill carried the value of the declared secret \${${leaked.name}} as a literal, so this ` +
        `run publishes NO \`.ad\` recording — writing it would put the secret on disk. Author the ` +
        `check as \`\${${leaked.name}}\` to record it as a placeholder instead.`,
    };
  }

  return {
    value: args.value,
    flags: fillRecordingFlags({ armed: args.armed, target: args.target }),
    publishable: true,
  };
}

/* ------------------------------------------------------------------ *
 * Publication + replay outcome parsing.                               *
 * ------------------------------------------------------------------ */

interface Envelope {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown; details?: Record<string, unknown> };
}

function parseEnvelope(stdout: string): Envelope | undefined {
  if (!stdout || stdout.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object') return undefined;
    return parsed as Envelope;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export interface RecordingPublication {
  published: boolean;
  /** Upstream's own refusal, verbatim, when it refused. */
  reason?: string;
}

/** Did `session save-script` publish? Pure — the caller supplies the exec. */
export function classifyRecordingPublish(res: {
  code: number;
  stdout: string;
  stderr: string;
}): RecordingPublication {
  const env = parseEnvelope(res.stdout);
  if (env?.success === true) return { published: true };
  const message = str(env?.error?.message) ?? `${res.stderr}\n${res.stdout}`.trim();
  if (env?.success === false || res.code !== 0) {
    return { published: false, reason: message || `agent-device exited ${res.code}` };
  }
  // No envelope and exit 0 — an old binary, or output we cannot read. Refuse to
  // claim a publication we did not observe.
  return { published: false, reason: 'agent-device did not report a published script' };
}

/* ------------------------------------------------------------------ */

/**
 * How a replayed recording maps onto `validity replay`'s vocabulary.
 *
 * Deliberately three-valued and pessimistic in the middle: only agent-device's
 * OWN divergence code means "the journey no longer holds". Every other failure
 * is an environment we could not attribute to the code under test, and calling
 * that `regressed` would be a false red exactly as calling it `reproduced`
 * would be a false green.
 */
export type AgentDeviceReplayOutcome = 'reproduced' | 'regressed' | 'unverifiable-now';

export interface AgentDeviceReplayResult {
  outcome: AgentDeviceReplayOutcome;
  /** One line, in the product's register, safe to print verbatim. */
  notice: string;
  /** Steps agent-device says it replayed, when it said. */
  replayed?: number;
  /** agent-device's error code, when it failed. */
  errorCode?: string;
  /** 1-based step the divergence landed on, when reported. */
  step?: number;
  /**
   * The session `agent-device replay` left behind. Reported, NOT released.
   *
   * A published script has no terminal `close` (publication refuses one), so
   * replay leaves its session active — and, verified live on 0.20.3, in a
   * throwaway daemon of its own under a temp state dir, not the one Validity's
   * verifies use. Closing it would mean addressing that other daemon by a state
   * dir we only learn from a hint string, to tear down something that idle-reaps
   * on its own in five minutes. Replay's job is to not mutate the reviewer's
   * device; leaving a temp daemon to expire is the smaller footprint.
   *
   * 0.20.5 adds `--keep-session`, which "returns the surviving session for
   * continued commands" — that is the session named here, and it is what the
   * post-journey perf/network evidence attaches to (see perf-evidence.ts). It
   * is still not closed by us: the flag is opt-in, and the same idle reap
   * applies.
   */
  session?: string;
  /**
   * The 0.20.5 bounded divergence report, when the failure carried one.
   *
   * Present only alongside `REPLAY_DIVERGENCE`. Absent means the binary is
   * older, or upstream could not build a report — never that the journey is
   * fine.
   */
  divergence?: ReplayDivergenceReport;
}

/* ------------------------------------------------------------------ *
 * The divergence report (0.20.5).                                     *
 * ------------------------------------------------------------------ */

/** One ranked selector suggestion. `basis` is upstream's own ranking key. */
export interface DivergenceSuggestion {
  /** The selector expression upstream would target instead. */
  selector: string;
  /** Why it ranks where it does: `id` > `role-label` > `label` > `other`. */
  basis?: string;
  /** A blessed session-local ref for the repair transaction — never for a script. */
  ref?: string;
  role?: string;
  label?: string;
}

/** How upstream says a repair could be attempted. Advisory; we never act on it. */
export type DivergenceRepairHint = 'record-and-heal' | 'state-repair' | 'caution' | 'manual';

/**
 * The resume handle — `replay --from <n> --plan-digest <sha256>`.
 *
 * `allowed:false` is a real answer, not an omission: upstream refuses a resume
 * whose skipped range touches runtime control flow, and it explains why in
 * `reason`.
 */
export interface DivergenceResume {
  allowed: boolean;
  from: number;
  planDigest: string;
  reason?: string;
}

/**
 * The bounded report Validity persists. A NORMALIZED subset of upstream's
 * payload — every field here was read off the 0.20.5 builder (see the module
 * header) — with hard caps applied, because this is written into a run dir and
 * a run dir is evidence a human reads, not a log.
 */
export interface ReplayDivergenceReport {
  /** Upstream's report version (1 as of 0.20.5). */
  version?: number;
  /** `action-failure`, `identity-mismatch`, `selector-miss`, … */
  kind?: string;
  /** 1-based step index the journey diverged on. */
  step?: number;
  /** Source location of that step inside the `.ad`. */
  source?: { path?: string; line?: number };
  /** The recorded action, as upstream labels it. */
  action?: string;
  cause?: { code?: string; message?: string; hint?: string };
  /** Ranked replacements for the step's selector (upstream caps at 5). */
  suggestions: DivergenceSuggestion[];
  /** How many suggestions upstream had before ITS cap. */
  suggestionCount?: number;
  resume?: DivergenceResume;
  repairHint?: DivergenceRepairHint;
  /** Blessed refs from the screen the journey actually landed on. */
  screen?: {
    state: 'available' | 'unavailable';
    refsGeneration?: number;
    refs?: Array<{ ref?: string; role?: string; label?: string }>;
    truncated?: boolean;
    reason?: string;
    hint?: string;
  };
}

/** Caps — this lands in a run dir, so it stays readable by construction. */
const MAX_SUGGESTIONS = 5;
const MAX_SCREEN_REFS = 12;
const MAX_TEXT = 400;

const clip = (v: unknown): string | undefined => {
  const s = str(v);
  return s === undefined ? undefined : s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
};
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const REPAIR_HINTS: readonly DivergenceRepairHint[] = [
  'record-and-heal',
  'state-repair',
  'caution',
  'manual',
];

/**
 * Normalize `error.details.divergence` into {@link ReplayDivergenceReport}.
 * TOTAL and tolerant: an unrecognized shape yields `undefined` rather than
 * throwing, and an unknown `kind`/`repairHint` is dropped rather than
 * guessed — a report we cannot read is missing evidence, never a verdict.
 *
 * `redact` is applied to every string that can quote device text (messages,
 * hints, labels, selectors), so a divergence on a login screen cannot write a
 * password into the run dir.
 */
export function parseDivergenceReport(
  details: unknown,
  redact: (s: string) => string = (s) => s,
): ReplayDivergenceReport | undefined {
  const d = rec(rec(details)?.divergence);
  if (!d) return undefined;
  const R = (v: unknown): string | undefined => {
    const s = clip(v);
    return s === undefined ? undefined : redact(s);
  };

  const rawSuggestions = Array.isArray(d.suggestions) ? d.suggestions : [];
  const suggestions: DivergenceSuggestion[] = [];
  for (const raw of rawSuggestions.slice(0, MAX_SUGGESTIONS)) {
    const s = rec(raw);
    const selector = s ? R(s.selector) : undefined;
    if (!selector) continue;
    suggestions.push({
      selector,
      ...(s && str(s.basis) ? { basis: str(s.basis) } : {}),
      ...(s && str(s.ref) ? { ref: str(s.ref) } : {}),
      ...(s && R(s.role) ? { role: R(s.role) } : {}),
      ...(s && R(s.label) ? { label: R(s.label) } : {}),
    });
  }

  const stepRec = rec(d.step);
  const sourceRec = rec(stepRec?.source);
  const causeRec = rec(d.cause);
  const resumeRec = rec(d.resume);
  const screenRec = rec(d.screen);
  const hint = str(d.repairHint);

  const report: ReplayDivergenceReport = {
    ...(num(d.version) === undefined ? {} : { version: num(d.version) }),
    ...(str(d.kind) ? { kind: str(d.kind) } : {}),
    ...(num(stepRec?.index) === undefined ? {} : { step: num(stepRec?.index) }),
    ...(sourceRec
      ? {
          source: {
            ...(R(sourceRec.path) ? { path: R(sourceRec.path) } : {}),
            ...(num(sourceRec.line) === undefined ? {} : { line: num(sourceRec.line) }),
          },
        }
      : {}),
    ...(R(d.action) ? { action: R(d.action) } : {}),
    ...(causeRec
      ? {
          cause: {
            ...(str(causeRec.code) ? { code: str(causeRec.code) } : {}),
            ...(R(causeRec.message) ? { message: R(causeRec.message) } : {}),
            ...(R(causeRec.hint) ? { hint: R(causeRec.hint) } : {}),
          },
        }
      : {}),
    suggestions,
    ...(num(d.suggestionCount) === undefined ? {} : { suggestionCount: num(d.suggestionCount) }),
    // A resume handle is only usable if BOTH halves are present — `--from`
    // without `--plan-digest` is rejected by upstream before any action, so a
    // half-report must not become a command we tell the user to run.
    ...(resumeRec && num(resumeRec.from) !== undefined && str(resumeRec.planDigest)
      ? {
          resume: {
            allowed: resumeRec.allowed === true,
            from: num(resumeRec.from)!,
            planDigest: str(resumeRec.planDigest)!,
            ...(R(resumeRec.reason) ? { reason: R(resumeRec.reason) } : {}),
          },
        }
      : {}),
    ...(hint && (REPAIR_HINTS as readonly string[]).includes(hint)
      ? { repairHint: hint as DivergenceRepairHint }
      : {}),
    ...(screenRec
      ? {
          screen: {
            state: screenRec.state === 'available' ? 'available' : 'unavailable',
            ...(num(screenRec.refsGeneration) === undefined
              ? {}
              : { refsGeneration: num(screenRec.refsGeneration) }),
            ...(Array.isArray(screenRec.refs)
              ? {
                  refs: screenRec.refs.slice(0, MAX_SCREEN_REFS).map((raw) => {
                    const n = rec(raw) ?? {};
                    return {
                      ...(str(n.ref) ? { ref: str(n.ref) } : {}),
                      ...(R(n.role) ? { role: R(n.role) } : {}),
                      ...(R(n.label) ? { label: R(n.label) } : {}),
                    };
                  }),
                }
              : {}),
            ...(screenRec.truncated === true ||
            (Array.isArray(screenRec.refs) && screenRec.refs.length > MAX_SCREEN_REFS)
              ? { truncated: true }
              : {}),
            ...(R(screenRec.reason) ? { reason: R(screenRec.reason) } : {}),
            ...(R(screenRec.hint) ? { hint: R(screenRec.hint) } : {}),
          },
        }
      : {}),
  };
  return report;
}

/**
 * The evidence block a human reads: what diverged, what upstream would target
 * instead, and — verbatim — the command that resumes from the failed step.
 *
 * Rendering only. Nothing here runs anything, and the resume line is printed
 * for the USER to run: a resume re-enters a journey mid-flight, and deciding
 * that the app state is right for it is a judgement Validity is not entitled
 * to make on someone's device.
 */
export function divergenceEvidenceLines(report: ReplayDivergenceReport): string[] {
  const lines: string[] = [];
  const where =
    report.step === undefined
      ? 'the recorded journey diverged'
      : `diverged at step ${report.step}${report.action ? ` (${report.action})` : ''}`;
  lines.push(`${where}${report.kind ? ` — ${report.kind}` : ''}`);
  if (report.cause?.message) {
    lines.push(
      `cause: ${report.cause.message}${report.cause.code ? ` [${report.cause.code}]` : ''}`,
    );
  }
  if (report.cause?.hint) lines.push(`hint: ${report.cause.hint}`);

  if (report.suggestions.length > 0) {
    const total = report.suggestionCount ?? report.suggestions.length;
    const extra =
      total > report.suggestions.length ? ` (top ${report.suggestions.length} of ${total})` : '';
    lines.push(`ranked selector suggestions${extra}:`);
    report.suggestions.forEach((s, i) => {
      const meta = [
        s.basis ? `basis ${s.basis}` : undefined,
        s.role,
        s.label ? `“${s.label}”` : undefined,
      ]
        .filter(Boolean)
        .join(', ');
      lines.push(`  ${i + 1}. ${s.selector}${meta ? `  — ${meta}` : ''}`);
    });
  } else if (report.screen?.state === 'unavailable') {
    lines.push(
      `no selector suggestions — the screen could not be read${report.screen.reason ? ` (${report.screen.reason})` : ''}`,
    );
  }
  return lines;
}

/**
 * `agent-device replay <path> --from <n> --plan-digest <sha>` — upstream's own
 * resume handle, rendered exactly as it must be typed. Undefined when the
 * report carries no usable handle, or when upstream says the resume is not
 * allowed (its `reason` is surfaced instead by {@link repairTransactionLines}).
 */
export function resumeCommandLine(
  report: ReplayDivergenceReport,
  adPath: string,
): string | undefined {
  const r = report.resume;
  if (!r || !r.allowed) return undefined;
  return `agent-device replay ${adPath} --from ${r.from} --plan-digest ${r.planDigest}`;
}

/**
 * The repair transaction, DOCUMENTED and never executed.
 *
 * `--save-script` heal-by-doing (ADR 0012) rewrites the `.ad` a run was
 * attested against. Running it automatically would mean Validity editing its
 * own evidence and then reporting on it — so this function's entire output is
 * text. Each `repairHint` gets upstream's own procedure, in the order upstream
 * documents it, plus the one warning that matters: the healed script is a NEW
 * artifact and only becomes the run's evidence after a fresh verify signs it.
 */
export function repairTransactionLines(report: ReplayDivergenceReport, adPath: string): string[] {
  const lines: string[] = [];
  const resume = resumeCommandLine(report, adPath);
  const next = report.resume ? report.resume.from : undefined;

  switch (report.repairHint) {
    case 'record-and-heal':
      lines.push(
        'agent-device says a repair could be RECORDED (repairHint: record-and-heal). Validity does not do it for you:',
        `  1. arm the repair:  agent-device replay ${adPath} --save-script`,
        '  2. press the correct control via a blessed @ref from the divergence screen (recorded)',
        next === undefined
          ? '  3. continue from the step after the failure with --from/--plan-digest from the report'
          : `  3. continue:  agent-device replay ${adPath} --from ${next + 1} --plan-digest ${report.resume?.planDigest ?? '<sha>'}`,
        '  4. finish with `agent-device close --save-script`, then DIFF the healed script before promoting it',
      );
      break;
    case 'state-repair':
      lines.push(
        'agent-device says the script is right and the APP STATE is wrong (repairHint: state-repair):',
        '  1. fix the state with --no-record actions (nothing enters the script)',
        resume
          ? `  2. re-run the unchanged step:  ${resume}`
          : '  2. re-run the unchanged step with --from/--plan-digest from the report',
      );
      break;
    case 'caution':
      lines.push(
        'agent-device flagged this repair as CAUTION: something already matches the recorded selector, ' +
          'so re-pressing blindly may repeat the mistake. Look at the screen before resuming.',
      );
      break;
    case 'manual':
      lines.push(
        'agent-device could prove no safe automated repair (repairHint: manual) — this one is yours to diagnose.',
      );
      break;
    default:
      break;
  }

  if (resume && report.repairHint !== 'state-repair' && report.repairHint !== 'record-and-heal') {
    lines.push(`resume from the failed step:  ${resume}`);
  }
  if (report.resume && !report.resume.allowed) {
    lines.push(
      `a resume is NOT available here${report.resume.reason ? `: ${report.resume.reason}` : ''} — re-run the whole recording instead.`,
    );
  }
  if (lines.length > 0) {
    lines.push(
      'A healed script is a NEW artifact: it is evidence only after a fresh `validity verify` records and signs it.',
    );
  }
  return lines;
}

/**
 * agent-device error codes that describe THE ENVIRONMENT, not the app: no
 * device, no app, no session, no tool, wrong platform. Replay's attach-only
 * posture means it cannot fix any of them, so they land on `unverifiable-now`
 * with the code named. Anything NOT in this set and not `REPLAY_DIVERGENCE`
 * lands there too — the set exists to produce a better MESSAGE, never to widen
 * what counts as a regression.
 */
const ENVIRONMENT_CODES = new Set([
  'DEVICE_NOT_FOUND',
  'DEVICE_IN_USE',
  'APP_NOT_INSTALLED',
  'SESSION_NOT_FOUND',
  'TOOL_MISSING',
  'UNSUPPORTED_PLATFORM',
  'UNSUPPORTED_OPERATION',
  'UNAUTHORIZED',
  'NOT_IMPLEMENTED',
]);

/**
 * Classify one `agent-device replay <path> --json` execution. PURE — every
 * branch is fixture-driven and needs no device.
 *
 * `secrets` is the redaction set: upstream scrubs the variables IT knows about
 * (`scrubVars`), but a message can still quote text typed from a value we
 * supplied via `-e`, so every string that leaves here is passed through
 * {@link redactSecrets} as well. Belt and braces on the one path that turns
 * device output into a file on disk.
 */
export function classifyAgentDeviceReplay(
  res: {
    code: number;
    stdout: string;
    stderr: string;
  },
  secrets: ReadonlyArray<ResolvedSecret> = [],
): AgentDeviceReplayResult {
  const env = parseEnvelope(res.stdout);
  const redact = (s: string): string => (secrets.length === 0 ? s : redactSecrets(s, secrets));

  if (env?.success === true) {
    const replayed = num(env.data?.replayed);
    const session = str(env.data?.session);
    return {
      outcome: 'reproduced',
      ...(replayed === undefined ? {} : { replayed }),
      ...(session === undefined ? {} : { session }),
      notice:
        `the recorded on-device journey replayed to its landmark` +
        (replayed === undefined ? '' : ` (${replayed} step${replayed === 1 ? '' : 's'})`) +
        ' — agent-device verified the destination element by its recorded identity, not just its label',
    };
  }

  const code = str(env?.error?.code);
  const message = redact(str(env?.error?.message) ?? `${res.stderr}\n${res.stdout}`.trim());

  if (code === 'REPLAY_DIVERGENCE') {
    const divergence = parseDivergenceReport(env?.error?.details, redact);
    // The report's own step index wins over the flat `details.step`: they agree
    // on 0.20.5, and the report is the field that keeps carrying meaning.
    const step = divergence?.step ?? num(env?.error?.details?.step);
    return {
      outcome: 'regressed',
      errorCode: code,
      ...(step === undefined ? {} : { step }),
      ...(divergence ? { divergence } : {}),
      notice:
        `the recorded on-device journey no longer reaches its landmark` +
        (step === undefined ? '' : ` (diverged at step ${step})`) +
        `: ${message}`,
    };
  }

  if (code && ENVIRONMENT_CODES.has(code)) {
    return {
      outcome: 'unverifiable-now',
      errorCode: code,
      notice:
        `the recording could not be re-executed here (${code}): ${message}. ` +
        'Replay attaches only — it never boots a device or installs an app.',
    };
  }

  return {
    outcome: 'unverifiable-now',
    ...(code ? { errorCode: code } : {}),
    notice:
      `the recording did not run to a verdict${code ? ` (${code})` : ''}: ` +
      `${message || `agent-device exited ${res.code}`}. Not counted as a regression — ` +
      'nothing here attributes the failure to the code under test.',
  };
}

// `runRecordingReplay` (a runner-injected replay executor that duplicated the
// driver's env/cwd plumbing) was consolidated into
// `AgentDeviceDriver.replayRecording(path, opts)` once the driver grew an
// invocation-options parameter — `validity replay` constructs the driver, so
// replays get the same session env, project-root cwd, timeout, and
// `--remote-config` passthrough as every other agent-device command.
