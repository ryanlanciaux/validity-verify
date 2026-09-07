import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  createSpec,
  readSpec,
  readSpecVersion,
  writeSpec,
  updateSpec,
  freezeSpec,
  listSpecIds,
  computeSpecHash,
  SCORING_CONTRACT_VERSION,
  newSpecId,
  isSpecId,
  planCriteriaToSpecCriteria,
  CHECK_COMPILER_VERSION,
  specToPlan,
  mapChangedFilesToSpecs,
  specHistoryDir,
  clearSpecProbation,
  approveSpecs,
  detectWeakenedCriteria,
  weakenedSincePrevVersion,
  type SpecCriterion,
  type Spec,
  parseSpec,
  SpecValidationError,
} from './index.js';

const T0 = '2026-01-01T00:00:00.000Z';

function tmpProject(): string {
  return mkdtempSync(resolve(tmpdir(), 'validity-specs-'));
}

const HARD_CRITERION: SpecCriterion = {
  id: 'AC-1',
  text: 'User can submit the contact form',
  tier: 'hard',
  mocking: 'required',
  checks: [
    { fill: { role: 'textbox', name: 'Email', value: 'a@b.com' } },
    { click: { role: 'button', name: 'Send' } },
    { expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } } },
    { expect: { console: { errors: 0 } } },
  ],
};

const SOFT_CRITERION: SpecCriterion = {
  id: 'AC-2',
  text: 'Form looks polished and on-brand',
  tier: 'soft',
};

describe('spec store', () => {
  it('creates a draft spec as YAML on disk', () => {
    const root = tmpProject();
    const { specId, spec, path } = createSpec({
      projectRoot: root,
      prompt: 'Build a contact form',
      criteria: [HARD_CRITERION, SOFT_CRITERION],
    });
    expect(isSpecId(specId)).toBe(true);
    expect(spec.status).toBe('draft');
    expect(spec.version).toBe(1);
    expect(existsSync(path)).toBe(true);
    const onDisk = parseYaml(readFileSync(path, 'utf-8'));
    expect(onDisk.id).toBe(specId);
    expect(onDisk.criteria).toHaveLength(2);
    expect(listSpecIds(root)).toEqual([specId]);
  });

  it('#4 stamps source.compiledWith with the current contract on create', () => {
    const root = tmpProject();
    const { spec } = createSpec({ projectRoot: root, prompt: 'p', criteria: [SOFT_CRITERION] });
    expect(spec.source.compiledWith).toBe(CHECK_COMPILER_VERSION);
    // Persisted to disk (hashed content), not just in memory.
    expect(readSpec(root, spec.id)!.source.compiledWith).toBe(CHECK_COMPILER_VERSION);
  });

  it('#4 an explicit compiledWith override is honored (plan→spec bridge continuity)', () => {
    const root = tmpProject();
    const { spec } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [SOFT_CRITERION],
      compiledWith: '1',
    });
    expect(spec.source.compiledWith).toBe('1');
  });

  it('#4 updateSpec re-stamps compiledWith when criteria change, not on a metadata-only edit', () => {
    const root = tmpProject();
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [SOFT_CRITERION],
      compiledWith: '1', // pretend it was compiled under an old contract
    });
    // Metadata-only edit (no criteria patch) keeps the stale stamp.
    const meta = updateSpec({ projectRoot: root, specId, patch: { runtime: 'web' } });
    expect(meta.spec.source.compiledWith).toBe('1');
    // A criteria change re-authors the bar → re-stamp to current.
    const crit = updateSpec({
      projectRoot: root,
      specId,
      patch: { criteria: [SOFT_CRITERION, { id: 'AC-3', text: 'has a footer', tier: 'soft' }] },
    });
    expect(crit.spec.source.compiledWith).toBe(CHECK_COMPILER_VERSION);
  });

  it('round-trips a spec through read', () => {
    const root = tmpProject();
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [HARD_CRITERION],
    });
    const loaded = readSpec(root, specId);
    expect(loaded?.criteria[0].checks).toHaveLength(4);
  });

  it('freezes a spec, binding a content hash', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [HARD_CRITERION] });
    const { spec } = freezeSpec({ projectRoot: root, specId });
    expect(spec.status).toBe('frozen');
    expect(spec.hash).toMatch(/^sha256-/);
    // Hash is content-derived and stable across re-read.
    const reread = readSpec(root, specId)!;
    expect(computeSpecHash(reread)).toBe(reread.hash);
  });

  it('blocks freeze without approval when specApproval=always', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [HARD_CRITERION] });
    expect(() => freezeSpec({ projectRoot: root, specId, approval: 'always' })).toThrow(
      /approval/i,
    );
    // Approval is granted OUT OF BAND — not via spec_update, which now refuses
    // to write the 'approved' status (it would let the agent self-clear the
    // gate). Simulate the privileged approval write directly.
    const draft = readSpec(root, specId)!;
    writeSpec(root, { ...draft, status: 'approved' });
    const { spec } = freezeSpec({ projectRoot: root, specId, approval: 'always' });
    expect(spec.status).toBe('frozen');
  });

  it('refuses to set status to frozen or approved via updateSpec (no forge)', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [SOFT_CRITERION] });
    expect(() => updateSpec({ projectRoot: root, specId, patch: { status: 'frozen' } })).toThrow(
      SpecValidationError,
    );
    expect(() => updateSpec({ projectRoot: root, specId, patch: { status: 'approved' } })).toThrow(
      /freeze/i,
    );
    // The spec stays a draft — no hashless frozen forge landed on disk.
    const onDisk = readSpec(root, specId)!;
    expect(onDisk.status).toBe('draft');
    expect(onDisk.hash).toBeUndefined();
  });

  it('still lets a reviewer set status to reviewed', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [SOFT_CRITERION] });
    const { spec, bumped } = updateSpec({
      projectRoot: root,
      specId,
      patch: { status: 'reviewed' },
      by: 'agent-r',
    });
    expect(bumped).toBe(false);
    expect(spec.status).toBe('reviewed');
    expect(spec.source.reviewedBy).toContain('agent-r');
  });

  it('amends a draft in place without bumping version', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [SOFT_CRITERION] });
    const { spec, bumped } = updateSpec({
      projectRoot: root,
      specId,
      patch: { criteria: [SOFT_CRITERION, HARD_CRITERION] },
      by: 'agent-b',
    });
    expect(bumped).toBe(false);
    expect(spec.version).toBe(1);
    expect(spec.criteria).toHaveLength(2);
    expect(spec.source.reviewedBy).toContain('agent-b');
  });

  it('versions a frozen spec on edit, snapshotting history with lineage', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [HARD_CRITERION] });
    freezeSpec({ projectRoot: root, specId });
    const { spec, bumped } = updateSpec({
      projectRoot: root,
      specId,
      patch: { criteria: [HARD_CRITERION, SOFT_CRITERION] },
    });
    expect(bumped).toBe(true);
    expect(spec.version).toBe(2);
    expect(spec.status).toBe('draft');
    expect(spec.hash).toBeUndefined();
    expect(spec.supersedes).toBe(`${specId}@v1`);
    expect(existsSync(resolve(specHistoryDir(root, specId), 'v1.yaml'))).toBe(true);
  });
});

