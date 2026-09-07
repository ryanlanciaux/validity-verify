/**
 * The `.ad` recording contract, tested where it is cheapest to test: as pure
 * argv construction and pure outcome mapping, with no device anywhere.
 *
 * The argv assertions are deliberately exact rather than "contains the flag".
 * Every one of them encodes a rule agent-device enforces by REFUSING to publish
 * (one recorded open, no `@ref` steps, a selector wait as the destination
 * guard, `--record-as` never alongside `--no-record`), so a drifting flag would
 * not fail loudly at runtime — it would silently produce a run with no
 * recording, which is exactly the failure mode this file exists to catch.
 */
import { describe, expect, it } from 'vitest';
import {
  armRecordingFlags,
  classifyAgentDeviceReplay,
  classifyRecordingPublish,
  configuredSecrets,
  destinationGuardArgs,
  destinationGuardSelector,
  divergenceEvidenceLines,
  fillRecordingFlags,
  isFreshSessionArmRefusal,
  keepSessionRefusal,
  KEEP_SESSION_FLAG,
  NO_RECORD_FLAG,
  normalizeScenarioSecrets,
  parseDivergenceReport,
  planRecordedFill,
  publishRecordingArgs,
  recordAsVarName,
  recordingPathFor,
  recordingVariableNames,
  redactSecrets,
  repairTransactionLines,
  replayEnvArgs,
  replayRecordingArgs,
  resolveSecrets,
  resumeCommandLine,
  REPLAY_RECORDING_FILENAME,
} from './replay-recording.js';

const MARKER = 'validity-root:a1b2c3';

describe('recording argv', () => {
  it('names the recording replay.ad inside the run dir', () => {
    expect(REPLAY_RECORDING_FILENAME).toBe('replay.ad');
    expect(recordingPathFor('/p/.validity/runs/r1')).toBe('/p/.validity/runs/r1/replay.ad');
  });

  it('arms the open with --save-script and --force', () => {
    // --force matters: the native engine retries a capture after a Metro
    // restart, and upstream REFUSES an existing --save-script target without
    // it. A refusal there would abort the open, not just the recording.
    expect(armRecordingFlags('/runs/r1/replay.ad')).toEqual([
      '--save-script',
      '/runs/r1/replay.ad',
      '--force',
    ]);
  });

  it('publishes without closing the session', () => {
    // `close --save-script` is the other publish verb and is NOT usable here:
    // Validity's verify session is shared across every spec in the process and
    // is never closed.
    const args = publishRecordingArgs('/runs/r1/replay.ad');
    expect(args).toEqual(['session', 'save-script', '/runs/r1/replay.ad', '--force', '--json']);
    expect(args).not.toContain('close');
  });

  it('replays a recording by path', () => {
    expect(replayRecordingArgs('/runs/r1/replay.ad')).toEqual([
      'replay',
      '/runs/r1/replay.ad',
      '--json',
    ]);
  });

  it('is byte-identical to the pre-0.20.5 argv when no options are passed', () => {
    // Every existing replay path must keep its exact argv — the options below
    // are opt-in, and an unrequested flag would change device behavior.
    expect(replayRecordingArgs('/runs/r1/replay.ad', {})).toEqual(
      replayRecordingArgs('/runs/r1/replay.ad'),
    );
  });

  it('forwards --keep-session after the env pairs', () => {
    expect(
      replayRecordingArgs('/runs/r1/replay.ad', {
        keepSession: true,
        env: [{ name: 'LOGIN_PASSWORD', value: 'hunter2' }],
      }),
    ).toEqual([
      'replay',
      '/runs/r1/replay.ad',
      '--json',
      '-e',
      'LOGIN_PASSWORD=hunter2',
      KEEP_SESSION_FLAG,
    ]);
  });

  it('never sends the retired --update/-u (ADR 0012 made it a no-op)', () => {
    const args = replayRecordingArgs('/runs/r1/replay.ad', { keepSession: true });
    expect(args).not.toContain('--update');
    expect(args).not.toContain('-u');
  });
});

