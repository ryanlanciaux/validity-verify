/**
 * Plan-first enforcement (B1). Two properties are load-bearing and each gets a
 * can't-false-green test:
 *
 *   1. Strict mode can only REFUSE, never mint: a redirect carries NO
 *      verdict/signedOff/runId keys, so a loop driver keying on
 *      `structuredContent.verdict.signedOff` reads undefined — not done.
 *   2. The UNPLANNED badge derives from VERIFY-time state (`isRunPlanned` over
 *      run-meta), so a submit-time `planId` cannot launder it off.
 *
 * Handlers are driven directly (no MCP transport) against throwaway project
 * dirs, mirroring report-roundtrip.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSpec,
  freezeSpec,
  runDir,
  runMetaPathFor,
  type CriterionVerdict,
  type Spec,
} from '@validity.ai/verify-spec';
import {
  buildVerifyStructuredContent,
  handleSubmitReport,
  handleVerify,
  resolveEnforcement,
  strictVerifyRedirect,
} from './server.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-strict-'));
});
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeConfig(enforcement?: 'advisory' | 'strict'): void {
  mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
  writeFileSync(
    resolve(projectRoot, '.validity', 'config.ts'),
    `export default {\n` +
      `  renderMode: 'web' as const,\n` +
      `  framework: 'auto' as const,\n` +
      `  wrapper: './.validity/wrapper.gen.tsx',\n` +
      (enforcement ? `  enforcement: '${enforcement}' as const,\n` : '') +
      `};\n`,
  );
}

/** Create a spec in the store; optionally freeze it. Returns the spec id. */
function seedSpec(opts: { frozen: boolean }): string {
  const { specId } = createSpec({
    projectRoot,
    prompt: 'add a save button',
    criteria: [{ id: 'AC-1', text: 'a save button is visible', tier: 'soft' }],
  });
  if (opts.frozen) freezeSpec({ projectRoot, specId, approval: 'auto' });
  return specId;
}

/** Minimal run-meta a bare-prompt (unplanned) verify would persist. */
function writeUnplannedRunMeta(runId: string): void {
  const dir = runDir(projectRoot, runId);
  mkdirSync(resolve(dir, 'screenshots'), { recursive: true });
  writeFileSync(
    runMetaPathFor(projectRoot, runId),
    JSON.stringify(
      {
        runId,
        createdAt: '2026-07-01T10:00:00.000Z',
        prompt: 'make it pop',
        scenarios: [],
        planned: false,
        components: [
          {
            id: 'web-card',
            filePath: 'web/Card.tsx',
            screenshotPath: resolve(dir, 'screenshots', 'web-card__base.png'),
            unmatchedUrls: [],
          },
        ],
        diff: { files: [] },
        report: { enabled: true, brand: 'validity' },
      },
      null,
      2,
    ),
  );
}

describe('resolveEnforcement', () => {
  it("is 'advisory' when no config exists (strict cannot pre-date init)", async () => {
    await expect(resolveEnforcement(projectRoot)).resolves.toBe('advisory');
  });

  it('reads the configured mode', async () => {
    writeConfig('strict');
    await expect(resolveEnforcement(projectRoot)).resolves.toBe('strict');
  });

  it("defaults to 'advisory' when the config omits the field", async () => {
    writeConfig();
    await expect(resolveEnforcement(projectRoot)).resolves.toBe('advisory');
  });
});

