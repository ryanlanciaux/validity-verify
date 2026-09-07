/**
 * Preliminary (verify-time) report + in-flight marker wiring (Features 1 & 2).
 *
 * A report artifact must ALWAYS exist after a verify — written mechanically,
 * BEFORE the agent scores the soft criteria — and be OVERWRITTEN by
 * submit_report once scored. And every verify must leave an in-flight marker
 * that is removed on EVERY exit path (here: a thrown dispatch + the submit
 * backstop). We bypass the Vite/Playwright sandbox by writing a realistic
 * run-meta by hand (same approach as report-roundtrip.test.ts) and driving the
 * exported `writePreliminaryReport` / `handleSubmitReport` / `handleVerify`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  inflightDir,
  readInflightMarkers,
  readRunMeta,
  runDir,
  runMetaPathFor,
  writeInflightMarker,
  writeSpec,
} from '@validity.ai/verify-spec';
import { handleSubmitReport, handleVerify, writePreliminaryReport } from './server.js';

// 8x8 red PNG — real bytes so the renderer's data-URI embed is exercised.
const RED_8x8_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAAA' +
    'AAD//////xX76loAAAANSURBVAjXY/jPwMDAAAAEAAEW6L8VAAAAAElFTkSuQmCC',
  'base64',
);

let projectRoot: string;
const runId = 'run_prelim_001';

beforeEach(() => {
  projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-prelim-'));
  mkdirSync(resolve(runDir(projectRoot, runId), 'screenshots'), { recursive: true });
  writeFileSync(
    resolve(runDir(projectRoot, runId), 'screenshots', 'web-card__base.png'),
    RED_8x8_PNG,
  );
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Frozen spec (one hard + one soft criterion) + a run-meta ready to report. */
function writeSpecAndMeta(over: Record<string, unknown> = {}): void {
  writeSpec(projectRoot, {
    id: 'spec-p1',
    version: 1,
    status: 'frozen',
    source: { prompt: 'polish the card', createdBy: 'agent' },
    runtime: 'web',
    // Declared criteria are soft-only (hard-tier specs must carry a `checks`
    // block, which is orthogonal to this test). The MECHANICAL verdict is
    // derived from the run-meta's criterionVerdicts below, not the spec.
    criteria: [{ id: 'AC-soft', text: 'the card looks polished and on-brand', tier: 'soft' }],
    createdAt: '2026-01-01T00:00:00.000Z',
  } as never);
  writeFileSync(
    runMetaPathFor(projectRoot, runId),
    JSON.stringify({
      runId,
      createdAt: '2026-07-18T10:00:00.000Z',
      mode: 'isolation',
      prompt: 'polish the card',
      scenarios: [],
      specId: 'spec-p1',
      specVersion: 1,
      components: [
        {
          id: 'web-card',
          filePath: 'src/Card.tsx',
          screenshotPath: resolve(runDir(projectRoot, runId), 'screenshots', 'web-card__base.png'),
        },
      ],
      componentSources: {},
      diff: { files: [] },
      report: { enabled: true, brand: 'validity' },
      // Verify-time verdicts: hard proven pass; soft still an unverifiable placeholder.
      criterionVerdicts: [
        { id: 'AC-1', tier: 'hard', status: 'pass', detail: 'has an accessible name' },
        { id: 'AC-soft', tier: 'soft', status: 'unverifiable', detail: 'score it' },
      ],
      ...over,
    }),
  );
}

