/**
 * Attestation chain (attest.ts) — the Part-1.1 acceptance criterion:
 * editing ONE BYTE anywhere in the chain produces a NAMED failure.
 *
 * The tamper matrix below is the point of this file. Every case asserts on the
 * mismatch's `field`, not just on `ok === false`: a verifier that says "invalid"
 * without saying WHAT is a worse reviewer tool than no verifier at all.
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTESTATION_FILENAME,
  attestKeyPath,
  attestPublicKey,
  attestRecording,
  attestReport,
  attestRun,
  buildAttestationPayload,
  canonicalRunDigest,
  hashRunScreenshots,
  loadOrCreateAttestKey,
  readAttestation,
  REPLAY_RECORDING_FILENAME,
  signRun,
  verifyAttestation,
  verifyRunAttestation,
  type AttestKeyPair,
  type AttestationRecord,
} from './attest.js';
import { runDir } from './runs.js';
import { runMetaPathFor, type RunMeta } from './run.js';

/**
 * `os.tmpdir()` is a symlink on macOS (/var → /private/var). Every path the
 * attestation relativizes must agree with the paths run-meta records, so
 * realpath the root once (same fix as the sandbox integration suite).
 */
function tempRoot(): string {
  return realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-attest-')));
}

const RUN_ID = 'run-attest-1';

function meta(over: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: RUN_ID,
    createdAt: '2026-07-30T12:00:00.000Z',
    mode: 'isolation',
    prompt: 'contact form',
    scenarios: [],
    diff: { files: [] },
    report: { enabled: true, brand: 'validity' },
    specId: 'spec-abc',
    specVersion: 2,
    specHash: 'sha256-frozen',
    scoringContractVersion: 'v1',
    git: { sha: 'a'.repeat(40), branch: 'main', dirty: false },
    verdict: 'pass',
    signedOff: true,
    scoring: { judge: 'self', selfScored: true },
    criterionVerdicts: [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      { id: 'AC-2', tier: 'soft', status: 'pass', scoredBy: { session: 'sess-1' } },
      { id: 'AC-3', tier: 'property', status: 'unverifiable', networkTainted: true },
    ],
    ...over,
  };
}

/** Materialize a run dir with run-meta + two screenshots. Returns paths. */
function seedRun(
  root: string,
  over: Partial<RunMeta> = {},
): { dir: string; metaPath: string; shotA: string; shotB: string } {
  const dir = runDir(root, RUN_ID);
  mkdirSync(resolve(dir, 'screenshots'), { recursive: true });
  const shotA = resolve(dir, 'screenshots', 'form__base.png');
  const shotB = resolve(dir, 'screenshots', 'form__empty.png');
  writeFileSync(shotA, Buffer.from('PNG-A-BYTES'));
  writeFileSync(shotB, Buffer.from('PNG-B-BYTES'));
  const m = meta({
    components: [
      {
        id: 'form',
        filePath: 'src/Form.tsx',
        screenshotPath: shotA,
      },
      {
        id: 'form',
        filePath: 'src/Form.tsx',
        screenshotPath: shotB,
        scenarioId: 'empty',
      },
    ] as RunMeta['components'],
    ...over,
  });
  const metaPath = runMetaPathFor(root, RUN_ID);
  writeFileSync(metaPath, JSON.stringify(m, null, 2));
  return { dir, metaPath, shotA, shotB };
}

/** Every mismatch field reported for a run dir. */
function fieldsFor(dir: string, root: string): string[] {
  const raw = readFileSync(runMetaPathFor(root, RUN_ID), 'utf-8');
  let parsed: RunMeta | null = null;
  try {
    parsed = JSON.parse(raw) as RunMeta;
  } catch {
    parsed = null;
  }
  return verifyRunAttestation({ dir, runMeta: parsed }).mismatches.map((m) => m.field);
}

