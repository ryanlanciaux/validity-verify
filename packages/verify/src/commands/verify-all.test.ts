/**
 * Unit tests for the PURE pieces of `validity verify --all`. We never boot the
 * Vite sandbox here (it fails on node 23 locally and would make these tests
 * slow + flaky) — every helper under test takes synthetic specs/verdicts and
 * returns strings or structures we can assert byte-for-byte.
 *
 * The `verify --all` native-path block additionally exercises the impure
 * orchestrator and the native verify engine, with config load and the
 * emulator lifecycle stubbed so nothing boots a real device.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@validity.ai/verify-spec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@validity.ai/verify-spec')>()),
  loadConfig: vi.fn(async () => ({
    config: {
      renderMode: 'native',
      framework: 'expo-native',
      wrapper: './.validity/wrapper.tsx',
    } satisfies ValidityConfig,
  })),
}));
// Stub the emulator lifecycle (partial mock: the real captureNative etc. stay
// available for the engine's default deps, which the unit tests override).
vi.mock('@validity.ai/verify-native', async () => {
  const actual = await vi.importActual<typeof import('@validity.ai/verify-native')>(
    '@validity.ai/verify-native',
  );
  return {
    ...actual,
    bootAndroidEmulator: vi.fn(async () => ({ deviceId: 'emulator-5554', port: 5554, child: {} })),
    installCompanion: vi.fn(async () => undefined),
    teardownEmulator: vi.fn(async () => undefined),
    closeEstablishedNativeSessions: vi.fn(async () => ({ closed: 0, failed: 0 })),
    // The companion's presence on the pinned device is gated by these two on
    // BOTH platforms — it decides whether an attached-device run installs at
    // all. Stubbed ready-by-default so the orchestrator tests exercise routing,
    // not real device probing; tests that care flip the companion-app step.
    companionBuildIdentity: vi.fn(() => ({
      scheme: 'validity-test',
      bundleId: 'ai.validity.playground',
      buildHash: 'hash-test',
      buildMarkerPath: '/tmp/validity-build-marker',
      buildInputs: {},
    })),
    checkNativeReadiness: vi.fn(async () => ({
      ready: true,
      steps: [{ id: 'companion-app', label: 'Validity companion app', status: 'ok' }],
    })),
  };
});
// Stub the native engine so the runVerifyAll integration tests don't try to
// prepare a real companion app. The engine has its own unit tests below.
vi.mock('../native-verify-engine.js', () => ({
  verifyOneSpecNative: vi.fn(),
}));
// Stub the WEB verify engine so the probation integration tests below (which
// drive runVerifyAll on a `runtime: 'web'` spec) never boot the Vite sandbox.
// No existing test in this file invokes the web engine through runVerifyAll.
vi.mock('../verify-engine.js', () => ({ verifyOneSpec: vi.fn() }));
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type {
  CommandExec,
  CriterionVerdict,
  RunMeta,
  Scorecard,
  Spec,
  ValidityConfig,
} from '@validity.ai/verify-spec';
import {
  CommandCheckRunner,
  computeValidityScore,
  readSpec,
  reconcileScorecard,
  runDir,
  writeSpec,
  acquireVerifyLock,
} from '@validity.ai/verify-spec';
import { loadConfig } from '@validity.ai/verify-spec';
import {
  bootAndroidEmulator,
  checkNativeReadiness,
  closeEstablishedNativeSessions,
  installCompanion,
  teardownEmulator,
  type CommandRunner,
} from '@validity.ai/verify-native';
import {
  aggregateVerdicts,
  armPlanSentinel,
  checkCoverageFloor,
  computeEnvBlocked,
  EXIT_UNFINISHED,
  formatDiagnosisSuffix,
  formatMarkdown,
  formatTable,
  hasHardFailure,
  readPrContext,
  runVerifyAll,
  selectSpecsForRun,
  toJUnit,
  toSpecObservations,
  unfinishedRunMessage,
  type SpecResult,
} from './verify-all.js';
import { verifyOneSpec } from '../verify-engine.js';
import { verifyOneSpecNative } from '../native-verify-engine.js';

function makeSpec(over: Partial<Spec> = {}): Spec {
  return {
    id: 'spec-aaaa',
    version: 1,
    status: 'frozen',
    source: { prompt: 'do the thing', createdBy: 'agent' },
    runtime: 'web',
    criteria: [
      { id: 'AC-1', text: 'hard one', tier: 'hard', checks: [{ click: { role: 'button' } }] },
      { id: 'AC-2', text: 'soft one', tier: 'soft' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('selectSpecsForRun', () => {
  it('explicit mode selects requested ids and reports missing ones', () => {
    const specs = [makeSpec({ id: 'spec-a' }), makeSpec({ id: 'spec-b' })];
    const res = selectSpecsForRun({
      specs,
      mode: 'explicit',
      explicitIds: ['spec-a', 'spec-missing'],
    });
    expect(res.selected.map((s) => s.id)).toEqual(['spec-a']);
    expect(res.skipped).toEqual([
      { id: 'spec-missing', reason: 'not found under .validity/specs/' },
    ]);
  });

  it('all mode selects only frozen specs and explains skipped drafts', () => {
    const specs = [
      makeSpec({ id: 'spec-frozen', status: 'frozen' }),
      makeSpec({ id: 'spec-draft', status: 'draft' }),
    ];
    const res = selectSpecsForRun({ specs, mode: 'all' });
    expect(res.selected.map((s) => s.id)).toEqual(['spec-frozen']);
    expect(res.skipped).toContainEqual({ id: 'spec-draft', reason: 'status=draft (not frozen)' });
  });

  it('changed mode maps changed files to frozen specs by target basename', () => {
    const specs = [
      makeSpec({ id: 'spec-login', targets: { components: ['LoginForm'] } }),
      makeSpec({ id: 'spec-nav', targets: { components: ['NavBar'] } }),
    ];
    const res = selectSpecsForRun({
      specs,
      mode: 'changed',
      changedFiles: ['src/components/LoginForm.tsx'],
    });
    expect(res.selected.map((s) => s.id)).toEqual(['spec-login']);
    expect(res.skipped).toContainEqual({ id: 'spec-nav', reason: 'targets unchanged' });
  });

  it('explicit mode with an empty id list selects nothing (present-but-empty !== full sweep)', () => {
    const specs = [
      makeSpec({ id: 'spec-a', status: 'frozen' }),
      makeSpec({ id: 'spec-b', status: 'frozen' }),
    ];
    const res = selectSpecsForRun({ specs, mode: 'explicit', explicitIds: [] });
    // Crucially NOT the full frozen sweep — a present-but-empty selection runs
    // nothing rather than silently expanding to every frozen spec.
    expect(res.selected).toEqual([]);
    expect(res.selected.length).not.toBe(specs.length);
  });

  it('changed mode reports specs with no targets as unmappable', () => {
    const specs = [makeSpec({ id: 'spec-notargets', targets: undefined })];
    const res = selectSpecsForRun({ specs, mode: 'changed', changedFiles: ['src/Anything.tsx'] });
    expect(res.selected).toEqual([]);
    expect(res.skipped).toContainEqual({
      id: 'spec-notargets',
      reason: 'no targets — cannot map to changed files',
    });
  });
});

describe('aggregateVerdicts', () => {
  it('marks soft criteria as skipped (never pass) and threads hard verdicts', () => {
    const spec = makeSpec();
    const mechanical: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'pass', detail: 'clicked' },
    ];
    const result = aggregateVerdicts(spec, mechanical);
    expect(result).toEqual([
      { id: 'AC-1', tier: 'hard', status: 'pass', detail: 'clicked' },
      {
        id: 'AC-2',
        tier: 'soft',
        status: 'skipped',
        detail: 'soft criterion — needs agent verify (no LLM in the CLI)',
      },
    ]);
  });

  it('marks a hard criterion with no mechanical verdict as unverifiable', () => {
    const spec = makeSpec({
      criteria: [{ id: 'AC-1', text: 'h', tier: 'hard', checks: [{ click: { role: 'button' } }] }],
    });
    const result = aggregateVerdicts(spec, []);
    expect(result[0]!.status).toBe('unverifiable');
  });
});

describe('hasHardFailure', () => {
  it('is true when a hard criterion fails', () => {
    const results: SpecResult[] = [
      { specId: 'spec-a', version: 1, criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail' }] },
    ];
    expect(hasHardFailure(results)).toBe(true);
  });

  it('is false when only soft criteria are skipped', () => {
    const results: SpecResult[] = [
      { specId: 'spec-a', version: 1, criteria: [{ id: 'AC-2', tier: 'soft', status: 'skipped' }] },
    ];
    expect(hasHardFailure(results)).toBe(false);
  });

  it('is true when a spec failed to render', () => {
    const results: SpecResult[] = [{ specId: 'spec-a', version: 1, error: 'boom', criteria: [] }];
    expect(hasHardFailure(results)).toBe(true);
  });

  // Regression pin (A5): command criteria are property tier, so a failing
  // typecheck/test command exits the build non-zero with no special-casing.
  it('is true when a property-tier command criterion fails', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          {
            id: 'repo-typecheck',
            tier: 'property',
            status: 'fail',
            detail: `command 'typecheck' ("tsc --noEmit") exited 2, expected 0`,
          },
        ],
      },
    ];
    expect(hasHardFailure(results)).toBe(true);
  });
});

describe('computeEnvBlocked', () => {
  it('returns undefined when no spec errored', () => {
    const results: SpecResult[] = [
      { specId: 'spec-a', version: 1, criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }] },
    ];
    expect(computeEnvBlocked(results)).toBeUndefined();
  });

  it('counts specs with .error and carries the error string', () => {
    const results: SpecResult[] = [
      { specId: 'spec-a', version: 1, error: 'Vite sandbox failed: boom', criteria: [] },
      { specId: 'spec-b', version: 1, criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }] },
    ];
    expect(computeEnvBlocked(results)).toEqual({
      count: 1,
      errors: ['Vite sandbox failed: boom'],
    });
  });

  it('dedupes identical error strings across multiple errored specs', () => {
    const results: SpecResult[] = [
      { specId: 'spec-a', version: 1, error: 'ECONNREFUSED', criteria: [] },
      { specId: 'spec-b', version: 1, error: 'ECONNREFUSED', criteria: [] },
      { specId: 'spec-c', version: 1, error: 'a different failure', criteria: [] },
    ];
    const eb = computeEnvBlocked(results)!;
    expect(eb.count).toBe(3); // count = every errored spec, even sharing a cause
    expect(eb.errors).toEqual(['ECONNREFUSED', 'a different failure']); // errors = deduped
  });

  // ── Per-error attribution (handoff-2026-07-28) ──
  //
  // "No mechanical verdict produced" was the output for five different causes.
  // `causes` joins each deduped error string to the named cause + fix, so the
  // PR comment can say WHICH one happened. Every assertion below also pins the
  // additive posture: absent, never empty, when nothing was diagnosed.

  it('omits `causes` entirely — never an empty array — when nothing was diagnosed', () => {
    const results: SpecResult[] = [
      { specId: 'spec-a', version: 1, error: 'Vite sandbox failed: boom', criteria: [] },
    ];
    const eb = computeEnvBlocked(results)!;
    expect(eb).not.toHaveProperty('causes');
    // Byte-identical to the pre-feature shape, so post-check.cjs's absence
    // guard covers an old CLI and an undiagnosed modern run with one path.
    expect(eb).toEqual({ count: 1, errors: ['Vite sandbox failed: boom'] });
  });

  it('joins each deduped error to its cause + fix command', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        error: 'native verify: render not confirmed',
        diagnosis: {
          cause: 'phantom-device-claim',
          symptom: 'open says the device is in use; session list reports none.',
          detail: 'A claim outlived its session.',
          fixCommand: 'kill $(cat daemon.pid)\nrm -rf "$HOME/.agent-device/sessions"',
          confidence: 'confirmed',
        },
        criteria: [],
      },
    ];
    expect(computeEnvBlocked(results)!.causes).toEqual([
      {
        error: 'native verify: render not confirmed',
        cause: 'phantom-device-claim',
        // The FULL recipe here — clipping to one line is the table's job.
        fixCommand: 'kill $(cat daemon.pid)\nrm -rf "$HOME/.agent-device/sessions"',
      },
    ]);
  });

  it('keeps ONE entry per deduped error, and skips undiagnosed specs', () => {
    const diagnosis = {
      cause: 'device-not-ready' as const,
      symptom: 'No booted simulator.',
      detail: 'Nowhere for the deep link to land.',
      confidence: 'confirmed' as const,
    };
    const results: SpecResult[] = [
      { specId: 'spec-a', version: 1, error: 'no device', diagnosis, criteria: [] },
      { specId: 'spec-b', version: 1, error: 'no device', diagnosis, criteria: [] },
      { specId: 'spec-c', version: 1, error: 'something else entirely', criteria: [] },
    ];
    const eb = computeEnvBlocked(results)!;
    expect(eb.count).toBe(3);
    expect(eb.errors).toEqual(['no device', 'something else entirely']);
    // One row for the shared cause; the undiagnosed error contributes nothing.
    expect(eb.causes).toEqual([{ error: 'no device', cause: 'device-not-ready' }]);
    expect(eb.causes![0]).not.toHaveProperty('fixCommand');
  });
});

describe('formatDiagnosisSuffix', () => {
  it('is the empty string with no diagnosis, so undiagnosed output is unchanged', () => {
    expect(formatDiagnosisSuffix(undefined)).toBe('');
  });

  it('names the cause and clips a multi-line recipe to its FIRST command', () => {
    const suffix = formatDiagnosisSuffix({
      cause: 'session-decay',
      symptom: 'p95 2934ms over 209 captures.',
      detail: 'The session degraded with age.',
      fixCommand: 'kill $(cat daemon.pid)\nadb emu kill\nemulator -avd Medium_Phone_API_35',
      confidence: 'suspected',
    });
    expect(suffix).toBe('  cause: session-decay — fix: kill $(cat daemon.pid)');
    // A table row is not where a four-line reset gets run.
    expect(suffix).not.toContain('adb emu kill');
  });

  it('names the cause alone when there is no one-command fix', () => {
    expect(
      formatDiagnosisSuffix({
        cause: 'unknown',
        symptom: 'No probe matched.',
        detail: 'Verdicts are withheld rather than guessed.',
        confidence: 'suspected',
      }),
    ).toBe('  cause: unknown');
  });
});

describe('ERROR-line attribution across the three output formats', () => {
  const diagnosed: SpecResult[] = [
    {
      specId: 'spec-a',
      version: 1,
      error: 'native verify: render not confirmed (status=unconfirmed)',
      diagnosis: {
        cause: 'foreign-metro',
        symptom: 'Port 8082 is served by a Metro Validity did not start.',
        detail: 'A hand-started `expo start` is serving the companion port.',
        fixCommand: 'kill 4242\nvalidity browse --native',
        confidence: 'confirmed',
      },
      criteria: [{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }],
    },
  ];
  const undiagnosed: SpecResult[] = [{ specId: 'spec-a', version: 1, error: 'boom', criteria: [] }];

  it('formatTable appends the cause + first-line fix under the ERROR row', () => {
    const table = formatTable(diagnosed);
    expect(table).toContain('native verify: render not confirmed');
    expect(table).toContain('cause: foreign-metro');
    expect(table).toContain('fix: kill 4242');
  });

  it('formatTable prints no attribution line at all when nothing was diagnosed', () => {
    expect(formatTable(undiagnosed)).not.toContain('cause:');
  });

  it('formatMarkdown keeps the attribution inside the blockquote', () => {
    const md = formatMarkdown(diagnosed);
    expect(md).toContain('> ⛔ native verify: render not confirmed (status=unconfirmed)');
    expect(md).toContain('> cause: foreign-metro — fix: kill 4242');
  });

  it('formatMarkdown flattens a multi-line error so it cannot break out of the blockquote', () => {
    const md = formatMarkdown([
      {
        specId: 'spec-a',
        version: 1,
        error: 'native verify: render not confirmed\n  likely cause (confirmed): a thing',
        criteria: [],
      },
    ]);
    expect(md).toContain('> ⛔ native verify: render not confirmed   likely cause');
    // No bare line: every error line stays quoted.
    expect(md).not.toMatch(/\n {2}likely cause/);
  });

  it('toJUnit folds the attribution into the synthetic render failure message', () => {
    const xml = toJUnit(diagnosed);
    expect(xml).toContain('name="render"');
    expect(xml).toContain('cause: foreign-metro');
    expect(xml).toContain('fix: kill 4242');
  });

  it('toJUnit leaves an undiagnosed failure message byte-identical', () => {
    expect(toJUnit(undiagnosed)).toContain('<failure message="boom">');
  });

  it('CANNOT change the gate: attribution never touches hasHardFailure', () => {
    expect(hasHardFailure(diagnosed)).toBe(true);
    expect(hasHardFailure(undiagnosed)).toBe(true);
  });
});

// Issue #15: a verify aborted mid-plan (dep-scan abort strands the capture,
// the event loop drains, Node exits 0 from inside an await) must NOT read as
// green. The sentinel converts a code-0 exit while the plan is in flight into
// a loud UNFINISHED + EXIT_UNFINISHED.
describe('armPlanSentinel', () => {
  const savedExitCode = process.exitCode;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    process.exitCode = savedExitCode;
  });

  it('registers an exit listener while armed and removes it on disarm', () => {
    const before = process.listeners('exit').length;
    const sentinel = armPlanSentinel(13, () => 1);
    expect(process.listeners('exit')).toContain(sentinel.onExit);
    sentinel.disarm();
    expect(process.listeners('exit')).not.toContain(sentinel.onExit);
    expect(process.listeners('exit').length).toBe(before);
  });

  it('on a code-0 exit mid-plan: prints UNFINISHED with executed/planned and forces EXIT_UNFINISHED', () => {
    const sentinel = armPlanSentinel(13, () => 1);
    try {
      sentinel.onExit(0);
      const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('UNFINISHED');
      expect(written).toContain('1 of 13 planned runs');
      expect(process.exitCode).toBe(EXIT_UNFINISHED);
    } finally {
      sentinel.disarm();
    }
  });

  it('leaves a deliberate non-zero exit untouched (the gate already told the truth)', () => {
    const sentinel = armPlanSentinel(13, () => 13);
    try {
      sentinel.onExit(1);
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(savedExitCode);
    } finally {
      sentinel.disarm();
    }
  });

  it('unfinishedRunMessage names the shortfall and the distinct exit code', () => {
    const msg = unfinishedRunMessage(1, 13);
    expect(msg).toContain('1 of 13');
    expect(msg).toContain(`exit ${EXIT_UNFINISHED}`);
    expect(EXIT_UNFINISHED).not.toBe(0);
    expect(EXIT_UNFINISHED).not.toBe(1);
    expect(EXIT_UNFINISHED).not.toBe(2);
  });
});

describe('toJUnit', () => {
  it('emits failure for hard fails and skipped for soft', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 2,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'no button' },
          { id: 'AC-2', tier: 'soft', status: 'skipped', detail: 'needs agent' },
        ],
      },
    ];
    const xml = toJUnit(results);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuite name="spec-a@v2" tests="2" failures="1" skipped="1">');
    expect(xml).toContain('<failure message="no button">');
    expect(xml).toContain('<skipped message="needs agent">');
  });

  it('escapes XML-significant characters', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [{ id: 'AC-1', tier: 'hard', status: 'fail', detail: 'a < b & "c"' }],
      },
    ];
    const xml = toJUnit(results);
    expect(xml).toContain('a &lt; b &amp; &quot;c&quot;');
  });

  it('renders a render-error as a failing synthetic testcase', () => {
    const results: SpecResult[] = [{ specId: 'spec-a', version: 1, error: 'boom', criteria: [] }];
    const xml = toJUnit(results);
    expect(xml).toContain('name="render"');
    expect(xml).toContain('<failure message="boom">');
  });

  it('keeps a MODEL-JUDGED soft pass/fail out of the machine gate (never reds/greens)', () => {
    // Simulates the post-`--judge` state: soft criteria now carry real pass/fail
    // statuses, but the CI interchange must stay hard/property-only — a model's
    // opinion can neither fail the build nor mark a passing testcase.
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'soft', status: 'fail', detail: 'model-judged (anthropic/x)' },
          { id: 'AC-3', tier: 'soft', status: 'pass', detail: 'model-judged (anthropic/x)' },
        ],
      },
    ];
    const xml = toJUnit(results);
    // Zero failures despite a judged soft fail; both soft criteria are skipped.
    expect(xml).toContain('<testsuite name="spec-a@v1" tests="3" failures="0" skipped="2">');
    expect(xml).toContain('<skipped message="model-judged (anthropic/x)">');
    // A judged soft fail must NOT become a junit <failure>.
    expect(xml).not.toContain('<failure');
  });
});

describe('formatTable', () => {
  it('includes a summary line with all four counts', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'soft', status: 'skipped' },
        ],
      },
    ];
    const table = formatTable(results);
    expect(table).toContain('spec-a@v1');
    expect(table).toMatch(/1 pass/);
    expect(table).toMatch(/1 skipped/);
  });
});

describe('formatMarkdown (GitHub job summary)', () => {
  it('renders a color-free markdown table with per-criterion badges + a count line', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 2,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass', detail: '2 pass' },
          { id: 'AC-2', tier: 'hard', status: 'fail', detail: 'POST | 500' },
          { id: 'AC-3', tier: 'soft', status: 'skipped' },
        ],
      },
    ];
    const md = formatMarkdown(results);
    expect(md).toContain('## Validity');
    expect(md).toContain('`spec-a@v2`');
    expect(md).toContain('| Criterion | Tier | Result | Detail |');
    expect(md).toContain('AC-1');
    expect(md).toContain('✅ pass');
    expect(md).toContain('❌ fail');
    expect(md).toContain('⏭️ skipped');
    // Pipes inside a detail are escaped so they don't break the table.
    expect(md).toContain('POST \\| 500');
    // Plain markdown — no ANSI color escapes (picocolors) leaking in.
    // eslint-disable-next-line no-control-regex
    expect(md).not.toMatch(/\u001b\[/);
    expect(md).toMatch(/1 pass · 1 fail · 0 unverifiable · 1 skipped/);
  });
});

describe('checkCoverageFloor', () => {
  const makeConfig = (floor: number | undefined): ValidityConfig => ({
    renderMode: 'web',
    framework: 'vite',
    wrapper: './.validity/wrapper.tsx',
    coverageFloorPercent: floor,
  });

  it('returns pass:true when floor is undefined', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(undefined));
    expect(check.pass).toBe(true);
    expect(check.reason).toBeUndefined();
  });

  it('returns pass:true when coverage >= floor', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'hard', status: 'fail' },
        ],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(100));
    expect(check.pass).toBe(true);
  });

  it('returns pass:false with reason when coverage < floor', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'hard', status: 'unverifiable' },
        ],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(80));
    expect(check.pass).toBe(false);
    expect(check.reason).toContain('Coverage 50%');
    expect(check.reason).toContain('< floor 80%');
    expect(check.reason).toContain('1/2');
  });

  it('passes at floor 0 even when all are unverifiable', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(0));
    expect(check.pass).toBe(true);
  });

  it('rejects partial coverage at floor 100', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'hard', status: 'unverifiable' },
        ],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(100));
    expect(check.pass).toBe(false);
  });

  // Regression pin (A5): an UNCONFIGURED command criterion resolves
  // `unverifiable` (property tier), so it drags the coverage ratio — the
  // incentive to add `commands.<name>` to .validity/config.ts, never a pass.
  it('an unconfigured command criterion counts against the floor', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          {
            id: 'repo-typecheck',
            tier: 'property',
            status: 'unverifiable',
            detail: "AC unverifiable: command 'typecheck' is not configured",
          },
        ],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(80));
    expect(check.pass).toBe(false);
    expect(check.reason).toContain('Coverage 50%');
  });

  it('ignores soft criteria in coverage calculation', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'soft', status: 'skipped' },
        ],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(100));
    expect(check.pass).toBe(true);
  });

  it('returns pass:true when no hard/property criteria exist', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [{ id: 'AC-1', tier: 'soft', status: 'skipped' }],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(80));
    expect(check.pass).toBe(true);
  });

  it('returns pass:true on an empty result set', () => {
    const check = checkCoverageFloor([], makeConfig(80));
    expect(check.pass).toBe(true);
  });

  it('skips specs with render errors when aggregating', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        error: 'render failed',
        criteria: [],
      },
      {
        specId: 'spec-b',
        version: 1,
        criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(100));
    expect(check.pass).toBe(true);
  });

  it('aggregates coverage across multiple specs', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
      },
      {
        specId: 'spec-b',
        version: 1,
        criteria: [
          { id: 'AC-2', tier: 'hard', status: 'unverifiable' },
          { id: 'AC-3', tier: 'hard', status: 'unverifiable' },
        ],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(50));
    expect(check.pass).toBe(false);
    expect(check.reason).toContain('33%');
  });

  // Attribution context (never softens the gate — `pass` stays false either
  // way): when env-blocked specs carry enough hard/property criteria that
  // never ran to plausibly explain the shortfall, say so in the message.
  it('has no env-blocked mention when nothing errored', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'hard', status: 'unverifiable' },
        ],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(80));
    expect(check.pass).toBe(false);
    expect(check.reason).not.toContain('environment-blocked');
  });

  it('names env-blocked specs as a plausible full explanation when their criteria cover the shortfall', () => {
    const results: SpecResult[] = [
      // Excluded from the coverage calc entirely (spec.error), but its 3
      // hard/property criteria never ran — that's the attribution signal.
      {
        specId: 'spec-broken',
        version: 1,
        error: 'Vite sandbox failed: ECONNREFUSED',
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'unverifiable' },
          { id: 'AC-2', tier: 'hard', status: 'unverifiable' },
          { id: 'AC-3', tier: 'property', status: 'unverifiable' },
        ],
      },
      // 1/2 = 50% < floor 80%; shortfall = ceil(0.8*2) - 1 = 1 criterion.
      {
        specId: 'spec-b',
        version: 1,
        criteria: [
          { id: 'AC-4', tier: 'hard', status: 'pass' },
          { id: 'AC-5', tier: 'hard', status: 'unverifiable' },
        ],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(80));
    expect(check.pass).toBe(false);
    expect(check.reason).toContain('Coverage 50%');
    expect(check.reason).toContain('1 environment-blocked spec (3 criteria never ran)');
    expect(check.reason).toContain('may fully explain this shortfall');
  });

  it('notes env-blocked specs without claiming they explain the shortfall when their criteria fall short', () => {
    const results: SpecResult[] = [
      // Only 1 criterion never ran here — not enough to cover the shortfall below.
      {
        specId: 'spec-broken',
        version: 1,
        error: 'boom',
        criteria: [{ id: 'AC-1', tier: 'hard', status: 'unverifiable' }],
      },
      // 1/4 = 25% < floor 90%; shortfall = ceil(0.9*4) - 1 = 3 criteria.
      {
        specId: 'spec-b',
        version: 1,
        criteria: [
          { id: 'AC-2', tier: 'hard', status: 'pass' },
          { id: 'AC-3', tier: 'hard', status: 'unverifiable' },
          { id: 'AC-4', tier: 'hard', status: 'unverifiable' },
          { id: 'AC-5', tier: 'hard', status: 'unverifiable' },
        ],
      },
    ];
    const check = checkCoverageFloor(results, makeConfig(90));
    expect(check.pass).toBe(false);
    expect(check.reason).toContain(
      '1 environment-blocked spec also produced no verdicts (1 criterion)',
    );
    expect(check.reason).toContain('though not enough alone to explain this shortfall');
    expect(check.reason).not.toContain('may fully explain');
  });
});

describe('formatTable with coverage', () => {
  it('includes coverage ratio in summary', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'hard', status: 'unverifiable' },
        ],
      },
    ];
    const table = formatTable(results);
    expect(table).toContain('Coverage: 1/2 (50%)');
  });

  it('omits coverage line when no hard/property criteria', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [{ id: 'AC-1', tier: 'soft', status: 'skipped' }],
      },
    ];
    const table = formatTable(results);
    expect(table).not.toContain('Coverage:');
  });
});

describe('formatMarkdown with coverage', () => {
  it('includes coverage ratio in summary', () => {
    const results: SpecResult[] = [
      {
        specId: 'spec-a',
        version: 1,
        criteria: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'hard', status: 'fail' },
        ],
      },
    ];
    const md = formatMarkdown(results);
    expect(md).toContain('Coverage: 2/2 (100%)');
  });
});

describe('readPrContext', () => {
  const saved = {
    GITHUB_HEAD_REF: process.env.GITHUB_HEAD_REF,
    GITHUB_REF_NAME: process.env.GITHUB_REF_NAME,
    GITHUB_REF: process.env.GITHUB_REF,
    GITHUB_BASE_REF: process.env.GITHUB_BASE_REF,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('reads branch, PR number, and the base ref (B3) from a pull_request env', () => {
    process.env.GITHUB_HEAD_REF = 'feature/x';
    process.env.GITHUB_REF = 'refs/pull/42/merge';
    process.env.GITHUB_BASE_REF = 'main';
    expect(readPrContext()).toEqual({ branch: 'feature/x', prNumber: 42, baseRef: 'main' });
  });

  it('baseRef is null outside a PR (GITHUB_BASE_REF unset or empty)', () => {
    delete process.env.GITHUB_HEAD_REF;
    delete process.env.GITHUB_REF_NAME;
    delete process.env.GITHUB_REF;
    process.env.GITHUB_BASE_REF = '';
    expect(readPrContext()).toEqual({ branch: null, prNumber: null, baseRef: null });
  });
});

/* ------------------------------------------------------------------ *
 * Native CI verify path.                                              *
 * ------------------------------------------------------------------ */

