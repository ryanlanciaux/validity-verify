/**
 * Unit tests for the headless native verify engine, driven entirely through
 * the injectable `deps` seams — NO emulator, NO Metro, NO `agent-device`.
 *
 * Regression under test: "verify-all native specs always classify temporal
 * binding as 'unknown'" — `verifyOneSpecNative` used to return `meta: null`
 * on its SUCCESS path, so `verify --all` classified every native spec's
 * temporal binding via the `{ git: undefined }` stub (rule 1 ⇒ `unknown`).
 * A confirmed native verify must now persist + return a real run-meta whose
 * `git`/`diff` let the classification run, exactly like the web engine.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTemporalBinding, runDir, type Spec, type ValidityConfig } from '@validity.ai/verify-spec';
import {
  appendCaptureMetric,
  diagnoseNativeEnvironment,
  readMetroHealRecord,
  readSessionMetrics,
  resetMetroAutoRestartCount,
  SESSION_METRICS_RELATIVE_PATH,
  writeMetroHealRecord,
} from '@validity.ai/verify-native';
import type {
  captureNative,
  ensureCompanionMetro,
  prepareNativeApp,
  startNativeBridge,
  DeviceEvidence,
  EnvironmentDiagnosis,
  NativeCaptureResult,
  NativeDeviceEvidence,
  NativeDriver,
} from '@validity.ai/verify-native';
import {
  deviceEvidenceRecords,
  resolveConfiguredProps,
  verifyOneSpecNative,
  type NativeVerifyDeps,
} from './native-verify-engine.js';

describe('verifyOneSpecNative — run-meta on the success path (B2 temporal fix)', () => {
  let root: string;

  beforeEach(() => {
    // realpath: on darwin `tmpdir()` is a symlink (/var → /private/var) and
    // componentIdFor/discovery compare project-relative paths.
    root = realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-native-engine-')));
    mkdirSync(resolve(root, 'src'), { recursive: true });
    writeFileSync(
      resolve(root, 'src', 'MyScreen.tsx'),
      'export default function MyScreen() {\n  return <div>Title</div>;\n}\n',
    );
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@validity.local']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
  }

  function makeSpec(over: Partial<Spec> = {}): Spec {
    return {
      id: 'spec-native',
      version: 1,
      status: 'frozen',
      source: { prompt: 'Build the native screen', createdBy: 'user' },
      runtime: 'native',
      targets: { components: ['MyScreen'] },
      criteria: [
        {
          id: 'AC-1',
          text: 'shows the title',
          tier: 'hard',
          checks: [{ click: { role: 'button' } }],
        },
        { id: 'AC-2', text: 'looks polished', tier: 'soft' },
      ],
      hash: 'sha256-native',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...over,
    };
  }

  function makeDeps(over: {
    renderStatus?: 'confirmed' | 'unconfirmed' | 'failed';
    verdicts?: NativeCaptureResult['criterionVerdicts'];
  }): NativeVerifyDeps {
    const app = {
      appDir: resolve(root, 'node_modules', '.validity-native'),
      scheme: 'validity',
      bundleId: 'ai.validity.companion',
      contentHash: 'hash-1',
      metroContentMarkerPath: resolve(root, 'node_modules', '.validity-native', 'marker'),
      prepared: { dataPayload: { mockNetwork: undefined }, contentHash: 'hash-1' },
    };
    return {
      prepareApp: (() => app) as unknown as typeof prepareNativeApp,
      ensureMetro: (async () => ({ up: true })) as unknown as typeof ensureCompanionMetro,
      startBridge: (() => ({
        setNativeData: () => {},
        close: () => {},
      })) as unknown as typeof startNativeBridge,
      makeDriver: () => ({}) as NativeDriver,
      capture: (async (opts: { screenshotPath: string }) => ({
        url: 'validity://render',
        screenshotPath: opts.screenshotPath,
        a11ySnapshot: 'a11y-tree',
        render: { status: over.renderStatus ?? 'confirmed', via: 'bridge-ack' },
        timing: {},
        criterionVerdicts: over.verdicts,
      })) as unknown as typeof captureNative,
    };
  }

  it('a confirmed render persists + returns a real run-meta whose git/diff classify temporal binding (never the meta:null unknown stub)', async () => {
    const spec = makeSpec();
    const result = await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      spec,
      { deviceId: 'emulator-5554', port: 5554 },
      makeDeps({
        verdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass', detail: 'text found' }],
      }),
    );

    expect(result.error).toBeUndefined();
    expect(result.meta).not.toBeNull();
    const meta = result.meta!;
    // The whole point of the fix: git facts are present, so verify-all's
    // classifyTemporal no longer falls into rule 1 (`no verify sha ⇒ unknown`).
    expect(meta.git?.sha).toBe(git(['rev-parse', 'HEAD']));
    expect(meta.mode).toBe('native');
    expect(meta.specId).toBe('spec-native');
    expect(meta.specVersion).toBe(1);
    // Persisted for real — the returned meta is read back off disk.
    expect(existsSync(resolve(runDir(root, meta.runId), 'run-meta.json'))).toBe(true);

    // End-to-end B2: a spec frozen at HEAD with a clean tree classifies
    // affirmatively instead of 'unknown'.
    const temporal = resolveTemporalBinding({
      projectRoot: root,
      freeze: { sha: meta.git!.sha, dirty: false, changedFiles: [] },
      meta,
    });
    expect(temporal.classification).toBe('frozen-before-work');
  });

  it('rolls up ONE verdict per spec criterion: executed checks keep verdicts, soft criteria stay unverifiable placeholders', async () => {
    const result = await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      makeSpec(),
      { deviceId: 'emulator-5554', port: 5554 },
      makeDeps({
        verdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass', detail: 'text found' }],
      }),
    );
    expect(result.mechanical).toEqual([
      { id: 'AC-1', tier: 'hard', status: 'pass', detail: 'text found' },
      {
        id: 'AC-2',
        tier: 'soft',
        status: 'unverifiable',
        detail: 'soft criterion — needs agent verify (no LLM in the CLI)',
      },
    ]);
    // The persisted run-meta carries the same full contract, so its
    // verdict/signedOff roll-up can never read green off a partial set.
    expect(result.meta?.criterionVerdicts).toEqual(result.mechanical);
    expect(result.meta?.signedOff).toBe(false);
  });

  it('an unconfirmed render still returns meta:null with a build-failing error (gate integrity unchanged)', async () => {
    const result = await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      makeSpec(),
      { deviceId: 'emulator-5554', port: 5554 },
      makeDeps({ renderStatus: 'unconfirmed' }),
    );
    expect(result.meta).toBeNull();
    expect(result.mechanical).toEqual([]);
    expect(result.error).toMatch(/render not confirmed/);
  });

  // ── Failure attribution (handoff-2026-07-28) ──
  //
  // "render not confirmed" was the whole story a developer got for five
  // different causes. These pin that the cause now rides both the prose AND a
  // structured field — and that the GATE is untouched either way, since an
  // undiagnosed failure must fail exactly as it always did.

  const DIAGNOSIS = {
    cause: 'phantom-device-claim' as const,
    symptom: '`open` says the device is in use by session "default"; `session list` reports none.',
    detail: 'A device claim outlived its session, so nothing could be opened.',
    fixCommand: 'kill $(cat daemon.pid)\nrm -rf "$HOME/.agent-device/sessions"',
    confidence: 'confirmed' as const,
  };

  it('attaches the capture diagnosis to an unconfirmed render, in prose AND structured', async () => {
    const deps = makeDeps({ renderStatus: 'unconfirmed' });
    const result = await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      makeSpec(),
      { deviceId: 'emulator-5554', port: 5554 },
      {
        ...deps,
        capture: (async (opts: { screenshotPath: string }) => ({
          url: 'validity://render',
          screenshotPath: opts.screenshotPath,
          a11ySnapshot: '',
          render: { status: 'unconfirmed', via: 'settle' },
          timing: {},
          diagnosis: DIAGNOSIS,
        })) as unknown as typeof captureNative,
      },
    );
    expect(result.diagnosis).toEqual(DIAGNOSIS);
    expect(result.error).toContain('likely cause (confirmed)');
    expect(result.error).toContain('session list` reports none');
    // The full recipe is indented as a block, not clipped to one line.
    expect(result.error).toContain('rm -rf "$HOME/.agent-device/sessions"');
    // GATE INTEGRITY: still a build-failing error with no verdicts.
    expect(result.meta).toBeNull();
    expect(result.mechanical).toEqual([]);
  });

  it('leaves the error byte-identical when the capture attached no diagnosis', async () => {
    const result = await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      makeSpec(),
      { deviceId: 'emulator-5554', port: 5554 },
      makeDeps({ renderStatus: 'unconfirmed' }),
    );
    expect(result.diagnosis).toBeUndefined();
    expect(result.error).toBe('native verify: render not confirmed (status=unconfirmed)');
  });

  it('probes for a cause when Metro never comes up (a foreign process on the port)', async () => {
    const deps = makeDeps({});
    const result = await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      makeSpec(),
      { deviceId: 'emulator-5554', port: 5554 },
      {
        ...deps,
        ensureMetro: (async () => ({
          up: false,
          earlyExitCode: 1,
        })) as unknown as typeof ensureCompanionMetro,
        diagnose: async () => ({
          cause: 'foreign-metro',
          symptom: 'Port 8082 is served by a Metro Validity did not start.',
          detail: 'A hand-started `expo start` is serving the companion port.',
          fixCommand: 'kill 4242',
          confidence: 'confirmed',
        }),
      },
    );
    expect(result.diagnosis?.cause).toBe('foreign-metro');
    expect(result.error).toContain('companion Metro bundler did not come up');
    expect(result.error).toContain('likely cause (confirmed)');
    expect(result.error).toContain('kill 4242');
  });

  it('feeds a THROWN capture back in as openErrorText so agent-device signatures are recognized', async () => {
    const deps = makeDeps({});
    let sawOpenErrorText: string | undefined;
    const result = await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      makeSpec(),
      { deviceId: 'emulator-5554', port: 5554 },
      {
        ...deps,
        capture: (async () => {
          throw new Error('Device is already in use by session "default"');
        }) as unknown as typeof captureNative,
        diagnose: async (opts) => {
          sawOpenErrorText = opts?.openErrorText;
          return DIAGNOSIS;
        },
      },
    );
    expect(sawOpenErrorText).toBe('Device is already in use by session "default"');
    expect(result.diagnosis).toEqual(DIAGNOSIS);
    // The thrown message survives VERBATIM ahead of the added cause.
    expect(result.error).toMatch(/^Device is already in use by session "default"/);
  });

  it('names a session-less sweep instead of the `cause: unknown` it used to report', async () => {
    // THE 2026-07-29 REGRESSION, end to end through the REAL diagnosis engine.
    // With the agent-device daemon cold at sweep start but the companion app
    // still running, the control bridge acked renders, no `agent-device open`
    // ever ran, and captureNative's screenshot threw on SESSION_NOT_FOUND. That
    // message reached this catch, matched no probe, and all SEVEN specs in the
    // sweep were reported as blocked with `cause: unknown`.
    const deps = makeDeps({});
    const result = await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      makeSpec(),
      { deviceId: 'sim-udid', port: 0, platform: 'ios' },
      {
        ...deps,
        capture: (async () => {
          throw new Error(
            'Screenshot failed (exit 1): Error (SESSION_NOT_FOUND): No active session. Run open first.',
          );
        }) as unknown as typeof captureNative,
        // The REAL engine, with the process-spawning probes disabled so this
        // stays a unit test — the match is on the text, which is the point.
        // stateDir pins the daemon probe to the scenario (cold daemon, no
        // state on disk). Without it the probe reads the developer's REAL
        // ~/.agent-device, and a host with a dead-pid daemon.json plus
        // leftover session dirs — any machine that has ever dogfooded native
        // verify — diagnoses `daemon-unresponsive` at step 5, before the
        // no-session probe this test is about ever runs.
        diagnose: (opts) =>
          diagnoseNativeEnvironment({
            ...opts,
            skipCommands: true,
            stateDir: resolve(root, 'no-agent-device-state'),
          }),
      },
    );
    expect(result.diagnosis?.cause).toBe('no-native-session');
    expect(result.diagnosis?.confidence).toBe('confirmed');
    expect(result.error).toMatch(/^Screenshot failed/); // verbatim, cause appended
    expect(result.error).toContain('likely cause (confirmed)');
    expect(result.error).toContain('agent-device open');
    // GATE INTEGRITY: naming the cause never rescues the run.
    expect(result.meta).toBeNull();
    expect(result.mechanical).toEqual([]);
  });

  it('a THROWING diagnose costs the attribution line, never the legible error', async () => {
    const deps = makeDeps({});
    const result = await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      makeSpec(),
      { deviceId: 'emulator-5554', port: 5554 },
      {
        ...deps,
        capture: (async () => {
          throw new Error('adb: device offline');
        }) as unknown as typeof captureNative,
        diagnose: async () => {
          throw new Error('lsof exploded');
        },
      },
    );
    expect(result.diagnosis).toBeUndefined();
    expect(result.error).toBe('adb: device offline');
  });

  it('WRONG-COMPONENT: a PATH-bound target resolves to that component, not the prompt fallback', async () => {
    // Regression: `targets.components` from an MCP-created spec holds a
    // project-relative path, which was compared un-normalized against a
    // basename and never matched — so the run silently fell back to the
    // prompt's best guess and rendered a DIFFERENT component, then reported
    // hard verdicts (including confident FAILs) against a screen it never
    // rendered. A second component must exist for the fallback to have
    // something wrong to pick.
    writeFileSync(
      resolve(root, 'src', 'Decoy.tsx'),
      'export default function Decoy() {\n  return <div>Decoy</div>;\n}\n',
    );
    const result = await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      makeSpec({
        targets: { components: ['src/MyScreen.tsx'] },
        source: { prompt: 'Decoy', createdBy: 'user' },
      }),
      { deviceId: 'emulator-5554', port: 5554 },
      makeDeps({ verdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass', detail: 'ok' }] }),
    );

    expect(result.error).toBeUndefined();
    // The rendered component is the BOUND target, never the prompt's pick.
    expect(result.meta?.components?.[0]?.filePath).toContain('MyScreen');
    expect(result.meta?.components?.[0]?.filePath).not.toContain('Decoy');
  });

  it('WRONG-COMPONENT: a bound target that resolves to nothing errors instead of guessing', async () => {
    const result = await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      makeSpec({
        targets: { components: ['app/screens/DeletedScreen.tsx'] },
        source: { prompt: 'MyScreen', createdBy: 'user' },
      }),
      { deviceId: 'emulator-5554', port: 5554 },
      makeDeps({ verdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass', detail: 'ok' }] }),
    );

    // Build-failing, not a verdict against whatever the prompt matched.
    expect(result.meta).toBeNull();
    expect(result.mechanical).toEqual([]);
    expect(result.error).toMatch(/could not resolve a target component/);
  });
});

/**
 * Regression: `validity verify` rendered every native component with `{}`
 * props, because the host never resolved a configured fixture into the
 * `overrides` the device actually applies. A Button whose label lives in
 * `fixtures.default.props.text` therefore drew empty, and its accessible-name
 * criteria came back `unverifiable` on iOS AND Android (spec-9279 in the
 * ValidityTestApp fixture — reproduced on device on both platforms).
 */