describe('freezeSpec git binding (B2 temporal binding)', () => {
  const BINDING_A = {
    sha: 'a'.repeat(40),
    dirty: true,
    changedFiles: ['src/Foo.tsx'],
  };
  const BINDING_B = {
    sha: 'b'.repeat(40),
    dirty: false,
    changedFiles: [],
  };

  it('stamps an injected gitBinding onto the frozen spec — OUTSIDE the content hash', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [HARD_CRITERION] });
    const { spec } = freezeSpec({ projectRoot: root, specId, gitBinding: BINDING_A });
    expect(spec.git).toEqual(BINDING_A);
    // Provenance, not contract: the hash must be identical with/without the
    // binding — a re-stamp can never mint a "new" spec version by hash.
    const { git: _omit, ...withoutBinding } = spec;
    expect(computeSpecHash(spec)).toBe(computeSpecHash(withoutBinding as Spec));
    expect(computeSpecHash(spec)).toBe(spec.hash);
    // And it round-trips through the YAML on disk.
    expect(readSpec(root, specId)?.git).toEqual(BINDING_A);
  });

  it('gitBinding: null skips collection entirely (deterministic YAML for tests)', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [HARD_CRITERION] });
    const { spec } = freezeSpec({ projectRoot: root, specId, gitBinding: null });
    expect(spec.git).toBeUndefined();
  });

  it('self-collection in a non-git project omits the field (legacy behavior preserved)', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [HARD_CRITERION] });
    const { spec } = freezeSpec({ projectRoot: root, specId });
    expect(spec.git).toBeUndefined();
  });

  it('re-freeze is idempotent: the binding is stamped once per version, never re-stamped', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [HARD_CRITERION] });
    freezeSpec({ projectRoot: root, specId, gitBinding: BINDING_A });
    const { spec } = freezeSpec({ projectRoot: root, specId, gitBinding: BINDING_B });
    expect(spec.git).toEqual(BINDING_A);
  });

  it('v(n)→v(n+1): each version carries its OWN freeze-time binding; history preserves the old one', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [HARD_CRITERION] });
    freezeSpec({ projectRoot: root, specId, gitBinding: BINDING_A });
    updateSpec({
      projectRoot: root,
      specId,
      patch: { criteria: [HARD_CRITERION, SOFT_CRITERION] },
    });
    freezeSpec({ projectRoot: root, specId, gitBinding: BINDING_B });
    // readSpecVersion resolves the EXACT frozen version's binding.
    expect(readSpecVersion(root, specId, 1)?.git).toEqual(BINDING_A);
    expect(readSpecVersion(root, specId, 2)?.git).toEqual(BINDING_B);
    expect(readSpec(root, specId)?.git).toEqual(BINDING_B);
  });

  it("REGRESSION (stale binding across version bumps): the v(n+1) draft does NOT inherit v(n)'s git binding, and a re-freeze that skips/fails collection stays unstamped", () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [HARD_CRITERION] });
    freezeSpec({ projectRoot: root, specId, gitBinding: BINDING_A });
    const { spec: draft } = updateSpec({
      projectRoot: root,
      specId,
      patch: { criteria: [HARD_CRITERION, SOFT_CRITERION] },
    });
    // The bump clears the inherited freeze provenance — it belongs to v1 only.
    expect(draft.git).toBeUndefined();
    expect(readSpec(root, specId)?.git).toBeUndefined();
    // Re-freeze with collection skipped (same shape as a failed self-collect):
    // v2 must carry NO binding (honest `unknown`), never v1's stale
    // before-work snapshot.
    const { spec } = freezeSpec({ projectRoot: root, specId, gitBinding: null });
    expect(spec.git).toBeUndefined();
    expect(readSpec(root, specId)?.git).toBeUndefined();
    // v1's history snapshot keeps its own binding untouched.
    expect(readSpecVersion(root, specId, 1)?.git).toEqual(BINDING_A);
  });

  it('back-compat: a pre-B2 frozen spec (no git field) parses and its hash is unchanged', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [HARD_CRITERION] });
    const { spec } = freezeSpec({ projectRoot: root, specId, gitBinding: null });
    const reread = readSpec(root, specId)!;
    expect(reread.git).toBeUndefined();
    expect(computeSpecHash(reread)).toBe(spec.hash);
  });
});

