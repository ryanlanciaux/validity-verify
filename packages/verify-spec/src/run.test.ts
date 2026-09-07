import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_NATIVE_RENDER_TARGETS,
  MAX_PERF_KEYS_PER_RUN,
  MAX_RENDER_PAIRS,
  TooManyRenderPairsError,
  UnknownScenarioError,
  collectRunPerf,
  componentIdFor,
  componentLooksDataDependent,
  computeCoverageFromVerdicts,
  computeHardPropertyCoverage,
  computeRegressionDeltas,
  indexRunForSpec,
  fixtureScenarioPrecedenceWarning,
  prepareVerification,
  readRunMeta,
  readSpecRunHistory,
  resolveColorSchemes,
  resolveDataStates,
  writeNativeRunMeta,
  type RenderFn,
  type RenderRequestSpec,
  type RunMeta,
} from './run.js';
import { historyDir, readHistoryRows } from './history.js';
import { detectRunOrigin } from './run-origin.js';
import { ensureValidityGitignore } from './runs.js';
import type { CriterionVerdict } from './spec-schema.js';
import type { ComponentRender, RunEnvironment, ValidityConfig } from './types.js';
import type { Spec } from './spec-schema.js';
import type { EnsureResult } from './ensure-configured.js';
import { CommandCheckRunner, type CommandExec, type CommandExecResult } from './command-check.js';

/**
 * Minimal ComponentRender skeleton for the perf-timeline tests (D1) — only
 * the fields `collectRunPerf`/`perfKeyFor` read matter.
 */
function perfRender(over: Partial<ComponentRender> & Pick<ComponentRender, 'id'>): ComponentRender {
  return { filePath: `src/${over.id}.tsx`, screenshotPath: `/tmp/${over.id}.png`, ...over };
}

/**
 * Minimal config skeleton; tests override `scenarios` per case.
 */
function makeConfig(overrides: Partial<ValidityConfig> = {}): ValidityConfig {
  return {
    renderMode: 'web',
    framework: 'vite',
    wrapper: './.validity/wrapper.tsx',
    ...overrides,
  };
}

/**
 * The environment record a stub render session reports. Mirrors what the real
 * sandbox produces on the ordinary path (web target, its own cold Vite, no
 * Tailwind shim, a clean dep pre-scan) so a test only has to state the fact it
 * is actually about.
 */
function stubEnvironment(over: Partial<RunEnvironment> = {}): RunEnvironment {
  return { target: 'web', devServer: 'cold', tailwindShim: false, ...over };
}

/**
 * Stub render that records the requests it received and returns one
 * `ComponentRender` per request, echoing back the scenarioId so tests can
 * assert on the fan-out shape.
 */
function makeStubRender(): {
  render: RenderFn;
  captured: { components: RenderRequestSpec[] };
} {
  const captured: { components: RenderRequestSpec[] } = { components: [] };
  const render: RenderFn = async (args) => {
    captured.components = args.components;
    return {
      renders: args.components.map<ComponentRender>((req) => ({
        id: req.componentId,
        filePath: req.componentAbsolutePath,
        screenshotPath: `${args.screenshotsDir}/${req.componentId}__${req.scenarioId ?? 'base'}.png`,
        scenarioId: req.scenarioId,
        viewport: req.viewport,
      })),
      environment: stubEnvironment(),
    };
  };
  return { render, captured };
}

/**
 * A real React component file the AST-based `isReactComponentFile` filter will
 * accept — `selectComponentsToRender` parses the file before including it.
 */
const COMPONENT_SOURCE = `import React from 'react';
export default function Widget() {
  return <div>hi</div>;
}
`;

