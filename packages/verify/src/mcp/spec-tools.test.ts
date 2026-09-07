/**
 * Spec lifecycle handler tests. These call the handlers DIRECTLY (no MCP
 * transport) against a throwaway project dir so we exercise the real
 * @validity.ai/verify-spec store + the agent-facing UX (ids returned, validation
 * surfaced inline, deterministic review findings). The handlers return the
 * MCP `ServerResult` shape; we read `content[0].text`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerResult } from '@modelcontextprotocol/sdk/types.js';
import {
  auditSpec,
  handleSpecCreate,
  handleSpecFreeze,
  handleSpecGet,
  handleSpecList,
  handleSpecReview,
  handleSpecUpdate,
  splitClauses,
} from './spec-tools.js';
import {
  CHECK_COMPILER_VERSION,
  createSpec,
  indexRunForSpec,
  readSpec,
  type RunMeta,
  type Spec,
} from '@validity.ai/verify-spec';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'validity-spec-tools-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Pull the first text block out of a ServerResult. */
function bodyOf(res: ServerResult): string {
  const first = res.content[0];
  if (first?.type !== 'text') throw new Error('expected a text content block');
  return first.text;
}

/** Extract a created spec id (`spec-xxxx`) from create/list output. */
function specIdIn(body: string): string {
  const m = body.match(/spec-[0-9a-f]+/);
  if (!m) throw new Error(`no spec id in: ${body}`);
  return m[0];
}

describe('handleSpecCreate', () => {
  it('creates a draft spec and returns its id + criteria', async () => {
    const res = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Users can submit the contact form.',
      criteria: [{ id: 'AC-1', text: 'User can submit the contact form', tier: 'soft' }],
    });
    expect(res.isError).toBeFalsy();
    const body = bodyOf(res);
    const id = specIdIn(body);
    expect(body).toContain('status: draft');
    expect(body).toContain('AC-1');

    const onDisk = readSpec(root, id);
    expect(onDisk?.status).toBe('draft');
    expect(onDisk?.criteria).toHaveLength(1);
  });

  it('surfaces a SpecValidationError inline for a hard criterion with no checks', async () => {
    const res = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Submit works.',
      criteria: [{ id: 'AC-1', text: 'Submit works', tier: 'hard' }],
    });
    expect(res.isError).toBe(true);
    expect(bodyOf(res)).toMatch(/validation error/i);
    expect(bodyOf(res)).toMatch(/checks/i);
  });

  it('Phase C: bulk+batchId stamps probation.since + probation.batchId on the spec', async () => {
    const res = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Submit works.',
      criteria: [{ id: 'AC-1', text: 'Submit works', tier: 'soft' }],
      bulk: true,
      batchId: 'batch-42',
    });
    expect(res.isError).toBeFalsy();
    const body = bodyOf(res);
    const id = specIdIn(body);
    // Success message announces the probation + the batch id.
    expect(body).toContain('On probation (bulk batch batch-42)');
    expect(body).toMatch(/needs-review \(low\)/);

    const onDisk = readSpec(root, id) as Spec;
    expect(onDisk.probation).toBeDefined();
    expect(onDisk.probation?.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(onDisk.probation?.batchId).toBe('batch-42');
  });

  it('Phase C: a batchId alone (no bulk flag) still stamps probation for the batch', async () => {
    const res = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Submit works.',
      criteria: [{ id: 'AC-1', text: 'Submit works', tier: 'soft' }],
      batchId: 'batch-7',
    });
    expect(res.isError).toBeFalsy();
    const id = specIdIn(bodyOf(res));
    const onDisk = readSpec(root, id) as Spec;
    // batchId groups the batch → probation applies the same downgrade.
    expect(onDisk.probation).toBeDefined();
    expect(onDisk.probation?.batchId).toBe('batch-7');
  });

  it('Phase C: no bulk/batchId leaves the spec with NO probation field', async () => {
    const res = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Submit works.',
      criteria: [{ id: 'AC-1', text: 'Submit works', tier: 'soft' }],
    });
    expect(res.isError).toBeFalsy();
    const id = specIdIn(bodyOf(res));
    const onDisk = readSpec(root, id) as Spec;
    expect(onDisk.probation).toBeUndefined();
    expect(bodyOf(res)).not.toContain('On probation');
  });
});

