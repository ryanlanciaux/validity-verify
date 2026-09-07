/**
 * Foundation additions to run.ts (Track 0): the `perfKeyFor` key derivation,
 * the `isRunPlanned` back-compat reader, and the three audited behavior stamps
 * (writeNativeRunMeta `mode: 'native'` + `planned`; indexRunForSpec `sha`).
 * Old run-metas / runs.jsonl lines without the new fields must still parse.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  indexRunForSpec,
  isRunPlanned,
  perfKeyFor,
  readRunMeta,
  readSpecRunHistory,
  writeNativeRunMeta,
  writeUrlRunMeta,
  type RunMeta,
} from './run.js';
import { validityDir } from './runs.js';

describe('perfKeyFor', () => {
  it('falls back to base/base/default for a bare render', () => {
    expect(perfKeyFor({ id: 'Comp' })).toBe('Comp__base__base__default');
  });

  it('threads scenario / fixture / viewport into the key', () => {
    expect(
      perfKeyFor({
        id: 'Comp',
        scenarioId: 'logged-in',
        fixtureId: 'primary',
        viewport: { width: 375, height: 667, name: 'mobile' },
      }),
    ).toBe('Comp__logged-in__primary__mobile');
  });

  it('adds a __data-<state> segment for a forced non-populated dataState', () => {
    expect(perfKeyFor({ id: 'Comp', dataState: 'empty' })).toBe(
      'Comp__base__base__default__data-empty',
    );
  });

  it('does NOT add a data segment for the populated default', () => {
    expect(perfKeyFor({ id: 'Comp', dataState: 'populated' })).toBe('Comp__base__base__default');
  });

  it('adds an @native suffix for native renders', () => {
    expect(perfKeyFor({ id: 'Comp' }, 'native')).toBe('Comp__base__base__default@native');
    expect(perfKeyFor({ id: 'Comp', dataState: 'loading' }, 'native')).toBe(
      'Comp__base__base__default__data-loading@native',
    );
  });
});

describe('isRunPlanned', () => {
  it('honors an explicit planned flag', () => {
    expect(isRunPlanned({ planned: true })).toBe(true);
    expect(isRunPlanned({ planned: false })).toBe(false);
  });

  it('an explicit planned:false wins over a plan id', () => {
    expect(isRunPlanned({ planned: false, planId: 'plan_1' })).toBe(false);
  });

  it('derives planned from planId / specId on old run-metas', () => {
    expect(isRunPlanned({ planId: 'plan_1' })).toBe(true);
    expect(isRunPlanned({ specId: 'spec-x' })).toBe(true);
  });

  it('is false for a run with neither flag nor ids', () => {
    expect(isRunPlanned({})).toBe(false);
  });
});

describe('behavior stamps + back-compat', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-run-foundation-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("writeNativeRunMeta stamps mode:'native' + planned from the ids", () => {
    const runId = 'run_native_planned';
    mkdirSync(resolve(projectRoot, '.validity', 'runs', runId), { recursive: true });
    writeNativeRunMeta({
      projectRoot,
      runId,
      prompt: 'p',
      scenarios: [],
      components: [
        { id: 'c', filePath: 'src/C.tsx', screenshotPath: resolve(projectRoot, 'c.png') },
      ],
      componentSources: {},
      reportConfig: { enabled: false, brand: 'none' },
      specId: 'spec-x',
    });
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.mode).toBe('native');
    expect(meta.planned).toBe(true);
  });

  it('writeUrlRunMeta stamps planned:false when there is no plan/spec', () => {
    const runId = 'run_url_unplanned';
    mkdirSync(resolve(projectRoot, '.validity', 'runs', runId), { recursive: true });
    writeUrlRunMeta({
      projectRoot,
      runId,
      prompt: 'p',
      scenarios: [],
      pages: [],
      reportConfig: { enabled: false, brand: 'none' },
    });
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.mode).toBe('url');
    expect(meta.planned).toBe(false);
  });

  it('indexRunForSpec stamps the run sha from meta.git', () => {
    const meta: RunMeta = {
      runId: 'run_sha',
      createdAt: new Date().toISOString(),
      mode: 'isolation',
      prompt: 'p',
      scenarios: [],
      diff: { files: [] },
      report: { enabled: false, brand: 'none' },
      specId: 'spec-sha',
      git: { sha: 'abc1234', dirty: false },
      criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    };
    indexRunForSpec(projectRoot, meta);
    const [entry] = readSpecRunHistory(projectRoot, 'spec-sha');
    expect(entry!.sha).toBe('abc1234');
  });

  it('tolerates a legacy runs.jsonl line without sha / perf', () => {
    const dir = resolve(validityDir(projectRoot), 'specs', 'spec-legacy');
    mkdirSync(dir, { recursive: true });
    const legacyLine =
      JSON.stringify({
        runId: 'run_legacy',
        createdAt: new Date(0).toISOString(),
        verdict: 'pass',
        counts: { pass: 1, fail: 0, unverifiable: 0 },
      }) + '\n';
    appendFileSync(resolve(dir, 'runs.jsonl'), legacyLine);
    const [entry] = readSpecRunHistory(projectRoot, 'spec-legacy');
    expect(entry!.runId).toBe('run_legacy');
    expect(entry!.sha).toBeUndefined();
    expect(entry!.perf).toBeUndefined();
  });

  it('reads a pre-foundation run-meta unchanged (new fields absent → undefined)', () => {
    const runId = 'run_legacy_meta';
    const runDir = resolve(projectRoot, '.validity', 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    // A run-meta as written before Track 0 — no planned/mode:'native'/scoring/etc.
    const legacy = {
      runId,
      createdAt: new Date(0).toISOString(),
      mode: 'isolation',
      prompt: 'legacy',
      scenarios: [],
      diff: { files: [] },
      report: { enabled: false, brand: 'none' },
      planId: 'plan_legacy',
    };
    writeFileSync(resolve(runDir, 'run-meta.json'), JSON.stringify(legacy));
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.planned).toBeUndefined();
    expect(meta.sessionFingerprint).toBeUndefined();
    // …but the back-compat reader still classifies it as planned via its plan id.
    expect(isRunPlanned(meta)).toBe(true);
  });

  it('indexRunForSpec accepts the locked historyCommitted opts arg (ignored for now)', () => {
    const meta: RunMeta = {
      runId: 'run_opts',
      createdAt: new Date().toISOString(),
      mode: 'isolation',
      prompt: 'p',
      scenarios: [],
      diff: { files: [] },
      report: { enabled: false, brand: 'none' },
      specId: 'spec-opts',
      criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
    };
    expect(() => indexRunForSpec(projectRoot, meta, { historyCommitted: true })).not.toThrow();
    expect(readSpecRunHistory(projectRoot, 'spec-opts')).toHaveLength(1);
  });
});