describe('strictVerifyRedirect', () => {
  it('redirects to validity__plan when no planId was passed', () => {
    const res = strictVerifyRedirect(projectRoot, undefined);
    expect(res).not.toBeNull();
    expect(res!.isError).toBeFalsy();
    expect(res!.structuredContent).toEqual({
      redirect: { reason: 'strict-enforcement', cause: 'no-plan', nextTool: 'validity__plan' },
    });
  });

  it('redirects a legacy plan_… id (no frozen contract behind it)', () => {
    const res = strictVerifyRedirect(projectRoot, 'plan_legacy_123');
    expect((res!.structuredContent as { redirect: { cause: string } }).redirect.cause).toBe(
      'legacy-plan',
    );
  });

  it('redirects a draft spec to spec_freeze (the contract exists, it is not locked)', () => {
    const specId = seedSpec({ frozen: false });
    const res = strictVerifyRedirect(projectRoot, specId);
    expect(res!.structuredContent).toEqual({
      redirect: {
        reason: 'strict-enforcement',
        cause: 'unfrozen-spec',
        nextTool: 'validity__spec_freeze',
        specId,
      },
    });
  });

  it('lets a frozen spec through (returns null)', () => {
    const specId = seedSpec({ frozen: true });
    expect(strictVerifyRedirect(projectRoot, specId)).toBeNull();
  });

  it('throws on an unknown spec id — a typo is a bug signal, not a redirect', () => {
    expect(() => strictVerifyRedirect(projectRoot, 'spec-doesnotexist')).toThrow(
      /not found in \.validity\/specs\//,
    );
  });
});

describe("handleVerify under enforcement: 'strict' (can't-false-green)", () => {
  it('a redirect carries NO verdict/signedOff/runId and records no run', async () => {
    writeConfig('strict');
    const res = await handleVerify({ prompt: 'make the button blue', projectRoot });

    // A redirect the agent follows — not an error, and NEVER a verdict.
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.redirect).toEqual({
      reason: 'strict-enforcement',
      cause: 'no-plan',
      nextTool: 'validity__plan',
    });
    expect(sc.verdict).toBeUndefined();
    expect('signedOff' in sc).toBe(false);
    expect('runId' in sc).toBe(false);

    // The gate runs before any render/persist: no run directory exists and the
    // text says so — a loop driver has nothing green to latch onto.
    expect(existsSync(resolve(projectRoot, '.validity', 'runs'))).toBe(false);
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toContain('validity__plan');
    expect(text).toContain('Nothing was rendered and no run was recorded');
    expect(text).not.toMatch(/signedOff|Run:/);
  });

  it('browse-shaped tools are ungated: the gate only fires inside verify/submit_report', async () => {
    // Structural assertion: strict mode with a FROZEN spec id proceeds past the
    // gate (strictVerifyRedirect returns null) — proving the gate keys on the
    // plan-first contract, not on strict mode per se. Browse tools never route
    // through handleVerify/handleSubmitReport, so they cannot hit the gate.
    writeConfig('strict');
    const specId = seedSpec({ frozen: true });
    expect(strictVerifyRedirect(projectRoot, specId)).toBeNull();
  });
});

describe('advisory mode — verdict.planned in the verify loop signal', () => {
  it('an unplanned run reads planned:false AND signedOff:false — second-class and not done', () => {
    const out = buildVerifyStructuredContent('run-1', undefined, undefined, projectRoot, undefined);
    expect(out.verdict.planned).toBe(false);
    expect(out.verdict.signedOff).toBe(false);
    expect(out.verdict.status).toBe('unverifiable');
  });

  it('a planned run stamps planned:true without touching status/signedOff', () => {
    const planned = buildVerifyStructuredContent(
      'run-1',
      undefined,
      undefined,
      projectRoot,
      undefined,
      undefined,
      true,
    );
    const unplanned = buildVerifyStructuredContent(
      'run-1',
      undefined,
      undefined,
      projectRoot,
      undefined,
      undefined,
      false,
    );
    expect(planned.verdict.planned).toBe(true);
    // `planned` is display-only: everything verdict-bearing is identical.
    expect({ ...planned.verdict, planned: undefined }).toEqual({
      ...unplanned.verdict,
      planned: undefined,
    });
  });
});