describe('handleSpecFreeze', () => {
  it('freezes a draft and binds a hash', async () => {
    const created = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Submit works.',
      criteria: [{ id: 'AC-1', text: 'Submit works', tier: 'soft' }],
    });
    const id = specIdIn(bodyOf(created));

    const res = await handleSpecFreeze({ projectRoot: root, specId: id });
    expect(res.isError).toBeFalsy();
    expect(bodyOf(res)).toContain('frozen');

    const onDisk = readSpec(root, id) as Spec;
    expect(onDisk.status).toBe('frozen');
    expect(onDisk.hash).toMatch(/^sha256-/);
  });

  it('#4 BLOCKS freezing a stale-compiler spec whose recompile changes the bar', async () => {
    // Seed a draft compiled under an old contract whose text compiles to HARD today.
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [{ id: 'AC-1', text: 'renders with no console errors', tier: 'soft' }],
      compiledWith: '1',
    });
    const res = await handleSpecFreeze({ projectRoot: root, specId });
    expect(res.isError).toBe(true);
    expect(bodyOf(res)).toMatch(/BLOCKED/);
    expect(bodyOf(res)).toMatch(/acceptRecompile/);
    // Still a draft — nothing was locked.
    expect(readSpec(root, specId)!.status).toBe('draft');
  });

  it('#4 acceptRecompile adopts the recompiled bar, re-stamps, and freezes', async () => {
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [{ id: 'AC-1', text: 'renders with no console errors', tier: 'soft' }],
      compiledWith: '1',
    });
    const res = await handleSpecFreeze({ projectRoot: root, specId, acceptRecompile: true });
    expect(res.isError).toBeFalsy();
    const onDisk = readSpec(root, specId)!;
    expect(onDisk.status).toBe('frozen');
    expect(onDisk.source.compiledWith).toBe(CHECK_COMPILER_VERSION);
    expect(onDisk.criteria[0]!.tier).toBe('hard'); // recompiled bar adopted
  });

  it('#4 a stale stamp with an IDENTICAL recompile re-stamps + freezes with no flag', async () => {
    // Aesthetic text stays soft under every contract → safe transparent re-stamp.
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [{ id: 'AC-1', text: 'looks polished and on-brand', tier: 'soft' }],
      compiledWith: '1',
    });
    const res = await handleSpecFreeze({ projectRoot: root, specId });
    expect(res.isError).toBeFalsy();
    const onDisk = readSpec(root, specId)!;
    expect(onDisk.status).toBe('frozen');
    expect(onDisk.source.compiledWith).toBe(CHECK_COMPILER_VERSION);
    expect(onDisk.criteria[0]!.tier).toBe('soft'); // bar unchanged
  });

  it('Phase C: specApproval-always freeze rejection names `validity onboard review`', async () => {
    // Seed a project with specApproval: 'always' so freeze requires approval.
    mkdirSync(resolve(root, '.validity'), { recursive: true });
    writeFileSync(
      resolve(root, '.validity', 'config.ts'),
      `export default {\n` +
        `  renderMode: 'web' as const,\n` +
        `  framework: 'auto' as const,\n` +
        `  wrapper: './.validity/wrapper.gen.tsx',\n` +
        `  specApproval: 'always' as const,\n` +
        `};\n`,
    );
    const created = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Submit works.',
      criteria: [{ id: 'AC-1', text: 'Submit works', tier: 'soft' }],
    });
    const id = specIdIn(bodyOf(created));

    const res = await handleSpecFreeze({ projectRoot: root, specId: id });
    expect(res.isError).toBe(true);
    const body = bodyOf(res);
    expect(body).toMatch(/specApproval: 'always'/);
    expect(body).toContain('validity onboard review');
    expect(body).toContain('--approve');
    // The spec stays a draft — nothing was locked.
    expect(readSpec(root, id)!.status).toBe('draft');
  });
});

