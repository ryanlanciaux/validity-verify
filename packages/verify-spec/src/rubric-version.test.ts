/**
 * Rubric versioning (E2.2). A soft score is an opinion; the least it can do is
 * record which rubric produced it. These tests pin the three properties that
 * make the stamp trustworthy rather than decorative:
 *
 *   1. freeze stamps the CURRENT rubric onto the spec;
 *   2. the stamp is EXCLUDED from the content hash — a rubric bump must not
 *      silently unbind every frozen spec's reports and approvals (that is the
 *      scoring-contract version's job, and it is a much louder event);
 *   3. drift produces a WARNING with both versions named, and silence when the
 *      spec is already on the current rubric.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RUBRIC_VERSION,
  computeSpecHash,
  createSpec,
  freezeSpec,
  readSpec,
  rubricDriftWarning,
  specRubricVersion,
  type Spec,
  type SpecCriterion,
} from './index.js';

const SOFT_CRITERION: SpecCriterion = { id: 'AC-1', text: 'looks polished', tier: 'soft' };

function frozenSpec(rubricVersion?: string): Spec {
  const root = mkdtempSync(resolve(tmpdir(), 'validity-rubric-'));
  const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [SOFT_CRITERION] });
  return freezeSpec({ projectRoot: root, specId, gitBinding: null, rubricVersion }).spec;
}

describe('freeze stamps the rubric baseline', () => {
  it('stamps the current RUBRIC_VERSION', () => {
    expect(frozenSpec().rubric).toEqual({ version: RUBRIC_VERSION });
  });

  it('persists the stamp to disk', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'validity-rubric-'));
    const { specId } = createSpec({ projectRoot: root, prompt: 'p', criteria: [SOFT_CRITERION] });
    freezeSpec({ projectRoot: root, specId, gitBinding: null });
    expect(readSpec(root, specId)!.rubric).toEqual({ version: RUBRIC_VERSION });
  });

  it('honors an explicit override (re-freeze reproducing an older baseline)', () => {
    expect(frozenSpec('0').rubric).toEqual({ version: '0' });
  });
});

describe('the rubric stamp is EXCLUDED from computeSpecHash', () => {
  it('two specs differing only in rubric version hash identically', () => {
    const base = frozenSpec();
    const underV0: Spec = { ...base, rubric: { version: '0' } };
    const unstamped: Spec = { ...base, rubric: undefined };
    expect(computeSpecHash(underV0)).toBe(computeSpecHash(base));
    expect(computeSpecHash(unstamped)).toBe(computeSpecHash(base));
  });

  it("freeze's own hash matches what the pre-stamp content would have hashed to", () => {
    const spec = frozenSpec();
    expect(spec.hash).toBe(computeSpecHash({ ...spec, rubric: undefined }));
  });
});

describe('specRubricVersion / rubricDriftWarning', () => {
  it('an unstamped spec reports undefined — unknown, not a version to compare', () => {
    expect(specRubricVersion({})).toBeUndefined();
    expect(specRubricVersion({ rubric: { version: '0' } })).toBe('0');
  });

  it('no warning when the spec is on the current rubric', () => {
    expect(rubricDriftWarning({ rubric: { version: RUBRIC_VERSION } })).toBeUndefined();
  });

  // The load-bearing one. Every spec in the field predates the stamp, so
  // treating "no stamp" as drift would warn on every verify of every existing
  // spec forever, about something the author cannot act on — and a warning that
  // always fires is one people stop reading, which costs the REAL drift warning
  // its meaning. Absence is unknown; only a present-and-different stamp is drift.
  it('says NOTHING about a spec frozen before the stamp existed', () => {
    expect(rubricDriftWarning({})).toBeUndefined();
  });

  it('warns and names BOTH versions plus the remedy when a stamp is behind', () => {
    const warning = rubricDriftWarning({ rubric: { version: '0' } })!;
    expect(warning).toContain('rubric v0');
    expect(warning).toContain(`current rubric v${RUBRIC_VERSION}`);
    expect(warning).toContain('re-freeze to re-baseline');
  });

  it('warns on a FUTURE rubric too (a spec frozen by a newer build)', () => {
    expect(rubricDriftWarning({ rubric: { version: '99' } })).toContain('rubric v99');
  });
});
