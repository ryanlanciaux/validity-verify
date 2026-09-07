/**
 * Item 4 (soft-scoring quality floor) + Item 2 (regression deltas) gate guards.
 *
 * `validateSoftCitations` is the central false-green guard for soft criteria: a
 * soft verdict submitted without (or with a bogus) screenshot citation MUST be
 * rejected, never silently accepted as a pass. `loadPreviousVerdicts` must
 * return the MOST RECENT prior run's verdicts — the OS attempt used an
 * off-by-one (limit 2 / history[length-2]); these tests lock the correct
 * behavior so a revert goes red.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  indexRunForSpec,
  runMetaPathFor,
  type CriterionVerdict,
  type RunMeta,
  type Spec,
} from '@validity.ai/verify-spec';
import { rmSync } from 'node:fs';
import {
  crossComponentPassWarnings,
  loadPreviousVerdicts,
  validateSoftCitations,
} from './server.js';

/** Minimal spec carrying one soft + one hard criterion (only fields the floor reads). */
function specWith(
  criteria: Array<{ id: string; text: string; tier: 'soft' | 'hard' | 'property' }>,
): Spec {
  return { id: 'login', version: 1, criteria } as unknown as Spec;
}

const SOFT_SPEC = specWith([
  { id: 'AC-1', text: 'looks polished', tier: 'soft' },
  { id: 'AC-2', text: 'submit button exists', tier: 'hard' },
]);