/** A frozen native spec, written to a tmp project for the orchestrator tests. */
function makeNativeSpec(over: Partial<Spec> = {}): Spec {
  return makeSpec({
    id: 'spec-native',
    runtime: 'native',
    status: 'frozen',
    hash: 'deadbeef',
    targets: { components: ['Button'] },
    ...over,
  });
}

describe('runVerifyAll — native path', () => {
  let root: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let exited: number | null;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-native-verify-'));
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    exited = null;
    // process.exit must NOT actually exit the test worker — capture the code and
    // throw so the orchestrator's control flow stops where the real one would.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited = code ?? 0;
      throw new Error(`__exit_${code ?? 0}`);
    }) as never);
    vi.mocked(verifyOneSpecNative).mockReset();
    vi.mocked(bootAndroidEmulator).mockClear();
    vi.mocked(installCompanion).mockClear();
    vi.mocked(teardownEmulator).mockClear();
    vi.mocked(closeEstablishedNativeSessions).mockClear();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  /** An adb runner that reports NO running device (auto-discovery finds nothing). */
  const noDevices: CommandRunner = async () => ({
    code: 0,
    stdout: 'List of devices attached\n',
    stderr: '',
  });

  /**
   * Pin the run to Android. The native target defaults to iOS (parity with the
   * MCP native path), so the Android-specific tests below must opt in the same
   * way a real Android project does — via `native.target` in config.
   */
  function pinAndroid(): void {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      config: {
        renderMode: 'native',
        framework: 'expo-native',
        wrapper: './.validity/wrapper.tsx',
        native: { target: 'android' },
      },
    } as never);
  }

  it('FALSE-GREEN: native spec with no --native config AND nothing to discover exits non-zero, never green', async () => {
    pinAndroid();
    writeSpec(root, makeNativeSpec());
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // No flags → auto-discovery runs; with no device (injected empty adb) and no
    // companion APK on disk it fails, and the orchestrator hits process.exit(1)
    // — our stub throws to halt it.
    await expect(
      runVerifyAll({ cwd: root, all: true, nativeDeviceRunner: noDevices }),
    ).rejects.toThrow('__exit_1');

    expect(exited).toBe(1);
    // It must announce the actionable flags + what auto-discovery found, not
    // silently drop the spec.
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('--native-avd');
    expect(printed).toContain('--native-apk');
    expect(printed).toContain('no running Android device');
    // The native verify engine was NOT reached — nothing pretended to verify it.
    expect(vi.mocked(verifyOneSpecNative)).not.toHaveBeenCalled();
    expect(vi.mocked(bootAndroidEmulator)).not.toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('AUTO-DISCOVERY: attaches to a running device, does NOT reinstall a current companion, and NEVER tears the device down', async () => {
    pinAndroid();
    writeSpec(root, makeNativeSpec());
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    // A freshly-built companion APK under the companion gradle output.
    const apkPath = resolve(
      root,
      '.validity/native-app/android/app/build/outputs/apk/debug/app-debug.apk',
    );
    mkdirSync(resolve(apkPath, '..'), { recursive: true });
    writeFileSync(apkPath, 'PK');

    // adb reports one running emulator.
    const oneDevice: CommandRunner = async (bin, args) => {
      if (bin === 'adb' && args[0] === 'devices') {
        return {
          code: 0,
          stdout:
            'List of devices attached\n' +
            'emulator-5554          device product:sdk_gphone64 model:Pixel_7 device:emu64a\n',
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

    vi.mocked(verifyOneSpecNative).mockResolvedValue({
      spec: makeNativeSpec(),
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runVerifyAll({ cwd: root, all: true, nativeDeviceRunner: oneDevice });

    // Attached to the RUNNING device — never booted a fresh emulator …
    expect(vi.mocked(bootAndroidEmulator)).not.toHaveBeenCalled();
    // … and left the already-current companion ALONE. This used to be an
    // unconditional `adb install -r`, which was the whole Android blocker:
    // reinstalling force-stops the package, the deep link then cold-starts
    // MainActivity, and expo-dev-launcher redirects to its own server-picker
    // activity because no bundle is loaded — so every capture on an attached
    // emulator settled on the launcher and reported `unconfirmed`.
    expect(vi.mocked(installCompanion)).not.toHaveBeenCalled();
    expect(vi.mocked(verifyOneSpecNative)).toHaveBeenCalledOnce();
    // … and did NOT tear the user's emulator down.
    expect(vi.mocked(teardownEmulator)).not.toHaveBeenCalled();
    // A passing hard verdict → gate not tripped.
    expect(exited).toBeNull();
    // The choice is logged, with the override hint.
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('Auto-detected a running Android device');
    expect(printed).toContain('emulator-5554');
    expect(printed).toContain('app-debug.apk');
  });

  it('AUTO-DISCOVERY: still installs the discovered APK when the companion is missing or stale', async () => {
    // The other half of the gate. Skipping the reinstall must not turn into
    // "never install", or a developer whose emulator has no companion (or a
    // stale one after a native dep bump) would get an unexplained
    // `render not confirmed` where a one-line install was the fix.
    pinAndroid();
    writeSpec(root, makeNativeSpec());
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const apkPath = resolve(
      root,
      '.validity/native-app/android/app/build/outputs/apk/debug/app-debug.apk',
    );
    mkdirSync(resolve(apkPath, '..'), { recursive: true });
    writeFileSync(apkPath, 'PK');

    vi.mocked(checkNativeReadiness).mockResolvedValueOnce({
      ready: false,
      steps: [
        {
          id: 'companion-app',
          label: 'Validity companion app',
          status: 'todo',
          detail: 'not installed',
        },
      ],
      nextAction: { label: 'Validity companion app', action: 'validity browse --native' },
    } as Awaited<ReturnType<typeof checkNativeReadiness>>);

    const oneDevice: CommandRunner = async (bin, args) => {
      if (bin === 'adb' && args[0] === 'devices') {
        return {
          code: 0,
          stdout:
            'List of devices attached\n' +
            'emulator-5554          device product:sdk_gphone64 model:Pixel_7 device:emu64a\n',
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    };

    vi.mocked(verifyOneSpecNative).mockResolvedValue({
      spec: makeNativeSpec(),
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runVerifyAll({ cwd: root, all: true, nativeDeviceRunner: oneDevice });

    expect(vi.mocked(installCompanion)).toHaveBeenCalledWith({
      apkPath,
      deviceId: 'emulator-5554',
    });
  });

  /** A `simctl list devices booted -j` runner reporting one booted simulator. */
  const oneSimulator: CommandRunner = async (bin, args) => {
    if (bin === 'xcrun' && args[0] === 'simctl') {
      return {
        code: 0,
        stdout: JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-26-3': [
              {
                udid: 'A7DF62D0-297A-4F15-AAA1-3A6675787CE2',
                name: 'iPhone 17 Pro',
                state: 'Booted',
              },
            ],
          },
        }),
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };

  it('iOS: auto-discovers a booted simulator, skips the APK install, and verifies on ios', async () => {
    // Regression: native auto-discovery asked adb for an Android device no
    // matter what, so on an iOS-only machine every native spec came back
    // unverifiable — a permanently red gate with a booted simulator sitting
    // right there. iOS is now the default target, matching the MCP path.
    writeSpec(root, makeNativeSpec());
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    vi.mocked(verifyOneSpecNative).mockResolvedValue({
      spec: makeNativeSpec(),
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runVerifyAll({ cwd: root, all: true, nativeDeviceRunner: oneSimulator });

    // Nothing installed from disk — an iOS companion is already on the sim …
    expect(vi.mocked(installCompanion)).not.toHaveBeenCalled();
    expect(vi.mocked(bootAndroidEmulator)).not.toHaveBeenCalled();
    expect(vi.mocked(teardownEmulator)).not.toHaveBeenCalled();
    // … and the engine was pinned to the discovered udid AS iOS. Driving an
    // iOS udid as 'android' would route every deep link through adb.
    expect(vi.mocked(verifyOneSpecNative)).toHaveBeenCalledOnce();
    // …carrying the device provenance the run-meta records (RunMeta.nativeDevice).
    expect(vi.mocked(verifyOneSpecNative).mock.calls[0]![3]).toEqual({
      deviceId: 'A7DF62D0-297A-4F15-AAA1-3A6675787CE2',
      deviceName: 'iPhone 17 Pro',
      osVersion: 'iOS 26.3',
      port: 0,
      platform: 'ios',
    });
    expect(exited).toBeNull();
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('Auto-detected a running iOS Simulator');
    // Android-only vocabulary must not leak into an iOS run.
    expect(printed).not.toContain('APK');
  });

  it('iOS FALSE-GREEN: no booted simulator fails the build with iOS-specific guidance', async () => {
    writeSpec(root, makeNativeSpec());
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    // simctl reports nothing booted → nothing to attach to.
    const noSimulators: CommandRunner = async () => ({
      code: 0,
      stdout: JSON.stringify({ devices: {} }),
      stderr: '',
    });

    await expect(
      runVerifyAll({ cwd: root, all: true, nativeDeviceRunner: noSimulators }),
    ).rejects.toThrow('__exit_1');

    expect(exited).toBe(1);
    expect(vi.mocked(verifyOneSpecNative)).not.toHaveBeenCalled();
    const printed = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('no booted iOS Simulator');
    // The fix must name the iOS action, not send the reader hunting for an APK
    // that is never supposed to exist on this path.
    expect(printed).toContain('validity browse --native');
    expect(printed).not.toContain('no companion APK');
    stderr.mockRestore();
  });

  it('MASKING: a mixed web+native --all verifies + reports the web spec, THEN fails on the native one', async () => {
    // Regression: the native-without-emulator gate used to `process.exit(1)`
    // BEFORE the web loop, so a repo with both runtimes never verified/reported
    // its web specs — web regressions were masked behind the native message.
    writeSpec(
      root,
      makeSpec({ id: 'spec-web', status: 'frozen', targets: { components: ['Card'] } }),
    );
    writeSpec(root, makeNativeSpec());
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // The web engine RUNS and returns a mechanical verdict (proves the web loop
    // was reached — the whole point of the fix).
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec: makeSpec({ id: 'spec-web' }),
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    // The native spec still trips the gate → exit 1 (stub throws). No device to
    // auto-discover (injected empty adb) + no APK on disk → the native gate fires.
    await expect(
      runVerifyAll({ cwd: root, all: true, nativeDeviceRunner: noDevices }),
    ).rejects.toThrow('__exit_1');
    expect(exited).toBe(1);

    // Web spec was verified (not masked) …
    expect(vi.mocked(verifyOneSpec)).toHaveBeenCalledTimes(1);
    // … and reported: its id shows up in the printed report.
    const printedOut = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(printedOut).toContain('spec-web');
    // … while the native reason is still announced.
    const printedErr = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(printedErr).toContain('--native-avd');
    stdout.mockRestore();
    stderr.mockRestore();
  });

  it('boots, installs, verifies each native spec, and tears down', async () => {
    writeSpec(root, makeNativeSpec());
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(verifyOneSpecNative).mockResolvedValue({
      spec: makeNativeSpec(),
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runVerifyAll({
      cwd: root,
      all: true,
      native: { avdName: 'validity', apkPath: '/tmp/app.apk' },
    });

    expect(vi.mocked(bootAndroidEmulator)).toHaveBeenCalledOnce();
    expect(vi.mocked(installCompanion)).toHaveBeenCalledWith({
      apkPath: '/tmp/app.apk',
      deviceId: 'emulator-5554',
    });
    expect(vi.mocked(verifyOneSpecNative)).toHaveBeenCalledOnce();
    expect(vi.mocked(teardownEmulator)).toHaveBeenCalledOnce();
    // A passing hard verdict → no hard failure → exit gate not tripped.
    expect(exited).toBeNull();
  });

  it('hands the agent-device session back BEFORE killing the emulator', async () => {
    // Order is the whole fix. Closing releases the device claim, so it has to
    // happen while the device still exists — kill the emulator first and the
    // daemon is left holding a claim against a device that is gone, which is
    // the claim file the next run reports as a phantom.
    writeSpec(root, makeNativeSpec());
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(verifyOneSpecNative).mockResolvedValue({
      spec: makeNativeSpec(),
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runVerifyAll({
      cwd: root,
      all: true,
      native: { avdName: 'validity', apkPath: '/tmp/app.apk' },
    });

    expect(vi.mocked(closeEstablishedNativeSessions)).toHaveBeenCalledOnce();
    expect(vi.mocked(closeEstablishedNativeSessions).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(teardownEmulator).mock.invocationCallOrder[0]!,
    );
  });

  it('closes the session even when the native sweep throws', async () => {
    writeSpec(root, makeNativeSpec());
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(verifyOneSpecNative).mockRejectedValue(new Error('companion never booted'));

    await runVerifyAll({
      cwd: root,
      all: true,
      native: { avdName: 'validity', apkPath: '/tmp/app.apk' },
    }).catch(() => undefined);

    expect(vi.mocked(closeEstablishedNativeSessions)).toHaveBeenCalledOnce();
  });

  it('temporal binding (B2): a mid-work spec renders the mid-work chip, yet the passing run still exits 0', async () => {
    const verifySha = 'd'.repeat(40);
    // Spec frozen while src/Button.tsx was already dirty…
    writeSpec(
      root,
      makeNativeSpec({ git: { sha: verifySha, dirty: true, changedFiles: ['src/Button.tsx'] } }),
    );
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // …and this run's diff touches the same file ⇒ frozen-mid-work (rule 2,
    // ancestry-independent — the temp root isn't even a git repo).
    const meta: RunMeta = {
      runId: 'run-native-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      mode: 'isolation',
      prompt: 'do the thing',
      scenarios: [],
      components: [],
      diff: { files: [{ path: 'src/Button.tsx', hunks: [] }] },
      report: { enabled: true, brand: 'none' },
      git: { sha: verifySha, dirty: true },
      criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    };
    vi.mocked(verifyOneSpecNative).mockResolvedValue({
      spec: makeNativeSpec(),
      meta,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runVerifyAll({
      cwd: root,
      all: true,
      native: { avdName: 'validity', apkPath: '/tmp/app.apk' },
      reportHtml: 'report.html',
    });

    // GATE INTEGRITY (honesty pair, exit half): mid-work is a badge, not a
    // gate — every hard criterion passed, so the run exits 0.
    expect(exited).toBeNull();
    const html = readFileSync(resolve(root, 'report.html'), 'utf-8');
    expect(html).toContain('spec frozen mid-work');
  });

  it('tears down even when an install/verify step fails (finally), failing every native spec', async () => {
    writeSpec(root, makeNativeSpec());
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(installCompanion).mockRejectedValueOnce(new Error('adb install failed'));

    // A hard failure (every native spec recorded as error) trips the exit gate.
    await expect(
      runVerifyAll({
        cwd: root,
        all: true,
        native: { avdName: 'validity', apkPath: '/tmp/app.apk' },
      }),
    ).rejects.toThrow('__exit_1');

    expect(exited).toBe(1);
    // Teardown ran despite the mid-run throw — no leaked emulator.
    expect(vi.mocked(teardownEmulator)).toHaveBeenCalledOnce();
    // verifyOneSpecNative never ran (install threw first), yet the spec is NOT
    // green — it lands as a build-failing error.
    expect(vi.mocked(verifyOneSpecNative)).not.toHaveBeenCalled();
  });
});

describe('verifyOneSpecNative', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-native-engine-'));
    // A component file matching the spec's target basename so resolution
    // succeeds without touching git.
    mkdirSync(resolve(root, 'src'), { recursive: true });
    writeFileSync(
      resolve(root, 'src', 'Button.tsx'),
      'export function Button() { return <button>ok</button>; }\n',
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const config: ValidityConfig = {
    renderMode: 'native',
    framework: 'expo-native',
    wrapper: './.validity/wrapper.tsx',
  };
  const booted = { deviceId: 'emulator-5554', port: 5554 };

  /** Minimal injectable deps so nothing boots a device / prepares an app. */
  function fakeDeps(
    capture: import('../native-verify-engine.js').NativeVerifyDeps['capture'],
  ): import('../native-verify-engine.js').NativeVerifyDeps {
    return {
      capture,
      prepareApp: () =>
        ({
          appDir: resolve(root, '.validity', 'native-app'),
          scheme: 'validity-test',
          bundleId: 'ai.validity.playground',
          prepared: {
            dataPayload: { views: {}, scenarios: {}, mockNetwork: {}, asyncStorage: [] },
            contentHash: 'content-hash',
          },
          contentHash: 'content-hash',
          metroContentMarkerPath: resolve(root, '.validity', 'marker'),
        }) as unknown as ReturnType<typeof import('@validity.ai/verify-native').prepareNativeApp>,
      ensureMetro: async () => ({ started: false, up: true }),
      startBridge: () =>
        ({ setNativeData: () => {}, close: () => {} }) as unknown as ReturnType<
          typeof import('@validity.ai/verify-native').startNativeBridge
        >,
      makeDriver: () => ({}) as unknown as import('@validity.ai/verify-native').NativeDriver,
    };
  }

  async function run(
    spec: Spec,
    capture: import('../native-verify-engine.js').NativeVerifyDeps['capture'],
  ) {
    // Import the REAL engine even though the file mocks it for the orchestrator.
    const { verifyOneSpecNative: real } = await vi.importActual<
      typeof import('../native-verify-engine.js')
    >('../native-verify-engine.js');
    return real(root, config, spec, booted, fakeDeps(capture));
  }

  it('FALSE-GREEN: a non-confirmed render sets error and leaves mechanical empty', async () => {
    const spec = makeNativeSpec();
    const v = await run(spec, (async () => ({
      target: {},
      url: 'validity-test://x',
      screenshotPath: '',
      a11ySnapshot: '',
      render: { status: 'unconfirmed' },
      timing: { openMs: 0, screenshotMs: 0, snapshotMs: 0 },
      criterionVerdicts: undefined,
    })) as unknown as import('@validity.ai/verify-native').captureNative);

    expect(v.error).toBeTruthy();
    expect(v.error).toContain('unconfirmed');
    expect(v.mechanical).toEqual([]);
    // Proven failing: the aggregated result trips hasHardFailure.
    const aggregated: SpecResult = {
      specId: spec.id,
      version: spec.version,
      error: v.error,
      criteria: aggregateVerdicts(spec, v.mechanical),
    };
    expect(hasHardFailure([aggregated])).toBe(true);
  });

  it('a confirmed render with an executed pass yields a clean pass (no error)', async () => {
    const spec = makeNativeSpec();
    const v = await run(spec, (async () => ({
      target: {},
      url: 'validity-test://x',
      screenshotPath: '',
      a11ySnapshot: '',
      render: { status: 'confirmed', via: 'marker' },
      timing: { openMs: 0, screenshotMs: 0, snapshotMs: 0 },
      criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }] as CriterionVerdict[],
    })) as unknown as import('@validity.ai/verify-native').captureNative);

    expect(v.error).toBeUndefined();
    // The executed verdict flows through; the soft criterion rides along as an
    // honest `unverifiable` placeholder (run-meta parity with the web engine).
    expect(v.mechanical).toEqual([
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      {
        id: 'AC-2',
        tier: 'soft',
        status: 'unverifiable',
        detail: 'soft criterion — needs agent verify (no LLM in the CLI)',
      },
    ]);
    const aggregated: SpecResult = {
      specId: spec.id,
      version: spec.version,
      error: v.error,
      criteria: aggregateVerdicts(spec, v.mechanical),
    };
    expect(hasHardFailure([aggregated])).toBe(false);
  });

  it('forwards the spec checks to captureNative and surfaces a taint-demoted verdict', async () => {
    const spec = makeNativeSpec();
    let forwarded: unknown;
    const v = await run(spec, (async (opts: { criteriaChecks?: unknown }) => {
      forwarded = opts.criteriaChecks;
      // captureNative would demote a catch-all-satisfied check to unverifiable
      // (network taint) — assert that demotion flows straight through.
      return {
        target: {},
        url: 'validity-test://x',
        screenshotPath: '',
        a11ySnapshot: '',
        render: { status: 'confirmed', via: 'marker' },
        timing: { openMs: 0, screenshotMs: 0, snapshotMs: 0 },
        criterionVerdicts: [
          { id: 'AC-1', tier: 'hard', status: 'unverifiable' },
        ] as CriterionVerdict[],
      };
    }) as unknown as import('@validity.ai/verify-native').captureNative);

    // Only criteria that carry executable checks are forwarded (AC-1, not the
    // soft AC-2) so the device runs the right assertions.
    expect(Array.isArray(forwarded)).toBe(true);
    expect((forwarded as { id: string }[]).map((c) => c.id)).toEqual(['AC-1']);
    expect(v.mechanical).toEqual([
      { id: 'AC-1', tier: 'hard', status: 'unverifiable' },
      {
        id: 'AC-2',
        tier: 'soft',
        status: 'unverifiable',
        detail: 'soft criterion — needs agent verify (no LLM in the CLI)',
      },
    ]);
  });

  it('a thrown capture (no booted device) becomes a build-failing error', async () => {
    const spec = makeNativeSpec();
    const v = await run(spec, (async () => {
      throw new Error('no booted simulator/emulator');
    }) as unknown as import('@validity.ai/verify-native').captureNative);

    expect(v.error).toContain('no booted simulator/emulator');
    expect(v.mechanical).toEqual([]);
  });

  it('runs command criteria on the HOST and never forwards them to the device (A5)', async () => {
    const spec = makeNativeSpec({
      criteria: [
        { id: 'AC-1', text: 'hard one', tier: 'hard', checks: [{ click: { role: 'button' } }] },
        {
          id: 'AC-cmd',
          text: 'repo typechecks',
          tier: 'property',
          checks: [{ expect: { command: { run: 'typecheck', exitCode: 0 } } }],
        },
      ],
    });
    const execCalls: string[] = [];
    const exec: CommandExec = async (cmd) => {
      execCalls.push(cmd);
      return { exitCode: 0, output: '', timedOut: false, durationMs: 3 };
    };
    let forwarded: unknown;
    const capture = (async (opts: { criteriaChecks?: unknown }) => {
      forwarded = opts.criteriaChecks;
      return {
        target: {},
        url: 'validity-test://x',
        screenshotPath: '',
        a11ySnapshot: '',
        render: { status: 'confirmed', via: 'marker' },
        timing: { openMs: 0, screenshotMs: 0, snapshotMs: 0 },
        criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }] as CriterionVerdict[],
      };
    }) as unknown as import('@validity.ai/verify-native').captureNative;

    const { verifyOneSpecNative: real } = await vi.importActual<
      typeof import('../native-verify-engine.js')
    >('../native-verify-engine.js');
    const v = await real(
      root,
      { ...config, commands: { typecheck: 'tsc --noEmit' } },
      spec,
      booted,
      { ...fakeDeps(capture), commandRunner: new CommandCheckRunner(exec) },
    );

    // The command criterion never reached the device…
    expect((forwarded as { id: string }[]).map((c) => c.id)).toEqual(['AC-1']);
    // …but its host-executed verdict is merged into the mechanical list.
    expect(execCalls).toEqual(['tsc --noEmit']);
    const cmd = v.mechanical.find((m) => m.id === 'AC-cmd');
    expect(cmd?.status).toBe('pass');
    expect(cmd?.checks?.[0]?.command?.resolved).toBe('tsc --noEmit');
  });

  it("CAN'T-FALSE-GREEN: an unconfirmed render is NOT rescued by a green command (A5)", async () => {
    const spec = makeNativeSpec({
      criteria: [
        {
          id: 'AC-cmd',
          text: 'repo typechecks',
          tier: 'property',
          checks: [{ expect: { command: { run: 'typecheck', exitCode: 0 } } }],
        },
      ],
    });
    const exec: CommandExec = async () => ({
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 3,
    });
    const capture = (async () => ({
      target: {},
      url: 'validity-test://x',
      screenshotPath: '',
      a11ySnapshot: '',
      render: { status: 'unconfirmed' },
      timing: { openMs: 0, screenshotMs: 0, snapshotMs: 0 },
      criterionVerdicts: undefined,
    })) as unknown as import('@validity.ai/verify-native').captureNative;

    const { verifyOneSpecNative: real } = await vi.importActual<
      typeof import('../native-verify-engine.js')
    >('../native-verify-engine.js');
    const v = await real(
      root,
      { ...config, commands: { typecheck: 'tsc --noEmit' } },
      spec,
      booted,
      { ...fakeDeps(capture), commandRunner: new CommandCheckRunner(exec) },
    );

    // The gate-integrity early return fires BEFORE the command run — the
    // build-failing error stands and no green command verdict appears.
    expect(v.error).toContain('unconfirmed');
    expect(v.mechanical).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Validity Score plumbing (F1) — pure, no sandbox.                    *
 * ------------------------------------------------------------------ */

describe('toSpecObservations (F1 — CLI results → scorecard observations)', () => {
  it('maps skipped→unscored, passes hard statuses through, and joins severity/softThreshold from the FROZEN spec', () => {
    const spec = makeSpec({
      hash: 'h1',
      criteria: [
        { id: 'AC-1', text: 'hard one', tier: 'hard', checks: [], severity: 'advisory' },
        { id: 'AC-2', text: 'soft one', tier: 'soft', softThreshold: 0.75 },
        { id: 'AC-3', text: 'prop one', tier: 'property', checks: [] },
      ],
    });
    const results: SpecResult = {
      specId: spec.id,
      version: 1,
      criteria: [
        { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'no POST' },
        { id: 'AC-2', tier: 'soft', status: 'skipped' },
        { id: 'AC-3', tier: 'property', status: 'unverifiable' },
      ],
    };
    const [obs] = toSpecObservations([{ spec, results }]);
    expect(obs).toMatchObject({ specId: spec.id, specVersion: 1, specHash: 'h1' });
    const byId = new Map(obs!.criteria.map((c) => [c.id, c]));
    expect(byId.get('AC-1')).toMatchObject({ status: 'fail', severity: 'advisory' });
    expect(byId.get('AC-2')).toMatchObject({ status: 'unscored', softThreshold: 0.75 });
    expect(byId.get('AC-2')!.severity).toBeUndefined();
    expect(byId.get('AC-3')).toMatchObject({ status: 'unverifiable' });
  });
});

describe('CI scorecard fold for CheckMetadata.validityScore (F1 — read-only, gate-inert)', () => {
  const T0 = '2026-01-01T00:00:00.000Z';
  const T1 = '2026-01-02T00:00:00.000Z';

  const committedScorecard = (): Scorecard => ({
    version: 1,
    updatedAt: T0,
    specs: {
      'spec-aaaa': {
        specVersion: 1,
        specHash: 'h1',
        verdict: 'pass',
        coveragePercent: 100,
        criteria: {
          'AC-1': { tier: 'hard', status: 'pass', at: T0, sha: 'sha0' },
          'AC-2': { tier: 'soft', status: 'pass', at: T0, sha: 'sha0' },
        },
        updatedAt: T0,
      },
    },
  });

  const ciResults = (): SpecResult => ({
    specId: 'spec-aaaa',
    version: 1,
    criteria: [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      { id: 'AC-2', tier: 'soft', status: 'skipped' }, // no model in CI
    ],
  });

  it("a committed soft pass SURVIVES the fold (rule 1) and counts at full credit on the same sha — CI can't erase soft credit", () => {
    const spec = makeSpec({ hash: 'h1' });
    const { scorecard } = reconcileScorecard({
      prev: committedScorecard(),
      observations: toSpecObservations([{ spec, results: ciResults() }]),
      now: T1,
      sha: 'sha0',
    });
    expect(scorecard.specs['spec-aaaa']!.criteria['AC-2']!.status).toBe('pass');
    // hard 2 + soft 1, all earned → 100.
    expect(computeValidityScore(scorecard)!.score).toBe(100);
  });

  it('a MOVED sha decays the committed soft pass to half credit (stale) — old scores are not trusted at full weight', () => {
    const spec = makeSpec({ hash: 'h1' });
    const { scorecard } = reconcileScorecard({
      prev: committedScorecard(),
      observations: toSpecObservations([{ spec, results: ciResults() }]),
      now: T1,
      sha: 'sha-moved',
    });
    expect(scorecard.specs['spec-aaaa']!.criteria['AC-2']!.stale).toBe(true);
    // earned 2 + 0.5 of possible 3 → round(83.3) = 83.
    expect(computeValidityScore(scorecard)!.score).toBe(83);
  });

  it('no committed scorecard + no specs ⇒ score is null (never 0, never 100)', () => {
    const { scorecard } = reconcileScorecard({
      prev: null,
      observations: [],
      now: T1,
    });
    expect(computeValidityScore(scorecard)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Probation (Phase C — bulk onboarding).
 *                                                                    *
 * `verify --all` is an ATTENDED surface: a clean pass here lifts the   *
 * bulk-onboarding probation marker. `toSpecObservations` threads the *
 * marker so the reducer downgrades any in-flight pass→fail to needs- *
 * review (low) — but once probation is cleared, a subsequent pass→   *
 * fail reverts to the normal `regression`-high behavior.             *
 * ------------------------------------------------------------------ */

const Tprob0 = '2026-01-01T00:00:00.000Z';
const Tprob1 = '2026-01-02T00:00:00.000Z';

/** Web spec carrying the bulk-onboarding probation marker. */
function makeProbationSpec(over: Partial<Spec> = {}): Spec {
  return makeSpec({
    id: 'spec-prob-all',
    version: 1,
    status: 'frozen',
    hash: 'h-prob',
    runtime: 'web',
    probation: { since: Tprob0, batchId: 'batch-1' },
    criteria: [
      { id: 'AC-1', text: 'hard one', tier: 'hard', checks: [{ click: { role: 'button' } }] },
      { id: 'AC-2', text: 'soft one', tier: 'soft' },
    ],
    ...over,
  });
}

describe('verify --all — probation clearing on the attended CI surface (Phase C)', () => {
  let root: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-verify-all-probation-'));
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error(`__exit_${_code ?? 0}`);
    }) as never);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it('CLEARS: a clean verify --all with --check-output lifts the probation marker', async () => {
    writeSpec(root, makeProbationSpec());
    // Clean pass: the hard criterion passes; the soft criterion is `skipped`
    // (no LLM in the CLI) → maps to `unscored` in the observation.
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec: makeProbationSpec(),
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runVerifyAll({ cwd: root, all: true, checkOutput: resolve(root, 'check.json') });

    const after = readSpec(root, 'spec-prob-all');
    expect(after?.probation).toBeUndefined();
    // The check metadata was written (the fold site is gated on --check-output).
    expect(existsSync(resolve(root, 'check.json'))).toBe(true);
  });

  it('LEAVES probation in place when a hard criterion is failing (not a clean pass)', async () => {
    writeSpec(root, makeProbationSpec());
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec: makeProbationSpec(),
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'fail', detail: 'no button' }],
    });

    // The run will exit 1 (hard failure trips the gate). Catch the sentinel.
    await expect(
      runVerifyAll({ cwd: root, all: true, checkOutput: resolve(root, 'check.json') }),
    ).rejects.toThrow('__exit_1');

    const after = readSpec(root, 'spec-prob-all');
    // The marker survives — only a CLEAN confirmed pass clears probation.
    expect(after?.probation).toBeDefined();
  });

  it('SUBSEQUENT REGRESSION: after probation is cleared, a pass→fail opens a normal high-severity `regression` (NOT needs-review)', async () => {
    // Phase 1 — a clean verify --all clears the marker (mirror of the CLEARS test).
    writeSpec(root, makeProbationSpec());
    vi.mocked(verifyOneSpec).mockResolvedValueOnce({
      spec: makeProbationSpec(),
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });
    await runVerifyAll({ cwd: root, all: true, checkOutput: resolve(root, 'check.json') });
    const cleared = readSpec(root, 'spec-prob-all');
    expect(cleared?.probation).toBeUndefined();

    // Phase 2 — the now-CONFIRMED spec regresses on a subsequent pass. Verify
    // does not persist the scorecard; we drive the SAME fold the verify --all
    // orchestrator does (`toSpecObservations` + `reconcileScorecard`) over a
    // prior scorecard that records the clean pass (the state the FIRST tick
    // produced). The probation flag on the now-confirmed spec must be absent,
    // so the reducer opens `regression`-high — never `needs-review`.
    const priorScorecard: Scorecard = {
      version: 1,
      updatedAt: Tprob0,
      specs: {
        'spec-prob-all': {
          specVersion: 1,
          specHash: 'h-prob',
          verdict: 'pass',
          coveragePercent: 100,
          criteria: {
            'AC-1': { tier: 'hard', status: 'pass', at: Tprob0, sha: 'sha-clean' },
          },
          updatedAt: Tprob0,
        },
      },
    };
    const failingResults: SpecResult = {
      specId: 'spec-prob-all',
      version: 1,
      criteria: [
        { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'console errored' },
        { id: 'AC-2', tier: 'soft', status: 'skipped' },
      ],
    };
    const observations = toSpecObservations([{ spec: cleared!, results: failingResults }]);
    // Confirmed: the now-cleared spec carries NO probation flag on its observation.
    expect(observations[0]!.probation).toBeUndefined();

    const { signals } = reconcileScorecard({
      prev: priorScorecard,
      observations,
      now: Tprob1,
      sha: 'sha-fail',
    });

    // The regression surfaces as `regression` (high) — the needs-review
    // downgrade is keyed on `obs.probation`, which is absent now that the
    // marker is lifted.
    const reg = signals.find((s) => s.kind === 'regression' && s.status === 'open');
    expect(reg).toBeDefined();
    expect(reg!.severity).toBe('high');
    expect(reg!.criterionId).toBe('AC-1');
    expect(signals.find((s) => s.kind === 'needs-review')).toBeUndefined();
  });
});

describe('runVerifyAll — verify lock', () => {
  let root: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-verify-all-lock-'));
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    vi.mocked(verifyOneSpec).mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}`);
    }) as never);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('exits non-zero with the holder message and never renders when the lock is held', async () => {
    writeSpec(root, makeSpec({ id: 'spec-lock' }));
    const lock = acquireVerifyLock(root, { owner: 'mcp-verify' });
    try {
      await expect(runVerifyAll({ cwd: root, all: true })).rejects.toThrow('__exit_1');
    } finally {
      lock.release();
    }
    const printed = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('A verify is already running');
    expect(printed).toContain('mcp-verify');
    expect(printed).toContain('node_modules/.validity/.verify.lock');
    expect(vi.mocked(verifyOneSpec)).not.toHaveBeenCalled();
  });
});

describe('runVerifyAll — env-blocked attribution end-to-end (never softens the gate)', () => {
  let root: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-verify-all-envblocked-'));
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    vi.mocked(verifyOneSpec).mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}`);
    }) as never);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('prints the ENVIRONMENT BLOCKED block and writes envBlocked into --check-output', async () => {
    writeSpec(root, makeSpec({ id: 'spec-env' }));
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec: makeSpec({ id: 'spec-env' }),
      meta: null,
      mechanical: [],
      error: 'Vite sandbox failed: ECONNREFUSED',
    });

    await expect(
      runVerifyAll({ cwd: root, all: true, checkOutput: resolve(root, 'check.json') }),
    ).rejects.toThrow('__exit_1');

    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrText).toContain('ENVIRONMENT BLOCKED — 1 spec produced no verdicts');
    expect(stderrText).toContain('Vite sandbox failed: ECONNREFUSED');
    expect(stderrText).toContain('This gate failure is environmental, not a code regression.');

    const meta = JSON.parse(readFileSync(resolve(root, 'check.json'), 'utf-8'));
    expect(meta.envBlocked).toEqual({ count: 1, errors: ['Vite sandbox failed: ECONNREFUSED'] });
    expect(meta.pass).toBe(false); // attribution, never a softer gate
  });

  it('omits envBlocked from --check-output and prints no block on a clean run', async () => {
    writeSpec(root, makeSpec({ id: 'spec-ok' }));
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec: makeSpec({ id: 'spec-ok' }),
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runVerifyAll({ cwd: root, all: true, checkOutput: resolve(root, 'check.json') });

    const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrText).not.toContain('ENVIRONMENT BLOCKED');

    const meta = JSON.parse(readFileSync(resolve(root, 'check.json'), 'utf-8'));
    expect(meta.envBlocked).toBeUndefined();
  });
});

describe('runVerifyAll — per-run report.html by default (Feature 1)', () => {
  let root: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let exited: number | null;

  // 8x8 red PNG so the report renderer's data-URI embed is exercised.
  const RED_8x8_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAAA' +
      'AAD//////xX76loAAAANSURBVAjXY/jPwMDAAAAEAAEW6L8VAAAAAElFTkSuQmCC',
    'base64',
  );

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-verify-all-report-'));
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    exited = null;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited = code ?? 0;
      throw new Error(`__exit_${code ?? 0}`);
    }) as never);
    vi.mocked(verifyOneSpec).mockReset();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** Seed a run dir + screenshot and return the RunMeta a web verify produced. */
  function seedWebRun(runId: string): RunMeta {
    const dir = runDir(root, runId);
    mkdirSync(resolve(dir, 'screenshots'), { recursive: true });
    writeFileSync(resolve(dir, 'screenshots', 'card__base.png'), RED_8x8_PNG);
    return {
      runId,
      createdAt: '2026-07-18T10:00:00.000Z',
      mode: 'isolation',
      prompt: 'do the thing',
      scenarios: [],
      specId: 'spec-web',
      specVersion: 1,
      components: [
        {
          id: 'card',
          filePath: 'src/Card.tsx',
          screenshotPath: resolve(dir, 'screenshots', 'card__base.png'),
        },
      ],
      componentSources: {},
      diff: { files: [] },
      report: { enabled: true, brand: 'validity' },
      criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    } as RunMeta;
  }

  it('writes report.html into each run dir (the /run/<runId>/report read path) by default', async () => {
    writeSpec(root, makeSpec({ id: 'spec-web', status: 'frozen' }));
    const meta = seedWebRun('run-web-1');
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec: makeSpec({ id: 'spec-web' }),
      meta,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runVerifyAll({ cwd: root, all: true });

    expect(exited).toBeNull();
    // The dashboard's serveRunReport reads exactly this path.
    expect(existsSync(resolve(runDir(root, 'run-web-1'), 'report.html'))).toBe(true);
  });

  it('keeps the aggregate --report-html on top of the per-run reports', async () => {
    writeSpec(root, makeSpec({ id: 'spec-web', status: 'frozen' }));
    const meta = seedWebRun('run-web-1');
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec: makeSpec({ id: 'spec-web' }),
      meta,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runVerifyAll({ cwd: root, all: true, reportHtml: 'agg.html' });

    expect(existsSync(resolve(root, 'agg.html'))).toBe(true); // aggregate preserved
    expect(existsSync(resolve(runDir(root, 'run-web-1'), 'report.html'))).toBe(true); // per-run too
  });

  it('honors report:false — no per-run report is written', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      config: {
        renderMode: 'web',
        framework: 'auto',
        wrapper: './.validity/wrapper.tsx',
        report: false,
      },
    } as never);
    writeSpec(root, makeSpec({ id: 'spec-web', status: 'frozen' }));
    const meta = seedWebRun('run-web-1');
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec: makeSpec({ id: 'spec-web' }),
      meta,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runVerifyAll({ cwd: root, all: true });

    expect(existsSync(resolve(runDir(root, 'run-web-1'), 'report.html'))).toBe(false);
  });
});