describe('spec schema validation', () => {
  it('rejects a hard criterion with no checks', () => {
    expect(() =>
      parseSpec({
        id: 'spec-x',
        version: 1,
        status: 'draft',
        source: { prompt: 'p', createdBy: 'agent' },
        runtime: 'web',
        criteria: [{ id: 'AC-1', text: 't', tier: 'hard' }],
        createdAt: new Date(0).toISOString(),
      }),
    ).toThrow(SpecValidationError);
  });

  it('rejects an expect asserting more than one family', () => {
    expect(() =>
      parseSpec({
        id: 'spec-x',
        version: 1,
        status: 'draft',
        source: { prompt: 'p', createdBy: 'agent' },
        runtime: 'web',
        criteria: [
          {
            id: 'AC-1',
            text: 't',
            tier: 'hard',
            checks: [{ expect: { console: { errors: 0 }, network: { url: '/x' } } }],
          },
        ],
        createdAt: new Date(0).toISOString(),
      }),
    ).toThrow(SpecValidationError);
  });

  it('accepts an expect.a11y check (severity + maxViolations)', () => {
    const spec = parseSpec({
      id: 'spec-a11y',
      version: 1,
      status: 'draft',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      criteria: [
        {
          id: 'AC-1',
          text: 'no serious a11y violations',
          tier: 'hard',
          checks: [{ expect: { a11y: { severity: 'serious', maxViolations: 0 } } }],
        },
      ],
      createdAt: new Date(0).toISOString(),
    });
    expect(spec.criteria[0].checks?.[0]).toEqual({
      expect: { a11y: { severity: 'serious', maxViolations: 0 } },
    });
  });

  it('accepts an expect.a11y with no fields (both optional → defaults apply)', () => {
    expect(() =>
      parseSpec({
        id: 'spec-a11y-empty',
        version: 1,
        status: 'draft',
        source: { prompt: 'p', createdBy: 'agent' },
        runtime: 'web',
        criteria: [
          {
            id: 'AC-1',
            text: 'a11y is healthy',
            tier: 'hard',
            checks: [{ expect: { a11y: {} } }],
          },
        ],
        createdAt: new Date(0).toISOString(),
      }),
    ).not.toThrow();
  });

  it('rejects an expect mixing a11y with another family (exactly-one refine)', () => {
    expect(() =>
      parseSpec({
        id: 'spec-a11y-mixed',
        version: 1,
        status: 'draft',
        source: { prompt: 'p', createdBy: 'agent' },
        runtime: 'web',
        criteria: [
          {
            id: 'AC-1',
            text: 't',
            tier: 'hard',
            checks: [{ expect: { a11y: { maxViolations: 0 }, element: { role: 'button' } } }],
          },
        ],
        createdAt: new Date(0).toISOString(),
      }),
    ).toThrow(SpecValidationError);
  });
});

