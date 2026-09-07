/**
 * URL-mode counterpart to report-roundtrip.test.ts. Validates the wiring
 * between writeUrlRunMeta, readRunMeta, and the report renderer for runs
 * produced via handleVerifyUrl. We don't drive Playwright here — we hand-
 * write a run-meta the same shape handleVerifyUrl would and assert that
 * the renderer produces a valid HTML report from it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHtmlReport, type ReportInput } from '@validity.ai/verify-web';
import {
  readRunMeta,
  runDir,
  runMetaPathFor,
  urlModeCriterionVerdicts,
  URL_MODE_DISCLOSURE,
  writeUrlRunMeta,
  type PageRender,
  type Spec,
} from '@validity.ai/verify-spec';

const RED_8x8_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAAA' +
    'AAD//////xX76loAAAANSURBVAjXY/jPwMDAAAAEAAEW6L8VAAAAAElFTkSuQmCC',
  'base64',
);

describe('url-mode report submit_report round-trip', () => {
  let projectRoot: string;
  const runId = 'run_test_url_rt_001';

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-url-rt-'));
    const dir = runDir(projectRoot, runId);
    mkdirSync(resolve(dir, 'screenshots'), { recursive: true });
    writeFileSync(resolve(dir, 'screenshots', 'dashboard__logged-in.png'), RED_8x8_PNG);
    writeFileSync(resolve(dir, 'screenshots', 'dashboard__logged-out.png'), RED_8x8_PNG);
    writeFileSync(resolve(dir, 'screenshots', 'users__logged-in.png'), RED_8x8_PNG);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writeUrlRunMeta + readRunMeta round-trip preserves mode and pages', () => {
    const dir = runDir(projectRoot, runId);
    const pages: PageRender[] = [
      {
        id: 'dashboard__logged-in',
        pathId: 'dashboard',
        url: 'http://localhost:3000/dashboard',
        scenarioId: 'logged-in',
        screenshotPath: resolve(dir, 'screenshots', 'dashboard__logged-in.png'),
        unmatchedUrls: [],
      },
      {
        id: 'dashboard__logged-out',
        pathId: 'dashboard',
        url: 'http://localhost:3000/dashboard',
        scenarioId: 'logged-out',
        screenshotPath: resolve(dir, 'screenshots', 'dashboard__logged-out.png'),
        unmatchedUrls: [],
      },
    ];

    const path = writeUrlRunMeta({
      projectRoot,
      runId,
      prompt: 'verify the dashboard',
      scenarios: ['logged-in', 'logged-out'],
      pages,
      reportConfig: { enabled: true, brand: 'validity' },
    });

    expect(path).toBe(runMetaPathFor(projectRoot, runId));
    const meta = readRunMeta(projectRoot, runId);
    expect(meta).not.toBeNull();
    expect(meta!.mode).toBe('url');
    expect(meta!.scenarios).toEqual(['logged-in', 'logged-out']);
    expect(meta!.pages).toHaveLength(2);
    expect(meta!.pages![0]!.pathId).toBe('dashboard');
    expect(meta!.pages![0]!.scenarioId).toBe('logged-in');
    // Components / sources are absent for URL mode.
    expect(meta!.components).toBeUndefined();
    expect(meta!.componentSources).toBeUndefined();
    // Diff is collected (empty in a tmp dir, which isn't a git repo).
    expect(meta!.diff).toEqual({ files: [] });
    // Report config flows through.
    expect(meta!.report).toEqual({ enabled: true, brand: 'validity' });
  });

  it('writeUrlRunMeta with report disabled produces an empty diff and disabled report flag', () => {
    const dir = runDir(projectRoot, runId);
    writeUrlRunMeta({
      projectRoot,
      runId,
      prompt: 'no report',
      scenarios: [],
      pages: [
        {
          id: 'dashboard',
          pathId: 'dashboard',
          url: 'http://localhost:3000/dashboard',
          screenshotPath: resolve(dir, 'screenshots', 'dashboard__logged-in.png'),
          unmatchedUrls: [],
        },
      ],
      reportConfig: { enabled: false, brand: 'validity' },
    });

    const meta = readRunMeta(projectRoot, runId);
    expect(meta!.report.enabled).toBe(false);
    expect(meta!.diff).toEqual({ files: [] });
  });

  it('renderHtmlReport against a url-mode run-meta produces an HTML report', () => {
    const dir = runDir(projectRoot, runId);
    const pages: PageRender[] = [
      {
        id: 'dashboard__logged-in',
        pathId: 'dashboard',
        url: 'http://localhost:3000/dashboard',
        scenarioId: 'logged-in',
        screenshotPath: resolve(dir, 'screenshots', 'dashboard__logged-in.png'),
        unmatchedUrls: [],
      },
      {
        id: 'dashboard__logged-out',
        pathId: 'dashboard',
        url: 'http://localhost:3000/dashboard',
        scenarioId: 'logged-out',
        screenshotPath: resolve(dir, 'screenshots', 'dashboard__logged-out.png'),
        unmatchedUrls: [],
      },
      {
        id: 'users__logged-in',
        pathId: 'users',
        url: 'http://localhost:3000/users',
        scenarioId: 'logged-in',
        screenshotPath: resolve(dir, 'screenshots', 'users__logged-in.png'),
        unmatchedUrls: ['GET http://localhost:3000/api/something-unmatched'],
      },
    ];
    writeUrlRunMeta({
      projectRoot,
      runId,
      prompt: 'verify dashboard and users under both auth states',
      scenarios: ['logged-in', 'logged-out'],
      pages,
      reportConfig: { enabled: true, brand: 'validity' },
    });

    // Mirror handleSubmitReport's url-mode mapping so we test the renderer
    // against the same shape the production code produces.
    const meta = readRunMeta(projectRoot, runId)!;
    const byComponent = new Map<string, ReportInput['components'][number]>();
    for (const p of meta.pages!) {
      let entry = byComponent.get(p.pathId);
      if (!entry) {
        entry = { id: p.pathId, filePath: p.url, renders: [] };
        byComponent.set(p.pathId, entry);
      }
      const dataUrl = 'data:image/png;base64,' + readFileSync(p.screenshotPath).toString('base64');
      entry.renders.push({
        scenarioId: p.scenarioId,
        screenshotDataUrl: dataUrl,
        unmatchedUrls: p.unmatchedUrls,
      });
    }

    const html = renderHtmlReport({
      runId: meta.runId,
      createdAt: meta.createdAt,
      mode: 'url',
      prompt: meta.prompt,
      scenarios: meta.scenarios,
      verdict: 'pass',
      summary: 'Both pages render the right state under each scenario.',
      components: Array.from(byComponent.values()),
      brand: 'validity',
      viewCommand: `npx http-server ${runDir(projectRoot, runId)}`,
      criteria: [
        {
          description: 'Dashboard shows the user when logged in',
          status: 'pass',
          reasoning: 'Profile card is present.',
        },
      ],
    });

    expect(html).toContain('<!doctype html');
    expect(html).toContain(meta.runId);
    expect(html).toContain('verify dashboard and users under both auth states');
    // Both pages appear in the screenshots section.
    expect(html).toContain('http://localhost:3000/dashboard');
    expect(html).toContain('http://localhost:3000/users');
    // Two scenarios on the dashboard create scenario tabs.
    expect(html).toContain('logged-in');
    expect(html).toContain('logged-out');
    // No source-code Source section is rendered (URL mode has no source).
    expect(html).not.toContain('<details class="report-source"');
    // The unmatched-URL note appears for the users page.
    expect(html).toContain('something-unmatched');

    const reportPath = resolve(runDir(projectRoot, runId), 'report.html');
    writeFileSync(reportPath, html);
    expect(existsSync(reportPath)).toBe(true);
  });

  it('DISCLOSES that no mechanical criteria ran, and only in URL mode (B6)', () => {
    const urlHtml = renderHtmlReport({
      runId,
      createdAt: '2026-05-04T00:00:00.000Z',
      mode: 'url',
      prompt: 'verify the dashboard',
      scenarios: [],
      components: [],
      brand: 'validity',
      viewCommand: 'npx http-server .',
    });
    // The exact sentence, from the single shared constant — a reader must not
    // mistake "no mechanical failures" for "mechanical checks passed".
    expect(urlHtml).toContain(URL_MODE_DISCLOSURE);
    expect(urlHtml).toContain('only screenshots were captured');

    // Isolation mode DOES run them, so the disclosure must not appear there.
    const isoHtml = renderHtmlReport({
      runId,
      createdAt: '2026-05-04T00:00:00.000Z',
      mode: 'isolation',
      prompt: 'verify the card',
      scenarios: [],
      components: [],
      brand: 'validity',
      viewCommand: 'npx http-server .',
    });
    expect(isoHtml).not.toContain(URL_MODE_DISCLOSURE);
  });

  it('every criterion a URL run persists is unverifiable, with the reason attached (B6)', () => {
    const spec = {
      id: 'spec-url',
      version: 1,
      status: 'frozen',
      hash: 'h',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      criteria: [
        { id: 'AC-1', text: 'no console errors', tier: 'hard' },
        { id: 'AC-2', text: 'renders under 2s', tier: 'property' },
        { id: 'AC-3', text: 'looks polished', tier: 'soft' },
      ],
      createdAt: '2026-05-04T00:00:00.000Z',
    } as unknown as Spec;

    const verdicts = urlModeCriterionVerdicts(spec);
    expect(verdicts).toHaveLength(3);
    // No pass may be manufactured by a mode that evaluated nothing: a blank
    // would let submit_report accept an agent's self-reported hard pass.
    expect(verdicts.every((v) => v.status === 'unverifiable')).toBe(true);
    expect(verdicts.every((v) => (v.detail ?? '').includes('URL mode'))).toBe(true);
    expect(verdicts.map((v) => v.id)).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(verdicts.map((v) => v.tier)).toEqual(['hard', 'property', 'soft']);
  });

  it('renderHtmlReport with mode=url and zero pages shows a page-flavored empty state', () => {
    const html = renderHtmlReport({
      runId,
      createdAt: '2026-05-04T00:00:00.000Z',
      mode: 'url',
      prompt: 'no captures',
      scenarios: [],
      components: [],
      brand: 'validity',
      viewCommand: 'npx http-server .',
    });
    expect(html).toContain('No pages were captured');
    expect(html).not.toContain('No components were rendered');
  });

  it('renderHtmlReport with mode=isolation and zero components shows the components empty state', () => {
    const html = renderHtmlReport({
      runId,
      createdAt: '2026-05-04T00:00:00.000Z',
      mode: 'isolation',
      prompt: 'no components',
      scenarios: [],
      components: [],
      brand: 'validity',
      viewCommand: 'npx http-server .',
    });
    expect(html).toContain('No components were rendered');
    expect(html).not.toContain('No pages were captured');
  });
});