describe('prepareVerification', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-run-test-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeComponent(relPath: string): string {
    const abs = resolve(projectRoot, relPath);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, COMPONENT_SOURCE);
    return relPath;
  }

  it('produces 1 render per component when scenarios is undefined', async () => {
    const a = writeComponent('src/A.tsx');
    const { render, captured } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render the widget',
      changedFiles: [a],
      render,
    });

    expect(result.pairCount).toBe(1);
    expect(captured.components).toHaveLength(1);
    expect(captured.components[0]!.scenarioId).toBeUndefined();
    expect(result.components).toHaveLength(1);
    expect(result.components[0]!.scenarioId).toBeUndefined();
  });

  it('produces 1 render per component when scenarios is empty array', async () => {
    const a = writeComponent('src/A.tsx');
    const { render, captured } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({ scenarios: { 'logged-in': {} } }),
      prompt: 'render the widget',
      changedFiles: [a],
      scenarios: [],
      render,
    });

    expect(result.pairCount).toBe(1);
    expect(captured.components).toHaveLength(1);
    expect(captured.components[0]!.scenarioId).toBeUndefined();
  });

  it('fans out to N×M pairs across components and scenarios', async () => {
    const a = writeComponent('src/A.tsx');
    const b = writeComponent('src/B.tsx');
    const { render, captured } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({
        scenarios: { 'logged-in': {}, 'logged-out': {} },
      }),
      prompt: 'render',
      changedFiles: [a, b],
      scenarios: ['logged-in', 'logged-out'],
      render,
    });

    expect(result.pairCount).toBe(4);
    expect(captured.components).toHaveLength(4);
    expect(result.warnings).toBeUndefined();

    // Group by component → scenario set, regardless of order.
    const byComponent = new Map<string, Set<string | undefined>>();
    for (const r of captured.components) {
      const set = byComponent.get(r.componentId) ?? new Set();
      set.add(r.scenarioId);
      byComponent.set(r.componentId, set);
    }
    expect(byComponent.size).toBe(2);
    for (const set of byComponent.values()) {
      expect(set).toEqual(new Set(['logged-in', 'logged-out']));
    }
  });

  it('throws UnknownScenarioError with the available scenario list', async () => {
    const a = writeComponent('src/A.tsx');
    const { render } = makeStubRender();

    await expect(
      prepareVerification({
        projectRoot,
        config: makeConfig({
          scenarios: { 'logged-in': {}, 'logged-out': {} },
        }),
        prompt: 'render',
        changedFiles: [a],
        scenarios: ['nope'],
        render,
      }),
    ).rejects.toBeInstanceOf(UnknownScenarioError);

    try {
      await prepareVerification({
        projectRoot,
        config: makeConfig({
          scenarios: { 'logged-in': {}, 'logged-out': {} },
        }),
        prompt: 'render',
        changedFiles: [a],
        scenarios: ['nope'],
        render,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownScenarioError);
      const e = err as UnknownScenarioError;
      expect(e.scenario).toBe('nope');
      expect(e.available).toEqual(['logged-in', 'logged-out']);
    }
  });

  it('throws UnknownScenarioError before the pair-cap check', async () => {
    // Ensure validation order: unknown scenarios fail loud even when the
    // requested fan-out would also exceed the cap.
    const files = Array.from({ length: 4 }, (_, i) => writeComponent(`src/C${i}.tsx`));
    const { render } = makeStubRender();

    await expect(
      prepareVerification({
        projectRoot,
        config: makeConfig({ scenarios: { 'logged-in': {} } }),
        prompt: 'render',
        changedFiles: files,
        scenarios: ['logged-in', 'mystery'],
        render,
        maxComponents: 4,
      }),
    ).rejects.toBeInstanceOf(UnknownScenarioError);
  });

  it('throws TooManyRenderPairsError when pair count exceeds the cap', async () => {
    // 13 components × 2 scenarios = 26 > MAX_RENDER_PAIRS (24).
    const files = Array.from({ length: 13 }, (_, i) => writeComponent(`src/C${i}.tsx`));
    const { render } = makeStubRender();

    // Single call (rather than two) — ts-morph + babel parsing on 13 files is
    // slow enough that doing it twice times out the test under the default
    // budget. One rejection is enough to verify both the type and the fields.
    await expect(
      prepareVerification({
        projectRoot,
        config: makeConfig({
          scenarios: { 'logged-in': {}, 'logged-out': {} },
        }),
        prompt: 'render',
        changedFiles: files,
        scenarios: ['logged-in', 'logged-out'],
        render,
        maxComponents: 13,
      }),
    ).rejects.toMatchObject({
      name: 'TooManyRenderPairsError',
      requestedPairs: 26,
      limit: MAX_RENDER_PAIRS,
    });
    // Generous timeout: spins 13 real component fixtures through ts-morph +
    // babel (~28s on an idle machine), which flakes under vitest's default 30s.
  }, 120_000);

  it('does not invoke the renderer when the pair cap is exceeded', async () => {
    const files = Array.from({ length: 13 }, (_, i) => writeComponent(`src/C${i}.tsx`));
    let invocations = 0;
    const render: RenderFn = async () => {
      invocations++;
      return { renders: [], environment: stubEnvironment() };
    };

    await expect(
      prepareVerification({
        projectRoot,
        config: makeConfig({
          scenarios: { 'logged-in': {}, 'logged-out': {} },
        }),
        prompt: 'render',
        changedFiles: files,
        scenarios: ['logged-in', 'logged-out'],
        render,
        maxComponents: 13,
      }),
    ).rejects.toBeInstanceOf(TooManyRenderPairsError);

    expect(invocations).toBe(0);
    // Generous timeout: same 13-fixture parse cost as the sibling above (~25s).
  }, 120_000);

  it('returns pairCount: 0 with no thrown error when no components match', async () => {
    const { render, captured } = makeStubRender();

    // changedFiles with no .tsx/.jsx entries → selectComponentsToRender returns [].
    // (Avoids falling through to `git diff`, which would be brittle in a tmp dir.)
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({
        scenarios: { 'logged-in': {}, 'logged-out': {} },
      }),
      prompt: 'render nothing',
      changedFiles: ['README.md'],
      scenarios: ['logged-in', 'logged-out'],
      render,
    });

    expect(result.pairCount).toBe(0);
    expect(result.components).toEqual([]);
    expect(result.componentSources).toEqual({});
    // Renderer not invoked when there's nothing to render.
    expect(captured.components).toEqual([]);
  });

  it('writes run-meta.json so submit_report can read it back', async () => {
    const a = writeComponent('src/A.tsx');
    const { render } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({
        scenarios: {
          'logged-in': { mockNetwork: { handlers: [{ url: '/api/me', json: { id: '1' } }] } },
        },
        report: { enabled: true, brand: 'validity' },
      }),
      prompt: 'render the widget',
      changedFiles: [a],
      scenarios: ['logged-in'],
      render,
    });

    // run-meta.json is at the path returned by prepareVerification.
    expect(result.runMetaPath).toContain(result.runId);
    expect(result.runMetaPath.endsWith('run-meta.json')).toBe(true);

    const raw = readFileSync(result.runMetaPath, 'utf-8');
    const meta = JSON.parse(raw);
    expect(meta.runId).toBe(result.runId);
    expect(meta.prompt).toBe('render the widget');
    expect(meta.scenarios).toEqual(['logged-in']);
    expect(meta.report).toEqual({ enabled: true, brand: 'validity' });
    expect(meta.components).toHaveLength(1);
    expect(meta.components[0].scenarioId).toBe('logged-in');
    // Diff is the empty {files:[]} object when not in a git repo (or git
    // collection failed). Tmp dirs aren't git repos.
    expect(meta.diff).toEqual({ files: [] });
    // The isolation writer stamps run origin from the env. Assert against the
    // detector (not a hard 'local') so the test is deterministic even when the
    // suite itself runs under a CI runner.
    expect(meta.origin).toBe(detectRunOrigin(process.env));
    expect(meta.origin === 'local' || meta.origin === 'ci').toBe(true);
  });

  it('stamps coverageFloorPercent from config at verify time (C1)', async () => {
    const a = writeComponent('src/A.tsx');
    const { render } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({ coverageFloorPercent: 70 }),
      prompt: 'render the widget',
      changedFiles: [a],
      render,
    });
    const meta = JSON.parse(readFileSync(result.runMetaPath, 'utf-8'));
    expect(meta.coverageFloorPercent).toBe(70);
    // No floor configured → the field is simply absent (additive persistence).
    const bare = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render the widget',
      changedFiles: [a],
      render,
    });
    const bareMeta = JSON.parse(readFileSync(bare.runMetaPath, 'utf-8'));
    expect(bareMeta.coverageFloorPercent).toBeUndefined();
    expect(bareMeta.droppedDataStates).toBeUndefined();
  });

  it('does not collect diff when report is disabled', async () => {
    const a = writeComponent('src/A.tsx');
    const { render } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({ report: false }),
      prompt: 'render the widget',
      changedFiles: [a],
      render,
    });

    const meta = JSON.parse(readFileSync(result.runMetaPath, 'utf-8'));
    expect(meta.report.enabled).toBe(false);
    expect(meta.diff).toEqual({ files: [] });
  });

  it('readRunMeta returns null when the file does not exist', async () => {
    const meta = readRunMeta(projectRoot, 'run_does_not_exist');
    expect(meta).toBeNull();
  });

  it('stacks fixtures into one render request when no fixture has play', async () => {
    const button = writeComponent('src/Button.tsx');
    const { render, captured } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({
        // Scenarios are intentionally requested AND defined — the component
        // has fixtures, so they must be ignored for that component.
        scenarios: { 'logged-in': {}, 'logged-out': {} },
        components: {
          [button]: {
            fixtures: {
              primary: { props: { variant: 'primary' } },
              loading: { props: { variant: 'primary', loading: true } },
              disabled: { props: { variant: 'primary', disabled: true } },
            },
          },
        },
      }),
      prompt: 'render the button',
      changedFiles: [button],
      scenarios: ['logged-in', 'logged-out'],
      render,
    });

    // Stacking emits ONE render with all fixture names attached, not N.
    expect(result.pairCount).toBe(1);
    expect(captured.components).toHaveLength(1);
    const req = captured.components[0]!;
    expect(req.scenarioId).toBeUndefined();
    expect(req.fixtureId).toBeUndefined();
    expect(req.props).toBeUndefined();
    expect(req.stackedFixtureIds).toEqual(['primary', 'loading', 'disabled']);
    expect(result.warnings).toEqual([
      fixtureScenarioPrecedenceWarning('src-button', ['logged-in', 'logged-out']),
    ]);
  });

  it('falls back to per-fixture renders when a fixture has play', async () => {
    const button = writeComponent('src/Button.tsx');
    const { render, captured } = makeStubRender();
    const playFn = async () => {
      /* no-op */
    };

    await prepareVerification({
      projectRoot,
      config: makeConfig({
        components: {
          [button]: {
            fixtures: {
              // primary: no play
              primary: { props: { variant: 'primary' } },
              // pressed: needs play to drive the click — forces per-fixture
              pressed: { props: { variant: 'primary' }, play: playFn },
            },
          },
        },
      }),
      prompt: 'render the button',
      changedFiles: [button],
      render,
    });

    // ANY play in the set → per-fixture. Each fixture gets its own request.
    expect(captured.components).toHaveLength(2);
    expect(captured.components.every((r) => r.fixtureId)).toBe(true);
    expect(captured.components.every((r) => r.stackedFixtureIds === undefined)).toBe(true);
    const pressed = captured.components.find((r) => r.fixtureId === 'pressed');
    expect(pressed?.play).toBe(playFn);
  });

  it('renders a single fixture as its own request (1 fixture is not stacked)', async () => {
    const button = writeComponent('src/Button.tsx');
    const { render, captured } = makeStubRender();

    await prepareVerification({
      projectRoot,
      config: makeConfig({
        components: {
          [button]: {
            fixtures: {
              primary: { props: { variant: 'primary' } },
            },
          },
        },
      }),
      prompt: 'render the button',
      changedFiles: [button],
      render,
    });

    // 1-fixture stacking would produce a stacked render of one element —
    // pointless. Single fixtures keep the per-fixture path.
    expect(captured.components).toHaveLength(1);
    expect(captured.components[0]!.fixtureId).toBe('primary');
    expect(captured.components[0]!.stackedFixtureIds).toBeUndefined();
  });

  it('mixes stacked-fixture and scenario-driven components in one call', async () => {
    const button = writeComponent('src/Button.tsx');
    const loginForm = writeComponent('src/LoginForm.tsx');
    const { render, captured } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({
        scenarios: { 'logged-in': {}, 'logged-out': {} },
        components: {
          [button]: {
            fixtures: {
              primary: { props: { variant: 'primary' } },
              loading: { props: { loading: true } },
              disabled: { props: { disabled: true } },
            },
            // No fixtures on LoginForm — falls through to scenarios.
          },
        },
      }),
      prompt: 'render the surfaces',
      changedFiles: [button, loginForm],
      scenarios: ['logged-in', 'logged-out'],
      render,
    });

    // 1 (Button stacked) + 2 (LoginForm × scenarios) = 3
    expect(result.pairCount).toBe(3);
    expect(captured.components).toHaveLength(3);

    const buttonReqs = captured.components.filter((r) => r.componentId === 'src-button');
    expect(buttonReqs).toHaveLength(1);
    expect(buttonReqs[0]!.stackedFixtureIds).toEqual(['primary', 'loading', 'disabled']);
    expect(buttonReqs[0]!.scenarioId).toBeUndefined();

    expect(result.warnings).toEqual([
      fixtureScenarioPrecedenceWarning('src-button', ['logged-in', 'logged-out']),
    ]);

    const loginReqs = captured.components.filter((r) => r.componentId === 'src-loginform');
    expect(loginReqs).toHaveLength(2);
    for (const r of loginReqs) {
      expect(r.fixtureId).toBeUndefined();
      expect(r.stackedFixtureIds).toBeUndefined();
      expect(r.scenarioId).toBeDefined();
    }
    expect(new Set(loginReqs.map((r) => r.scenarioId))).toEqual(
      new Set(['logged-in', 'logged-out']),
    );
  });

  it('stacks across many components for a small pair count (no cap hit)', async () => {
    // 3 components × 5 fixtures each used to be 15 renders (above the cap).
    // With stacking, it becomes 3 (one stacked render per component) — well
    // under the cap. The cap-test below uses scenarios + components instead.
    const files = [
      writeComponent('src/A.tsx'),
      writeComponent('src/B.tsx'),
      writeComponent('src/C.tsx'),
    ];
    const fxBlock = {
      fixtures: {
        f1: { props: { n: 1 } },
        f2: { props: { n: 2 } },
        f3: { props: { n: 3 } },
        f4: { props: { n: 4 } },
        f5: { props: { n: 5 } },
      },
    };
    const { render, captured } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({
        components: {
          [files[0]!]: fxBlock,
          [files[1]!]: fxBlock,
          [files[2]!]: fxBlock,
        },
      }),
      prompt: 'render',
      changedFiles: files,
      render,
      maxComponents: 3,
    });

    expect(result.pairCount).toBe(3);
    expect(captured.components).toHaveLength(3);
    for (const req of captured.components) {
      expect(req.stackedFixtureIds).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    }
  });

  it('counts per-fixture renders (forced by play) against the pair cap', async () => {
    // When a component has any fixture with play, we fall back to per-fixture.
    // 5 components × 6 fixtures with play in each → 30 renders, > cap (24).
    const files = [
      writeComponent('src/A.tsx'),
      writeComponent('src/B.tsx'),
      writeComponent('src/C.tsx'),
      writeComponent('src/D.tsx'),
      writeComponent('src/E.tsx'),
    ];
    const playFn = async () => {};
    const fxBlock = {
      fixtures: {
        f1: { props: { n: 1 }, play: playFn },
        f2: { props: { n: 2 }, play: playFn },
        f3: { props: { n: 3 }, play: playFn },
        f4: { props: { n: 4 }, play: playFn },
        f5: { props: { n: 5 }, play: playFn },
        f6: { props: { n: 6 }, play: playFn },
      },
    };
    const { render } = makeStubRender();

    await expect(
      prepareVerification({
        projectRoot,
        config: makeConfig({
          components: {
            [files[0]!]: fxBlock,
            [files[1]!]: fxBlock,
            [files[2]!]: fxBlock,
            [files[3]!]: fxBlock,
            [files[4]!]: fxBlock,
          },
        }),
        prompt: 'render',
        changedFiles: files,
        render,
        maxComponents: 5,
      }),
    ).rejects.toMatchObject({
      name: 'TooManyRenderPairsError',
      requestedPairs: 30,
      limit: MAX_RENDER_PAIRS,
    });
  });

  it('passes the fixture play function to the render request', async () => {
    const button = writeComponent('src/Button.tsx');
    const { render, captured } = makeStubRender();
    const fixturePlay = async () => {
      /* noop — identity check below */
    };

    await prepareVerification({
      projectRoot,
      config: makeConfig({
        components: {
          [button]: {
            fixtures: {
              primary: { props: { variant: 'primary' }, play: fixturePlay },
            },
          },
        },
      }),
      prompt: 'render',
      changedFiles: [button],
      render,
    });

    expect(captured.components).toHaveLength(1);
    const req = captured.components[0]!;
    expect(typeof req.play).toBe('function');
    // Same identity — prepareVerification must not wrap or re-bind.
    expect(req.play).toBe(fixturePlay);
  });

  it("fans out renders across the scenario's viewports list", async () => {
    const a = writeComponent('src/A.tsx');
    const { render, captured } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({
        scenarios: {
          'logged-in': { viewports: ['mobile', 'desktop'] },
        },
      }),
      prompt: 'render',
      changedFiles: [a],
      scenarios: ['logged-in'],
      render,
    });

    // 1 component × 1 scenario × 2 viewports = 2 renders.
    expect(result.pairCount).toBe(2);
    expect(captured.components).toHaveLength(2);
    const viewportNames = captured.components.map((r) => r.viewport?.name);
    expect(new Set(viewportNames)).toEqual(new Set(['mobile', 'desktop']));
    const mobile = captured.components.find((r) => r.viewport?.name === 'mobile');
    expect(mobile?.viewport).toMatchObject({ width: 375, height: 667 });
    const desktop = captured.components.find((r) => r.viewport?.name === 'desktop');
    expect(desktop?.viewport).toMatchObject({ width: 1280, height: 800 });
  });

  it('accepts inline viewport specs alongside preset names', async () => {
    const a = writeComponent('src/A.tsx');
    const { render, captured } = makeStubRender();

    await prepareVerification({
      projectRoot,
      config: makeConfig({
        scenarios: {
          'logged-in': {
            viewports: ['mobile', { width: 1440, height: 900, name: 'laptop' }],
          },
        },
      }),
      prompt: 'render',
      changedFiles: [a],
      scenarios: ['logged-in'],
      render,
    });

    expect(captured.components).toHaveLength(2);
    const laptop = captured.components.find((r) => r.viewport?.name === 'laptop');
    expect(laptop?.viewport).toEqual({ width: 1440, height: 900, name: 'laptop' });
  });

  it('keeps the single-render default when no viewports list is set', async () => {
    const a = writeComponent('src/A.tsx');
    const { render, captured } = makeStubRender();

    await prepareVerification({
      projectRoot,
      config: makeConfig({
        scenarios: { 'logged-in': {} },
      }),
      prompt: 'render',
      changedFiles: [a],
      scenarios: ['logged-in'],
      render,
    });

    expect(captured.components).toHaveLength(1);
    expect(captured.components[0]!.viewport).toBeUndefined();
  });

  it('passes the scenario play function to the render request', async () => {
    const a = writeComponent('src/A.tsx');
    const { render, captured } = makeStubRender();
    const scenarioPlay = async () => {
      /* noop */
    };

    await prepareVerification({
      projectRoot,
      config: makeConfig({
        scenarios: {
          'logged-in': { play: scenarioPlay },
          'logged-out': {},
        },
      }),
      prompt: 'render',
      changedFiles: [a],
      scenarios: ['logged-in', 'logged-out'],
      render,
    });

    expect(captured.components).toHaveLength(2);
    const loggedIn = captured.components.find((r) => r.scenarioId === 'logged-in');
    const loggedOut = captured.components.find((r) => r.scenarioId === 'logged-out');
    expect(loggedIn?.play).toBe(scenarioPlay);
    // Scenario without `play` should NOT inherit the other scenario's.
    expect(loggedOut?.play).toBeUndefined();
  });

  it("binds spec hard-checks to the spec's TARGET component, rendered first", async () => {
    // A and B both change, but the spec targets B. The checks must run against
    // B's render — not A's (renderRequests[0] before the fix).
    const a = writeComponent('src/A.tsx');
    const b = writeComponent('src/B.tsx');
    const { render, captured } = makeStubRender();

    const spec: Spec = {
      id: 'spec-target',
      version: 1,
      status: 'frozen',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      targets: { components: ['B'] },
      criteria: [
        {
          id: 'AC-1',
          text: 'submit works',
          tier: 'hard',
          checks: [{ click: { role: 'button', name: 'Go' } }],
        },
      ],
      createdAt: new Date(0).toISOString(),
    };

    await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [a, b],
      render,
      spec,
    });

    // Target B is ordered FIRST in the rendered set…
    expect(captured.components[0]!.componentId).toBe('src-b');
    // …and the criteria checks bind to B, not the first changed file A.
    const bReq = captured.components.find((r) => r.componentId === 'src-b');
    const aReq = captured.components.find((r) => r.componentId === 'src-a');
    expect(bReq?.criteriaChecks?.map((c) => c.id)).toEqual(['AC-1']);
    expect(aReq?.criteriaChecks).toBeUndefined();
  });

  it('binds target checks when the target is a PATH (not just a name)', async () => {
    // `validity__plan` stores the target as a project-relative PATH
    // (`src/B.tsx`), while `spec_create` often stores a NAME (`B`). Both must
    // resolve to the same render — this is the regression the dogfood caught.
    const a = writeComponent('src/A.tsx');
    const b = writeComponent('src/B.tsx');
    const { render, captured } = makeStubRender();

    const spec: Spec = {
      id: 'spec-pathtarget',
      version: 1,
      status: 'frozen',
      source: { prompt: 'p', createdBy: 'user' },
      runtime: 'web',
      targets: { components: ['src/B.tsx'] },
      criteria: [
        {
          id: 'AC-1',
          text: 'submit works',
          tier: 'hard',
          checks: [{ click: { role: 'button', name: 'Go' } }],
        },
      ],
      createdAt: new Date(0).toISOString(),
    };

    await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [a, b],
      render,
      spec,
    });

    expect(captured.components[0]!.componentId).toBe('src-b');
    const bReq = captured.components.find((r) => r.componentId === 'src-b');
    expect(bReq?.criteriaChecks?.map((c) => c.id)).toEqual(['AC-1']);
  });

  it('DIAGNOSTIC: a render that THREW says so, instead of "not among the rendered set"', async () => {
    // Regression: a component that rendered and threw produced no check
    // verdicts, and the placeholder blamed target SELECTION — sending the
    // reader after a targeting bug when the real cause was a redbox whose
    // message was already sitting in run-meta.
    const b = writeComponent('src/B.tsx');
    const render: RenderFn = async (args) => ({
      renders: args.components.map<ComponentRender>((req) => ({
        id: req.componentId,
        filePath: req.componentAbsolutePath,
        screenshotPath: `${args.screenshotsDir}/${req.componentId}.png`,
        renderError:
          'THIS COMPONENT THREW AT RUNTIME\n\nIt probably needs more than props.\n\n' +
          'TypeError: navigation.setOptions is not a function\n    at useHeader.tsx:10:16',
      })),
      environment: stubEnvironment(),
    });

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [b],
      render,
      spec: targetSpec('spec-threw', ['src/B.tsx']),
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    const v = meta.criterionVerdicts?.find((x) => x.id === 'AC-1');
    expect(v?.status).toBe('unverifiable');
    // Names the throw…
    expect(v?.detail).toMatch(/navigation\.setOptions is not a function/);
    // …and does NOT misattribute it to target selection.
    expect(v?.detail).not.toMatch(/not among the rendered set/);
  });

  /** Frozen-spec skeleton with one render-bound hard criterion. */
  function targetSpec(id: string, components: string[]): Spec {
    return {
      id,
      version: 1,
      status: 'frozen',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      targets: { components },
      criteria: [
        {
          id: 'AC-1',
          text: 'submit works',
          tier: 'hard',
          checks: [{ click: { role: 'button', name: 'Go' } }],
        },
      ],
      createdAt: new Date(0).toISOString(),
    };
  }

  it('renders EVERY declared target even when they outnumber maxComponents (no silent drop)', async () => {
    // A spec may declare more targets than the component cap. The cap exists to
    // bound incidental changed-file noise — it must never discard a component
    // the spec explicitly asked to verify, because a dropped target's criteria
    // get scored against a DOM that was never rendered. Note `maxComponents: 3`
    // also makes `selectComponentsToRender` slice D off up front, so this
    // additionally proves the missing-target project scan pulls it back in.
    const files = ['src/A.tsx', 'src/B.tsx', 'src/C.tsx', 'src/D.tsx'].map(writeComponent);
    const { render, captured } = makeStubRender();

    await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: files,
      render,
      spec: targetSpec('spec-manytargets', ['A', 'B', 'C', 'D']),
      maxComponents: 3, // one FEWER than the number of declared targets
    });

    // All four survive, in the spec's declared order — the cap only ever eats
    // the non-target remainder (here: empty).
    expect(captured.components.map((r) => r.componentId)).toEqual([
      'src-a',
      'src-b',
      'src-c',
      'src-d',
    ]);
  });

  it('binds checks to the FIRST SPEC TARGET, not the target that happens to render first', async () => {
    // Both targets render. `A` is first in the changed-file/scan order, so the
    // old any-target `find` bound the checks to A. The spec declares B FIRST,
    // making B the subject — this is the real-world bug where a page-wide
    // assertion ran against an isolated atom that merely sorted earlier.
    const a = writeComponent('src/A.tsx');
    const b = writeComponent('src/B.tsx');
    const { render, captured } = makeStubRender();

    await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [a, b], // A first — the order that used to decide binding
      render,
      spec: targetSpec('spec-order', ['B', 'A']),
    });

    // Declared order drives the render order…
    expect(captured.components.map((r) => r.componentId)).toEqual(['src-b', 'src-a']);
    // …and the binding follows the spec, not the sort.
    const bReq = captured.components.find((r) => r.componentId === 'src-b');
    const aReq = captured.components.find((r) => r.componentId === 'src-a');
    expect(bReq?.criteriaChecks?.map((c) => c.id)).toEqual(['AC-1']);
    // Canonical single-bind: the second-declared target must NOT also pick it up.
    expect(aReq?.criteriaChecks).toBeUndefined();
  });

  it('REGRESSION: a single-target spec (the frozen spec-ac6d shape) binds exactly as before', async () => {
    // Guard for frozen specs like `spec-ac6d` (one target, `QuickActionsPanel`,
    // currently scoring 100). With exactly ONE target, "first base render
    // matching any target" and "first declared target that has a base render"
    // are mathematically the same render — pin it so the multi-target fix can
    // never move a frozen single-target spec's score.
    const header = writeComponent('src/components/DashboardHeader.tsx');
    const panel = writeComponent('src/components/QuickActionsPanel.tsx');
    const page = writeComponent('src/pages/Dashboard.tsx');
    const { render, captured } = makeStubRender();

    await prepareVerification({
      projectRoot,
      config: makeConfig(),
      // The lone target is NOT first in the changed set — it must still be
      // hoisted and bound, exactly as the pre-change code did.
      changedFiles: [header, panel, page],
      prompt: 'render',
      render,
      spec: targetSpec('spec-ac6d-shape', ['QuickActionsPanel']),
    });

    expect(captured.components[0]!.componentId).toBe('src-components-quickactionspanel');
    const panelReq = captured.components.find(
      (r) => r.componentId === 'src-components-quickactionspanel',
    );
    expect(panelReq?.criteriaChecks?.map((c) => c.id)).toEqual(['AC-1']);
    // Non-target renders stay unbound.
    for (const other of captured.components.filter((r) => r !== panelReq)) {
      expect(other.criteriaChecks).toBeUndefined();
    }
  });

  it('does NOT emit a regression delta for a soft criterion (no false signal)', async () => {
    // The OS-model bug: soft criteria are `unverifiable` PLACEHOLDERS at verify
    // time but the previous run's run-meta holds their POST-submit score (e.g.
    // `pass`). Diffing the placeholder against the prior score would emit a
    // spurious `regressed` for every soft criterion on every run. We restrict
    // deltas to HARD/PROPERTY tiers, so the soft criterion must be absent.
    const b = writeComponent('src/B.tsx');
    const { render } = makeStubRender();

    const spec: Spec = {
      id: 'spec-softdelta',
      version: 1,
      status: 'frozen',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      targets: { components: ['B'] },
      criteria: [
        {
          id: 'AC-hard',
          text: 'submit works',
          tier: 'hard',
          checks: [{ click: { role: 'button', name: 'Go' } }],
        },
        { id: 'AC-soft', text: 'looks polished', tier: 'soft' },
      ],
      createdAt: new Date(0).toISOString(),
    };

    // Previous run scored BOTH criteria `pass` (soft already scored by the
    // agent). The current soft verdict is the `unverifiable` placeholder.
    const previousVerdicts: CriterionVerdict[] = [
      { id: 'AC-hard', tier: 'hard', status: 'pass' },
      { id: 'AC-soft', tier: 'soft', status: 'pass' },
    ];

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [b],
      render,
      spec,
      previousVerdicts,
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    const deltas = meta.regressionDeltas ?? [];
    // The soft criterion must NOT appear at all — no spurious `regressed`.
    expect(deltas.find((d) => d.criterionId === 'AC-soft')).toBeUndefined();
    // Only the hard/property criterion is diffed.
    expect(deltas.map((d) => d.criterionId)).toEqual(['AC-hard']);
  });

  it('omits regressionDeltas entirely on a first run / when no previous verdicts are threaded', async () => {
    const b = writeComponent('src/B.tsx');
    const { render } = makeStubRender();

    const spec: Spec = {
      id: 'spec-firstrun',
      version: 1,
      status: 'frozen',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      targets: { components: ['B'] },
      criteria: [
        {
          id: 'AC-hard',
          text: 'submit works',
          tier: 'hard',
          checks: [{ click: { role: 'button', name: 'Go' } }],
        },
      ],
      createdAt: new Date(0).toISOString(),
    };

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [b],
      render,
      spec,
      // previousVerdicts omitted → undefined.
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    expect(meta.regressionDeltas).toBeUndefined();
  });
});