describe('verifyOneSpecNative — configured fixture props reach the device', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-native-props-')));
    mkdirSync(resolve(root, 'src'), { recursive: true });
    writeFileSync(
      resolve(root, 'src', 'Button.tsx'),
      'export default function Button() {\n  return <button />;\n}\n',
    );
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@validity.local'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const BUTTON = 'src/Button.tsx';

  function buttonSpec(): Spec {
    return {
      id: 'spec-button',
      version: 1,
      status: 'frozen',
      source: { prompt: 'The button shows its label', createdBy: 'user' },
      runtime: 'native',
      targets: { components: [BUTTON] },
      criteria: [
        {
          id: 'AC-1',
          text: 'exposes its label',
          tier: 'hard',
          checks: [{ expect: { element: { role: 'button', name: 'Continue' } } }],
        },
      ],
      hash: 'sha256-button',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  /** Deps that RECORD the TargetSpec handed to captureNative. */
  function recordingDeps(seen: { target?: Record<string, unknown> }): NativeVerifyDeps {
    const app = {
      appDir: resolve(root, 'node_modules', '.validity-native'),
      scheme: 'validity',
      bundleId: 'ai.validity.companion',
      contentHash: 'hash-1',
      metroContentMarkerPath: resolve(root, 'node_modules', '.validity-native', 'marker'),
      prepared: { dataPayload: { mockNetwork: undefined }, contentHash: 'hash-1' },
    };
    return {
      prepareApp: (() => app) as unknown as typeof prepareNativeApp,
      ensureMetro: (async () => ({ up: true })) as unknown as typeof ensureCompanionMetro,
      startBridge: (() => ({
        setNativeData: () => {},
        close: () => {},
      })) as unknown as typeof startNativeBridge,
      makeDriver: () => ({}) as NativeDriver,
      capture: (async (opts: { screenshotPath: string; spec: Record<string, unknown> }) => {
        seen.target = opts.spec;
        return {
          url: 'validity://render',
          screenshotPath: opts.screenshotPath,
          a11ySnapshot: 'a11y-tree',
          render: { status: 'confirmed', via: 'bridge-ack' },
          timing: {},
          criterionVerdicts: [
            { id: 'AC-1', tier: 'hard', status: 'pass', detail: 'button "Continue"' },
          ],
        };
      }) as unknown as typeof captureNative,
    };
  }

  it("sends the first fixture's props as overrides so the component renders in its configured state", async () => {
    const seen: { target?: Record<string, unknown> } = {};
    const config = {
      components: {
        [BUTTON]: {
          fixtures: {
            default: { props: { text: 'Continue', preset: 'default' } },
            filled: { props: { text: 'Continue', preset: 'filled' } },
          },
        },
      },
    } as unknown as ValidityConfig;

    const result = await verifyOneSpecNative(
      root,
      config,
      buttonSpec(),
      { deviceId: 'emulator-5554', port: 5554 },
      recordingDeps(seen),
    );

    expect(result.error).toBeUndefined();
    // The device applies ONLY overrides — this is the payload that makes the
    // label exist on screen at all.
    expect(seen.target?.overrides).toEqual({ text: 'Continue', preset: 'default' });
    // The name rides along so the remount key (and the URL) say which state ran.
    expect(seen.target?.fixture).toBe('default');
  });

  it('falls back to plain `props` when the component declares no fixtures', async () => {
    const seen: { target?: Record<string, unknown> } = {};
    const config = {
      components: { [BUTTON]: { props: { text: 'Continue' } } },
    } as unknown as ValidityConfig;

    await verifyOneSpecNative(
      root,
      config,
      buttonSpec(),
      { deviceId: 'emulator-5554', port: 5554 },
      recordingDeps(seen),
    );

    expect(seen.target?.overrides).toEqual({ text: 'Continue' });
    expect(seen.target?.fixture).toBeUndefined();
  });

  it('sends no overrides at all for an unconfigured component (unchanged behaviour)', async () => {
    const seen: { target?: Record<string, unknown> } = {};
    await verifyOneSpecNative(
      root,
      {} as ValidityConfig,
      buttonSpec(),
      { deviceId: 'emulator-5554', port: 5554 },
      recordingDeps(seen),
    );

    expect(seen.target?.overrides).toBeUndefined();
    expect(seen.target?.fixture).toBeUndefined();
    expect(seen.target?.component).toContain('Button');
  });

  describe('resolveConfiguredProps', () => {
    it('matches a config keyed by absolute path as well as project-relative', () => {
      const abs = resolve(root, BUTTON);
      const config = {
        components: { [abs]: { fixtures: { only: { props: { text: 'Continue' } } } } },
      } as unknown as ValidityConfig;
      expect(resolveConfiguredProps(config, root, BUTTON)).toEqual({
        props: { text: 'Continue' },
        fixture: 'only',
      });
    });

    it('treats a fixture with no props as an empty (but named) state rather than throwing', () => {
      const config = {
        components: { [BUTTON]: { fixtures: { bare: {} } } },
      } as unknown as ValidityConfig;
      expect(resolveConfiguredProps(config, root, BUTTON)).toEqual({ props: {}, fixture: 'bare' });
    });

    it('returns nothing for a component the config does not mention', () => {
      expect(resolveConfiguredProps({} as ValidityConfig, root, BUTTON)).toEqual({});
    });
  });
});

/**
 * THE METRO AUTO-HEAL (task #28).
 *
 * The 2026-07-29 isolation run proved the companion Metro is the layer that
 * decays after ~40-50 device opens, and that restarting it recovers the sweep
 * every time — but nothing ever restarted it, so an unattended loop collapsed
 * and stayed collapsed. These tests drive the whole in-band recovery through the
 * same injectable seams: the restart trigger, the retry, the bounding rules that
 * stop it becoming a restart loop, and the requirement that a heal is never
 * silent (in the log, in the metrics, or on the reported diagnosis).
 */
describe('verifyOneSpecNative — companion-Metro auto-heal', () => {
  let root: string;
  let appDir: string;
  let markerPath: string;

  beforeEach(() => {
    resetMetroAutoRestartCount();
    root = realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-metro-heal-')));
    mkdirSync(resolve(root, 'src'), { recursive: true });
    writeFileSync(
      resolve(root, 'src', 'MyScreen.tsx'),
      'export default function MyScreen() {\n  return <div>Title</div>;\n}\n',
    );
    appDir = resolve(root, '.validity', 'native-app');
    mkdirSync(appDir, { recursive: true });
    markerPath = resolve(appDir, '.validity-metro-content');
    writeFileSync(markerPath, 'hash-1');
  });
  afterEach(() => {
    resetMetroAutoRestartCount();
    rmSync(root, { recursive: true, force: true });
  });

  function healSpec(id = 'spec-heal'): Spec {
    return {
      id,
      version: 1,
      status: 'frozen',
      source: { prompt: 'Build the native screen', createdBy: 'user' },
      runtime: 'native',
      targets: { components: ['MyScreen'] },
      criteria: [
        {
          id: 'AC-1',
          text: 'shows the title',
          tier: 'hard',
          checks: [{ click: { role: 'button' } }],
        },
      ],
      hash: 'sha256-heal',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  const decayed: EnvironmentDiagnosis = {
    cause: 'metro-decayed',
    symptom: 'the navigate was acked and the React Native root never attached',
    detail: 'isolated signature of a decayed companion Metro',
    fixCommand: 'rm -f .validity/native-app/.validity-metro-content',
    confidence: 'suspected',
  };

  interface HealTrace {
    captures: { forceReload: boolean; waitForBundle: boolean }[];
    metroCalls: number;
    markerPresentAtMetroCall: boolean[];
  }

  /**
   * A fixture whose capture returns `statuses[n]` for the n-th attempt (with a
   * `metro-decayed` diagnosis on every non-confirmed one), so a test says
   * "decayed, then recovered" as a list and the engine's retry is what walks it.
   */
  function healDeps(
    trace: HealTrace,
    statuses: ('confirmed' | 'unconfirmed')[],
    over: { diagnosis?: EnvironmentDiagnosis; metroUp?: boolean; metroStarted?: boolean } = {},
  ): NativeVerifyDeps {
    const app = {
      appDir,
      scheme: 'validity',
      bundleId: 'ai.validity.companion',
      contentHash: 'hash-1',
      metroContentMarkerPath: markerPath,
      prepared: { dataPayload: { mockNetwork: undefined }, contentHash: 'hash-1' },
    };
    let attempt = 0;
    return {
      prepareApp: (() => app) as unknown as typeof prepareNativeApp,
      ensureMetro: (async () => {
        trace.metroCalls += 1;
        trace.markerPresentAtMetroCall.push(existsSync(markerPath));
        // Mirror the real ensureCompanionMetro: an absent marker means "content
        // changed", which is its verified kill + `--clear` respawn branch.
        const restarted = !existsSync(markerPath);
        writeFileSync(markerPath, 'hash-1');
        return {
          up: over.metroUp ?? true,
          started: over.metroStarted ?? restarted,
          restartedForContent: restarted,
        };
      }) as unknown as typeof ensureCompanionMetro,
      startBridge: (() => ({
        setNativeData: () => {},
        close: () => {},
      })) as unknown as typeof startNativeBridge,
      makeDriver: () => ({}) as NativeDriver,
      capture: (async (opts: {
        screenshotPath: string;
        forceReload?: boolean;
        waitForBundle?: unknown;
      }) => {
        const status = statuses[attempt] ?? statuses[statuses.length - 1] ?? 'unconfirmed';
        attempt += 1;
        trace.captures.push({
          forceReload: opts.forceReload === true,
          waitForBundle: typeof opts.waitForBundle === 'function',
        });
        // captureNative writes the metrics row itself; the fake must too, since
        // the heal's bounding reads render history out of that log.
        appendCaptureMetric(root, {
          ts: new Date().toISOString(),
          platform: 'android',
          openMs: 100,
          renderStatus: status,
          openCallCount: attempt,
        });
        return {
          url: 'validity://render',
          screenshotPath: opts.screenshotPath,
          a11ySnapshot: 'a11y-tree @e1 [text]',
          render: { status, via: 'bridge-ack' },
          timing: {},
          criterionVerdicts:
            status === 'confirmed'
              ? [{ id: 'AC-1', tier: 'hard' as const, status: 'pass' as const }]
              : undefined,
          ...(status === 'confirmed' ? {} : { diagnosis: over.diagnosis ?? decayed }),
        };
      }) as unknown as typeof captureNative,
      diagnose: (async () => undefined) as unknown as typeof diagnoseNativeEnvironment,
    };
  }

  const booted = { deviceId: 'emulator-5554', port: 5554, platform: 'android' as const };
  const noPreventive = {
    native: { metroRecycleAfterCaptures: false },
  } as unknown as ValidityConfig;

  it('restarts Metro and retries the spec ONCE when the capture diagnoses metro-decayed — and the retry lands real verdicts', async () => {
    const trace: HealTrace = { captures: [], metroCalls: 0, markerPresentAtMetroCall: [] };
    const result = await verifyOneSpecNative(
      root,
      noPreventive,
      healSpec(),
      booted,
      healDeps(trace, ['unconfirmed', 'confirmed']),
    );

    // Two captures, two ensureMetro calls, and the SECOND one saw the content
    // marker gone — i.e. the sanctioned managed restart, not a new kill path.
    expect(trace.captures).toHaveLength(2);
    expect(trace.metroCalls).toBe(2);
    expect(trace.markerPresentAtMetroCall).toEqual([true, false]);
    // The retry waits for the restarted bundler to serve, and does NOT force a
    // reload — the heal regenerated identical content, so tearing the app down
    // only spends the attempt's budget (measured on device: 45.6s unconfirmed
    // with the reload, 11.5s confirmed without it).
    expect(trace.captures[1]).toEqual({ forceReload: false, waitForBundle: true });
    // The healed run is a real verified run, not an error.
    expect(result.error).toBeUndefined();
    expect(result.meta).not.toBeNull();
    expect(result.mechanical.find((v) => v.id === 'AC-1')?.status).toBe('pass');
  });

  it('records the heal in session-metrics as an event row — and that row is NOT counted as a capture', async () => {
    const trace: HealTrace = { captures: [], metroCalls: 0, markerPresentAtMetroCall: [] };
    await verifyOneSpecNative(
      root,
      noPreventive,
      healSpec(),
      booted,
      healDeps(trace, ['unconfirmed', 'confirmed']),
    );

    const raw = readFileSync(resolve(root, SESSION_METRICS_RELATIVE_PATH), 'utf-8');
    const events = raw
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.event === 'metro-auto-restart');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      trigger: 'decay-diagnosis',
      specId: 'spec-heal',
      metroUp: true,
      outcome: 'recovered',
    });
    // Session health must see the two captures and nothing else — an event row
    // counted as a capture would shift percentiles and break streaks.
    expect(readSessionMetrics(root)).toHaveLength(2);
  });

  it('spends the budget once: a SECOND metro-decayed spec in the same run is reported, not restarted again', async () => {
    const first: HealTrace = { captures: [], metroCalls: 0, markerPresentAtMetroCall: [] };
    await verifyOneSpecNative(
      root,
      noPreventive,
      healSpec('spec-a'),
      booted,
      healDeps(first, ['unconfirmed', 'confirmed']),
    );

    const second: HealTrace = { captures: [], metroCalls: 0, markerPresentAtMetroCall: [] };
    const result = await verifyOneSpecNative(
      root,
      noPreventive,
      healSpec('spec-b'),
      booted,
      healDeps(second, ['unconfirmed']),
    );

    // One capture, one ensureMetro — no second restart.
    expect(second.captures).toHaveLength(1);
    expect(second.metroCalls).toBe(1);
    expect(result.error).toContain('render not confirmed');
    // And it SAYS why it didn't restart, ahead of a fix command that would
    // otherwise send the reader to run the restart that just happened.
    expect(result.diagnosis?.autoRemediation).toMatch(/already auto-restarted/);
    expect(result.error).toContain('already attempted:');
  });

  it('a heal that does NOT recover is reported honestly — the retry result stands and the failure is recorded', async () => {
    const trace: HealTrace = { captures: [], metroCalls: 0, markerPresentAtMetroCall: [] };
    const result = await verifyOneSpecNative(
      root,
      noPreventive,
      healSpec(),
      booted,
      healDeps(trace, ['unconfirmed', 'unconfirmed']),
    );

    expect(trace.captures).toHaveLength(2);
    expect(result.error).toContain('render not confirmed');
    expect(result.meta).toBeNull();
    const raw = readFileSync(resolve(root, SESSION_METRICS_RELATIVE_PATH), 'utf-8');
    expect(raw).toContain('"outcome":"failed"');
    // The journal keeps the pessimistic record, which is what blocks the next
    // run from restarting a bundler that is demonstrably not the problem.
    expect(readMetroHealRecord(appDir)?.outcome).toBe('failed');
  });

  it('never restarts for a diagnosis that is not metro-decayed', async () => {
    const trace: HealTrace = { captures: [], metroCalls: 0, markerPresentAtMetroCall: [] };
    const result = await verifyOneSpecNative(root, noPreventive, healSpec(), booted, {
      ...healDeps(trace, ['unconfirmed'], {
        diagnosis: {
          cause: 'render-failure',
          symptom: 'the component threw',
          detail: 'the most likely remaining cause is the component itself',
          confidence: 'suspected',
        },
      }),
    });

    expect(trace.captures).toHaveLength(1);
    expect(trace.metroCalls).toBe(1);
    expect(result.diagnosis?.autoRemediation).toBeUndefined();
  });

  it('preventively recycles a bundler that has served past the threshold, before it can decay', async () => {
    // A bundler epoch, and enough captures on it to cross a low threshold.
    writeMetroHealRecord(appDir, {
      ts: '2026-07-29T11:00:00.000Z',
      trigger: 'preventive',
      outcome: 'recovered',
      bundlerEpochStartedAt: '2026-07-29T11:00:00.000Z',
    });
    for (let i = 0; i < 3; i += 1) {
      appendCaptureMetric(root, {
        ts: '2026-07-29T11:30:00.000Z',
        platform: 'android',
        openMs: 100,
        renderStatus: 'confirmed',
        openCallCount: i + 1,
      });
    }

    const trace: HealTrace = { captures: [], metroCalls: 0, markerPresentAtMetroCall: [] };
    const result = await verifyOneSpecNative(
      root,
      { native: { metroRecycleAfterCaptures: 3 } } as unknown as ValidityConfig,
      healSpec(),
      booted,
      healDeps(trace, ['confirmed']),
    );

    // The marker was already gone when ensureMetro ran — the recycle happened
    // BEFORE the capture, so the spec renders against a fresh bundler.
    expect(trace.markerPresentAtMetroCall).toEqual([false]);
    // The capture waits for the fresh bundle but is NOT force-reloaded: the
    // recycle was for AGE, and the content it regenerated is identical.
    expect(trace.captures[0]).toEqual({ forceReload: false, waitForBundle: true });
    expect(result.error).toBeUndefined();
    const raw = readFileSync(resolve(root, SESSION_METRICS_RELATIVE_PATH), 'utf-8');
    expect(raw).toContain('"trigger":"preventive"');
  });

  it('leaves a bundler below the threshold alone (no restart tax on a healthy run)', async () => {
    writeMetroHealRecord(appDir, {
      ts: '2026-07-29T11:00:00.000Z',
      trigger: 'preventive',
      outcome: 'recovered',
      bundlerEpochStartedAt: '2026-07-29T11:00:00.000Z',
    });
    const trace: HealTrace = { captures: [], metroCalls: 0, markerPresentAtMetroCall: [] };
    await verifyOneSpecNative(
      root,
      { native: { metroRecycleAfterCaptures: 30 } } as unknown as ValidityConfig,
      healSpec(),
      booted,
      healDeps(trace, ['confirmed']),
    );

    expect(trace.markerPresentAtMetroCall).toEqual([true]);
    expect(trace.captures[0]).toEqual({ forceReload: false, waitForBundle: false });
  });

  it('waits for the bundle on a FRESH SPAWN even when content is unchanged', async () => {
    // The first-run-after-install bounce: the wizard/browse persisted the
    // content marker, Metro is down, verify spawns it — cache cold, content
    // "unchanged". The old gate (restartedForContent only) let this capture
    // spend a fixed 4s sleep against a 30-90s first build and land
    // UNVERIFIABLE on run 1, green on run 2. A spawn this call performed must
    // wait observably; no forceReload, because the content is not stale.
    const trace: HealTrace = { captures: [], metroCalls: 0, markerPresentAtMetroCall: [] };
    await verifyOneSpecNative(
      root,
      noPreventive,
      healSpec(),
      booted,
      healDeps(trace, ['confirmed'], { metroStarted: true }),
    );
    expect(trace.markerPresentAtMetroCall).toEqual([true]);
    expect(trace.captures[0]).toEqual({ forceReload: false, waitForBundle: true });
  });

  it('a GENUINE content change still forces a reload — only an age restart skips it', async () => {
    // No preventive recycle, no heal: the marker is simply already gone, which
    // is what a regenerated contentHash looks like to ensureCompanionMetro. The
    // running app then holds a truly stale bundle and a warm re-target would ack
    // old code as success, so this restart MUST force the reload.
    rmSync(markerPath, { force: true });
    const trace: HealTrace = { captures: [], metroCalls: 0, markerPresentAtMetroCall: [] };
    await verifyOneSpecNative(
      root,
      noPreventive,
      healSpec(),
      booted,
      healDeps(trace, ['confirmed']),
    );
    expect(trace.captures[0]).toEqual({ forceReload: true, waitForBundle: true });
  });

  it('seeds the bundler epoch on first sighting, so an externally started Metro still gets a clock', async () => {
    const trace: HealTrace = { captures: [], metroCalls: 0, markerPresentAtMetroCall: [] };
    await verifyOneSpecNative(
      root,
      noPreventive,
      healSpec(),
      booted,
      healDeps(trace, ['confirmed']),
    );
    expect(readMetroHealRecord(appDir)?.bundlerEpochStartedAt).toBeTruthy();
  });
});

