/**
 * `validity replay` — the reviewer's re-execution command.
 *
 * Two layers are covered here:
 *
 *   - the PURE comparison (`classifyReplay` / `compareReplay` / `replayVerdict` /
 *     `replayHeadline`), which decides reproduced vs. regressed vs. improved vs.
 *     unverifiable-now and therefore owns the never-false-green guarantee;
 *   - the ORCHESTRATOR (`runReplay`) end-to-end on a real spec store + a real
 *     signed run dir, with only the sandbox verify engine stubbed. Everything
 *     that makes the command trustworthy — the attestation chain, the frozen
 *     spec load by specHash, the exit codes — runs for real.
 *
 * The web verify engine is mocked because booting Vite here would be slow and
 * flaky (see the same note in verify-all.test.ts); its stub IS the "current
 * working tree", so a `fail` from it is exactly a mutated tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@validity.ai/verify-spec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@validity.ai/verify-spec')>()),
  loadConfig: vi.fn(async () => ({
    config: { renderMode: 'isolation', wrapper: './.validity/wrapper.tsx' },
  })),
}));
vi.mock('../verify-engine.js', () => ({ verifyOneSpec: vi.fn() }));
vi.mock('../native-verify-engine.js', () => ({ verifyOneSpecNative: vi.fn() }));

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  attestRecording,
  attestRun,
  createSpec,
  freezeSpec,
  loadSignals,
  readSpec,
  replayDivergenceSignalId,
  runDir,
  runMetaPathFor,
  specHistoryDir,
  updateSpec,
  type AttestKeyPair,
  type AttestedCriterion,
  type CriterionVerdict,
  type RunMeta,
  type Spec,
  type SpecCriterion,
} from '@validity.ai/verify-spec';
import { verifyOneSpec } from '../verify-engine.js';
import { verifyOneSpecNative } from '../native-verify-engine.js';
import {
  classifyReplay,
  compareReplay,
  divergenceLedgerRow,
  formatReplay,
  loadReplaySpec,
  replayDivergenceSignalDetail,
  replayHeadline,
  replayRecordingOnDevice,
  replayVerdict,
  resolveReplayTarget,
  runReplay,
  tallyReplay,
  REPLAY_DEVICE_EVIDENCE_FILENAME,
  REPLAY_DIVERGENCE_FILENAME,
  REPLAY_DIVERGENCE_LEDGER_PATH,
  REPLAY_EXIT_INCOMPLETE,
  REPLAY_EXIT_OK,
  REPLAY_EXIT_REGRESSED,
  REPLAY_EXIT_USAGE,
  REPLAY_RECEIPT,
  type ReplayCriterion,
  type ReplayDivergenceLedgerRow,
  type ReplayRecording,
  type ReplayResult,
} from './replay.js';

const T0 = '2026-01-01T00:00:00.000Z';

const HARD: SpecCriterion = {
  id: 'AC-1',
  text: 'The submit button is present',
  tier: 'hard',
  mocking: 'required',
  checks: [{ expect: { console: { errors: 0 } } }],
};
const PROPERTY: SpecCriterion = {
  id: 'AC-2',
  text: 'No console errors',
  tier: 'property',
  mocking: 'required',
  checks: [{ expect: { console: { errors: 0 } } }],
};
const SOFT: SpecCriterion = {
  id: 'AC-3',
  text: 'The form looks like the mock',
  tier: 'soft',
  mocking: 'required',
};

/** One fixed keypair for the whole file — never touches ~/.validity. */
function testKey(): AttestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    createdAt: T0,
  };
}
const KEY = testKey();

/* ------------------------------------------------------------------ *
 * Pure layer.                                                         *
 * ------------------------------------------------------------------ */

describe('classifyReplay', () => {
  it('reproduces when the re-executed verdict matches the attested one', () => {
    expect(classifyReplay('pass', 'pass')).toBe('reproduced');
    expect(classifyReplay('fail', 'fail')).toBe('reproduced');
  });

  it('regresses on pass → fail', () => {
    expect(classifyReplay('pass', 'fail')).toBe('regressed');
  });

  it('improves on fail → pass', () => {
    expect(classifyReplay('fail', 'pass')).toBe('improved');
  });

  it('NEVER FALSE GREEN: an unexecutable check is unverifiable-now, whatever was attested', () => {
    expect(classifyReplay('pass', null)).toBe('unverifiable-now');
    expect(classifyReplay('pass', 'unverifiable')).toBe('unverifiable-now');
    // Reproducing a NON-result is not evidence — this must not read "reproduced".
    expect(classifyReplay('unverifiable', 'unverifiable')).toBe('unverifiable-now');
  });

  it('NEVER FALSE GREEN: a fresh pass with nothing attested is unverifiable-now, not reproduced', () => {
    expect(classifyReplay(null, 'pass')).toBe('unverifiable-now');
  });

  it('treats an attested-unverifiable that now FAILS as a regression (ties resolve red)', () => {
    expect(classifyReplay('unverifiable', 'fail')).toBe('regressed');
  });
});

describe('replayVerdict', () => {
  const counts = (over: Partial<ReturnType<typeof tallyReplay>> = {}) => ({
    reproduced: 0,
    regressed: 0,
    improved: 0,
    unverifiableNow: 0,
    judgedLane: 0,
    ...over,
  });

  it('is green only when every deterministic criterion reproduced or improved', () => {
    expect(replayVerdict(counts({ reproduced: 3 }))).toEqual({
      verdict: 'reproduced',
      exitCode: 0,
    });
    expect(replayVerdict(counts({ reproduced: 1, improved: 2 }))).toEqual({
      verdict: 'reproduced',
      exitCode: 0,
    });
  });

  it('any regression wins over everything else and exits 1', () => {
    expect(replayVerdict(counts({ reproduced: 9, regressed: 1, unverifiableNow: 4 }))).toEqual({
      verdict: 'regressed',
      exitCode: REPLAY_EXIT_REGRESSED,
    });
  });

  it('an unexecutable criterion makes the run incomplete, never reproduced', () => {
    expect(replayVerdict(counts({ reproduced: 5, unverifiableNow: 1 }))).toEqual({
      verdict: 'incomplete',
      exitCode: REPLAY_EXIT_INCOMPLETE,
    });
  });

  it('an EMPTY deterministic lane is incomplete, not a vacuous pass', () => {
    expect(replayVerdict(counts({ judgedLane: 4 }))).toEqual({
      verdict: 'incomplete',
      exitCode: REPLAY_EXIT_INCOMPLETE,
    });
  });
});