describe('keepSessionRefusal', () => {
  it('allows a native .ad (the only lane upstream accepts the flag on)', () => {
    expect(keepSessionRefusal('/runs/r1/replay.ad')).toBeUndefined();
    expect(keepSessionRefusal('REPLAY.AD')).toBeUndefined();
  });

  it('refuses a Maestro YAML flow by name, before a device is claimed', () => {
    const why = keepSessionRefusal('./e2e/login.yaml');
    expect(why).toContain('native `.ad` recordings only');
    expect(why).toContain('Maestro');
  });

  it('refuses anything else rather than letting agent-device INVALID_ARGS it', () => {
    expect(keepSessionRefusal('./flow.js')).toContain('.js script');
    expect(keepSessionRefusal('./flow')).toContain('no .ad extension');
  });
});

describe('destination guard', () => {
  // The guard is the whole reason a recording is publishable. Upstream accepts
  // ONLY a selector wait on a labeled or id-bearing landmark; a duration wait,
  // `wait stable`, `wait @ref`, and a BARE positional (which parses as a text
  // wait — what Validity's existing render-marker wait sends) all fail closed.
  it('is a quoted id= selector, not a bare positional', () => {
    expect(destinationGuardSelector(MARKER)).toBe('id="validity-root:a1b2c3"');
  });

  it('quotes the marker, which contains a colon the parser would otherwise split on', () => {
    expect(destinationGuardSelector(MARKER)).toContain('"');
  });

  it('builds `wait <selector> <timeoutMs>`', () => {
    expect(destinationGuardArgs(MARKER, 2500)).toEqual([
      'wait',
      'id="validity-root:a1b2c3"',
      '2500',
    ]);
  });

  it('never emits a form upstream rejects as a guard', () => {
    const args = destinationGuardArgs(MARKER, 2500);
    expect(args).not.toContain('stable');
    expect(args[1].startsWith('@')).toBe(false);
    expect(args[1]).toMatch(/^id=/);
  });
});

describe('isFreshSessionArmRefusal', () => {
  it('matches the 0.20.3 refusal verbatim', () => {
    // The exact string upstream's session.js emits when `open --save-script`
    // meets a session the daemon still holds — what a failed run leaves behind.
    expect(
      isFreshSessionArmRefusal(
        'Error (INVALID_ARGS): open --save-script can only arm a fresh session. ' +
          'Use the current session without --save-script, or close it and start a fresh session.',
      ),
    ).toBe(true);
  });

  it('does not fire on other INVALID_ARGS or session errors', () => {
    expect(isFreshSessionArmRefusal('Error (INVALID_ARGS): unknown flag --save-scripts')).toBe(
      false,
    );
    expect(isFreshSessionArmRefusal('Error (SESSION_NOT_FOUND): Run open first')).toBe(false);
    expect(isFreshSessionArmRefusal('Device is already in use by session "default"')).toBe(false);
    expect(isFreshSessionArmRefusal('')).toBe(false);
  });
});

describe('recordAsVarName', () => {
  it('uppercases and collapses separators', () => {
    expect(recordAsVarName('login password')).toBe('LOGIN_PASSWORD');
    expect(recordAsVarName('auth.token-v2')).toBe('AUTH_TOKEN_V2');
  });

  it('trims the separators it would otherwise leave dangling', () => {
    expect(recordAsVarName('--secret--')).toBe('SECRET');
  });

  it('prefixes a leading digit — ${1PASSWORD} is not a legal placeholder', () => {
    expect(recordAsVarName('1password')).toBe('V_1PASSWORD');
  });

  it('falls back rather than emitting an empty placeholder name', () => {
    expect(recordAsVarName('---')).toBe('VALIDITY_SECRET');
  });
});

