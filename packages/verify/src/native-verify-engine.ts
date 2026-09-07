/**
 * Headless native verify loop — the on-device cousin of `verify-engine.ts`.
 *
 * Drives a SINGLE frozen `runtime: native` spec through the same on-device
 * mechanical-check path the MCP server's native verify uses (captureNative →
 * runNativeCriterionChecks), against an emulator the CI runner already booted
 * (see `bootAndroidEmulator` in @validity.ai/verify-native). It returns the SAME
 * `SpecVerification` shape the web engine returns, so its results flow through
 * `aggregateVerdicts` / `hasHardFailure` / the exit gate untouched. A verified
 * run persists a real run-meta (`writeNativeRunMeta`, parity with both the web
 * engine and the MCP native path) so verify-all gets `meta.git`/`meta.diff`
 * for the temporal-binding classification (B2) and the report gets the
 * on-device screenshot.
 *
 * GATE INTEGRITY: a native spec that can't actually be verified must FAIL the
 * build, never pass and never be silently dropped:
 *   - a non-confirmed render (broken emulator / stale bundle / companion crash)
 *     sets `error` (which hasHardFailure treats as a failure) — captureNative
 *     returns `criterionVerdicts: undefined` there, and an empty `mechanical`
 *     would otherwise demote hard criteria to `unverifiable` → green.
 *   - a thrown capture (no booted device, deep-link open failed) sets `error`.
 *   - only a CONFIRMED render with EXECUTED verdicts may yield a pass.
 * The network-taint demotion fires because captureNative forwards
 * matchedRequests/consoleErrorCount/unmatchedUrls into the check executor.
 *
 * Heavy primitives are injectable via `deps` so this is unit-testable with NO
 * real device; the defaults build the real native session.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  componentIdFor,
  criterionUsesCommandChecks,
  discoverComponentFiles,
  ensureRunDirectories,
  executeCommandCriteria,
  nativeRecordReplayEnabled,
  newRunId,
  overlayCommandVerdicts,
  readRunMeta,
  resolveReportConfig,
  runDir,
  selectComponentsToRender,
  writeNativeRunMeta,
  type CommandCheckRunner,
  type CriterionVerdict,
  type Spec,
  type SpecCriterion,
  type ValidityConfig,
} from '@validity.ai/verify-spec';
import {
  AgentDeviceDriver,
  appendMetroRestartEvent,
  bundlerEpochStartMs,
  captureNative,
  capturesOnBundler,
  decideMetroHeal,
  decidePreventiveRecycle,
  diagnoseNativeEnvironment,
  ensureCompanionMetro,
  invalidateMetroContentMarker,
  metroAutoRestartCount,
  metroLogLength,
  noteMetroAutoRestart,
  prepareNativeApp,
  readMetroHealRecord,
  readMetroOwnerMarker,
  readSessionMetrics,
  recordingPathFor,
  configuredSecrets,
  resolveRemoteConfigPath,
  resolveSecrets,
  startNativeBridge,
  waitForBundleServed,
  writeDeviceEvidence,
  writeMetroHealRecord,
  evidenceSummaryLine,
  type DeviceEvidence,
  type EnvironmentDiagnosis,
  type MetroRestartTrigger,
  type NativeCaptureResult,
  type NativeDeviceEvidence,
  type NativeDriver,
  type TargetSpec,
} from '@validity.ai/verify-native';
import type { SpecVerification } from './verify-engine.js';

/** The already-booted device this verify runs against. */
export interface BootedTarget {
  /** adb serial (`emulator-5554`) on Android, simulator udid on iOS. */
  deviceId: string;
  /** Emulator console port. iOS simulators have none — pass 0. */
  port: number;
  /**
   * Which runtime the pinned device is. Absent ⇒ `android`, preserving the
   * original Android-only call sites. The driver MUST agree with the device
   * the caller discovered: an iOS udid driven as `android` sends every deep
   * link and screenshot through adb, which finds nothing.
   */
  platform?: 'ios' | 'android';
  /** Human-readable device name, recorded as run-meta provenance. */
  deviceName?: string;
  /** OS/runtime version, recorded as run-meta provenance. */
  osVersion?: string;
}

/**
 * Injectable seams so `verifyOneSpecNative` runs in tests with no emulator,
 * no Metro, and no `agent-device` binary. Production omits `deps` and the real
 * native primitives are used.
 */
