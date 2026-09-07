/**
 * End-to-end round-trip for the report flow without involving Playwright or
 * Vite. We bypass `validity__verify` (which spins up a sandbox) and instead
 * write a minimally-realistic `run-meta.json` to disk by hand, plus a real
 * PNG screenshot file. Then we drive `handleSubmitReport` via its public
 * shape — we re-export it for testing — and assert the resulting HTML file
 * has all the pieces wired up.
 *
 * Why we bypass validity__verify: that path is exercised end-to-end by
 * `packages/verify-web/src/integration.test.ts` (real Vite + Playwright). The
 * complementary gap this test covers is the wiring between `readRunMeta`,
 * `renderHtmlReport`, and the file IO inside the MCP tool.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHtmlReport, type ReportInput } from '@validity.ai/verify-web';
import {
  RUBRIC_VERSION,
  computeCoverageFromVerdicts,
  readRunMeta,
  runDir,
  runMetaPathFor,
  saveScorecard,
  writeSpec,
  type CriterionVerdict,
} from '@validity.ai/verify-spec';
import { handleSubmitReport } from './server.js';
import { SESSION_FINGERPRINT } from './session-fingerprint.js';

// 8x8 PNG (red square) — small but real bytes so the renderer's data URI
// embed is exercised against a real image.
const RED_8x8_PNG = Buffer.from(
  // Hand-crafted minimal PNG, 8x8 solid red, RGB, no interlace.
  // Source: https://www.mjt.me.uk/posts/smallest-png/  (adapted to 8x8)
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAAA' +
    'AAD//////xX76loAAAANSURBVAjXY/jPwMDAAAAEAAEW6L8VAAAAAElFTkSuQmCC',
  'base64',
);

describe('report submit_report round-trip', () => {
  let projectRoot: string;
  const runId = 'run_test_roundtrip_001';

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-report-rt-'));
    const dir = runDir(projectRoot, runId);
    mkdirSync(resolve(dir, 'screenshots'), { recursive: true });

    // Drop a real PNG that the renderer will base64-embed into the HTML.
    writeFileSync(resolve(dir, 'screenshots', 'web-clock__base.png'), RED_8x8_PNG);

    // Build a runMeta exactly like prepareVerification would.
    writeFileSync(
      runMetaPathFor(projectRoot, runId),
      JSON.stringify({
        runId,
        createdAt: '2026-05-02T10:00:00.000Z',
        prompt: 'verify the clock renders the time',
        scenarios: [],
        components: [
          {
            id: 'web-clock',
            filePath: 'web/Clock.tsx',
            screenshotPath: resolve(dir, 'screenshots', 'web-clock__base.png'),
            scenarioId: undefined,
            unmatchedUrls: [],
          },
        ],
        componentSources: {
          'web-clock':
            "import { useEffect, useState } from 'react';\nexport function Clock() { return <div>now</div>; }\n",
        },
        diff: {
          files: [
            {
              path: 'web/Clock.tsx',
              hunks: [
                {
                  header: '@@ -1,1 +1,2 @@',
                  lines: [
                    { kind: 'context', text: 'import { useEffect, useState } from "react";' },
                    { kind: 'add', text: 'export function Clock() { return <div>now</div>; }' },
                  ],
                },
              ],
            },
          ],
        },
        report: { enabled: true, brand: 'validity' },
      }),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('renderHtmlReport against a real run-meta produces a valid report file', () => {
    // Read meta back the same way handleSubmitReport does.
    const metaPath = runMetaPathFor(projectRoot, runId);
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as {
      runId: string;
      createdAt: string;
      prompt: string;
      scenarios: string[];
      components: Array<{
        id: string;
        filePath: string;
        screenshotPath: string;
        scenarioId?: string;
        unmatchedUrls?: string[];
      }>;
      componentSources: Record<string, string>;
      diff: { files: Array<unknown> };
      report: { enabled: boolean; brand: 'validity' | 'none' };
    };

    expect(meta.report.enabled).toBe(true);

    // Mirror the handler's grouping logic (the unit under test is shape, not
    // the grouping which lives inline in server.ts — keep this fixture mode
    // simple).
    const screenshotDataUrl =
      'data:image/png;base64,' +
      readFileSync(meta.components[0]!.screenshotPath).toString('base64');

    const input: ReportInput = {
      runId: meta.runId,
      createdAt: meta.createdAt,
      prompt: meta.prompt,
      scenarios: meta.scenarios,
      verdict: 'pass',
      summary: 'Clock renders the current time correctly.',
      components: [
        {
          id: meta.components[0]!.id,
          filePath: meta.components[0]!.filePath,
          source: meta.componentSources['web-clock'],
          renders: [{ scenarioId: undefined, screenshotDataUrl, unmatchedUrls: [] }],
        },
      ],
      diff: meta.diff as ReportInput['diff'],
      fileNotes: { 'web/Clock.tsx': 'Added the Clock component that renders the current time.' },
      criteria: [
        {
          description: 'Clock renders on the page',
          status: 'pass',
          reasoning: 'Screenshot shows a styled time block.',
        },
      ],
      brand: meta.report.brand,
      viewCommand: `npx http-server ${runDir(projectRoot, runId)}`,
    };

    const html = renderHtmlReport(input);

    expect(html).toContain('<!doctype html');
    expect(html).toContain(meta.runId);
    expect(html).toContain('verify the clock renders the time');
    expect(html).toContain('data:image/png;base64,');
    // Logo present (validity brand) — inlined as a base64 data URI so the
    // self-contained report always shows branding offline / from file://.
    expect(html).toContain('src="data:image/svg+xml;base64,');
    // The diff hunk shows up.
    expect(html).toContain('export function Clock');
    // The agent's per-file note shows up.
    expect(html).toContain('Added the Clock component');
    // The view command appears verbatim in the footer.
    expect(html).toContain(`npx http-server ${runDir(projectRoot, runId)}`);

    // Write to disk like the handler would, just to prove the file path
    // resolves and is writable.
    const reportPath = resolve(runDir(projectRoot, runId), 'report.html');
    writeFileSync(reportPath, html);
    expect(existsSync(reportPath)).toBe(true);
  });

  it('coverage from criterionVerdicts renders the Proven-section footnote (handleSubmitReport wiring)', () => {
    // Mirrors what handleSubmitReport now does: compute coverage from the
    // (hard/property) criterion verdicts via the canonical core helper and pass
    // it to renderHtmlReport. Before the fix the coverage field was never set,
    // so this footnote never rendered.
    const criterionVerdicts: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'pass', detail: 'ok' },
      { id: 'AC-2', tier: 'property', status: 'fail', detail: 'mismatch' },
      { id: 'AC-3', tier: 'hard', status: 'unverifiable', detail: 'no selector' },
      // Soft is excluded from coverage.
      { id: 'AC-4', tier: 'soft', status: 'pass' },
    ];
    const coverage = computeCoverageFromVerdicts(criterionVerdicts) ?? undefined;
    expect(coverage).toEqual({ ratio: 2 / 3, hardPropertyTotal: 3, verifiableCount: 2 });

    const screenshotDataUrl = 'data:image/png;base64,' + RED_8x8_PNG.toString('base64');
    const input: ReportInput = {
      runId,
      createdAt: '2026-05-02T10:00:00.000Z',
      prompt: 'verify',
      scenarios: [],
      verdict: 'partial',
      components: [
        {
          id: 'web-clock',
          filePath: 'web/Clock.tsx',
          renders: [{ scenarioId: undefined, screenshotDataUrl, unmatchedUrls: [] }],
        },
      ],
      criterionVerdicts,
      coverage,
      brand: 'validity',
      viewCommand: 'x',
    };

    const html = renderHtmlReport(input);
    // 2/3 mechanically decided → 67% footnote in the Proven section.
    expect(html).toContain('2/3');
    expect(html).toContain('67%');
    expect(html).toContain('mechanically decided');
  });

  it('omits coverage when there are no hard/property verdicts (soft-only)', () => {
    const softOnly: CriterionVerdict[] = [{ id: 'AC-1', tier: 'soft', status: 'pass' }];
    expect(computeCoverageFromVerdicts(softOnly)).toBeNull();
  });

  it('runMetaPathFor returns the expected path under runDir', () => {
    const expected = resolve(runDir(projectRoot, runId), 'run-meta.json');
    expect(runMetaPathFor(projectRoot, runId)).toBe(expected);
    expect(existsSync(runMetaPathFor(projectRoot, runId))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C1/C2 — evidence assembly seam (handleSubmitReport → report.html)
// ---------------------------------------------------------------------------

describe('submit_report evidence assembly (C1/C2)', () => {
  let projectRoot: string;
  const runId = 'run_evidence_rt_001';

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-evidence-rt-'));
    mkdirSync(resolve(runDir(projectRoot, runId), 'screenshots'), { recursive: true });
    writeFileSync(
      resolve(runDir(projectRoot, runId), 'screenshots', 'web-card__base.png'),
      RED_8x8_PNG,
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeSpecAndMeta(over: Record<string, unknown> = {}): void {
    const spec = {
      id: 'spec-ev1',
      version: 1,
      status: 'frozen',
      source: { prompt: 'polish the card', createdBy: 'agent' },
      runtime: 'web',
      criteria: [{ id: 'AC-soft', text: 'looks polished', tier: 'soft' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeSpec(projectRoot, spec as never);
    writeFileSync(
      runMetaPathFor(projectRoot, runId),
      JSON.stringify({
        runId,
        createdAt: '2026-01-01T00:00:00.000Z',
        mode: 'isolation',
        prompt: 'polish the card',
        scenarios: [],
        specId: 'spec-ev1',
        components: [
          {
            id: 'web-card',
            filePath: 'src/Card.tsx',
            screenshotPath: resolve(
              runDir(projectRoot, runId),
              'screenshots',
              'web-card__base.png',
            ),
            dataProvenance: ['declared-mock'],
          },
        ],
        componentSources: {},
        diff: { files: [] },
        report: { enabled: true, brand: 'none' },
        criterionVerdicts: [
          { id: 'AC-soft', tier: 'soft', status: 'unverifiable', detail: 'score it' },
        ],
        ...over,
      }),
    );
  }

  it('assembles the evidence line from run-meta (citations + provenance + scored-by) after soft folding', async () => {
    writeSpecAndMeta();
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      scoredBy: 'model-z',
      criteria: [
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'pass',
          reasoning: 'clean',
          screenshotIds: ['web-card'],
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).toContain('scored by: model-z');
    expect(html).toContain('data: declared mock');
    expect(html).toContain('data-shot-ref="web-card"');
    // Not-validated section is present for spec runs (honest-empty here).
    expect(html).toContain('Not validated');
  });

  it('BATTERY S2: proxy-fed (synthetic) data is VISIBLE in the evidence line while staying provenance-only — the pass persists but is labeled', async () => {
    writeSpecAndMeta({
      components: [
        {
          id: 'web-card',
          filePath: 'src/Card.tsx',
          screenshotPath: resolve(runDir(projectRoot, runId), 'screenshots', 'web-card__base.png'),
          dataProvenance: ['proxy-fallback'],
        },
      ],
      criterionVerdicts: [
        {
          id: 'AC-soft',
          tier: 'soft',
          status: 'unverifiable',
          evidenceTaints: ['synthetic-data'],
        },
      ],
    });
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      criteria: [
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'pass',
          reasoning: 'the list renders',
          screenshotIds: ['web-card'],
        },
      ],
    });
    expect(result.isError).toBeUndefined();

    // synthetic-data is provenance-only (foundation §1.1): the pass persists…
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.criterionVerdicts![0]!.status).toBe('pass');
    // …but the provenance is never laundered away.
    expect(meta.criterionVerdicts![0]!.evidenceTaints).toEqual(['synthetic-data']);

    // The report's evidence line labels the render's data as unverified.
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).toContain('data: Proxy fallback (unverified data)');
  });

  it("CAN'T FORGE: agent-submitted evidence/taints-shaped payloads never reach the report", async () => {
    writeSpecAndMeta();
    const forged = {
      runId,
      projectRoot,
      verdict: 'pass',
      // Forged top-level + per-criterion evidence payloads — SubmitReportArgs
      // has no such fields; the handler must ignore them entirely.
      evidence: {
        'AC-soft': { scoredBy: 'FORGED_SCORER_X', dataProvenance: ['declared-mock'] },
      },
      criteria: [
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'pass',
          reasoning: 'clean',
          screenshotIds: ['web-card'],
          taints: ['FORGED_TAINT_Y'],
          evidence: { scoredBy: 'FORGED_SCORER_X' },
        },
      ],
    };
    const result = await handleSubmitReport(
      forged as unknown as Parameters<typeof handleSubmitReport>[0],
    );
    expect(result.isError).toBeUndefined();
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).not.toContain('FORGED_SCORER_X');
    expect(html).not.toContain('FORGED_TAINT_Y');
    // The REAL evidence (from run-meta) still renders.
    expect(html).toContain('data: declared mock');
  });

  it('OLD run-meta (pre-taint/provenance, legacy networkTainted) renders with sections self-omitting, never throws', async () => {
    // Pre-A2/A3/A4 shape: no mode-adjacent stamps, legacy networkTainted only.
    writeSpecAndMeta({
      components: [
        {
          id: 'web-card',
          filePath: 'src/Card.tsx',
          screenshotPath: resolve(runDir(projectRoot, runId), 'screenshots', 'web-card__base.png'),
        },
      ],
      criterionVerdicts: [
        { id: 'AC-net', tier: 'hard', status: 'unverifiable', networkTainted: true },
      ],
    });
    const result = await handleSubmitReport({ runId, projectRoot, verdict: 'partial' });
    expect(result.isError).toBeUndefined();
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    // Legacy boolean groups under the network header in Not-validated.
    expect(html).toContain('Network evidence was fabricated (permissive mock)');
    expect(html).toContain('AC-net');
    // No provenance stamps anywhere → no data chips, no render-confirmation chip.
    expect(html).not.toContain('data: declared mock');
    expect(html).not.toContain('render: UNCONFIRMED');
  });

  it('non-spec legacy run-meta (no verdicts at all) → no Not-validated section, report still renders', async () => {
    writeFileSync(
      runMetaPathFor(projectRoot, runId),
      JSON.stringify({
        runId,
        createdAt: '2026-01-01T00:00:00.000Z',
        prompt: 'old run',
        scenarios: [],
        components: [
          {
            id: 'web-card',
            filePath: 'src/Card.tsx',
            screenshotPath: resolve(
              runDir(projectRoot, runId),
              'screenshots',
              'web-card__base.png',
            ),
          },
        ],
        componentSources: {},
        diff: { files: [] },
        report: { enabled: true, brand: 'none' },
      }),
    );
    const result = await handleSubmitReport({ runId, projectRoot, verdict: 'pass' });
    expect(result.isError).toBeUndefined();
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).not.toContain('Not validated');
    expect(html).not.toContain('class="report-section report-notvalidated"');
  });

  it('"Not validated" lists persisted droppedDataStates + the coverage floor stamp', async () => {
    writeSpecAndMeta({
      coverageFloorPercent: 90,
      droppedDataStates: [{ componentId: 'web-card', dataState: 'empty' }],
      criterionVerdicts: [
        { id: 'AC-hard', tier: 'hard', status: 'unverifiable', detail: 'checks did not execute' },
      ],
    });
    const result = await handleSubmitReport({ runId, projectRoot, verdict: 'partial' });
    expect(result.isError).toBeUndefined();
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).toContain('Data states not rendered');
    expect(html).toContain('empty (web-card)');
    expect(html).toContain('floor 90%');
    expect(html).toContain('BREACH');
  });
});

describe('submit_report judge-mode stamping (A6)', () => {
  let projectRoot: string;
  const runId = 'run_judge_rt_001';

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-judge-rt-'));
    mkdirSync(resolve(runDir(projectRoot, runId), 'screenshots'), { recursive: true });
    writeFileSync(
      resolve(runDir(projectRoot, runId), 'screenshots', 'web-card__base.png'),
      RED_8x8_PNG,
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeSpecAndMeta(over: Record<string, unknown> = {}): void {
    const spec = {
      id: 'spec-jm1',
      version: 1,
      status: 'frozen',
      source: { prompt: 'polish the card', createdBy: 'agent' },
      runtime: 'web',
      criteria: [{ id: 'AC-soft', text: 'looks polished', tier: 'soft' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeSpec(projectRoot, spec as never);
    writeFileSync(
      runMetaPathFor(projectRoot, runId),
      JSON.stringify({
        runId,
        createdAt: '2026-01-01T00:00:00.000Z',
        mode: 'isolation',
        prompt: 'polish the card',
        scenarios: [],
        specId: 'spec-jm1',
        components: [
          {
            id: 'web-card',
            filePath: 'src/Card.tsx',
            screenshotPath: resolve(
              runDir(projectRoot, runId),
              'screenshots',
              'web-card__base.png',
            ),
          },
        ],
        componentSources: {},
        diff: { files: [] },
        report: { enabled: true, brand: 'none' },
        criterionVerdicts: [
          { id: 'AC-soft', tier: 'soft', status: 'unverifiable', detail: 'score it' },
        ],
        ...over,
      }),
    );
  }

  function writeScoringConfig(judge: 'self' | 'fresh-context' | 'human'): void {
    mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, '.validity/config.ts'),
      `export default {
  renderMode: 'web',
  framework: 'auto',
  wrapper: './.validity/wrapper.gen.tsx',
  scoring: { judge: '${judge}' },
};
`,
    );
  }

  const SOFT_SUBMISSION = [
    {
      id: 'AC-soft',
      description: 'looks polished',
      status: 'pass' as const,
      reasoning: 'clean spacing in the screenshot',
      screenshotIds: ['web-card'],
    },
  ];

  it('same-session scoring stamps meta.scoring + report-meta + judgeMode, and the report badges self-scored', async () => {
    writeSpecAndMeta({ sessionFingerprint: SESSION_FINGERPRINT });
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      criteria: SOFT_SUBMISSION,
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { judgeMode: string; selfScored: boolean };
    expect(sc.judgeMode).toBe('self');
    expect(sc.selfScored).toBe(true);
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.scoring).toEqual({
      judge: 'self',
      scoredBy: undefined,
      selfScored: true,
      // E2.2: the submission declared no rubric, so the stamp is the current
      // one marked ASSUMED rather than a claim the scorer never made.
      rubricVersion: RUBRIC_VERSION,
      rubricVersionAssumed: true,
    });
    const reportMeta = JSON.parse(
      readFileSync(resolve(runDir(projectRoot, runId), 'report-meta.json'), 'utf-8'),
    );
    expect(reportMeta.judgeMode).toBe('self');
    expect(reportMeta.selfScored).toBe(true);
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).toContain('self-scored');
  });

  it('fresh-context + distinct recorded judge from another session badges fresh-context, not self-scored', async () => {
    writeSpecAndMeta({ sessionFingerprint: 'sfp-someone-else' });
    writeScoringConfig('fresh-context');
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      scoredBy: 'judge-model-9',
      criteria: SOFT_SUBMISSION,
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { judgeMode: string; selfScored: boolean };
    expect(sc.judgeMode).toBe('fresh-context');
    expect(sc.selfScored).toBe(false);
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.scoring).toEqual({
      judge: 'fresh-context',
      scoredBy: 'judge-model-9',
      selfScored: false,
      rubricVersion: RUBRIC_VERSION,
      rubricVersionAssumed: true,
    });
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).toContain('fresh-context');
    expect(html).not.toContain('>self-scored<');
  });

  it('fresh-context WITHOUT scoredBy on a soft submission badges self-scored (deny-by-default) + warns', async () => {
    writeSpecAndMeta({ sessionFingerprint: 'sfp-someone-else' });
    writeScoringConfig('fresh-context');
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      criteria: SOFT_SUBMISSION,
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { judgeMode: string; selfScored: boolean };
    expect(sc.selfScored).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/judge identity/);
    expect(text).toMatch(/Badged as self-scored/);
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.scoring?.selfScored).toBe(true);
  });

  it('BATTERY S5: fresh-context judge with a MATCHING session fingerprint still badges self-scored + warns (identity claim cannot launder same-session scoring) — and never gates', async () => {
    writeSpecAndMeta({ sessionFingerprint: SESSION_FINGERPRINT });
    writeScoringConfig('fresh-context');
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      scoredBy: 'judge-model-9',
      criteria: SOFT_SUBMISSION,
    });
    expect(result.isError).toBeUndefined();

    // The fingerprint match wins over the claimed fresh judge identity.
    const sc = result.structuredContent as {
      judgeMode: string;
      selfScored: boolean;
      signedOff: boolean;
    };
    expect(sc.judgeMode).toBe('fresh-context');
    expect(sc.selfScored).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toMatch(/scored in the same session that ran verify/);

    // Visible in the rendered report as well.
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).toContain('self-scored');

    // NEVER gates: the clean soft pass still persists and signs off.
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.criterionVerdicts![0]!.status).toBe('pass');
    expect(sc.signedOff).toBe(true);
  });

  it("CAN'T FALSE-GREEN: judge mode never changes the persisted verdicts or signedOff", async () => {
    // Identical submissions under 'self' vs 'fresh-context' — the persisted
    // criterion statuses + signedOff must be identical; only badges move.
    const outcomes: Array<{ signedOff: boolean | undefined; statuses: unknown }> = [];
    for (const judge of ['self', 'fresh-context'] as const) {
      writeSpecAndMeta({ sessionFingerprint: 'sfp-someone-else' });
      writeScoringConfig(judge);
      const result = await handleSubmitReport({
        runId,
        projectRoot,
        verdict: 'pass',
        scoredBy: 'judge-model-9',
        criteria: SOFT_SUBMISSION,
      });
      expect(result.isError).toBeUndefined();
      const meta = readRunMeta(projectRoot, runId)!;
      outcomes.push({
        signedOff: meta.signedOff,
        statuses: meta.criterionVerdicts?.map((v) => [v.id, v.status]),
      });
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});

/* ------------------------------------------------------------------ *
 * requireFreshJudge (A6/1.5) — opt-in strict knob, default OFF.        *
 * A blocking soft PASS that is selfScored must not satisfy sign-off.   *
 * ------------------------------------------------------------------ */