describe('prepareVerification — evidence taints (A3)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-run-taint-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeComponent(relPath: string): string {
    const abs = resolve(projectRoot, relPath);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, COMPONENT_SOURCE);
    return relPath;
  }

  const spec: Spec = {
    id: 'spec-taint',
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    targets: { components: ['B'] },
    criteria: [
      {
        id: 'AC-hard',
        text: 'submit works',
        tier: 'hard',
        checks: [{ click: { role: 'button', name: 'Go' } }],
      },
      { id: 'AC-soft', text: 'looks polished', tier: 'soft' },
    ],
    createdAt: new Date(0).toISOString(),
  };

  /**
   * Stub render that echoes attached criteria checks back as PASSING verdicts.
   * `extra` overrides each render; `env` overrides the ONE session-level
   * environment record (where facts like an aborted dep pre-scan now live).
   */
  function makePassingRender(
    extra: Partial<ComponentRender> = {},
    env: Partial<RunEnvironment> = {},
  ): RenderFn {
    return async (args) => ({
      renders: args.components.map<ComponentRender>((req) => ({
        id: req.componentId,
        filePath: req.componentAbsolutePath,
        screenshotPath: `${args.screenshotsDir}/${req.componentId}__base.png`,
        scenarioId: req.scenarioId,
        criterionVerdicts: req.criteriaChecks?.map((c) => ({
          id: c.id,
          tier: c.tier,
          status: 'pass' as const,
          detail: '1 pass, 0 fail, 0 unverifiable',
        })),
        ...extra,
      })),
      environment: stubEnvironment(env),
    });
  }

  it('stamps the wrapper taint on SOFT verdicts only when the wrapper is degraded, and records the session fingerprint', async () => {
    const b = writeComponent('src/B.tsx');
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [b],
      render: makePassingRender(),
      spec,
      sessionFingerprint: 'sfp-test-123',
      setupResult: {
        wrapperFidelity: {
          status: 'degraded',
          missingProviders: [],
          expectedProviders: [],
          analyzed: 'passthrough',
          detail: 'no-entry-file',
        },
      } as unknown as EnsureResult,
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    expect(meta.sessionFingerprint).toBe('sfp-test-123');
    const hard = meta.criterionVerdicts!.find((v) => v.id === 'AC-hard')!;
    const soft = meta.criterionVerdicts!.find((v) => v.id === 'AC-soft')!;
    // Soft-only: the wrapper's failure mode is wrong-but-renders pixels, which
    // is what soft scoring consumes; hard checks assert concrete DOM facts.
    expect(soft.evidenceTaints).toContain('wrapper');
    expect(soft.detail).toMatch(/tainted: wrapper: no-entry-file/);
    expect(hard.evidenceTaints ?? []).not.toContain('wrapper');
    expect(hard.status).toBe('pass');
  });

  it('names the missing providers in the taint detail when the analyzer found them (A1)', async () => {
    const b = writeComponent('src/B.tsx');
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [b],
      render: makePassingRender(),
      spec,
      setupResult: {
        wrapperFidelity: {
          status: 'degraded',
          missingProviders: ['QueryClientProvider', 'MemoryRouter'],
          expectedProviders: ['QueryClientProvider', 'MemoryRouter'],
          analyzed: 'on-disk',
        },
      } as unknown as EnsureResult,
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    const soft = meta.criterionVerdicts!.find((v) => v.id === 'AC-soft')!;
    expect(soft.evidenceTaints).toContain('wrapper');
    expect(soft.detail).toMatch(/tainted: wrapper: missing QueryClientProvider, MemoryRouter/);
  });

  it('stamps the dep-scan taint on ALL tiers when the pre-scan aborted, naming the stray import', async () => {
    const b = writeComponent('src/B.tsx');
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [b],
      // The failure now arrives on the SESSION's environment record, not
      // smeared across the renders.
      render: makePassingRender(
        {},
        {
          depScanFailure:
            'Could not resolve "chromium-bidi/lib/cjs/bidiMapper/BidiMapper" (from e2e/session.spec.ts:3:24)',
        },
      ),
      spec,
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    const hard = meta.criterionVerdicts!.find((v) => v.id === 'AC-hard')!;
    const soft = meta.criterionVerdicts!.find((v) => v.id === 'AC-soft')!;
    // ALL tiers — an aborted scan destabilizes the whole session's module
    // graph, and nothing can attribute which renders raced the reload. The
    // taint is demoting, so the fold clamps these passes to unverifiable.
    for (const v of [hard, soft]) {
      expect(v.evidenceTaints).toContain('dep-scan');
      expect(v.detail).toMatch(/tainted: dep-scan: Could not resolve "chromium-bidi/);
    }
    // The summary rides run-meta ONCE, on the environment record, for the CLI's
    // spec-error line.
    expect(meta.environment?.depScanFailure).toMatch(/Could not resolve "chromium-bidi/);
    // …and is NOT copied onto any render. This is the de-smearing assertion:
    // one session fact, one place to read it.
    expect(meta.components!.filter((c) => c.depScanFailure)).toHaveLength(0);
  });

  it('threads the render session environment onto run-meta, once, for every render', async () => {
    // Two components ⇒ two renders in one session: the environment is a
    // property of the SESSION, so it appears once regardless of the fan-out.
    const a = writeComponent('src/A.tsx');
    const b = writeComponent('src/B.tsx');
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [a, b],
      render: makePassingRender(
        {},
        {
          target: 'expo-web',
          devServer: 'reused-browse',
          tailwindShim: true,
          appManifest: 'app manifest present (v1, @validity.ai/verify-plugin-vite@0.0.1); mirrored: envDir',
        },
      ),
      spec,
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    expect(meta.components!.length).toBeGreaterThan(1);
    expect(meta.environment).toEqual({
      target: 'expo-web',
      devServer: 'reused-browse',
      tailwindShim: true,
      appManifest: 'app manifest present (v1, @validity.ai/verify-plugin-vite@0.0.1); mirrored: envDir',
    });
    // A clean session records no failure at all — absent, never an empty string
    // that a reader could mistake for "reported nothing wrong".
    expect(meta.environment).not.toHaveProperty('depScanFailure');
  });

  it('does NOT stamp the wrapper taint when fidelity is absent (unknown ≠ degraded)', async () => {
    const b = writeComponent('src/B.tsx');
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [b],
      render: makePassingRender(),
      spec,
    });
    const meta = readRunMeta(projectRoot, result.runId)!;
    for (const v of meta.criterionVerdicts!) {
      expect(v.evidenceTaints ?? []).not.toContain('wrapper');
    }
  });

  it('stamps synthetic-data provenance from unmatchedUrls WITHOUT demoting the pass', async () => {
    const b = writeComponent('src/B.tsx');
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [b],
      render: makePassingRender({ unmatchedUrls: ['GET /api/feed'] }),
      spec,
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    const hard = meta.criterionVerdicts!.find((v) => v.id === 'AC-hard')!;
    const soft = meta.criterionVerdicts!.find((v) => v.id === 'AC-soft')!;
    // The executing render consumed proxy-fabricated data → provenance stamp on
    // the hard verdict AND the soft placeholder (scored from those pixels)…
    expect(hard.evidenceTaints).toContain('synthetic-data');
    expect(soft.evidenceTaints).toContain('synthetic-data');
    // …but synthetic-data is PROVENANCE-ONLY: the mechanical pass stands.
    expect(hard.status).toBe('pass');
  });
});