/**
 * `native.deviceEvidence` — the production caller for the capture layer's
 * `captureDeviceEvidence` seam, which until now had none.
 *
 * The invariant these tests exist to hold is NEGATIVE: the flag adds an
 * artifact and NOTHING else. Not a verdict, not a criterion, not a gate, not a
 * score. So every assertion about the file is paired with one showing the run's
 * result is byte-identical to the same run without it — including when the
 * evidence itself came back `unavailable`, which is the shape most likely to be
 * mistaken for a finding later.
 */
describe('verifyOneSpecNative — native.deviceEvidence (advisory capture only)', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-native-evidence-')));
    mkdirSync(resolve(root, 'src'), { recursive: true });
    writeFileSync(
      resolve(root, 'src', 'MyScreen.tsx'),
      'export default function MyScreen() {\n  return <div>Title</div>;\n}\n',
    );
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 'test@validity.local'],
      ['config', 'user.name', 'Test'],
      ['config', 'commit.gpgsign', 'false'],
      ['add', '.'],
      ['commit', '-q', '-m', 'base'],
    ]) {
      execFileSync('git', args, { cwd: root });
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const booted = { deviceId: 'emulator-5554', port: 5554 };

  function evidenceSpec(): Spec {
    return {
      id: 'spec-evidence',
      version: 1,
      status: 'frozen',
      source: { prompt: 'the screen shows a title', createdBy: 'user' },
      runtime: 'native',
      targets: { components: ['src/MyScreen.tsx'] },
      criteria: [
        {
          id: 'AC-1',
          text: 'shows the title',
          tier: 'hard',
          checks: [{ expect: { element: { name: 'Title', state: 'visible' } } }],
        },
      ],
      hash: 'sha256-evidence',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
  }

  function record(over: Partial<DeviceEvidence> = {}): DeviceEvidence {
    return {
      schema: 1,
      kind: 'perf-metrics',
      source: 'agent-device',
      command: 'agent-device perf metrics --json',
      capturedAt: '2026-01-01T00:00:00.000Z',
      phase: 'post-interaction',
      platform: 'android',
      scoring: 'advisory-evidence-only',
      status: 'captured',
      data: { fps: 59.4 },
      ...over,
    };
  }

  const BUNDLE: NativeDeviceEvidence = {
    perf: {
      metrics: record(),
      frames: record({ kind: 'perf-frames', command: 'agent-device perf frames --json' }),
    },
    network: record({
      kind: 'network-dump',
      command: 'agent-device network dump --json',
      data: { requests: [] },
    }),
  };

  /** Deps whose capture records the flag it was handed and returns `evidence`. */
  function evidenceDeps(
    seen: { captureDeviceEvidence?: boolean }[],
    evidence?: NativeDeviceEvidence,
  ): NativeVerifyDeps {
    const app = {
      appDir: resolve(root, 'node_modules', '.validity-native'),
      scheme: 'validity',
      bundleId: 'ai.validity.companion',
      contentHash: 'hash-1',
      metroContentMarkerPath: resolve(root, 'node_modules', '.validity-native', 'marker'),
      prepared: { dataPayload: { mockNetwork: undefined }, contentHash: 'hash-1' },
    };
    return {
      prepareApp: (() => app) as unknown as typeof prepareNativeApp,
      ensureMetro: (async () => ({ up: true })) as unknown as typeof ensureCompanionMetro,
      startBridge: (() => ({
        setNativeData: () => {},
        close: () => {},
      })) as unknown as typeof startNativeBridge,
      makeDriver: () => ({}) as NativeDriver,
      capture: (async (opts: { screenshotPath: string; captureDeviceEvidence?: boolean }) => {
        seen.push({ captureDeviceEvidence: opts.captureDeviceEvidence });
        return {
          url: 'validity://render',
          screenshotPath: opts.screenshotPath,
          a11ySnapshot: 'a11y-tree',
          render: { status: 'confirmed', via: 'bridge-ack' },
          timing: {},
          criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass', detail: 'text found' }],
          ...(evidence ? { deviceEvidence: evidence } : {}),
        };
      }) as unknown as typeof captureNative,
    };
  }

  function evidencePath(runId: string): string {
    return resolve(runDir(root, runId), 'device-evidence.json');
  }

  const config = (deviceEvidence?: boolean): ValidityConfig =>
    ({ native: deviceEvidence === undefined ? {} : { deviceEvidence } }) as ValidityConfig;

  it('is OFF by default: the capture is never asked for evidence, and no file appears', async () => {
    const seen: { captureDeviceEvidence?: boolean }[] = [];
    const result = await verifyOneSpecNative(
      root,
      config(),
      evidenceSpec(),
      booted,
      evidenceDeps(seen),
    );
    // Not merely false — ABSENT, so the capture's own default decides.
    expect(seen).toEqual([{ captureDeviceEvidence: undefined }]);
    expect(existsSync(evidencePath(result.meta!.runId))).toBe(false);
  });

  it('the WRITE follows the returned field, not the flag — evidence handed back is never dropped', async () => {
    // The flag asks; the field answers. Persisting only when the flag was set
    // would silently discard evidence a capture chose to return, and a run dir
    // that is missing evidence the run actually collected is a small lie.
    const result = await verifyOneSpecNative(
      root,
      config(),
      evidenceSpec(),
      booted,
      evidenceDeps([], BUNDLE),
    );
    expect(existsSync(evidencePath(result.meta!.runId))).toBe(true);
  });

  it('an explicit false stays off (only `true` opts in)', async () => {
    const seen: { captureDeviceEvidence?: boolean }[] = [];
    await verifyOneSpecNative(root, config(false), evidenceSpec(), booted, evidenceDeps(seen));
    expect(seen).toEqual([{ captureDeviceEvidence: undefined }]);
  });

  it('true asks the capture for evidence and flattens the bundle into <run-dir>/device-evidence.json', async () => {
    const seen: { captureDeviceEvidence?: boolean }[] = [];
    const result = await verifyOneSpecNative(
      root,
      config(true),
      evidenceSpec(),
      booted,
      evidenceDeps(seen, BUNDLE),
    );
    expect(seen).toEqual([{ captureDeviceEvidence: true }]);

    const path = evidencePath(result.meta!.runId);
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, 'utf-8')) as {
      schema: number;
      records: DeviceEvidence[];
    };
    expect(written.schema).toBe(1);
    // Fixed order: metrics, frames, network — two runs of one shape compare.
    expect(written.records.map((r) => r.kind)).toEqual([
      'perf-metrics',
      'perf-frames',
      'network-dump',
    ]);
    // The advisory posture travels IN the artifact, so a reader who finds this
    // file out of context cannot mistake it for a scored criterion.
    expect(written.records.every((r) => r.scoring === 'advisory-evidence-only')).toBe(true);
  });

  it('changes NO verdict: the run result is identical with the evidence and without it', async () => {
    const withEvidence = await verifyOneSpecNative(
      root,
      config(true),
      evidenceSpec(),
      booted,
      evidenceDeps([], BUNDLE),
    );
    const without = await verifyOneSpecNative(
      root,
      config(),
      evidenceSpec(),
      booted,
      evidenceDeps([]),
    );
    expect(withEvidence.error).toBeUndefined();
    expect(withEvidence.mechanical).toEqual(without.mechanical);
    expect(withEvidence.meta?.criterionVerdicts).toEqual(without.meta?.criterionVerdicts);
    expect(withEvidence.meta?.signedOff).toBe(without.meta?.signedOff);
    // Nothing about the evidence leaks into the attested run-meta.
    expect(JSON.stringify(withEvidence.meta)).not.toContain('advisory-evidence-only');
  });

  it('an UNAVAILABLE record is written down, and is still not a finding', async () => {
    // "Could not tell" must survive to disk — but it must never read as a red.
    const unavailable: NativeDeviceEvidence = {
      perf: {
        metrics: record({
          status: 'unavailable',
          data: undefined,
          unavailableReason: 'no session',
          errorCode: 'SESSION_NOT_FOUND',
        }),
        frames: record({ kind: 'perf-frames', status: 'unavailable', data: undefined }),
      },
    };
    const result = await verifyOneSpecNative(
      root,
      config(true),
      evidenceSpec(),
      booted,
      evidenceDeps([], unavailable),
    );
    const written = JSON.parse(readFileSync(evidencePath(result.meta!.runId), 'utf-8')) as {
      records: DeviceEvidence[];
    };
    expect(written.records).toHaveLength(2);
    expect(written.records[0]!.unavailableReason).toBe('no session');
    expect(result.error).toBeUndefined();
    expect(result.mechanical).toEqual([
      { id: 'AC-1', tier: 'hard', status: 'pass', detail: 'text found' },
    ]);
  });

  it('writes NO file when the bundle carries only a reason (a records:[] artifact would say less)', async () => {
    const result = await verifyOneSpecNative(
      root,
      config(true),
      evidenceSpec(),
      booted,
      evidenceDeps([], { unavailableReason: 'driver does not expose runInSession' }),
    );
    expect(existsSync(evidencePath(result.meta!.runId))).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('deviceEvidenceRecords is total: absent bundle, absent family, reason-only', () => {
    expect(deviceEvidenceRecords(undefined)).toEqual([]);
    expect(deviceEvidenceRecords({ unavailableReason: 'nothing to attach to' })).toEqual([]);
    expect(deviceEvidenceRecords({ network: BUNDLE.network! }).map((r) => r.kind)).toEqual([
      'network-dump',
    ]);
    expect(deviceEvidenceRecords({ perf: BUNDLE.perf! }).map((r) => r.kind)).toEqual([
      'perf-metrics',
      'perf-frames',
    ]);
  });
});