describe('requireFreshJudge gate (A6/1.5)', () => {
  let projectRoot: string;
  const runId = 'run_rfj_rt_001';

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-rfj-rt-'));
    mkdirSync(resolve(runDir(projectRoot, runId), 'screenshots'), { recursive: true });
    writeFileSync(
      resolve(runDir(projectRoot, runId), 'screenshots', 'web-card__base.png'),
      RED_8x8_PNG,
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeSpecAndMeta(over: Record<string, unknown> = {}): void {
    const spec = {
      id: 'spec-rfj1',
      version: 1,
      status: 'frozen',
      source: { prompt: 'polish the card', createdBy: 'agent' },
      runtime: 'web',
      // A single BLOCKING soft criterion — signedOff hinges entirely on it.
      criteria: [{ id: 'AC-soft', text: 'looks polished', tier: 'soft' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeSpec(projectRoot, spec as never);
    writeFileSync(
      runMetaPathFor(projectRoot, runId),
      JSON.stringify({
        runId,
        createdAt: '2026-01-01T00:00:00.000Z',
        mode: 'isolation',
        prompt: 'polish the card',
        scenarios: [],
        specId: 'spec-rfj1',
        components: [
          {
            id: 'web-card',
            filePath: 'src/Card.tsx',
            screenshotPath: resolve(
              runDir(projectRoot, runId),
              'screenshots',
              'web-card__base.png',
            ),
          },
        ],
        componentSources: {},
        diff: { files: [] },
        report: { enabled: true, brand: 'none' },
        criterionVerdicts: [
          { id: 'AC-soft', tier: 'soft', status: 'unverifiable', detail: 'score it' },
        ],
        ...over,
      }),
    );
  }

  function writeConfig(opts: {
    requireFreshJudge?: boolean;
    judge?: 'self' | 'fresh-context' | 'human';
  }): void {
    mkdirSync(resolve(projectRoot, '.validity'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, '.validity/config.ts'),
      `export default {
  renderMode: 'web',
  framework: 'auto',
  wrapper: './.validity/wrapper.gen.tsx',
  ${opts.requireFreshJudge !== undefined ? `requireFreshJudge: ${opts.requireFreshJudge},` : ''}
  ${opts.judge ? `scoring: { judge: '${opts.judge}' },` : ''}
};
`,
    );
  }

  const SOFT_SUBMISSION = [
    {
      id: 'AC-soft',
      description: 'looks polished',
      status: 'pass' as const,
      reasoning: 'clean spacing in the screenshot',
      screenshotIds: ['web-card'],
    },
  ];

  it('knob OFF (no config): a same-session (self-scored) soft pass signs off — regression guard, current behavior unchanged', async () => {
    writeSpecAndMeta({ sessionFingerprint: SESSION_FINGERPRINT });
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      criteria: SOFT_SUBMISSION,
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { signedOff: boolean; selfScored: boolean };
    expect(sc.selfScored).toBe(true);
    expect(sc.signedOff).toBe(true);
    expect('requireFreshJudgeBlocked' in (result.structuredContent as object)).toBe(false);
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.signedOff).toBe(true);
    // The criterion still renders its actual verdict — pass — untouched.
    expect(meta.criterionVerdicts![0]!.status).toBe('pass');
  });

  it('knob ON + selfScored pass: NOT signed off, named reason, criterion still RENDERS as pass (never hides the verdict)', async () => {
    writeSpecAndMeta({ sessionFingerprint: SESSION_FINGERPRINT });
    writeConfig({ requireFreshJudge: true });
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      criteria: SOFT_SUBMISSION,
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as {
      signedOff: boolean;
      selfScored: boolean;
      requireFreshJudgeBlocked?: { count: number; reason: string };
    };
    expect(sc.selfScored).toBe(true);
    expect(sc.signedOff).toBe(false);
    expect(sc.requireFreshJudgeBlocked).toEqual({
      count: 1,
      reason: '1 soft pass is self-scored; requireFreshJudge is on',
    });
    const text = (result.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toContain('1 soft pass is self-scored; requireFreshJudge is on');

    // Never-false-green also means never-hidden-red: the criterion still
    // renders its actual (passing) verdict, only sign-off is refused.
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.signedOff).toBe(false);
    expect(meta.criterionVerdicts![0]!.status).toBe('pass');
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).not.toContain('signed off — every blocking criterion proven mechanically');
  });

  it('knob ON + a fresh-context judged pass (distinct session + recorded judge identity): signs off', async () => {
    writeSpecAndMeta({ sessionFingerprint: 'sfp-someone-else' });
    writeConfig({ requireFreshJudge: true, judge: 'fresh-context' });
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      scoredBy: 'judge-model-9',
      criteria: SOFT_SUBMISSION,
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { signedOff: boolean; selfScored: boolean };
    expect(sc.selfScored).toBe(false);
    expect(sc.signedOff).toBe(true);
    expect('requireFreshJudgeBlocked' in (result.structuredContent as object)).toBe(false);
  });

  it('interaction with the evidence-taint clamp: a demoting-tainted pass stays blocked even when freshly judged', async () => {
    // Evidence taint present at verify time (e.g. a degraded wrapper render) —
    // the taint clamp already refuses this as a countable pass, independent of
    // (and evaluated before) the requireFreshJudge check.
    writeSpecAndMeta({
      sessionFingerprint: 'sfp-someone-else',
      criterionVerdicts: [
        {
          id: 'AC-soft',
          tier: 'soft',
          status: 'unverifiable',
          detail: 'score it',
          evidenceTaints: ['wrapper'],
        },
      ],
    });
    writeConfig({ requireFreshJudge: true, judge: 'fresh-context' });
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      scoredBy: 'judge-model-9',
      criteria: SOFT_SUBMISSION,
    });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { signedOff: boolean; selfScored: boolean };
    expect(sc.selfScored).toBe(false);
    expect(sc.signedOff).toBe(false);
    // The taint clamp withholds the pass itself — requireFreshJudge never even
    // gets to name a reason, since the criterion isn't a countable pass at all.
    expect('requireFreshJudgeBlocked' in (result.structuredContent as object)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * F1 — the repo-level Validity Score chip on submit_report.           *
 * ------------------------------------------------------------------ */

describe('submit_report Validity Score chip (F1 — informational)', () => {
  let projectRoot: string;
  const runId = 'run_score_rt_001';

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-score-rt-'));
    mkdirSync(resolve(runDir(projectRoot, runId), 'screenshots'), { recursive: true });
    writeFileSync(
      resolve(runDir(projectRoot, runId), 'screenshots', 'web-card__base.png'),
      RED_8x8_PNG,
    );
    const spec = {
      id: 'spec-f1',
      version: 1,
      status: 'frozen',
      source: { prompt: 'polish the card', createdBy: 'agent' },
      runtime: 'web',
      criteria: [{ id: 'AC-soft', text: 'looks polished', tier: 'soft' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeSpec(projectRoot, spec as never);
    writeFileSync(
      runMetaPathFor(projectRoot, runId),
      JSON.stringify({
        runId,
        createdAt: '2026-01-01T00:00:00.000Z',
        mode: 'isolation',
        prompt: 'polish the card',
        scenarios: [],
        specId: 'spec-f1',
        components: [
          {
            id: 'web-card',
            filePath: 'src/Card.tsx',
            screenshotPath: resolve(
              runDir(projectRoot, runId),
              'screenshots',
              'web-card__base.png',
            ),
          },
        ],
        componentSources: {},
        diff: { files: [] },
        report: { enabled: true, brand: 'none' },
        criterionVerdicts: [
          { id: 'AC-soft', tier: 'soft', status: 'unverifiable', detail: 'score it' },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('no scorecard ⇒ no chip in the HTML, structuredContent.validityScore is null (honest)', async () => {
    const result = await handleSubmitReport({ runId, projectRoot, verdict: 'partial' });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { validityScore: number | null; verdict: string };
    expect(sc.validityScore).toBeNull();
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).not.toContain('validity score:');
  });

  it('a committed scorecard renders the chip beside the verdict — and never moves it', async () => {
    saveScorecard(projectRoot, {
      version: 1,
      updatedAt: '2026-06-30T00:00:00.000Z',
      specs: {
        'spec-f1': {
          specVersion: 1,
          specHash: 'h1',
          verdict: 'pass',
          coveragePercent: 100,
          criteria: {
            'AC-hard': { tier: 'hard', status: 'pass', at: '2026-06-30T00:00:00.000Z' },
            'AC-soft': { tier: 'soft', status: 'pass', at: '2026-06-30T00:00:00.000Z' },
          },
          updatedAt: '2026-06-30T00:00:00.000Z',
        },
      },
    });
    // The RUN's verdict is FAIL — a high repo score must ride beside it, not lift it.
    const result = await handleSubmitReport({ runId, projectRoot, verdict: 'fail' });
    expect(result.isError).toBeUndefined();
    const sc = result.structuredContent as { validityScore: number | null; verdict: string };
    expect(sc.validityScore).toBe(100);
    expect(sc.verdict).toBe('fail');
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).toContain('validity score: 100');
    // The legend/tooltip carries the published formula verbatim.
    expect(html).toContain('weighted pass-rate over every blocking criterion');
    expect(html).toContain('as of 2026-06-30T00:00:00.000Z');
  });
});

/* ------------------------------------------------------------------ *
 * Sign-off note — validated vs. agent-attested (display-only).        *
 * Asserts submit_report threads signOff.attested into the report:     *
 * a blocking soft pass ⇒ agent-attested; an all-hard pass ⇒ fully     *
 * mechanical (attested: false). Never gates.                          *
 * ------------------------------------------------------------------ */

describe('submit_report sign-off note (validated vs. agent-attested)', () => {
  let projectRoot: string;
  const runId = 'run_signoff_rt_001';

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-signoff-rt-'));
    mkdirSync(resolve(runDir(projectRoot, runId), 'screenshots'), { recursive: true });
    writeFileSync(
      resolve(runDir(projectRoot, runId), 'screenshots', 'web-card__base.png'),
      RED_8x8_PNG,
    );
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeSpecAndMeta(args: {
    criteria: Array<Record<string, unknown>>;
    criterionVerdicts: Array<Record<string, unknown>>;
  }): void {
    const spec = {
      id: 'spec-so1',
      version: 1,
      status: 'frozen',
      source: { prompt: 'polish the card', createdBy: 'agent' },
      runtime: 'web',
      criteria: args.criteria,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeSpec(projectRoot, spec as never);
    writeFileSync(
      runMetaPathFor(projectRoot, runId),
      JSON.stringify({
        runId,
        createdAt: '2026-01-01T00:00:00.000Z',
        mode: 'isolation',
        prompt: 'polish the card',
        scenarios: [],
        specId: 'spec-so1',
        components: [
          {
            id: 'web-card',
            filePath: 'src/Card.tsx',
            screenshotPath: resolve(
              runDir(projectRoot, runId),
              'screenshots',
              'web-card__base.png',
            ),
          },
        ],
        componentSources: {},
        diff: { files: [] },
        report: { enabled: true, brand: 'none' },
        criterionVerdicts: args.criterionVerdicts,
      }),
    );
  }

  it('a blocking soft pass makes the sign-off agent-attested (HTML + markdown)', async () => {
    writeSpecAndMeta({
      criteria: [{ id: 'AC-soft', text: 'looks polished', tier: 'soft' }],
      criterionVerdicts: [
        { id: 'AC-soft', tier: 'soft', status: 'unverifiable', detail: 'score it' },
      ],
    });
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      criteria: [
        {
          id: 'AC-soft',
          description: 'looks polished',
          status: 'pass',
          reasoning: 'clean spacing in the screenshot',
          screenshotIds: ['web-card'],
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    // The scored soft pass signs off, and it's persisted (soft folding fires).
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.signedOff).toBe(true);
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).toContain('class="report-signoff report-signoff--attested"');
    expect(html).toContain('signed off (agent-attested) — worth a human check');
    const md = readFileSync(resolve(runDir(projectRoot, runId), 'report.md'), 'utf-8');
    expect(md).toContain('✓ signed off (agent-attested) — worth a human check');
  });

  it('a run whose only blocking proof is mechanical signs off fully-mechanical (attested: false)', async () => {
    // Hard-tier spec criteria require a `checks` block; the mechanical verdict is
    // instead carried by run-meta with an id outside the spec (blocking by
    // default). The lone spec criterion is an advisory soft, so it never blocks.
    writeSpecAndMeta({
      criteria: [
        { id: 'AC-soft', text: 'nice-to-have polish', tier: 'soft', severity: 'advisory' },
      ],
      criterionVerdicts: [
        { id: 'AC-hard', tier: 'hard', status: 'pass', detail: 'proven' },
        { id: 'AC-soft', tier: 'soft', status: 'unverifiable', detail: 'advisory, not scored' },
      ],
    });
    const result = await handleSubmitReport({ runId, projectRoot, verdict: 'pass' });
    expect(result.isError).toBeUndefined();
    // The report threads the FINAL (local) stop signal — the proven note renders
    // even though no soft folding re-persisted meta.signedOff on this run.
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).toContain('class="report-signoff report-signoff--proven"');
    expect(html).toContain('signed off — every blocking criterion proven mechanically');
    expect(html).not.toContain('signed off (agent-attested)');
    const md = readFileSync(resolve(runDir(projectRoot, runId), 'report.md'), 'utf-8');
    expect(md).toContain('✓ signed off — every blocking criterion proven mechanically');
  });

  it('a failing run writes no sign-off note', async () => {
    writeSpecAndMeta({
      criteria: [{ id: 'AC-soft', text: 'looks polished', tier: 'soft' }],
      criterionVerdicts: [{ id: 'AC-hard', tier: 'hard', status: 'fail', detail: 'blank card' }],
    });
    const result = await handleSubmitReport({ runId, projectRoot, verdict: 'fail' });
    expect(result.isError).toBeUndefined();
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).not.toContain('class="report-signoff');
  });
});

// ---------------------------------------------------------------------------
// Prior-run SOFT-score diffs (display-only): submit_report reads the previous
// run's report-meta on disk and, for a soft criterion whose folded status
// changed, attaches the prior receipt so the strip can distinguish a real UI
// regression from a scorer swap.
// ---------------------------------------------------------------------------

describe('submit_report prior-run soft-score diffs (display-only)', () => {
  let projectRoot: string;
  const specId = 'spec-prior1';
  const run1 = 'run_prior_001';
  const run2 = 'run_prior_002';

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-prior-rt-'));
    for (const runId of [run1, run2]) {
      mkdirSync(resolve(runDir(projectRoot, runId), 'screenshots'), { recursive: true });
      writeFileSync(
        resolve(runDir(projectRoot, runId), 'screenshots', 'web-card__base.png'),
        RED_8x8_PNG,
      );
    }
    writeSpec(projectRoot, {
      id: specId,
      version: 1,
      status: 'frozen',
      source: { prompt: 'polish the card', createdBy: 'agent' },
      runtime: 'web',
      criteria: [
        { id: 'AC-soft', text: 'looks polished', tier: 'soft' },
        { id: 'AC-keep', text: 'stays tidy', tier: 'soft' },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
    } as never);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeRunMeta(runId: string, createdAt: string): void {
    writeFileSync(
      runMetaPathFor(projectRoot, runId),
      JSON.stringify({
        runId,
        createdAt,
        mode: 'isolation',
        prompt: 'polish the card',
        scenarios: [],
        specId,
        components: [
          {
            id: 'web-card',
            filePath: 'src/Card.tsx',
            screenshotPath: resolve(
              runDir(projectRoot, runId),
              'screenshots',
              'web-card__base.png',
            ),
          },
        ],
        componentSources: {},
        diff: { files: [] },
        report: { enabled: true, brand: 'none' },
        criterionVerdicts: [
          { id: 'AC-soft', tier: 'soft', status: 'unverifiable', detail: 'score it' },
          { id: 'AC-keep', tier: 'soft', status: 'unverifiable', detail: 'score it' },
        ],
      }),
    );
  }

  const soft = (id: string, description: string, status: 'pass' | 'fail', reasoning: string) => ({
    id,
    description,
    status,
    reasoning,
    screenshotIds: ['web-card'],
  });

  // Slice the rendered regression strip's <ul> so per-row markup can be asserted
  // without the inline <style> block's class names polluting the match.
  function regressionList(html: string): string {
    const start = html.indexOf('<ul class="report-regression-list">');
    if (start === -1) return '';
    return html.slice(start, html.indexOf('</ul>', start) + '</ul>'.length);
  }

  it('attaches prior context for a changed soft criterion (not for unchanged ones) and mirrors it in markdown', async () => {
    writeRunMeta(run1, '2026-01-01T00:00:00.000Z');
    const r1 = await handleSubmitReport({
      runId: run1,
      projectRoot,
      verdict: 'pass',
      scoredBy: 'scorer-run1',
      criteria: [
        soft('AC-soft', 'looks polished', 'pass', 'Looked clean.'),
        soft('AC-keep', 'stays tidy', 'pass', 'Tidy.'),
      ],
    });
    expect(r1.isError).toBeUndefined();

    writeRunMeta(run2, '2026-01-02T00:00:00.000Z');
    const r2 = await handleSubmitReport({
      runId: run2,
      projectRoot,
      verdict: 'fail',
      scoredBy: 'scorer-run2',
      criteria: [
        soft('AC-soft', 'looks polished', 'fail', 'Now broken.'),
        soft('AC-keep', 'stays tidy', 'pass', 'Still tidy.'),
      ],
    });
    expect(r2.isError).toBeUndefined();

    const html = readFileSync(resolve(runDir(projectRoot, run2), 'report.html'), 'utf-8');
    const list = regressionList(html);
    expect(list).toContain('report-regression-row--has-prior');
    expect(list).toContain('AC-soft');
    expect(list).toContain('pass → fail');
    // Prior receipt = the PREVIOUS run's reasoning + scorer, with the swap explicit.
    expect(list).toContain('Looked clean.');
    expect(list).toContain('scored by scorer-run1 → scorer-run2');
    // The unchanged criterion is not added to the strip.
    expect(list).not.toContain('AC-keep');

    // Markdown parity.
    const md = readFileSync(resolve(runDir(projectRoot, run2), 'report.md'), 'utf-8');
    expect(md).toContain('## Regression vs. last run');
    expect(md).toContain('- ↓ `AC\\-soft` — pass → fail');
    expect(md).toContain('- _scored by scorer\\-run1 → scorer\\-run2_');
    expect(md).toContain('- _prior:_ Looked clean.');
  });

  it('DISPLAY-ONLY: enrichment never mutates meta.regressionDeltas on disk', async () => {
    writeRunMeta(run1, '2026-01-01T00:00:00.000Z');
    await handleSubmitReport({
      runId: run1,
      projectRoot,
      verdict: 'pass',
      scoredBy: 'scorer-run1',
      criteria: [
        soft('AC-soft', 'looks polished', 'pass', 'Looked clean.'),
        soft('AC-keep', 'stays tidy', 'pass', 'Tidy.'),
      ],
    });
    writeRunMeta(run2, '2026-01-02T00:00:00.000Z');
    await handleSubmitReport({
      runId: run2,
      projectRoot,
      verdict: 'fail',
      scoredBy: 'scorer-run2',
      criteria: [
        soft('AC-soft', 'looks polished', 'fail', 'Now broken.'),
        soft('AC-keep', 'stays tidy', 'pass', 'Still tidy.'),
      ],
    });
    // The persisted run-meta must carry NO regression deltas (soft rows live only
    // in the in-memory report input) — the enrichment is display-only.
    const meta = readRunMeta(projectRoot, run2)!;
    expect(meta.regressionDeltas).toBeUndefined();
  });

  it('shows no prior diff when the previous report-meta is preliminary, malformed, or missing', async () => {
    writeRunMeta(run1, '2026-01-01T00:00:00.000Z');
    await handleSubmitReport({
      runId: run1,
      projectRoot,
      verdict: 'pass',
      scoredBy: 'scorer-run1',
      criteria: [
        soft('AC-soft', 'looks polished', 'pass', 'Looked clean.'),
        soft('AC-keep', 'stays tidy', 'pass', 'Tidy.'),
      ],
    });
    const run1MetaPath = resolve(runDir(projectRoot, run1), 'report-meta.json');
    const corruptions: Array<() => void> = [
      // Preliminary shape yields no priors.
      () =>
        writeFileSync(
          run1MetaPath,
          JSON.stringify({ runId: run1, preliminary: true, criteria: [] }),
        ),
      // Malformed JSON: read defensively, no crash, no priors.
      () => writeFileSync(run1MetaPath, '{ not valid json'),
      // Missing sidecar entirely.
      () => rmSync(run1MetaPath, { force: true }),
    ];
    for (const corrupt of corruptions) {
      corrupt();
      writeRunMeta(run2, '2026-01-02T00:00:00.000Z');
      const r2 = await handleSubmitReport({
        runId: run2,
        projectRoot,
        verdict: 'fail',
        scoredBy: 'scorer-run2',
        criteria: [
          soft('AC-soft', 'looks polished', 'fail', 'Now broken.'),
          soft('AC-keep', 'stays tidy', 'pass', 'Still tidy.'),
        ],
      });
      expect(r2.isError).toBeUndefined();
      const html = readFileSync(resolve(runDir(projectRoot, run2), 'report.html'), 'utf-8');
      expect(html).not.toContain('Regression vs. last run');
    }
  });
});