describe('validateSoftCitations', () => {
  it('REJECTS a soft submission with no screenshotIds (false-green guard)', () => {
    const errors = validateSoftCitations({
      submitted: [{ id: 'AC-1', description: 'looks polished' }],
      spec: SOFT_SPEC,
      validScreenshotIds: new Set(['login']),
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('AC-1');
    expect(errors[0]).toContain('screenshotIds');
  });

  it('REJECTS a soft submission citing an unknown render id', () => {
    const errors = validateSoftCitations({
      submitted: [{ id: 'AC-1', description: 'looks polished', screenshotIds: ['nope'] }],
      spec: SOFT_SPEC,
      validScreenshotIds: new Set(['login']),
    });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('nope');
    expect(errors[0]).toMatch(/unknown render id/i);
  });

  it('ACCEPTS a soft submission citing a valid render id', () => {
    const errors = validateSoftCitations({
      submitted: [{ id: 'AC-1', description: 'looks polished', screenshotIds: ['login'] }],
      spec: SOFT_SPEC,
      validScreenshotIds: new Set(['login']),
    });
    expect(errors).toEqual([]);
  });

  it('does NOT require citations for hard/property criteria (mechanically proven)', () => {
    const errors = validateSoftCitations({
      submitted: [{ id: 'AC-2', description: 'submit button exists' }],
      spec: SOFT_SPEC,
      validScreenshotIds: new Set(['login']),
    });
    expect(errors).toEqual([]);
  });

  // ASYMMETRY GUARD: the floor matched id-only when an id was present, but the
  // verdict writeback resolves id-OR-text. So a submission with a WRONG id but
  // the EXACT soft-criterion description used to skip the floor (specCrit
  // undefined → not checked) yet still land its pass via the text-keyed
  // writeback. The floor now falls back to text just like the writeback.
  it('REJECTS a soft submission with a WRONG id but the right description (id/text asymmetry)', () => {
    const errors = validateSoftCitations({
      submitted: [{ id: 'AC-bogus', description: 'looks polished' }], // no screenshotIds
      spec: SOFT_SPEC,
      validScreenshotIds: new Set(['login']),
    });
    expect(errors.length).toBe(1);
    // Reported under the REAL criterion id it text-resolved to, not the bogus one.
    expect(errors[0]).toContain('AC-1');
    expect(errors[0]).toContain('screenshotIds');
  });

  it('a WRONG id that resolves to a HARD criterion by text is still not required to cite', () => {
    const errors = validateSoftCitations({
      submitted: [{ id: 'AC-bogus', description: 'submit button exists' }],
      spec: SOFT_SPEC,
      validScreenshotIds: new Set(['login']),
    });
    expect(errors).toEqual([]);
  });

  it('is lenient for non-spec (legacy/plan) submissions (spec === null)', () => {
    const errors = validateSoftCitations({
      submitted: [{ id: 'AC-1', description: 'looks polished' }],
      spec: null,
      validScreenshotIds: new Set(),
    });
    expect(errors).toEqual([]);
  });

  // RELEVANCE (A3 §5.3): a blank-PNG render is a valid citation for a fail (the
  // emptiness IS the evidence) but can never PROVE a pass.
  it('REJECTS a soft PASS sourced only from an empty (blank) render', () => {
    const errors = validateSoftCitations({
      submitted: [
        { id: 'AC-1', description: 'looks polished', status: 'pass', screenshotIds: ['login'] },
      ],
      spec: SOFT_SPEC,
      validScreenshotIds: new Set(['login']),
      emptyScreenshotIds: new Set(['login']),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('AC-1');
    expect(errors[0]).toMatch(/empty \(blank\) render/i);
  });

  it('ACCEPTS a soft FAIL citing an empty render (the blank shot is the evidence)', () => {
    const errors = validateSoftCitations({
      submitted: [
        { id: 'AC-1', description: 'looks polished', status: 'fail', screenshotIds: ['login'] },
      ],
      spec: SOFT_SPEC,
      validScreenshotIds: new Set(['login']),
      emptyScreenshotIds: new Set(['login']),
    });
    expect(errors).toEqual([]);
  });

  it('ACCEPTS a soft PASS that cites one empty AND one NON-empty render', () => {
    const errors = validateSoftCitations({
      submitted: [
        {
          id: 'AC-1',
          description: 'looks polished',
          status: 'pass',
          screenshotIds: ['blank', 'login'],
        },
      ],
      spec: SOFT_SPEC,
      validScreenshotIds: new Set(['login', 'blank']),
      emptyScreenshotIds: new Set(['blank']),
    });
    expect(errors).toEqual([]);
  });

  it('is inert when emptyScreenshotIds is omitted (byte-identical legacy behavior)', () => {
    const errors = validateSoftCitations({
      submitted: [
        { id: 'AC-1', description: 'looks polished', status: 'pass', screenshotIds: ['login'] },
      ],
      spec: SOFT_SPEC,
      validScreenshotIds: new Set(['login']),
    });
    expect(errors).toEqual([]);
  });
});

/**
 * Cross-component relevance (A3 §5.3) — ADVISORY (never gates). A soft pass
 * sourced only from a render outside the spec's declared target components is
 * surfaced as a warning so a reviewer notices a pass backed by the wrong
 * component. Fires only when the spec declares component targets.
 */
describe('crossComponentPassWarnings', () => {
  const specTargeting = (components: string[]): Spec =>
    ({
      id: 'login',
      version: 1,
      criteria: [{ id: 'AC-1', text: 'looks polished', tier: 'soft' }],
      targets: { components },
    }) as unknown as Spec;

  it('warns when a pass cites only an OFF-target component render', () => {
    const warnings = crossComponentPassWarnings({
      submitted: [
        { id: 'AC-1', description: 'looks polished', status: 'pass', screenshotIds: ['Other'] },
      ],
      spec: specTargeting(['src/LoginForm.tsx']),
      renderComponentPathById: new Map([['Other', 'src/Sidebar.tsx']]),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('AC-1');
    expect(warnings[0]).toContain('outside this spec');
  });

  it('is silent when a pass cites the on-target component (basename match)', () => {
    const warnings = crossComponentPassWarnings({
      submitted: [
        { id: 'AC-1', description: 'looks polished', status: 'pass', screenshotIds: ['LoginForm'] },
      ],
      spec: specTargeting(['src/LoginForm.tsx']),
      renderComponentPathById: new Map([['LoginForm', 'src/LoginForm.tsx']]),
    });
    expect(warnings).toEqual([]);
  });

  it('is silent when the spec declares NO component targets', () => {
    const warnings = crossComponentPassWarnings({
      submitted: [
        { id: 'AC-1', description: 'looks polished', status: 'pass', screenshotIds: ['Other'] },
      ],
      spec: specTargeting([]),
      renderComponentPathById: new Map([['Other', 'src/Sidebar.tsx']]),
    });
    expect(warnings).toEqual([]);
  });

  it('never warns on a fail (advisory relevance is a pass-only concern)', () => {
    const warnings = crossComponentPassWarnings({
      submitted: [
        { id: 'AC-1', description: 'looks polished', status: 'fail', screenshotIds: ['Other'] },
      ],
      spec: specTargeting(['src/LoginForm.tsx']),
      renderComponentPathById: new Map([['Other', 'src/Sidebar.tsx']]),
    });
    expect(warnings).toEqual([]);
  });

  it('ignores page/unknown citations (no component path to compare)', () => {
    const warnings = crossComponentPassWarnings({
      submitted: [
        { id: 'AC-1', description: 'looks polished', status: 'pass', screenshotIds: ['Home'] },
      ],
      spec: specTargeting(['src/LoginForm.tsx']),
      renderComponentPathById: new Map(), // 'Home' is a page — not in the map
    });
    expect(warnings).toEqual([]);
  });
});

describe('loadPreviousVerdicts', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function seedRun(projectRoot: string, runId: string, verdicts: CriterionVerdict[]): void {
    const meta: RunMeta = {
      runId,
      specId: 'login',
      specVersion: 1,
      specHash: 'sha256-x',
      createdAt: `2026-06-22T00:00:0${runId.slice(-1)}Z`,
      criterionVerdicts: verdicts,
    } as unknown as RunMeta;
    const p = runMetaPathFor(projectRoot, runId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(meta));
    indexRunForSpec(projectRoot, meta);
  }

  it('returns the MOST RECENT prior run, not an older one (off-by-one guard)', () => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-prevverdicts-'));
    seedRun(root, 'run_1', [{ id: 'AC-2', tier: 'hard', status: 'pass' }]);
    seedRun(root, 'run_2', [{ id: 'AC-2', tier: 'hard', status: 'fail' }]);
    const prev = loadPreviousVerdicts(root, 'login');
    expect(prev).toBeDefined();
    expect(prev).toHaveLength(1);
    // run_2 (most recent) had `fail` — a limit-2/length-2 off-by-one would
    // return run_1's `pass` instead.
    expect(prev![0]!.status).toBe('fail');
  });

  it('returns undefined on first run (no history)', () => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-prevverdicts-'));
    expect(loadPreviousVerdicts(root, 'login')).toBeUndefined();
  });

  it('returns undefined when the previous run had no verdicts (honest no-op)', () => {
    root = mkdtempSync(resolve(tmpdir(), 'validity-prevverdicts-'));
    seedRun(root, 'run_1', []);
    expect(loadPreviousVerdicts(root, 'login')).toBeUndefined();
  });
});