describe('resolveColorSchemes', () => {
  const cfg = (colorSchemes?: Array<'light' | 'dark'>): ValidityConfig => ({
    renderMode: 'web',
    framework: 'vite',
    wrapper: './.validity/wrapper.tsx',
    ...(colorSchemes !== undefined ? { colorSchemes } : {}),
  });
  const specWithCriteria = (texts: string[]): Spec =>
    ({
      criteria: texts.map((text, i) => ({ id: `AC-${i + 1}`, text, tier: 'soft' as const })),
    }) as Spec;

  it('no config + no spec → single default-theme render (axis off)', () => {
    expect(resolveColorSchemes(cfg())).toEqual([]);
  });

  it('no config + a theme-mentioning criterion → auto both themes', () => {
    expect(resolveColorSchemes(cfg(), specWithCriteria(['Legible in light and dark']))).toEqual([
      'light',
      'dark',
    ]);
    expect(resolveColorSchemes(cfg(), specWithCriteria(['Supports dark mode toggling']))).toEqual([
      'light',
      'dark',
    ]);
  });

  it('no config + a spec with NO theme criterion → axis stays off', () => {
    expect(resolveColorSchemes(cfg(), specWithCriteria(['Shows a submit button']))).toEqual([]);
  });

  it('explicit [] forces the axis OFF even with a theme criterion', () => {
    expect(resolveColorSchemes(cfg([]), specWithCriteria(['light and dark']))).toEqual([]);
  });

  it('an explicit list forces those themes regardless of criteria', () => {
    expect(resolveColorSchemes(cfg(['dark']))).toEqual(['dark']);
    expect(resolveColorSchemes(cfg(['dark', 'light', 'dark']))).toEqual(['dark', 'light']);
  });
});

describe('componentIdFor', () => {
  it('slugifies the project-relative path (strips ext) so native + isolation ids match', () => {
    expect(componentIdFor('/proj/src/components/Button.tsx', '/proj')).toBe(
      'src-components-button',
    );
    // Falls back to the absolute path when it is not under projectRoot.
    expect(componentIdFor('/elsewhere/Foo.tsx', '/proj')).toBe('elsewhere-foo');
  });
});

describe('writeNativeRunMeta', () => {
  let projectRoot: string;
  const runId = 'run_native_meta_001';

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-native-meta-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('persists the native-labeled isolation shape (components + planId) so submit_report reads it unmodified', () => {
    mkdirSync(resolve(projectRoot, '.validity', 'runs', runId), { recursive: true });
    const components: ComponentRender[] = [
      {
        id: 'src-screen',
        filePath: 'src/Screen.tsx',
        screenshotPath: resolve(projectRoot, 'shot.png'),
        a11ySnapshot: 'Text "Hi"',
      },
      {
        id: 'src-broken',
        filePath: 'src/Broken.tsx',
        screenshotPath: resolve(projectRoot, 'broken.png'),
        renderError: 'RENDER_FAILED: not registered',
      },
    ];
    const path = writeNativeRunMeta({
      projectRoot,
      runId,
      prompt: 'verify natively',
      scenarios: [],
      components,
      componentSources: { 'src-screen': 'export const Screen = () => null;' },
      reportConfig: { enabled: true, brand: 'validity' },
      planId: 'plan_native_1',
    });
    expect(path).toContain(runId);

    const meta = readRunMeta(projectRoot, runId)!;
    // Native now labels the mode 'native' (C1) while keeping the isolation
    // payload shape (components + componentSources) submit_report reads.
    expect(meta.mode).toBe('native');
    expect(meta.planId).toBe('plan_native_1');
    expect(meta.components).toHaveLength(2);
    // The structured-status analog of 'render error:' survives the round-trip.
    expect(meta.components?.[1]?.renderError).toMatch(/^RENDER_FAILED/);
    // The native a11y tree survives as the new ComponentRender.a11ySnapshot field.
    expect(meta.components?.[0]?.a11ySnapshot).toBe('Text "Hi"');
  });
});

