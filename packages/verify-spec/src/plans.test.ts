import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PlanValidationError,
  planPathFor,
  plansDir,
  readPlan,
  validateCriteria,
  validateCriterion,
  writePlan,
} from './plans.js';

describe('validateCriterion', () => {
  it('returns a normalized criterion for valid input', () => {
    expect(validateCriterion({ id: 'primary-blue', description: 'Primary is blue' }, 0)).toEqual({
      id: 'primary-blue',
      description: 'Primary is blue',
      observable: undefined,
    });
  });

  it('trims id + description', () => {
    expect(validateCriterion({ id: '  a  ', description: '  desc  ' }, 0)).toEqual({
      id: 'a',
      description: 'desc',
      observable: undefined,
    });
  });

  it('accepts a valid observable', () => {
    expect(
      validateCriterion({ id: 'a', description: 'desc', observable: 'a11y' }, 0).observable,
    ).toBe('a11y');
  });

  it('rejects non-object input', () => {
    expect(() => validateCriterion('string', 0)).toThrow(PlanValidationError);
    expect(() => validateCriterion(null, 0)).toThrow(PlanValidationError);
  });

  it('rejects empty id or description', () => {
    expect(() => validateCriterion({ id: '', description: 'x' }, 0)).toThrow(/id/);
    expect(() => validateCriterion({ id: 'a', description: '' }, 0)).toThrow(/description/);
  });

  it('rejects an unknown observable', () => {
    expect(() =>
      validateCriterion({ id: 'a', description: 'x', observable: 'thermal' }, 0),
    ).toThrow(/observable must be one of/);
  });

  it('indexes errors so the agent can locate the bad criterion', () => {
    expect(() => validateCriterion({ id: '', description: '' }, 3)).toThrow(/criteria\[3\]/);
  });
});

describe('validateCriteria', () => {
  it('rejects non-array input', () => {
    expect(() => validateCriteria({ id: 'a', description: 'x' })).toThrow(/must be an array/);
  });

  it('rejects an empty array', () => {
    expect(() => validateCriteria([])).toThrow(/cannot be empty/);
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      validateCriteria([
        { id: 'same', description: 'one' },
        { id: 'same', description: 'two' },
      ]),
    ).toThrow(/duplicated/);
  });

  it('returns the normalized list when everything is valid', () => {
    const out = validateCriteria([
      { id: 'a', description: 'one' },
      { id: 'b', description: 'two', observable: 'visual' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe('a');
    expect(out[1]?.observable).toBe('visual');
  });
});

describe('writePlan + readPlan', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-plans-'));
  });

  afterEach(() => {
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writes a plan to .validity/plans/<id>.json and reads it back verbatim', () => {
    const { planPath, plan } = writePlan({
      projectRoot,
      planId: 'plan_test_1',
      prompt: 'Make the button blue',
      criteria: [
        { id: 'blue', description: 'Primary button background is blue', observable: 'visual' },
      ],
      componentPath: 'src/Button.tsx',
    });
    expect(planPath).toBe(planPathFor(projectRoot, 'plan_test_1'));
    expect(existsSync(planPath)).toBe(true);

    const loaded = readPlan(projectRoot, 'plan_test_1');
    expect(loaded).not.toBeNull();
    expect(loaded?.planId).toBe('plan_test_1');
    expect(loaded?.prompt).toBe('Make the button blue');
    expect(loaded?.criteria).toEqual(plan.criteria);
    expect(loaded?.componentPath).toBe('src/Button.tsx');
    expect(loaded?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('creates the plans directory on demand', () => {
    expect(existsSync(plansDir(projectRoot))).toBe(false);
    writePlan({
      projectRoot,
      planId: 'plan_test_2',
      prompt: 'p',
      criteria: [{ id: 'a', description: 'b' }],
    });
    expect(existsSync(plansDir(projectRoot))).toBe(true);
  });

  it('returns null for an unknown plan id', () => {
    expect(readPlan(projectRoot, 'plan_does_not_exist')).toBeNull();
  });

  it('returns null when the plan file exists but is malformed JSON', () => {
    mkdirSync(plansDir(projectRoot), { recursive: true });
    writeFileSync(planPathFor(projectRoot, 'plan_bad'), '{not json');
    expect(readPlan(projectRoot, 'plan_bad')).toBeNull();
  });
});