function patchAttestation(dir: string, mutate: (r: AttestationRecord) => void): void {
  const path = resolve(dir, ATTESTATION_FILENAME);
  const record = JSON.parse(readFileSync(path, 'utf-8')) as AttestationRecord;
  mutate(record);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

let root: string;
let home: string;
const previousHome = process.env.VALIDITY_HOME;

beforeEach(() => {
  root = tempRoot();
  home = resolve(root, 'validity-home');
  process.env.VALIDITY_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.VALIDITY_HOME;
  else process.env.VALIDITY_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});

describe('keypair', () => {
  it('creates the key lazily under $VALIDITY_HOME, chmod 600', () => {
    const pair = loadOrCreateAttestKey();
    expect(attestKeyPath()).toBe(resolve(home, 'attest-key.json'));
    expect(pair.publicKey.length).toBeGreaterThan(0);
    expect(statSync(attestKeyPath()).mode & 0o777).toBe(0o600);
  });

  it('is stable across calls (never regenerates a live key)', () => {
    const a = loadOrCreateAttestKey();
    const b = loadOrCreateAttestKey();
    expect(b.privateKey).toBe(a.privateKey);
    expect(attestPublicKey()).toBe(a.publicKey);
  });

  it('never writes the private key into the attestation record', () => {
    const pair = loadOrCreateAttestKey();
    seedRun(root);
    const record = attestRun(root, RUN_ID)!;
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(pair.privateKey);
    expect(serialized).toContain(pair.publicKey);
  });

  it('regenerates from a corrupt key file rather than throwing', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(attestKeyPath(), 'not json');
    expect(() => loadOrCreateAttestKey()).not.toThrow();
    expect(loadOrCreateAttestKey().publicKey.length).toBeGreaterThan(0);
  });
});

describe('canonicalRunDigest', () => {
  it('is key-order independent (same canonicalization as computeSpecHash)', () => {
    const { dir } = seedRun(root);
    const m = JSON.parse(readFileSync(runMetaPathFor(root, RUN_ID), 'utf-8')) as RunMeta;
    const payload = buildAttestationPayload(dir, m);
    const reordered = JSON.parse(
      JSON.stringify({ screenshots: payload.screenshots, ...payload }),
    ) as typeof payload;
    expect(canonicalRunDigest(reordered)).toBe(canonicalRunDigest(payload));
  });

  it('changes when any covered fact changes', () => {
    const { dir } = seedRun(root);
    const m = JSON.parse(readFileSync(runMetaPathFor(root, RUN_ID), 'utf-8')) as RunMeta;
    const base = canonicalRunDigest(buildAttestationPayload(dir, m));
    const mutations: Array<(x: RunMeta) => void> = [
      (x) => (x.specHash = 'sha256-other'),
      (x) => (x.criterionVerdicts![0]!.status = 'fail'),
      (x) => (x.criterionVerdicts![0]!.tier = 'soft'),
      (x) => (x.criterionVerdicts![2]!.networkTainted = false),
      (x) => (x.criterionVerdicts![1]!.scoredBy = { session: 'other' }),
      (x) => (x.scoring = { judge: 'model', selfScored: false }),
      (x) => (x.git = { sha: 'b'.repeat(40), branch: 'main', dirty: false }),
      (x) => (x.createdAt = '2026-07-30T13:00:00.000Z'),
    ];
    for (const mutate of mutations) {
      const copy = JSON.parse(JSON.stringify(m)) as RunMeta;
      mutate(copy);
      expect(canonicalRunDigest(buildAttestationPayload(dir, copy))).not.toBe(base);
    }
  });

  it('hashes EVERY screenshot, including errored and skipped renders', () => {
    const { dir, shotA } = seedRun(root);
    const skipped = resolve(dir, 'screenshots', 'form__error.png');
    writeFileSync(skipped, Buffer.from('PNG-ERR'));
    const m = meta({
      components: [
        { id: 'form', filePath: 'src/Form.tsx', screenshotPath: shotA },
        {
          id: 'form',
          filePath: 'src/Form.tsx',
          screenshotPath: skipped,
          renderError: 'boom',
        },
      ] as RunMeta['components'],
    });
    const shots = hashRunScreenshots(dir, m);
    expect(shots.map((s) => s.path)).toEqual([
      'screenshots/form__base.png',
      'screenshots/form__error.png',
    ]);
    expect(shots.every((s) => typeof s.sha256 === 'string')).toBe(true);
  });

  it('records a null hash for a referenced screenshot that has no file', () => {
    const { dir, shotA } = seedRun(root);
    const m = meta({
      components: [
        { id: 'form', filePath: 'src/Form.tsx', screenshotPath: shotA },
        {
          id: 'gone',
          filePath: 'src/Gone.tsx',
          screenshotPath: resolve(dir, 'screenshots', 'gone.png'),
        },
      ] as RunMeta['components'],
    });
    expect(hashRunScreenshots(dir, m).find((s) => s.path === 'screenshots/gone.png')).toEqual({
      path: 'screenshots/gone.png',
      sha256: null,
    });
  });

  it('records screenshots run-dir-relative so the digest survives a move', () => {
    const { dir } = seedRun(root);
    const m = JSON.parse(readFileSync(runMetaPathFor(root, RUN_ID), 'utf-8')) as RunMeta;
    expect(buildAttestationPayload(dir, m).screenshots.map((s) => s.path)).toEqual([
      'screenshots/form__base.png',
      'screenshots/form__empty.png',
    ]);
  });
});