describe('handleSpecUpdate', () => {
  it('versions a FROZEN spec into a new draft at v+1 with lineage', async () => {
    const created = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Submit works.',
      criteria: [{ id: 'AC-1', text: 'Submit works', tier: 'soft' }],
    });
    const id = specIdIn(bodyOf(created));
    await handleSpecFreeze({ projectRoot: root, specId: id });

    const res = await handleSpecUpdate({
      projectRoot: root,
      specId: id,
      patch: {
        criteria: [
          { id: 'AC-1', text: 'Submit works', tier: 'soft' },
          { id: 'AC-2', text: 'Shows a toast on success', tier: 'soft' },
        ],
      },
      by: 'agent-b',
    });
    expect(res.isError).toBeFalsy();
    const body = bodyOf(res);
    expect(body).toContain('v2');

    const onDisk = readSpec(root, id) as Spec;
    expect(onDisk.version).toBe(2);
    expect(onDisk.status).toBe('draft');
    expect(onDisk.supersedes).toBe(`${id}@v1`);
    expect(onDisk.criteria).toHaveLength(2);
    expect(onDisk.source.reviewedBy).toContain('agent-b');
  });

  it('refuses to freeze/approve via spec_update and surfaces the error inline', async () => {
    const created = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Submit works.',
      criteria: [{ id: 'AC-1', text: 'Submit works', tier: 'soft' }],
    });
    const id = specIdIn(bodyOf(created));

    const frozen = await handleSpecUpdate({
      projectRoot: root,
      specId: id,
      patch: { status: 'frozen' },
    });
    expect(frozen.isError).toBe(true);
    expect(bodyOf(frozen)).toMatch(/spec_freeze/);

    const approved = await handleSpecUpdate({
      projectRoot: root,
      specId: id,
      patch: { status: 'approved' },
    });
    expect(approved.isError).toBe(true);
    expect(bodyOf(approved)).toMatch(/freeze/i);

    // Neither attempt mutated the on-disk spec — it stays a hashless draft.
    const onDisk = readSpec(root, id) as Spec;
    expect(onDisk.status).toBe('draft');
    expect(onDisk.hash).toBeUndefined();
  });

  it('lets a reviewer set status to reviewed', async () => {
    const created = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Submit works.',
      criteria: [{ id: 'AC-1', text: 'Submit works', tier: 'soft' }],
    });
    const id = specIdIn(bodyOf(created));

    const res = await handleSpecUpdate({
      projectRoot: root,
      specId: id,
      patch: { status: 'reviewed' },
      by: 'agent-r',
    });
    expect(res.isError).toBeFalsy();
    const onDisk = readSpec(root, id) as Spec;
    expect(onDisk.status).toBe('reviewed');
    expect(onDisk.source.reviewedBy).toContain('agent-r');
  });

  it('amends a DRAFT in place without bumping the version', async () => {
    const created = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Submit works.',
      criteria: [{ id: 'AC-1', text: 'Submit works', tier: 'soft' }],
    });
    const id = specIdIn(bodyOf(created));

    await handleSpecUpdate({
      projectRoot: root,
      specId: id,
      patch: { conditions: { viewports: [375, 1280] } },
    });
    const onDisk = readSpec(root, id) as Spec;
    expect(onDisk.version).toBe(1);
    expect(onDisk.conditions?.viewports).toEqual([375, 1280]);
  });
});

