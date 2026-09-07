/**
 * Native verify is the SAME plan -> verify -> submit_report contract web has,
 * captured on a simulator. This locks the load-bearing seams that make that
 * parity real without driving a real device:
 *   - target selection caps the SERIAL device's fanout (truncating, never
 *     silently dropping);
 *   - the mock-network status block warns when screens were scored against the
 *     real network instead of fixtures;
 *   - run-meta written in the isolation shape round-trips through the unmodified
 *     report renderer — a CONFIRMED render embeds its native screenshot, a
 *     non-confirmed one surfaces a render error and NO image (so a broken
 *     component is never scored), and the planId survives for submit_report.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_NATIVE_RENDER_TARGETS,
  componentIdFor,
  readRunMeta,
  runDir,
  runMetaPathFor,
  writeNativeRunMeta,
  writeSpec,
  ensureRunDirectories,
  type ComponentRender,
  type CriterionVerdict,
  type Spec,
} from '@validity.ai/verify-spec';
import { renderHtmlReport, type ReportComponent } from '@validity.ai/verify-web';
import {
  NATIVE_DATASTATE_UNSUPPORTED_DETAIL,
  annotateNativeDataStateVerdicts,
  handleSubmitReport,
  holdNativeDataStateCriteria,
  nativeHeldDataStateSoftIds,
  nativeMockStatusBlock,
  selectNativeVerifyTargets,
  specScopedScoringInstructions,
} from './server.js';

// 8x8 PNG (red square) — small but real bytes so the renderer's data-URL embed
// is exercised against a real image.
const RED_8x8_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX/AAAA' +
    'AAD//////xX76loAAAANSURBVAjXY/jPwMDAAAAEAAEW6L8VAAAAAElFTkSuQmCC',
  'base64',
);

describe('selectNativeVerifyTargets', () => {
  const projectRoot = '/proj';

  it('fans components × scenarios and mints the same ids as the isolation path', () => {
    const { targets, truncated } = selectNativeVerifyTargets(
      ['/proj/src/A.tsx', '/proj/src/B.tsx'],
      [],
      projectRoot,
    );
    expect(truncated).toBe(0);
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      rel: 'src/A.tsx',
      id: componentIdFor('/proj/src/A.tsx', projectRoot),
      scenarioId: undefined,
    });
    // base render → no scenario fanout.
    expect(targets.every((t) => t.scenarioId === undefined)).toBe(true);
    expect(selectNativeVerifyTargets(['/proj/src/A.tsx'], [], projectRoot).warnings).toEqual([]);
  });

  it('multiplies across scenarios', () => {
    const { targets } = selectNativeVerifyTargets(
      ['/proj/src/A.tsx'],
      ['logged-in', 'logged-out'],
      projectRoot,
    );
    expect(targets.map((t) => t.scenarioId)).toEqual(['logged-in', 'logged-out']);
    expect(
      selectNativeVerifyTargets(['/proj/src/A.tsx'], ['logged-in', 'logged-out'], projectRoot)
        .warnings,
    ).toEqual([]);
  });

  it('CAPS the serial-device fanout by truncation (never a silent drop)', () => {
    // 3 components × 3 scenarios = 9 > cap.
    const { targets, truncated } = selectNativeVerifyTargets(
      ['/proj/src/A.tsx', '/proj/src/B.tsx', '/proj/src/C.tsx'],
      ['s1', 's2', 's3'],
      projectRoot,
    );
    expect(targets).toHaveLength(MAX_NATIVE_RENDER_TARGETS);
    expect(truncated).toBe(9 - MAX_NATIVE_RENDER_TARGETS);
  });

  it('renders ONE target per fixture (with resolved props) instead of bare — and does NOT fan across scenarios (web parity)', () => {
    const { targets, warnings } = selectNativeVerifyTargets(
      ['/proj/src/Button.tsx'],
      ['logged-in', 'logged-out'], // requested scenarios are IGNORED for a fixture-driven component
      projectRoot,
      {
        'src/Button.tsx': {
          fixtures: {
            primary: { props: { text: 'Go', kind: 'primary' } },
            disabled: { props: { text: 'Nope', disabled: true } },
          },
        },
      },
    );
    expect(targets).toHaveLength(2);
    expect(targets.map((t) => t.fixtureId)).toEqual(['primary', 'disabled']);
    // Fixture props are resolved host-side (the device only applies overrides).
    expect(targets[0]).toMatchObject({
      rel: 'src/Button.tsx',
      fixtureId: 'primary',
      props: { text: 'Go', kind: 'primary' },
    });
    // Fixture-driven → no scenario fanout at all.
    expect(targets.every((t) => t.scenarioId === undefined)).toBe(true);
    expect(warnings).toEqual([
      `${componentIdFor('/proj/src/Button.tsx', projectRoot)}: scenarios [logged-in, logged-out] ignored — component has fixtures in .validity/config.ts (fixtures take precedence). Remove the fixtures or drop the scenarios.`,
    ]);
  });

  it('falls back to scenario fanout for components WITHOUT fixtures, even when other components have them', () => {
    const { targets, warnings } = selectNativeVerifyTargets(
      ['/proj/src/Button.tsx', '/proj/src/Plain.tsx'],
      ['logged-in'],
      projectRoot,
      { 'src/Button.tsx': { fixtures: { primary: { props: { text: 'Go' } } } } },
    );
    // Button → 1 fixture target; Plain → 1 scenario target.
    expect(targets).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/src-button.*scenarios \[logged-in\] ignored/);
    expect(targets[0]).toMatchObject({ rel: 'src/Button.tsx', fixtureId: 'primary' });
    expect(targets[0]!.scenarioId).toBeUndefined();
    expect(targets[1]).toMatchObject({ rel: 'src/Plain.tsx', scenarioId: 'logged-in' });
    expect(targets[1]!.fixtureId).toBeUndefined();
  });

  it('matches config fixtures by relative OR absolute key', () => {
    const byAbs = selectNativeVerifyTargets(['/proj/src/Button.tsx'], [], projectRoot, {
      '/proj/src/Button.tsx': { fixtures: { only: { props: { a: 1 } } } },
    });
    expect(byAbs.targets).toHaveLength(1);
    expect(byAbs.targets[0]).toMatchObject({ fixtureId: 'only', props: { a: 1 } });
  });
});

describe('nativeMockStatusBlock', () => {
  it('ACTIVE — fixtures applied', () => {
    const block = nativeMockStatusBlock({ mock: { active: true } });
    expect(block).toMatch(/^MOCK_NETWORK: ACTIVE/);
  });

  it('DISABLED — carries the reason verbatim and forbids scoring network criteria', () => {
    const block = nativeMockStatusBlock({ mock: { active: false, reason: 'msw boom' } });
    expect(block).toMatch(/^MOCK_NETWORK: DISABLED \(msw boom\)/);
    expect(block).toMatch(/REAL network/);
    expect(block).toMatch(/Do NOT score/);
  });

  it('UNKNOWN — no hello, or an old companion that sent no mock field', () => {
    expect(nativeMockStatusBlock(null)).toMatch(/^MOCK_NETWORK: UNKNOWN/);
    // hello present (platform) but no mock field → still unknown, never a false "disabled".
    expect(nativeMockStatusBlock({ platform: 'ios' })).toMatch(/^MOCK_NETWORK: UNKNOWN/);
  });
});

describe('native run-meta round-trips through the UNMODIFIED report renderer', () => {
  let projectRoot: string;
  const runId = 'run_native_rt_001';

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-native-rt-'));
    const { screenshotsDir } = ensureRunDirectories(projectRoot, runId);
    // A real PNG for the CONFIRMED render.
    writeFileSync(resolve(screenshotsDir, 'src-screen-ok__base.png'), RED_8x8_PNG);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('embeds a confirmed native screenshot, surfaces a render error for a broken one, and keeps planId', () => {
    const { screenshotsDir } = ensureRunDirectories(projectRoot, runId);
    const okPath = resolve(screenshotsDir, 'src-screen-ok__base.png');

    const components: ComponentRender[] = [
      {
        id: 'src-screen-ok',
        filePath: 'src/ScreenOk.tsx',
        screenshotPath: okPath,
        scenarioId: undefined,
        a11ySnapshot: 'Button "Save"',
        // Un-mocked URLs the device's permissive catch-all answered, threaded
        // from the bridge 'rendered' ack — must persist into run-meta so the
        // diagnostic survives a separate submit_report (native parity with web).
        unmatchedUrls: ['GET https://api.example.com/users'],
      },
      {
        // A deliberately-broken component: status was not 'confirmed', so the
        // native analog of 'render error:' is set and there is NO screenshot.
        id: 'src-screen-broken',
        filePath: 'src/ScreenBroken.tsx',
        screenshotPath: resolve(screenshotsDir, 'src-screen-broken__base.png'),
        scenarioId: undefined,
        renderError: 'RENDER_FAILED: No component registered for "src/ScreenBroken.tsx"',
      },
    ];

    const metaPath = writeNativeRunMeta({
      projectRoot,
      runId,
      prompt: 'native verify the screens',
      scenarios: [],
      components,
      componentSources: {
        'src-screen-ok': 'export function ScreenOk() { return null; }',
        'src-screen-broken': 'export function ScreenBroken() { return null; }',
      },
      reportConfig: { enabled: true, brand: 'validity' },
      planId: 'plan_abc',
    });
    expect(metaPath).toBe(resolve(runDir(projectRoot, runId), 'run-meta.json'));

    // Read it back the way handleSubmitReport does — proving the isolation
    // PAYLOAD shape is intact (components populated, planId kept). The mode is
    // now labeled 'native' (C1); submit_report's only mode branch is `=== 'url'`,
    // so 'native' reads exactly like 'isolation' there.
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.mode).toBe('native');
    expect(meta.planId).toBe('plan_abc');
    expect(meta.components).toHaveLength(2);
    // The un-mocked URLs threaded from the device ack survive the run-meta
    // round-trip, so submit_report can surface them like web's unmatched block.
    expect(meta.components?.[0]?.unmatchedUrls).toEqual(['GET https://api.example.com/users']);

    // Drive the UNMODIFIED report renderer with the same grouping handleSubmitReport uses.
    const reportComponents: ReportComponent[] = (meta.components ?? []).map((c) => ({
      id: c.id,
      filePath: c.filePath,
      source: meta.componentSources?.[c.id],
      renders: [
        {
          scenarioId: c.scenarioId,
          screenshotDataUrl: c.renderError
            ? undefined
            : 'data:image/png;base64,' + RED_8x8_PNG.toString('base64'),
          renderError: c.renderError,
        },
      ],
    }));

    const html = renderHtmlReport({
      runId: meta.runId,
      createdAt: meta.createdAt,
      mode: 'isolation',
      prompt: meta.prompt,
      scenarios: meta.scenarios,
      verdict: 'partial',
      components: reportComponents,
      brand: meta.report.brand,
      viewCommand: `npx http-server ${runDir(projectRoot, runId)}`,
      criteria: [
        { description: 'Save button visible', status: 'pass', reasoning: 'Screenshot shows it.' },
      ],
    });

    expect(html).toContain('<!doctype html');
    // The confirmed render's native screenshot embeds as a data URL.
    expect(html).toContain('data:image/png;base64,');
    // The broken render surfaces its render error (and, being errored, no image
    // for it — the renderer suppresses screenshots on renderError).
    expect(html).toContain('No component registered for');
    // The (plan) criterion shows up in the report.
    expect(html).toContain('Save button visible');
  });

  it('threads the companion-measured on-device perf onto the render, persists it through run-meta, and renders the Performance panel', () => {
    const { screenshotsDir } = ensureRunDirectories(projectRoot, runId);
    const okPath = resolve(screenshotsDir, 'src-screen-ok__base.png');

    // The companion measures perf on-device and ships it on the bridge
    // `rendered` ack; handleVerifyNative copies it onto the render's
    // `performance` (NativePerf is a structural subset of PerformanceMetrics:
    // readyMs/mountMs/updateMs/commitCount; loadMs/firstContentfulPaintMs have
    // no RN source). This is the host-side wiring the report panel reads.
    const components: ComponentRender[] = [
      {
        id: 'src-screen-ok',
        filePath: 'src/ScreenOk.tsx',
        screenshotPath: okPath,
        scenarioId: undefined,
        performance: { readyMs: 120, mountMs: 8, updateMs: 3, commitCount: 2 },
      },
    ];

    writeNativeRunMeta({
      projectRoot,
      runId,
      prompt: 'native verify perf',
      scenarios: [],
      components,
      componentSources: { 'src-screen-ok': 'export function ScreenOk() { return null; }' },
      reportConfig: { enabled: true, brand: 'validity' },
    });

    // The perf object survives the run-meta round-trip (REGRESSION GUARD: the
    // host once copied unmatchedUrls/consoleErrorCount but dropped perf entirely,
    // so native perf never reached the report).
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.components?.[0]?.performance).toEqual({
      readyMs: 120,
      mountMs: 8,
      updateMs: 3,
      commitCount: 2,
    });

    // Drive the UNMODIFIED report renderer, carrying perf onto the render the
    // same way the submit_report mapping does.
    const reportComponents: ReportComponent[] = (meta.components ?? []).map((c) => ({
      id: c.id,
      filePath: c.filePath,
      source: meta.componentSources?.[c.id],
      renders: [
        {
          scenarioId: c.scenarioId,
          screenshotDataUrl: 'data:image/png;base64,' + RED_8x8_PNG.toString('base64'),
          performance: c.performance,
        },
      ],
    }));

    const html = renderHtmlReport({
      runId: meta.runId,
      createdAt: meta.createdAt,
      mode: 'isolation',
      prompt: meta.prompt,
      scenarios: meta.scenarios,
      verdict: 'pass',
      components: reportComponents,
      brand: meta.report.brand,
      viewCommand: `npx http-server ${runDir(projectRoot, runId)}`,
    });

    // The per-render Performance panel surfaces the native metrics the companion
    // measured. The web-only metrics (load / first contentful paint) have no RN
    // source and are correctly absent.
    expect(html).toContain('Time to ready');
    expect(html).toContain('Initial render (mount)');
    expect(html).toContain('Slowest re-render (update)');
    expect(html).not.toContain('Page load');
    expect(html).not.toContain('First contentful paint');
  });
});

describe('native dataState criteria (A2 — axis is web-only in v1)', () => {
  const specWith = (criteria: Spec['criteria']): Spec => ({
    id: 'spec-native-ds',
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'native',
    criteria,
    createdAt: new Date(0).toISOString(),
  });

  it('holdNativeDataStateCriteria filters dataState-conditioned checks out of the device run', () => {
    const criteria: Spec['criteria'] = [
      {
        id: 'AC-pop',
        text: 'renders items',
        tier: 'hard',
        checks: [{ expect: { console: { errors: 0 } } }],
      },
      {
        id: 'AC-empty',
        text: 'shows no results',
        tier: 'hard',
        dataState: 'empty',
        checks: [{ expect: { element: { text: 'No results', state: 'visible' } } }],
      },
      {
        id: 'AC-pop2',
        text: 'populated is fine',
        tier: 'hard',
        dataState: 'populated',
        checks: [{ expect: { console: { errors: 0 } } }],
      },
    ];
    expect(holdNativeDataStateCriteria(criteria).map((c) => c.id)).toEqual(['AC-pop', 'AC-pop2']);
  });

  it("CAN'T FALSE-GREEN: a held-out dataState criterion resolves unverifiable with the native-unsupported detail — never pass", () => {
    const spec = specWith([
      {
        id: 'AC-empty',
        text: 'shows no results when the list is empty',
        tier: 'hard',
        dataState: 'empty',
        checks: [{ expect: { element: { text: 'No results', state: 'visible' } } }],
      },
    ]);
    // The roll-up placeholder for a criterion whose checks never executed.
    const verdicts: CriterionVerdict[] = [
      {
        id: 'AC-empty',
        tier: 'hard',
        status: 'unverifiable',
        detail: 'checks did not execute against the rendered set',
      },
    ];
    annotateNativeDataStateVerdicts(verdicts, spec);
    expect(verdicts[0]!.status).toBe('unverifiable');
    expect(verdicts[0]!.detail).toBe(NATIVE_DATASTATE_UNSUPPORTED_DETAIL);
  });

  it('leaves executed / dataState-free soft / populated verdicts untouched', () => {
    const spec = specWith([
      { id: 'AC-soft', text: 'the header feels polished', tier: 'soft' },
      {
        id: 'AC-pop',
        text: 'renders',
        tier: 'hard',
        checks: [{ expect: { console: { errors: 0 } } }],
      },
    ]);
    const verdicts: CriterionVerdict[] = [
      {
        id: 'AC-soft',
        tier: 'soft',
        status: 'unverifiable',
        detail: 'soft — score from the screenshot below',
      },
      { id: 'AC-pop', tier: 'hard', status: 'pass', detail: '1 pass' },
    ];
    annotateNativeDataStateVerdicts(verdicts, spec);
    // A dataState-FREE soft placeholder keeps its scoring instruction
    // (submit_report owns it) — the natural render IS the right premise.
    expect(verdicts[0]!.detail).toBe('soft — score from the screenshot below');
    expect(verdicts[1]!.status).toBe('pass');
    expect(verdicts[1]!.detail).toBe('1 pass');
  });

  it('REGRESSION (native dataState soft scoring): a SOFT dataState placeholder is annotated unverifiable-with-detail — never left as an invitation to score the wrong state', () => {
    const spec = specWith([
      { id: 'AC-soft', text: 'the empty state feels friendly', tier: 'soft', dataState: 'empty' },
    ]);
    const verdicts: CriterionVerdict[] = [
      {
        id: 'AC-soft',
        tier: 'soft',
        status: 'unverifiable',
        detail: 'soft — score from the screenshot below',
      },
    ];
    annotateNativeDataStateVerdicts(verdicts, spec);
    expect(verdicts[0]!.status).toBe('unverifiable');
    expect(verdicts[0]!.detail).toBe(NATIVE_DATASTATE_UNSUPPORTED_DETAIL);
  });

  it('nativeHeldDataStateSoftIds collects exactly the soft non-populated dataState criteria', () => {
    const spec = specWith([
      { id: 'AC-soft-empty', text: 'empty state', tier: 'soft', dataState: 'empty' },
      { id: 'AC-soft-err', text: 'error state', tier: 'soft', dataState: 'error' },
      { id: 'AC-soft-pop', text: 'populated soft', tier: 'soft', dataState: 'populated' },
      { id: 'AC-soft-plain', text: 'plain soft', tier: 'soft' },
      {
        id: 'AC-hard-empty',
        text: 'hard empty',
        tier: 'hard',
        dataState: 'empty',
        checks: [{ expect: { console: { errors: 0 } } }],
      },
    ]);
    expect([...nativeHeldDataStateSoftIds(spec)].sort()).toEqual(['AC-soft-empty', 'AC-soft-err']);
    expect(nativeHeldDataStateSoftIds(null).size).toBe(0);
    expect(nativeHeldDataStateSoftIds(undefined).size).toBe(0);
  });

  it('specScopedScoringInstructions HOLDS a native dataState soft criterion out of the scoreable set and names why', () => {
    const spec = specWith([
      { id: 'AC-empty', text: 'the empty state feels friendly', tier: 'soft', dataState: 'empty' },
      { id: 'AC-plain', text: 'the header feels polished', tier: 'soft' },
    ]);
    const out = specScopedScoringInstructions(spec, [], nativeHeldDataStateSoftIds(spec));
    // The scoreable list carries ONLY the dataState-free criterion…
    expect(out).toContain('AC-plain: the header feels polished');
    expect(out).not.toContain('AC-empty: the empty state feels friendly\n');
    // …and the held block names the criterion + why it cannot be scored here.
    expect(out).toContain('HELD (native)');
    expect(out).toContain('AC-empty: the empty state feels friendly (dataState: empty)');
    expect(out).toContain('submit_report refuses a pass');
  });

  it('specScopedScoringInstructions with EVERY soft criterion held says nothing needs fresh scoring (no quality-floor bait)', () => {
    const spec = specWith([
      { id: 'AC-empty', text: 'the empty state feels friendly', tier: 'soft', dataState: 'empty' },
    ]);
    const out = specScopedScoringInstructions(spec, [], nativeHeldDataStateSoftIds(spec));
    expect(out).toContain('none scoreable on this runtime');
    expect(out).not.toContain('QUALITY FLOOR');
    expect(out).toContain('HELD (native)');
  });

  it('web path is untouched: no held set ⇒ byte-identical instructions with the soft criterion scoreable', () => {
    const spec = specWith([
      { id: 'AC-empty', text: 'the empty state feels friendly', tier: 'soft', dataState: 'empty' },
    ]);
    expect(specScopedScoringInstructions(spec, [])).toBe(specScopedScoringInstructions(spec));
    expect(specScopedScoringInstructions(spec)).toContain(
      'AC-empty: the empty state feels friendly',
    );
  });
});

/**
 * REGRESSION (native dataState soft scoring), the submit-time gate: even when
 * an agent ignores the HELD block and scores a dataState-conditioned soft
 * criterion PASS from the populated native screenshot (a valid citation!),
 * the pass must persist as `unverifiable` — the wire-seam contract is "native
 * dataState criteria resolve unverifiable in the meantime, never pass".
 */