describe('writePreliminaryReport (Feature 1: a report always exists)', () => {
  it('writes report.html + report-meta.json{preliminary:true} with a mechanical PARTIAL verdict (never pass)', async () => {
    writeSpecAndMeta();
    const meta = readRunMeta(projectRoot, runId)!;
    const out = await writePreliminaryReport(projectRoot, meta);

    expect(out).not.toBeNull();
    expect(out!.reportFileUrl).toContain('report.html');

    const reportPath = resolve(runDir(projectRoot, runId), 'report.html');
    expect(existsSync(reportPath)).toBe(true);

    const reportMeta = JSON.parse(
      readFileSync(resolve(runDir(projectRoot, runId), 'report-meta.json'), 'utf-8'),
    );
    expect(reportMeta.preliminary).toBe(true);
    // All hard/property pass ⇒ partial (soft unscored), NEVER pass.
    expect(reportMeta.verdict).toBe('partial');
    expect(reportMeta.verdict).not.toBe('pass');

    // Soft criterion renders as a "scoring pending" placeholder, and the HTML
    // never claims a proven-pass rollup.
    const html = readFileSync(reportPath, 'utf-8');
    expect(html).toContain('the card looks polished and on-brand');
    expect(html.toLowerCase()).toContain('scoring pending');
  });

  it('derives a FAIL verdict when a hard/property check failed', async () => {
    writeSpecAndMeta({
      criterionVerdicts: [
        { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'no accessible name' },
        { id: 'AC-soft', tier: 'soft', status: 'unverifiable' },
      ],
    });
    const out = await writePreliminaryReport(projectRoot, readRunMeta(projectRoot, runId)!);
    expect(out).not.toBeNull();
    const reportMeta = JSON.parse(
      readFileSync(resolve(runDir(projectRoot, runId), 'report-meta.json'), 'utf-8'),
    );
    expect(reportMeta.verdict).toBe('fail');
  });

  it('threads a fully-mechanical sign-off note when a verify-time all-hard run signed off', async () => {
    // An all-hard spec whose blocking checks all proved at verify time signs off
    // BEFORE any soft scoring — attested is false (nothing rests on a judged soft
    // pass), so the preliminary report shows the fully-mechanical phrasing.
    writeSpecAndMeta({
      signedOff: true,
      criterionVerdicts: [
        { id: 'AC-1', tier: 'hard', status: 'pass', detail: 'has an accessible name' },
      ],
    });
    const out = await writePreliminaryReport(projectRoot, readRunMeta(projectRoot, runId)!);
    expect(out).not.toBeNull();
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).toContain('class="report-signoff report-signoff--proven"');
    expect(html).toContain('signed off — every blocking criterion proven mechanically');
    // (the CSS comment references "(agent-attested)", so anchor on the note text)
    expect(html).not.toContain('signed off (agent-attested)');
  });

  it('writes no sign-off note when the verify-time run has NOT signed off', async () => {
    // Default meta: a blocking soft is still unverifiable ⇒ signedOff is false.
    writeSpecAndMeta();
    await writePreliminaryReport(projectRoot, readRunMeta(projectRoot, runId)!);
    const html = readFileSync(resolve(runDir(projectRoot, runId), 'report.html'), 'utf-8');
    expect(html).not.toContain('class="report-signoff');
  });

  it('honors report:false — no report written, returns null', async () => {
    writeSpecAndMeta({ report: { enabled: false, brand: 'validity' } });
    const out = await writePreliminaryReport(projectRoot, readRunMeta(projectRoot, runId)!);
    expect(out).toBeNull();
    expect(existsSync(resolve(runDir(projectRoot, runId), 'report.html'))).toBe(false);
    expect(existsSync(resolve(runDir(projectRoot, runId), 'report-meta.json'))).toBe(false);
  });

  it('is OVERWRITTEN by submit_report (later-wins): report-meta loses preliminary, gains the scored verdict', async () => {
    writeSpecAndMeta();
    await writePreliminaryReport(projectRoot, readRunMeta(projectRoot, runId)!);
    let reportMeta = JSON.parse(
      readFileSync(resolve(runDir(projectRoot, runId), 'report-meta.json'), 'utf-8'),
    );
    expect(reportMeta.preliminary).toBe(true);

    const res = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      summary: 'looks great',
      criteria: [
        {
          id: 'AC-soft',
          description: 'the card looks polished and on-brand',
          status: 'pass',
          reasoning: 'clean, aligned, on-brand',
          screenshotIds: ['web-card'],
        },
      ],
    });
    expect(res.isError).toBeUndefined();

    reportMeta = JSON.parse(
      readFileSync(resolve(runDir(projectRoot, runId), 'report-meta.json'), 'utf-8'),
    );
    // The submit-time sidecar has no `preliminary` flag; it carries submittedAt.
    expect(reportMeta.preliminary).toBeUndefined();
    expect(reportMeta.submittedAt).toBeTruthy();
  });
});

describe('in-flight marker lifecycle (Feature 2)', () => {
  it('handleVerify writes a marker at start and clears it even when the dispatch THROWS', async () => {
    // No inflight dir yet.
    expect(existsSync(inflightDir(projectRoot))).toBe(false);
    // An unknown spec id makes the isolation dispatch throw (resolvePlan) AFTER
    // the marker is written — so this exercises the finally on the throw path.
    await expect(
      handleVerify({ prompt: 'make it pop', projectRoot, planId: 'spec-doesnotexist' }),
    ).rejects.toThrow();
    // The write happened (dir was created)…
    expect(existsSync(inflightDir(projectRoot))).toBe(true);
    // …and the finally cleared the marker (no live rows survive the throw).
    expect(readInflightMarkers(projectRoot)).toEqual([]);
  });

  it('submit_report clears any leftover marker for its runId (crash backstop)', async () => {
    writeSpecAndMeta();
    // Simulate a verify that crashed after writing its marker but before submit.
    writeInflightMarker(projectRoot, {
      runId,
      specId: 'spec-p1',
      mode: 'isolation',
      startedAt: new Date().toISOString(),
    });
    expect(readInflightMarkers(projectRoot).map((m) => m.runId)).toEqual([runId]);

    await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'partial',
      criteria: [
        {
          id: 'AC-soft',
          description: 'the card looks polished and on-brand',
          status: 'unverifiable',
          reasoning: 'n/a',
          screenshotIds: ['web-card'],
        },
      ],
    });
    expect(readInflightMarkers(projectRoot)).toEqual([]);
  });
});