describe('fillRecordingFlags', () => {
  it('adds nothing at all when no recording is armed', () => {
    // An unrecorded run must keep its exact pre-recording argv.
    expect(fillRecordingFlags({ armed: false, target: '@e12' })).toEqual([]);
    expect(fillRecordingFlags({ armed: false, target: 'id="pw"', secretVar: 'PW' })).toEqual([]);
  });

  it('excludes an @ref-targeted fill from the recording', () => {
    // Publication refuses a recorded step carrying a session-local ref, so
    // recording it would not produce a safer script — it would produce none.
    // This is the LIVE path: the check executor resolves fill targets from a
    // snapshot, so a spec's literal fill value never enters the .ad.
    expect(fillRecordingFlags({ armed: true, target: '@e12' })).toEqual([NO_RECORD_FLAG]);
    expect(fillRecordingFlags({ armed: true, target: '@e12', secretVar: 'PW' })).toEqual([
      NO_RECORD_FLAG,
    ]);
  });

  it('publishes a selector-targeted secret as ${VAR}, never as the literal', () => {
    expect(
      fillRecordingFlags({ armed: true, target: 'id="password"', secretVar: 'login password' }),
    ).toEqual(['--record-as', 'LOGIN_PASSWORD']);
  });

  it('never combines --record-as with --no-record (upstream rejects the pair)', () => {
    const flags = fillRecordingFlags({ armed: true, target: 'id="pw"', secretVar: 'PW' });
    expect(flags).toContain('--record-as');
    expect(flags).not.toContain(NO_RECORD_FLAG);
  });

  it('leaves a non-secret selector fill recorded verbatim', () => {
    expect(fillRecordingFlags({ armed: true, target: 'id="query"' })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

const envelope = (body: unknown): string => JSON.stringify(body);

describe('classifyRecordingPublish', () => {
  it('reports a published script', () => {
    expect(
      classifyRecordingPublish({
        code: 0,
        stdout: envelope({ success: true, data: { path: '/runs/r1/replay.ad' } }),
        stderr: '',
      }),
    ).toEqual({ published: true });
  });

  it('carries upstream refusal text verbatim', () => {
    const res = classifyRecordingPublish({
      code: 1,
      stdout: envelope({
        success: false,
        error: {
          code: 'COMMAND_FAILED',
          message: 'Cannot publish this session without a portable destination guard.',
        },
      }),
      stderr: '',
    });
    expect(res.published).toBe(false);
    expect(res.reason).toContain('portable destination guard');
  });

  it('refuses to claim a publication it did not observe', () => {
    // Exit 0 with unreadable output is NOT evidence a file was written.
    const res = classifyRecordingPublish({ code: 0, stdout: 'not json', stderr: '' });
    expect(res.published).toBe(false);
    expect(res.reason).toContain('did not report a published script');
  });
});

describe('classifyAgentDeviceReplay', () => {
  it('maps a successful replay to reproduced, naming landmark verification', () => {
    const res = classifyAgentDeviceReplay({
      code: 0,
      stdout: envelope({
        success: true,
        data: { replayed: 2, healed: 0, session: 'cwd_abc_default', sessionActive: true },
      }),
      stderr: '',
    });
    expect(res.outcome).toBe('reproduced');
    expect(res.replayed).toBe(2);
    expect(res.session).toBe('cwd_abc_default');
    expect(res.notice).toContain('2 steps');
    expect(res.notice).toContain('recorded identity');
  });

  it('singularizes a one-step replay', () => {
    const res = classifyAgentDeviceReplay({
      code: 0,
      stdout: envelope({ success: true, data: { replayed: 1 } }),
      stderr: '',
    });
    expect(res.notice).toContain('1 step)');
  });

  it('maps REPLAY_DIVERGENCE to regressed, with the failing step', () => {
    // The ONLY code that means "the app changed under the recording".
    const res = classifyAgentDeviceReplay({
      code: 1,
      stdout: envelope({
        success: false,
        error: {
          code: 'REPLAY_DIVERGENCE',
          message: 'Replay failed at step 2 (wait id="validity-root:a1b2c3"): wait timed out',
          details: { step: 2, action: 'wait' },
        },
      }),
      stderr: '',
    });
    expect(res.outcome).toBe('regressed');
    expect(res.errorCode).toBe('REPLAY_DIVERGENCE');
    expect(res.step).toBe(2);
    expect(res.notice).toContain('no longer reaches its landmark');
    expect(res.notice).toContain('step 2');
  });

  it.each([
    'DEVICE_NOT_FOUND',
    'DEVICE_IN_USE',
    'APP_NOT_INSTALLED',
    'SESSION_NOT_FOUND',
    'TOOL_MISSING',
    'UNSUPPORTED_PLATFORM',
    'UNSUPPORTED_OPERATION',
    'UNAUTHORIZED',
    'NOT_IMPLEMENTED',
  ])('maps the environment code %s to unverifiable-now, never regressed', (code) => {
    // Replay attaches only. None of these says anything about the code under
    // test, so calling them red would be a false red.
    const res = classifyAgentDeviceReplay({
      code: 1,
      stdout: envelope({ success: false, error: { code, message: 'nope' } }),
      stderr: '',
    });
    expect(res.outcome).toBe('unverifiable-now');
    expect(res.errorCode).toBe(code);
    expect(res.notice).toContain('attaches only');
  });

  it('maps an unattributable failure to unverifiable-now, not to a regression', () => {
    const res = classifyAgentDeviceReplay({
      code: 1,
      stdout: envelope({
        success: false,
        error: { code: 'COMMAND_FAILED', message: 'the daemon fell over' },
      }),
      stderr: '',
    });
    expect(res.outcome).toBe('unverifiable-now');
    expect(res.errorCode).toBe('COMMAND_FAILED');
    expect(res.notice).toContain('Not counted as a regression');
  });

  it('never reads unparseable output as success', () => {
    const res = classifyAgentDeviceReplay({ code: 3, stdout: 'segfault', stderr: 'boom' });
    expect(res.outcome).toBe('unverifiable-now');
    expect(res.errorCode).toBeUndefined();
  });

  it('never reads an empty stdout as success', () => {
    const res = classifyAgentDeviceReplay({ code: 0, stdout: '', stderr: '' });
    expect(res.outcome).toBe('unverifiable-now');
  });
});

/* ------------------------------------------------------------------ *
 * Declared secrets.                                                   *
 * ------------------------------------------------------------------ */

describe('normalizeScenarioSecrets', () => {
  it('accepts the string shorthand as name-and-env', () => {
    expect(normalizeScenarioSecrets(['LOGIN_PASSWORD'])).toEqual([
      { name: 'LOGIN_PASSWORD', env: 'LOGIN_PASSWORD' },
    ]);
  });

  it('normalizes the VARIABLE name but takes the env var verbatim', () => {
    // The variable has to match what the .ad carries (`${LOGIN_PASSWORD}`);
    // the env var is the user's own export and must not be rewritten.
    expect(normalizeScenarioSecrets([{ name: 'login password', env: 'e2e_pw' }])).toEqual([
      { name: 'LOGIN_PASSWORD', env: 'e2e_pw' },
    ]);
  });

  it('de-duplicates by variable name, first declaration winning', () => {
    expect(
      normalizeScenarioSecrets([{ name: 'TOKEN', env: 'A' }, 'token', { name: 'TOKEN', env: 'B' }]),
    ).toEqual([{ name: 'TOKEN', env: 'A' }]);
  });

  it('drops junk rather than inventing a variable', () => {
    expect(normalizeScenarioSecrets(['', '   '])).toEqual([]);
    expect(normalizeScenarioSecrets(undefined)).toEqual([]);
  });
});

describe('configuredSecrets', () => {
  it('collapses every scenario, because a .ad is per SESSION not per scenario', () => {
    expect(
      configuredSecrets({
        'logged-in': { secrets: ['LOGIN_PASSWORD'] },
        admin: { secrets: [{ name: 'ADMIN_TOKEN', env: 'CI_ADMIN_TOKEN' }] },
        plain: {},
      }),
    ).toEqual([
      { name: 'LOGIN_PASSWORD', env: 'LOGIN_PASSWORD' },
      { name: 'ADMIN_TOKEN', env: 'CI_ADMIN_TOKEN' },
    ]);
  });

  it('is empty for a config that declares none', () => {
    expect(configuredSecrets(undefined)).toEqual([]);
  });
});

describe('resolveSecrets', () => {
  it('reads the live value out of the environment', () => {
    const res = resolveSecrets([{ name: 'PW', env: 'E2E_PW' }], { E2E_PW: 'hunter2' });
    expect(res.resolved).toEqual([{ name: 'PW', env: 'E2E_PW', value: 'hunter2' }]);
    expect(res.missing).toEqual([]);
  });

  it('treats an EMPTY export as missing — filling "" would score a typo', () => {
    const res = resolveSecrets([{ name: 'PW', env: 'E2E_PW' }], { E2E_PW: '' });
    expect(res.resolved).toEqual([]);
    expect(res.missing).toEqual([{ name: 'PW', env: 'E2E_PW' }]);
  });
});

describe('recordingVariableNames', () => {
  it('reads the ${VAR} placeholders a published .ad carries', () => {
    const ad = [
      'context platform=android device="emulator-5554"',
      'open "ai.validity.playground"',
      'fill \'id="password"\' "${LOGIN_PASSWORD}"',
      'fill \'id="token"\' "${LOGIN_PASSWORD}"',
      'wait \'id="validity-root:a1b2c3"\' 2500',
    ].join('\n');
    expect(recordingVariableNames(ad)).toEqual(['LOGIN_PASSWORD']);
  });

  it('demands nothing from a recording that carries no placeholders', () => {
    expect(recordingVariableNames('open "app"\nwait \'id="x"\' 100')).toEqual([]);
  });
});

describe('replayEnvArgs', () => {
  it('maps resolved secrets onto -e pairs by VARIABLE name, not env name', () => {
    expect(replayEnvArgs([{ name: 'PW', env: 'E2E_PW', value: 'hunter2' }])).toEqual([
      { name: 'PW', value: 'hunter2' },
    ]);
  });
});

describe('redactSecrets', () => {
  const secrets = [
    { name: 'PW', env: 'PW', value: 'hunter2' },
    { name: 'LONG', env: 'LONG', value: 'hunter2-extended' },
  ];

  it('replaces a live value with its placeholder', () => {
    expect(redactSecrets('typed hunter2 into the field', [secrets[0]!])).toBe(
      'typed ${PW} into the field',
    );
  });

  it('redacts the LONGEST value first, so no fragment survives', () => {
    // Naive shortest-first would leave "${PW}-extended" — half a secret.
    expect(redactSecrets('sent hunter2-extended', secrets)).toBe('sent ${LONG}');
  });

  it('is a no-op with nothing declared', () => {
    expect(redactSecrets('hunter2', [])).toBe('hunter2');
  });
});

describe('planRecordedFill', () => {
  const SECRETS = [{ name: 'LOGIN_PASSWORD', env: 'E2E_PW', value: 'hunter2' }];

  it('sends the LIVE value and records it as ${VAR}', () => {
    const plan = planRecordedFill({
      armed: true,
      target: 'id="password"',
      value: '${LOGIN_PASSWORD}',
      secrets: SECRETS,
    });
    expect(plan.value).toBe('hunter2');
    expect(plan.flags).toEqual(['--record-as', 'LOGIN_PASSWORD']);
    expect(plan.publishable).toBe(true);
  });

  it('BLOCKS a placeholder with no value instead of typing "${VAR}" into the field', () => {
    const plan = planRecordedFill({
      armed: true,
      target: 'id="password"',
      value: '${LOGIN_PASSWORD}',
      secrets: [],
    });
    expect(plan.blocked).toBe(true);
    expect(plan.publishable).toBe(false);
    expect(plan.reason).toContain('nothing in the environment supplies it');
  });

  it('FAILS CLOSED on a literal secret under an armed selector fill', () => {
    // The recording is abandoned, not silently trimmed: a login journey minus
    // its login step replays to the wrong screen.
    const plan = planRecordedFill({
      armed: true,
      target: 'id="password"',
      value: 'hunter2',
      secrets: SECRETS,
    });
    expect(plan.publishable).toBe(false);
    expect(plan.flags).toEqual([NO_RECORD_FLAG]);
    expect(plan.reason).toContain('publishes NO `.ad` recording');
  });

  it('leaves an @ref fill alone — it can never reach the script anyway', () => {
    const plan = planRecordedFill({
      armed: true,
      target: '@e12',
      value: 'hunter2',
      secrets: SECRETS,
    });
    expect(plan.flags).toEqual([NO_RECORD_FLAG]);
    expect(plan.publishable).toBe(true);
  });

  it('is byte-identical to fillRecordingFlags for an ordinary value', () => {
    const plan = planRecordedFill({
      armed: true,
      target: 'id="query"',
      value: 'shoes',
      secrets: SECRETS,
    });
    expect(plan).toEqual({ value: 'shoes', flags: [], publishable: true });
  });

  it('changes nothing when no recording is armed', () => {
    const plan = planRecordedFill({
      armed: false,
      target: 'id="password"',
      value: 'hunter2',
      secrets: SECRETS,
    });
    expect(plan.flags).toEqual([]);
    expect(plan.publishable).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The 0.20.5 divergence report.                                       *
 * ------------------------------------------------------------------ */

/**
 * A full 0.20.5 divergence envelope. Field names are read off the shipped
 * `agent-device@0.20.5` `dist/src/session.js` report builders (`divergence:
 * {version:1,kind:…}`) and its `resume` validator, not invented.
 */
const DIVERGENCE_ENVELOPE = {
  success: false,
  error: {
    code: 'REPLAY_DIVERGENCE',
    message: 'Replay failed at step 2 (wait id="validity-root:a1b2c3"): wait timed out',
    details: {
      replayPath: '/runs/r1/replay.ad',
      step: 2,
      action: 'wait',
      positionals: ['id="validity-root:a1b2c3"'],
      artifactPaths: [],
      divergence: {
        version: 1,
        kind: 'selector-miss',
        step: { index: 2, source: { path: 'replay.ad', line: 3 } },
        action: 'wait id="validity-root:a1b2c3"',
        cause: {
          code: 'COMMAND_FAILED',
          message: 'wait timed out for selector: id="validity-root:a1b2c3"',
          hint: 'Take a new snapshot before targeting an element.',
        },
        screen: {
          state: 'available',
          refsGeneration: 4,
          refs: [
            { ref: '@e3', role: 'Other', label: 'validity-root:d4e5f6' },
            { ref: '@e12', role: 'button', label: 'Sign in' },
          ],
        },
        suggestions: [
          {
            selector: 'id="validity-root:d4e5f6"',
            basis: 'id',
            ref: '@e3',
            role: 'Other',
            label: 'validity-root:d4e5f6',
          },
          { selector: 'label="Sign in"', basis: 'role-label', ref: '@e12', role: 'button' },
        ],
        suggestionCount: 7,
        resume: { allowed: true, from: 2, planDigest: 'b3d1c0ffee' },
        repairHint: 'record-and-heal',
      },
    },
  },
};

describe('parseDivergenceReport', () => {
  it('normalizes the whole 0.20.5 report', () => {
    const report = parseDivergenceReport(DIVERGENCE_ENVELOPE.error.details)!;
    expect(report.version).toBe(1);
    expect(report.kind).toBe('selector-miss');
    expect(report.step).toBe(2);
    expect(report.source).toEqual({ path: 'replay.ad', line: 3 });
    expect(report.cause?.code).toBe('COMMAND_FAILED');
    expect(report.suggestions[0]).toEqual({
      selector: 'id="validity-root:d4e5f6"',
      basis: 'id',
      ref: '@e3',
      role: 'Other',
      label: 'validity-root:d4e5f6',
    });
    expect(report.suggestionCount).toBe(7);
    expect(report.resume).toEqual({ allowed: true, from: 2, planDigest: 'b3d1c0ffee' });
    expect(report.repairHint).toBe('record-and-heal');
    expect(report.screen?.state).toBe('available');
    expect(report.screen?.refs).toHaveLength(2);
  });

  it('answers undefined for an envelope with no report, rather than an empty one', () => {
    expect(parseDivergenceReport({ step: 2, action: 'wait' })).toBeUndefined();
    expect(parseDivergenceReport(undefined)).toBeUndefined();
  });

  it('drops a HALF resume — --from without --plan-digest is rejected upstream', () => {
    const report = parseDivergenceReport({ divergence: { resume: { allowed: true, from: 2 } } })!;
    expect(report.resume).toBeUndefined();
  });

  it('drops an unknown repairHint rather than guessing one', () => {
    const report = parseDivergenceReport({ divergence: { repairHint: 'teleport' } })!;
    expect(report.repairHint).toBeUndefined();
  });

  it('caps suggestions and screen refs, and says when it truncated', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ selector: `id="e${i}"`, basis: 'id' }));
    const refs = Array.from({ length: 30 }, (_, i) => ({ ref: `@e${i}`, role: 'button' }));
    const report = parseDivergenceReport({
      divergence: { suggestions: many, screen: { state: 'available', refs } },
    })!;
    expect(report.suggestions).toHaveLength(5);
    expect(report.screen?.refs).toHaveLength(12);
    expect(report.screen?.truncated).toBe(true);
  });

  it('redacts device text so a login divergence cannot write a password to disk', () => {
    const report = parseDivergenceReport(
      {
        divergence: {
          cause: { message: 'expected field to contain hunter2' },
          suggestions: [{ selector: 'label="hunter2"', basis: 'label' }],
        },
      },
      (s) => redactSecrets(s, [{ name: 'PW', env: 'PW', value: 'hunter2' }]),
    )!;
    expect(report.cause?.message).toBe('expected field to contain ${PW}');
    expect(report.suggestions[0]!.selector).toBe('label="${PW}"');
  });

  it('records an unreadable screen as unavailable, never as "no problems found"', () => {
    const report = parseDivergenceReport({
      divergence: {
        screen: { state: 'unavailable', reason: 'ref-publication-stale', hint: 'Take a snapshot.' },
      },
    })!;
    expect(report.screen).toEqual({
      state: 'unavailable',
      reason: 'ref-publication-stale',
      hint: 'Take a snapshot.',
    });
  });
});

describe('classifyAgentDeviceReplay — with a divergence report', () => {
  it('carries the report and prefers its step index', () => {
    const res = classifyAgentDeviceReplay({
      code: 1,
      stdout: JSON.stringify(DIVERGENCE_ENVELOPE),
      stderr: '',
    });
    expect(res.outcome).toBe('regressed');
    expect(res.step).toBe(2);
    expect(res.divergence?.repairHint).toBe('record-and-heal');
    expect(res.divergence?.suggestions).toHaveLength(2);
  });

  it('redacts a supplied secret out of the notice', () => {
    const res = classifyAgentDeviceReplay(
      {
        code: 1,
        stdout: JSON.stringify({
          success: false,
          error: { code: 'REPLAY_DIVERGENCE', message: 'field held hunter2', details: {} },
        }),
        stderr: '',
      },
      [{ name: 'PW', env: 'PW', value: 'hunter2' }],
    );
    expect(res.notice).toContain('${PW}');
    expect(res.notice).not.toContain('hunter2');
  });

  it('still classifies a 0.20.3-shaped divergence (no report) exactly as before', () => {
    const res = classifyAgentDeviceReplay({
      code: 1,
      stdout: JSON.stringify({
        success: false,
        error: { code: 'REPLAY_DIVERGENCE', message: 'nope', details: { step: 2, action: 'wait' } },
      }),
      stderr: '',
    });
    expect(res.outcome).toBe('regressed');
    expect(res.step).toBe(2);
    expect(res.divergence).toBeUndefined();
  });
});

describe('divergence rendering', () => {
  const report = parseDivergenceReport(DIVERGENCE_ENVELOPE.error.details)!;

  it('names the step, the cause and the ranked suggestions', () => {
    const lines = divergenceEvidenceLines(report).join('\n');
    expect(lines).toContain('diverged at step 2');
    expect(lines).toContain('selector-miss');
    expect(lines).toContain('wait timed out for selector');
    expect(lines).toContain('top 2 of 7');
    expect(lines).toContain('1. id="validity-root:d4e5f6"');
    expect(lines).toContain('basis id');
  });

  it('says the screen was unreadable instead of implying there was nothing to suggest', () => {
    const blind = parseDivergenceReport({
      divergence: { screen: { state: 'unavailable', reason: 'ax-unavailable' }, suggestions: [] },
    })!;
    expect(divergenceEvidenceLines(blind).join('\n')).toContain('the screen could not be read');
  });

  it('renders the resume handle exactly as it must be typed', () => {
    expect(resumeCommandLine(report, 'replay.ad')).toBe(
      'agent-device replay replay.ad --from 2 --plan-digest b3d1c0ffee',
    );
  });

  it('offers no resume line when upstream refused the resume', () => {
    const refused = parseDivergenceReport({
      divergence: {
        resume: {
          allowed: false,
          from: 3,
          planDigest: 'abc',
          reason: 'skipped range is control flow',
        },
      },
    })!;
    expect(resumeCommandLine(refused, 'replay.ad')).toBeUndefined();
    expect(repairTransactionLines(refused, 'replay.ad').join('\n')).toContain(
      'skipped range is control flow',
    );
  });

  it('DOCUMENTS the repair transaction and never runs it', () => {
    const lines = repairTransactionLines(report, 'replay.ad').join('\n');
    expect(lines).toContain('--save-script');
    expect(lines).toContain('--from 3 --plan-digest b3d1c0ffee');
    expect(lines).toContain('DIFF the healed script');
    expect(lines).toContain('evidence only after a fresh `validity verify`');
  });

  it('passes through the caution and manual hints', () => {
    const caution = parseDivergenceReport({ divergence: { repairHint: 'caution' } })!;
    expect(repairTransactionLines(caution, 'x.ad').join('\n')).toContain('repeat the mistake');
    const manual = parseDivergenceReport({ divergence: { repairHint: 'manual' } })!;
    expect(repairTransactionLines(manual, 'x.ad').join('\n')).toContain('no safe automated repair');
  });

  it('says nothing at all when there is no hint and no resume', () => {
    const bare = parseDivergenceReport({ divergence: { kind: 'action-failure' } })!;
    expect(repairTransactionLines(bare, 'x.ad')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Executing a replay through an injected runner.                      *
 * ------------------------------------------------------------------ */

// runRecordingReplay's argv/env tests moved with the code: the executor was
// consolidated into AgentDeviceDriver.replayRecording (agent-device-driver
// .test.ts), and the argv builder it shared is covered by the
// replayRecordingArgs tests above.
