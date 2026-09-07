/**
 * Foundation schema round-trips for the new spec-schema surface (Track 0):
 * `expect.command` (A5), the command no-mixing refine, the `dataState` axis
 * (A2), and the command narrowing helpers. Also pins that a pre-foundation spec
 * still parses byte-identically (all additions are optional).
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  CHECK_TIMEOUT_MS,
  checkSchema,
  criterionUsesCommandChecks,
  elementStateSchema,
  expectBodySchema,
  isCommandExpectCheck,
  isHoverCheck,
  isPressCheck,
  isScrollCheck,
  isSelectCheck,
  isWaitCheck,
  isWaitForRequestCheck,
  parseSpec,
  pressCheckSchema,
  pressKeyAndTimes,
  scrollCheckSchema,
  selectCheckSchema,
  specConditionsSchema,
  specCriterionSchema,
  specProbationSchema,
  SpecValidationError,
  waitCheckSchema,
  waitForRequestCheckSchema,
  type Check,
  type Spec,
} from './spec-schema.js';

describe('expect.command (A5)', () => {
  it('parses a named command check with an exit code', () => {
    expect(expectBodySchema.safeParse({ command: { run: 'typecheck', exitCode: 0 } }).success).toBe(
      true,
    );
  });

  it('parses a named command check without an exit code', () => {
    expect(expectBodySchema.safeParse({ command: { run: 'typecheck' } }).success).toBe(true);
  });

  it('rejects a shell string in `run` (no shell smuggling into a spec)', () => {
    expect(expectBodySchema.safeParse({ command: { run: 'tsc --noEmit' } }).success).toBe(false);
  });

  it('rejects an out-of-range exit code', () => {
    expect(
      expectBodySchema.safeParse({ command: { run: 'typecheck', exitCode: 256 } }).success,
    ).toBe(false);
  });

  it('rejects two assertion families in one expect', () => {
    const r = expectBodySchema.safeParse({
      command: { run: 'typecheck' },
      console: { errors: 0 },
    });
    expect(r.success).toBe(false);
  });
});

describe('command no-mixing refine (A5)', () => {
  it('accepts an all-command criterion with two command checks', () => {
    const r = specCriterionSchema.safeParse({
      id: 'AC-1',
      text: 'repo is healthy',
      tier: 'property',
      checks: [
        { expect: { command: { run: 'typecheck', exitCode: 0 } } },
        { expect: { command: { run: 'test', exitCode: 0 } } },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a criterion that mixes a command check with a page check', () => {
    const r = specCriterionSchema.safeParse({
      id: 'AC-1',
      text: 'submits and typechecks',
      tier: 'hard',
      checks: [
        { click: { role: 'button', name: 'Send' } },
        { expect: { command: { run: 'typecheck', exitCode: 0 } } },
      ],
    });
    expect(r.success).toBe(false);
  });
});

describe('command narrowing helpers (A5)', () => {
  const cmd: Check = { expect: { command: { run: 'typecheck' } } };
  const click: Check = { click: { role: 'button', name: 'Send' } };

  it('isCommandExpectCheck distinguishes command checks', () => {
    expect(isCommandExpectCheck(cmd)).toBe(true);
    expect(isCommandExpectCheck(click)).toBe(false);
  });

  it('criterionUsesCommandChecks detects any command check', () => {
    expect(criterionUsesCommandChecks({ checks: [cmd] })).toBe(true);
    expect(criterionUsesCommandChecks({ checks: [click] })).toBe(false);
    expect(criterionUsesCommandChecks({ checks: undefined })).toBe(false);
  });
});

describe('dataState axis (A2)', () => {
  it('a criterion may carry a dataState', () => {
    const r = specCriterionSchema.safeParse({
      id: 'AC-1',
      text: 'shows a spinner while loading',
      tier: 'soft',
      dataState: 'loading',
    });
    expect(r.success).toBe(true);
  });

  it('conditions may fan across dataStates', () => {
    const r = specConditionsSchema.safeParse({ dataStates: ['empty', 'error'] });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown dataState', () => {
    expect(
      specCriterionSchema.safeParse({
        id: 'AC-1',
        text: 'x',
        tier: 'soft',
        dataState: 'stale',
      }).success,
    ).toBe(false);
  });
});

describe('probation marker (Phase C bulk onboarding)', () => {
  it('specProbationSchema parses a full marker (since + batchId)', () => {
    const r = specProbationSchema.safeParse({
      since: '2026-07-04T00:00:00.000Z',
      batchId: 'batch-1',
    });
    expect(r.success).toBe(true);
  });

  it('specProbationSchema parses a marker with no batchId (batchId optional)', () => {
    const r = specProbationSchema.safeParse({ since: '2026-07-04T00:00:00.000Z' });
    expect(r.success).toBe(true);
  });

  it('specProbationSchema rejects a marker with no since', () => {
    expect(specProbationSchema.safeParse({ batchId: 'batch-1' }).success).toBe(false);
  });

  it('a spec carrying probation parses', () => {
    const spec = parseSpec({
      id: 'spec-prob',
      version: 1,
      status: 'draft',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      criteria: [{ id: 'AC-1', text: 't', tier: 'soft' }],
      probation: { since: '2026-07-04T00:00:00.000Z', batchId: 'batch-7' },
      createdAt: new Date(0).toISOString(),
    });
    expect(spec.probation).toEqual({ since: '2026-07-04T00:00:00.000Z', batchId: 'batch-7' });
  });

  it('probation round-trips through YAML serialize→parse', () => {
    // Build a valid spec, attach probation, serialize to YAML, re-parse: the
    // marker survives the on-disk form unchanged.
    const spec = parseSpec({
      id: 'spec-rt',
      version: 1,
      status: 'draft',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      criteria: [{ id: 'AC-1', text: 't', tier: 'soft' }],
      createdAt: new Date(0).toISOString(),
    });
    const withProbation = {
      ...spec,
      probation: { since: '2026-07-04T00:00:00.000Z', batchId: 'batch-rt' },
    };
    const yaml = stringifyYaml(withProbation);
    const reparsed = parseSpec(parseYaml(yaml));
    expect(reparsed.probation).toEqual({ since: '2026-07-04T00:00:00.000Z', batchId: 'batch-rt' });
  });

  it('a spec with no probation still parses (field is optional — back-compat)', () => {
    const spec = parseSpec({
      id: 'spec-none',
      version: 1,
      status: 'draft',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      criteria: [{ id: 'AC-1', text: 't', tier: 'soft' }],
      createdAt: new Date(0).toISOString(),
    });
    expect(spec.probation).toBeUndefined();
  });
});

describe('back-compat', () => {
  const PRE_FOUNDATION_SPEC: Spec = {
    id: 'spec-abc123',
    version: 1,
    status: 'frozen',
    source: { prompt: 'Build a contact form', createdBy: 'agent' },
    runtime: 'web',
    criteria: [
      {
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
      },
      { id: 'AC-2', text: 'Form looks polished and on-brand', tier: 'soft' },
    ],
    hash: 'deadbeef',
    createdAt: new Date(0).toISOString(),
  };

  it('a pre-foundation spec parses byte-identically (all additions optional)', () => {
    expect(parseSpec(PRE_FOUNDATION_SPEC)).toEqual(PRE_FOUNDATION_SPEC);
  });

  it('parseSpec throws a SpecValidationError on invalid input', () => {
    expect(() => parseSpec({ id: 'nope' })).toThrow(SpecValidationError);
  });
});

describe('press / hover / focused (keyboard-focus-hover checks)', () => {
  it('parses a bare-string press', () => {
    expect(checkSchema.safeParse({ press: 'Tab' }).success).toBe(true);
  });

  it('parses an object press with key + times', () => {
    expect(checkSchema.safeParse({ press: { key: 'Shift+Tab', times: 3 } }).success).toBe(true);
  });

  it('parses an object press without times (defaults later to 1)', () => {
    expect(pressCheckSchema.safeParse({ press: { key: 'Enter' } }).success).toBe(true);
  });

  it('rejects times below 1 and above 25', () => {
    expect(pressCheckSchema.safeParse({ press: { key: 'Tab', times: 0 } }).success).toBe(false);
    expect(pressCheckSchema.safeParse({ press: { key: 'Tab', times: 26 } }).success).toBe(false);
    expect(pressCheckSchema.safeParse({ press: { key: 'Tab', times: 25 } }).success).toBe(true);
  });

  it('rejects an empty press key', () => {
    expect(pressCheckSchema.safeParse({ press: '' }).success).toBe(false);
    expect(pressCheckSchema.safeParse({ press: { key: '' } }).success).toBe(false);
  });

  it('parses a hover with a role/name selector', () => {
    expect(checkSchema.safeParse({ hover: { role: 'button', name: 'Save' } }).success).toBe(true);
  });

  it('rejects a hover with an empty selector (needs one a11y field)', () => {
    expect(checkSchema.safeParse({ hover: {} }).success).toBe(false);
  });

  it("adds 'focused' to the element-state enum", () => {
    expect(elementStateSchema.safeParse('focused').success).toBe(true);
    expect(
      expectBodySchema.safeParse({ element: { role: 'button', name: 'Save', state: 'focused' } })
        .success,
    ).toBe(true);
  });

  it('narrowing helpers key on the single present key', () => {
    const press: Check = { press: 'Tab' };
    const hover: Check = { hover: { role: 'button', name: 'Save' } };
    expect(isPressCheck(press)).toBe(true);
    expect(isHoverCheck(press)).toBe(false);
    expect(isHoverCheck(hover)).toBe(true);
    expect(isPressCheck(hover)).toBe(false);
  });

  it('pressKeyAndTimes normalizes both forms (default times 1)', () => {
    expect(pressKeyAndTimes('Tab')).toEqual({ key: 'Tab', times: 1 });
    expect(pressKeyAndTimes({ key: 'Enter' })).toEqual({ key: 'Enter', times: 1 });
    expect(pressKeyAndTimes({ key: 'Shift+Tab', times: 4 })).toEqual({
      key: 'Shift+Tab',
      times: 4,
    });
  });

  it('a hard criterion can carry press/hover/focused checks', () => {
    const r = specCriterionSchema.safeParse({
      id: 'AC-kbd',
      text: 'Tab moves focus to Save',
      tier: 'hard',
      checks: [
        { press: 'Tab' },
        { hover: { role: 'button', name: 'Save' } },
        { expect: { element: { role: 'button', name: 'Save', state: 'focused' } } },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('parses an element-scoped press (optional selector)', () => {
    const r = pressCheckSchema.safeParse({
      press: { key: 'Enter', selector: { label: 'Email' } },
    });
    expect(r.success).toBe(true);
    expect(pressKeyAndTimes(r.data!.press)).toEqual({
      key: 'Enter',
      times: 1,
      selector: { label: 'Email' },
    });
  });

  it('page-level press is unchanged when selector is absent', () => {
    expect(pressKeyAndTimes('Tab')).toEqual({ key: 'Tab', times: 1 });
    expect(pressKeyAndTimes({ key: 'Enter', times: 2 })).toEqual({ key: 'Enter', times: 2 });
  });
});

describe('wait / waitForRequest / select / scroll', () => {
  it('parses wait { ms } within CHECK_TIMEOUT_MS', () => {
    expect(waitCheckSchema.safeParse({ wait: { ms: 200 } }).success).toBe(true);
    expect(waitCheckSchema.safeParse({ wait: { ms: CHECK_TIMEOUT_MS } }).success).toBe(true);
  });

  it('rejects wait.ms above CHECK_TIMEOUT_MS (schema-level ceiling)', () => {
    expect(waitCheckSchema.safeParse({ wait: { ms: CHECK_TIMEOUT_MS + 1 } }).success).toBe(false);
  });

  it('parses wait { for, state }', () => {
    expect(
      waitCheckSchema.safeParse({
        wait: { for: { text: 'Message sent' }, state: 'visible' },
      }).success,
    ).toBe(true);
    expect(
      waitCheckSchema.safeParse({ wait: { for: { role: 'status' }, state: 'hidden' } }).success,
    ).toBe(true);
    expect(
      waitCheckSchema.safeParse({ wait: { for: { testId: 'toast' }, state: 'attached' } }).success,
    ).toBe(true);
  });

  it('rejects wait with both ms and for, or neither', () => {
    expect(waitCheckSchema.safeParse({ wait: { ms: 100, for: { text: 'x' } } }).success).toBe(
      false,
    );
    expect(waitCheckSchema.safeParse({ wait: {} }).success).toBe(false);
  });

  it('rejects wait.state without wait.for', () => {
    expect(waitCheckSchema.safeParse({ wait: { ms: 100, state: 'visible' } }).success).toBe(false);
  });

  it('parses waitForRequest with url / method / timeoutMs', () => {
    expect(
      waitForRequestCheckSchema.safeParse({ waitForRequest: { url: '/api/contact' } }).success,
    ).toBe(true);
    expect(
      waitForRequestCheckSchema.safeParse({
        waitForRequest: { url: '/api/save', method: 'POST', timeoutMs: 1000 },
      }).success,
    ).toBe(true);
    expect(
      waitForRequestCheckSchema.safeParse({
        waitForRequest: { url: '/^https:\\/\\/api\\.example/' },
      }).success,
    ).toBe(true);
  });

  it('rejects waitForRequest.timeoutMs above CHECK_TIMEOUT_MS', () => {
    expect(
      waitForRequestCheckSchema.safeParse({
        waitForRequest: { url: '/api/x', timeoutMs: CHECK_TIMEOUT_MS + 1 },
      }).success,
    ).toBe(false);
  });

  it('parses select with a string option or { label, value, index }', () => {
    expect(
      selectCheckSchema.safeParse({
        select: { selector: { label: 'Country' }, option: 'United States' },
      }).success,
    ).toBe(true);
    expect(
      selectCheckSchema.safeParse({
        select: { selector: { role: 'combobox', name: 'Size' }, option: { value: 'lg' } },
      }).success,
    ).toBe(true);
    expect(
      selectCheckSchema.safeParse({
        select: { selector: { testId: 'size' }, option: { index: 0 } },
      }).success,
    ).toBe(true);
  });

  it('rejects select with an empty option object', () => {
    expect(
      selectCheckSchema.safeParse({
        select: { selector: { label: 'Country' }, option: {} },
      }).success,
    ).toBe(false);
  });

  it('parses scroll to/by/intoView', () => {
    expect(scrollCheckSchema.safeParse({ scroll: { to: 'bottom' } }).success).toBe(true);
    expect(scrollCheckSchema.safeParse({ scroll: { to: 'top' } }).success).toBe(true);
    expect(scrollCheckSchema.safeParse({ scroll: { by: { y: 400 } } }).success).toBe(true);
    expect(
      scrollCheckSchema.safeParse({
        scroll: { selector: { text: 'Footer' }, intoView: true },
      }).success,
    ).toBe(true);
  });

  it('rejects scroll with no to/by/intoView, and intoView without selector', () => {
    expect(scrollCheckSchema.safeParse({ scroll: {} }).success).toBe(false);
    expect(scrollCheckSchema.safeParse({ scroll: { intoView: true } }).success).toBe(false);
  });

  it('narrowing helpers key on the single present key', () => {
    const wait: Check = { wait: { ms: 100 } };
    const wfr: Check = { waitForRequest: { url: '/api/x' } };
    const sel: Check = { select: { selector: { label: 'C' }, option: 'US' } };
    const scr: Check = { scroll: { to: 'bottom' } };
    expect(isWaitCheck(wait)).toBe(true);
    expect(isWaitForRequestCheck(wfr)).toBe(true);
    expect(isSelectCheck(sel)).toBe(true);
    expect(isScrollCheck(scr)).toBe(true);
    expect(isWaitCheck(sel)).toBe(false);
    expect(isSelectCheck(wait)).toBe(false);
  });

  it('a hard criterion can carry the new verbs', () => {
    const r = specCriterionSchema.safeParse({
      id: 'AC-verbs',
      text: 'wait, select, scroll, then press Enter in the field',
      tier: 'hard',
      checks: [
        { wait: { ms: 50 } },
        { wait: { for: { text: 'Ready' }, state: 'visible' } },
        { waitForRequest: { url: '/api/boot' } },
        { select: { selector: { label: 'Country' }, option: 'US' } },
        { scroll: { to: 'bottom' } },
        { press: { key: 'Enter', selector: { label: 'Email' } } },
      ],
    });
    expect(r.success).toBe(true);
  });
});