describe('run-meta back-compat + C1 stamps', () => {
  let projectRoot: string;
  const runId = 'run_c1_stamps_001';

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-c1-meta-'));
    mkdirSync(resolve(projectRoot, '.validity', 'runs', runId), { recursive: true });
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('writeNativeRunMeta stamps mode native + coverageFloorPercent', () => {
    writeNativeRunMeta({
      projectRoot,
      runId,
      prompt: 'verify natively',
      scenarios: [],
      components: [],
      componentSources: {},
      reportConfig: { enabled: true, brand: 'validity' },
      coverageFloorPercent: 85,
    });
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.mode).toBe('native');
    expect(meta.coverageFloorPercent).toBe(85);
  });

  it('an OLD run-meta (no mode/floor/taints/provenance fields) still parses through the submit_report read path', () => {
    // The pre-C1/A2/A3/A4 shape, byte-for-byte minimal.
    writeFileSync(
      resolve(projectRoot, '.validity', 'runs', runId, 'run-meta.json'),
      JSON.stringify({
        runId,
        createdAt: '2025-01-01T00:00:00.000Z',
        prompt: 'old run',
        scenarios: [],
        components: [{ id: 'web-a', filePath: 'src/A.tsx', screenshotPath: '/tmp/a.png' }],
        componentSources: {},
        diff: { files: [] },
        report: { enabled: true, brand: 'none' },
        criterionVerdicts: [{ id: 'AC-1', tier: 'hard', status: 'pass' }],
      }),
    );
    const meta = readRunMeta(projectRoot, runId)!;
    expect(meta.mode).toBeUndefined();
    expect(meta.coverageFloorPercent).toBeUndefined();
    expect(meta.droppedDataStates).toBeUndefined();
    expect(meta.criterionVerdicts![0]!.status).toBe('pass');
  });
});

describe('MAX_NATIVE_RENDER_TARGETS', () => {
  it('is a quarter of the web cap (one device renders serially)', () => {
    expect(MAX_NATIVE_RENDER_TARGETS).toBe(Math.floor(MAX_RENDER_PAIRS / 4));
    expect(MAX_NATIVE_RENDER_TARGETS).toBeLessThan(MAX_RENDER_PAIRS);
  });
});

describe('computeHardPropertyCoverage', () => {
  it('returns null when no hard/property criteria exist', () => {
    const counts = { pass: 0, fail: 0, unverifiable: 0 };
    expect(computeHardPropertyCoverage(counts)).toBe(null);
  });

  it('returns ratio (pass + fail) / total for hard/property', () => {
    const counts = { pass: 1, fail: 0, unverifiable: 1 };
    // 1 verifiable (1 pass + 0 fail) / 2 total = 0.5
    expect(computeHardPropertyCoverage(counts)).toBe(0.5);
  });

  it('returns 0 when all are unverifiable', () => {
    const counts = { pass: 0, fail: 0, unverifiable: 3 };
    expect(computeHardPropertyCoverage(counts)).toBe(0);
  });

  it('returns 1 when all are verifiable (pass or fail)', () => {
    const counts = { pass: 2, fail: 1, unverifiable: 0 };
    // 3 verifiable / 3 total = 1.0
    expect(computeHardPropertyCoverage(counts)).toBe(1.0);
  });
});

describe('computeCoverageFromVerdicts', () => {
  it('returns null when there are no hard/property verdicts', () => {
    expect(computeCoverageFromVerdicts([])).toBe(null);
    expect(computeCoverageFromVerdicts(undefined)).toBe(null);
    // Soft-only verdicts are excluded → still unmeasurable.
    expect(computeCoverageFromVerdicts([{ id: 'a', tier: 'soft', status: 'pass' }])).toBe(null);
  });

  it('counts only hard/property and treats pass+fail as verifiable', () => {
    const out = computeCoverageFromVerdicts([
      { id: 'a', tier: 'hard', status: 'pass' },
      { id: 'b', tier: 'property', status: 'fail' },
      { id: 'c', tier: 'hard', status: 'unverifiable' },
      // soft excluded entirely from the denominator.
      { id: 'd', tier: 'soft', status: 'pass' },
    ]);
    expect(out).toEqual({ ratio: 2 / 3, hardPropertyTotal: 3, verifiableCount: 2 });
  });

  it('returns ratio 1 when every hard/property verdict was decided', () => {
    const out = computeCoverageFromVerdicts([
      { id: 'a', tier: 'hard', status: 'pass' },
      { id: 'b', tier: 'hard', status: 'fail' },
    ]);
    expect(out).toEqual({ ratio: 1, hardPropertyTotal: 2, verifiableCount: 2 });
  });

  it('returns ratio 0 when all hard/property verdicts are unverifiable', () => {
    const out = computeCoverageFromVerdicts([
      { id: 'a', tier: 'hard', status: 'unverifiable' },
      { id: 'b', tier: 'property', status: 'unverifiable' },
    ]);
    expect(out).toEqual({ ratio: 0, hardPropertyTotal: 2, verifiableCount: 0 });
  });
});

describe('computeRegressionDeltas', () => {
  const v = (id: string, status: 'pass' | 'fail' | 'unverifiable'): CriterionVerdict => ({
    id,
    tier: 'hard',
    status,
  });

  it("flags a pass→fail change as 'regressed' with both statuses", () => {
    const out = computeRegressionDeltas([v('AC-1', 'fail')], [v('AC-1', 'pass')]);
    expect(out).toEqual([
      { criterionId: 'AC-1', previousStatus: 'pass', currentStatus: 'fail', delta: 'regressed' },
    ]);
  });

  it("flags a fail→pass change as 'improved'", () => {
    const out = computeRegressionDeltas([v('AC-1', 'pass')], [v('AC-1', 'fail')]);
    expect(out[0]).toMatchObject({
      delta: 'improved',
      previousStatus: 'fail',
      currentStatus: 'pass',
    });
  });

  it("flags an unchanged status as 'unchanged' (carrying both statuses)", () => {
    const out = computeRegressionDeltas([v('AC-1', 'pass')], [v('AC-1', 'pass')]);
    expect(out[0]).toEqual({
      criterionId: 'AC-1',
      previousStatus: 'pass',
      currentStatus: 'pass',
      delta: 'unchanged',
    });
  });

  it("flags a criterion absent in the previous run as 'new' (no previousStatus)", () => {
    const out = computeRegressionDeltas(
      [v('AC-1', 'pass'), v('AC-2', 'fail')],
      [v('AC-1', 'pass')],
    );
    const ac2 = out.find((d) => d.criterionId === 'AC-2')!;
    expect(ac2).toEqual({ criterionId: 'AC-2', currentStatus: 'fail', delta: 'new' });
    expect(ac2.previousStatus).toBeUndefined();
  });

  it("treats undefined / empty previous verdicts as all-'new' (first run)", () => {
    const cur = [v('AC-1', 'pass'), v('AC-2', 'unverifiable')];
    for (const prev of [undefined, [] as CriterionVerdict[]]) {
      const out = computeRegressionDeltas(cur, prev);
      expect(out.map((d) => d.delta)).toEqual(['new', 'new']);
      expect(out.every((d) => d.previousStatus === undefined)).toBe(true);
    }
  });

  it('walks the full lattice (pass<unverifiable<fail) in both directions', () => {
    // A check that used to decide but now can't is a regression.
    expect(computeRegressionDeltas([v('AC', 'unverifiable')], [v('AC', 'pass')])[0]!.delta).toBe(
      'regressed',
    );
    // A check that becomes decidable again is an improvement.
    expect(computeRegressionDeltas([v('AC', 'pass')], [v('AC', 'unverifiable')])[0]!.delta).toBe(
      'improved',
    );
    // unverifiable→fail is a regression; fail→unverifiable is an improvement.
    expect(computeRegressionDeltas([v('AC', 'fail')], [v('AC', 'unverifiable')])[0]!.delta).toBe(
      'regressed',
    );
    expect(computeRegressionDeltas([v('AC', 'unverifiable')], [v('AC', 'fail')])[0]!.delta).toBe(
      'improved',
    );
  });

  it('NEGATIVE: a genuine hard pass→fail can never be hidden as unchanged/improved', () => {
    // Gate-integrity: the signal must be able to FIRE. If the lattice direction
    // were inverted, this assertion would flip — so it proves a real regression
    // is reported as `regressed`, not laundered into `unchanged`/`improved`.
    const out = computeRegressionDeltas([v('AC-1', 'fail')], [v('AC-1', 'pass')]);
    expect(out[0]!.delta).toBe('regressed');
    expect(out[0]!.delta).not.toBe('unchanged');
    expect(out[0]!.delta).not.toBe('improved');
  });

  it('DISPLAY-ONLY: deltas live beside the gate — they never alter coverage or verdict status', () => {
    // Same authoritative verdict set, two different previous runs (one makes the
    // failing criterion read as `regressed`, the other as `unchanged`). The
    // coverage gate must be IDENTICAL in both cases, and the current verdicts'
    // statuses must be untouched (computeRegressionDeltas does not mutate them).
    const current: CriterionVerdict[] = [
      { id: 'AC-1', tier: 'hard', status: 'fail' },
      { id: 'AC-2', tier: 'hard', status: 'pass' },
    ];
    const coverageBefore = computeCoverageFromVerdicts(current);

    const regressed = computeRegressionDeltas(current, [
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      { id: 'AC-2', tier: 'hard', status: 'pass' },
    ]);
    const unchanged = computeRegressionDeltas(current, [
      { id: 'AC-1', tier: 'hard', status: 'fail' },
      { id: 'AC-2', tier: 'hard', status: 'pass' },
    ]);
    expect(regressed[0]!.delta).toBe('regressed');
    expect(unchanged[0]!.delta).toBe('unchanged');

    // The gate is unmoved: an `unchanged`/`improved` delta cannot launder a fail.
    expect(computeCoverageFromVerdicts(current)).toEqual(coverageBefore);
    expect(current.map((c) => c.status)).toEqual(['fail', 'pass']);
  });
});