describe('compareReplay', () => {
  const spec = {
    id: 'spec-a',
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    criteria: [HARD, PROPERTY, SOFT],
    createdAt: T0,
  } as Spec;

  const attested: AttestedCriterion[] = [
    { id: 'AC-1', tier: 'hard', status: 'pass', taints: [] },
    { id: 'AC-2', tier: 'property', status: 'pass', taints: [] },
    {
      id: 'AC-3',
      tier: 'soft',
      status: 'pass',
      taints: ['wrapper'],
      scoredBy: { model: 'anthropic/claude', session: 'sess-abcdef012345' },
    },
  ];

  it('SOFT CRITERIA ARE NEVER RE-EXECUTED — they land in the judged lane with their provenance', () => {
    const { criteria, soft } = compareReplay({
      spec,
      attested,
      // Even if something upstream handed us a soft verdict, it must not be
      // treated as a re-execution: replay has no model to produce one.
      replayed: [
        { id: 'AC-1', status: 'pass' },
        { id: 'AC-2', status: 'pass' },
        { id: 'AC-3', status: 'pass' },
      ],
    });
    expect(criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2']);
    expect(soft).toEqual([
      {
        id: 'AC-3',
        attested: 'pass',
        scoredBy: { model: 'anthropic/claude', session: 'sess-abcdef012345' },
        taints: ['wrapper'],
        lane: 'judged lane, not replayed',
      },
    ]);
  });

  it('enumerates from the FROZEN SPEC, so a criterion the replay skipped still appears', () => {
    const { criteria } = compareReplay({
      spec,
      attested,
      replayed: [{ id: 'AC-1', status: 'pass' }],
      blockedReason: 'the sandbox never rendered',
    });
    const ac2 = criteria.find((c) => c.id === 'AC-2')!;
    expect(ac2.outcome).toBe('unverifiable-now');
    expect(ac2.replayed).toBeNull();
    expect(ac2.note).toContain('the sandbox never rendered');
  });

  it('names the criterion that has no attested verdict to compare against', () => {
    const { criteria } = compareReplay({
      spec,
      attested: attested.filter((c) => c.id !== 'AC-2'),
      replayed: [
        { id: 'AC-1', status: 'pass' },
        { id: 'AC-2', status: 'pass' },
      ],
    });
    const ac2 = criteria.find((c) => c.id === 'AC-2')!;
    expect(ac2.outcome).toBe('unverifiable-now');
    expect(ac2.note).toContain('no attested verdict');
  });

  it('carries the re-executed engine detail through verbatim', () => {
    const { criteria } = compareReplay({
      spec,
      attested,
      replayed: [
        { id: 'AC-1', status: 'fail', detail: 'expected 1 [data-testid=submit], found 0' },
        { id: 'AC-2', status: 'pass' },
      ],
    });
    expect(criteria[0]).toMatchObject({
      outcome: 'regressed',
      attested: 'pass',
      replayed: 'fail',
      detail: 'expected 1 [data-testid=submit], found 0',
    });
  });
});

describe('replayHeadline', () => {
  it('leads with the verdict and never says "reproduced" on an incomplete lane', () => {
    const c = tallyReplay(
      [
        { id: 'a', tier: 'hard', attested: 'pass', replayed: 'pass', outcome: 'reproduced' },
        { id: 'b', tier: 'hard', attested: 'pass', replayed: null, outcome: 'unverifiable-now' },
      ] satisfies ReplayCriterion[],
      [],
    );
    expect(replayHeadline('incomplete', c)).toMatch(/^NOT REPRODUCED/);
    expect(replayHeadline('incomplete', c)).toContain('1 of 2');
  });

  it('says so plainly when there is nothing deterministic to replay', () => {
    expect(replayHeadline('incomplete', tallyReplay([], []))).toContain(
      'no deterministic (hard/property) criteria',
    );
  });

  it('a broken chain is reported as NOT REPLAYED, not as a verdict about the code', () => {
    expect(replayHeadline('attestation-failed', tallyReplay([], []))).toMatch(/^NOT REPLAYED/);
  });
});

/* ------------------------------------------------------------------ *
 * Orchestrator.                                                       *
 * ------------------------------------------------------------------ */

/** Build a frozen spec in a real store. */
function freezeProject(criteria: SpecCriterion[], runtime: 'web' | 'native' = 'web') {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-replay-'));
  const draft = createSpec({
    projectRoot: root,
    prompt: 'contact form',
    criteria,
    runtime,
    createdBy: 'agent',
    createdAt: T0,
  });
  const { spec } = freezeSpec({
    projectRoot: root,
    specId: draft.specId,
    updatedAt: T0,
    gitBinding: null,
  });
  return { root, spec };
}

/** Write + SIGN a run dir citing that frozen spec, with the given verdicts. */
function signRunDir(root: string, spec: Spec, verdicts: CriterionVerdict[]): string {
  const runId = 'run-20260101-replay';
  mkdirSync(runDir(root, runId), { recursive: true });
  const meta: RunMeta = {
    runId,
    createdAt: T0,
    mode: 'isolation',
    prompt: 'contact form',
    scenarios: [],
    components: [],
    diff: { files: [] },
    report: { enabled: true, brand: 'validity' },
    specId: spec.id,
    specVersion: spec.version,
    specHash: spec.hash,
    criterionVerdicts: verdicts,
  };
  writeFileSync(runMetaPathFor(root, runId), `${JSON.stringify(meta, null, 2)}\n`);
  const record = attestRun(root, runId, KEY);
  expect(record).not.toBeNull();
  return runId;
}

describe('runReplay', () => {
  let exited: number | null;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdout: string;
  let stderr: string;
  const roots: string[] = [];

  beforeEach(() => {
    exited = null;
    stdout = '';
    stderr = '';
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exited = code ?? 0;
      throw new Error(`__exit_${code ?? 0}`);
    }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    vi.mocked(verifyOneSpec).mockReset();
    vi.mocked(verifyOneSpecNative).mockReset();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** Run and parse the --json output, tolerating the process.exit throw. */
  async function replayJson(root: string, target: string): Promise<ReplayResult> {
    try {
      await runReplay(target, { cwd: root, json: true });
    } catch (err) {
      if (!/^__exit_/.test((err as Error).message)) throw err;
    }
    return JSON.parse(stdout) as ReplayResult;
  }

  it('REPRODUCED: the deterministic lane re-executes to the attested verdicts and exits 0', async () => {
    const { root, spec } = freezeProject([HARD, PROPERTY, SOFT]);
    roots.push(root);
    const runId = signRunDir(root, spec, [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      { id: 'AC-2', tier: 'property', status: 'pass' },
      {
        id: 'AC-3',
        tier: 'soft',
        status: 'pass',
        scoredBy: { model: 'anthropic/claude', session: 'sess-1234567890ab' },
      },
    ]);
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec,
      meta: null,
      mechanical: [
        { id: 'AC-1', tier: 'hard', status: 'pass' },
        { id: 'AC-2', tier: 'property', status: 'pass' },
      ],
    });

    const result = await replayJson(root, runDir(root, runId));

    expect(exited).toBeNull();
    expect(result.verdict).toBe('reproduced');
    expect(result.exitCode).toBe(0);
    expect(result.attestation.ok).toBe(true);
    expect(result.counts).toMatchObject({ reproduced: 2, regressed: 0, judgedLane: 1 });
    // The receipt is part of the contract, in the structured output too.
    expect(result.llmTokens).toBe(0);
    expect(result.receipt).toBe('re-verified deterministically — 0 LLM tokens');
    // The frozen contract was loaded by the version the run cited, not the head.
    expect(result.spec).toMatchObject({
      id: spec.id,
      version: spec.version,
      hash: spec.hash,
      attestedHash: spec.hash,
      refrozen: false,
      runtime: 'web',
    });
  });

  it('SOFT CRITERIA ARE NEVER RE-SCORED — they are reported with provenance and the model is never consulted', async () => {
    const { root, spec } = freezeProject([HARD, SOFT]);
    roots.push(root);
    const runId = signRunDir(root, spec, [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      {
        id: 'AC-3',
        tier: 'soft',
        status: 'pass',
        scoredBy: { model: 'anthropic/claude', session: 'sess-1234567890ab' },
        evidenceTaints: ['wrapper'],
      },
    ]);
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec,
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    const result = await replayJson(root, runId);

    expect(result.soft).toEqual([
      {
        id: 'AC-3',
        attested: 'pass',
        scoredBy: { model: 'anthropic/claude', session: 'sess-1234567890ab' },
        taints: ['wrapper'],
        lane: 'judged lane, not replayed',
      },
    ]);
    // The soft criterion appears in NEITHER the deterministic comparison nor the counts.
    expect(result.criteria.map((c) => c.id)).toEqual(['AC-1']);
    expect(result.counts.judgedLane).toBe(1);
    // The spec handed to the engine still carries the soft criterion (it is the
    // frozen contract) — what matters is that no verdict for it was produced.
    expect(vi.mocked(verifyOneSpec)).toHaveBeenCalledOnce();
  });

  it('REGRESSION: a check that fails against the mutated tree exits non-zero and names the criterion', async () => {
    const { root, spec } = freezeProject([HARD, PROPERTY]);
    roots.push(root);
    const runId = signRunDir(root, spec, [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      { id: 'AC-2', tier: 'property', status: 'pass' },
    ]);
    // The "mutated working tree": the same frozen check now fails.
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec,
      meta: null,
      mechanical: [
        {
          id: 'AC-1',
          tier: 'hard',
          status: 'fail',
          detail: 'expected 1 element matching [data-testid=submit], found 0',
        },
        { id: 'AC-2', tier: 'property', status: 'pass' },
      ],
    });

    const result = await replayJson(root, runId);

    expect(exited).toBe(REPLAY_EXIT_REGRESSED);
    expect(result.verdict).toBe('regressed');
    expect(result.headline).toMatch(/^REGRESSED/);
    expect(result.counts).toMatchObject({ regressed: 1, reproduced: 1 });
    expect(result.criteria.find((c) => c.id === 'AC-1')).toMatchObject({
      outcome: 'regressed',
      attested: 'pass',
      replayed: 'fail',
      detail: 'expected 1 element matching [data-testid=submit], found 0',
    });
  });

  it('ATTESTATION INVALID SHORT-CIRCUITS: the tree is never re-executed and the exit is non-zero', async () => {
    const { root, spec } = freezeProject([HARD]);
    roots.push(root);
    const runId = signRunDir(root, spec, [{ id: 'AC-1', tier: 'hard', status: 'fail' }]);
    // The laundering attack: flip the recorded verdict AFTER signing.
    const path = runMetaPathFor(root, runId);
    const meta = JSON.parse(readFileSync(path, 'utf-8')) as RunMeta;
    meta.criterionVerdicts![0]!.status = 'pass';
    writeFileSync(path, JSON.stringify(meta, null, 2));

    const result = await replayJson(root, runId);

    expect(exited).toBe(REPLAY_EXIT_REGRESSED);
    expect(result.verdict).toBe('attestation-failed');
    expect(result.headline).toMatch(/^NOT REPLAYED/);
    expect(result.attestation.ok).toBe(false);
    // The mismatch is NAMED, exactly as `attest verify` names it.
    expect(result.attestation.mismatches.map((m) => m.field)).toContain(
      'run-meta:criteria[AC-1].status',
    );
    // …and nothing was re-executed against the working tree.
    expect(vi.mocked(verifyOneSpec)).not.toHaveBeenCalled();
    expect(result.criteria).toEqual([]);
    expect(result.spec).toBeUndefined();
  });

  it('RE-FROZEN SPEC: warns and replays the current contract, never calls it tampering', async () => {
    const { root, spec } = freezeProject([HARD]);
    roots.push(root);
    const runId = signRunDir(root, spec, [{ id: 'AC-1', tier: 'hard', status: 'pass' }]);

    // The contract legitimately moves on: edit + re-freeze.
    updateSpec({
      projectRoot: root,
      specId: spec.id,
      patch: { criteria: [{ ...HARD, text: 'The submit button is present and enabled' }] },
      updatedAt: T0,
    });
    freezeSpec({ projectRoot: root, specId: spec.id, updatedAt: T0, gitBinding: null });
    const head = readSpec(root, spec.id)!;
    expect(head.hash).not.toBe(spec.hash);
    // Remove the history copy so the run's exact version is unreachable — this is
    // what forces the fall back to the store head, and the warning that goes with it.
    rmSync(specHistoryDir(root, spec.id), { recursive: true, force: true });

    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec: head,
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    const result = await replayJson(root, runId);

    // A warning, NOT a mismatch: the run's own evidence is untouched.
    expect(result.attestation.ok).toBe(true);
    expect(result.attestation.warnings.some((w) => /re-frozen/.test(w.detail))).toBe(true);
    expect(result.spec).toMatchObject({
      version: head.version,
      hash: head.hash,
      attestedHash: spec.hash,
      refrozen: true,
      source: 'current',
    });
    // …and it still replayed rather than refusing.
    expect(vi.mocked(verifyOneSpec)).toHaveBeenCalledOnce();
    expect(result.verdict).toBe('reproduced');
  });

  it('a render failure blocks the lane: unverifiable-now, exit 3, never a verdict', async () => {
    const { root, spec } = freezeProject([HARD]);
    roots.push(root);
    const runId = signRunDir(root, spec, [{ id: 'AC-1', tier: 'hard', status: 'pass' }]);
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec,
      meta: null,
      mechanical: [],
      error: 'vite sandbox failed to boot',
    });

    const result = await replayJson(root, runId);

    expect(exited).toBe(REPLAY_EXIT_INCOMPLETE);
    expect(result.verdict).toBe('incomplete');
    expect(result.blocked).toContain('vite sandbox failed to boot');
    expect(result.criteria[0]!.outcome).toBe('unverifiable-now');
  });

  it('NATIVE with no booted device degrades to a named notice — never a false verdict', async () => {
    const { root, spec } = freezeProject([HARD], 'native');
    roots.push(root);
    const runId = signRunDir(root, spec, [{ id: 'AC-1', tier: 'hard', status: 'pass' }]);

    // No devices: `xcrun simctl list devices booted` reports an empty JSON set.
    const result = await (async () => {
      try {
        await runReplay(runId, {
          cwd: root,
          json: true,
          deps: {
            nativeDeviceRunner: async () => ({ code: 0, stdout: '{"devices":{}}', stderr: '' }),
          },
        });
      } catch (err) {
        if (!/^__exit_/.test((err as Error).message)) throw err;
      }
      return JSON.parse(stdout) as ReplayResult;
    })();

    expect(exited).toBe(REPLAY_EXIT_INCOMPLETE);
    expect(result.verdict).toBe('incomplete');
    expect(result.blocked).toContain('native replay requires a booted device');
    expect(vi.mocked(verifyOneSpecNative)).not.toHaveBeenCalled();
    expect(result.criteria[0]!.outcome).toBe('unverifiable-now');
  });

  it('NATIVE with a signed recording but no device: names the on-device lane, exit 3', async () => {
    // Attach-only. Replay never boots a device and never installs an app, so
    // the recording is REPORTED as un-re-executable rather than skipped in
    // silence — and the run cannot be called reproduced.
    const { root, spec } = freezeProject([HARD], 'native');
    roots.push(root);
    const runId = signRunDir(root, spec, [{ id: 'AC-1', tier: 'hard', status: 'pass' }]);
    writeFileSync(
      resolve(runDir(root, runId), 'replay.ad'),
      'context platform=android\nopen "validity://x"\nwait id="validity-root:t1"\n',
    );
    expect(attestRecording(root, runId, undefined, KEY)).not.toBeNull();

    const result = await (async () => {
      try {
        await runReplay(runId, {
          cwd: root,
          json: true,
          deps: {
            nativeDeviceRunner: async () => ({
              code: 0,
              stdout: '{"devices":{}}',
              stderr: '',
            }),
          },
        });
      } catch (err) {
        if (!/^__exit_/.test((err as Error).message)) throw err;
      }
      return JSON.parse(stdout) as ReplayResult;
    })();

    expect(exited).toBe(REPLAY_EXIT_INCOMPLETE);
    expect(result.recording?.outcome).toBe('unverifiable-now');
    expect(result.recording?.file).toBe('replay.ad');
    expect(result.recording?.notice).toContain('not re-executed');
    expect(result.attestation.ok).toBe(true);
  });

  it('NATIVE with no recording behaves exactly as it did before recordings existed', async () => {
    const { root, spec } = freezeProject([HARD], 'native');
    roots.push(root);
    const runId = signRunDir(root, spec, [{ id: 'AC-1', tier: 'hard', status: 'pass' }]);

    const result = await (async () => {
      try {
        await runReplay(runId, {
          cwd: root,
          json: true,
          deps: {
            nativeDeviceRunner: async () => ({
              code: 0,
              stdout: '{"devices":{}}',
              stderr: '',
            }),
          },
        });
      } catch (err) {
        if (!/^__exit_/.test((err as Error).message)) throw err;
      }
      return JSON.parse(stdout) as ReplayResult;
    })();

    expect(result.recording).toBeUndefined();
    expect(result.verdict).toBe('incomplete');
    expect(result.attestation.ok).toBe(true);
  });
  it('accepts a report.html path inside the run dir, not just the dir', async () => {
    const { root, spec } = freezeProject([HARD]);
    roots.push(root);
    const runId = signRunDir(root, spec, [{ id: 'AC-1', tier: 'hard', status: 'pass' }]);
    const reportPath = resolve(runDir(root, runId), 'report.html');
    writeFileSync(reportPath, '<html>report</html>');
    expect(resolveReplayTarget(root, reportPath)).toBe(runDir(root, runId));

    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec,
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });
    const result = await replayJson(root, reportPath);
    expect(result.dir).toBe(runDir(root, runId));
    // report.html exists but was written outside the attested path — a warning,
    // and the replay proceeds.
    expect(result.attestation.ok).toBe(true);
    expect(result.verdict).toBe('reproduced');
  });

  it('exits 2 with the known run ids when the target resolves to nothing', async () => {
    const { root } = freezeProject([HARD]);
    roots.push(root);
    await expect(runReplay('nope', { cwd: root })).rejects.toThrow('__exit_2');
    expect(exited).toBe(REPLAY_EXIT_USAGE);
    expect(stderr).toContain('no run dir found');
  });

  it('prints the verdict first and the receipt last in the console view', async () => {
    const { root, spec } = freezeProject([HARD, SOFT]);
    roots.push(root);
    const runId = signRunDir(root, spec, [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      { id: 'AC-3', tier: 'soft', status: 'pass' },
    ]);
    vi.mocked(verifyOneSpec).mockResolvedValue({
      spec,
      meta: null,
      mechanical: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    });

    await runReplay(runDir(root, runId), { cwd: root });

    expect(stdout).toContain('REPRODUCED');
    expect(stdout).toContain('judged lane, not replayed');
    // picocolors enables ANSI when `CI` is set even without a TTY, so compare
    // the stripped text — the receipt must be the LAST thing printed.
    // eslint-disable-next-line no-control-regex
    const plain = stdout.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain.trimEnd().endsWith('Re-verified deterministically — 0 LLM tokens.')).toBe(true);
  });
});

