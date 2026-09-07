/**
 * `validity onboard review` — the ONE-ACTION batch review+freeze surface.
 *
 * Tests build a temp project with a spec store (mirroring spec.test.ts's
 * mkdtempSync + .validity/ + writeSpec/createSpec pattern) and exercise the
 * four behaviors the contract pins:
 *
 *   1. review lists ONLY probation-carrying draft/reviewed specs, grouped by
 *      batch (a non-bulk draft is left out).
 *   2. --approve approves AND freezes every pending spec in one invocation;
 *      the frozen specs STILL carry probation (it outlives freeze — only a
 *      confirmed clean `verify --all` pass lifts it via clearSpecProbation).
 *   3. --batch narrows the listing to one batch id.
 *   4. a second run reports `nothing pending` (everything got frozen).
 *
 * The coverage header feed (buildCatalog → computeOnboardReport) is stubbed
 * out — these tests pin the review+freeze behavior, not the catalog walker
 * (onboard-tools.test.ts already covers the catalog→report pipeline).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createSpec, readSpec, type Spec, type SpecCriterion } from '@validity.ai/verify-spec';

// The coverage pre-flight calls loadConfig (best-effort) and buildCatalog. We
// don't need a real React tree for these tests — stub both so the header is a
// deterministic no-baseline report and never touches the filesystem walker.
vi.mock('@validity.ai/verify-spec', () => ({
  loadConfig: vi.fn(async () => ({ config: {} })),
}));
vi.mock('@validity.ai/verify-spec', async () => {
  const actual = await vi.importActual<typeof import('@validity.ai/verify-spec')>('@validity.ai/verify-spec');
  return {
    ...actual,
    buildCatalog: vi.fn(() => ({
      entries: [],
      navigation: [],
      counts: { components: 0, screens: 0, views: 0 },
    })),
  };
});
import { runOnboard } from './onboard.js';

const HARD: SpecCriterion = {
  id: 'AC-1',
  text: 'renders a button',
  tier: 'hard',
  checks: [{ click: { role: 'button' } }],
};
const SOFT: SpecCriterion = { id: 'AC-2', text: 'looks polished', tier: 'soft' };

function tmpProject(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-onboard-review-'));
  mkdirSync(resolve(root, '.validity'), { recursive: true });
  return root;
}

/** Probation-carrying draft spec minted by the bulk-onboard pass. */
function makeBulkDraft(root: string, batchId: string | undefined, over: Partial<Spec> = {}): Spec {
  const { spec } = createSpec({
    projectRoot: root,
    prompt: 'bulk',
    criteria: [HARD, SOFT],
    targets: { components: ['src/Widget.tsx'] },
    probation: batchId === undefined ? {} : { batchId },
    createdAt: '2026-07-04T00:00:00.000Z',
    ...over,
  });
  return spec;
}

