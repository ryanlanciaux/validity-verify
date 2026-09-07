/**
 * `structuredContent.environmentBlocked` — the agent-loop half of the diagnosis
 * surface (handoff-2026-07-28).
 *
 * The human `content` text already carried a LIKELY CAUSE block, but a headless
 * loop driver reads `structuredContent` and nothing else, so a decayed
 * emulator, a phantom device claim and a genuinely broken component were one
 * indistinguishable silence to the only consumer that could act on them.
 *
 * These tests pin the three properties that make the addition safe to ship:
 *   - PRESENT when a cause was established, ABSENT otherwise (a healthy run's
 *     payload stays byte-identical to the pre-feature one);
 *   - INERT — naming a cause never moves `verdict`/`signedOff` in either
 *     direction (no false green, and no false red either);
 *   - the readiness early-return, which used to return prose and NO structured
 *     payload at all, now answers a poller in machine-readable terms.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CriterionVerdict } from '@validity.ai/verify-spec';
import type { EnvironmentDiagnosis, NativeReadiness } from '@validity.ai/verify-native';
import {
  buildVerifyStructuredContent,
  environmentBlockedFromDiagnosis,
  environmentDegradedFromDiagnosis,
  readinessEnvironmentBlocked,
  readinessStepCause,
} from './server.js';

const DECAY: EnvironmentDiagnosis = {
  cause: 'session-decay',
  symptom: 'Android snapshots are slow in this run: p95 2934ms over 209 captures.',
  detail: 'The session has degraded with age; the companion acks the navigate but never attaches.',
  fixCommand: 'kill $(cat daemon.pid)\nadb emu kill\nemulator -avd Medium_Phone_API_35',
  confidence: 'suspected',
};

describe('environmentBlockedFromDiagnosis', () => {
  it('projects the five wire fields and nothing else', () => {
    expect(environmentBlockedFromDiagnosis(DECAY)).toEqual({
      cause: 'session-decay',
      symptom: DECAY.symptom,
      detail: DECAY.detail,
      fixCommand: DECAY.fixCommand,
      confidence: 'suspected',
    });
  });

  it('omits fixCommand — never emits it as an empty string — when there is no one-command fix', () => {
    const out = environmentBlockedFromDiagnosis({
      cause: 'unknown',
      symptom: 'No probe matched.',
      detail: 'Verdicts are withheld rather than guessed.',
      confidence: 'suspected',
    });
    expect(out).not.toHaveProperty('fixCommand');
    expect(out.cause).toBe('unknown');
  });

  it('carries an unrecognized future cause through verbatim (cause is a string, not a closed union)', () => {
    const out = environmentBlockedFromDiagnosis({
      ...DECAY,
      cause: 'some-future-probe' as EnvironmentDiagnosis['cause'],
    });
    expect(out.cause).toBe('some-future-probe');
  });
});

describe('environmentDegradedFromDiagnosis', () => {
  const renders = [
    { screenshotPath: '/runs/run_1/screenshots/src-button__base.png' },
    { screenshotPath: '/runs/run_1/screenshots/src-button__dark.png' },
  ];

  it('is environmentBlocked’s payload PLUS which renders were lost', () => {
    expect(environmentDegradedFromDiagnosis(DECAY, renders)).toEqual({
      ...environmentBlockedFromDiagnosis(DECAY),
      affectedRenders: 2,
      affectedTargets: ['src-button__base', 'src-button__dark'],
    });
  });

  it('keeps the same fixCommand discipline — omitted, never an empty string', () => {
    const out = environmentDegradedFromDiagnosis(
      {
        cause: 'unknown',
        symptom: 'No probe matched.',
        detail: 'Withheld.',
        confidence: 'suspected',
      },
      renders.slice(0, 1),
    );
    expect(out).not.toHaveProperty('fixCommand');
    expect(out.affectedRenders).toBe(1);
  });
});

describe('buildVerifyStructuredContent — environmentBlocked', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-env-blocked-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const verdicts: CriterionVerdict[] = [
    { id: 'AC-1', tier: 'hard', status: 'unverifiable', detail: 'checks did not execute' },
  ];

  it('is ABSENT when no cause was established', () => {
    const out = buildVerifyStructuredContent(
      'run_1',
      verdicts,
      undefined,
      projectRoot,
      undefined,
      undefined,
      false,
    );
    expect(out).not.toHaveProperty('environmentBlocked');
  });

  it('is PRESENT, as a sibling of verdict, when a cause was established', () => {
    const out = buildVerifyStructuredContent(
      'run_1',
      verdicts,
      undefined,
      projectRoot,
      undefined,
      undefined,
      false,
      undefined,
      environmentBlockedFromDiagnosis(DECAY),
    );
    expect(out.environmentBlocked).toEqual({
      cause: 'session-decay',
      symptom: DECAY.symptom,
      detail: DECAY.detail,
      fixCommand: DECAY.fixCommand,
      confidence: 'suspected',
    });
    // A SIBLING of `verdict`, never nested inside it (invariant #3).
    expect(out.verdict).not.toHaveProperty('environmentBlocked');
  });

  it("CAN'T FALSE-GREEN / CAN'T FALSE-RED: the verdict block is deep-equal with and without a cause", () => {
    const args = ['run_1', verdicts, undefined, projectRoot, undefined, undefined, false] as const;
    const without = buildVerifyStructuredContent(...args);
    const with_ = buildVerifyStructuredContent(
      ...args,
      undefined,
      environmentBlockedFromDiagnosis(DECAY),
    );
    expect(with_.verdict).toEqual(without.verdict);
    expect(with_.verdict.status).toBe('unverifiable');
    expect(with_.verdict.signedOff).toBe(without.verdict.signedOff);
  });

  it('does not upgrade an unverifiable run to a pass just because the cause is environmental', () => {
    const out = buildVerifyStructuredContent(
      'run_1',
      verdicts,
      undefined,
      projectRoot,
      undefined,
      undefined,
      false,
      undefined,
      environmentBlockedFromDiagnosis(DECAY),
    );
    expect(out.verdict.status).not.toBe('pass');
  });
});

describe('readinessStepCause', () => {
  it('maps the environment probes onto the diagnosis vocabulary', () => {
    expect(readinessStepCause('agent-device-daemon')).toBe('daemon-unresponsive');
    expect(readinessStepCause('device-claim')).toBe('phantom-device-claim');
    expect(readinessStepCause('companion-metro-owner')).toBe('foreign-metro');
    expect(readinessStepCause('agent-device')).toBe('stale-agent-device');
    expect(readinessStepCause('device')).toBe('device-not-ready');
  });

  it('calls a first-run setup gap setup-incomplete, NOT a wedged daemon', () => {
    // Telling a developer who simply has not installed the companion that their
    // daemon is broken is exactly the false alarm this feature exists to avoid.
    expect(readinessStepCause('companion-app')).toBe('setup-incomplete');
    expect(readinessStepCause('scheme')).toBe('setup-incomplete');
    expect(readinessStepCause('native-project')).toBe('setup-incomplete');
  });
});

describe('readinessEnvironmentBlocked', () => {
  const notReady: NativeReadiness = {
    ready: false,
    steps: [
      { id: 'native-project', label: 'React Native project', status: 'ok', detail: 'Detected.' },
      {
        id: 'device-claim',
        label: 'agent-device device claim',
        status: 'todo',
        detail: '1 claim held, but agent-device reports no live sessions.',
        action: 'kill $(cat daemon.pid)\nrm -rf "$HOME/.agent-device/sessions"',
      },
    ],
    nextAction: {
      id: 'device-claim',
      label: 'agent-device device claim',
      status: 'todo',
      detail: '1 claim held, but agent-device reports no live sessions.',
      action: 'kill $(cat daemon.pid)\nrm -rf "$HOME/.agent-device/sessions"',
    },
  };

  it('names the FIRST unmet step: one cause, one command, not a wall', () => {
    const out = readinessEnvironmentBlocked(notReady, 'src/Button.tsx');
    expect(out).toBeDefined();
    expect(out!.cause).toBe('phantom-device-claim');
    expect(out!.symptom).toContain('agent-device device claim');
    expect(out!.symptom).toContain('no live sessions');
    expect(out!.fixCommand).toBe(notReady.nextAction!.action);
    // A readiness step is a direct observation of a prerequisite, not an
    // inference from a symptom — so it is confirmed, not suspected.
    expect(out!.confidence).toBe('confirmed');
  });

  it('says the target was not rendered, and that this is not a judgement about the code', () => {
    const out = readinessEnvironmentBlocked(notReady, 'src/Button.tsx');
    expect(out!.detail).toContain('src/Button.tsx');
    expect(out!.detail).toMatch(/NOT a judgement about the code/i);
  });

  it('returns undefined for a READY checklist — a working setup is never "blocked"', () => {
    expect(
      readinessEnvironmentBlocked(
        { ready: true, steps: [{ id: 'device', label: 'Device', status: 'ok', detail: 'ok' }] },
        'src/Button.tsx',
      ),
    ).toBeUndefined();
  });

  it('falls back to the first todo step when nextAction is missing', () => {
    const out = readinessEnvironmentBlocked(
      { ready: false, steps: notReady.steps },
      'src/Button.tsx',
    );
    expect(out!.cause).toBe('phantom-device-claim');
  });

  it('omits fixCommand when the unmet step carries no action', () => {
    const out = readinessEnvironmentBlocked(
      {
        ready: false,
        steps: [{ id: 'device', label: 'Device', status: 'todo', detail: 'None booted.' }],
      },
      'src/Button.tsx',
    );
    expect(out).not.toHaveProperty('fixCommand');
    expect(out!.cause).toBe('device-not-ready');
  });
});