describe('loadReplaySpec', () => {
  it('refuses to replay a run that was never bound to a frozen spec', () => {
    const { root } = freezeProject([HARD]);
    const res = loadReplaySpec(root, {
      attestVersion: 1,
      runId: 'r',
      createdAt: T0,
      criteria: [],
      screenshots: [],
    });
    expect(res.spec).toBeNull();
    expect(res.reason).toContain('not bound to a frozen spec');
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a spec that has left the store rather than replaying something else', () => {
    const { root } = freezeProject([HARD]);
    const res = loadReplaySpec(root, {
      attestVersion: 1,
      runId: 'r',
      createdAt: T0,
      specId: 'spec-gone',
      specHash: 'sha256-deadbeef',
      criteria: [],
      screenshots: [],
    });
    expect(res.spec).toBeNull();
    expect(res.reason).toContain('no longer in the spec store');
    rmSync(root, { recursive: true, force: true });
  });
});
/* ------------------------------------------------------------------ *
 * The on-device lane: `.ad` recordings.                               *
 * ------------------------------------------------------------------ */

const RECORDING = (over: Partial<ReplayRecording> = {}): ReplayRecording => ({
  file: 'replay.ad',
  outcome: 'reproduced',
  notice: 'the recorded on-device journey replayed to its landmark',
  ...over,
});

