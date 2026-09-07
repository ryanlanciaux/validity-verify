/**
 * The MCP multi-target render loop, driven end-to-end with fakes.
 *
 * `handleVerifyNative` re-targets ONE warm session N times (component ×
 * fixture/scenario × color-scheme) on a single serial device. The diagnosis
 * engine's mid-loop catch was
 * unit-tested at the probe level and at the wire-shape level, but never at the
 * LOOP level — which is the only level where the two properties that actually
 * matter are observable:
 *
 *   1. a target that blows up gets a NAMED CAUSE attached to its own render,
 *      instead of a bare `RENDER_FAILED:` that reproduces the exact "five
 *      indistinguishable causes" problem the engine exists to kill; and
 *   2. the remaining targets STILL RUN and still report. This is the shape of
 *      the old verify-all bug where a premature native gate `exit(1)`-ed and
 *      masked every web spec behind it — that shape must stay dead.
 *
 * Everything here runs against injected fakes ({@link NativeRenderLoopDeps}):
 * no simulator, no emulator, no daemon, no network. The `diagnose` seam is the
 * same one `captureNative` already exposes for its own tests.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CriterionVerdict } from '@validity.ai/verify-spec';
import {
  BridgePortHeldError,
  type CaptureNativeOptions,
  type EnvironmentDiagnosis,
  type NativeCaptureResult,
} from '@validity.ai/verify-native';
import {
  buildVerifyStructuredContent,
  environmentBlockedFromDiagnosis,
  environmentDegradedFromDiagnosis,
  renderNativeTargets,
  selectNativeVerifyTargets,
  type NativeRenderLoopInput,
  type NativeRenderLoopResult,
  type NativeSession,
} from './server.js';

// ---------------------------------------------------------------------------
// Fakes. The loop only ever touches `app` for the data payload / bundle id and
// passes `driver`/`bridge` straight through to `capture` — which is itself
// faked here — so an opaque stand-in is honest, not a shortcut.
// ---------------------------------------------------------------------------

const fakeSession = () =>
  ({
    app: {
      bundleId: 'com.example.playground',
      contentHash: 'content-hash-1',
      prepared: {
        contentHash: 'content-hash-1',
        dataPayload: { scenarios: { 'logged-in': { user: 'ada' } }, mockNetwork: 'active' },
      },
    } as unknown as NativeSession['app'],
    driver: { kind: 'fake-driver' } as unknown as NativeSession['driver'],
    bridge: { kind: 'fake-bridge' } as unknown as NativeSession['bridge'],
    platform: 'ios' as const,
    pinnedDevice: 'SIM-1',
    metroLogPath: '/dev/null',
  }) satisfies Partial<NativeRenderLoopInput>;

const confirmedCapture = (opts: CaptureNativeOptions): NativeCaptureResult => ({
  target: opts.spec,
  url: `validity://render?component=${opts.spec.component}`,
  screenshotPath: opts.screenshotPath,
  a11ySnapshot: `<tree component="${opts.spec.component}">`,
  render: { status: 'confirmed', via: 'bridge-ack', token: 'nav-ok' },
  timing: { openMs: 11 },
});

const PHANTOM_CLAIM: EnvironmentDiagnosis = {
  cause: 'phantom-device-claim',
  symptom: 'agent-device holds a claim on SIM-1 but reports no live sessions.',
  detail: 'The claim file outlived its owner process, so every open is refused.',
  fixCommand: 'kill $(cat daemon.pid)\nrm -rf "$HOME/.agent-device/sessions"',
  confidence: 'confirmed',
};

const SESSION_DECAY: EnvironmentDiagnosis = {
  cause: 'session-decay',
  symptom: 'Snapshots are slow in this run: p95 2934ms over 209 captures.',
  detail: 'The session has degraded with age; the companion acks but never attaches.',
  fixCommand: 'adb emu kill',
  confidence: 'suspected',
};

describe('renderNativeTargets — the multi-target loop', () => {
  let projectRoot: string;
  let screenshotsDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-native-loop-'));
    screenshotsDir = projectRoot;
    for (const rel of ['A.tsx', 'B.tsx', 'C.tsx']) {
      writeFileSync(resolve(projectRoot, rel), `export const ${rel[0]} = () => null;\n`);
    }
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const threeTargets = () =>
    selectNativeVerifyTargets(
      [resolve(projectRoot, 'A.tsx'), resolve(projectRoot, 'B.tsx'), resolve(projectRoot, 'C.tsx')],
      [],
      projectRoot,
    ).targets;

  const run = (
    capture: (opts: CaptureNativeOptions) => NativeCaptureResult | Promise<NativeCaptureResult>,
    diagnose: NonNullable<NativeRenderLoopInput['deps']>['diagnose'],
    over = threeTargets(),
  ) =>
    renderNativeTargets({
      ...fakeSession(),
      targets: over,
      projectRoot,
      screenshotsDir,
      deps: { capture: capture as never, diagnose },
    });

  // -------------------------------------------------------------------------
  // (a) A diagnosis raised mid-loop for ONE target.
  // -------------------------------------------------------------------------

  describe('a capture that THROWS for one target', () => {
    const boom = 'DEVICE_IN_USE: device SIM-1 is claimed by another session';

    const scripted = () => {
      const captured: string[] = [];
      const capture = vi.fn(async (opts: CaptureNativeOptions) => {
        captured.push(opts.spec.component ?? '(none)');
        if (opts.spec.component === 'B.tsx') throw new Error(boom);
        return confirmedCapture(opts);
      });
      const diagnose = vi.fn(async () => PHANTOM_CLAIM);
      return { captured, capture, diagnose };
    };

    it('does NOT abort the remaining targets — every target is still captured, in order', async () => {
      const { captured, capture, diagnose } = scripted();
      const out = await run(capture, diagnose);

      expect(captured).toEqual(['A.tsx', 'B.tsx', 'C.tsx']);
      expect(out.renders.map((r) => r.filePath)).toEqual(['A.tsx', 'B.tsx', 'C.tsx']);
      expect(out.portHeld).toBeNull();
    });

    it('attaches the structured cause to THAT target’s render, not to the healthy ones', async () => {
      const { capture, diagnose } = scripted();
      const out = await run(capture, diagnose);

      const failed = out.renders.find((r) => r.filePath === 'B.tsx')!;
      expect(failed.renderConfirmation).toBe('unconfirmed');
      expect(failed.renderError).toContain(`RENDER_FAILED: ${boom}`);
      // cause / confidence / symptom / detail / fix — the whole recipe, on the
      // render that failed, so a partially-degraded run is still actionable.
      expect(failed.renderError).toContain('LIKELY CAUSE (confirmed, phantom-device-claim)');
      expect(failed.renderError).toContain(PHANTOM_CLAIM.symptom);
      expect(failed.renderError).toContain(PHANTOM_CLAIM.detail);
      expect(failed.renderError).toContain(PHANTOM_CLAIM.fixCommand!);

      for (const ok of out.renders.filter((r) => r.filePath !== 'B.tsx')) {
        expect(ok.renderError).toBeUndefined();
        expect(ok.renderConfirmation).toBe('confirmed');
      }
    });

    it('feeds the thrown text back in as openErrorText so the agent-device signatures are recognizable', async () => {
      const { capture, diagnose } = scripted();
      await run(capture, diagnose);

      expect(diagnose).toHaveBeenCalledTimes(1);
      expect(diagnose).toHaveBeenCalledWith(
        expect.objectContaining({
          projectRoot,
          platform: 'ios',
          openErrorText: boom,
          renderStatus: 'failed',
        }),
      );
    });

    it('keeps anyConfirmed TRUE and publishes the cause as firstDiagnosis', async () => {
      const { capture, diagnose } = scripted();
      const out = await run(capture, diagnose);

      // The healthy targets are real evidence — one bad target does not void them.
      expect(out.anyConfirmed).toBe(true);
      expect(out.firstDiagnosis).toEqual(PHANTOM_CLAIM);
    });

    it('never exits the process (the premature native-gate exit(1) must stay dead)', async () => {
      const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code}) called`);
      }) as never);
      const { capture, diagnose } = scripted();

      const out = await run(capture, diagnose);

      expect(exit).not.toHaveBeenCalled();
      expect(out.renders).toHaveLength(3);
    });

    it('is FIRST-wins across targets: one thing to fix, not a per-target chorus', async () => {
      const capture = vi.fn(async (opts: CaptureNativeOptions) => {
        if (opts.spec.component === 'A.tsx') throw new Error('first failure');
        if (opts.spec.component === 'C.tsx') throw new Error('later failure');
        return confirmedCapture(opts);
      });
      const diagnose = vi
        .fn<() => Promise<EnvironmentDiagnosis>>()
        .mockResolvedValueOnce(PHANTOM_CLAIM)
        .mockResolvedValueOnce(SESSION_DECAY);

      const out = await run(capture, diagnose);

      expect(diagnose).toHaveBeenCalledTimes(2);
      expect(out.firstDiagnosis).toEqual(PHANTOM_CLAIM);
      // Both failures still carry THEIR own cause on their own render.
      expect(out.renders[0]!.renderError).toContain('phantom-device-claim');
      expect(out.renders[2]!.renderError).toContain('session-decay');
    });

    it('survives a diagnose that itself throws — the render is still recorded and the loop still continues', async () => {
      const { capture } = scripted();
      const diagnose = vi.fn(async () => {
        throw new Error('probe blew up');
      });

      const out = await run(capture, diagnose as never);

      expect(out.renders).toHaveLength(3);
      const failed = out.renders[1]!;
      expect(failed.renderError).toBe(`RENDER_FAILED: ${boom}`);
      expect(failed.renderError).not.toContain('LIKELY CAUSE');
      expect(out.firstDiagnosis).toBeUndefined();
      expect(out.anyConfirmed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // (a′) The non-throwing variant: the device answers, but not with a
  // confirmed render. captureNative attaches the diagnosis itself.
  // -------------------------------------------------------------------------

  describe('a capture that RETURNS an unconfirmed render', () => {
    it('carries the cause into the status block and keeps going', async () => {
      const capture = vi.fn(async (opts: CaptureNativeOptions) => {
        if (opts.spec.component !== 'B.tsx') return confirmedCapture(opts);
        return {
          ...confirmedCapture(opts),
          render: {
            status: 'unconfirmed' as const,
            via: 'settle' as const,
            token: 'nav-b',
            error: 'render marker "validity-root:nav-b" did not appear within 3500ms',
          },
          diagnosis: SESSION_DECAY,
        };
      });
      const diagnose = vi.fn(async () => PHANTOM_CLAIM);

      const out = await run(capture, diagnose);

      expect(capture).toHaveBeenCalledTimes(3);
      // The THROW path's diagnose is not reached — captureNative already
      // resolved this capture's cause.
      expect(diagnose).not.toHaveBeenCalled();
      const failed = out.renders[1]!;
      expect(failed.renderConfirmation).toBe('unconfirmed');
      expect(failed.renderError).toMatch(/^RENDER_UNCONFIRMED:/);
      expect(failed.renderError).toContain('session-decay');
      expect(out.firstDiagnosis).toEqual(SESSION_DECAY);
      expect(out.anyConfirmed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // (b) The happy path stays byte-identical to the pre-diagnosis behaviour.
  // -------------------------------------------------------------------------

  describe('the no-diagnosis happy path', () => {
    it('confirms every target, never probes, and leaves firstDiagnosis undefined', async () => {
      const capture = vi.fn(confirmedCapture);
      const diagnose = vi.fn(async () => PHANTOM_CLAIM);

      const out = await run(capture, diagnose);

      expect(diagnose).not.toHaveBeenCalled();
      expect(out.firstDiagnosis).toBeUndefined();
      expect(out.portHeld).toBeNull();
      expect(out.anyConfirmed).toBe(true);
      expect(out.renders).toHaveLength(3);
      for (const r of out.renders) {
        expect(r.renderError).toBeUndefined();
        expect(r.renderConfirmation).toBe('confirmed');
        expect(r.a11ySnapshot).toContain(r.filePath);
      }
    });

    it('reads each component source exactly once and carries scenario/fixture identity through', async () => {
      const targets = selectNativeVerifyTargets(
        [resolve(projectRoot, 'A.tsx')],
        ['logged-in'],
        projectRoot,
      ).targets;
      const capture = vi.fn(confirmedCapture);

      const out = await run(
        capture,
        vi.fn(async () => PHANTOM_CLAIM),
        targets,
      );

      expect(out.renders[0]!.scenarioId).toBe('logged-in');
      expect(Object.keys(out.sources)).toEqual([out.renders[0]!.id]);
      expect(out.sources[out.renders[0]!.id]).toContain('export const A');
      // Scenario seed travels inline over the bridge navigate (data, not a rebuild).
      expect(capture.mock.calls[0]![0].spec).toMatchObject({
        component: 'A.tsx',
        scenario: 'logged-in',
        scenarioSeed: { user: 'ada' },
      });
    });

    it('gives distinct screenshot paths to every target (no silent overwrite)', async () => {
      const capture = vi.fn(confirmedCapture);
      const out = await run(
        capture,
        vi.fn(async () => PHANTOM_CLAIM),
      );

      const paths = out.renders.map((r) => r.screenshotPath);
      expect(new Set(paths).size).toBe(paths.length);
    });
  });

  // -------------------------------------------------------------------------
  // (c) Hard errors mid-loop.
  // -------------------------------------------------------------------------

  describe('hard errors mid-loop', () => {
    it('a driver error on the FIRST target still runs the rest', async () => {
      const capture = vi.fn(async (opts: CaptureNativeOptions) => {
        if (opts.spec.component === 'A.tsx') throw new Error('spawn agent-device ENOENT');
        return confirmedCapture(opts);
      });

      const out = await run(
        capture,
        vi.fn(async () => PHANTOM_CLAIM),
      );

      expect(capture).toHaveBeenCalledTimes(3);
      expect(out.renders[0]!.renderError).toContain('spawn agent-device ENOENT');
      expect(out.renders[1]!.renderConfirmation).toBe('confirmed');
      expect(out.renders[2]!.renderConfirmation).toBe('confirmed');
    });

    it('EVERY target failing yields three diagnosed renders, anyConfirmed false, and no throw out of the loop', async () => {
      const capture = vi.fn(async () => {
        throw new Error('DEVICE_IN_USE: device SIM-1 is claimed by another session');
      });
      const diagnose = vi.fn(async () => PHANTOM_CLAIM);

      const out = await run(capture, diagnose);

      expect(out.renders).toHaveLength(3);
      expect(out.renders.every((r) => r.renderError?.includes('phantom-device-claim'))).toBe(true);
      expect(out.anyConfirmed).toBe(false);
      expect(out.firstDiagnosis).toEqual(PHANTOM_CLAIM);
    });

    it('a non-Error throw does not crash the loop', async () => {
      const capture = vi.fn(async (opts: CaptureNativeOptions) => {
        if (opts.spec.component === 'B.tsx') throw 'a bare string';
        return confirmedCapture(opts);
      });

      const out = await run(
        capture as never,
        vi.fn(async () => undefined as never),
      );

      expect(out.renders).toHaveLength(3);
      expect(out.renders[1]!.renderConfirmation).toBe('unconfirmed');
    });

    it('BridgePortHeldError is the ONE documented exception: it stops the loop instead of being recorded per target', async () => {
      const capture = vi.fn(async (opts: CaptureNativeOptions) => {
        if (opts.spec.component === 'B.tsx')
          throw new BridgePortHeldError('port 8083 held by another process');
        return confirmedCapture(opts);
      });
      const diagnose = vi.fn(async () => PHANTOM_CLAIM);

      const out = await run(capture, diagnose);

      // A dead bridge is a SESSION fact, not a target fact — re-targeting is
      // pointless, so C is never attempted and B gets no bogus render row.
      expect(capture).toHaveBeenCalledTimes(2);
      expect(out.renders.map((r) => r.filePath)).toEqual(['A.tsx']);
      expect(out.portHeld).toBeInstanceOf(BridgePortHeldError);
      expect(diagnose).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (d) The payload doctor / CI / a headless loop driver actually read.
  // -------------------------------------------------------------------------

  describe('the diagnosis reaches structuredContent', () => {
    const verdicts: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'unverifiable', detail: 'checks did not execute' },
    ];

    /**
     * Mirrors handleVerifyNative's tail EXACTLY — the two branches are the
     * contract under test:
     *   nothing confirmed → `environmentBlocked` (this run produced nothing;
     *                       a driver may stop the sweep over it);
     *   some confirmed,   → `environmentDegraded` (this run produced real
     *   some lost           evidence; stopping the sweep would be wrong).
     * Never both, and never either on a clean run.
     */
    const publish = (loop: NativeRenderLoopResult) => {
      const blocked =
        !loop.anyConfirmed && loop.firstDiagnosis
          ? environmentBlockedFromDiagnosis(loop.firstDiagnosis)
          : undefined;
      const affected = loop.renders.filter((r) => r.renderConfirmation !== 'confirmed');
      const degraded =
        loop.anyConfirmed && loop.firstDiagnosis && affected.length > 0
          ? environmentDegradedFromDiagnosis(loop.firstDiagnosis, affected)
          : undefined;
      return buildVerifyStructuredContent(
        'run_1',
        verdicts,
        undefined,
        projectRoot,
        undefined,
        undefined,
        false,
        undefined,
        blocked,
        degraded,
      );
    };

    it('a fully-blocked run publishes cause + fix on structuredContent.environmentBlocked', async () => {
      const capture = vi.fn(async () => {
        throw new Error('DEVICE_IN_USE: device SIM-1 is claimed by another session');
      });

      const out = await run(
        capture,
        vi.fn(async () => PHANTOM_CLAIM),
      );
      const structured = publish(out);

      expect(structured.environmentBlocked).toEqual({
        cause: 'phantom-device-claim',
        symptom: PHANTOM_CLAIM.symptom,
        detail: PHANTOM_CLAIM.detail,
        fixCommand: PHANTOM_CLAIM.fixCommand,
        confidence: 'confirmed',
      });
      // Naming a cause is INERT: it never moves the verdict in either direction.
      expect(structured.verdict.status).toBe('unverifiable');
      expect(structured.verdict).not.toHaveProperty('environmentBlocked');
      // A run that produced NOTHING is blocked, never merely degraded.
      expect(structured).not.toHaveProperty('environmentDegraded');
    });

    it('a healthy run publishes NEITHER key', async () => {
      const structured = await run(
        vi.fn(confirmedCapture),
        vi.fn(async () => PHANTOM_CLAIM),
      ).then(publish);

      expect(structured).not.toHaveProperty('environmentBlocked');
      expect(structured).not.toHaveProperty('environmentDegraded');
    });

    /**
     * The partial case — early targets confirm, later ones fail — is the
     * documented session-decay shape, and the one a headless driver used to see
     * as an unexplained partial run: the cause was in the failing render's
     * `renderError` PROSE and nowhere in `structuredContent`.
     *
     * It is deliberately NOT `environmentBlocked`: a driver may reasonably read
     * "blocked" as "abort the sweep and fix the machine", and this run produced
     * real, scoreable evidence for most of its targets.
     */
    it('PARTIAL degradation publishes environmentDegraded — with the affected targets — and NOT environmentBlocked', async () => {
      const capture = vi.fn(async (opts: CaptureNativeOptions) => {
        if (opts.spec.component === 'C.tsx') throw new Error('DEVICE_IN_USE: SIM-1 claimed');
        return confirmedCapture(opts);
      });

      const out = await run(
        capture,
        vi.fn(async () => SESSION_DECAY),
      );
      const structured = publish(out);

      expect(structured).not.toHaveProperty('environmentBlocked');
      expect(structured.environmentDegraded).toEqual({
        cause: 'session-decay',
        symptom: SESSION_DECAY.symptom,
        detail: SESSION_DECAY.detail,
        fixCommand: SESSION_DECAY.fixCommand,
        confidence: 'suspected',
        affectedRenders: 1,
        // The screenshot key — the same identity the report, the baselines and
        // the PNG on disk use — so a driver can line the cause up with the
        // evidence it did NOT get.
        affectedTargets: [basename(out.renders[2]!.screenshotPath, '.png')],
      });
      // Still on the render text too: removing the prose is not the deal here.
      expect(out.renders[2]!.renderError).toContain('session-decay');
    });

    it('counts and names EVERY lost target, not just the first-diagnosed one', async () => {
      const capture = vi.fn(async (opts: CaptureNativeOptions) => {
        if (opts.spec.component === 'A.tsx') throw new Error('DEVICE_IN_USE: SIM-1 claimed');
        if (opts.spec.component === 'C.tsx') throw new Error('DEVICE_IN_USE: SIM-1 claimed');
        return confirmedCapture(opts);
      });

      const out = await run(
        capture,
        vi.fn(async () => SESSION_DECAY),
      );
      const degraded = publish(out).environmentDegraded!;

      // ONE cause (first-wins, as the loop resolves it) over TWO lost targets.
      expect(degraded.cause).toBe('session-decay');
      expect(degraded.affectedRenders).toBe(2);
      expect(degraded.affectedTargets).toEqual([
        basename(out.renders[0]!.screenshotPath, '.png'),
        basename(out.renders[2]!.screenshotPath, '.png'),
      ]);
    });

    it('an UNCONFIRMED (not thrown) render degrades the run just the same', async () => {
      const capture = vi.fn(async (opts: CaptureNativeOptions) => {
        if (opts.spec.component !== 'B.tsx') return confirmedCapture(opts);
        return {
          ...confirmedCapture(opts),
          render: { status: 'unconfirmed' as const, via: 'settle' as const, token: 'nav-b' },
          diagnosis: SESSION_DECAY,
        };
      });

      const degraded = await run(
        capture,
        vi.fn(async () => PHANTOM_CLAIM),
      ).then((out) => publish(out).environmentDegraded);

      expect(degraded).toMatchObject({ cause: 'session-decay', affectedRenders: 1 });
    });

    it('is INERT: the verdict block is deep-equal with and without the degraded key', async () => {
      const clean = await run(
        vi.fn(confirmedCapture),
        vi.fn(async () => SESSION_DECAY),
      );
      const partial = await run(
        vi.fn(async (opts: CaptureNativeOptions) => {
          if (opts.spec.component === 'C.tsx') throw new Error('DEVICE_IN_USE: SIM-1 claimed');
          return confirmedCapture(opts);
        }),
        vi.fn(async () => SESSION_DECAY),
      );

      expect(publish(partial).environmentDegraded).toBeDefined();
      // Naming the degradation moves nothing: no false red, no false green.
      expect(publish(partial).verdict).toEqual(publish(clean).verdict);
    });

    it('BridgePortHeldError leaves no confirmed evidence lost-to-cause bookkeeping to invent', async () => {
      // A held port stops the loop before any diagnosis is resolved, so there
      // is no cause to publish — neither key appears, and the (real) tail's
      // bridgePortHeldBlock carries the story instead.
      const out = await run(
        vi.fn(async (opts: CaptureNativeOptions) => {
          if (opts.spec.component === 'B.tsx') throw new BridgePortHeldError('port 8083 held');
          return confirmedCapture(opts);
        }),
        vi.fn(async () => SESSION_DECAY),
      );
      const structured = publish(out);

      expect(out.portHeld).toBeInstanceOf(BridgePortHeldError);
      expect(structured).not.toHaveProperty('environmentDegraded');
      expect(structured).not.toHaveProperty('environmentBlocked');
    });
  });
});
