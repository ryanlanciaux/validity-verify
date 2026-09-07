/**
 * Attestation chain — makes a run's evidence tamper-EVIDENT.
 *
 * A run dir is a pile of plain files (run-meta.json, screenshots/*.png,
 * report.html). Nothing stopped a reader — or the agent that produced them —
 * from editing a verdict after the fact, which is exactly the objection the
 * product has to answer ("the agent grades its own work"). This module signs
 * the run's decisive facts with a per-machine Ed25519 key so any later edit is
 * detectable by `validity attest verify`.
 *
 * WHAT IT PROVES: "these bytes are unmodified since Validity wrote them."
 * WHAT IT DOES NOT PROVE: who ran it. This is deliberately NOT PKI — there is
 * no identity, no CA, no revocation. Per-machine keypair, nothing more.
 *
 * Three signatures, in this order, because the report EMBEDS the first one:
 *
 *   1. `signature`           — over the canonical digest of the run payload
 *                              (verdicts + screenshot hashes + commit + times).
 *   2. `report.signature`    — over the sha256 of the rendered report.html,
 *                              attached AFTER the report is written (the report's
 *                              footer prints signature #1, so it cannot be inside
 *                              the payload without a cycle).
 *   3. `recording.signature` — over the sha256 of the native `.ad` replay
 *                              recording, when the run produced one.
 *
 * Signatures 2 and 3 live OUTSIDE the payload on purpose: adding either to the
 * payload would change `canonicalRunDigest` for every run, and a run that
 * predates them (or simply has no recording) would then fail to verify. Runs
 * without a recording verify exactly as they did before this field existed.
 *
 * All three are deterministic: Ed25519 signatures are deterministic (RFC 8032) and
 * every payload field is derived from files on disk, so re-attesting an
 * unchanged run rewrites byte-identical JSON.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { stableStringify } from './specs.js';
import {
  evidenceTaintsOf,
  type CriterionTier,
  type EvidenceTaint,
  type ScorerProvenance,
} from './spec-schema.js';
import { runDir } from './runs.js';
import { runMetaPathFor, type RunMeta } from './run.js';
import { supersedeReplayDivergence } from './replay-divergence.js';
import { hash } from './util.js';

/** Bumping this changes every newly written digest — it is inside the payload. */
export const ATTESTATION_VERSION = 1;

/** File names inside a run dir. Exported so the CLI/MCP never re-spell them. */
export const ATTESTATION_FILENAME = 'attestation.json';
const REPORT_FILENAME = 'report.html';
/**
 * The agent-device `.ad` session script a native verify records into its run
 * dir (see `@validity.ai/verify-native`'s replay-recording module). Named here because
 * `attestRun`/`verifyRunAttestation` must find it without importing the native
 * package — core does not depend on native.
 */
export const REPLAY_RECORDING_FILENAME = 'replay.ad';

// ---------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------

/** One criterion's decisive facts. Ids and tiers only — never criterion text. */
export interface AttestedCriterion {
  id: string;
  tier: CriterionTier;
  status: 'pass' | 'fail' | 'unverifiable';
  /** Normalized through `evidenceTaintsOf` (legacy `networkTainted` folded in), sorted. */
  taints: EvidenceTaint[];
  /** SOFT only — who scored it (model id + MCP session fingerprint). */
  scoredBy?: ScorerProvenance;
}

/**
 * One screenshot the run referenced. `sha256` is `null` when no file existed at
 * attest time (an errored/skipped render) — recorded rather than omitted so a
 * file APPEARING later is itself a detectable change.
 */
export interface AttestedScreenshot {
  /** Run-dir-relative POSIX path when the file lives under the run dir, else absolute. */
  path: string;
  sha256: string | null;
}