describe('replayVerdict — the `.ad` outcome is part of the gate', () => {
  const clean = {
    reproduced: 2,
    regressed: 0,
    improved: 0,
    unverifiableNow: 0,
    judgedLane: 0,
  };

  it('gates exactly as before when there is no recording', () => {
    // Backward compatibility: every web run and every pre-recording native run.
    expect(replayVerdict(clean)).toEqual({
      verdict: 'reproduced',
      exitCode: REPLAY_EXIT_OK,
    });
    expect(replayVerdict(clean, undefined)).toEqual({
      verdict: 'reproduced',
      exitCode: REPLAY_EXIT_OK,
    });
  });

  it('stays green when the recording reproduced too', () => {
    expect(replayVerdict(clean, RECORDING())).toEqual({
      verdict: 'reproduced',
      exitCode: REPLAY_EXIT_OK,
    });
  });

  it('goes RED on a diverged recording even when every check still passes', () => {
    // This is the class of break the deterministic lane cannot see: a route
    // moved, a screen stopped mounting, the deep link stopped resolving.
    expect(replayVerdict(clean, RECORDING({ outcome: 'regressed' }))).toEqual({
      verdict: 'regressed',
      exitCode: REPLAY_EXIT_REGRESSED,
    });
  });

  it('refuses to call a run reproduced when the recording could not be re-executed', () => {
    expect(replayVerdict(clean, RECORDING({ outcome: 'unverifiable-now' }))).toEqual({
      verdict: 'incomplete',
      exitCode: REPLAY_EXIT_INCOMPLETE,
    });
  });

  it('keeps a criterion regression outranking an unverifiable recording', () => {
    const counts = { ...clean, regressed: 1 };
    expect(replayVerdict(counts, RECORDING({ outcome: 'unverifiable-now' })).verdict).toBe(
      'regressed',
    );
  });
});

