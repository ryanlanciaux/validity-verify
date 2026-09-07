/**
 * WHICH native render executes a spec's hard/property checks — and how the
 * per-render verdicts roll up.
 *
 * This pair was untested, and the gap hid a total loss of mechanical
 * verification: `renderNativeTargets` attached `criteriaChecks` only to a BASE
 * render (no scenario, no fixture), while `selectNativeVerifyTargets` emits NO
 * base target for a component that has configured fixtures (or when scenarios
 * are requested). For every such component the checks bound to nothing, zero
 * device checks ran, and every hard criterion fell to the roll-up's
 * "checks did not execute" placeholder — a spec that could not gate anything,
 * silently. Web hit the identical bug and fixed it by binding to ALL variants
 * of a target with no base render (core run.ts `prepareVerification`); these
 * tests pin native to the same contract, plus the fail-wins roll-up that keeps
 * multi-attach honest (first-wins would let a pass on fixture 1 mask a fail on
 * fixture 3).
 *
 * Everything runs against the injected {@link NativeRenderLoopDeps} fakes — no
 * simulator, no emulator, no network.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentRender, CriterionVerdict, Spec, SpecCriterion } from '@validity.ai/verify-spec';
import type { CaptureNativeOptions, NativeCaptureResult } from '@validity.ai/verify-native';
import {
  collectVerdictsFromComponents,
  renderNativeTargets,
  selectNativeVerifyTargets,
  unattachedNativeChecksWarning,
  type NativeRenderLoopInput,
  type NativeSession,
} from './server.js';

const fakeSession = () =>
  ({
    app: {
      bundleId: 'com.example.playground',
      contentHash: 'content-hash-1',
      prepared: {
        contentHash: 'content-hash-1',
        dataPayload: {
          scenarios: { 'logged-in': { user: 'ada' }, 'logged-out': {} },
          mockNetwork: 'active',
        },
      },
    } as unknown as NativeSession['app'],
    driver: { kind: 'fake-driver' } as unknown as NativeSession['driver'],
    bridge: { kind: 'fake-bridge' } as unknown as NativeSession['bridge'],
    platform: 'ios' as const,
    pinnedDevice: 'SIM-1',
    metroLogPath: '/dev/null',
  }) satisfies Partial<NativeRenderLoopInput>;

const HARD: SpecCriterion[] = [
  {
    id: 'AC-1',
    text: 'the heading is visible',
    tier: 'hard',
    checks: [{ expect: { element: { text: 'Inbox', state: 'visible' } } }],
  },
  {
    id: 'AC-2',
    text: 'no console errors',
    tier: 'hard',
    checks: [{ expect: { console: { errors: 0 } } }],
  },
];

const PASS_VERDICTS: CriterionVerdict[] = [
  { id: 'AC-1', tier: 'hard', status: 'pass' },
  { id: 'AC-2', tier: 'hard', status: 'pass' },
];

/** One label per capture: `component[/fixture|@scenario][:scheme]` + attach flag. */
interface Attachment {
  label: string;
  attached: boolean;
}