export interface NativeVerifyDeps {
  /** Capture one target on the device (default: the real captureNative). */
  capture?: typeof captureNative;
  /** Build the device driver pinned to the booted emulator (default: AgentDeviceDriver). */
  makeDriver?: (o: {
    platform: 'ios' | 'android';
    device: string;
    scheme: string;
    metroUrl?: string;
    /** Where a `.ad` replay recording should be written (`<run-dir>/replay.ad`). */
    recordingPath?: string;
  }) => NativeDriver;
  /** Prepare the companion app (default: prepareNativeApp). */
  prepareApp?: typeof prepareNativeApp;
  /** Bring up the companion Metro (default: ensureCompanionMetro). */
  ensureMetro?: typeof ensureCompanionMetro;
  /** Start the host control bridge (default: startNativeBridge). */
  startBridge?: typeof startNativeBridge;
  /**
   * Shared `expect.command` runner (A5) so `verify --all` runs each named
   * command once across web + native specs. Absent → a fresh run per spec.
   */
  commandRunner?: CommandCheckRunner;
  /**
   * Environment diagnosis for the failure paths (default: the real
   * `diagnoseNativeEnvironment`). Injectable because the real one shells out to
   * `lsof`/`ps`/`agent-device` — a unit test asserting attribution must not
   * depend on what is running on the machine.
   */
  diagnose?: typeof diagnoseNativeEnvironment;
}

/**
 * The comparison key for matching a spec's bound target against a discovered
 * component file: lowercased basename, extension stripped. Accepts a bare name
 * (`Button`) or a project-relative path (`app/screens/WelcomeScreen.tsx`).
 */
/** Indent a multi-line fix command so it reads as a block inside an error. */
function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

/**
 * The "…and here is why" suffix appended to a build-failing `error`. Empty
 * string when nothing was diagnosed, so an undiagnosed failure reads exactly as
 * it did before this feature existed — a cause is added, never substituted.
 */
export function formatDiagnosisTail(d: EnvironmentDiagnosis | undefined): string {
  if (!d) return '';
  return (
    `\n  likely cause (${d.confidence}): ${d.symptom}\n  ${d.detail}` +
    // What the run already DID about it, ahead of what the reader should do —
    // a fix command that has just been executed automatically must never be the
    // first thing they see, or they will run it again and conclude nothing works.
    (d.autoRemediation ? `\n  already attempted: ${d.autoRemediation}` : '') +
    (d.fixCommand ? `\n  fix:\n${indent(d.fixCommand)}` : '')
  );
}

/** One line on stderr, matching the package's existing `[validity] …` convention. */
function note(message: string): void {
  if (typeof console !== 'undefined' && console.warn) console.warn(`[validity] ${message}`);
}

/* ------------------------------------------------------------------ *
 * Device evidence (advisory — see NativeConfig.deviceEvidence).        *
 * ------------------------------------------------------------------ */

/**
 * The capture's advisory perf/network bundle, in the run dir.
 *
 * Sibling of `replay-device-evidence.json` (the `--keep-session` replay's
 * bundle), named apart from it so a reader can tell which command produced
 * which — one is taken during a verify's own capture, the other after a later
 * replay of that verify's recording.
 */
export const DEVICE_EVIDENCE_FILENAME = 'device-evidence.json';

/**
 * Flatten the capture's evidence bundle into the flat records array the on-disk
 * format uses. Ordering is fixed (metrics, frames, network) so two runs of the
 * same shape produce byte-comparable files.
 *
 * PURE, and total: an absent bundle, an absent family, or a bundle that only
 * carries an `unavailableReason` all yield what they actually have — never a
 * fabricated record. Each individual record already classifies its own failure
 * into `status: 'unavailable'` with upstream's reason, so a device that answered
 * nothing is WRITTEN DOWN rather than omitted.
 */
export function deviceEvidenceRecords(bundle: NativeDeviceEvidence | undefined): DeviceEvidence[] {
  if (!bundle) return [];
  const records: DeviceEvidence[] = [];
  if (bundle.perf) records.push(bundle.perf.metrics, bundle.perf.frames);
  if (bundle.network) records.push(bundle.network);
  return records;
}

/**
 * Persist the bundle beside the run's other artifacts. Returns the filename
 * when a file was written.
 *
 * BEST-EFFORT BY CONSTRUCTION: `writeDeviceEvidence` swallows its own IO
 * failures, and nothing downstream reads the result, so evidence collection can
 * never fail the run it is documenting. Absent bundle ⇒ no file at all (the
 * feature is off, or the capture never reached the evidence phase). A bundle
 * with nothing in it but a reason writes NO file either — a `records: []`
 * artifact would state less than the reason does — and the reason is printed
 * instead, so "we tried and got nothing" is never silently dropped.
 */