describe('replayHeadline — naming the lane that actually went red', () => {
  const clean = {
    reproduced: 3,
    regressed: 0,
    improved: 0,
    unverifiableNow: 0,
    judgedLane: 0,
  };

  it('says the journey broke when the recording is the sole reason for red', () => {
    const line = replayHeadline('regressed', clean, RECORDING({ outcome: 'regressed' }));
    // "0 of 3 criteria no longer hold" would be true and useless.
    expect(line).not.toContain('0 of 3');
    expect(line).toContain('recorded on-device journey');
  });

  it('keeps the criterion wording when criteria are what regressed', () => {
    const counts = { ...clean, reproduced: 2, regressed: 1 };
    expect(replayHeadline('regressed', counts, RECORDING({ outcome: 'regressed' }))).toContain(
      '1 of 3 deterministic',
    );
  });

  it('says so when only the recording could not be re-executed', () => {
    const line = replayHeadline('incomplete', clean, RECORDING({ outcome: 'unverifiable-now' }));
    expect(line).toContain('all 3 deterministic criteria reproduced');
    expect(line).toContain('could not be re-executed');
  });

  it('credits the recording in a fully green headline', () => {
    expect(replayHeadline('reproduced', clean, RECORDING())).toContain(
      'recorded on-device journey reached its landmark again',
    );
  });

  it('is byte-identical to the pre-recording wording when there is none', () => {
    expect(replayHeadline('reproduced', clean)).toBe(
      'REPRODUCED — all 3 deterministic criteria produced their attested verdict.',
    );
  });
});