describe('submit_report clamps a native soft dataState pass to unverifiable', () => {
  let projectRoot: string;
  const runId = 'run_native_ds_clamp_001';
  const specId = 'spec-native-ds-clamp';

  function seedNativeRun(): void {
    writeSpec(projectRoot, {
      id: specId,
      version: 1,
      status: 'frozen',
      hash: 'sha-native-ds',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'native',
      criteria: [
        {
          id: 'AC-empty',
          text: 'the empty state feels friendly',
          tier: 'soft',
          dataState: 'empty',
        },
        { id: 'AC-plain', text: 'the header feels polished', tier: 'soft' },
      ],
      createdAt: new Date(0).toISOString(),
    } as Spec);

    const { screenshotsDir } = ensureRunDirectories(projectRoot, runId);
    const shot = resolve(screenshotsDir, 'src-screen-ok__base.png');
    writeFileSync(shot, RED_8x8_PNG);
    writeNativeRunMeta({
      projectRoot,
      runId,
      prompt: 'native verify the screen',
      scenarios: [],
      components: [
        { id: 'src-screen-ok', filePath: 'src/ScreenOk.tsx', screenshotPath: shot },
      ] as ComponentRender[],
      componentSources: {},
      reportConfig: { enabled: true, brand: 'none' },
      planId: specId,
      specId,
      specVersion: 1,
      specHash: 'sha-native-ds',
      criterionVerdicts: [
        {
          id: 'AC-empty',
          tier: 'soft',
          status: 'unverifiable',
          detail: NATIVE_DATASTATE_UNSUPPORTED_DETAIL,
        },
        {
          id: 'AC-plain',
          tier: 'soft',
          status: 'unverifiable',
          detail: 'soft — score from the screenshot below',
        },
      ],
    });
  }

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-native-ds-clamp-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('a submitted PASS on the held criterion persists as unverifiable (signedOff stays false); the un-held soft pass persists', async () => {
    seedNativeRun();
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      criteria: [
        {
          id: 'AC-empty',
          description: 'the empty state feels friendly',
          status: 'pass',
          reasoning: 'looks friendly to me',
          screenshotIds: ['src-screen-ok'], // a REAL citation — of the WRONG (populated) state
        },
        {
          id: 'AC-plain',
          description: 'the header feels polished',
          status: 'pass',
          reasoning: 'clean header',
          screenshotIds: ['src-screen-ok'],
        },
      ],
    });
    expect(result.isError).toBeUndefined();

    const meta = readRunMeta(projectRoot, runId)!;
    const byId = new Map(meta.criterionVerdicts!.map((v) => [v.id, v]));
    // The held criterion's pass was withheld — never scoreable green against
    // the wrong data state…
    expect(byId.get('AC-empty')!.status).toBe('unverifiable');
    expect(byId.get('AC-empty')!.detail).toContain('pass withheld');
    expect(byId.get('AC-empty')!.detail).toContain('dataState renders are not supported on native');
    // …while the dataState-free soft criterion scores normally (the clamp is
    // targeted, not a blanket native soft freeze)…
    expect(byId.get('AC-plain')!.status).toBe('pass');
    // …and the stop rule stays shut on the blocking unverifiable criterion.
    expect(meta.signedOff).toBe(false);
  });

  it('a submitted FAIL on the held criterion is accepted (strictening is always allowed)', async () => {
    seedNativeRun();
    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'fail',
      criteria: [
        {
          id: 'AC-empty',
          description: 'the empty state feels friendly',
          status: 'fail',
          reasoning: 'no empty state handling exists at all',
          screenshotIds: ['src-screen-ok'],
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    const meta = readRunMeta(projectRoot, runId)!;
    const verdict = meta.criterionVerdicts!.find((v) => v.id === 'AC-empty')!;
    expect(verdict.status).toBe('fail');
    expect(meta.signedOff).toBe(false);
  });

  it('web control: the same spec scored on an ISOLATION run keeps the pass (the sandbox renders the forced state for real)', async () => {
    seedNativeRun();
    // Rewrite the run-meta as a web isolation run of the same spec — the A2
    // clamp is keyed on the runtime, not on the criterion alone.
    const meta = readRunMeta(projectRoot, runId)!;
    meta.mode = 'isolation';
    writeFileSync(runMetaPathFor(projectRoot, runId), JSON.stringify(meta, null, 2));

    const result = await handleSubmitReport({
      runId,
      projectRoot,
      verdict: 'pass',
      criteria: [
        {
          id: 'AC-empty',
          description: 'the empty state feels friendly',
          status: 'pass',
          reasoning: 'forced empty render shows the friendly message',
          screenshotIds: ['src-screen-ok'],
        },
      ],
    });
    expect(result.isError).toBeUndefined();
    const scored = readRunMeta(projectRoot, runId)!;
    expect(scored.criterionVerdicts!.find((v) => v.id === 'AC-empty')!.status).toBe('pass');
  });
});
