/**
 * Pure temporal-binding classifier (B2) — table-driven, no git — plus one
 * end-to-end canonical-workflow suite on a real temp repo. The honesty
 * invariant lives here: a mid-work freeze (overlap between the freeze-dirty
 * set and the run's work set) can NEVER classify `frozen-before-work`, no
 * matter what the ancestry facts say.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpecGitBinding } from './spec-schema.js';
import { createSpec, freezeSpec } from './specs.js';
import {
  aggregateTemporalClassifications,
  classifyTemporalBinding,
  resolveTemporalBinding,
} from './temporal-binding.js';

const FREEZE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VERIFY_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function freeze(over: Partial<SpecGitBinding> = {}): SpecGitBinding {
  return { sha: FREEZE_SHA, dirty: false, changedFiles: [], ...over };
}

describe('classifyTemporalBinding', () => {
  it('rule 1: no freeze binding → unknown, reason names the freeze side + the re-freeze remedy', () => {
    const r = classifyTemporalBinding({ verifySha: VERIFY_SHA, runDiffFiles: ['src/Foo.tsx'] });
    expect(r.classification).toBe('unknown');
    expect(r.reason).toMatch(/frozen/);
    expect(r.reason).toMatch(/re-freeze|freeze stamps one/);
  });

  it('rule 1: no verify sha → unknown, reason names the verify side', () => {
    const r = classifyTemporalBinding({ freeze: freeze(), runDiffFiles: [] });
    expect(r.classification).toBe('unknown');
    expect(r.reason).toMatch(/verify time/);
  });

  it('rule 1: neither side recorded → unknown', () => {
    const r = classifyTemporalBinding({ runDiffFiles: [] });
    expect(r.classification).toBe('unknown');
    expect(r.reason).toMatch(/no git state recorded at freeze or verify/);
  });

  it("rule 2 (HONESTY): freeze-dirty ∩ run diff ⇒ frozen-mid-work even with ancestry true and equal shas — a mid-work freeze can NEVER read 'frozen-before-work'", () => {
    const r = classifyTemporalBinding({
      freeze: freeze({ sha: VERIFY_SHA, dirty: true, changedFiles: ['src/Foo.tsx'] }),
      verifySha: VERIFY_SHA,
      runDiffFiles: ['src/Foo.tsx'],
      freezeIsAncestorOfVerify: true,
    });
    expect(r.classification).toBe('frozen-mid-work');
    expect(r.classification).not.toBe('frozen-before-work');
    expect(r.overlap).toEqual(['src/Foo.tsx']);
    expect(r.reason).toMatch(/already uncommitted when the spec was frozen/);
  });

  it('rule 2 fires via COMMITTED overlap too (work landed between freeze and verify)', () => {
    const r = classifyTemporalBinding({
      freeze: freeze({ dirty: true, changedFiles: ['src/Foo.tsx'] }),
      verifySha: VERIFY_SHA,
      runDiffFiles: [],
      freezeIsAncestorOfVerify: true,
      committedFiles: ['src/Foo.tsx'],
    });
    expect(r.classification).toBe('frozen-mid-work');
    expect(r.overlap).toEqual(['src/Foo.tsx']);
  });

  it('#24: committed overlap on a NON-ancestor (different branch / rewritten history) does NOT false-positive mid-work', () => {
    // freeze is NOT an ancestor of verify → the committedFiles diff is
    // cross-branch divergence, not this run's work. Path overlap on it must not
    // read as frozen-mid-work; with no uncommitted overlap this stays `unknown`.
    const r = classifyTemporalBinding({
      freeze: freeze({ dirty: true, changedFiles: ['src/Foo.tsx'] }),
      verifySha: VERIFY_SHA,
      runDiffFiles: [],
      freezeIsAncestorOfVerify: false,
      committedFiles: ['src/Foo.tsx'], // same path, but cross-branch noise
    });
    expect(r.classification).toBe('unknown');
    expect(r.overlap).toEqual([]);
  });

  it("#24: the RUN's own uncommitted overlap still fires mid-work even on a non-ancestor", () => {
    // runDiffFiles overlap is ancestry-independent evidence and must still count.
    const r = classifyTemporalBinding({
      freeze: freeze({ dirty: true, changedFiles: ['src/Foo.tsx'] }),
      verifySha: VERIFY_SHA,
      runDiffFiles: ['src/Foo.tsx'],
      freezeIsAncestorOfVerify: false,
      committedFiles: ['unrelated.ts'],
    });
    expect(r.classification).toBe('frozen-mid-work');
    expect(r.overlap).toEqual(['src/Foo.tsx']);
  });

  it('rule 2 lists at most 5 overlap files in the reason and counts the rest', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `src/${n}.tsx`);
    const r = classifyTemporalBinding({
      freeze: freeze({ dirty: true, changedFiles: files }),
      verifySha: VERIFY_SHA,
      runDiffFiles: files,
      freezeIsAncestorOfVerify: true,
    });
    expect(r.classification).toBe('frozen-mid-work');
    expect(r.overlap).toHaveLength(7);
    expect(r.reason).toMatch(/\+2 more/);
  });

  it('rule 3: truncated freeze-dirty list + no visible overlap → unknown, never before-work', () => {
    const r = classifyTemporalBinding({
      freeze: freeze({ dirty: true, changedFiles: ['other.txt'], changedFilesTruncated: true }),
      verifySha: VERIFY_SHA,
      runDiffFiles: ['src/Foo.tsx'],
      freezeIsAncestorOfVerify: true,
    });
    expect(r.classification).toBe('unknown');
    expect(r.reason).toMatch(/truncated/);
  });

  it('rule 4 (uncommitted flow): clean freeze at the same sha, disjoint diff → frozen-before-work', () => {
    const r = classifyTemporalBinding({
      freeze: freeze({ sha: VERIFY_SHA }),
      verifySha: VERIFY_SHA,
      runDiffFiles: ['src/Foo.tsx'],
      freezeIsAncestorOfVerify: true,
    });
    expect(r.classification).toBe('frozen-before-work');
    expect(r.reason).toMatch(/no overlap with the 1 changed file/);
  });

  it('rule 4 (committed flow): ancestor + committedFiles disjoint from freeze-dirty → frozen-before-work', () => {
    const r = classifyTemporalBinding({
      freeze: freeze({ dirty: true, changedFiles: ['README.md'] }),
      verifySha: VERIFY_SHA,
      runDiffFiles: [],
      freezeIsAncestorOfVerify: true,
      committedFiles: ['src/Foo.tsx'],
    });
    expect(r.classification).toBe('frozen-before-work');
  });

  it('rule 4 (no work detected): ancestor + empty work set → frozen-before-work with the no-changes reason', () => {
    const r = classifyTemporalBinding({
      freeze: freeze(),
      verifySha: VERIFY_SHA,
      runDiffFiles: [],
      freezeIsAncestorOfVerify: true,
    });
    expect(r.classification).toBe('frozen-before-work');
    expect(r.reason).toMatch(/no changed files detected this run/);
  });

  it('rule 5: provably NOT an ancestor AND no shared lineage (unrelated branch) → unknown', () => {
    const r = classifyTemporalBinding({
      freeze: freeze(),
      verifySha: VERIFY_SHA,
      runDiffFiles: ['src/Foo.tsx'],
      freezeIsAncestorOfVerify: false,
      sharedLineageWithVerify: false,
    });
    expect(r.classification).toBe('unknown');
    expect(r.reason).toMatch(/shares no history/);
  });

  it('rule 4b (B2 #22): NOT a literal ancestor but shares a merge-base (squash/rebase) + no overlap → frozen-before-work', () => {
    const r = classifyTemporalBinding({
      freeze: freeze(),
      verifySha: VERIFY_SHA,
      runDiffFiles: ['src/Foo.tsx'],
      freezeIsAncestorOfVerify: false,
      sharedLineageWithVerify: true,
    });
    expect(r.classification).toBe('frozen-before-work');
    expect(r.reason).toMatch(/squash-merge or rebase/);
    expect(r.reason).toMatch(/merge-base/);
  });

  it('rule 4b does NOT launder a mid-work freeze: shared lineage + freeze-dirty overlap still → frozen-mid-work', () => {
    const r = classifyTemporalBinding({
      freeze: freeze({ dirty: true, changedFiles: ['src/Foo.tsx'] }),
      verifySha: VERIFY_SHA,
      runDiffFiles: ['src/Foo.tsx'],
      freezeIsAncestorOfVerify: false,
      sharedLineageWithVerify: true,
    });
    expect(r.classification).toBe('frozen-mid-work');
  });

  it('rule 4b does NOT fire on a truncated freeze-dirty list (uncertifiable no-overlap) even with shared lineage → unknown', () => {
    const r = classifyTemporalBinding({
      freeze: freeze({ dirty: true, changedFiles: ['src/A.tsx'], changedFilesTruncated: true }),
      verifySha: VERIFY_SHA,
      runDiffFiles: ['src/Foo.tsx'],
      freezeIsAncestorOfVerify: false,
      sharedLineageWithVerify: true,
    });
    expect(r.classification).toBe('unknown');
  });

  it('rule 5: ancestry UNANSWERABLE (GC’d sha / git failure) → unknown, never before-work', () => {
    const r = classifyTemporalBinding({
      freeze: freeze(),
      verifySha: VERIFY_SHA,
      runDiffFiles: [],
      freezeIsAncestorOfVerify: undefined,
    });
    expect(r.classification).toBe('unknown');
  });

  it("REGRESSION (canonical-workflow misclassification): overlap on Validity's own .validity/ files never fires mid-work — filtered symmetrically on both sides", () => {
    const specFile = '.validity/specs/spec-x/spec.yaml';
    const r = classifyTemporalBinding({
      // A pre-exclusion binding: the freeze-dirty list still carries the spec
      // store's own writes (spec.yaml landed just before the freeze stamped).
      freeze: freeze({
        dirty: true,
        changedFiles: [specFile, '.validity/specs/spec-x/history/v1.yaml'],
      }),
      verifySha: VERIFY_SHA,
      runDiffFiles: [],
      freezeIsAncestorOfVerify: true,
      // Specs are committed by default, so the same file shows up as
      // committed work between freeze and verify.
      committedFiles: [specFile, 'src/Foo.tsx'],
    });
    expect(r.classification).toBe('frozen-before-work');
    expect(r.overlap).toEqual([]);
  });

  it('…but real-file overlap still fires mid-work even when .validity/ files also overlap', () => {
    const r = classifyTemporalBinding({
      freeze: freeze({
        dirty: true,
        changedFiles: ['.validity/specs/spec-x/spec.yaml', 'src/Foo.tsx'],
      }),
      verifySha: VERIFY_SHA,
      runDiffFiles: ['src/Foo.tsx'],
      freezeIsAncestorOfVerify: true,
      committedFiles: ['.validity/specs/spec-x/spec.yaml'],
    });
    expect(r.classification).toBe('frozen-mid-work');
    expect(r.overlap).toEqual(['src/Foo.tsx']);
  });

  it('path normalization: ./src/Foo.tsx and src/Foo.tsx are the same file (overlap fires)', () => {
    const r = classifyTemporalBinding({
      freeze: freeze({ dirty: true, changedFiles: ['./src/Foo.tsx'] }),
      verifySha: VERIFY_SHA,
      runDiffFiles: ['src/Foo.tsx'],
      freezeIsAncestorOfVerify: true,
    });
    expect(r.classification).toBe('frozen-mid-work');
    expect(r.overlap).toEqual(['src/Foo.tsx']);
  });

  it('carries short display shas for the badge', () => {
    const r = classifyTemporalBinding({
      freeze: freeze(),
      verifySha: VERIFY_SHA,
      runDiffFiles: [],
      freezeIsAncestorOfVerify: true,
    });
    expect(r.freezeSha).toBe(FREEZE_SHA.slice(0, 7));
    expect(r.verifySha).toBe(VERIFY_SHA.slice(0, 7));
  });
});

describe('aggregateTemporalClassifications (verify --all header rule)', () => {
  it('mid-work wins over everything', () => {
    expect(
      aggregateTemporalClassifications(['frozen-before-work', 'frozen-mid-work', 'unknown'])
        .classification,
    ).toBe('frozen-mid-work');
  });

  it('known + unknown reports the known classification with partial: true', () => {
    const mixed = aggregateTemporalClassifications([
      { specId: 'spec-a', classification: 'frozen-before-work' },
      { specId: 'spec-b', classification: 'unknown' },
    ]);
    expect(mixed).toEqual({
      classification: 'frozen-before-work',
      partial: true,
      unknownSpecs: ['spec-b'],
    });
  });

  it('only all-unknown collapses to unknown (not partial)', () => {
    expect(aggregateTemporalClassifications(['unknown', 'unknown'])).toEqual({
      classification: 'unknown',
    });
  });

  it('all before-work → before-work; empty → unknown', () => {
    expect(aggregateTemporalClassifications(['frozen-before-work', 'frozen-before-work'])).toEqual({
      classification: 'frozen-before-work',
    });
    expect(aggregateTemporalClassifications([])).toEqual({ classification: 'unknown' });
  });

  it('mid-work + unknown is mid-work and partial', () => {
    const mixed = aggregateTemporalClassifications([
      { specId: 'spec-a', classification: 'frozen-mid-work' },
      { specId: 'spec-b', classification: 'unknown' },
    ]);
    expect(mixed.classification).toBe('frozen-mid-work');
    expect(mixed.partial).toBe(true);
    expect(mixed.unknownSpecs).toEqual(['spec-b']);
  });
});

/* ------------------------------------------------------------------ *
 * End-to-end canonical workflow. Real temp repo, real spec store —    *
 * the honest flow must never wear the adverse badge.                  *
 * ------------------------------------------------------------------ */