describe('computeSpecHash deep content coverage', () => {
  // Plain objects (cast) so we control key insertion order precisely — the
  // hash must reflect nested fields and be invariant to key order.
  const base = {
    id: 'spec-hash',
    version: 1,
    status: 'frozen',
    source: { prompt: 'Build a contact form', createdBy: 'agent' },
    runtime: 'web',
    targets: { components: ['ContactForm'] },
    criteria: [HARD_CRITERION, SOFT_CRITERION],
    createdAt: new Date(0).toISOString(),
  } as unknown as Spec;

  it('changes when a nested criterion field changes (text/tier/check value)', () => {
    const h0 = computeSpecHash(base);

    const textChanged = {
      ...base,
      criteria: [{ ...HARD_CRITERION, text: 'a totally different statement' }, SOFT_CRITERION],
    } as unknown as Spec;

    const tierChanged = {
      ...base,
      criteria: [HARD_CRITERION, { ...SOFT_CRITERION, tier: 'property' }],
    } as unknown as Spec;

    const checkValueChanged = {
      ...base,
      criteria: [
        {
          ...HARD_CRITERION,
          checks: [
            { fill: { role: 'textbox', name: 'Email', value: 'changed@example.com' } },
            { click: { role: 'button', name: 'Send' } },
            { expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } } },
            { expect: { console: { errors: 0 } } },
          ],
        },
        SOFT_CRITERION,
      ],
    } as unknown as Spec;

    const promptChanged = {
      ...base,
      source: { ...base.source, prompt: 'Build a checkout flow' },
    } as unknown as Spec;

    // Every nested edit must move the hash — the old key-allowlist serializer
    // dropped all of these and produced an identical hash.
    expect(computeSpecHash(textChanged)).not.toBe(h0);
    expect(computeSpecHash(tierChanged)).not.toBe(h0);
    expect(computeSpecHash(checkValueChanged)).not.toBe(h0);
    expect(computeSpecHash(promptChanged)).not.toBe(h0);
  });

  it('is invariant to object key order at every nesting level', () => {
    const reordered = {
      createdAt: new Date(0).toISOString(),
      criteria: [
        {
          tier: 'hard',
          mocking: 'required',
          text: HARD_CRITERION.text,
          id: 'AC-1',
          checks: HARD_CRITERION.checks,
        },
        { tier: 'soft', text: SOFT_CRITERION.text, id: 'AC-2' },
      ],
      targets: { components: ['ContactForm'] },
      runtime: 'web',
      source: { createdBy: 'agent', prompt: 'Build a contact form' },
      status: 'frozen',
      version: 1,
      id: 'spec-hash',
    } as unknown as Spec;
    expect(computeSpecHash(reordered)).toBe(computeSpecHash(base));
  });

  it('ignores the volatile hash/updatedAt fields', () => {
    const withVolatile = {
      ...base,
      hash: 'sha256-stale',
      updatedAt: new Date(12345).toISOString(),
    } as unknown as Spec;
    expect(computeSpecHash(withVolatile)).toBe(computeSpecHash(base));
  });

  it('excludes the B2 git freeze-binding — a spec with and without `git` hashes identically', () => {
    // The freeze binding is provenance, not content: adding it must NOT change a
    // frozen spec's hash (parity with hash/updatedAt), or the field would break
    // every already-frozen spec on disk.
    const withGit = {
      ...base,
      git: {
        sha: 'abc1234',
        dirty: true,
        changedFiles: ['src/ContactForm.tsx'],
        changedFilesTruncated: false,
      },
    } as unknown as Spec;
    expect(computeSpecHash(withGit)).toBe(computeSpecHash(base));
  });

  it('folds SCORING_CONTRACT_VERSION into the hash, overriding any content scoringContract', () => {
    // The contract version is injected as a synthetic `scoringContract` key, so
    // a content-level `scoringContract` field is ignored (the constant wins).
    // This proves the mixing is wired: under the OLD body (hash of `content`
    // alone) the extra field would have moved the hash. Bumping the constant
    // therefore changes the hash of every newly frozen spec — a new contract
    // surfaces as a spec change, never a silent re-score.
    const withSpuriousContract = {
      ...base,
      scoringContract: 'this-value-must-be-ignored',
    } as unknown as Spec;
    expect(computeSpecHash(withSpuriousContract)).toBe(computeSpecHash(base));
    expect(SCORING_CONTRACT_VERSION).toBe('v1');
  });
});

