/**
 * Run-the-export (Maestro) — classifiers, argv, and the recorded provenance.
 *
 * Every test here runs on a box with NO DEVICE. That is the point: the engine
 * invocation sits behind an injectable runner and the classifiers are pure, so
 * the interesting half — how agent-device's envelopes map onto a verdict, and
 * what that verdict is allowed to do to the portable badge — is provable from
 * recorded fixtures.
 *
 * The envelope shapes below are the 0.20.5 contract:
 *   - `{success, data|error}` at the CLI boundary (verified live on 0.20.3 in
 *     `replay-recording.ts`, unchanged in 0.20.5);
 *   - `data` for `test` is `ReplaySuiteResult`
 *     ({total, executed, passed, failed, skipped, notRun, durationMs, failures,
 *     tests[]}) and each `tests[]` row carries {file, status, error?};
 *   - unsupported Maestro syntax comes back as `INVALID_ARGS` with source
 *     context — the engine "fails loudly rather than being skipped".
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezeSpec, writeSpec, type Spec, type ValidityConfig } from '@validity.ai/verify-spec';
import {
  assessSpecPortability,
  loadExportsManifest,
  writeSpecExport,
  type ExportsManifest,
} from '@validity.ai/verify-web';
import {
  classifyMaestroFlowRun,
  classifyMaestroSuiteRun,
  maestroFlowArgs,
  maestroSuiteArgs,
  parseAgentDeviceEnvelope,
  resolveMaestroTarget,
  runMaestroExport,
  specIdFromFlowFile,
} from './run-maestro-export.js';

const T0 = '2026-01-01T00:00:00.000Z';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-maestro-run-'));
  roots.push(root);
  return root;
}

function ok(data: unknown): { code: number; stdout: string; stderr: string } {
  return { code: 0, stdout: JSON.stringify({ success: true, data }), stderr: '' };
}
function bad(
  error: { code: string; message: string; details?: Record<string, unknown> },
  exitCode = 1,
): { code: number; stdout: string; stderr: string } {
  return { code: exitCode, stdout: JSON.stringify({ success: false, error }), stderr: '' };
}

function suite(
  over: Partial<{
    total: number;
    executed: number;
    passed: number;
    failed: number;
    skipped: number;
    notRun: number;
    tests: unknown[];
  }> = {},
): Record<string, unknown> {
  return {
    total: 1,
    executed: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    notRun: 0,
    durationMs: 1200,
    failures: [],
    tests: [{ file: '/x/spec-a.v1.flow.yaml', status: 'passed', attempts: 1, replayed: 6 }],
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * Envelope parsing.                                                    *
 * ------------------------------------------------------------------ */