describe('indexRunForSpec / readSpecRunHistory', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-spec-history-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // Minimal RunMeta skeleton — the timeline only reads runId/createdAt/spec*
  // provenance + criterionVerdicts/signedOff, so we omit the render payload.
  const metaFor = (over: Partial<RunMeta>): RunMeta => ({
    runId: 'run_x',
    createdAt: new Date().toISOString(),
    mode: 'isolation',
    prompt: 'demo',
    scenarios: [],
    diff: { files: [] },
    report: { enabled: false, brand: 'none' },
    ...over,
  });

  it('round-trips signedOff + the per-criterion snapshot through the timeline', () => {
    indexRunForSpec(
      projectRoot,
      metaFor({
        runId: 'run_1',
        specId: 'spec-abc',
        specVersion: 2,
        specHash: 'hash-2',
        signedOff: false,
        origin: 'ci',
        criterionVerdicts: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'property', status: 'fail' },
          // Pre-scoring verify append: the soft criterion is still a placeholder.
          { id: 'AC-3', tier: 'soft', status: 'unverifiable' },
        ],
      }),
    );

    const history = readSpecRunHistory(projectRoot, 'spec-abc');
    expect(history).toHaveLength(1);
    const [entry] = history;
    expect(entry!.runId).toBe('run_1');
    expect(entry!.signedOff).toBe(false);
    // Origin is mirrored from the run-meta onto the timeline summary.
    expect(entry!.origin).toBe('ci');
    expect(entry!.criteria).toEqual([
      { id: 'AC-1', tier: 'hard', status: 'pass' },
      { id: 'AC-2', tier: 'property', status: 'fail' },
      { id: 'AC-3', tier: 'soft', status: 'unverifiable' },
    ]);
  });

  it('preserves a soft criterion that submit_report later scored (signed off)', () => {
    // Pre-scoring verify append: soft is an `unverifiable` placeholder, not signed off.
    indexRunForSpec(
      projectRoot,
      metaFor({
        runId: 'run_a',
        specId: 'spec-soft',
        signedOff: false,
        criterionVerdicts: [{ id: 'AC-1', tier: 'soft', status: 'unverifiable' }],
      }),
    );
    // Post-scoring re-append (the submit_report path): the host folded a pass in,
    // flipping the stop signal — the timeline must capture the SCORED state.
    indexRunForSpec(
      projectRoot,
      metaFor({
        runId: 'run_a',
        specId: 'spec-soft',
        signedOff: true,
        criterionVerdicts: [{ id: 'AC-1', tier: 'soft', status: 'pass' }],
      }),
    );

    const history = readSpecRunHistory(projectRoot, 'spec-soft');
    // Append-only: both appends survive; the newest (scored) one is last.
    expect(history).toHaveLength(2);
    const latest = history.at(-1)!;
    expect(latest.signedOff).toBe(true);
    expect(latest.criteria).toEqual([{ id: 'AC-1', tier: 'soft', status: 'pass' }]);
    // And the earlier placeholder is still readable for "N iterations ago".
    expect(history[0]!.signedOff).toBe(false);
    expect(history[0]!.criteria).toEqual([{ id: 'AC-1', tier: 'soft', status: 'unverifiable' }]);
  });

  it('emits an empty criteria array (and no signedOff) for a spec run with no verdicts', () => {
    indexRunForSpec(projectRoot, metaFor({ runId: 'run_empty', specId: 'spec-empty' }));
    const [entry] = readSpecRunHistory(projectRoot, 'spec-empty');
    expect(entry!.criteria).toEqual([]);
    expect(entry!.signedOff).toBeUndefined();
    // A meta with no origin leaves the summary field absent (never defaulted).
    expect(entry!.origin).toBeUndefined();
    expect('origin' in (entry as object)).toBe(false);
  });

  it('is a no-op (and never throws) when meta carries no specId', () => {
    expect(() => indexRunForSpec(projectRoot, metaFor({ specId: undefined }))).not.toThrow();
    expect(readSpecRunHistory(projectRoot, 'spec-missing')).toEqual([]);
  });

  it('writes perf into the row, and a perf-less meta writes a row byte-compatible with the pre-feature shape', () => {
    indexRunForSpec(
      projectRoot,
      metaFor({
        runId: 'run_perf',
        specId: 'spec-perf',
        components: [perfRender({ id: 'Button', performance: { mountMs: 5.06, commitCount: 2 } })],
      }),
    );
    indexRunForSpec(projectRoot, metaFor({ runId: 'run_noperf', specId: 'spec-perf' }));

    const raw = readFileSync(
      resolve(projectRoot, '.validity', 'specs', 'spec-perf', 'runs.jsonl'),
      'utf-8',
    )
      .trim()
      .split('\n');
    expect(JSON.parse(raw[0]!).perf).toEqual({
      Button__base__base__default: { mountMs: 5.1, commitCount: 2 },
    });
    // No `perf` key at all on the perf-less row — not `perf: undefined`/`{}`.
    expect('perf' in JSON.parse(raw[1]!)).toBe(false);

    const history = readSpecRunHistory(projectRoot, 'spec-perf');
    expect(history[0]!.perf).toBeDefined();
    expect(history[1]!.perf).toBeUndefined();
  });

  it('parses pre-feature JSONL lines (no perf) mixed with new rows', () => {
    const dir = resolve(projectRoot, '.validity', 'specs', 'spec-old');
    mkdirSync(dir, { recursive: true });
    // A row written before sha/perf existed.
    writeFileSync(
      resolve(dir, 'runs.jsonl'),
      JSON.stringify({
        runId: 'run_old',
        createdAt: '2026-01-01T00:00:00.000Z',
        verdict: 'pass',
        counts: { pass: 1, fail: 0, unverifiable: 0 },
      }) + '\n',
    );
    indexRunForSpec(
      projectRoot,
      metaFor({
        runId: 'run_new',
        specId: 'spec-old',
        components: [perfRender({ id: 'Card', performance: { readyMs: 120 } })],
      }),
    );
    const history = readSpecRunHistory(projectRoot, 'spec-old');
    expect(history).toHaveLength(2);
    expect(history[0]!.runId).toBe('run_old');
    expect(history[0]!.perf).toBeUndefined();
    expect(history[1]!.perf).toEqual({ Card__base__base__default: { readyMs: 120 } });
  });

  it('historyCommitted: true also appends a committed row copied VERBATIM from the runs.jsonl summary', () => {
    indexRunForSpec(
      projectRoot,
      metaFor({
        runId: 'run_hist',
        specId: 'spec-hist',
        specVersion: 3,
        specHash: 'hash-3',
        git: { sha: 'abc1234', branch: 'main', dirty: false },
        signedOff: true,
        origin: 'local',
        components: [perfRender({ id: 'Button', performance: { mountMs: 5 } })],
        criterionVerdicts: [
          { id: 'AC-1', tier: 'hard', status: 'pass' },
          { id: 'AC-2', tier: 'soft', status: 'unverifiable' },
        ],
      }),
      { historyCommitted: true },
    );

    const local = readSpecRunHistory(projectRoot, 'spec-hist')[0]!;
    const committed = readHistoryRows(projectRoot, 'spec-hist')[0]!;
    expect(committed.v).toBe(1);
    expect(committed.specId).toBe('spec-hist');
    // Verbatim-copy invariant: the committed row can never disagree with the
    // local timeline row it mirrors.
    expect(committed.runId).toBe(local.runId);
    expect(committed.createdAt).toBe(local.createdAt);
    expect(committed.specVersion).toBe(local.specVersion);
    expect(committed.specHash).toBe(local.specHash);
    expect(committed.verdict).toBe(local.verdict);
    expect(committed.signedOff).toBe(local.signedOff);
    expect(committed.counts).toEqual(local.counts);
    expect(committed.criteria).toEqual(local.criteria);
    expect(committed.sha).toBe(local.sha);
    expect(committed.perf).toEqual(local.perf);
    expect(committed.origin).toBe(local.origin);
    expect(committed.origin).toBe('local');
    // Score is deliberately NOT stamped at index time (§9.4).
    expect(committed.score).toBeUndefined();
  });

  it('HISTORY POSTURE (§9.4): omitted/false opts write NOTHING under .validity/history/', () => {
    indexRunForSpec(projectRoot, metaFor({ runId: 'run_1', specId: 'spec-off' }));
    indexRunForSpec(projectRoot, metaFor({ runId: 'run_2', specId: 'spec-off' }), {
      historyCommitted: false,
    });
    indexRunForSpec(projectRoot, metaFor({ runId: 'run_3', specId: 'spec-off' }), {});
    expect(readSpecRunHistory(projectRoot, 'spec-off')).toHaveLength(3);
    expect(existsSync(historyDir(projectRoot))).toBe(false);
  });

  it('regression fence (§3.2): ensureValidityGitignore never ignores history/', () => {
    ensureValidityGitignore(projectRoot);
    const gi = readFileSync(resolve(projectRoot, '.validity', '.gitignore'), 'utf-8');
    // Check the ignore ENTRIES, not the explanatory comments (which mention
    // `historyCommitted` when describing the derive posture, W6 #21): no
    // gitignore PATTERN may target the committed-when-opted-in history/ dir.
    const entries = gi
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(entries.some((l) => l === 'history/' || l === '/history/' || l === 'history')).toBe(
      false,
    );
    expect(entries).toContain('history/signals.jsonl');
  });
});

describe('collectRunPerf (D1 — advisory perf timeline)', () => {
  const metaWith = (components: ComponentRender[], over: Partial<RunMeta> = {}): RunMeta => ({
    runId: 'run_perf',
    createdAt: new Date().toISOString(),
    mode: 'isolation',
    prompt: 'demo',
    scenarios: [],
    diff: { files: [] },
    report: { enabled: false, brand: 'none' },
    components,
    ...over,
  });

  it('keys renders via perfKeyFor with base fallbacks, scenario/fixture/viewport and dataState segments', () => {
    const perf = collectRunPerf(
      metaWith([
        perfRender({ id: 'Button', performance: { mountMs: 3 } }),
        perfRender({
          id: 'Button',
          scenarioId: 'admin',
          fixtureId: 'long',
          viewport: { width: 375, height: 667, name: 'mobile' },
          performance: { mountMs: 4 },
        }),
        perfRender({ id: 'Button', dataState: 'empty', performance: { mountMs: 5 } }),
      ]),
    );
    expect(Object.keys(perf!).sort()).toEqual([
      'Button__admin__long__mobile',
      'Button__base__base__default',
      'Button__base__base__default__data-empty',
    ]);
  });

  it('suffixes @native when meta.mode is native', () => {
    const perf = collectRunPerf(
      metaWith([perfRender({ id: 'Screen', performance: { readyMs: 300 } })], { mode: 'native' }),
    );
    expect(perf).toEqual({ 'Screen__base__base__default@native': { readyMs: 300 } });
  });

  it('rounds to 0.1ms and drops non-finite/negative/non-numeric values', () => {
    const perf = collectRunPerf(
      metaWith([
        perfRender({
          id: 'Button',
          performance: {
            mountMs: 5.128,
            updateMs: -2,
            readyMs: Number.NaN,
            loadMs: Number.POSITIVE_INFINITY,
            // A crafted/legacy run-meta can't inject strings into the timeline.
            firstContentfulPaintMs: '900' as unknown as number,
          },
        }),
      ]),
    );
    expect(perf).toEqual({ Button__base__base__default: { mountMs: 5.1 } });
  });

  it('skips errored renders and renders with no metrics; returns undefined when nothing survives', () => {
    expect(
      collectRunPerf(
        metaWith([
          perfRender({ id: 'Broken', renderError: 'boom', performance: { mountMs: 999 } }),
          perfRender({ id: 'Silent' }),
          perfRender({ id: 'Junk', performance: { mountMs: Number.NaN } }),
        ]),
      ),
    ).toBeUndefined();
    expect(collectRunPerf(metaWith([]))).toBeUndefined();
  });

  it('caps at MAX_PERF_KEYS_PER_RUN deterministically (sorted keys)', () => {
    const components = Array.from({ length: MAX_PERF_KEYS_PER_RUN + 5 }, (_, i) =>
      perfRender({
        id: `C${String(i).padStart(3, '0')}`,
        performance: { mountMs: i + 1 },
      }),
    );
    const perf = collectRunPerf(metaWith(components));
    const keys = Object.keys(perf!);
    expect(keys).toHaveLength(MAX_PERF_KEYS_PER_RUN);
    expect(keys).toEqual([...keys].sort());
    expect(keys[0]).toBe('C000__base__base__default');
  });
});