describe('sign / verify round-trip', () => {
  it('verifies under its own key', () => {
    const { dir } = seedRun(root);
    const record = attestRun(root, RUN_ID)!;
    expect(record.algorithm).toBe('ed25519');
    expect(verifyAttestation(record, record.publicKey).ok).toBe(true);
    expect(verifyRunAttestation({ dir, runMeta: readMeta(root) }).ok).toBe(true);
  });

  it('re-signing an unchanged run is byte-identical (deterministic)', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    const first = readFileSync(resolve(dir, ATTESTATION_FILENAME), 'utf-8');
    attestRun(root, RUN_ID);
    expect(readFileSync(resolve(dir, ATTESTATION_FILENAME), 'utf-8')).toBe(first);
  });

  it('re-signing after retention pruning never erases a recorded screenshot hash', () => {
    const { dir, shotA } = seedRun(root);
    const original = attestRun(root, RUN_ID)!;
    rmSync(shotA);
    // A dashboard bake-on-demand after pruning must not launder the loss away.
    expect(attestRun(root, RUN_ID)!.digest).toBe(original.digest);
    expect(fieldsFor(dir, root)).toEqual(['screenshot:screenshots/form__base.png']);
  });

  it('covers the rendered report once attestReport runs', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    writeFileSync(resolve(dir, 'report.html'), '<html>proof</html>');
    const record = attestReport(root, RUN_ID)!;
    expect(record.report?.file).toBe('report.html');
    expect(verifyRunAttestation({ dir, runMeta: readMeta(root) }).ok).toBe(true);
  });

  it('warns (does not fail) when a report exists but was never signed', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    writeFileSync(resolve(dir, 'report.html'), '<html>unsigned</html>');
    const result = verifyRunAttestation({ dir, runMeta: readMeta(root) });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.field)).toContain('report:report.html');
  });
});

function readMeta(projectRoot: string): RunMeta | null {
  try {
    return JSON.parse(readFileSync(runMetaPathFor(projectRoot, RUN_ID), 'utf-8')) as RunMeta;
  } catch {
    return null;
  }
}