describe('plan ↔ spec bridge', () => {
  it('compiles observable plan criteria to hard, leaves aesthetic soft', () => {
    const out = planCriteriaToSpecCriteria([
      { id: 'a', description: 'looks good' },
      { id: 'b', description: 'A "Submit" button is visible' },
      { id: 'c', description: 'No console errors on load' },
    ]);
    // Aesthetic → soft (demote by default); observable → hard with checks.
    expect(out[0].tier).toBe('soft');
    expect(out[0].text).toBe('looks good');
    expect(out[1].tier).toBe('hard');
    expect(out[1].checks && out[1].checks.length > 0).toBe(true);
    expect(out[2].tier).toBe('hard');
  });

  it('adapts a spec back to a plan shape', () => {
    const root = tmpProject();
    const { spec } = createSpec({
      projectRoot: root,
      prompt: 'orig prompt',
      criteria: [HARD_CRITERION],
    });
    const plan = specToPlan(spec);
    expect(plan.planId).toBe(spec.id);
    expect(plan.prompt).toBe('orig prompt');
    expect(plan.criteria[0].description).toBe(HARD_CRITERION.text);
  });
});

describe('change mapping', () => {
  it('matches specs whose targets resolve to a changed file', () => {
    const specA = baseSpec('spec-a', { components: ['ContactForm'] });
    const specB = baseSpec('spec-b', { components: ['Toast'] });
    const specC = baseSpec('spec-c', undefined);
    const { matched, unmapped } = mapChangedFilesToSpecs({
      specs: [specA, specB, specC],
      changedFiles: ['src/ContactForm.tsx'],
      resolveTarget: (name) => (name === 'ContactForm' ? ['src/ContactForm.tsx'] : []),
    });
    expect(matched.map((s) => s.id)).toEqual(['spec-a']);
    expect(unmapped.map((s) => s.id)).toEqual(['spec-c']);
  });

  it('falls back to basename matching with no resolver', () => {
    const specA = baseSpec('spec-a', { components: ['ContactForm'] });
    const { matched } = mapChangedFilesToSpecs({
      specs: [specA],
      changedFiles: ['src/components/ContactForm.tsx'],
    });
    expect(matched.map((s) => s.id)).toEqual(['spec-a']);
  });

  it('matches path targets against changed files (plan-created specs)', () => {
    const specA = baseSpec('spec-a', { components: ['src/components/ContactForm.tsx'] });
    const specB = baseSpec('spec-b', { components: ['./src/Toast.tsx'] });
    const { matched } = mapChangedFilesToSpecs({
      specs: [specA, specB],
      changedFiles: ['src/components/ContactForm.tsx', 'src/Toast.tsx'],
    });
    expect(matched.map((s) => s.id)).toEqual(['spec-a', 'spec-b']);
  });

  it('matches a path target by basename when directories differ', () => {
    const specA = baseSpec('spec-a', { components: ['app/screens/Login.tsx'] });
    const { matched } = mapChangedFilesToSpecs({
      specs: [specA],
      changedFiles: ['src/screens/Login.tsx'],
    });
    expect(matched.map((s) => s.id)).toEqual(['spec-a']);
  });
});

function baseSpec(id: string, targets: { components?: string[] } | undefined) {
  return parseSpec({
    id,
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    targets,
    criteria: [SOFT_CRITERION],
    createdAt: new Date(0).toISOString(),
  });
}

describe('newSpecId', () => {
  it('mints spec- prefixed ids', () => {
    expect(newSpecId()).toMatch(/^spec-[0-9a-f]+$/);
  });
});

describe('readSpecVersion', () => {
  it('reads a superseded version from history/', () => {
    const root = tmpProject();
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'v1 prompt',
      criteria: [SOFT_CRITERION],
    });
    freezeSpec({ projectRoot: root, specId });
    // Supersede → v1 snapshots into history/, spec.yaml becomes v2 draft.
    updateSpec({
      projectRoot: root,
      specId,
      patch: { criteria: [{ ...SOFT_CRITERION, text: 'v2 wording' }] },
    });
    const v1 = readSpecVersion(root, specId, 1);
    expect(v1?.version).toBe(1);
    expect(v1?.criteria[0]?.text).toBe(SOFT_CRITERION.text);
    expect(v1?.status).toBe('frozen');
  });

  it('falls back to the live spec.yaml when its version matches', () => {
    const root = tmpProject();
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [SOFT_CRITERION],
    });
    const live = readSpecVersion(root, specId, 1);
    expect(live?.id).toBe(specId);
    expect(live?.version).toBe(1);
  });

  it('returns null for a version that never existed (and for unknown specs)', () => {
    const root = tmpProject();
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [SOFT_CRITERION],
    });
    expect(readSpecVersion(root, specId, 7)).toBeNull();
    expect(readSpecVersion(root, 'spec-nope', 1)).toBeNull();
  });

  it('throws SpecValidationError on a malformed history file', () => {
    const root = tmpProject();
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [SOFT_CRITERION],
    });
    const dir = specHistoryDir(root, specId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'v3.yaml'), '{{ not: yaml');
    expect(() => readSpecVersion(root, specId, 3)).toThrow(SpecValidationError);
  });
});