describe('handleSpecReview', () => {
  it('surfaces an uncovered clause and a promote candidate', async () => {
    const created = await handleSpecCreate({
      projectRoot: root,
      prompt: 'Users can submit the contact form. The dashboard displays recent orders.',
      // Only the contact-form clause is covered; the dashboard clause is not.
      // AC-1 is soft but contains the action verb "submit" → promote candidate.
      criteria: [{ id: 'AC-1', text: 'User can submit the contact form', tier: 'soft' }],
    });
    const id = specIdIn(bodyOf(created));

    const res = await handleSpecReview({ projectRoot: root, specId: id });
    expect(res.isError).toBeFalsy();
    const body = bodyOf(res);

    // Coverage finding: the dashboard clause has no related criterion.
    expect(body.toLowerCase()).toContain('dashboard');
    expect(body).toContain('uncovered');
    // Tier finding: AC-1 flagged for promotion (verb "submit").
    expect(body).toContain('promote AC-1');
    expect(body).toContain('submit');
    // Never edits.
    expect(body).toContain('never edits');

    // The on-disk spec is untouched by review.
    const onDisk = readSpec(root, id) as Spec;
    expect(onDisk.criteria[0].tier).toBe('soft');
  });

  it('errors clearly for an unknown spec id', async () => {
    const res = await handleSpecReview({ projectRoot: root, specId: 'spec-nope' });
    expect(res.isError).toBe(true);
    expect(bodyOf(res)).toContain('not found');
  });
});

describe('handleSpecList', () => {
  it('filters by status', async () => {
    const a = await handleSpecCreate({
      projectRoot: root,
      prompt: 'A',
      criteria: [{ id: 'AC-1', text: 'first', tier: 'soft' }],
    });
    await handleSpecCreate({
      projectRoot: root,
      prompt: 'B',
      criteria: [{ id: 'AC-1', text: 'second', tier: 'soft' }],
    });
    const frozenId = specIdIn(bodyOf(a));
    await handleSpecFreeze({ projectRoot: root, specId: frozenId });

    const all = await handleSpecList({ projectRoot: root });
    expect(bodyOf(all)).toContain(': 2');

    const frozen = await handleSpecList({ projectRoot: root, status: 'frozen' });
    const body = bodyOf(frozen);
    expect(body).toContain(': 1');
    expect(body).toContain(frozenId);
  });

  it('filters by target component', async () => {
    const created = await handleSpecCreate({
      projectRoot: root,
      prompt: 'A',
      criteria: [{ id: 'AC-1', text: 'first', tier: 'soft' }],
      targets: { components: ['ContactForm'] },
    });
    const id = specIdIn(bodyOf(created));
    await handleSpecCreate({
      projectRoot: root,
      prompt: 'B',
      criteria: [{ id: 'AC-1', text: 'second', tier: 'soft' }],
      targets: { components: ['Toast'] },
    });

    const res = await handleSpecList({ projectRoot: root, component: 'contactform' });
    const body = bodyOf(res);
    expect(body).toContain(': 1');
    expect(body).toContain(id);
  });
});

describe('handleSpecGet', () => {
  it('renders the spec yaml + a no-runs note', async () => {
    const created = await handleSpecCreate({
      projectRoot: root,
      prompt: 'A',
      criteria: [{ id: 'AC-1', text: 'first', tier: 'soft' }],
    });
    const id = specIdIn(bodyOf(created));

    const res = await handleSpecGet({ projectRoot: root, specId: id });
    const body = bodyOf(res);
    expect(body).toContain(id);
    expect(body).toContain('```yaml');
    expect(body).toContain('Recent run verdicts: none yet');
    expect(body).toContain(`planId: "${id}"`);
  });

  it('surfaces the runs.jsonl regression timeline once runs are indexed (B4)', async () => {
    const created = await handleSpecCreate({
      projectRoot: root,
      prompt: 'A',
      criteria: [{ id: 'AC-1', text: 'first', tier: 'soft' }],
    });
    const id = specIdIn(bodyOf(created));
    const meta: RunMeta = {
      runId: 'run_spec_get_001',
      createdAt: '2026-07-01T10:00:00.000Z',
      prompt: 'A',
      scenarios: [],
      components: [],
      diff: { files: [] },
      report: { enabled: true, brand: 'validity' },
      specId: id,
      signedOff: false,
      criterionVerdicts: [{ id: 'AC-1', tier: 'soft', status: 'unverifiable' }],
    };
    indexRunForSpec(root, meta);

    const body = bodyOf(await handleSpecGet({ projectRoot: root, specId: id }));
    expect(body).toContain('Recent run verdicts (last 1, newest last):');
    expect(body).toContain('run_spec_get_001');
    expect(body).toContain('signedOff=false');
  });
});