describe('resolveDataStates (A2)', () => {
  const cfg = (
    dataStates?: Array<'loading' | 'empty' | 'error' | 'populated'>,
  ): ValidityConfig => ({
    renderMode: 'web',
    framework: 'vite',
    wrapper: './.validity/wrapper.tsx',
    ...(dataStates !== undefined ? { dataStates } : {}),
  });
  const specWith = (over: Partial<Spec>): Spec => ({
    id: 's',
    version: 1,
    status: 'frozen',
    source: { prompt: 'p', createdBy: 'agent' },
    runtime: 'web',
    criteria: [],
    createdAt: new Date(0).toISOString(),
    ...over,
  });

  it('no config + no spec → no mandatory states (auto, nothing requested)', () => {
    expect(resolveDataStates(cfg())).toEqual([]);
  });

  it('auto: unions criterion dataStates and conditions.dataStates, deduped', () => {
    const spec = specWith({
      conditions: { dataStates: ['empty', 'error'] },
      criteria: [
        { id: 'AC-1', text: 'no results shown', tier: 'soft', dataState: 'empty' },
        { id: 'AC-2', text: 'skeleton', tier: 'soft', dataState: 'loading' },
      ],
    });
    expect(resolveDataStates(cfg(), spec).sort()).toEqual(['empty', 'error', 'loading']);
  });

  it("filters 'populated' (the base render already covers it)", () => {
    const spec = specWith({
      conditions: { dataStates: ['populated'] },
      criteria: [{ id: 'AC-1', text: 'list renders', tier: 'soft', dataState: 'populated' }],
    });
    expect(resolveDataStates(cfg(), spec)).toEqual([]);
    expect(resolveDataStates(cfg(['populated', 'empty', 'empty']))).toEqual(['empty']);
  });

  it('an explicit config list WINS over the spec (forced axis)', () => {
    const spec = specWith({
      criteria: [{ id: 'AC-1', text: 'no results shown', tier: 'soft', dataState: 'empty' }],
    });
    expect(resolveDataStates(cfg(['error']), spec)).toEqual(['error']);
  });

  it('config [] forces the axis OFF even when criteria mention states', () => {
    const spec = specWith({
      criteria: [{ id: 'AC-1', text: 'no results shown', tier: 'soft', dataState: 'empty' }],
    });
    expect(resolveDataStates(cfg([]), spec)).toEqual([]);
  });
});

describe('componentLooksDataDependent (A2)', () => {
  it('flags fetch / hooks / clients', () => {
    expect(componentLooksDataDependent("useEffect(() => { fetch('/api/items'); }, [])")).toBe(true);
    expect(componentLooksDataDependent("const { data } = useQuery(['items'], getItems)")).toBe(
      true,
    );
    expect(componentLooksDataDependent("axios.get('/api/items')")).toBe(true);
    expect(componentLooksDataDependent('const { data } = useSWR(key, fetcher)')).toBe(true);
    expect(componentLooksDataDependent('supabase.from("items").select()')).toBe(true);
  });

  it('leaves purely presentational sources alone (conservative by design)', () => {
    expect(componentLooksDataDependent('export default function Badge({ label }) {}')).toBe(false);
    // Hook-indirection miss is ACCEPTED: criteria/config-driven states are
    // unaffected; only the free extra `empty` render is skipped.
    expect(componentLooksDataDependent('const items = useItems();')).toBe(false);
  });
});