describe('formatReplay — the recording block', () => {
  const base = {
    dir: '/p/.validity/runs/r1',
    exitCode: 0,
    attestation: { ok: true, mismatches: [], warnings: [] },
    criteria: [],
    soft: [],
    counts: {
      reproduced: 1,
      regressed: 0,
      improved: 0,
      unverifiableNow: 0,
      judgedLane: 0,
    },
    llmTokens: 0 as const,
    receipt: REPLAY_RECEIPT,
    verdict: 'reproduced' as const,
    headline: 'REPRODUCED',
    spec: {
      id: 's1',
      version: 1,
      refrozen: false,
      source: 'history' as const,
      runtime: 'native' as const,
    },
  };

  it('prints the recording with its landmark notice', () => {
    const out = formatReplay({ ...base, recording: RECORDING() });
    expect(out).toContain('on-device recording');
    expect(out).toContain('replay.ad');
    expect(out).toContain('replayed to its landmark');
  });

  it('explains the absence on a native run rather than saying nothing', () => {
    const out = formatReplay(base);
    expect(out).toContain('no `.ad` replay recording');
    expect(out).toContain('native.recordReplay');
  });

  it('says nothing about recordings on a web run', () => {
    const out = formatReplay({
      ...base,
      spec: { ...base.spec, runtime: 'web' as const },
    });
    expect(out).not.toContain('.ad');
  });

  it('renders the divergence evidence, the resume line and the repair transaction', () => {
    const out = formatReplay({
      ...base,
      verdict: 'regressed',
      headline: 'REGRESSED',
      recording: RECORDING({
        outcome: 'regressed',
        notice: 'the recorded on-device journey no longer reaches its landmark',
        divergence: {
          kind: 'selector-miss',
          step: 2,
          action: 'wait id="validity-root:a1b2c3"',
          cause: { code: 'COMMAND_FAILED', message: 'wait timed out' },
          suggestions: [{ selector: 'id="validity-root:d4e5f6"', basis: 'id' }],
          suggestionCount: 3,
          resume: { allowed: true, from: 2, planDigest: 'b3d1c0ffee' },
          repairHint: 'record-and-heal',
        },
        divergenceFile: REPLAY_DIVERGENCE_FILENAME,
      }),
    });
    expect(out).toContain('diverged at step 2');
    expect(out).toContain('id="validity-root:d4e5f6"');
    expect(out).toContain('--from 3 --plan-digest b3d1c0ffee');
    // The repair is documented as a USER action — never performed.
    expect(out).toContain('repair is a USER action');
    expect(out).toContain(REPLAY_DIVERGENCE_FILENAME);
  });

  it('lists captured device evidence as advisory, with no judgement about the numbers', () => {
    const out = formatReplay({
      ...base,
      recording: RECORDING({
        keptSession: true,
        evidence: [
          {
            schema: 1,
            kind: 'perf-metrics',
            source: 'agent-device',
            command: 'agent-device perf metrics --json',
            capturedAt: T0,
            phase: 'post-interaction',
            platform: 'android',
            scoring: 'advisory-evidence-only',
            status: 'captured',
            data: { startupMs: 812 },
          },
          {
            schema: 1,
            kind: 'network-dump',
            source: 'agent-device',
            command: 'agent-device network dump --json',
            capturedAt: T0,
            phase: 'post-interaction',
            platform: 'android',
            scoring: 'advisory-evidence-only',
            status: 'unavailable',
            errorCode: 'SESSION_NOT_FOUND',
            unavailableReason: 'Run open first',
          },
        ],
        evidenceFile: REPLAY_DEVICE_EVIDENCE_FILENAME,
      }),
    });
    expect(out).toContain('advisory — nothing scores it');
    expect(out).toContain('perf-metrics: captured');
    // Absence is written down as absence, never as a healthy reading.
    expect(out).toContain('network-dump: not captured');
    expect(out).toContain('SESSION_NOT_FOUND');
  });
});

/* ------------------------------------------------------------------ *
 * The on-device lane, up close: secrets, keep-session, evidence.      *
 * ------------------------------------------------------------------ */

describe('divergenceLedgerRow', () => {
  it('carries the resume handle and the selectors, and nothing bulky', () => {
    const row = divergenceLedgerRow({
      report: {
        kind: 'selector-miss',
        step: 2,
        action: 'wait id="x"',
        cause: { code: 'COMMAND_FAILED', message: 'timed out' },
        suggestions: [
          { selector: 'id="a"', basis: 'id', ref: '@e1' },
          { selector: 'label="b"', basis: 'label' },
        ],
        resume: { allowed: true, from: 2, planDigest: 'deadbeef' },
        repairHint: 'state-repair',
        screen: { state: 'available', refs: [{ ref: '@e1' }] },
      },
      at: T0,
      dir: '/p/.validity/runs/r1',
      file: 'replay.ad',
      runId: 'r1',
      specId: 's1',
    });
    expect(row).toEqual({
      v: 1,
      ts: T0,
      runId: 'r1',
      specId: 's1',
      file: 'replay.ad',
      dir: '/p/.validity/runs/r1',
      step: 2,
      kind: 'selector-miss',
      action: 'wait id="x"',
      causeCode: 'COMMAND_FAILED',
      cause: 'timed out',
      repairHint: 'state-repair',
      resume: { allowed: true, from: 2, planDigest: 'deadbeef' },
      suggestions: ['id="a"', 'label="b"'],
    });
    // The screen digest belongs in the run-dir report, not in an append-only feed.
    expect(JSON.stringify(row)).not.toContain('screen');
  });
});