describe('probation marker (Phase C bulk onboarding)', () => {
  it('createSpec stamps probation.since/batchId when the probation arg is provided', () => {
    const root = tmpProject();
    const { spec } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [SOFT_CRITERION],
      probation: { batchId: 'batch-7' },
      createdAt: '2026-07-04T00:00:00.000Z',
    });
    expect(spec.probation).toEqual({ since: '2026-07-04T00:00:00.000Z', batchId: 'batch-7' });
    // Persisted to disk.
    expect(readSpec(root, spec.id)?.probation).toEqual({
      since: '2026-07-04T00:00:00.000Z',
      batchId: 'batch-7',
    });
  });

  it('createSpec with no probation arg leaves the field absent', () => {
    const root = tmpProject();
    const { spec } = createSpec({ projectRoot: root, prompt: 'p', criteria: [SOFT_CRITERION] });
    expect(spec.probation).toBeUndefined();
  });

  it('createSpec stamps probation.since with no batchId when batchId is omitted', () => {
    const root = tmpProject();
    const { spec } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [SOFT_CRITERION],
      probation: {},
      createdAt: '2026-07-04T00:00:00.000Z',
    });
    expect(spec.probation).toEqual({ since: '2026-07-04T00:00:00.000Z' });
  });

  it('computeSpecHash is identical with and without probation (provenance, not contract)', () => {
    const root = tmpProject();
    const { spec } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [SOFT_CRITERION],
      probation: { batchId: 'batch-x' },
    });
    const withoutProbation = { ...spec, probation: undefined } as Spec;
    expect(computeSpecHash(spec)).toBe(computeSpecHash(withoutProbation));
  });

  it('freeze then clearSpecProbation: hash and version unchanged, status still frozen', () => {
    const root = tmpProject();
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [SOFT_CRITERION],
      probation: { batchId: 'batch-f' },
    });
    const { spec: frozen } = freezeSpec({ projectRoot: root, specId, gitBinding: null });
    const hashBefore = frozen.hash!;
    const versionBefore = frozen.version;
    expect(frozen.probation).toBeDefined();

    const lifted = clearSpecProbation({ projectRoot: root, specId });
    expect(lifted).toBe(true);

    const after = readSpec(root, specId)!;
    expect(after.probation).toBeUndefined();
    // NO hash recompute, NO version bump, NO status change — the marker was
    // content-independent provenance, so lifting it leaves the frozen spec
    // byte-identical to its hash.
    expect(after.hash).toBe(hashBefore);
    expect(after.version).toBe(versionBefore);
    expect(after.status).toBe('frozen');
  });

  it('clearSpecProbation returns false when the spec is absent', () => {
    const root = tmpProject();
    expect(clearSpecProbation({ projectRoot: root, specId: 'spec-nope' })).toBe(false);
  });

  it('clearSpecProbation returns false when the spec has no probation', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [SOFT_CRITERION] });
    expect(clearSpecProbation({ projectRoot: root, specId })).toBe(false);
  });

  it('clearSpecProbation is idempotent (second call returns false, field already gone)', () => {
    const root = tmpProject();
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [SOFT_CRITERION],
      probation: { batchId: 'batch-idem' },
    });
    expect(clearSpecProbation({ projectRoot: root, specId })).toBe(true);
    expect(clearSpecProbation({ projectRoot: root, specId })).toBe(false);
    expect(readSpec(root, specId)?.probation).toBeUndefined();
  });

  it('updateSpec carries probation across the frozen→v+1 bump (not cleared like git)', () => {
    const root = tmpProject();
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [SOFT_CRITERION],
      probation: { batchId: 'batch-carry' },
      createdAt: '2026-07-04T00:00:00.000Z',
    });
    freezeSpec({ projectRoot: root, specId, gitBinding: null });
    // Edit a frozen spec → v+1 draft. `git` is cleared on the bump, but
    // `probation` must ride along (the spec still hasn't had a confirmed clean
    // pass), lifted ONLY by clearSpecProbation.
    const { spec: draft } = updateSpec({
      projectRoot: root,
      specId,
      patch: { criteria: [SOFT_CRITERION, HARD_CRITERION] },
    });
    expect(draft.version).toBe(2);
    expect(draft.git).toBeUndefined();
    expect(draft.probation).toEqual({ since: '2026-07-04T00:00:00.000Z', batchId: 'batch-carry' });
    expect(readSpec(root, specId)?.probation).toEqual({
      since: '2026-07-04T00:00:00.000Z',
      batchId: 'batch-carry',
    });
  });
});