describe('deterministic audit internals', () => {
  it('splitClauses breaks on terminators and conjunctions', () => {
    const clauses = splitClauses('Open the modal and close it. Then save the draft; reload.');
    // "open ... modal", "close it", "then save ... draft", "reload"
    expect(clauses.length).toBeGreaterThanOrEqual(3);
    expect(clauses.some((c) => /modal/i.test(c))).toBe(true);
    expect(clauses.some((c) => /save/i.test(c))).toBe(true);
  });

  it('auditSpec flags hard selectors that rely only on testId', () => {
    const spec: Spec = {
      id: 'spec-x',
      version: 1,
      status: 'draft',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      criteria: [
        {
          id: 'AC-1',
          text: 'click submit',
          tier: 'hard',
          checks: [{ click: { testId: 'submit-btn' } }],
        },
      ],
      createdAt: new Date().toISOString(),
    };
    const findings = auditSpec(spec, 'click submit');
    expect(findings.durabilityNotes).toEqual([{ id: 'AC-1', basis: 'testId' }]);
    // No conditions → nemesis note present.
    expect(findings.nemesisNotes.length).toBeGreaterThan(0);
  });

  it('auditSpec flags soft criteria that hinge on pixel-invisible a11y attributes (mis-tiered by construction)', () => {
    const spec: Spec = {
      id: 'spec-a11y-soft',
      version: 1,
      status: 'draft',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      criteria: [
        {
          id: 'AC-1',
          text: 'The a11y contract stays intact: the testID and accessible name are preserved',
          tier: 'soft',
        },
        // Visible copy that merely CONTAINS "role" — must not be flagged.
        { id: 'AC-2', text: 'The user role badge shows Admin', tier: 'soft' },
      ],
      createdAt: new Date().toISOString(),
    };
    const findings = auditSpec(spec, 'keep the accessibility contract');
    expect(findings.pixelInvisibleNotes).toEqual([
      { id: 'AC-1', terms: ['testID', 'accessible name/label/role', 'a11y'] },
    ]);
  });

  it('auditSpec flags a metric budgeted by more than one criterion', () => {
    const spec: Spec = {
      id: 'spec-perf-dup',
      version: 1,
      status: 'draft',
      source: { prompt: 'fast', createdBy: 'agent' },
      runtime: 'web',
      criteria: [
        {
          id: 'AC-1',
          text: 'renders fast',
          tier: 'hard',
          checks: [{ expect: { performance: { metric: 'ready', maxMs: 1000 } } }],
        },
        {
          id: 'AC-2',
          text: 'also renders fast',
          tier: 'hard',
          checks: [{ expect: { performance: { metric: 'ready', maxMs: 800 } } }],
        },
      ],
      createdAt: new Date().toISOString(),
    };
    const findings = auditSpec(spec, 'renders fast');
    expect(findings.perfNotes.some((n) => /metric "ready" is budgeted by AC-1, AC-2/.test(n))).toBe(
      true,
    );
  });

  it('auditSpec flags a soft "feels fast" criterion overlapping a hard perf budget', () => {
    const spec: Spec = {
      id: 'spec-perf-soft',
      version: 1,
      status: 'draft',
      source: { prompt: 'fast', createdBy: 'agent' },
      runtime: 'web',
      criteria: [
        {
          id: 'AC-1',
          text: 'loads quickly',
          tier: 'hard',
          checks: [{ expect: { performance: { metric: 'ready', maxMs: 1000 } } }],
        },
        { id: 'AC-2', text: 'the page should feel snappy', tier: 'soft' },
      ],
      createdAt: new Date().toISOString(),
    };
    const findings = auditSpec(spec, 'fast');
    expect(findings.perfNotes.some((n) => /soft criterion AC-2/.test(n))).toBe(true);
  });
});