describe('renderNativeTargets — binding the spec checks to renders', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-native-attach-'));
    for (const rel of ['Inbox.tsx', 'Sidebar.tsx']) {
      writeFileSync(resolve(projectRoot, rel), `export const C = () => null;\n`);
    }
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * Records what each capture was handed. `verdictsFrom` decides whether a
   * capture answers with `criterionVerdicts` — the loop's base-render latch
   * closes only on a capture that actually came back with them.
   */
  const runLoop = async (
    targets: NativeRenderLoopInput['targets'],
    opts: {
      checkCriteria?: SpecCriterion[];
      specTargetKeys?: Set<string>;
      verdictsFrom?: (spec: CaptureNativeOptions['spec']) => CriterionVerdict[] | undefined;
    } = {},
  ) => {
    const seen: Attachment[] = [];
    const capture = vi.fn(async (o: CaptureNativeOptions): Promise<NativeCaptureResult> => {
      const variant = o.spec.fixture
        ? `/${o.spec.fixture}`
        : o.spec.scenario
          ? `@${o.spec.scenario}`
          : '';
      const scheme = o.spec.colorScheme ? `:${o.spec.colorScheme}` : '';
      seen.push({
        label: `${o.spec.component}${variant}${scheme}`,
        attached: (o.criteriaChecks?.length ?? 0) > 0,
      });
      return {
        target: o.spec,
        url: `validity://render?component=${o.spec.component}`,
        screenshotPath: o.screenshotPath,
        a11ySnapshot: '<tree>',
        render: { status: 'confirmed', via: 'bridge-ack', token: 'nav-ok' },
        timing: { openMs: 7 },
        // `verdictsFrom` returning undefined is MEANINGFUL (a capture that ran
        // the checks but came back with nothing), so it is not defaulted away.
        criterionVerdicts: o.criteriaChecks?.length
          ? opts.verdictsFrom
            ? opts.verdictsFrom(o.spec)
            : PASS_VERDICTS
          : undefined,
      };
    });
    const result = await renderNativeTargets({
      ...fakeSession(),
      targets,
      projectRoot,
      screenshotsDir: projectRoot,
      checkCriteria: opts.checkCriteria ?? HARD,
      specTargetKeys: opts.specTargetKeys,
      deps: { capture: capture as never },
    });
    return { seen, result };
  };

  const attachedLabels = (seen: Attachment[]) => seen.filter((s) => s.attached).map((s) => s.label);

  /** Native's colorScheme axis, applied the way handleVerifyNative applies it. */
  const overSchemes = (
    targets: NativeRenderLoopInput['targets'],
    schemes: Array<'light' | 'dark'>,
  ) => targets.flatMap((t) => schemes.map((colorScheme) => ({ ...t, colorScheme })));

  // -------------------------------------------------------------------------
  // (1) Fixtures-only: no base render exists → every fixture render carries the
  //     checks. This is the case that ran ZERO checks before.
  // -------------------------------------------------------------------------

  it('a fixtures-only component attaches the checks to EVERY fixture render', async () => {
    const { targets } = selectNativeVerifyTargets(
      [resolve(projectRoot, 'Inbox.tsx')],
      [],
      projectRoot,
      {
        'Inbox.tsx': {
          fixtures: { unread: { props: { n: 3 } }, empty: { props: {} }, error: { props: {} } },
        },
      },
    );
    // The premise of the bug: fixtures mean NO base target is ever emitted.
    expect(targets.every((t) => t.fixtureId)).toBe(true);

    const { seen, result } = await runLoop(targets, { specTargetKeys: new Set(['inbox']) });

    expect(attachedLabels(seen)).toEqual([
      'Inbox.tsx/unread',
      'Inbox.tsx/empty',
      'Inbox.tsx/error',
    ]);
    expect(result.renders.every((r) => (r.criterionVerdicts?.length ?? 0) > 0)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('multi-attach survives the colorScheme fanout — every theme × fixture render checks', async () => {
    const { targets } = selectNativeVerifyTargets(
      [resolve(projectRoot, 'Inbox.tsx')],
      [],
      projectRoot,
      { 'Inbox.tsx': { fixtures: { unread: { props: {} }, empty: { props: {} } } } },
    );
    const { seen } = await runLoop(overSchemes(targets, ['light', 'dark']), {
      specTargetKeys: new Set(['inbox']),
    });

    expect(attachedLabels(seen)).toEqual([
      'Inbox.tsx/unread:light',
      'Inbox.tsx/unread:dark',
      'Inbox.tsx/empty:light',
      'Inbox.tsx/empty:dark',
    ]);
  });

  // -------------------------------------------------------------------------
  // (2) Scenario-only: same shape — scenarios also suppress the base render.
  // -------------------------------------------------------------------------

  it('a scenario-driven component attaches the checks to EVERY scenario render', async () => {
    const { targets } = selectNativeVerifyTargets(
      [resolve(projectRoot, 'Inbox.tsx')],
      ['logged-in', 'logged-out'],
      projectRoot,
    );
    expect(targets.every((t) => t.scenarioId)).toBe(true);

    const { seen } = await runLoop(targets, { specTargetKeys: new Set(['inbox']) });

    expect(attachedLabels(seen)).toEqual(['Inbox.tsx@logged-in', 'Inbox.tsx@logged-out']);
  });

  // -------------------------------------------------------------------------
  // (3) A base render exists → today's single-bind semantics are unchanged.
  // -------------------------------------------------------------------------

  it('binds to the BASE render only when one exists — fixture renders of another component stay check-free', async () => {
    const { targets } = selectNativeVerifyTargets(
      [resolve(projectRoot, 'Inbox.tsx'), resolve(projectRoot, 'Sidebar.tsx')],
      [],
      projectRoot,
      { 'Sidebar.tsx': { fixtures: { collapsed: { props: {} }, expanded: { props: {} } } } },
    );
    // Inbox has no fixtures → one base target; Sidebar fans into two fixtures.
    expect(targets.map((t) => t.fixtureId)).toEqual([undefined, 'collapsed', 'expanded']);

    const { seen } = await runLoop(targets); // no spec targets ⇒ all eligible

    expect(attachedLabels(seen)).toEqual(['Inbox.tsx']);
  });

  it('with a colorScheme fanout, only the FIRST confirming base render carries the checks', async () => {
    const { targets } = selectNativeVerifyTargets(
      [resolve(projectRoot, 'Inbox.tsx')],
      [],
      projectRoot,
    );
    const { seen } = await runLoop(overSchemes(targets, ['light', 'dark']), {
      specTargetKeys: new Set(['inbox']),
    });

    expect(attachedLabels(seen)).toEqual(['Inbox.tsx:light']);
  });

  it('RETRY LATCH: a base render that returns no verdicts defers the checks to the next base render', async () => {
    const { targets } = selectNativeVerifyTargets(
      [resolve(projectRoot, 'Inbox.tsx')],
      [],
      projectRoot,
    );
    const { seen, result } = await runLoop(overSchemes(targets, ['light', 'dark']), {
      specTargetKeys: new Set(['inbox']),
      // The light render is handed the checks but answers with nothing (an
      // unconfirmed/racing tree) — the latch must stay OPEN.
      verdictsFrom: (spec) => (spec.colorScheme === 'light' ? undefined : PASS_VERDICTS),
    });

    expect(attachedLabels(seen)).toEqual(['Inbox.tsx:light', 'Inbox.tsx:dark']);
    expect(result.renders.map((r) => r.criterionVerdicts?.length ?? 0)).toEqual([0, 2]);
  });

  // -------------------------------------------------------------------------
  // (4) Nothing eligible → a named warning, never a silent no-op.
  // -------------------------------------------------------------------------

  it('spec targets that match no rendered component raise a warning and attach nothing', async () => {
    const { targets } = selectNativeVerifyTargets(
      [resolve(projectRoot, 'Inbox.tsx')],
      [],
      projectRoot,
    );
    const { seen, result } = await runLoop(targets, {
      specTargetKeys: new Set(['checkout', 'cart']),
    });

    expect(attachedLabels(seen)).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    // Both sides of the mismatch are named — the spec's keys AND what rendered.
    expect(result.warnings[0]).toContain('checkout');
    expect(result.warnings[0]).toContain('cart');
    expect(result.warnings[0]).toContain('Inbox.tsx');
    expect(result.warnings[0]).toContain('2 hard/property criteria executed NO checks');
  });

  it('no checks configured → no warning even when nothing is eligible', async () => {
    const { targets } = selectNativeVerifyTargets(
      [resolve(projectRoot, 'Inbox.tsx')],
      [],
      projectRoot,
    );
    const { result } = await runLoop(targets, {
      checkCriteria: [],
      specTargetKeys: new Set(['checkout']),
    });

    expect(result.warnings).toEqual([]);
  });

  it('names the empty rendered set when there is nothing to bind to at all', () => {
    const warning = unattachedNativeChecksWarning(3, new Set(['checkout']), []);
    expect(warning).toContain('(nothing rendered)');
    expect(warning).toContain('checkout');
  });
});

// ---------------------------------------------------------------------------
// The roll-up. Multi-attach is only safe if the fold is conservative: a pass on
// one variant must never bury a fail on another.
// ---------------------------------------------------------------------------

describe('collectVerdictsFromComponents — folding multi-attached verdicts', () => {
  const spec = (criteria: SpecCriterion[]) =>
    ({ id: 'inbox', version: 1, criteria }) as unknown as Spec;

  const hardSpec = spec([
    { id: 'AC-1', text: 'heading visible', tier: 'hard', checks: [{ press: 'Tab' }] },
  ]);

  const render = (fixtureId: string, verdict: CriterionVerdict): ComponentRender => ({
    id: 'inbox',
    filePath: 'Inbox.tsx',
    screenshotPath: `/tmp/inbox__${fixtureId}.png`,
    fixtureId,
    criterionVerdicts: [verdict],
  });

  it('FAIL WINS: a pass on fixture 1 cannot mask a fail on fixture 2', () => {
    const out = collectVerdictsFromComponents(hardSpec, [
      render('unread', { id: 'AC-1', tier: 'hard', status: 'pass', detail: 'found it' }),
      render('empty', { id: 'AC-1', tier: 'hard', status: 'fail', detail: 'no heading' }),
    ]);

    expect(out[0]!.status).toBe('fail');
    // The failing variant is NAMED — otherwise a merged fail is unactionable.
    expect(out[0]!.detail).toContain('failed on 1/2 variants');
    expect(out[0]!.detail).toContain('fixture "empty"');
    expect(out[0]!.detail).toContain('no heading');
  });

  it('an unverifiable execution beats a pass', () => {
    const out = collectVerdictsFromComponents(hardSpec, [
      render('unread', { id: 'AC-1', tier: 'hard', status: 'pass' }),
      render('empty', {
        id: 'AC-1',
        tier: 'hard',
        status: 'unverifiable',
        detail: 'tree unsettled',
      }),
    ]);

    expect(out[0]!.status).toBe('unverifiable');
    expect(out[0]!.detail).toContain('unverifiable on 1/2 variants (fixture "empty")');
  });

  it('all-pass folds to pass with the variant tally', () => {
    const out = collectVerdictsFromComponents(hardSpec, [
      render('unread', { id: 'AC-1', tier: 'hard', status: 'pass' }),
      render('empty', { id: 'AC-1', tier: 'hard', status: 'pass' }),
      render('error', { id: 'AC-1', tier: 'hard', status: 'pass' }),
    ]);

    expect(out[0]!.status).toBe('pass');
    expect(out[0]!.detail).toBe('passed on 3/3 variants');
  });

  it('a single execution (the base-render case) is returned VERBATIM', () => {
    const only: CriterionVerdict = {
      id: 'AC-1',
      tier: 'hard',
      status: 'pass',
      detail: 'heading "Inbox" visible',
      checks: [{ check: { press: 'Tab' }, status: 'pass' }],
    };
    const out = collectVerdictsFromComponents(hardSpec, [
      {
        id: 'inbox',
        filePath: 'Inbox.tsx',
        screenshotPath: '/tmp/inbox__base.png',
        criterionVerdicts: [only],
      },
    ]);

    expect(out[0]).toBe(only);
  });

  it('scenario renders are labelled by scenario', () => {
    const out = collectVerdictsFromComponents(hardSpec, [
      {
        id: 'inbox',
        filePath: 'Inbox.tsx',
        screenshotPath: '/tmp/a.png',
        scenarioId: 'logged-in',
        criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
      },
      {
        id: 'inbox',
        filePath: 'Inbox.tsx',
        screenshotPath: '/tmp/b.png',
        scenarioId: 'logged-out',
        criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'fail' }],
      },
    ]);

    expect(out[0]!.detail).toContain('scenario "logged-out"');
  });

  it('keeps NATIVE placeholder wording for criteria that never executed', () => {
    const out = collectVerdictsFromComponents(
      spec([
        { id: 'AC-1', text: 'heading visible', tier: 'hard', checks: [{ press: 'Tab' }] },
        { id: 'AC-2', text: 'feels polished', tier: 'soft' },
      ]),
      [],
    );

    expect(out.map((v) => v.status)).toEqual(['unverifiable', 'unverifiable']);
    expect(out[0]!.detail).toBe('checks did not execute against the rendered set');
    expect(out[1]!.detail).toBe('soft — score from the screenshot below');
  });
});