describe('approveSpecs (out-of-band approval surface)', () => {
  it('approves drafts, skips frozen/missing, and appends reviewedBy', () => {
    const root = tmpProject();
    const { specId: draft1 } = createSpec({
      projectRoot: root,
      prompt: 'p1',
      criteria: [SOFT_CRITERION],
    });
    const { specId: draft2 } = createSpec({
      projectRoot: root,
      prompt: 'p2',
      criteria: [SOFT_CRITERION],
    });
    const { specId: frozenId } = createSpec({
      projectRoot: root,
      prompt: 'p3',
      criteria: [SOFT_CRITERION],
    });
    freezeSpec({ projectRoot: root, specId: frozenId, gitBinding: null });

    const { approved, skipped } = approveSpecs({
      projectRoot: root,
      specIds: [draft1, frozenId, 'spec-missing', draft2],
      by: 'reviewer-r',
      updatedAt: '2026-07-04T12:00:00.000Z',
    });

    expect(approved).toEqual([draft1, draft2]);
    expect(skipped.map((s) => s.id)).toEqual([frozenId, 'spec-missing']);
    expect(skipped[0].reason).toMatch(/frozen/);
    expect(skipped[1].reason).toMatch(/not found/);

    // Approved drafts: status 'approved' + reviewedBy appended.
    expect(readSpec(root, draft1)?.status).toBe('approved');
    expect(readSpec(root, draft1)?.source.reviewedBy).toContain('reviewer-r');
    expect(readSpec(root, draft1)?.updatedAt).toBe('2026-07-04T12:00:00.000Z');
    expect(readSpec(root, draft2)?.status).toBe('approved');
    expect(readSpec(root, draft2)?.source.reviewedBy).toEqual(['reviewer-r']);
    // Frozen spec untouched (no re-approval, no reviewedBy write).
    const frozenAfter = readSpec(root, frozenId)!;
    expect(frozenAfter.status).toBe('frozen');
    expect(frozenAfter.source.reviewedBy).toBeUndefined();
  });

  it('dedupes reviewedBy and is idempotent on an already-approved spec', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [SOFT_CRITERION] });
    approveSpecs({ projectRoot: root, specIds: [specId], by: 'reviewer-r' });
    // Re-approve with the same reviewer: reviewedBy stays deduped.
    approveSpecs({ projectRoot: root, specIds: [specId], by: 'reviewer-r' });
    const after = readSpec(root, specId)!;
    expect(after.status).toBe('approved');
    expect(after.source.reviewedBy).toEqual(['reviewer-r']);
    // A second distinct reviewer is appended.
    approveSpecs({ projectRoot: root, specIds: [specId], by: 'reviewer-2' });
    expect(readSpec(root, specId)?.source.reviewedBy).toEqual(['reviewer-r', 'reviewer-2']);
  });

  it('skips a superseded spec with a reason', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [SOFT_CRITERION] });
    // Simulate a superseded spec via a direct privileged write (superseded is
    // not produced by updateSpec; it's a terminal status set elsewhere).
    const draft = readSpec(root, specId)!;
    writeSpec(root, { ...draft, status: 'superseded' });

    const { approved, skipped } = approveSpecs({
      projectRoot: root,
      specIds: [specId],
      by: 'reviewer-r',
    });
    expect(approved).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].id).toBe(specId);
    expect(skipped[0].reason).toMatch(/superseded/);
    // Untouched.
    expect(readSpec(root, specId)?.status).toBe('superseded');
  });

  it('appends no reviewedBy when `by` is omitted (status-only approval)', () => {
    const root = tmpProject();
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [SOFT_CRITERION] });
    const { approved } = approveSpecs({ projectRoot: root, specIds: [specId] });
    expect(approved).toEqual([specId]);
    const after = readSpec(root, specId)!;
    expect(after.status).toBe('approved');
    expect(after.source.reviewedBy).toBeUndefined();
  });
});