describe('auditSpec — dataState findings (A2)', () => {
  const specWith = (criteria: Spec['criteria']): Spec => ({
    id: 'spec-ds-audit',
    version: 1,
    status: 'draft',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    conditions: { viewports: [375], network: ['normal'] },
    criteria,
    createdAt: new Date().toISOString(),
  });

  it('stamps the compiler-detected dataState on a promote candidate', () => {
    const spec = specWith([
      {
        id: 'AC-1',
        text: 'Shows a "No results found" message when the list is empty',
        tier: 'soft',
      },
    ]);
    const findings = auditSpec(spec, 'empty list handling');
    const candidate = findings.promoteCandidates.find((p) => p.id === 'AC-1');
    expect(candidate?.suggestedChecks?.length).toBeGreaterThan(0);
    expect(candidate?.dataState).toBe('empty');
  });

  it('emits a nemesis note when the text names a data state the criterion does not condition on', () => {
    const spec = specWith([
      {
        id: 'AC-err',
        text: 'shows an error banner when the request fails',
        tier: 'hard',
        checks: [{ expect: { element: { role: 'alert', state: 'visible' } } }],
        // NO dataState — hand-authored spec that missed the condition.
      },
    ]);
    const findings = auditSpec(spec, 'error handling');
    expect(
      findings.nemesisNotes.some((n) =>
        n.includes("criterion AC-err mentions a 'error' data state but has no dataState condition"),
      ),
    ).toBe(true);
  });

  it('stays quiet when the criterion already carries the dataState condition', () => {
    const spec = specWith([
      {
        id: 'AC-err',
        text: 'shows an error banner when the request fails',
        tier: 'hard',
        dataState: 'error',
        checks: [{ expect: { element: { role: 'alert', state: 'visible' } } }],
      },
    ]);
    const findings = auditSpec(spec, 'error handling');
    expect(findings.nemesisNotes.some((n) => n.includes('data state'))).toBe(false);
  });
});

describe('criterion weakening surfacing (Finding 4 — surface, never gate)', () => {
  /** Freeze a v1 hard criterion, then version to a v2 that softens it hard→soft. */
  async function seedWeakenedV2(): Promise<string> {
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'Submit works',
      criteria: [
        {
          id: 'AC-1',
          text: 'Submit works',
          tier: 'hard',
          checks: [{ click: { role: 'button', name: 'Send' } }],
        },
      ],
    });
    await handleSpecFreeze({ projectRoot: root, specId }); // v1 frozen, hard
    // Softening edit → bumps to v2 draft, snapshots v1 to history/.
    await handleSpecUpdate({
      projectRoot: root,
      specId,
      patch: { criteria: [{ id: 'AC-1', text: 'Submit works', tier: 'soft' }] },
    });
    return specId;
  }

  it('spec_review section 7 flags a hard→soft softening vs the predecessor version', async () => {
    const specId = await seedWeakenedV2();
    const body = bodyOf(await handleSpecReview({ projectRoot: root, specId }));
    expect(body).toMatch(/Criterion weakening/);
    expect(body).toMatch(/WEAKENED since v1/);
    expect(body).toContain('AC-1');
    expect(body).toMatch(/tier hard → soft/);
  });

  it('spec_review reports a clean v1 spec with nothing to compare against', async () => {
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'p',
      criteria: [{ id: 'AC-1', text: 'looks polished', tier: 'soft' }],
    });
    await handleSpecFreeze({ projectRoot: root, specId });
    const body = bodyOf(await handleSpecReview({ projectRoot: root, specId }));
    expect(body).toMatch(/first version — nothing to compare/);
  });

  it('spec_freeze names the downgrade on the freeze receipt when locking the weakened v2', async () => {
    const specId = await seedWeakenedV2();
    const body = bodyOf(await handleSpecFreeze({ projectRoot: root, specId }));
    expect(body).toContain('frozen');
    expect(body).toMatch(/WEAKENED since v1/);
    expect(body).toContain('AC-1');
  });
});