/** The signed subject. Everything here is derived from files on disk. */
export interface AttestationPayload {
  attestVersion: number;
  runId: string;
  /** Run creation timestamp — the "when" the digest binds. */
  createdAt: string;
  specId?: string;
  specVersion?: number;
  specHash?: string;
  scoringContractVersion?: string;
  commitSha?: string;
  branch?: string;
  /** Working tree was dirty at capture time — provenance, not a gate. */
  dirty?: boolean;
  mode?: 'isolation' | 'url' | 'native';
  origin?: string;
  verdict?: 'pass' | 'fail' | 'partial' | 'unverifiable';
  signedOff?: boolean;
  scoring?: {
    judge: string;
    scoredBy?: string;
    selfScored?: boolean;
    judgeModel?: string;
  };
  /** Sorted by id. */
  criteria: AttestedCriterion[];
  /** Sorted by path. */
  screenshots: AttestedScreenshot[];
}

/** The signature over the rendered report bytes (attached after the render). */
export interface AttestedReport {
  file: string;
  sha256: string;
  signature: string;
}

/**
 * The signature over a native run's `.ad` replay recording. Same three fields
 * as {@link AttestedReport} and the same convention (Ed25519 over the ASCII
 * bytes of the file's sha256) — a separate type only so the two cannot be
 * assigned to each other by accident, because they answer different questions:
 * the report is what a reader SEES, the recording is what a reviewer RE-RUNS.
 *
 * `validity replay` refuses to execute a recording whose signature is absent or
 * does not verify. That is the whole point of signing it: replaying an
 * unattested `.ad` would hand an arbitrary on-disk script the device.
 */
export interface AttestedRecording {
  file: string;
  sha256: string;
  signature: string;
}

export interface AttestationRecord {
  version: number;
  algorithm: 'ed25519';
  payload: AttestationPayload;
  /** `sha256-<hex>` over the canonicalized payload. */
  digest: string;
  /** base64 Ed25519 signature over the ASCII bytes of `digest`. */
  signature: string;
  /** base64 SPKI DER public key. */
  publicKey: string;
  report?: AttestedReport;
  /** Native runs only, and only when a `.ad` recording was produced. */
  recording?: AttestedRecording;
}

export interface AttestKeyPair {
  /** base64 SPKI DER. */
  publicKey: string;
  /** base64 PKCS8 DER. NEVER logged, never leaves this process. */
  privateKey: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

/** `$VALIDITY_HOME/attest-key.json`, else `~/.validity/attest-key.json`. */
export function attestKeyPath(): string {
  const root = process.env.VALIDITY_HOME ?? resolve(homedir(), '.validity');
  return resolve(root, 'attest-key.json');
}

/**
 * Load the per-machine keypair, generating it on first use. The private key is
 * chmod 600 and is never returned to any surface that renders or logs — only
 * `signRun` reads it.
 */
export function loadOrCreateAttestKey(): AttestKeyPair {
  const path = attestKeyPath();
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      if (typeof raw.publicKey === 'string' && typeof raw.privateKey === 'string') {
        return {
          publicKey: raw.publicKey,
          privateKey: raw.privateKey,
          createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
        };
      }
    } catch {
      // Corrupt key file — fall through and regenerate. Old attestations then
      // fail signature verification, which is the honest outcome: we can no
      // longer prove anything about them.
    }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pair: AttestKeyPair = {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    createdAt: new Date().toISOString(),
  };
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
  }
  writeFileSync(path, JSON.stringify(pair, null, 2));
  chmodSync(path, 0o600);
  return pair;
}

/** The public half only — safe to print (`validity doctor`) and to embed. */
export function attestPublicKey(): string {
  return loadOrCreateAttestKey().publicKey;
}