function persistDeviceEvidence(
  runDirPath: string,
  bundle: NativeDeviceEvidence | undefined,
): string | undefined {
  if (!bundle) return undefined;
  const records = deviceEvidenceRecords(bundle);
  if (records.length === 0) {
    note(`device evidence: nothing captured — ${bundle.unavailableReason ?? 'no reason reported'}`);
    return undefined;
  }
  if (!writeDeviceEvidence(resolve(runDirPath, DEVICE_EVIDENCE_FILENAME), records)) {
    return undefined;
  }
  for (const record of records) note(`device evidence: ${evidenceSummaryLine(record)}`);
  return DEVICE_EVIDENCE_FILENAME;
}

/**
 * Has ANY capture confirmed since `sinceTs`? This is what ENDS a Metro collapse
 * episode for the auto-heal's bounding rule: a heal that recovered nothing may
 * not be repeated until something demonstrably rendered again — by a later heal,
 * or by a human fixing whatever the bundler was not.
 *
 * No timestamp (nothing was ever healed) → true, i.e. "the budget is free": the
 * rule exists to stop a REPEAT, and there is nothing to repeat yet.
 */
function hasConfirmedSince(projectRoot: string, sinceTs: string | undefined): boolean {
  if (!sinceTs) return true;
  const since = Date.parse(sinceTs);
  if (!Number.isFinite(since)) return true;
  return readSessionMetrics(projectRoot).some((row) => {
    const t = Date.parse(row.ts);
    return Number.isFinite(t) && t >= since && row.renderStatus === 'confirmed';
  });
}

/**
 * Run the diagnosis without letting it become the failure. `diagnoseNativeEnvironment`
 * is documented never to reject, but it is called here on paths that are ALREADY
 * broken — an injected stub or a future probe throwing must cost the attribution
 * line, never turn a legible verify error into a stack trace.
 */
async function safeDiagnose(
  diagnose: typeof diagnoseNativeEnvironment,
  opts: Parameters<typeof diagnoseNativeEnvironment>[0],
): Promise<EnvironmentDiagnosis | undefined> {
  try {
    return await diagnose(opts);
  } catch {
    return undefined;
  }
}

function componentKey(pathOrName: string): string {
  return pathOrName
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.[jt]sx?$/, '');
}

/**
 * Resolve the spec's target component file. Prefers the frozen spec's bound
 * targets (basename match against discovered components — the same key the
 * native MCP path uses), then falls back to the prompt-driven change selection
 * ONLY for specs that bound no targets. Returns the project-relative component
 * path, or null when nothing resolves (which becomes a build-failing `error`,
 * never a silent pass and never a verdict against the wrong component).
 */
function resolveTargetComponent(projectRoot: string, spec: Spec): string | null {
  // BOTH sides must reduce to a bare basename. `targets.components` holds
  // whatever the spec author bound — MCP-created specs store a project-relative
  // PATH (`app/screens/WelcomeScreen.tsx`), older/hand-written ones a bare name
  // (`Button`). Comparing an un-normalized path against a basename never
  // matched, so every path-bound spec fell through to the prompt fallback and
  // verified a DIFFERENT component than the one it targets — checks then failed
  // (or passed) against a screen the spec never named.
  const wanted = new Set((spec.targets?.components ?? []).map((c) => componentKey(c)));
  if (wanted.size > 0) {
    for (const rel of discoverComponentFiles(projectRoot)) {
      if (wanted.has(componentKey(rel))) return rel;
    }
    // Declared targets that resolve to NOTHING must not silently become "run
    // the prompt's best guess". Returning null makes this a build-failing
    // error naming the unresolved target — the prompt fallback below is only
    // for specs that bound no targets at all.
    return null;
  }
  const fromPrompt = selectComponentsToRender({
    prompt: spec.source.prompt,
    projectRoot,
    max: 1,
  });
  if (fromPrompt.length > 0) {
    const abs = fromPrompt[0]!;
    return abs.startsWith(projectRoot) ? abs.slice(projectRoot.length).replace(/^[\\/]/, '') : abs;
  }
  return null;
}

/**
 * The props a configured component should render under, mirroring the web
 * fanout in `run.ts`: a component with fixtures renders under a fixture's
 * props, otherwise under its plain `props` entry.
 *
 * This has to happen HOST-side. The device applies only `overrides` — the
 * `fixture` name that travels in the deep link / bridge navigate is an input to
 * the remount key, NOT a lookup key, because there is no fixtures map in the
 * bundle (see ValidityNativeRoot: `const props = overrides ?? {}`). Leaving the
 * name unresolved renders the component with `{}` props, which is how a Button
 * whose label comes from `fixtures.default.props.text` drew empty and reported
 * its accessible-name criteria `unverifiable` on BOTH platforms.
 *
 * Unlike web, native captures ONCE per spec rather than once per fixture, so a
 * multi-fixture component verifies under its FIRST fixture. That is the
 * configured state nearest to "render this component" and is strictly better
 * evidence than propless; per-fixture fanout on device is a separate change.
 */