describe('detectWeakenedCriteria (criterion weakening — surface, never gate)', () => {
  const base: Spec = {
    id: 'spec-w',
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    criteria: [
      { id: 'AC-1', text: 'submit works', tier: 'hard', checks: [{ click: { role: 'button' } }] },
      { id: 'AC-2', text: 'looks polished', tier: 'soft', softThreshold: 0.8 },
      { id: 'AC-3', text: 'nice to have', tier: 'soft' },
    ],
    createdAt: T0,
  } as unknown as Spec;

  const withCriteria = (criteria: SpecCriterion[], version = 2): Spec => ({
    ...base,
    version,
    criteria,
  });

  it('flags a hard→soft tier softening', () => {
    const next = withCriteria([
      { id: 'AC-1', text: 'submit works', tier: 'soft' },
      { id: 'AC-2', text: 'looks polished', tier: 'soft', softThreshold: 0.8 },
      { id: 'AC-3', text: 'nice to have', tier: 'soft' },
    ]);
    const w = detectWeakenedCriteria(base, next);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ id: 'AC-1', kind: 'tier-softened' });
  });

  it('flags a blocking→advisory severity downgrade', () => {
    const next = withCriteria([
      { id: 'AC-1', text: 'submit works', tier: 'hard', checks: [{ click: { role: 'button' } }] },
      {
        id: 'AC-2',
        text: 'looks polished',
        tier: 'soft',
        softThreshold: 0.8,
        severity: 'advisory',
      },
      { id: 'AC-3', text: 'nice to have', tier: 'soft' },
    ]);
    const w = detectWeakenedCriteria(base, next);
    expect(w).toEqual([expect.objectContaining({ id: 'AC-2', kind: 'severity-downgrade' })]);
  });

  it('flags a lowered softThreshold and a removed one', () => {
    const lowered = withCriteria([
      { id: 'AC-1', text: 'submit works', tier: 'hard', checks: [{ click: { role: 'button' } }] },
      { id: 'AC-2', text: 'looks polished', tier: 'soft', softThreshold: 0.5 },
      { id: 'AC-3', text: 'nice to have', tier: 'soft' },
    ]);
    expect(detectWeakenedCriteria(base, lowered)).toEqual([
      expect.objectContaining({ id: 'AC-2', kind: 'threshold-lowered' }),
    ]);
    const removed = withCriteria([
      { id: 'AC-1', text: 'submit works', tier: 'hard', checks: [{ click: { role: 'button' } }] },
      { id: 'AC-2', text: 'looks polished', tier: 'soft' },
      { id: 'AC-3', text: 'nice to have', tier: 'soft' },
    ]);
    expect(detectWeakenedCriteria(base, removed)).toEqual([
      expect.objectContaining({ id: 'AC-2', kind: 'threshold-lowered' }),
    ]);
  });

  it('does NOT flag strengthening (soft→hard, advisory→blocking, raised threshold)', () => {
    const stronger = withCriteria([
      {
        id: 'AC-1',
        text: 'submit works',
        tier: 'hard',
        checks: [{ click: { role: 'button' } }],
      },
      { id: 'AC-2', text: 'looks polished', tier: 'soft', softThreshold: 0.95 },
      { id: 'AC-3', text: 'nice to have', tier: 'hard', checks: [{ click: { role: 'link' } }] },
    ]);
    expect(detectWeakenedCriteria(base, stronger)).toEqual([]);
  });

  it('ignores criteria absent from one side (added/removed is coverage, not weakening)', () => {
    const next = withCriteria([{ id: 'AC-9', text: 'brand new', tier: 'soft' }]);
    expect(detectWeakenedCriteria(base, next)).toEqual([]);
  });
});

describe('weakenedSincePrevVersion (predecessor diff over the on-disk history)', () => {
  it('returns null for a v1 spec (nothing to compare)', () => {
    const root = tmpProject();
    const { specId, spec } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [
        { id: 'AC-1', text: 'submit works', tier: 'hard', checks: [{ click: { role: 'button' } }] },
      ],
    });
    freezeSpec({ projectRoot: root, specId });
    expect(weakenedSincePrevVersion(root, readSpec(root, specId)!)).toBeNull();
    expect(spec.version).toBe(1);
  });

  it('detects a downgrade between a frozen v1 and the versioned v2', () => {
    const root = tmpProject();
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [
        { id: 'AC-1', text: 'submit works', tier: 'hard', checks: [{ click: { role: 'button' } }] },
      ],
    });
    freezeSpec({ projectRoot: root, specId });
    // A frozen edit that softens AC-1 hard→soft bumps to v2 and snapshots v1.
    const { spec: v2 } = updateSpec({
      projectRoot: root,
      specId,
      patch: { criteria: [{ id: 'AC-1', text: 'submit works', tier: 'soft' }] },
    });
    expect(v2.version).toBe(2);
    const found = weakenedSincePrevVersion(root, v2);
    expect(found).not.toBeNull();
    expect(found!.fromVersion).toBe(1);
    expect(found!.weakenings).toEqual([
      expect.objectContaining({ id: 'AC-1', kind: 'tier-softened' }),
    ]);
  });
});
