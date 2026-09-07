/**
 * `validity attest verify` — the spec side of the chain.
 *
 * The run-dir side (run-meta / screenshots / report / signature) is exhaustively
 * covered by `packages/verify-spec/src/attest.test.ts`. What only exists here is the
 * judgement call the CLI makes about the SPEC: a re-frozen spec is a warning
 * (the run's evidence is untouched), an in-place edit of a frozen spec is a
 * MISMATCH (the contract the run was scored against no longer exists).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeSpecHash,
  createSpec,
  freezeSpec,
  readSpec,
  specPathFor,
  updateSpec,
  type AttestationPayload,
  type SpecCriterion,
} from '@validity.ai/verify-spec';
import { checkSpecHash } from './attest.js';

const T0 = '2026-01-01T00:00:00.000Z';

const HARD: SpecCriterion = {
  id: 'AC-1',
  text: 'User can submit the contact form',
  tier: 'hard',
  mocking: 'required',
  checks: [{ expect: { console: { errors: 0 } } }],
};

function tmpProject(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-attest-cli-'));
}

/** A frozen spec plus the payload a run bound to it would carry. */
function frozenProject(): { root: string; specId: string; payload: AttestationPayload } {
  const root = tmpProject();
  const draft = createSpec({
    projectRoot: root,
    prompt: 'contact form',
    criteria: [HARD],
    createdBy: 'agent',
    createdAt: T0,
  });
  const { spec } = freezeSpec({
    projectRoot: root,
    specId: draft.specId,
    updatedAt: T0,
    gitBinding: null,
  });
  return {
    root,
    specId: spec.id,
    payload: {
      attestVersion: 1,
      runId: 'run-1',
      createdAt: T0,
      specId: spec.id,
      specVersion: spec.version,
      specHash: spec.hash,
      criteria: [],
      screenshots: [],
    },
  };
}

describe('checkSpecHash', () => {
  it('passes clean when the frozen spec still hashes to its recorded hash', () => {
    const { root, payload } = frozenProject();
    expect(checkSpecHash(root, payload)).toEqual({ mismatches: [], warnings: [] });
  });

  it('names a MISMATCH when a frozen spec was edited in place', () => {
    const { root, specId, payload } = frozenProject();
    // The exact laundering attack: change the contract but keep the hash that
    // every report, approval, and run-meta cites.
    const spec = readSpec(root, specId)!;
    const path = specPathFor(root, specId);
    const yaml = readFileSync(path, 'utf-8');
    // Edited as TEXT, the way a human would — writeSpec would re-validate and
    // this must be caught however the bytes got there.
    writeFileSync(path, yaml.replace('the contact form', 'anything at all'));
    expect(readFileSync(path, 'utf-8')).toContain(spec.hash!);
    expect(computeSpecHash(readSpec(root, specId)!)).not.toBe(spec.hash);

    const result = checkSpecHash(root, payload);
    expect(result.warnings).toEqual([]);
    expect(result.mismatches.map((m) => m.field)).toEqual([`spec:${specId}`]);
    expect(result.mismatches[0]!.detail).toContain('edited in place');
  });

  it('warns (never fails) when the spec was legitimately re-frozen since the run', () => {
    const { root, specId, payload } = frozenProject();
    updateSpec({
      projectRoot: root,
      specId,
      patch: { criteria: [{ ...HARD, text: 'User can submit the enquiry form' }] },
      updatedAt: T0,
    });
    freezeSpec({ projectRoot: root, specId, updatedAt: T0, gitBinding: null });
    // The run cited v1, which survives in history/ — that is what gets checked.
    const result = checkSpecHash(root, payload);
    expect(result.mismatches).toEqual([]);
    expect(result.warnings).toEqual([]);

    // A payload citing only the (now superseded) hash, with no version to pin
    // it to history, degrades to a warning rather than a false accusation.
    const versionless = { ...payload, specVersion: undefined };
    const degraded = checkSpecHash(root, versionless);
    expect(degraded.mismatches).toEqual([]);
    expect(degraded.warnings.map((w) => w.field)).toEqual([`spec:${specId}`]);
    expect(degraded.warnings[0]!.detail).toContain('re-frozen');
  });

  it('warns when the spec is gone from the store', () => {
    const { root, payload } = frozenProject();
    const missing = { ...payload, specId: 'spec-vanished' };
    const result = checkSpecHash(root, missing);
    expect(result.mismatches).toEqual([]);
    expect(result.warnings.map((w) => w.field)).toEqual(['spec:spec-vanished']);
  });

  it('is a no-op for runs that were never bound to a spec', () => {
    const { root, payload } = frozenProject();
    expect(checkSpecHash(root, { ...payload, specId: undefined, specHash: undefined })).toEqual({
      mismatches: [],
      warnings: [],
    });
  });

  it('warns rather than throws when the spec file is unparseable', () => {
    const { root, specId, payload } = frozenProject();
    writeFileSync(specPathFor(root, specId), 'criteria: [\n  broken');
    const result = checkSpecHash(root, { ...payload, specVersion: undefined });
    expect(result.mismatches).toEqual([]);
    expect(result.warnings.map((w) => w.field)).toEqual([`spec:${specId}`]);
  });
});