describe('validity onboard review', () => {
  let root: string;
  let stdout: string;
  let stderr: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = tmpProject();
    stdout = '';
    stderr = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      stdout += String(s);
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      stderr += String(s);
      return true;
    });
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it('lists only probation-carrying draft/reviewed specs, grouped by batch (a non-bulk draft is left out)', async () => {
    makeBulkDraft(root, 'batch-1'); // pending, batch-1
    makeBulkDraft(root, 'batch-2'); // pending, batch-2
    makeBulkDraft(root, undefined); // pending, no batch
    // Non-bulk draft — NO probation — must NOT appear in the review listing.
    createSpec({
      projectRoot: root,
      prompt: 'hand-written',
      criteria: [HARD],
      createdAt: '2026-07-04T00:00:00.000Z',
    });

    await runOnboard('review', { cwd: root });

    // Three batch group headers (batch-1, batch-2, '(no batch)'), each with
    // one pending spec.
    expect(stdout).toContain('Batch: batch-1');
    expect(stdout).toContain('Batch: batch-2');
    expect(stdout).toContain('Batch: (no batch)');
    // The hand-written draft's id must NOT appear in the review listing.
    const specs = stdout
      .split('\n')
      .filter((l) => /^spec-[0-9a-f]+\s/.test(l))
      .map((l) => l.trim().split(/\s+/)[0]);
    // Only 3 specs listed (the probation-carrying ones), not 4.
    expect(specs.length).toBe(3);
    // Status column shows draft for all listed.
    expect(stdout).toMatch(/draft/);
    // Hint footer points at --approve.
    expect(stdout).toContain('--approve');
    // No approval happened yet.
    expect(stdout).not.toMatch(/Approved \d/);
  });

  it('--approve approves AND freezes all pending in one invocation; frozen specs still carry probation', async () => {
    const s1 = makeBulkDraft(root, 'batch-1');
    const s2 = makeBulkDraft(root, 'batch-1');
    // Non-bulk draft stays a draft (not approved, not frozen).
    const hand = createSpec({
      projectRoot: root,
      prompt: 'hand-written',
      criteria: [HARD],
      createdAt: '2026-07-04T00:00:00.000Z',
    });

    await runOnboard('review', { cwd: root, approve: true });

    // Both bulk specs froze in this single action.
    expect(stdout).toMatch(/Approved 2, frozen 2/);
    const after1 = readSpec(root, s1.id)!;
    const after2 = readSpec(root, s2.id)!;
    expect(after1.status).toBe('frozen');
    expect(after2.status).toBe('frozen');
    // PROBATION OUTLIVES FREEZE — the marker is still stamped on the frozen
    // specs. Only a confirmed clean `verify --all` pass (clearSpecProbation)
    // lifts it; `onboard review --approve` must NOT clear it.
    expect(after1.probation).toBeDefined();
    expect(after1.probation?.batchId).toBe('batch-1');
    expect(after2.probation).toBeDefined();
    expect(after2.probation?.batchId).toBe('batch-1');
    // Hash got bound (freeze ran) — but probation presence didn't perturb it.
    expect(after1.hash).toBeTruthy();

    // The hand-written non-bulk draft is untouched: still a draft, no probation.
    const handAfter = readSpec(root, hand.specId)!;
    expect(handAfter.status).toBe('draft');
    expect(handAfter.probation).toBeUndefined();
  });

  it('--batch filters the listing to specs minted under that batch id only', async () => {
    makeBulkDraft(root, 'batch-1');
    makeBulkDraft(root, 'batch-2');
    makeBulkDraft(root, undefined); // no batch — must NOT match --batch batch-1

    await runOnboard('review', { cwd: root, batch: 'batch-1' });

    expect(stdout).toContain('Batch: batch-1');
    expect(stdout).not.toContain('Batch: batch-2');
    expect(stdout).not.toContain('Batch: (no batch)');
    // Only the one batch-1 spec is listed.
    const listed = stdout
      .split('\n')
      .filter((l) => /^spec-[0-9a-f]+\s/.test(l))
      .map((l) => l.trim().split(/\s+/)[0]);
    expect(listed.length).toBe(1);
  });

  it('a second run reports nothing pending (everything got frozen by the first --approve)', async () => {
    makeBulkDraft(root, 'batch-1');
    makeBulkDraft(root, 'batch-1');

    await runOnboard('review', { cwd: root, approve: true });
    expect(stdout).toMatch(/Approved 2, frozen 2/);

    // Reset captured stdout for the second run.
    stdout = '';
    await runOnboard('review', { cwd: root });
    expect(stdout).toContain('nothing pending');
    // No batch headers, no review table — the listing is empty by design.
    expect(stdout).not.toContain('Batch:');
  });

  it('a missing subcommand exits non-zero with a clear error', async () => {
    await expect(runOnboard(undefined, { cwd: root })).rejects.toThrow('__exit_2');
    expect(stderr).toContain('needs a subcommand');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('--json prints a machine-readable report (and approves when --approve is also set)', async () => {
    const s1 = makeBulkDraft(root, 'batch-1');
    makeBulkDraft(root, 'batch-2');

    await runOnboard('review', { cwd: root, json: true });
    const parsed = JSON.parse(stdout) as {
      pending: string[];
      batches: Array<{ batch: string; specs: Array<{ id: string; batchId: string | null }> }>;
      approved: unknown;
    };
    expect(parsed.pending.length).toBe(2);
    expect(parsed.batches.map((b) => b.batch).sort()).toEqual(['batch-1', 'batch-2']);
    expect(parsed.approved).toBeNull();
    void s1;

    // --json --approve actually runs the approval and reports the outcome.
    stdout = '';
    await runOnboard('review', { cwd: root, json: true, approve: true });
    const approvedParsed = JSON.parse(stdout) as {
      approved: { approved: string[]; frozen: number };
    };
    expect(approvedParsed.approved.approved.length).toBe(2);
    expect(approvedParsed.approved.frozen).toBe(2);
  });
});