describe('replayRecordingOnDevice', () => {
  const roots: string[] = [];
  const NATIVE_CONFIG = {
    renderMode: 'native',
    framework: 'expo-native',
    wrapper: './.validity/wrapper.tsx',
    scenarios: { 'logged-in': { secrets: [{ name: 'LOGIN_PASSWORD', env: 'E2E_PW' }] } },
  } as unknown as Parameters<typeof replayRecordingOnDevice>[0]['config'];

  afterEach(() => {
    delete process.env.E2E_PW;
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  /** A signed native run whose `.ad` is exactly `ad`. */
  function nativeRun(ad: string) {
    const { root, spec } = freezeProject([HARD], 'native');
    roots.push(root);
    const runId = signRunDir(root, spec, [{ id: 'AC-1', tier: 'hard', status: 'pass' }]);
    const dir = runDir(root, runId);
    writeFileSync(resolve(dir, 'replay.ad'), ad);
    const record = attestRecording(root, runId, undefined, KEY)!;
    expect(record).not.toBeNull();
    return { root, dir, runId, record, spec };
  }

  const PLAIN_AD = 'context platform=android\nopen "app"\nwait \'id="validity-root:t1"\' 2500\n';
  const SECRET_AD =
    'context platform=android\nopen "app"\nfill \'id="password"\' "${LOGIN_PASSWORD}"\n' +
    'wait \'id="validity-root:t1"\' 2500\n';

  const ok = (over: Record<string, unknown> = {}) => ({
    outcome: 'reproduced' as const,
    notice: 'the recorded on-device journey replayed to its landmark',
    ...over,
  });

  it('forwards --keep-session and the resolved secrets to the replay', async () => {
    process.env.E2E_PW = 'hunter2';
    const { root, dir, record } = nativeRun(SECRET_AD);
    const seen: Array<Record<string, unknown>> = [];
    const res = await replayRecordingOnDevice({
      dir,
      projectRoot: root,
      platform: 'android',
      device: 'emulator-5554',
      attestation: record,
      config: NATIVE_CONFIG,
      keepSession: true,
      deps: {
        replayRecording: async (_path, ctx) => {
          seen.push(ctx as unknown as Record<string, unknown>);
          return ok();
        },
        evidenceRunner: async () => ({ code: 0, stdout: '{"success":true,"data":{}}', stderr: '' }),
      },
    });
    expect(seen[0]).toMatchObject({
      keepSession: true,
      secrets: [{ name: 'LOGIN_PASSWORD', env: 'E2E_PW', value: 'hunter2' }],
    });
    expect(res?.keptSession).toBe(true);
    expect(res?.outcome).toBe('reproduced');
  });

  it('FAILS CLOSED when the recording needs a secret the environment does not supply', async () => {
    const { root, dir, record } = nativeRun(SECRET_AD);
    let called = false;
    const res = await replayRecordingOnDevice({
      dir,
      projectRoot: root,
      platform: 'android',
      device: 'emulator-5554',
      attestation: record,
      config: NATIVE_CONFIG,
      deps: {
        replayRecording: async () => {
          called = true;
          return ok();
        },
      },
    });
    // Not run at all — a fill of the literal "${LOGIN_PASSWORD}" would produce a
    // verdict about a placeholder.
    expect(called).toBe(false);
    expect(res?.outcome).toBe('unverifiable-now');
    expect(res?.notice).toContain('LOGIN_PASSWORD (env E2E_PW)');
    expect(res?.notice).toContain('NOT executed');
  });

  it('demands nothing from a recording that carries no placeholders', async () => {
    const { root, dir, record } = nativeRun(PLAIN_AD);
    const res = await replayRecordingOnDevice({
      dir,
      projectRoot: root,
      platform: 'android',
      device: 'emulator-5554',
      attestation: record,
      config: NATIVE_CONFIG,
      deps: { replayRecording: async () => ok() },
    });
    expect(res?.outcome).toBe('reproduced');
  });

  it('persists the divergence report into the run dir AND the drift ledger', async () => {
    const { root, dir, record, runId } = nativeRun(PLAIN_AD);
    const res = await replayRecordingOnDevice({
      dir,
      projectRoot: root,
      platform: 'android',
      device: 'emulator-5554',
      attestation: record,
      config: NATIVE_CONFIG,
      specId: 's1',
      deps: {
        now: () => new Date(T0),
        replayRecording: async () => ({
          outcome: 'regressed' as const,
          notice: 'diverged',
          errorCode: 'REPLAY_DIVERGENCE',
          step: 2,
          divergence: {
            kind: 'selector-miss',
            step: 2,
            suggestions: [{ selector: 'id="new-root"', basis: 'id' }],
            resume: { allowed: true, from: 2, planDigest: 'deadbeef' },
            repairHint: 'record-and-heal' as const,
          },
        }),
      },
    });
    expect(res?.divergenceFile).toBe(REPLAY_DIVERGENCE_FILENAME);

    const persisted = JSON.parse(
      readFileSync(resolve(dir, REPLAY_DIVERGENCE_FILENAME), 'utf-8'),
    ) as Record<string, unknown>;
    expect(persisted.runId).toBe(runId);
    expect(persisted.recording).toBe('replay.ad');
    // The file SAYS it is not part of the attested set — provenance, not a footnote.
    expect(String(persisted.note)).toContain('not part of the run');

    const ledger = readFileSync(resolve(root, REPLAY_DIVERGENCE_LEDGER_PATH), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as ReplayDivergenceLedgerRow);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      v: 1,
      ts: T0,
      step: 2,
      repairHint: 'record-and-heal',
      suggestions: ['id="new-root"'],
    });
  });

  it('writes NOTHING extra when the journey reproduced', async () => {
    const { root, dir, record } = nativeRun(PLAIN_AD);
    await replayRecordingOnDevice({
      dir,
      projectRoot: root,
      platform: 'android',
      device: 'emulator-5554',
      attestation: record,
      config: NATIVE_CONFIG,
      deps: { replayRecording: async () => ok() },
    });
    expect(existsSync(resolve(dir, REPLAY_DIVERGENCE_FILENAME))).toBe(false);
    expect(existsSync(resolve(root, REPLAY_DIVERGENCE_LEDGER_PATH))).toBe(false);
    expect(existsSync(resolve(dir, REPLAY_DEVICE_EVIDENCE_FILENAME))).toBe(false);
  });

  /* ---------------------------------------------------------------- *
   * The signal bridge. The jsonl ledger is the append-only evidence   *
   * trail; the signal queue is the actionable state — and it drains,  *
   * which is the whole reason the kind exists (core owns the resolver *
   * and its fold; here we only prove the wiring).                     *
   * ---------------------------------------------------------------- */

  const diverged = (over: Record<string, unknown> = {}) => ({
    outcome: 'regressed' as const,
    notice: 'diverged',
    errorCode: 'REPLAY_DIVERGENCE',
    step: 2,
    divergence: {
      kind: 'selector-miss',
      step: 2,
      action: 'tap',
      cause: { code: 'SELECTOR_MISS', message: 'no element matched' },
      suggestions: [{ selector: 'id="new-root"', basis: 'id' }],
    },
    ...over,
  });

  it('OPENS a replay-divergence signal keyed on specId + recording, alongside the ledger', async () => {
    const { root, dir, record, runId } = nativeRun(PLAIN_AD);
    await replayRecordingOnDevice({
      dir,
      projectRoot: root,
      platform: 'android',
      device: 'emulator-5554',
      attestation: record,
      config: NATIVE_CONFIG,
      specId: 's1',
      deps: { now: () => new Date(T0), replayRecording: async () => diverged() },
    });

    const signals = loadSignals(root);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: replayDivergenceSignalId('s1', 'replay.ad'),
      kind: 'replay-divergence',
      severity: 'medium',
      specId: 's1',
      recording: 'replay.ad',
      runId,
      status: 'open',
      at: T0,
    });
    expect(signals[0]!.detail).toContain('step 2');
    // The evidence trail is untouched — additive, not a replacement.
    expect(existsSync(resolve(root, REPLAY_DIVERGENCE_LEDGER_PATH))).toBe(true);
  });

  it('a later replay of the same recording that reproduces CLOSES it', async () => {
    const { root, dir, record } = nativeRun(PLAIN_AD);
    const call = (replay: () => Promise<unknown>) =>
      replayRecordingOnDevice({
        dir,
        projectRoot: root,
        platform: 'android',
        device: 'emulator-5554',
        attestation: record,
        config: NATIVE_CONFIG,
        specId: 's1',
        deps: {
          now: () => new Date(T0),
          replayRecording: replay as Parameters<
            typeof replayRecordingOnDevice
          >[0]['deps']['replayRecording'],
        },
      });

    await call(async () => diverged());
    expect(loadSignals(root)[0]!.status).toBe('open');

    // Same journey, same recording — it holds again.
    await call(async () => ok());
    const signals = loadSignals(root);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.status).toBe('resolved');
  });

  it('a journey that could not be re-executed neither opens nor closes (no launder)', async () => {
    const { root, dir, record } = nativeRun(PLAIN_AD);
    await replayRecordingOnDevice({
      dir,
      projectRoot: root,
      platform: 'android',
      device: 'emulator-5554',
      attestation: record,
      config: NATIVE_CONFIG,
      specId: 's1',
      deps: {
        replayRecording: async () => ({
          outcome: 'unverifiable-now' as const,
          notice: 'agent-device never reached the device',
        }),
      },
    });
    expect(loadSignals(root)).toEqual([]);
  });

  it('raises no signal when the replay is not bound to a spec (nothing to hang it on)', async () => {
    const { root, dir, record } = nativeRun(PLAIN_AD);
    await replayRecordingOnDevice({
      dir,
      projectRoot: root,
      platform: 'android',
      device: 'emulator-5554',
      attestation: record,
      config: NATIVE_CONFIG,
      deps: { now: () => new Date(T0), replayRecording: async () => diverged() },
    });
    expect(loadSignals(root)).toEqual([]);
    // …but the evidence ledger still records the observation.
    expect(existsSync(resolve(root, REPLAY_DIVERGENCE_LEDGER_PATH))).toBe(true);
  });

  it('replayDivergenceSignalDetail names the step and both close paths', () => {
    const detail = replayDivergenceSignalDetail(
      {
        kind: 'selector-miss',
        step: 3,
        action: 'tap',
        cause: { code: 'SELECTOR_MISS' },
        suggestions: [],
      },
      'replay.ad',
    );
    expect(detail).toContain('step 3');
    expect(detail).toContain('SELECTOR_MISS');
    expect(detail).toContain(REPLAY_DIVERGENCE_FILENAME);
    expect(detail).toContain('reproduces');
    expect(detail).toContain('new signed recording');
  });

  it('captures perf + network evidence ONLY when the session was kept', async () => {
    const { root, dir, record } = nativeRun(PLAIN_AD);
    const commands: string[][] = [];
    const res = await replayRecordingOnDevice({
      dir,
      projectRoot: root,
      platform: 'android',
      device: 'emulator-5554',
      attestation: record,
      config: NATIVE_CONFIG,
      keepSession: true,
      deps: {
        replayRecording: async () => ok(),
        evidenceRunner: async (_bin, args) => {
          commands.push(args);
          return { code: 0, stdout: '{"success":true,"data":{"startupMs":812}}', stderr: '' };
        },
      },
    });
    expect(commands).toEqual([
      ['perf', 'metrics', '--json'],
      ['perf', 'frames', '--json'],
      ['network', 'dump', '--json'],
    ]);
    expect(res?.evidence).toHaveLength(3);
    expect(res?.evidenceFile).toBe(REPLAY_DEVICE_EVIDENCE_FILENAME);
    const bundle = JSON.parse(
      readFileSync(resolve(dir, REPLAY_DEVICE_EVIDENCE_FILENAME), 'utf-8'),
    ) as { records: Array<{ scoring: string; phase: string }> };
    // Advisory posture is stamped in the artifact, not only in the docs.
    expect(bundle.records.every((r) => r.scoring === 'advisory-evidence-only')).toBe(true);
    expect(bundle.records.every((r) => r.phase === 'post-interaction')).toBe(true);
  });

  it('spends no spawns on evidence when the session was NOT kept', async () => {
    const { root, dir, record } = nativeRun(PLAIN_AD);
    const evidenceRunner = vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const res = await replayRecordingOnDevice({
      dir,
      projectRoot: root,
      platform: 'android',
      device: 'emulator-5554',
      attestation: record,
      config: NATIVE_CONFIG,
      deps: { replayRecording: async () => ok(), evidenceRunner },
    });
    // A finished replay tears its session down; `perf metrics` would collect a
    // directory of SESSION_NOT_FOUND records that read like findings.
    expect(evidenceRunner).not.toHaveBeenCalled();
    expect(res?.evidence).toBeUndefined();
  });

  it('refuses --keep-session for a non-.ad recording, and says so alongside the outcome', async () => {
    const { root, dir, record } = nativeRun(PLAIN_AD);
    // A Maestro flow signed into the run: upstream rejects --keep-session on
    // that lane, so the flag is dropped with an explanation rather than
    // failing the replay after the device was claimed.
    record.recording!.file = 'flow.yaml';
    writeFileSync(resolve(dir, 'flow.yaml'), readFileSync(resolve(dir, 'replay.ad'), 'utf-8'));
    const seen: Array<Record<string, unknown>> = [];
    const res = await replayRecordingOnDevice({
      dir,
      projectRoot: root,
      platform: 'android',
      device: 'emulator-5554',
      attestation: record,
      config: NATIVE_CONFIG,
      keepSession: true,
      deps: {
        replayRecording: async (_p, ctx) => {
          seen.push(ctx as unknown as Record<string, unknown>);
          return ok();
        },
      },
    });
    expect(seen[0]!.keepSession).toBeUndefined();
    expect(res?.keptSession).toBeUndefined();
    expect(res?.notice).toContain('native `.ad` recordings only');
  });
});