describe('parseAgentDeviceEnvelope', () => {
  it('parses a clean JSON envelope', () => {
    expect(parseAgentDeviceEnvelope('{"success":true,"data":{"passed":1}}')?.success).toBe(true);
  });

  it('recovers the envelope when a reporter line precedes it', () => {
    const stdout = 'Test summary: 1 passed (1)\n{"success":true,"data":{"passed":1}}';
    expect(parseAgentDeviceEnvelope(stdout)?.data?.passed).toBe(1);
  });

  it('returns undefined for unparseable output rather than throwing', () => {
    expect(parseAgentDeviceEnvelope('not json at all')).toBeUndefined();
    expect(parseAgentDeviceEnvelope('')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Suite classification.                                                *
 * ------------------------------------------------------------------ */

describe('classifyMaestroSuiteRun', () => {
  it('passed: every executed flow held', () => {
    const v = classifyMaestroSuiteRun(ok(suite()));
    expect(v.status).toBe('passed');
    expect(v.counts).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(v.flows).toEqual([{ file: '/x/spec-a.v1.flow.yaml', status: 'passed' }]);
  });

  it('failed: any failing flow makes the run failed, with the per-file reason', () => {
    const v = classifyMaestroSuiteRun(
      bad({ code: 'COMMAND_FAILED', message: 'Unknown test failure' }, 1) as never as {
        code: number;
        stdout: string;
        stderr: string;
      },
    );
    expect(v.status).toBe('not-run'); // no counts anywhere ⇒ pessimistic

    const withCounts = classifyMaestroSuiteRun(
      ok(
        suite({
          passed: 1,
          failed: 1,
          total: 2,
          executed: 2,
          tests: [
            { file: 'spec-a.v1.flow.yaml', status: 'passed' },
            {
              file: 'spec-b.v1.flow.yaml',
              status: 'failed',
              error: { code: 'ASSERTION_FAILED', message: 'assertVisible "Dashboard" timed out' },
            },
          ],
        }),
      ),
    );
    expect(withCounts.status).toBe('failed');
    expect(withCounts.flows?.find((f) => f.file.includes('spec-b'))?.message).toContain(
      'assertVisible',
    );
  });

  it('reads counts out of a FAILURE envelope too (exit code carries the failure)', () => {
    const res = {
      code: 1,
      stdout: JSON.stringify({
        success: false,
        error: { code: 'COMMAND_FAILED', message: '1 failed', details: suite({ failed: 1 }) },
      }),
      stderr: '',
    };
    expect(classifyMaestroSuiteRun(res).status).toBe('failed');
  });

  it('not-run: a suite that matched flows but executed none proves nothing', () => {
    const v = classifyMaestroSuiteRun(ok(suite({ total: 2, executed: 0, passed: 0, skipped: 2 })));
    expect(v.status).toBe('not-run');
    expect(v.detail).toContain('nothing was proven');
  });

  it('not-run: success with no readable summary is never upgraded to a pass', () => {
    const v = classifyMaestroSuiteRun({ code: 0, stdout: '{"success":true}', stderr: '' });
    expect(v.status).toBe('not-run');
    expect(v.detail).toContain('rather than inventing a pass');
  });

  it('unsupported: the engine refusing the flow syntax is an EXPORT defect', () => {
    const v = classifyMaestroSuiteRun(
      bad({
        code: 'INVALID_ARGS',
        message: 'Maestro command "assertTrue" is not supported.',
        details: { scriptPath: '/x/spec-a.v1.flow.yaml', line: 12 },
      }),
    );
    expect(v.status).toBe('unsupported');
    expect(v.errorCode).toBe('INVALID_ARGS');
    expect(v.detail).toContain('does not certify');
  });

  it('not-run: environment codes are never blamed on the flow', () => {
    for (const code of ['DEVICE_NOT_FOUND', 'APP_NOT_INSTALLED', 'TOOL_MISSING']) {
      const v = classifyMaestroSuiteRun(bad({ code, message: 'nope' }));
      expect(v.status).toBe('not-run');
      expect(v.detail).toContain('it did not run');
    }
  });

  it('not-run: OUR bad argv must never be recorded as an unsupported export', () => {
    const v = classifyMaestroSuiteRun(
      bad({
        code: 'INVALID_ARGS',
        message: 'Maestro replay requires --platform android|ios or an active mobile session.',
      }),
    );
    expect(v.status).toBe('not-run');
    expect(v.detail).toContain("Validity's own invocation");
  });
});

/* ------------------------------------------------------------------ *
 * Single-flow classification.                                          *
 * ------------------------------------------------------------------ */

describe('classifyMaestroFlowRun', () => {
  it('passed, and names the step count when the engine reported it', () => {
    const v = classifyMaestroFlowRun(ok({ replayed: 7, healed: 0, session: 's', message: 'ok' }));
    expect(v.status).toBe('passed');
    expect(v.detail).toContain('7 steps');
  });

  it('failed: an executed step that did not hold IS the answer we asked for', () => {
    const v = classifyMaestroFlowRun(
      bad({
        code: 'REPLAY_FAILED',
        message: 'assertVisible "Dashboard" timed out',
        details: { step: 4 },
      }),
    );
    expect(v.status).toBe('failed');
    expect(v.detail).toContain('step 4');
  });

  it('unsupported beats failed: a parse-time refusal is not a step failure', () => {
    const v = classifyMaestroFlowRun(
      bad({ code: 'INVALID_ARGS', message: 'Maestro command "copyText" is not supported.' }),
    );
    expect(v.status).toBe('unsupported');
  });

  it('environment codes still land on not-run', () => {
    expect(
      classifyMaestroFlowRun(bad({ code: 'DEVICE_NOT_FOUND', message: 'no device' })).status,
    ).toBe('not-run');
  });
});

/* ------------------------------------------------------------------ *
 * argv.                                                               *
 * ------------------------------------------------------------------ */

describe('argv builders', () => {
  it('suite form matches the 0.20.5 documented shape', () => {
    expect(maestroSuiteArgs('/p/.validity/exports/maestro')).toEqual([
      'test',
      '/p/.validity/exports/maestro',
      '--maestro',
      '--json',
    ]);
  });

  it('single form uses replay, and keeps the target binding on the command', () => {
    expect(maestroFlowArgs('/p/spec-a.v1.flow.yaml', { platform: 'ios', device: 'ABC' })).toEqual([
      'replay',
      '/p/spec-a.v1.flow.yaml',
      '--maestro',
      '--json',
      '--platform',
      'ios',
      '--device',
      'ABC',
    ]);
  });

  it('omits the target binding entirely when unset (agent-device uses the session)', () => {
    expect(maestroSuiteArgs('/p').some((a) => a === '--platform')).toBe(false);
  });

  it('forwards --fail-fast, --timeout and repeatable -e', () => {
    expect(
      maestroSuiteArgs('/p', { failFast: true, timeoutMs: 90_000, env: ['A=1', 'B=2'] }),
    ).toEqual([
      'test',
      '/p',
      '--maestro',
      '--json',
      '--fail-fast',
      '--timeout',
      '90000',
      '-e',
      'A=1',
      '-e',
      'B=2',
    ]);
  });

  it('maps an artifact filename back to its spec id', () => {
    expect(specIdFromFlowFile('/a/b/spec-x1.v3.flow.yaml')).toBe('spec-x1');
    expect(specIdFromFlowFile('notes.yaml')).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Target binding precedence: flags over `export.maestro.run`.          *
 * ------------------------------------------------------------------ */

describe('resolveMaestroTarget — CLI flags beat config defaults, per field', () => {
  it('config alone supplies the binding (the reason the stanza exists)', () => {
    const t = resolveMaestroTarget({ config: { platform: 'android', device: 'emulator-5554' } });
    expect(t).toEqual({
      platform: 'android',
      device: 'emulator-5554',
      platformSource: 'config',
      deviceSource: 'config',
      notices: [],
    });
    // …and it reaches the argv, which is the only thing agent-device sees.
    expect(maestroSuiteArgs('/p', t)).toEqual([
      'test',
      '/p',
      '--maestro',
      '--json',
      '--platform',
      'android',
      '--device',
      'emulator-5554',
    ]);
  });

  it('an explicit flag WINS over the configured default', () => {
    const t = resolveMaestroTarget({
      flags: { platform: 'ios', device: 'SIM-9' },
      config: { platform: 'android', device: 'emulator-5554' },
    });
    expect(t.platform).toBe('ios');
    expect(t.device).toBe('SIM-9');
    expect(t.platformSource).toBe('flag');
    expect(t.deviceSource).toBe('flag');
  });

  it('resolves the two fields INDEPENDENTLY — a --device flag never drops the configured platform', () => {
    // The CI shape: committed `platform`, and the runner passes the udid of
    // whichever device it just booted. An all-or-nothing rule would silently
    // unbind the platform here and hand the flows to the active session.
    const t = resolveMaestroTarget({
      flags: { device: 'emulator-5556' },
      config: { platform: 'android', device: 'emulator-5554' },
    });
    expect(t.platform).toBe('android');
    expect(t.platformSource).toBe('config');
    expect(t.device).toBe('emulator-5556');
    expect(t.deviceSource).toBe('flag');
  });

  it('neither set leaves the flags OFF the argv (agent-device uses the active session)', () => {
    const t = resolveMaestroTarget({});
    expect(t.platform).toBeUndefined();
    expect(t.device).toBeUndefined();
    expect(t.platformSource).toBe('unset');
    expect(t.deviceSource).toBe('unset');
    expect(maestroSuiteArgs('/p', t)).toEqual(['test', '/p', '--maestro', '--json']);
  });

  it('accepts a flag in any case, and does not treat an empty flag as a choice', () => {
    expect(resolveMaestroTarget({ flags: { platform: 'IOS' } }).platform).toBe('ios');
    const empty = resolveMaestroTarget({
      flags: { platform: '' },
      config: { platform: 'android' },
    });
    expect(empty.platform).toBe('android');
    expect(empty.notices).toEqual([]);
  });

  it('an UNRECOGNIZED --platform is reported and ignored — the config default still applies', () => {
    // A typo could never have bound a target, so honouring it as "the user said
    // something" would only turn one mistake into a second, quieter failure.
    const t = resolveMaestroTarget({
      flags: { platform: 'droid' },
      config: { platform: 'android' },
    });
    expect(t.platform).toBe('android');
    expect(t.platformSource).toBe('config');
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toContain('ignoring --platform "droid"');
    expect(t.notices[0]).toContain('export.maestro.run.platform (android)');
  });

  it('still reports an unrecognized --platform when no config default exists', () => {
    const t = resolveMaestroTarget({ flags: { platform: 'droid' } });
    expect(t.platform).toBeUndefined();
    expect(t.platformSource).toBe('unset');
    expect(t.notices[0]).toContain('expected `ios` or `android`');
    expect(t.notices[0]).not.toContain('instead');
  });
});

/* ------------------------------------------------------------------ *
 * Orchestration + recorded provenance.                                 *
 * ------------------------------------------------------------------ */

function nativeSpec(id = 'spec-nat1'): Spec {
  return {
    id,
    version: 1,
    status: 'draft',
    source: { prompt: 'the dashboard shows a balance', createdBy: 'agent' },
    runtime: 'native',
    criteria: [
      {
        id: 'AC-1',
        text: 'the dashboard shows a balance',
        tier: 'hard',
        mocking: 'none',
        checks: [{ expect: { element: { name: 'Balance', state: 'visible' } } }],
      },
    ],
    createdAt: T0,
  };
}

const CONFIG: ValidityConfig = {
  renderMode: 'native',
  framework: 'auto',
  wrapper: './.validity/wrapper.tsx',
  export: { appId: 'com.example.app', maestro: { enabled: true } },
};

/** Freeze + canonically export a native spec into `root`. */
function seedExport(root: string, id = 'spec-nat1'): { spec: Spec; flowPath: string } {
  writeSpec(root, nativeSpec(id));
  const spec = freezeSpec({ projectRoot: root, specId: id, gitBinding: null }).spec;
  const result = writeSpecExport(root, spec, CONFIG, { now: T0 });
  return { spec, flowPath: result.written[0]! };
}

function manifestOf(root: string): ExportsManifest {
  return loadExportsManifest(root);
}

describe('runMaestroExport — dry-run (no device)', () => {
  it('lints the exported flow and passes when it is inside the subset', async () => {
    const root = tempRoot();
    seedExport(root);
    const report = await runMaestroExport({ projectRoot: root, specId: 'spec-nat1', dryRun: true });
    expect(report.mode).toBe('dry-run');
    expect(report.ok).toBe(true);
    expect(report.flows).toHaveLength(1);
    expect(report.flows[0]!.warnings).toEqual([]);
    // A lint is not a run: it must NEVER manufacture provenance.
    expect(report.recorded).toEqual([]);
    expect(manifestOf(root).entries['spec-nat1']!.lastRun).toBeUndefined();
  });

  it('fails, and never touches a device, when the committed flow left the subset', async () => {
    const root = tempRoot();
    const { flowPath } = seedExport(root);
    writeFileSync(flowPath, `${readFileSync(flowPath, 'utf-8')}\n- assertTrue: nope\n`);
    let spawned = 0;
    const report = await runMaestroExport({
      projectRoot: root,
      specId: 'spec-nat1',
      dryRun: true,
      deps: {
        run: async () => {
          spawned += 1;
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    });
    expect(spawned).toBe(0);
    expect(report.ok).toBe(false);
    const warning = report.flows[0]!.warnings.find((w) => w.scope.includes('assertTrue'));
    expect(warning?.severity).toBe('wont-run');
    // The line number is what makes the finding actionable — it must be real.
    expect(warning?.scope).toMatch(/^flow line \d+ \(assertTrue\)$/);
  });

  it('reports honestly when there is nothing to run', async () => {
    const root = tempRoot();
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    const report = await runMaestroExport({ projectRoot: root, dryRun: true });
    expect(report.ok).toBe(false);
    expect(report.notices.join(' ')).toContain('no exported Maestro flows');
  });
});

describe('runMaestroExport — device mode', () => {
  it('records a pass against the exact bytes that ran, and the badge sees it', async () => {
    const root = tempRoot();
    const { spec } = seedExport(root);
    const report = await runMaestroExport({
      projectRoot: root,
      specId: 'spec-nat1',
      platform: 'android',
      device: 'emulator-5554',
      deps: {
        now: () => T0,
        version: '0.20.5',
        run: async (_bin, args) => {
          expect(args[0]).toBe('replay');
          expect(args).toContain('--maestro');
          return ok({ replayed: 4, healed: 0, session: 's', message: 'ok' });
        },
      },
    });
    expect(report.verdict?.status).toBe('passed');
    expect(report.ok).toBe(true);
    expect(report.recorded).toEqual(['spec-nat1']);

    const run = manifestOf(root).entries['spec-nat1']!.lastRun!;
    expect(run).toMatchObject({
      target: 'maestro',
      status: 'passed',
      at: T0,
      device: { platform: 'android', id: 'emulator-5554' },
      tool: { name: 'agent-device', command: 'replay --maestro', version: '0.20.5' },
    });
    // Pinned to the artifact bytes — the anti-staleness anchor.
    expect(run.files[0]!.sha256).toBe(manifestOf(root).entries['spec-nat1']!.files[0]!.sha256);

    const badge = assessSpecPortability(root, spec, CONFIG);
    expect(badge.status).toBe('portable');
    expect(badge.run?.status).toBe('passed');
  });

  it('a failed run BLOCKS the portable badge even with clean warnings + fresh bytes', async () => {
    const root = tempRoot();
    const { spec } = seedExport(root);
    await runMaestroExport({
      projectRoot: root,
      specId: 'spec-nat1',
      deps: {
        now: () => T0,
        run: async () =>
          bad({ code: 'REPLAY_FAILED', message: 'assertVisible "Balance" timed out' }),
      },
    });
    const badge = assessSpecPortability(root, spec, CONFIG);
    expect(badge.run?.status).toBe('failed');
    expect(badge.status).toBe('blocked');
  });

  it('an unsupported-syntax refusal blocks the badge (an export that cannot run)', async () => {
    const root = tempRoot();
    const { spec } = seedExport(root);
    await runMaestroExport({
      projectRoot: root,
      specId: 'spec-nat1',
      deps: {
        now: () => T0,
        run: async () =>
          bad({
            code: 'INVALID_ARGS',
            message: 'Maestro command "assertTrue" is not supported.',
            details: { line: 12 },
          }),
      },
    });
    expect(assessSpecPortability(root, spec, CONFIG).status).toBe('blocked');
  });

  it('a not-run outcome neither blocks nor vouches — but the CLI still exits non-zero', async () => {
    const root = tempRoot();
    const { spec } = seedExport(root);
    const report = await runMaestroExport({
      projectRoot: root,
      specId: 'spec-nat1',
      deps: {
        now: () => T0,
        run: async () => bad({ code: 'DEVICE_NOT_FOUND', message: 'no booted device' }),
      },
    });
    expect(report.verdict?.status).toBe('not-run');
    expect(report.ok).toBe(false);
    const badge = assessSpecPortability(root, spec, CONFIG);
    expect(badge.run?.status).toBe('not-run');
    expect(badge.status).toBe('portable'); // unchanged: absence of a run is not evidence
  });

  it('a runner that throws is recorded as not-run, never as a failure', async () => {
    const root = tempRoot();
    seedExport(root);
    const report = await runMaestroExport({
      projectRoot: root,
      specId: 'spec-nat1',
      deps: {
        now: () => T0,
        run: async () => {
          throw new Error('spawn ENOENT');
        },
      },
    });
    expect(report.verdict?.status).toBe('not-run');
    expect(report.verdict?.detail).toContain('spawn ENOENT');
  });

  it('a suite run records each flow on its OWN verdict, not the suite-wide one', async () => {
    const root = tempRoot();
    seedExport(root, 'spec-nat1');
    seedExport(root, 'spec-nat2');
    const report = await runMaestroExport({
      projectRoot: root,
      deps: {
        now: () => T0,
        run: async (_bin, args) => {
          expect(args[0]).toBe('test');
          return ok(
            suite({
              total: 2,
              executed: 2,
              passed: 1,
              failed: 1,
              tests: [
                { file: 'spec-nat1.v1.flow.yaml', status: 'passed' },
                {
                  file: 'spec-nat2.v1.flow.yaml',
                  status: 'failed',
                  error: { message: 'assertVisible "Balance" timed out' },
                },
              ],
            }),
          );
        },
      },
    });
    expect(report.verdict?.status).toBe('failed');
    expect(report.recorded.sort()).toEqual(['spec-nat1', 'spec-nat2']);
    const entries = manifestOf(root).entries;
    expect(entries['spec-nat1']!.lastRun!.status).toBe('passed');
    expect(entries['spec-nat2']!.lastRun!.status).toBe('failed');
  });

  it('a flow the suite never mentioned is recorded not-run, never inherited as a pass', async () => {
    const root = tempRoot();
    seedExport(root, 'spec-nat1');
    seedExport(root, 'spec-nat2');
    await runMaestroExport({
      projectRoot: root,
      deps: {
        now: () => T0,
        run: async () =>
          ok(
            suite({
              total: 1,
              executed: 1,
              passed: 1,
              failed: 0,
              tests: [{ file: 'spec-nat1.v1.flow.yaml', status: 'passed' }],
            }),
          ),
      },
    });
    const entries = manifestOf(root).entries;
    expect(entries['spec-nat1']!.lastRun!.status).toBe('passed');
    expect(entries['spec-nat2']!.lastRun!.status).toBe('not-run');
  });
});

describe('run provenance staleness', () => {
  it('a re-export of UNCHANGED bytes keeps the run record', async () => {
    const root = tempRoot();
    const { spec } = seedExport(root);
    await runMaestroExport({
      projectRoot: root,
      specId: 'spec-nat1',
      deps: { now: () => T0, run: async () => ok({ replayed: 3 }) },
    });
    writeSpecExport(root, spec, CONFIG, { now: T0 });
    expect(manifestOf(root).entries['spec-nat1']!.lastRun?.status).toBe('passed');
    expect(assessSpecPortability(root, spec, CONFIG).run?.status).toBe('passed');
  });

  it('an export whose BYTES moved drops the run — a pass never transfers', async () => {
    const root = tempRoot();
    const { spec } = seedExport(root);
    await runMaestroExport({
      projectRoot: root,
      specId: 'spec-nat1',
      deps: { now: () => T0, run: async () => ok({ replayed: 3 }) },
    });
    // A config edit that changes the emitted flow (routes are inputs-hashed).
    writeSpecExport(
      root,
      spec,
      { ...CONFIG, export: { ...CONFIG.export, appId: 'com.example.other' } },
      { now: T0 },
    );
    expect(manifestOf(root).entries['spec-nat1']!.lastRun).toBeUndefined();
    expect(assessSpecPortability(root, spec, CONFIG).run?.status).toBe('not-run');
  });

  it('a hand-edited flow that was run reads as STALE against the manifest', async () => {
    const root = tempRoot();
    const { spec, flowPath } = seedExport(root);
    writeFileSync(flowPath, `${readFileSync(flowPath, 'utf-8')}# tampered\n`);
    await runMaestroExport({
      projectRoot: root,
      specId: 'spec-nat1',
      deps: { now: () => T0, run: async () => ok({ replayed: 3 }) },
    });
    const badge = assessSpecPortability(root, spec, CONFIG);
    // The artifact check already flags the hand edit; the run standing must not
    // paper over it by claiming those bytes passed.
    expect(badge.run?.status).toBe('stale');
    expect(badge.status).toBe('blocked');
  });
});
