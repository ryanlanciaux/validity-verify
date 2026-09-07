/**
 * `validity attest verify <run-dir>` — re-check a run's attestation chain.
 *
 * This is the reviewer-facing half of `core/src/attest.ts`: it re-derives the
 * signed payload from the files that are on disk RIGHT NOW and names the first
 * thing that no longer matches. Editing one byte of run-meta.json, of any
 * screenshot, of report.html, or of attestation.json itself produces a NAMED
 * failure and a non-zero exit.
 *
 * Exit codes: 0 verified (warnings allowed), 1 mismatch, 2 bad usage / no run.
 *
 * The spec check is the one place this command reaches outside the run dir: a
 * frozen spec that no longer hashes to its own recorded hash was edited in
 * place, which invalidates every run bound to it. A spec that was legitimately
 * RE-frozen since the run is a warning, not a failure — the run's evidence is
 * untouched, the contract simply moved on.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';
import {
  computeSpecHash,
  readSpec,
  readSpecVersion,
  runDir,
  shortId,
  verifyRunAttestation,
  type AttestationMismatch,
  type AttestationPayload,
  type RunMeta,
} from '@validity.ai/verify-spec';
import { recentRunIds } from './recent-runs.js';

export interface AttestVerifyOptions {
  cwd?: string;
  /** Verify against an explicit public key instead of the record's own. */
  publicKey?: string;
}

/**
 * Accept a run dir path OR a bare run id. Returns null when neither resolves.
 * Shared with `validity replay`, which widens it to also accept a file INSIDE
 * the run dir (a report.html path) — see `resolveReplayTarget`.
 */
export function resolveRunDir(projectRoot: string, target: string): string | null {
  const asPath = resolve(projectRoot, target);
  if (existsSync(asPath) && statSync(asPath).isDirectory()) return asPath;
  const byId = runDir(projectRoot, target);
  if (existsSync(byId) && statSync(byId).isDirectory()) return byId;
  return null;
}

/** Read `run-meta.json` out of a run dir by PATH (not by run id). Shared with replay. */
export function readRunMetaAt(dir: string): RunMeta | null {
  try {
    return JSON.parse(readFileSync(resolve(dir, 'run-meta.json'), 'utf-8')) as RunMeta;
  } catch {
    return null;
  }
}

/**
 * Spec-side integrity. Split deliberately:
 *   - MISMATCH when the frozen spec the run cites still claims the attested
 *     hash but its content no longer produces it (edited in place);
 *   - WARNING when the spec has moved on, or is gone from the store.
 */
export function checkSpecHash(
  projectRoot: string,
  payload: AttestationPayload,
): { mismatches: AttestationMismatch[]; warnings: AttestationMismatch[] } {
  const mismatches: AttestationMismatch[] = [];
  const warnings: AttestationMismatch[] = [];
  const { specId, specHash, specVersion } = payload;
  if (!specId || !specHash) return { mismatches, warnings };

  let spec = null;
  try {
    spec = specVersion != null ? readSpecVersion(projectRoot, specId, specVersion) : null;
    spec ??= readSpec(projectRoot, specId);
  } catch (err) {
    warnings.push({
      field: `spec:${specId}`,
      detail: `spec ${specId} could not be loaded (${(err as Error).message}) — its side of the chain is unchecked`,
    });
    return { mismatches, warnings };
  }
  if (!spec) {
    warnings.push({
      field: `spec:${specId}`,
      detail: `spec ${specId} is no longer in the spec store — its side of the chain is unchecked`,
    });
    return { mismatches, warnings };
  }
  if (spec.hash !== specHash) {
    warnings.push({
      field: `spec:${specId}`,
      detail: `spec ${specId} now hashes to ${spec.hash ?? '(unfrozen)'} but this run was verified against ${specHash} — the spec was re-frozen since; the run's own evidence is unaffected`,
    });
    return { mismatches, warnings };
  }
  const recomputed = computeSpecHash(spec);
  if (recomputed !== spec.hash) {
    mismatches.push({
      field: `spec:${specId}`,
      detail: `spec ${specId} still claims hash ${spec.hash} but its content hashes to ${recomputed} — the frozen spec was edited in place, so the contract this run was scored against no longer exists`,
    });
  }
  return { mismatches, warnings };
}

export async function runAttestVerify(
  target: string,
  opts: AttestVerifyOptions = {},
): Promise<void> {
  const projectRoot = opts.cwd ? resolve(opts.cwd) : process.cwd();
  if (!target) {
    process.stderr.write(
      pc.red('error: a run dir or run id is required (e.g. `validity attest verify <run-dir>`).\n'),
    );
    process.exit(2);
    return;
  }
  const dir = resolveRunDir(projectRoot, target);
  if (!dir) {
    process.stderr.write(pc.red(`error: no run dir found for "${target}".\n`));
    const known = recentRunIds(projectRoot);
    if (known.length > 0) {
      process.stderr.write('  Known run ids (newest first):\n');
      for (const id of known) process.stderr.write(`    ${id}\n`);
    }
    process.exit(2);
    return;
  }

  const result = verifyRunAttestation({
    dir,
    runMeta: readRunMetaAt(dir),
    publicKey: opts.publicKey,
    specCheck: (payload) => checkSpecHash(projectRoot, payload),
  });

  const payload = result.record?.payload;
  process.stdout.write(`Run:    ${payload?.runId ?? result.runId ?? '(unknown)'}\n`);
  process.stdout.write(`Dir:    ${dir}\n`);
  if (result.record) {
    process.stdout.write(`Digest: ${result.record.digest}\n`);
    process.stdout.write(`Key:    ${shortId(result.record.publicKey)}\n`);
  }
  if (payload) {
    const shots = payload.screenshots.length;
    process.stdout.write(
      `Covers: ${payload.criteria.length} criterion verdict(s), ${shots} screenshot(s)` +
        `${payload.commitSha ? `, commit ${payload.commitSha.slice(0, 12)}` : ''}` +
        `${result.record?.report ? ', report.html' : ''}\n`,
    );
  }

  for (const w of result.warnings) {
    process.stdout.write(pc.yellow(`  warn  ${w.field}: ${w.detail}\n`));
  }

  if (result.ok) {
    process.stdout.write(
      pc.green(
        '\nATTESTATION VALID — every signed artifact is unmodified since Validity wrote it.\n',
      ),
    );
    process.stdout.write(
      pc.dim(
        'Re-verified deterministically — 0 LLM tokens. This proves the artifacts are unaltered, not who produced them.\n',
      ),
    );
    return;
  }

  process.stderr.write(
    pc.red(`\nATTESTATION FAILED — ${result.mismatches.length} mismatch(es):\n`),
  );
  for (const m of result.mismatches) {
    process.stderr.write(`  ${pc.red('✗')} ${pc.bold(m.field)}: ${m.detail}\n`);
  }
  process.exit(1);
}
