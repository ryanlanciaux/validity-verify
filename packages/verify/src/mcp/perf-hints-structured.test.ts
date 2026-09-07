/**
 * D2's can't-false-green tests: the advisory `structuredContent.perf.hints`
 * key must be structurally incapable of touching the gate. Perfect perf can
 * never improve a failing verdict; pathological perf can never degrade a
 * passing one or perturb the `signedOff` stop rule — the `verdict` block must
 * be byte-identical with and without renders passed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentRender, CriterionVerdict, PerformanceMetrics } from '@validity.ai/verify-spec';
import { buildVerifyStructuredContent } from './server.js';

/** Every hint rule fires on these metrics (worst case the module can emit). */
const PATHOLOGICAL_PERF: PerformanceMetrics = {
  loadMs: 9000,
  firstContentfulPaintMs: 4000,
  readyMs: 5000,
  mountMs: 60,
  updateMs: 300,
  commitCount: 40,
  updateTotalMs: 2000,
};

/** No rule fires, no tint would exceed 'ok'. */
const PRISTINE_PERF: PerformanceMetrics = {
  loadMs: 300,
  firstContentfulPaintMs: 200,
  readyMs: 250,
  mountMs: 4,
  updateMs: 2,
  commitCount: 3,
};

function render(
  performance: PerformanceMetrics | undefined,
  overrides: Partial<ComponentRender> = {},
): Pick<ComponentRender, 'id' | 'scenarioId' | 'fixtureId' | 'performance'> {
  return { id: 'CheckoutForm', performance, ...overrides };
}

describe('buildVerifyStructuredContent — perf.hints (D2, advisory-only)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-perf-hints-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("CAN'T FALSE-GREEN A: pristine perf cannot improve a failing verdict", () => {
    const failing: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'button missing' },
    ];
    const out = buildVerifyStructuredContent('run-1', failing, undefined, projectRoot, undefined, [
      render(PRISTINE_PERF),
    ]);
    expect(out.verdict.status).toBe('fail');
    expect(out.verdict.signedOff).toBe(false);
    expect(out.perf).toBeUndefined();
  });

  it("CAN'T FALSE-GREEN B: pathological perf cannot degrade the gate or perturb the stop rule", () => {
    const allPass: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      { id: 'AC-2', tier: 'property', status: 'pass' },
    ];
    const withRedPerf = buildVerifyStructuredContent(
      'run-2',
      allPass,
      undefined,
      projectRoot,
      undefined,
      [render(PATHOLOGICAL_PERF)],
    );
    const withoutRenders = buildVerifyStructuredContent(
      'run-2',
      allPass,
      undefined,
      projectRoot,
      undefined,
    );
    expect(withRedPerf.verdict.status).toBe('pass');
    expect(withRedPerf.verdict.signedOff).toBe(true);
    // The verdict block a loop driver stops on is byte-identical: hints are a
    // sibling namespace, never an input to the stop rule.
    expect(withRedPerf.verdict).toEqual(withoutRenders.verdict);
    expect(withRedPerf.perf!.hints.length).toBeGreaterThan(0);
    expect(withoutRenders.perf).toBeUndefined();
  });

  it('omits the perf key entirely (not an empty object) when no hints fire', () => {
    const out = buildVerifyStructuredContent(
      'run-3',
      [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
      undefined,
      projectRoot,
      undefined,
      [render(PRISTINE_PERF), render(undefined, { scenarioId: 'empty' })],
    );
    expect('perf' in out).toBe(false);
  });

  it('labels each hint with the render slug (scenario/fixture aware) and keeps hint shape', () => {
    const out = buildVerifyStructuredContent(
      'run-4',
      [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
      undefined,
      projectRoot,
      undefined,
      [
        render({ commitCount: 14, updateMs: 31.2 }),
        render({ mountMs: 80 }, { scenarioId: 'loading', fixtureId: 'primary' }),
      ],
    );
    const hints = out.perf!.hints;
    expect(hints.map((h) => ({ render: h.render, rule: h.rule, severity: h.severity }))).toEqual([
      { render: 'CheckoutForm__base', rule: 'excessive-rerenders', severity: 'warn' },
      { render: 'CheckoutForm__loading__primary', rule: 'slow-mount', severity: 'warn' },
    ]);
    expect(hints[0]!.evidence).toEqual({ commitCount: 14, updateMs: 31.2 });
    expect(hints[0]!.message).toContain('excessive re-renders');
  });
});