describe('resolveTemporalBinding — canonical workflow (real repo)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'validity-temporal-e2e-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: tmpRoot, encoding: 'utf-8' }).trim();
  }

  function gitInit(): void {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@validity.local']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
  }

  it('REGRESSION (canonical-workflow misclassification): plan-freeze → edit component → commit all → verify ⇒ frozen-before-work', () => {
    gitInit();
    mkdirSync(resolve(tmpRoot, 'src'), { recursive: true });
    writeFileSync(resolve(tmpRoot, 'src/Button.tsx'), 'export const Button = () => null;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'baseline']);

    // Plan/freeze: spec_create just wrote spec.yaml, and freezeSpec
    // self-collects the binding IMMEDIATELY after — the spec store's own
    // untracked files must not land in changedFiles.
    const { specId } = createSpec({
      projectRoot: tmpRoot,
      prompt: 'Make the button pop',
      criteria: [{ id: 'AC-1', text: 'Button pops', tier: 'soft' }],
    });
    const { spec } = freezeSpec({ projectRoot: tmpRoot, specId });
    expect(spec.git).toBeDefined();
    expect(spec.git!.changedFiles).toEqual([]);
    expect(spec.git!.dirty).toBe(false);

    // Do the work: edit the component, then commit EVERYTHING — specs are
    // committed by default, so `.validity/` lands in freeze..verify too.
    writeFileSync(resolve(tmpRoot, 'src/Button.tsx'), 'export const Button = () => "pop";\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'work + spec store']);
    const verifySha = git(['rev-parse', 'HEAD']);

    const result = resolveTemporalBinding({
      projectRoot: tmpRoot,
      freeze: spec.git,
      meta: { git: { sha: verifySha, dirty: false }, diff: { files: [] } },
    });
    expect(result.classification).toBe('frozen-before-work');
    expect(result.overlap).toEqual([]);
  });

  it('the same flow with the component ALREADY edited at freeze time still reads frozen-mid-work', () => {
    gitInit();
    mkdirSync(resolve(tmpRoot, 'src'), { recursive: true });
    writeFileSync(resolve(tmpRoot, 'src/Button.tsx'), 'export const Button = () => null;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'baseline']);

    // Work happened FIRST — the spec is frozen mid-work.
    writeFileSync(resolve(tmpRoot, 'src/Button.tsx'), 'export const Button = () => "pop";\n');
    const { specId } = createSpec({
      projectRoot: tmpRoot,
      prompt: 'Make the button pop',
      criteria: [{ id: 'AC-1', text: 'Button pops', tier: 'soft' }],
    });
    const { spec } = freezeSpec({ projectRoot: tmpRoot, specId });
    expect(spec.git!.changedFiles).toEqual(['src/Button.tsx']);

    git(['add', '-A']);
    git(['commit', '-q', '-m', 'work + spec store']);
    const verifySha = git(['rev-parse', 'HEAD']);

    const result = resolveTemporalBinding({
      projectRoot: tmpRoot,
      freeze: spec.git,
      meta: { git: { sha: verifySha, dirty: false }, diff: { files: [] } },
    });
    expect(result.classification).toBe('frozen-mid-work');
    expect(result.overlap).toEqual(['src/Button.tsx']);
  });

  it('#22: squash-merge rewrites history — the freeze sha is no longer a literal ancestor but shares a merge-base ⇒ frozen-before-work, not unknown', () => {
    gitInit();
    mkdirSync(resolve(tmpRoot, 'src'), { recursive: true });
    writeFileSync(resolve(tmpRoot, 'src/Button.tsx'), 'export const Button = () => null;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'baseline']); // B — the eventual merge-base

    // Branch, then commit so HEAD advances to a feature commit BEFORE freezing —
    // that commit is what a squash-merge will orphan from main's history.
    git(['checkout', '-q', '-b', 'feature']);
    writeFileSync(resolve(tmpRoot, 'src/notes.txt'), 'scratch\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'feature scaffolding']); // F1 (HEAD at freeze)

    const { specId } = createSpec({
      projectRoot: tmpRoot,
      prompt: 'Make the button pop',
      criteria: [{ id: 'AC-1', text: 'Button pops', tier: 'soft' }],
    });
    const { spec } = freezeSpec({ projectRoot: tmpRoot, specId });
    expect(spec.git!.changedFiles).toEqual([]); // clean tree at freeze — no overlap

    // Do the work on the feature branch, then squash-merge into main. The squash
    // commit contains the work but F1 is NOT an ancestor of it (history rewritten).
    writeFileSync(resolve(tmpRoot, 'src/Button.tsx'), 'export const Button = () => "pop";\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'work']);
    git(['checkout', '-q', 'main']);
    git(['merge', '--squash', 'feature']);
    git(['commit', '-q', '-m', 'squashed feature']);
    const verifySha = git(['rev-parse', 'HEAD']); // M — squash commit on main

    const result = resolveTemporalBinding({
      projectRoot: tmpRoot,
      freeze: spec.git,
      meta: { git: { sha: verifySha, dirty: false }, diff: { files: [] } },
    });
    expect(result.classification).toBe('frozen-before-work');
    expect(result.reason).toMatch(/squash-merge or rebase/);
    expect(result.overlap).toEqual([]);
  });

  it('#22 honesty floor: an UNRELATED history (orphan branch, no shared merge-base) still reads unknown, never before-work', () => {
    gitInit();
    mkdirSync(resolve(tmpRoot, 'src'), { recursive: true });
    writeFileSync(resolve(tmpRoot, 'src/Button.tsx'), 'export const Button = () => null;\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'baseline']);

    const { specId } = createSpec({
      projectRoot: tmpRoot,
      prompt: 'Make the button pop',
      criteria: [{ id: 'AC-1', text: 'Button pops', tier: 'soft' }],
    });
    const { spec } = freezeSpec({ projectRoot: tmpRoot, specId });

    // A parallel root with NO common ancestor — merge-base returns nothing, so
    // the lineage upgrade must not fire and the classifier stays honest.
    git(['checkout', '-q', '--orphan', 'unrelated']);
    git(['rm', '-rfq', '.']);
    writeFileSync(resolve(tmpRoot, 'OTHER.md'), 'unrelated root\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'unrelated root']);
    const verifySha = git(['rev-parse', 'HEAD']);

    const result = resolveTemporalBinding({
      projectRoot: tmpRoot,
      freeze: spec.git,
      meta: { git: { sha: verifySha, dirty: false }, diff: { files: [] } },
    });
    expect(result.classification).toBe('unknown');
    expect(result.reason).toMatch(/shares no history/);
  });
});