describe('prepareVerification — dataState axis (A2)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-ds-test-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const FETCHING_SOURCE = `import React, { useEffect, useState } from 'react';
export default function List() {
  const [items, setItems] = useState<string[]>([]);
  useEffect(() => {
    fetch('/api/items').then(async (r) => setItems(await r.json()));
  }, []);
  return <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;
}
`;

  function writeComponent(relPath: string, source = COMPONENT_SOURCE): string {
    const abs = resolve(projectRoot, relPath);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, source);
    return relPath;
  }

  function specWith(over: Partial<Spec>): Spec {
    return {
      id: 'spec-ds',
      version: 1,
      status: 'frozen',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      criteria: [],
      createdAt: new Date(0).toISOString(),
      ...over,
    };
  }

  it('adds ONE additive empty clone for a data-dependent component (base variant only)', async () => {
    const a = writeComponent('src/List.tsx', FETCHING_SOURCE);
    const { render, captured } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({ scenarios: { s1: {}, s2: {} } }),
      prompt: 'render the list',
      changedFiles: [a],
      scenarios: ['s1', 's2'],
      render,
    });

    // 2 scenario renders + exactly 1 additive empty clone — the clone is never
    // multiplied across scenarios/viewports/themes and carries no play.
    expect(result.pairCount).toBe(3);
    const clones = captured.components.filter((r) => r.dataState);
    expect(clones).toHaveLength(1);
    expect(clones[0]).toMatchObject({ componentId: 'src-list', dataState: 'empty' });
    expect(clones[0]!.scenarioId).toBeUndefined();
    expect(clones[0]!.fixtureId).toBeUndefined();
    expect(clones[0]!.viewport).toBeUndefined();
    expect(clones[0]!.colorScheme).toBeUndefined();
    expect(clones[0]!.play).toBeUndefined();
    expect(result.droppedDataStates).toBeUndefined();
  });

  it('does NOT add the default empty clone for a presentational component', async () => {
    const a = writeComponent('src/Widget.tsx');
    const { render, captured } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render the widget',
      changedFiles: [a],
      render,
    });

    expect(result.pairCount).toBe(1);
    expect(captured.components.every((r) => r.dataState === undefined)).toBe(true);
  });

  it('config.dataStates: [] forces the whole axis OFF (no clone for a fetching component)', async () => {
    const a = writeComponent('src/List.tsx', FETCHING_SOURCE);
    const { render, captured } = makeStubRender();

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({ dataStates: [] }),
      prompt: 'render the list',
      changedFiles: [a],
      render,
    });

    expect(result.pairCount).toBe(1);
    expect(captured.components.every((r) => r.dataState === undefined)).toBe(true);
  });

  it("binds a dataState criterion's checks to the matching clone, populated criteria to the base render", async () => {
    const a = writeComponent('src/List.tsx', FETCHING_SOURCE);
    const { render, captured } = makeStubRender();

    const spec = specWith({
      targets: { components: ['List'] },
      criteria: [
        {
          id: 'AC-pop',
          text: 'the list renders items',
          tier: 'hard',
          checks: [{ expect: { element: { role: 'list', state: 'visible' } } }],
        },
        {
          id: 'AC-empty',
          text: "shows 'No items found' when the list is empty",
          tier: 'hard',
          dataState: 'empty',
          checks: [{ expect: { element: { text: 'No items found', state: 'visible' } } }],
        },
      ],
    });

    await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [a],
      render,
      spec,
    });

    const base = captured.components.find((r) => !r.dataState);
    const clone = captured.components.find((r) => r.dataState === 'empty');
    expect(base?.criteriaChecks?.map((c) => c.id)).toEqual(['AC-pop']);
    expect(clone?.criteriaChecks?.map((c) => c.id)).toEqual(['AC-empty']);
  });

  it("CAN'T FALSE-GREEN: with the axis forced off, a dataState criterion rolls up unverifiable with the no-render detail — never pass", async () => {
    const a = writeComponent('src/List.tsx', FETCHING_SOURCE);
    const { render } = makeStubRender();

    const spec = specWith({
      targets: { components: ['List'] },
      criteria: [
        {
          id: 'AC-err',
          text: 'shows an error banner when the request fails',
          tier: 'hard',
          dataState: 'error',
          checks: [{ expect: { element: { role: 'alert', state: 'visible' } } }],
        },
      ],
    });

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({ dataStates: [] }),
      prompt: 'render',
      changedFiles: [a],
      render,
      spec,
    });

    const meta = JSON.parse(readFileSync(result.runMetaPath, 'utf-8')) as RunMeta;
    const verdict = meta.criterionVerdicts?.find((v) => v.id === 'AC-err');
    expect(verdict?.status).toBe('unverifiable');
    expect(verdict?.detail).toContain("no 'error' data-state render");
    expect(meta.signedOff).toBe(false);
  });

  it('mandatory clones count against the cap and can throw TooManyRenderPairsError', async () => {
    const comps = ['src/A.tsx', 'src/B.tsx', 'src/C.tsx'].map((p) => writeComponent(p));
    const scenarios = Object.fromEntries(
      ['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((s) => [s, {}]),
    );
    const { render } = makeStubRender();

    // 3 components × 7 scenarios = 21 renders + 3 components × 2 mandatory
    // states = 27 > 24 → loud throw, agent narrows the request.
    await expect(
      prepareVerification({
        projectRoot,
        config: makeConfig({ scenarios, dataStates: ['empty', 'error'] }),
        prompt: 'render',
        changedFiles: comps,
        scenarios: Object.keys(scenarios),
        render,
      }),
    ).rejects.toBeInstanceOf(TooManyRenderPairsError);
  });

  it('best-effort empty clones over the cap are DROPPED (loudly) instead of throwing', async () => {
    const comps = ['src/A.tsx', 'src/B.tsx', 'src/C.tsx'].map((p) =>
      writeComponent(p, FETCHING_SOURCE),
    );
    const scenarios = Object.fromEntries(
      ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map((s) => [s, {}]),
    );
    const { render, captured } = makeStubRender();

    // 3 components × 8 scenarios = 24 = exactly the cap: every auto empty
    // clone is over budget → recorded in droppedDataStates, never a throw.
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({ scenarios }),
      prompt: 'render',
      changedFiles: comps,
      scenarios: Object.keys(scenarios),
      render,
    });

    expect(result.pairCount).toBe(24);
    expect(captured.components.every((r) => r.dataState === undefined)).toBe(true);
    expect(result.droppedDataStates).toHaveLength(3);
    expect(result.droppedDataStates).toContainEqual({ componentId: 'src-a', dataState: 'empty' });
    // ...and the drop is PERSISTED (C2): submit_report's "Not validated"
    // section reads it back from run-meta, not from this in-memory result.
    const meta = JSON.parse(readFileSync(result.runMetaPath, 'utf-8'));
    expect(meta.droppedDataStates).toHaveLength(3);
    expect(meta.droppedDataStates).toContainEqual({ componentId: 'src-a', dataState: 'empty' });
  });
});

describe('prepareVerification — run-level expect.command (A5)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-run-cmd-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeComponent(relPath: string): string {
    const abs = resolve(projectRoot, relPath);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(
      abs,
      `import React from 'react';\nexport default function Widget() {\n  return <div>hi</div>;\n}\n`,
    );
    return relPath;
  }

  function makeExec(result: Partial<CommandExecResult> = {}): {
    exec: CommandExec;
    calls: string[];
  } {
    const calls: string[] = [];
    const exec: CommandExec = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, output: '', timedOut: false, durationMs: 5, ...result };
    };
    return { exec, calls };
  }

  function makeCommandSpec(criteria: Spec['criteria']): Spec {
    return {
      id: 'spec-cmd',
      version: 1,
      status: 'frozen',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      targets: { components: ['B'] },
      criteria,
      createdAt: new Date(0).toISOString(),
    };
  }

  it('excludes command criteria from render attachment and merges their run-level verdicts', async () => {
    const b = writeComponent('src/B.tsx');
    const { render, captured } = makeStubRender();
    const { exec, calls } = makeExec();

    const spec = makeCommandSpec([
      {
        id: 'AC-ui',
        text: 'submit works',
        tier: 'hard',
        checks: [{ click: { role: 'button', name: 'Go' } }],
      },
      {
        id: 'AC-cmd',
        text: 'repo typechecks',
        tier: 'property',
        checks: [{ expect: { command: { run: 'typecheck', exitCode: 0 } } }],
      },
    ]);

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({ commands: { typecheck: 'tsc --noEmit' } }),
      prompt: 'render',
      changedFiles: [b],
      render,
      spec,
      commandRunner: new CommandCheckRunner(exec),
    });

    // The command criterion is NEVER attached to any render's criteriaChecks —
    // once per RUN, not per render.
    for (const req of captured.components) {
      expect(req.criteriaChecks?.map((c) => c.id) ?? []).not.toContain('AC-cmd');
    }
    // …but the render-bound criterion still is.
    const bReq = captured.components.find((r) => r.componentId === 'src-b');
    expect(bReq?.criteriaChecks?.map((c) => c.id)).toEqual(['AC-ui']);

    // The command executed once and its merged verdict landed in run-meta with
    // the resolved-string audit stamp.
    expect(calls).toEqual(['tsc --noEmit']);
    const meta = readRunMeta(projectRoot, result.runId)!;
    const cmd = meta.criterionVerdicts!.find((v) => v.id === 'AC-cmd')!;
    expect(cmd.status).toBe('pass');
    expect(cmd.checks?.[0]?.command).toMatchObject({ resolved: 'tsc --noEmit', exitCode: 0 });
  });

  it("CAN'T-FALSE-GREEN: blocking command criterion with no `commands` config → unverifiable, signedOff false, rollup ≠ pass", async () => {
    const b = writeComponent('src/B.tsx');
    const { render } = makeStubRender();
    const { exec, calls } = makeExec();

    const spec = makeCommandSpec([
      {
        id: 'AC-cmd',
        text: 'repo typechecks',
        tier: 'property',
        checks: [{ expect: { command: { run: 'typecheck' } } }],
      },
    ]);

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(), // no `commands`
      prompt: 'render',
      changedFiles: [b],
      render,
      spec,
      commandRunner: new CommandCheckRunner(exec),
    });

    expect(calls).toEqual([]); // nothing spawned for an unconfigured name
    const meta = readRunMeta(projectRoot, result.runId)!;
    const cmd = meta.criterionVerdicts!.find((v) => v.id === 'AC-cmd')!;
    expect(cmd.status).toBe('unverifiable');
    expect(cmd.detail).toContain('not configured');
    expect(meta.verdict).not.toBe('pass');
    expect(meta.signedOff).toBe(false);
  });

  it('CAN-FAIL: a failing command fails the criterion and the run verdict', async () => {
    const b = writeComponent('src/B.tsx');
    const { render } = makeStubRender();
    const { exec } = makeExec({ exitCode: 1, output: 'error TS2322' });

    const spec = makeCommandSpec([
      {
        id: 'AC-cmd',
        text: 'repo typechecks',
        tier: 'property',
        checks: [{ expect: { command: { run: 'typecheck', exitCode: 0 } } }],
      },
    ]);

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({ commands: { typecheck: 'tsc --noEmit' } }),
      prompt: 'render',
      changedFiles: [b],
      render,
      spec,
      commandRunner: new CommandCheckRunner(exec),
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    const cmd = meta.criterionVerdicts!.find((v) => v.id === 'AC-cmd')!;
    expect(cmd.status).toBe('fail');
    expect(cmd.detail).toContain('error TS2322');
    expect(meta.verdict).toBe('fail');
    expect(meta.signedOff).toBe(false);
  });

  it('a component-less run still executes command criteria and writes run-meta', async () => {
    // No component files at all — the empty-components early return used to
    // skip commands AND the run-meta write entirely. A typecheck-only spec is
    // a legitimate CI wedge and must keep working.
    const { render, captured } = makeStubRender();
    const { exec, calls } = makeExec();

    const spec = makeCommandSpec([
      {
        id: 'AC-cmd',
        text: 'repo typechecks',
        tier: 'property',
        checks: [{ expect: { command: { run: 'typecheck', exitCode: 0 } } }],
      },
      { id: 'AC-soft', text: 'looks polished', tier: 'soft' },
    ]);

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({ commands: { typecheck: 'tsc --noEmit' } }),
      prompt: 'render',
      changedFiles: [],
      render,
      spec,
      commandRunner: new CommandCheckRunner(exec),
    });

    expect(result.pairCount).toBe(0);
    expect(captured.components).toHaveLength(0); // render never invoked with requests
    expect(calls).toEqual(['tsc --noEmit']);
    const meta = readRunMeta(projectRoot, result.runId)!;
    expect(meta.criterionVerdicts!.find((v) => v.id === 'AC-cmd')!.status).toBe('pass');
    // Render-dependent criteria stay honest placeholders — never pass.
    expect(meta.criterionVerdicts!.find((v) => v.id === 'AC-soft')!.status).toBe('unverifiable');
    expect(meta.specId).toBe('spec-cmd');
  });

  it('a component-less run with NO command criteria keeps the legacy early return (no run-meta)', async () => {
    const { render } = makeStubRender();
    const spec = makeCommandSpec([{ id: 'AC-soft', text: 'looks polished', tier: 'soft' }]);

    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(),
      prompt: 'render',
      changedFiles: [],
      render,
      spec,
    });

    expect(result.pairCount).toBe(0);
    expect(readRunMeta(projectRoot, result.runId)).toBeNull();
  });
});

describe('prepareVerification — hard checks bind to fixture variants (Bug 4)', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(resolve(tmpdir(), 'validity-run-fx-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeComponent(relPath: string): string {
    const abs = resolve(projectRoot, relPath);
    mkdirSync(resolve(abs, '..'), { recursive: true });
    writeFileSync(abs, COMPONENT_SOURCE);
    return relPath;
  }

  /** Frozen spec with one render-bound hard criterion targeting `target`. */
  function hardSpec(target: string): Spec {
    return {
      id: 'spec-fx',
      version: 1,
      status: 'frozen',
      source: { prompt: 'p', createdBy: 'agent' },
      runtime: 'web',
      targets: { components: [target] },
      criteria: [
        {
          id: 'AC-1',
          text: 'button works',
          tier: 'hard',
          checks: [{ click: { role: 'button', name: 'Go' } }],
        },
      ],
      createdAt: new Date(0).toISOString(),
    };
  }

  /**
   * Render stub that echoes each attached criterion back as a verdict whose
   * status is chosen PER REQUEST — lets a test drive the multi-variant merge in
   * `collectCriterionVerdicts`. Carries a `checks` breakdown so the test can
   * assert the merged verdict keeps the deciding render's per-check evidence.
   */
  function makeVariantVerdictRender(
    statusFor: (req: RenderRequestSpec) => 'pass' | 'fail' | 'unverifiable',
    detail = 'per-check breakdown',
  ): RenderFn {
    return async (args) => ({
      renders: args.components.map<ComponentRender>((req) => {
        const status = statusFor(req);
        return {
          id: `${req.componentId}__${req.fixtureId ?? req.stackedFixtureIds?.join('+') ?? 'base'}`,
          filePath: req.componentAbsolutePath,
          screenshotPath: `${args.screenshotsDir}/x.png`,
          fixtureId: req.fixtureId,
          stackedFixtureIds: req.stackedFixtureIds,
          scenarioId: req.scenarioId,
          dataState: req.dataState,
          criterionVerdicts: req.criteriaChecks?.map((c) => ({
            id: c.id,
            tier: c.tier,
            status,
            detail,
            checks: [{ check: c.checks![0]!, status, detail }],
          })),
        };
      }),
      environment: stubEnvironment(),
    });
  }

  const noop = async (): Promise<void> => {};

  it('binds the hard check to EVERY fixture variant when the target has no base render (per-fixture path)', async () => {
    const button = writeComponent('src/Button.tsx');
    const { render, captured } = makeStubRender();

    await prepareVerification({
      projectRoot,
      config: makeConfig({
        components: {
          [button]: {
            // Any fixture with `play` forces the per-fixture path → 3 renders,
            // none of which is a base render.
            fixtures: {
              a: { props: {}, play: noop },
              b: { props: {}, play: noop },
              c: { props: {}, play: noop },
            },
          },
        },
      }),
      prompt: 'render',
      changedFiles: [button],
      render,
      spec: hardSpec('Button'),
    });

    // The exact bug: pre-fix these bound to NOTHING (no base render), so the
    // check was unverifiable. Now every variant carries it.
    expect(captured.components).toHaveLength(3);
    expect(captured.components.every((r) => r.fixtureId)).toBe(true);
    for (const req of captured.components) {
      expect(req.criteriaChecks?.map((c) => c.id)).toEqual(['AC-1']);
    }
  });

  it('binds the hard check to the stacked-fixture render (no base render, no play)', async () => {
    const button = writeComponent('src/Button.tsx');
    const { render, captured } = makeStubRender();

    await prepareVerification({
      projectRoot,
      config: makeConfig({
        components: {
          [button]: {
            fixtures: { a: { props: {} }, b: { props: {} }, c: { props: {} } },
          },
        },
      }),
      prompt: 'render',
      changedFiles: [button],
      render,
      spec: hardSpec('Button'),
    });

    // 3 stacked fixtures → ONE render (stackedFixtureIds), still not a base
    // render, so the fallback attaches the check there.
    expect(captured.components).toHaveLength(1);
    expect(captured.components[0]!.stackedFixtureIds).toEqual(['a', 'b', 'c']);
    expect(captured.components[0]!.criteriaChecks?.map((c) => c.id)).toEqual(['AC-1']);
  });

  it('merges variant verdicts: any FAIL wins and names the failing variants (keeps the breakdown)', async () => {
    const button = writeComponent('src/Button.tsx');
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({
        components: {
          [button]: {
            fixtures: {
              a: { props: {}, play: noop },
              b: { props: {}, play: noop },
              c: { props: {}, play: noop },
            },
          },
        },
      }),
      prompt: 'render',
      changedFiles: [button],
      render: makeVariantVerdictRender((req) => (req.fixtureId === 'b' ? 'fail' : 'pass')),
      spec: hardSpec('Button'),
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    const v = meta.criterionVerdicts!.find((x) => x.id === 'AC-1')!;
    expect(v.status).toBe('fail');
    expect(v.detail).toContain('failed on 1/3 variants');
    expect(v.detail).toContain('fixture "b"');
    // The deciding render's per-check breakdown rides the merged verdict.
    expect(v.checks?.length).toBeGreaterThan(0);
  });

  it('merges variant verdicts: an unverifiable execution beats an otherwise-clean pass', async () => {
    const button = writeComponent('src/Button.tsx');
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({
        components: {
          [button]: {
            fixtures: {
              a: { props: {}, play: noop },
              b: { props: {}, play: noop },
              c: { props: {}, play: noop },
            },
          },
        },
      }),
      prompt: 'render',
      changedFiles: [button],
      render: makeVariantVerdictRender((req) => (req.fixtureId === 'c' ? 'unverifiable' : 'pass')),
      spec: hardSpec('Button'),
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    const v = meta.criterionVerdicts!.find((x) => x.id === 'AC-1')!;
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toContain('unverifiable on 1/3 variants');
    expect(v.detail).toContain('fixture "c"');
  });

  it('merges variant verdicts: all-pass reports the per-variant tally', async () => {
    const button = writeComponent('src/Button.tsx');
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig({
        components: {
          [button]: {
            fixtures: {
              a: { props: {}, play: noop },
              b: { props: {}, play: noop },
              c: { props: {}, play: noop },
            },
          },
        },
      }),
      prompt: 'render',
      changedFiles: [button],
      render: makeVariantVerdictRender(() => 'pass'),
      spec: hardSpec('Button'),
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    const v = meta.criterionVerdicts!.find((x) => x.id === 'AC-1')!;
    expect(v.status).toBe('pass');
    expect(v.detail).toContain('passed on 3/3 variants');
  });

  it('a single base render is returned VERBATIM — no variant note (base-render behavior unchanged)', async () => {
    const b = writeComponent('src/B.tsx');
    const result = await prepareVerification({
      projectRoot,
      config: makeConfig(), // no fixtures → B produces a canonical base render
      prompt: 'render',
      changedFiles: [b],
      render: makeVariantVerdictRender(() => 'pass', 'ONLY-detail'),
      spec: hardSpec('B'),
    });

    const meta = readRunMeta(projectRoot, result.runId)!;
    const v = meta.criterionVerdicts!.find((x) => x.id === 'AC-1')!;
    expect(v.status).toBe('pass');
    // Single execution → the verdict is passed through unchanged, so no
    // `passed on 1/1` decoration leaks onto the non-fixture path.
    expect(v.detail).toBe('ONLY-detail');
  });
});