describe('vacuous sign-off is surfaced (Finding 3 — surface, never gate)', () => {
  const advisorySpec: Spec = {
    id: 'spec-vac',
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    criteria: [{ id: 'AC-1', text: 'nice to have', tier: 'soft', severity: 'advisory' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Spec;
  const blockingSpec: Spec = {
    ...advisorySpec,
    criteria: [{ id: 'AC-1', text: 'must pass', tier: 'soft' }],
  } as unknown as Spec;
  const passVerdicts: CriterionVerdict[] = [{ id: 'AC-1', tier: 'soft', status: 'pass' }];

  it('flags vacuousSignoff when the green rests on ZERO blocking criteria', () => {
    const out = buildVerifyStructuredContent(
      'run-vac',
      passVerdicts,
      advisorySpec,
      projectRoot,
      undefined,
    );
    expect(out.verdict.signedOff).toBe(true);
    expect(out.verdict.vacuousSignoff).toBe(true);
  });

  it('omits vacuousSignoff when at least one blocking criterion exists', () => {
    const out = buildVerifyStructuredContent(
      'run-real',
      passVerdicts,
      blockingSpec,
      projectRoot,
      undefined,
    );
    expect(out.verdict.signedOff).toBe(true);
    expect('vacuousSignoff' in out.verdict).toBe(false);
  });

  it('omits vacuousSignoff when not signed off (a failing advisory-only spec is not vacuous-green)', () => {
    const out = buildVerifyStructuredContent('run-none', [], advisorySpec, projectRoot, undefined);
    // No verdicts ⇒ signedOff false ⇒ not vacuous.
    expect(out.verdict.signedOff).toBe(false);
    expect('vacuousSignoff' in out.verdict).toBe(false);
  });
});

describe("handleSubmitReport under enforcement: 'strict'", () => {
  it('redirects an unplanned run BEFORE any mutation (no report, run-meta byte-identical)', async () => {
    writeConfig('strict');
    const runId = 'run_strict_submit_001';
    writeUnplannedRunMeta(runId);
    const metaPath = runMetaPathFor(projectRoot, runId);
    const bytesBefore = readFileSync(metaPath);

    const res = await handleSubmitReport({ runId, projectRoot, verdict: 'pass' });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.redirect).toEqual({
      reason: 'strict-enforcement',
      cause: 'unplanned-run',
      nextTool: 'validity__plan',
    });
    expect(sc.verdict).toBeUndefined();
    expect('signedOff' in sc).toBe(false);

    expect(existsSync(resolve(runDir(projectRoot, runId), 'report.html'))).toBe(false);
    expect(readFileSync(metaPath).equals(bytesBefore)).toBe(true);
  });
});

describe('advisory mode — UNPLANNED badge cannot be laundered', () => {
  it('a submit-time planId does NOT remove the badge (it derives from verify-time state)', async () => {
    writeConfig('advisory');
    const runId = 'run_advisory_launder_001';
    writeUnplannedRunMeta(runId);
    // A real frozen spec the submitter tries to attach after the fact.
    const specId = seedSpec({ frozen: true });

    const res = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      planId: specId,
    });

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as Record<string, unknown>;
    // The loop signal says unplanned too — mirrors verify's `verdict.planned`.
    expect(sc.planned).toBe(false);

    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).toContain('unplanned');
    expect(html).toContain('Verified without an upfront plan/spec');
    const md = readFileSync(resolve(runDir(projectRoot, runId), 'report.md'), 'utf-8');
    expect(md).toContain('**UNPLANNED**');
  });

  it('a spec-verified run is planned: no badge, structuredContent.planned true', async () => {
    writeConfig('advisory');
    const runId = 'run_advisory_planned_001';
    const specId = seedSpec({ frozen: true });
    writeUnplannedRunMeta(runId);
    // Stamp what a spec verify would have persisted.
    const metaPath = runMetaPathFor(projectRoot, runId);
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    meta.planned = true;
    meta.specId = specId;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const res = await handleSubmitReport({ runId, projectRoot, verdict: 'pass' });
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.planned).toBe(true);
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).not.toContain('Verified without an upfront plan/spec');
  });
});