export function resolveConfiguredProps(
  config: ValidityConfig,
  projectRoot: string,
  component: string,
): { props?: Record<string, unknown>; fixture?: string } {
  const abs = resolve(projectRoot, component);
  const rel = abs.startsWith(projectRoot) ? abs.slice(projectRoot.length + 1) : abs;
  const components = config.components ?? {};
  const entry = components[rel] ?? components[abs] ?? components[component];
  if (!entry) return {};
  const fixtures = entry.fixtures;
  const names = fixtures ? Object.keys(fixtures) : [];
  if (names.length > 0) {
    const name = names[0]!;
    return { props: fixtures![name]?.props ?? {}, fixture: name };
  }
  return entry.props ? { props: entry.props } : {};
}

/**
 * Verify ONE frozen native spec mechanically on a booted emulator. Never
 * throws — every failure lands in `error` (build-failing) so the headless
 * runner's exit gate can act on it.
 */
export async function verifyOneSpecNative(
  projectRoot: string,
  config: ValidityConfig,
  spec: Spec,
  booted: BootedTarget,
  deps: NativeVerifyDeps = {},
): Promise<SpecVerification> {
  const capture = deps.capture ?? captureNative;
  const diagnose = deps.diagnose ?? diagnoseNativeEnvironment;
  const prepareApp = deps.prepareApp ?? prepareNativeApp;
  const ensureMetro = deps.ensureMetro ?? ensureCompanionMetro;
  const startBridge = deps.startBridge ?? startNativeBridge;
  const remoteConfigPath = resolveRemoteConfigPath(config.native, projectRoot);
  // Secrets resolve once per spec run: config declares name→env, the
  // environment supplies values, and only resolvable declarations travel —
  // an unset one surfaces at the fill as a blocked (unverifiable) check.
  const resolvedSecrets = resolveSecrets(configuredSecrets(config.scenarios), process.env).resolved;
  // Advisory device-side evidence (perf metrics/frames + network dump), off
  // unless the project asked for it. Read once per spec: an explicit `true` is
  // the only value that turns it on, so a config written before the option
  // existed keeps the byte-identical two-spawns-cheaper path.
  const wantDeviceEvidence = config.native?.deviceEvidence === true;
  const makeDriver =
    deps.makeDriver ??
    ((o): NativeDriver =>
      new AgentDeviceDriver({
        platform: o.platform,
        device: o.device,
        scheme: o.scheme,
        metroUrl: o.metroUrl,
        // agent-device keys sessions by CWD, so the spawn cwd is half the
        // session's identity — pin it (and the diagnosis context) to the
        // project root instead of inheriting the host process's cwd.
        projectRoot,
        cwd: projectRoot,
        ...(o.recordingPath ? { recordingPath: o.recordingPath } : {}),
        // Remote device profile, when the project configured one — appended as
        // `--remote-config <path>` to every agent-device command this driver
        // spawns (see NativeConfig.remote). Unset leaves the local path
        // byte-identical.
        ...(remoteConfigPath ? { remoteConfigPath } : {}),
      }));

  // The spec's hard/property criteria that carry executable checks — the only
  // ones the device can verify. Soft criteria are never scored here (no LLM),
  // same as the web path. Command criteria are excluded: they execute once per
  // run on the HOST at projectRoot (typechecking RN code is exactly as
  // meaningful), merged in below after the render is confirmed.
  const checkCriteria: SpecCriterion[] = spec.criteria.filter(
    (c) => c.checks && c.checks.length > 0 && !criterionUsesCommandChecks(c),
  );

  const component = resolveTargetComponent(projectRoot, spec);
  if (!component) {
    return {
      spec,
      meta: null,
      mechanical: [],
      error:
        'native verify: could not resolve a target component for this spec ' +
        '(no bound targets matched, and the prompt selected no component file)',
    };
  }

  const platform = booted.platform ?? 'android';

  try {
    const app = prepareApp({ projectRoot, config });

    /* ---------------------------------------------------------------------- */
    /* PREVENTIVE BUNDLER RECYCLE                                              */
    /* ---------------------------------------------------------------------- */
    // The companion Metro decays after ~40-50 device opens and never recovers on
    // its own (2026-07-29 isolation run; see metro-heal.ts for the full record).
    // Reacting to that costs a handful of unverifiable specs per collapse,
    // because the decay signature needs a streak before it can be told apart
    // from a component that simply didn't render. Recycling the bundler a sweep
    // BEFORE the measured cliff costs one `--clear` cold bundle every few sweeps
    // and means an unattended loop never reaches it.
    //
    // The recycle is performed by INVALIDATING THE CONTENT MARKER, which is the
    // sanctioned managed restart: `ensureCompanionMetro` below then reads
    // "already up + content CHANGED" and takes its existing verified kill →
    // `--clear` respawn branch. Nothing new spawns or signals anything.
    const healRecord = readMetroHealRecord(app.appDir);
    const bundlerEpoch = bundlerEpochStartMs({
      ownerStartedAt: readMetroOwnerMarker(app.appDir)?.startedAt,
      journalEpoch: healRecord?.bundlerEpochStartedAt,
    });
    if (bundlerEpoch === undefined) {
      // Nothing knows when this bundler started — the normal state for the one
      // the `expo run` build left running, which is exactly the bundler a long
      // unattended sweep begins on. Record first sighting so the count has a
      // clock; an epoch that starts late only ever delays the recycle.
      writeMetroHealRecord(app.appDir, {
        ts: healRecord?.ts ?? new Date().toISOString(),
        trigger: healRecord?.trigger ?? 'preventive',
        outcome: healRecord?.outcome ?? 'recovered',
        bundlerEpochStartedAt: new Date().toISOString(),
      });
    }
    const served = capturesOnBundler(readSessionMetrics(projectRoot), bundlerEpoch);
    const preventive = decidePreventiveRecycle({
      platform,
      configured: config.native?.metroRecycleAfterCaptures,
      capturesOnBundler: served,
      restartsSoFar: metroAutoRestartCount(),
    });
    let restartTrigger: MetroRestartTrigger | undefined;
    if (preventive.recycle && invalidateMetroContentMarker(app.metroContentMarkerPath)) {
      restartTrigger = 'preventive';
      noteMetroAutoRestart();
      note(`recycling the companion Metro before it decays: ${preventive.reason}`);
      writeMetroHealRecord(app.appDir, {
        ts: new Date().toISOString(),
        trigger: 'preventive',
        // Pessimistic until a capture confirms — see MetroHealRecord.outcome.
        outcome: 'failed',
        specId: spec.id,
        capturesOnBundler: served,
        bundlerEpochStartedAt: new Date().toISOString(),
      });
    }

    const metro = await ensureMetro(app.appDir, {
      contentHash: app.contentHash,
      contentMarkerPath: app.metroContentMarkerPath,
    });
    if (!metro.up) {
      // Metro refusing to come up is very often NOT Metro's fault: something
      // else already holds the companion port (a hand-started `expo start` is
      // the documented trap). Probe before reporting, so the message names the
      // process to kill rather than sending the reader into a bundler log.
      const diagnosis = await safeDiagnose(diagnose, {
        projectRoot,
        platform,
        appDir: app.appDir,
      });
      return {
        spec,
        meta: null,
        mechanical: [],
        error:
          'native verify: the companion Metro bundler did not come up' +
          (metro.earlyExitCode !== undefined ? ` (exit ${metro.earlyExitCode})` : '') +
          (metro.logPath ? ` (log: ${metro.logPath})` : '') +
          formatDiagnosisTail(diagnosis),
        ...(diagnosis ? { diagnosis } : {}),
      };
    }

    // Persisted-run scaffolding: the run gets a real id + run dir up front so
    // the screenshot lands under `.validity/runs/<runId>/screenshots/` (parity
    // with the MCP native path) and the run-meta written on success references
    // artifacts that actually live in the run dir.
    const runId = newRunId();
    const { screenshotsDir } = ensureRunDirectories(projectRoot, runId);
    const componentId = componentIdFor(resolve(projectRoot, component), projectRoot);
    const runDirPath = runDir(projectRoot, runId);
    const recordReplay = nativeRecordReplayEnabled(config.native);

    const configured = resolveConfiguredProps(config, projectRoot, component);
    const target: TargetSpec = {
      component,
      mockNetwork: app.prepared.dataPayload.mockNetwork,
      ...(configured.props && Object.keys(configured.props).length > 0
        ? { overrides: configured.props }
        : {}),
      ...(configured.fixture ? { fixture: configured.fixture } : {}),
    };
    const screenshotPath = resolve(screenshotsDir, `${componentId}__base.png`);
    const metroLogPath = resolve(app.appDir, 'validity-native.log');

    /**
     * One capture attempt, bridge opened and closed around it. Extracted so the
     * Metro auto-heal below can run a SECOND one after a restart — the bridge
     * must not outlive an attempt (the companion is reloaded/relaunched across a
     * restart, and a half-attached socket would let the retry warm-ack a dead
     * session).
     *
     * The two post-restart knobs are deliberately INDEPENDENT, because a
     * Metro restart has two very different reasons and they want opposite
     * treatment:
     *
     *   - `waitForBundle` applies to BOTH. A restarted bundler has an empty
     *     cache and has to build before anything can attach; without the gate
     *     the open's fixed 4s bundle sleep expires against the dev launcher and
     *     every confirmation rung times out — which would make a heal that
     *     WORKED look like one that didn't.
     *   - `forceReload` applies ONLY when the CONTENT changed. Then the running
     *     app holds a genuinely stale bundle and a warm re-target would ack old
     *     code as success (the bug browse.ts already fixes this way). When
     *     Validity restarted the bundler for AGE — the heal and the preventive
     *     recycle both regenerate the identical content — the running bundle is
     *     not stale at all, and forcing a reload only spends the attempt's
     *     budget tearing down an app that just needed the bundler back.
     *     Measured on device 2026-07-29: the forced-reload retry burned 45.6s
     *     and stayed unconfirmed, while the very next spec, opening normally
     *     against the same restarted Metro, confirmed in 11.5s.
     */
    const attemptCapture = async (o: {
      forceReload: boolean;
      waitForBundle: boolean;
    }): Promise<NativeCaptureResult> => {
      // Captured BEFORE the open so only THIS attempt's bundle output can
      // satisfy the wait (a previous "Bundled" line must not count).
      const metroLogOffset = metroLogLength(metroLogPath);
      // Open the bridge inside the try so any failure in driver/target setup
      // still closes the WS in the finally (no leaked bridge on the error path).
      const bridge = startBridge();
      try {
        bridge.setNativeData(app.prepared.dataPayload);

        const driver = makeDriver({
          platform,
          device: booted.deviceId,
          scheme: app.scheme,
          // Arms the `.ad` recording on the session-establishing open. Only the
          // FIRST driver of the process actually arms it (upstream permits one
          // recorded open per session), so in a sweep this recording lands in
          // the run dir of whichever spec opened the session — see
          // replay-recording.ts. Off when the project opted out.
          ...(recordReplay ? { recordingPath: recordingPathFor(runDirPath) } : {}),
        });

        return await capture({
          driver,
          spec: target,
          screenshotPath,
          bridge,
          bundleId: app.bundleId,
          // Per-capture diagnostics: one metrics row per capture (the evidence
          // base for spotting session decay) and, on an unconfirmed render, a
          // named cause instead of silence. Additive only.
          projectRoot,
          specId: spec.id,
          expectedContentHash: app.prepared.contentHash,
          ...(o.forceReload ? { forceReload: true } : {}),
          ...(o.waitForBundle
            ? {
                waitForBundle: () =>
                  waitForBundleServed({ logPath: metroLogPath, sinceOffset: metroLogOffset }),
              }
            : {}),
          // Run the spec's hard/property checks on the device after a confirmed
          // render. captureNative forwards matchedRequests/consoleErrorCount/
          // unmatchedUrls into the executor so the network-taint demotion fires.
          criteriaChecks: checkCriteria,
          // Resolved scenario secrets for secret-safe fills: a `${NAME}` fill
          // types the live value while the armed `.ad` records the placeholder
          // (see planRecordedFill). Resolved once per spec from config + env.
          ...(resolvedSecrets.length > 0 ? { secrets: resolvedSecrets } : {}),
          // Advisory device-side perf/network evidence (config opt-in). Costs
          // two extra agent-device spawns per capture, so it is off unless
          // asked for; nothing it produces can reach a verdict.
          ...(wantDeviceEvidence ? { captureDeviceEvidence: true } : {}),
        });
      } finally {
        bridge.close();
      }
    };

    // `restartedForContent` covers BOTH reasons Metro was just recycled — but
    // only one of them means the running app's bundle is actually stale. The
    // preventive branch above deleted the marker itself for AGE, with identical
    // content, so a restart it caused must not force a reload (see attemptCapture).
    const metroRestarted = metro.restartedForContent === true;
    let cap = await attemptCapture({
      forceReload: metroRestarted && restartTrigger === undefined,
      // Observable bundle wait for ANY Metro this call brought up, not only a
      // content restart: a fresh spawn has a cold (or --clear'd) cache either
      // way, and the first post-install verify used to spend its fixed 4s
      // bundle sleep against a 30-90s first build — landing UNVERIFIABLE on
      // run 1 and green on run 2, the exact bounce a pilot dev won't retry
      // past. Costs nothing when the wired wait resolves on the first serve.
      waitForBundle: metroRestarted || metro.started === true,
    });

    /* ---------------------------------------------------------------------- */
    /* REACTIVE HEAL — a decayed bundler, restarted in band                    */
    /* ---------------------------------------------------------------------- */
    // The `metro-decayed` diagnosis names the one layer a restart is PROVEN to
    // recover, and until now it only ever named it — every sweep past the cliff
    // stayed collapsed until a human deleted the marker by hand. This performs
    // that exact deletion, then retries the spec ONCE. Bounded by
    // `decideMetroHeal` (per-run budget + a failed heal that nothing rendered
    // after), so a collapsed sweep restarts the bundler at most once and every
    // spec after it reports the truth instead of kicking Metro again.
    if (cap.render.status !== 'confirmed' && cap.diagnosis) {
      const lastHeal = readMetroHealRecord(app.appDir);
      const decision = decideMetroHeal({
        diagnosisCause: cap.diagnosis.cause,
        restartsSoFar: metroAutoRestartCount(),
        lastHeal,
        confirmedSinceLastHeal: hasConfirmedSince(projectRoot, lastHeal?.ts),
      });
      if (decision.heal && invalidateMetroContentMarker(app.metroContentMarkerPath)) {
        restartTrigger = 'decay-diagnosis';
        noteMetroAutoRestart();
        note(`${decision.reason} (spec ${spec.id})`);
        const healTs = new Date().toISOString();
        writeMetroHealRecord(app.appDir, {
          ts: healTs,
          trigger: 'decay-diagnosis',
          outcome: 'failed',
          specId: spec.id,
          bundlerEpochStartedAt: healTs,
        });
        const healed = await ensureMetro(app.appDir, {
          contentHash: app.contentHash,
          contentMarkerPath: app.metroContentMarkerPath,
        });
        if (healed.up) {
          // No forceReload: the heal regenerated identical content, so the app's
          // bundle is not stale — it only needed the bundler back. See attemptCapture.
          const retry = await attemptCapture({ forceReload: false, waitForBundle: true });
          if (retry.render.status === 'confirmed') {
            note(`the companion Metro restart recovered spec ${spec.id} — continuing`);
            writeMetroHealRecord(app.appDir, {
              ts: healTs,
              trigger: 'decay-diagnosis',
              outcome: 'recovered',
              specId: spec.id,
              bundlerEpochStartedAt: healTs,
            });
          } else {
            note(
              `the companion Metro restart did NOT recover spec ${spec.id} ` +
                `(render ${retry.render.status}) — reporting it`,
            );
          }
          // The retry's result REPLACES the first attempt's either way. A retry
          // that still failed is the more recent (and more informative) truth:
          // it was taken against a freshly restarted bundler, so its diagnosis
          // can no longer be the decay this just ruled out.
          cap = retry;
        } else {
          note(
            'the companion Metro did not come back up after the auto-restart' +
              (healed.earlyExitCode !== undefined ? ` (exit ${healed.earlyExitCode})` : ''),
          );
        }
        appendMetroRestartEvent(projectRoot, {
          event: 'metro-auto-restart',
          ts: healTs,
          platform,
          trigger: 'decay-diagnosis',
          specId: spec.id,
          metroUp: healed.up,
          outcome: cap.render.status === 'confirmed' ? 'recovered' : 'failed',
        });
      } else if (cap.diagnosis.cause === 'metro-decayed') {
        // Refused. SAY SO on the diagnosis: its fixCommand is the very restart
        // Validity just performed (or deliberately declined to repeat), and a
        // reader who runs it again learns nothing.
        cap = {
          ...cap,
          diagnosis: { ...cap.diagnosis, autoRemediation: decision.reason },
        };
      }
    }

    // The preventive recycle's own outcome, recorded once the spec that paid
    // for it has a verdict.
    if (restartTrigger === 'preventive') {
      appendMetroRestartEvent(projectRoot, {
        event: 'metro-auto-restart',
        ts: new Date().toISOString(),
        platform,
        trigger: 'preventive',
        specId: spec.id,
        capturesOnBundler: served,
        metroUp: metro.up,
        outcome: cap.render.status === 'confirmed' ? 'recovered' : 'failed',
      });
      if (cap.render.status === 'confirmed') {
        writeMetroHealRecord(app.appDir, {
          ts: new Date().toISOString(),
          trigger: 'preventive',
          outcome: 'recovered',
          specId: spec.id,
          capturesOnBundler: served,
          bundlerEpochStartedAt: readMetroHealRecord(app.appDir)?.bundlerEpochStartedAt,
        });
      }
    }

    // GATE INTEGRITY: anything that is NOT a confirmed render is not evidence.
    // captureNative leaves `criterionVerdicts` undefined there, so returning an
    // empty `mechanical` would let aggregateVerdicts mark hard criteria
    // `unverifiable` and (absent a coverage floor) the build would go GREEN
    // despite nothing rendering. Surface it as a build-failing `error` instead.
    if (cap.render.status !== 'confirmed') {
      // The historical dead end: this message was the whole story a developer
      // got for five different causes. The verdict is unchanged (an
      // unconfirmed render still fails the build) — what is added is WHY, with
      // the command that fixes it.
      const d = cap.diagnosis;
      return {
        spec,
        meta: null,
        mechanical: [],
        error:
          `native verify: render not confirmed (status=${cap.render.status})` +
          formatDiagnosisTail(d),
        // Structured twin of the prose above, so verify-all's table/markdown/
        // JUnit/check-metadata surfaces can attribute this without re-parsing.
        ...(d ? { diagnosis: d } : {}),
      };
    }

    // Run-level `expect.command` criteria (A5) — executed on the HOST after
    // the render is confirmed, then merged in. Deliberately BELOW the
    // gate-integrity early-returns above: an unconfirmed render still fails
    // the build; a green typecheck doesn't rescue it.
    const commandVerdicts = await executeCommandCriteria({
      criteria: spec.criteria.filter(criterionUsesCommandChecks),
      commands: config.commands,
      projectRoot,
      timeoutMs: config.commandTimeoutMs,
      runner: deps.commandRunner,
    });

    // Roll up to ONE verdict per spec criterion (mirrors web's
    // collectCriterionVerdicts): device-executed checks keep their verdicts;
    // soft and un-executed hard/property criteria become `unverifiable`
    // placeholders — so the run-meta lists the whole contract and its
    // verdict/signedOff roll-up can never read green off a partial set.
    const executed = new Map((cap.criterionVerdicts ?? []).map((v) => [v.id, v]));
    const criterionVerdicts = overlayCommandVerdicts(
      spec.criteria.map(
        (c): CriterionVerdict =>
          executed.get(c.id) ?? {
            id: c.id,
            tier: c.tier,
            status: 'unverifiable',
            detail:
              c.tier === 'soft'
                ? 'soft criterion — needs agent verify (no LLM in the CLI)'
                : 'checks did not execute on the device',
          },
      ),
      commandVerdicts,
    );

    // ADVISORY device evidence, written beside the run's other artifacts. It
    // lands AFTER the gate-integrity return above and touches nothing on the
    // way past: no verdict, no criterion, no run-meta field reads it. A run
    // that would have been red is still red with this file present, and a run
    // that would have been green is still green with it absent.
    persistDeviceEvidence(runDirPath, cap.deviceEvidence);

    // Persist the run-meta (the CLI cousin of the MCP server's
    // writeNativeRunMeta call) and return it. Beyond report screenshots, this
    // is what lets `verify --all` classify temporal binding (B2) from
    // `meta.git`/`meta.diff` — a native success used to return `meta: null`,
    // which forced every native spec's classification to `unknown`.
    let source = '';
    try {
      source = readFileSync(resolve(projectRoot, component), 'utf-8');
    } catch {
      // Source is display-only evidence — never fail a verified run over it.
    }
    writeNativeRunMeta({
      projectRoot,
      runId,
      prompt: spec.source.prompt,
      scenarios: [],
      components: [
        {
          id: componentId,
          filePath: component,
          screenshotPath: cap.screenshotPath,
          renderConfirmation: 'confirmed',
          a11ySnapshot: cap.a11ySnapshot || undefined,
          unmatchedUrls: cap.render.unmatchedUrls,
          performance: cap.render.perf,
          criterionVerdicts: cap.criterionVerdicts,
        },
      ],
      componentSources: { [componentId]: source },
      // Device provenance: which simulator/emulator, which OS, which companion
      // build drew these pixels. Without it a native run is unattributable.
      nativeDevice: {
        platform: platform,
        deviceId: booted.deviceId,
        ...(booted.deviceName ? { deviceName: booted.deviceName } : {}),
        ...(booted.osVersion ? { osVersion: booted.osVersion } : {}),
        ...(app.prepared.contentHash ? { buildHash: app.prepared.contentHash } : {}),
      },
      reportConfig: resolveReportConfig(config.report),
      specId: spec.id,
      specVersion: spec.version,
      specHash: spec.hash,
      criterionVerdicts,
      coverageFloorPercent: config.coverageFloorPercent,
      historyCommitted: config.historyCommitted,
    });

    return {
      spec,
      meta: readRunMeta(projectRoot, runId),
      mechanical: criterionVerdicts,
    };
  } catch (err) {
    // Best-effort attribution for a THROWN capture — the path that swallowed
    // the two agent-device signatures worth naming (a phantom device claim,
    // and Android's second-`open`-per-session 127). The thrown text is fed in
    // as `openErrorText` precisely so those signatures can be recognized;
    // the message itself is preserved verbatim ahead of any added cause.
    const message = (err as Error).message;
    const diagnosis = await safeDiagnose(diagnose, {
      projectRoot,
      platform,
      openErrorText: message,
    });
    return {
      spec,
      meta: null,
      mechanical: [],
      error: message + formatDiagnosisTail(diagnosis),
      ...(diagnosis ? { diagnosis } : {}),
    };
  }
}