describe('tamper matrix — one byte anywhere produces a NAMED failure', () => {
  it('run-meta byte edit: a flipped verdict is named by criterion and field', () => {
    const { dir, metaPath } = seedRun(root);
    attestRun(root, RUN_ID);
    const raw = readFileSync(metaPath, 'utf-8');
    const edited = raw.replace(/("id": "AC-1",\s*"tier": "hard",\s*"status": )"pass"/, '$1"fail"');
    expect(edited).not.toBe(raw);
    writeFileSync(metaPath, edited);
    expect(fieldsFor(dir, root)).toContain('run-meta:criteria[AC-1].status');
  });

  it('run-meta byte edit: a changed commit sha is named', () => {
    const { dir, metaPath } = seedRun(root);
    attestRun(root, RUN_ID);
    writeFileSync(
      metaPath,
      readFileSync(metaPath, 'utf-8').replace('a'.repeat(40), 'b'.repeat(40)),
    );
    expect(fieldsFor(dir, root)).toContain('run-meta:commitSha');
  });

  it('run-meta byte edit: a laundered taint is named', () => {
    const { dir, metaPath } = seedRun(root);
    attestRun(root, RUN_ID);
    writeFileSync(
      metaPath,
      readFileSync(metaPath, 'utf-8').replace('"networkTainted": true', '"networkTainted": false'),
    );
    expect(fieldsFor(dir, root)).toContain('run-meta:criteria[AC-3].taints');
  });

  it('run-meta byte edit: a laundered self-scored flag is named', () => {
    const { dir, metaPath } = seedRun(root);
    attestRun(root, RUN_ID);
    writeFileSync(
      metaPath,
      readFileSync(metaPath, 'utf-8').replace('"selfScored": true', '"selfScored": false'),
    );
    expect(fieldsFor(dir, root)).toContain('run-meta:scoring');
  });

  it('run-meta byte edit: an ADDED criterion is named', () => {
    const { dir, metaPath } = seedRun(root);
    attestRun(root, RUN_ID);
    const m = readMeta(root)!;
    m.criterionVerdicts!.push({ id: 'AC-9', tier: 'hard', status: 'pass' });
    writeFileSync(metaPath, JSON.stringify(m, null, 2));
    expect(fieldsFor(dir, root)).toContain('run-meta:criteria[AC-9]');
  });

  it('run-meta byte edit: a REMOVED criterion is named', () => {
    const { dir, metaPath } = seedRun(root);
    attestRun(root, RUN_ID);
    const m = readMeta(root)!;
    m.criterionVerdicts = m.criterionVerdicts!.filter((v) => v.id !== 'AC-3');
    writeFileSync(metaPath, JSON.stringify(m, null, 2));
    expect(fieldsFor(dir, root)).toContain('run-meta:criteria[AC-3]');
  });

  it('run-meta deleted entirely is named', () => {
    const { dir, metaPath } = seedRun(root);
    attestRun(root, RUN_ID);
    rmSync(metaPath);
    expect(verifyRunAttestation({ dir, runMeta: null }).mismatches.map((m) => m.field)).toContain(
      'run-meta.json',
    );
  });

  it('screenshot byte edit is named by file path', () => {
    const { dir, shotB } = seedRun(root);
    attestRun(root, RUN_ID);
    appendFileSync(shotB, '!');
    const fields = fieldsFor(dir, root);
    expect(fields).toEqual(['screenshot:screenshots/form__empty.png']);
  });

  it('a deleted screenshot is named by file path', () => {
    const { dir, shotA } = seedRun(root);
    attestRun(root, RUN_ID);
    rmSync(shotA);
    expect(fieldsFor(dir, root)).toContain('screenshot:screenshots/form__base.png');
  });

  it('a screenshot added to run-meta after signing is named', () => {
    const { dir, metaPath } = seedRun(root);
    attestRun(root, RUN_ID);
    const extra = resolve(dir, 'screenshots', 'sneaky.png');
    writeFileSync(extra, Buffer.from('PNG-NEW'));
    const m = readMeta(root)!;
    m.components!.push({
      id: 'sneaky',
      filePath: 'src/Sneaky.tsx',
      screenshotPath: extra,
    } as NonNullable<RunMeta['components']>[number]);
    writeFileSync(metaPath, JSON.stringify(m, null, 2));
    expect(fieldsFor(dir, root)).toContain('screenshot:screenshots/sneaky.png');
  });

  it('report byte edit is named by file', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    const reportPath = resolve(dir, 'report.html');
    writeFileSync(reportPath, '<html>PASS</html>');
    attestReport(root, RUN_ID);
    writeFileSync(reportPath, '<html>PASS!</html>');
    expect(fieldsFor(dir, root)).toContain('report:report.html');
  });

  it('attestation field edit (payload) breaks the self-digest', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    patchAttestation(dir, (r) => {
      r.payload.criteria[0]!.status = 'fail';
    });
    const fields = fieldsFor(dir, root);
    expect(fields).toContain('attestation.digest');
    // The forged payload also no longer matches run-meta — named on both sides.
    expect(fields).toContain('run-meta:criteria[AC-1].status');
  });

  it('attestation field edit (digest) breaks the signature', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    patchAttestation(dir, (r) => {
      r.digest = `sha256-${'0'.repeat(64)}`;
    });
    const fields = fieldsFor(dir, root);
    expect(fields).toContain('attestation.digest');
    expect(fields).toContain('attestation.signature');
  });

  it('attestation field edit (screenshot hash) is named on both sides', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    patchAttestation(dir, (r) => {
      r.payload.screenshots[0]!.sha256 = '0'.repeat(64);
    });
    const fields = fieldsFor(dir, root);
    expect(fields).toContain('attestation.digest');
    expect(fields).toContain('screenshot:screenshots/form__base.png');
  });

  it('a missing attestation.json is itself a named failure', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    rmSync(resolve(dir, ATTESTATION_FILENAME));
    expect(fieldsFor(dir, root)).toEqual(['attestation.json']);
  });

  it('an unsupported algorithm is refused outright', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    patchAttestation(dir, (r) => {
      r.algorithm = 'md5' as AttestationRecord['algorithm'];
    });
    expect(fieldsFor(dir, root)).toEqual(['attestation.algorithm']);
  });

  it('wrong public key: a valid record fails under a foreign key', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    const foreign = foreignKey();
    const result = verifyRunAttestation({
      dir,
      runMeta: readMeta(root),
      publicKey: foreign.publicKey,
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((m) => m.field)).toContain('attestation.signature');
    expect(result.warnings.map((w) => w.field)).toContain('attestation.publicKey');
  });

  it('wrong public key: a record re-signed by another machine fails', () => {
    seedRun(root);
    const record = attestRun(root, RUN_ID)!;
    const forged = signRun(record.payload, foreignKey());
    expect(verifyAttestation(forged, record.publicKey).mismatches.map((m) => m.field)).toEqual([
      'attestation.signature',
    ]);
  });

  it('wrong public key: swapping only the embedded key fails the signature', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    patchAttestation(dir, (r) => {
      r.publicKey = foreignKey().publicKey;
    });
    expect(fieldsFor(dir, root)).toEqual(['attestation.signature']);
  });

  it('report signature forged by another key is named', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    writeFileSync(resolve(dir, 'report.html'), '<html>proof</html>');
    attestReport(root, RUN_ID, undefined, foreignKey());
    expect(fieldsFor(dir, root)).toContain('report.signature');
  });

  it('an untouched run stays clean through the whole matrix helper', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    writeFileSync(resolve(dir, 'report.html'), '<html>proof</html>');
    attestReport(root, RUN_ID);
    expect(fieldsFor(dir, root)).toEqual([]);
    expect(readAttestation(dir)?.report?.sha256).toBeTruthy();
  });
});