/** Short, human-comparable form of a base64 key or signature. */
export function shortId(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function publicKeyObject(base64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
}

function privateKeyObject(base64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' });
}

// ---------------------------------------------------------------------------
// Generic digest signing
//
// The two primitives below are the whole crypto surface of this module,
// factored out so anything else that has to sign or check a Validity digest
// reuses the EXACT convention rather than re-deriving it: Ed25519 over the ASCII bytes of
// a `sha256-<hex>` digest string, base64 signature, base64 SPKI DER public key.
// Getting the "what exactly is signed" question wrong in a second place is how
// signature schemes quietly become decorative.
// ---------------------------------------------------------------------------

/** Sign the ASCII bytes of a digest string. Returns a base64 signature. */
export function signDigestWithKey(digest: string, privateKeyBase64: string): string {
  return cryptoSign(
    null,
    Buffer.from(digest, 'utf-8'),
    privateKeyObject(privateKeyBase64),
  ).toString('base64');
}

/**
 * Check a base64 Ed25519 signature over the ASCII bytes of a digest string.
 * Never throws — a malformed key, a malformed signature, and a wrong signature
 * are all just `false`, because to a verifier they mean the same thing.
 */
export function verifyDigestSignature(
  digest: string,
  signature: string,
  publicKeyBase64: string,
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(digest, 'utf-8'),
      publicKeyObject(publicKeyBase64),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * sha256 over the canonicalized payload, using the SAME deep key-sort
 * serializer as `computeSpecHash` (`specs.ts`) so spec hashing and run
 * attestation can never drift apart in their notion of "canonical".
 */
export function canonicalRunDigest(payload: AttestationPayload): string {
  return `sha256-${hash(stableStringify(payload))}`;
}

/** sha256 of a file's bytes, or null when unreadable/absent. */
export function sha256File(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Every screenshot path the run references — isolation renders AND url-mode
 * pages, INCLUDING errored/skipped/unconfirmed ones. Deliberately wider than
 * `stampScreenshotHashes` / `hardeningEvidenceFromMeta`, which only hash
 * EVIDENCE renders: the attestation covers the whole artifact set, so a
 * swapped "failed render" screenshot is caught too.
 */
export function runScreenshotPaths(meta: RunMeta): string[] {
  const out: string[] = [];
  for (const c of meta.components ?? []) if (c.screenshotPath) out.push(c.screenshotPath);
  for (const p of meta.pages ?? []) if (p.screenshotPath) out.push(p.screenshotPath);
  return [...new Set(out)];
}

/**
 * Portable form of a screenshot path: run-dir-relative POSIX when it lives
 * under the run dir (the normal case), else the path as-is. Keeps the digest
 * stable when the project is moved or cloned to another machine.
 */
export function relativizeScreenshotPath(dir: string, path: string): string {
  const abs = isAbsolute(path) ? path : resolve(dir, path);
  const rel = relative(dir, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return path;
  return rel.split(sep).join('/');
}

/** Resolve a recorded screenshot path back to an absolute file path. */
export function resolveScreenshotPath(dir: string, recorded: string): string {
  return isAbsolute(recorded) ? recorded : resolve(dir, recorded.split('/').join(sep));
}

/** Hash every screenshot the run references, in a stable path order. */
export function hashRunScreenshots(dir: string, meta: RunMeta): AttestedScreenshot[] {
  return runScreenshotPaths(meta)
    .map((p) => ({
      path: relativizeScreenshotPath(dir, p),
      sha256: sha256File(isAbsolute(p) ? p : resolve(dir, p)),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Project a run-meta (+ the screenshots on disk beside it) onto the signed
 * payload. Pure apart from reading the screenshot bytes.
 */
export function buildAttestationPayload(dir: string, meta: RunMeta): AttestationPayload {
  const criteria: AttestedCriterion[] = (meta.criterionVerdicts ?? [])
    .map((v) => ({
      id: v.id,
      tier: v.tier,
      status: v.status,
      taints: [...evidenceTaintsOf(v)].sort(),
      ...(v.scoredBy ? { scoredBy: v.scoredBy } : {}),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    attestVersion: ATTESTATION_VERSION,
    runId: meta.runId,
    createdAt: meta.createdAt,
    specId: meta.specId,
    specVersion: meta.specVersion,
    specHash: meta.specHash,
    scoringContractVersion: meta.scoringContractVersion,
    commitSha: meta.git?.sha,
    branch: meta.git?.branch,
    dirty: meta.git?.dirty,
    mode: meta.mode,
    origin: meta.origin,
    verdict: meta.verdict,
    signedOff: meta.signedOff,
    scoring: meta.scoring
      ? {
          judge: meta.scoring.judge,
          scoredBy: meta.scoring.scoredBy,
          selfScored: meta.scoring.selfScored,
          judgeModel: meta.scoring.judgeModel,
        }
      : undefined,
    criteria,
    screenshots: hashRunScreenshots(dir, meta),
  };
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

const signDigest = signDigestWithKey;

/** Sign a payload with the per-machine key (or an explicit one, for tests). */
export function signRun(payload: AttestationPayload, key?: AttestKeyPair): AttestationRecord {
  const pair = key ?? loadOrCreateAttestKey();
  const digest = canonicalRunDigest(payload);
  return {
    version: ATTESTATION_VERSION,
    algorithm: 'ed25519',
    payload,
    digest,
    signature: signDigest(digest, pair.privateKey),
    publicKey: pair.publicKey,
  };
}

/** A named failure. `field` is what to print; `detail` is the human line. */
export interface AttestationMismatch {
  field: string;
  detail: string;
}

export interface AttestationCheck {
  ok: boolean;
  mismatches: AttestationMismatch[];
}

/**
 * Cryptographic layer ONLY: does the record's digest match its own payload,
 * and does the signature verify under `publicKey`? Callers pass the key they
 * TRUST — passing `record.publicKey` proves self-consistency, not provenance.
 */
export function verifyAttestation(record: AttestationRecord, publicKey: string): AttestationCheck {
  const mismatches: AttestationMismatch[] = [];
  if (record.algorithm !== 'ed25519') {
    mismatches.push({
      field: 'attestation.algorithm',
      detail: `unsupported signature algorithm "${record.algorithm}" (expected ed25519)`,
    });
    return { ok: false, mismatches };
  }
  const recomputed = canonicalRunDigest(record.payload);
  if (recomputed !== record.digest) {
    mismatches.push({
      field: 'attestation.digest',
      detail: `attestation.json payload does not hash to its recorded digest (recorded ${record.digest}, actual ${recomputed}) — the attestation file was edited`,
    });
  }
  const signatureOk = verifyDigestSignature(record.digest, record.signature, publicKey);
  if (!signatureOk) {
    mismatches.push({
      field: 'attestation.signature',
      detail: `signature does not verify under public key ${shortId(publicKey)} — the attestation was re-written, or it was signed by a different machine`,
    });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Verify one out-of-payload file signature: the bytes still hash to what was
 * signed, AND the signature over that hash verifies. Shared by the report and
 * the `.ad` recording so the two can never drift in what they check — only in
 * what they NAME, which is what `kind` supplies.
 */
function verifyFileSignature(
  kind: 'report' | 'recording',
  artifact: AttestedReport | AttestedRecording,
  actualSha256: string | null,
  publicKey: string,
): AttestationCheck {
  const mismatches: AttestationMismatch[] = [];
  if (actualSha256 === null) {
    mismatches.push({
      field: `${kind}:${artifact.file}`,
      detail: `${artifact.file} is attested but missing from the run dir`,
    });
    return { ok: false, mismatches };
  }
  if (actualSha256 !== artifact.sha256) {
    mismatches.push({
      field: `${kind}:${artifact.file}`,
      detail: `${artifact.file} bytes changed since it was signed (attested sha256 ${artifact.sha256}, actual ${actualSha256})`,
    });
  }
  const ok = verifyDigestSignature(artifact.sha256, artifact.signature, publicKey);
  if (!ok) {
    mismatches.push({
      field: `${kind}.signature`,
      detail: `the ${kind} signature does not verify under public key ${shortId(publicKey)}`,
    });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Verify the second signature — the one over the rendered report bytes. */
export function verifyReportSignature(
  report: AttestedReport,
  actualSha256: string | null,
  publicKey: string,
): AttestationCheck {
  return verifyFileSignature('report', report, actualSha256, publicKey);
}

/**
 * Verify the third signature — the one over the `.ad` replay recording.
 *
 * `validity replay` calls this DIRECTLY (not just as part of the full-chain
 * check) before handing the file to `agent-device replay`, because "the run's
 * chain is intact" and "this specific script is the one Validity wrote" are
 * different claims and only the second one licenses execution.
 */
export function verifyRecordingSignature(
  recording: AttestedRecording,
  actualSha256: string | null,
  publicKey: string,
): AttestationCheck {
  return verifyFileSignature('recording', recording, actualSha256, publicKey);
}

// ---------------------------------------------------------------------------
// Disk I/O for a run dir
// ---------------------------------------------------------------------------

export function attestationPathFor(projectRoot: string, runId: string): string {
  return resolve(runDir(projectRoot, runId), ATTESTATION_FILENAME);
}

export function readAttestation(dir: string): AttestationRecord | null {
  try {
    const raw = readFileSync(resolve(dir, ATTESTATION_FILENAME), 'utf-8');
    const parsed = JSON.parse(raw) as AttestationRecord;
    if (!parsed || typeof parsed !== 'object' || !parsed.payload || !parsed.digest) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeAttestation(dir: string, record: AttestationRecord): void {
  writeFileSync(resolve(dir, ATTESTATION_FILENAME), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Sign a run's meta + screenshots and write `attestation.json` beside
 * `run-meta.json`. Idempotent and byte-stable: an unchanged run re-signs to the
 * identical file, so the dashboard's bake-on-demand can call this freely.
 *
 * Best-effort by contract — the caller must never fail a report write because
 * signing failed. Returns null when there was nothing to sign.
 */
export function attestRun(
  projectRoot: string,
  runId: string,
  key?: AttestKeyPair,
): AttestationRecord | null {
  try {
    const dir = runDir(projectRoot, runId);
    if (!existsSync(dir)) return null;
    // Sign what is ON DISK, never a caller's in-memory copy: the verifier reads
    // the file, so signing anything else would produce an attestation that can
    // never verify.
    const meta = readRunMetaAt(runMetaPathFor(projectRoot, runId));
    if (!meta) return null;
    const payload = buildAttestationPayload(dir, meta);
    // LAUNDERING GUARD: retention pruning deletes PNGs, and the dashboard bakes
    // reports on demand — so a re-sign after pruning would quietly replace
    // "this screenshot hashed to X" with "there was no file", erasing the only
    // record that the evidence ever existed. Keep the stronger prior claim; the
    // verifier then correctly reports the file as missing.
    const prior = readAttestation(dir);
    if (prior && dropsScreenshotEvidence(prior.payload, payload)) return prior;
    // Any prior report signature is deliberately dropped: every caller of this
    // function goes on to (re-)render the report and call `attestReport`, so
    // carrying the old one forward could leave a signature over stale bytes.
    const record = signRun(payload, key);
    // The RECORDING is the opposite case and must be carried forward. Nothing
    // re-produces a `.ad` after capture — it is written once, by the device
    // session, and no later caller (the dashboard's bake-on-demand, a re-judge,
    // `watch`) can recreate it. Dropping it here would silently disarm
    // `validity replay` on every native run the moment its report was re-baked.
    //
    // Carried forward ONLY while the bytes still match what was signed: the
    // signature is over the file's sha256, so re-hashing is a complete check.
    // A recording that changed under us loses its signature, which is exactly
    // what the verifier should then report — an unsigned script, not a valid
    // one.
    if (prior?.recording) {
      const abs = resolveScreenshotPath(dir, prior.recording.file);
      if (sha256File(abs) === prior.recording.sha256) record.recording = prior.recording;
    }
    writeAttestation(dir, record);
    return record;
  } catch {
    return null;
  }
}

/** True when re-signing would turn a recorded screenshot hash into "no file". */
function dropsScreenshotEvidence(prior: AttestationPayload, next: AttestationPayload): boolean {
  const nextByPath = new Map(next.screenshots.map((s) => [s.path, s.sha256]));
  return prior.screenshots.some(
    (s) => s.sha256 !== null && nextByPath.has(s.path) && nextByPath.get(s.path) === null,
  );
}

function readRunMetaAt(path: string): RunMeta | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RunMeta;
  } catch {
    return null;
  }
}

/**
 * Second half of the chain: hash the rendered report and sign THAT, then patch
 * it into the existing attestation.json. Called after the report is written —
 * the report's footer prints the payload signature, so the report cannot be
 * inside the payload. Best-effort.
 */
export function attestReport(
  projectRoot: string,
  runId: string,
  reportPath?: string,
  key?: AttestKeyPair,
): AttestationRecord | null {
  try {
    const dir = runDir(projectRoot, runId);
    const record = readAttestation(dir);
    if (!record) return null;
    const abs = reportPath ?? resolve(dir, REPORT_FILENAME);
    const sha256 = sha256File(abs);
    if (!sha256) return null;
    const pair = key ?? loadOrCreateAttestKey();
    record.report = {
      file: relativizeScreenshotPath(dir, abs),
      sha256,
      signature: signDigest(sha256, pair.privateKey),
    };
    writeAttestation(dir, record);
    return record;
  } catch {
    return null;
  }
}

/**
 * Third link in the chain: hash the `.ad` replay recording and sign THAT, then
 * patch it into the existing attestation.json. Called by the native capture as
 * soon as the recording is published — BEFORE the report render, so a later
 * `attestRun` re-sign finds it on disk and carries it forward.
 *
 * Best-effort by the same contract as {@link attestReport}: a native verify
 * must never fail because a recording could not be signed. Returns null when
 * there is no attestation to patch or no readable recording.
 */
export function attestRecording(
  projectRoot: string,
  runId: string,
  recordingPath?: string,
  key?: AttestKeyPair,
): AttestationRecord | null {
  try {
    const dir = runDir(projectRoot, runId);
    const record = readAttestation(dir);
    if (!record) return null;
    const abs = recordingPath ?? resolve(dir, REPLAY_RECORDING_FILENAME);
    const sha256 = sha256File(abs);
    if (!sha256) return null;
    // Did this record already carry these exact bytes? Re-rendering a run's
    // report re-signs the SAME recording, and that republication supersedes
    // nothing — only genuinely new journey bytes do.
    const isNewJourney = record.recording?.sha256 !== sha256;
    const pair = key ?? loadOrCreateAttestKey();
    record.recording = {
      file: relativizeScreenshotPath(dir, abs),
      sha256,
      signature: signDigest(sha256, pair.privateKey),
    };
    writeAttestation(dir, record);
    // CLOSE PATH (b) for `replay-divergence`. Publication is the moment a new
    // signed journey supersedes an older, diverged one for the same spec — so
    // this is where that signal drains. Strictly additive to the signing above:
    // it runs after the attestation is on disk, it writes only the signal
    // queue, and its own failures are swallowed by `supersedeReplayDivergence`
    // (signing a run must never fail because the queue could not be updated).
    if (isNewJourney && record.payload.specId) {
      supersedeReplayDivergence(projectRoot, {
        specId: record.payload.specId,
        recording: record.recording.file,
      });
    }
    return record;
  } catch {
    return null;
  }
}

/** The footer's display slice — digest + signature + key, nothing secret. */
export interface AttestationStamp {
  digest: string;
  signature: string;
  publicKey: string;
}

export function stampOf(record: AttestationRecord): AttestationStamp {
  return {
    digest: record.digest,
    signature: record.signature,
    publicKey: record.publicKey,
  };
}

// ---------------------------------------------------------------------------
// Full-chain verification
// ---------------------------------------------------------------------------

export interface RunAttestationResult {
  ok: boolean;
  runId?: string;
  dir: string;
  record?: AttestationRecord;
  mismatches: AttestationMismatch[];
  /** Named-but-not-tamper observations (e.g. the spec was re-frozen since). */
  warnings: AttestationMismatch[];
}

/** Compare two payloads field-by-field, naming the first divergence per field. */
function diffPayloads(
  attested: AttestationPayload,
  actual: AttestationPayload,
): AttestationMismatch[] {
  const out: AttestationMismatch[] = [];
  const scalarKeys = [
    'attestVersion',
    'runId',
    'createdAt',
    'specId',
    'specVersion',
    'specHash',
    'scoringContractVersion',
    'commitSha',
    'branch',
    'dirty',
    'mode',
    'origin',
    'verdict',
    'signedOff',
  ] as const;
  for (const k of scalarKeys) {
    if (stableStringify(attested[k]) !== stableStringify(actual[k])) {
      out.push({
        field: `run-meta:${k}`,
        detail: `${k} changed since signing (attested ${JSON.stringify(attested[k])}, on disk ${JSON.stringify(actual[k])})`,
      });
    }
  }
  if (stableStringify(attested.scoring) !== stableStringify(actual.scoring)) {
    out.push({
      field: 'run-meta:scoring',
      detail: `scoring provenance changed since signing (attested ${stableStringify(attested.scoring)}, on disk ${stableStringify(actual.scoring)})`,
    });
  }

  const attestedById = new Map(attested.criteria.map((c) => [c.id, c]));
  const actualById = new Map(actual.criteria.map((c) => [c.id, c]));
  for (const [id, a] of attestedById) {
    const b = actualById.get(id);
    if (!b) {
      out.push({
        field: `run-meta:criteria[${id}]`,
        detail: `criterion "${id}" was attested but is missing from run-meta.json`,
      });
      continue;
    }
    for (const k of ['tier', 'status', 'scoredBy', 'taints'] as const) {
      if (stableStringify(a[k]) === stableStringify(b[k])) continue;
      out.push({
        field: `run-meta:criteria[${id}].${k}`,
        detail: `criterion "${id}" ${k} changed since signing (attested ${stableStringify(a[k])}, on disk ${stableStringify(b[k])})`,
      });
    }
  }
  for (const id of actualById.keys()) {
    if (!attestedById.has(id)) {
      out.push({
        field: `run-meta:criteria[${id}]`,
        detail: `criterion "${id}" is in run-meta.json but was never attested — it was added after signing`,
      });
    }
  }
  return out;
}

function diffScreenshots(
  dir: string,
  attested: AttestedScreenshot[],
  actual: AttestedScreenshot[],
): AttestationMismatch[] {
  const out: AttestationMismatch[] = [];
  const actualByPath = new Map(actual.map((s) => [s.path, s]));
  for (const a of attested) {
    const b = actualByPath.get(a.path);
    const abs = resolveScreenshotPath(dir, a.path);
    if (!b) {
      out.push({
        field: `screenshot:${a.path}`,
        detail: `${a.path} was attested but run-meta.json no longer references it`,
      });
      continue;
    }
    if (a.sha256 === b.sha256) continue;
    if (a.sha256 !== null && b.sha256 === null) {
      out.push({
        field: `screenshot:${a.path}`,
        detail: `${a.path} is attested (sha256 ${a.sha256}) but the file is gone from ${abs} — retention pruning removes PNGs, so an old run can fail here legitimately`,
      });
    } else if (a.sha256 === null) {
      out.push({
        field: `screenshot:${a.path}`,
        detail: `${a.path} had no file when the run was signed, but one exists now (sha256 ${b.sha256})`,
      });
    } else {
      out.push({
        field: `screenshot:${a.path}`,
        detail: `${a.path} bytes changed since signing (attested sha256 ${a.sha256}, actual ${b.sha256})`,
      });
    }
  }
  for (const b of actual) {
    if (!attested.some((a) => a.path === b.path)) {
      out.push({
        field: `screenshot:${b.path}`,
        detail: `${b.path} is referenced by run-meta.json but was never attested — it was added after signing`,
      });
    }
  }
  return out;
}

/**
 * Verify the whole chain for one run dir: attestation self-consistency +
 * signature, run-meta field-by-field, every screenshot's bytes, and the
 * rendered report. `specCheck` is injected by the caller (the CLI loads the
 * spec store) so this module stays free of spec I/O.
 */
export function verifyRunAttestation(args: {
  dir: string;
  runMeta: RunMeta | null;
  /** Trusted key. Defaults to the record's own — self-consistency only. */
  publicKey?: string;
  specCheck?: (payload: AttestationPayload) => {
    mismatches?: AttestationMismatch[];
    warnings?: AttestationMismatch[];
  };
}): RunAttestationResult {
  const { dir, runMeta } = args;
  const record = readAttestation(dir);
  if (!record) {
    return {
      ok: false,
      dir,
      mismatches: [
        {
          field: 'attestation.json',
          detail: `no readable ${ATTESTATION_FILENAME} in ${dir} — this run was produced before attestation existed, or the file was removed`,
        },
      ],
      warnings: [],
    };
  }
  const mismatches: AttestationMismatch[] = [];
  const warnings: AttestationMismatch[] = [];

  mismatches.push(...verifyAttestation(record, args.publicKey ?? record.publicKey).mismatches);
  if (args.publicKey && args.publicKey !== record.publicKey) {
    warnings.push({
      field: 'attestation.publicKey',
      detail: `the record was written by key ${shortId(record.publicKey)}, verified against ${shortId(args.publicKey)}`,
    });
  }

  if (!runMeta) {
    mismatches.push({
      field: 'run-meta.json',
      detail: `no readable run-meta.json in ${dir} — the signed subject is gone`,
    });
  } else {
    const actual = buildAttestationPayload(dir, runMeta);
    mismatches.push(...diffPayloads(record.payload, actual));
    mismatches.push(...diffScreenshots(dir, record.payload.screenshots, actual.screenshots));
  }

  if (record.report) {
    const abs = resolveScreenshotPath(dir, record.report.file);
    mismatches.push(
      ...verifyReportSignature(record.report, sha256File(abs), args.publicKey ?? record.publicKey)
        .mismatches,
    );
  } else if (existsSync(resolve(dir, REPORT_FILENAME))) {
    warnings.push({
      field: `report:${REPORT_FILENAME}`,
      detail: `${REPORT_FILENAME} exists but carries no signature — it was rendered outside the attested write path`,
    });
  }

  // The `.ad` recording. A run WITHOUT one is not a finding of any kind — web
  // runs never have one and native recording is opt-out — so absence is silent.
  // An UNSIGNED `.ad` sitting in the run dir is a warning, exactly as an
  // unsigned report is: something put a script there that Validity did not
  // sign, and `validity replay` will refuse to execute it.
  if (record.recording) {
    const abs = resolveScreenshotPath(dir, record.recording.file);
    mismatches.push(
      ...verifyRecordingSignature(
        record.recording,
        sha256File(abs),
        args.publicKey ?? record.publicKey,
      ).mismatches,
    );
  } else if (existsSync(resolve(dir, REPLAY_RECORDING_FILENAME))) {
    warnings.push({
      field: `recording:${REPLAY_RECORDING_FILENAME}`,
      detail: `${REPLAY_RECORDING_FILENAME} exists but carries no signature — \`validity replay\` will not execute it`,
    });
  }

  if (args.specCheck) {
    const res = args.specCheck(record.payload);
    mismatches.push(...(res.mismatches ?? []));
    warnings.push(...(res.warnings ?? []));
  }

  return {
    ok: mismatches.length === 0,
    runId: record.payload.runId,
    dir,
    record,
    mismatches,
    warnings,
  };
}