/** A second machine's keypair — never written to $VALIDITY_HOME. */
function foreignKey(): AttestKeyPair {
  const previous = process.env.VALIDITY_HOME;
  process.env.VALIDITY_HOME = resolve(root, 'foreign-home');
  try {
    return loadOrCreateAttestKey();
  } finally {
    if (previous === undefined) delete process.env.VALIDITY_HOME;
    else process.env.VALIDITY_HOME = previous;
  }
}

describe('specCheck hook', () => {
  it('surfaces caller-supplied spec mismatches and warnings', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    const result = verifyRunAttestation({
      dir,
      runMeta: readMeta(root),
      specCheck: (payload) => ({
        mismatches: [{ field: `spec:${payload.specId}`, detail: 'edited in place' }],
        warnings: [{ field: 'spec:note', detail: 'moved on' }],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.mismatches.map((m) => m.field)).toEqual(['spec:spec-abc']);
    expect(result.warnings.map((w) => w.field)).toEqual(['spec:note']);
  });
});
/* ------------------------------------------------------------------ *
 * Third signature: the `.ad` replay recording.                        *
 * ------------------------------------------------------------------ */

describe('attestRecording — the native `.ad` replay script', () => {
  const AD_BYTES = 'context platform=android\nopen "validity://…" \nwait id="validity-root:t1"\n';

  const seedRecording = (dir: string, bytes = AD_BYTES): string => {
    const path = resolve(dir, REPLAY_RECORDING_FILENAME);
    writeFileSync(path, bytes);
    return path;
  };

  it('signs the recording as a THIRD signature, leaving the payload digest alone', () => {
    // The whole point of keeping it out of the payload: adding it there would
    // change `canonicalRunDigest` for every run ever signed.
    const { dir } = seedRun(root);
    const before = attestRun(root, RUN_ID)!;
    seedRecording(dir);
    const after = attestRecording(root, RUN_ID)!;
    expect(after.digest).toBe(before.digest);
    expect(after.signature).toBe(before.signature);
    expect(after.recording?.file).toBe(REPLAY_RECORDING_FILENAME);
    expect(after.recording?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies clean, and reports nothing about a run that simply has one', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    seedRecording(dir);
    attestRecording(root, RUN_ID);
    const res = verifyRunAttestation({
      dir,
      runMeta: JSON.parse(readFileSync(runMetaPathFor(root, RUN_ID), 'utf-8')) as RunMeta,
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.map((w) => w.field)).not.toContain(
      `recording:${REPLAY_RECORDING_FILENAME}`,
    );
  });

  it('names the file when ONE byte of the recording changes', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    const path = seedRecording(dir);
    attestRecording(root, RUN_ID);
    // A reviewer's device would otherwise be driven by an edited script.
    writeFileSync(path, `${AD_BYTES}press id="delete-everything"\n`);
    expect(fieldsFor(dir, root)).toContain(`recording:${REPLAY_RECORDING_FILENAME}`);
  });

  it('names the signature when the recording hash is re-stamped to match an edit', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    const path = seedRecording(dir);
    attestRecording(root, RUN_ID);
    writeFileSync(path, 'tampered');
    // The forger updates the recorded hash so the bytes match again — the
    // signature over that hash is what catches it.
    patchAttestation(dir, (r) => {
      r.recording!.sha256 = createHash('sha256').update('tampered').digest('hex');
    });
    expect(fieldsFor(dir, root)).toContain('recording.signature');
  });

  it('names the file when an attested recording is deleted', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    const path = seedRecording(dir);
    attestRecording(root, RUN_ID);
    rmSync(path);
    const fields = fieldsFor(dir, root);
    expect(fields).toContain(`recording:${REPLAY_RECORDING_FILENAME}`);
  });

  it('WARNS about an unsigned `.ad` sitting in the run dir', () => {
    // Something put a device script there that Validity never signed. Not
    // tampering with the run's own evidence, so not a mismatch — but replay
    // will refuse to execute it, and a reader should know why.
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    seedRecording(dir);
    const res = verifyRunAttestation({
      dir,
      runMeta: JSON.parse(readFileSync(runMetaPathFor(root, RUN_ID), 'utf-8')) as RunMeta,
    });
    expect(res.ok).toBe(true);
    expect(res.warnings.map((w) => w.field)).toContain(`recording:${REPLAY_RECORDING_FILENAME}`);
  });

  it('is a no-op when there is no recording — the web/no-record path', () => {
    // BACKWARD COMPATIBILITY. Every run written before recordings existed, and
    // every web run, must verify exactly as before.
    const { dir } = seedRun(root);
    const record = attestRun(root, RUN_ID)!;
    expect(attestRecording(root, RUN_ID)).toBeNull();
    const onDisk = readAttestation(dir)!;
    expect(onDisk.recording).toBeUndefined();
    expect(onDisk.digest).toBe(record.digest);
    const res = verifyRunAttestation({
      dir,
      runMeta: JSON.parse(readFileSync(runMetaPathFor(root, RUN_ID), 'utf-8')) as RunMeta,
    });
    expect(res.ok).toBe(true);
    expect(res.mismatches).toEqual([]);
  });

  it('verifies a record written before recordings existed', () => {
    // Simulate an older attestation.json: signed payload, no `recording` key.
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    patchAttestation(dir, (r) => {
      delete (r as { recording?: unknown }).recording;
    });
    const res = verifyRunAttestation({
      dir,
      runMeta: JSON.parse(readFileSync(runMetaPathFor(root, RUN_ID), 'utf-8')) as RunMeta,
    });
    expect(res.ok).toBe(true);
  });

  it('CARRIES the recording signature through a re-attest', () => {
    // Nothing re-produces a `.ad` after capture — not the dashboard's
    // bake-on-demand, not a re-judge, not a watch tick. Dropping it on re-sign
    // (as the report signature is deliberately dropped) would silently disarm
    // `validity replay` on every native run whose report got re-baked.
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    seedRecording(dir);
    const signed = attestRecording(root, RUN_ID)!;
    const resigned = attestRun(root, RUN_ID)!;
    expect(resigned.recording).toEqual(signed.recording);
  });

  it('drops a carried-forward signature once the recording bytes change', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    const path = seedRecording(dir);
    attestRecording(root, RUN_ID);
    writeFileSync(path, 'edited out of band');
    const resigned = attestRun(root, RUN_ID)!;
    // Carrying a signature over bytes that no longer match would be a lie.
    expect(resigned.recording).toBeUndefined();
  });

  it('signs a recording at an explicit path outside the default name', () => {
    const { dir } = seedRun(root);
    attestRun(root, RUN_ID);
    const path = resolve(dir, 'custom.ad');
    writeFileSync(path, AD_BYTES);
    const record = attestRecording(root, RUN_ID, path)!;
    expect(record.recording?.file).toBe('custom.ad');
  });

  it('returns null rather than throwing when there is no attestation to patch', () => {
    const { dir } = seedRun(root);
    seedRecording(dir);
    expect(attestRecording(root, RUN_ID)).toBeNull();
  });
});
