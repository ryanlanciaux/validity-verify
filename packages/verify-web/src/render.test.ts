import type { CriterionVerdict, MockNetworkConfig } from '@validity.ai/verify-spec';
import { describe, expect, it } from 'vitest';
import {
  buildRunEnvironment,
  foldRenderDataProvenance,
  mergeMockNetwork,
  renderIsBaselineWorthy,
  renderVariantSlug,
  runScopedPropsId,
} from './render.js';

describe('buildRunEnvironment (the session-level environment channel)', () => {
  it('records the toolchain, a cold dev server, and the Tailwind-shim fact', () => {
    expect(
      buildRunEnvironment({ target: 'web', reusedBrowseServer: false, tailwindShim: false }),
    ).toEqual({ target: 'web', devServer: 'cold', tailwindShim: false });
  });

  it('carries the app-manifest provenance line and the dep-scan abort when present', () => {
    const env = buildRunEnvironment({
      target: 'next-web',
      reusedBrowseServer: false,
      tailwindShim: true,
      appManifest: 'app manifest present (v1, @validity.ai/verify-plugin-vite@0.1.0); mirrored: envDir',
      depScanFailure: 'Could not resolve "aws-sdk" (from src/y.ts:1:0)',
    });
    expect(env).toEqual({
      target: 'next-web',
      devServer: 'cold',
      tailwindShim: true,
      appManifest: 'app manifest present (v1, @validity.ai/verify-plugin-vite@0.1.0); mirrored: envDir',
      depScanFailure: 'Could not resolve "aws-sdk" (from src/y.ts:1:0)',
    });
  });

  it('OMITS the unobservable facts on the reused-browse path — absent, never a falsy "all clear"', () => {
    const env = buildRunEnvironment({
      target: 'web',
      reusedBrowseServer: true,
      tailwindShim: false,
      appManifest: undefined,
      depScanFailure: undefined,
    });
    expect(env.devServer).toBe('reused-browse');
    expect(env).not.toHaveProperty('appManifest');
    expect(env).not.toHaveProperty('depScanFailure');
  });

  it('is one record per session — it says nothing about any individual render', () => {
    // Guard-rail for the de-smearing: the environment carries no render id,
    // component id, or screenshot, so it cannot regrow into per-element state.
    const env = buildRunEnvironment({
      target: 'expo-web',
      reusedBrowseServer: false,
      tailwindShim: true,
      depScanFailure: 'boom',
    });
    expect(Object.keys(env).sort()).toEqual([
      'depScanFailure',
      'devServer',
      'tailwindShim',
      'target',
    ]);
  });
});

describe('renderIsBaselineWorthy (baseline self-establish gate)', () => {
  const hardPass: CriterionVerdict = { id: 'AC-1', tier: 'hard', status: 'pass' };
  const hardFail: CriterionVerdict = { id: 'AC-1', tier: 'hard', status: 'fail' };
  const softFail: CriterionVerdict = { id: 'AC-2', tier: 'soft', status: 'fail' };

  it('establishes when the render is non-empty and no mechanical verdict failed', () => {
    expect(renderIsBaselineWorthy({ verdicts: [hardPass], looksEmpty: false })).toBe(true);
  });

  it('refuses an empty-looking shot (would bake a blank baseline)', () => {
    expect(renderIsBaselineWorthy({ verdicts: [hardPass], looksEmpty: true })).toBe(false);
  });

  it('refuses when a hard/property verdict FAILED (would bake a broken render)', () => {
    expect(renderIsBaselineWorthy({ verdicts: [hardFail], looksEmpty: false })).toBe(false);
  });

  it('a soft fail does NOT gate — soft is the agent’s judgment, not pixel truth', () => {
    expect(renderIsBaselineWorthy({ verdicts: [softFail], looksEmpty: false })).toBe(true);
  });

  it('establishes a purely visual render (no mechanical verdicts) when non-empty', () => {
    expect(renderIsBaselineWorthy({ verdicts: undefined, looksEmpty: false })).toBe(true);
  });
});

describe('mergeMockNetwork', () => {
  it('returns {} when both base and scenario are undefined', () => {
    expect(mergeMockNetwork(undefined, undefined)).toEqual({});
  });

  it('returns base unchanged when scenario is undefined', () => {
    const base: MockNetworkConfig = {
      fallback: 'reject',
      handlers: [{ url: '/api/me', json: { id: 'base' } }],
      cookies: { session: 'base' },
    };
    expect(mergeMockNetwork(base, undefined)).toBe(base);
  });

  it('returns scenario unchanged when base is undefined', () => {
    const scenario: MockNetworkConfig = {
      handlers: [{ url: '/api/me', json: { id: 's' } }],
      localStorage: { token: 's' },
    };
    expect(mergeMockNetwork(undefined, scenario)).toBe(scenario);
  });

  it('handles empty objects on both sides', () => {
    const merged = mergeMockNetwork({}, {});
    expect(merged).toEqual({
      fallback: undefined,
      handlers: [],
      cookies: {},
      localStorage: {},
      sessionStorage: {},
    });
  });

  it('concatenates handlers with scenario first (scenario wins on URL match)', () => {
    const base: MockNetworkConfig = {
      handlers: [
        { url: '/api/me', json: { from: 'base' } },
        { url: '/api/health', json: { ok: true } },
      ],
    };
    const scenario: MockNetworkConfig = {
      handlers: [{ url: '/api/me', json: { from: 'scenario' } }],
    };

    const merged = mergeMockNetwork(base, scenario);
    expect(merged.handlers).toEqual([
      { url: '/api/me', json: { from: 'scenario' } },
      { url: '/api/me', json: { from: 'base' } },
      { url: '/api/health', json: { ok: true } },
    ]);
  });

  it('merges cookies with scenario winning on key conflict', () => {
    const base: MockNetworkConfig = {
      cookies: { session: 'base', tracking: 'on' },
    };
    const scenario: MockNetworkConfig = {
      cookies: { session: 'scenario', extra: 'value' },
    };

    const merged = mergeMockNetwork(base, scenario);
    expect(merged.cookies).toEqual({
      tracking: 'on',
      session: 'scenario',
      extra: 'value',
    });
  });

  it('merges localStorage with scenario winning on key conflict', () => {
    const base: MockNetworkConfig = {
      localStorage: { token: 'base', theme: 'dark' },
    };
    const scenario: MockNetworkConfig = {
      localStorage: { token: 'scenario' },
    };

    const merged = mergeMockNetwork(base, scenario);
    expect(merged.localStorage).toEqual({ theme: 'dark', token: 'scenario' });
  });

  it('merges sessionStorage with scenario winning on key conflict', () => {
    const base: MockNetworkConfig = {
      sessionStorage: { tab: 'base', flag: 'a' },
    };
    const scenario: MockNetworkConfig = {
      sessionStorage: { tab: 'scenario' },
    };

    const merged = mergeMockNetwork(base, scenario);
    expect(merged.sessionStorage).toEqual({ flag: 'a', tab: 'scenario' });
  });

  it('uses scenario fallback when set, else base fallback', () => {
    const base: MockNetworkConfig = { fallback: 'permissive' };
    const scenario: MockNetworkConfig = { fallback: 'reject' };

    expect(mergeMockNetwork(base, scenario).fallback).toBe('reject');
    expect(mergeMockNetwork(base, {}).fallback).toBe('permissive');
    // Scenario sets fallback to a custom response object — wins.
    const custom: MockNetworkConfig = {
      fallback: { status: 503, json: { error: 'down' } },
    };
    expect(mergeMockNetwork(base, custom).fallback).toEqual({
      status: 503,
      json: { error: 'down' },
    });
  });

  it('falls back to base fallback when scenario does not set one', () => {
    const base: MockNetworkConfig = { fallback: 'reject' };
    const scenario: MockNetworkConfig = {
      handlers: [{ url: '/x', json: {} }],
    };
    expect(mergeMockNetwork(base, scenario).fallback).toBe('reject');
  });

  it('full merge: handlers + storage + fallback combine as expected', () => {
    const base: MockNetworkConfig = {
      fallback: 'permissive',
      handlers: [{ url: '/api/health', json: { ok: true } }],
      cookies: { session: 'base' },
      localStorage: { theme: 'dark' },
      sessionStorage: { tab: 'a' },
    };
    const scenario: MockNetworkConfig = {
      fallback: 'reject',
      handlers: [{ url: '/api/me', status: 401 }],
      cookies: { session: 'logged-in', extra: 'v' },
      localStorage: { token: 'bearer' },
      sessionStorage: { tab: 'b' },
    };

    expect(mergeMockNetwork(base, scenario)).toEqual({
      fallback: 'reject',
      handlers: [
        { url: '/api/me', status: 401 },
        { url: '/api/health', json: { ok: true } },
      ],
      cookies: { session: 'logged-in', extra: 'v' },
      localStorage: { theme: 'dark', token: 'bearer' },
      sessionStorage: { tab: 'b' },
    });
  });

  it('does not mutate the input objects', () => {
    const base: MockNetworkConfig = {
      handlers: [{ url: '/a', json: {} }],
      cookies: { session: 'base' },
    };
    const scenario: MockNetworkConfig = {
      handlers: [{ url: '/b', json: {} }],
      cookies: { session: 'scenario' },
    };
    const baseSnapshot = JSON.stringify(base);
    const scenarioSnapshot = JSON.stringify(scenario);

    mergeMockNetwork(base, scenario);

    expect(JSON.stringify(base)).toBe(baseSnapshot);
    expect(JSON.stringify(scenario)).toBe(scenarioSnapshot);
  });
});

describe('renderVariantSlug', () => {
  it('returns "base" when neither scenario nor fixture is set', () => {
    expect(renderVariantSlug(undefined, undefined)).toBe('base');
  });

  it('returns the slugified scenario when only scenario is set', () => {
    expect(renderVariantSlug('logged-in', undefined)).toBe('logged-in');
  });

  it('returns the slugified fixture when only fixture is set', () => {
    expect(renderVariantSlug(undefined, 'primary')).toBe('primary');
  });

  it('combines scenario and fixture with double-underscore when both are set', () => {
    expect(renderVariantSlug('logged-in', 'primary')).toBe('logged-in__primary');
  });

  it('slugifies non-alphanumeric characters in both segments', () => {
    // Spaces, slashes, dots, mixed case all collapse into hyphens, lowercased.
    expect(renderVariantSlug('Logged In!', 'Primary / Big')).toBe('logged-in__primary-big');
  });

  it('strips leading/trailing punctuation runs', () => {
    expect(renderVariantSlug('  spaced  ', '__edges__')).toBe('spaced__edges');
  });

  it('falls back to "base" when an input slugs to an empty string', () => {
    // Pure punctuation collapses to '' inside slugifySegment, which then
    // falls back to 'base'. Both segments fall through, so the composite
    // form yields 'base__base' — anything else would silently merge two
    // distinct (component × variant) shots into a single filename.
    expect(renderVariantSlug('!!!', '???')).toBe('base__base');
  });

  it('appends the forced data-state segment LAST (A2)', () => {
    expect(renderVariantSlug(undefined, undefined, undefined, undefined, 'empty')).toBe(
      'base__data-empty',
    );
    expect(renderVariantSlug('logged-in', undefined, 'mobile', 'dark', 'error')).toBe(
      'logged-in__mobile__dark__data-error',
    );
  });

  it('keeps existing filenames byte-identical when no dataState is forced (baseline compat)', () => {
    expect(renderVariantSlug(undefined, undefined)).toBe('base');
    expect(renderVariantSlug('logged-in', 'primary', 'mobile', 'dark')).toBe(
      'logged-in__primary__mobile__dark',
    );
  });
});

describe('runScopedPropsId (W4 #12 — per-run props namespace)', () => {
  const dirFor = (runId: string) => `/proj/.validity/runs/${runId}/screenshots`;

  it('scopes the id with the run directory that owns screenshotsDir', () => {
    expect(runScopedPropsId(dirFor('run_123'), 'src-header', 'base')).toBe(
      'run-123__src-header__base',
    );
  });

  it('two runs of the SAME component+variant get DISJOINT ids (no shared-file clobber)', () => {
    const a = runScopedPropsId(dirFor('run_aaa'), 'src-header', 'primary');
    const b = runScopedPropsId(dirFor('run_bbb'), 'src-header', 'primary');
    expect(a).not.toBe(b);
  });

  it('is stable within a run so a retried capture reuses the same file', () => {
    const dir = dirFor('run_xyz');
    expect(runScopedPropsId(dir, 'src-card', 'base')).toBe(
      runScopedPropsId(dir, 'src-card', 'base'),
    );
  });

  it('falls back to a per-dir content hash when the parent dir name is empty', () => {
    // A screenshotsDir with no usable parent segment still yields a unique,
    // deterministic token instead of collapsing every run onto one id.
    const id = runScopedPropsId('screenshots', 'src-header', 'base');
    expect(id).toMatch(/^[0-9a-f]{12}__src-header__base$/);
  });
});

describe('foldRenderDataProvenance (A2 forced-render labeling)', () => {
  it("EVERY forced clone is labeled 'dataState-forced' — even when the request-log fold saw nothing", () => {
    // A hung `loading` render can finish with no classified traffic at all;
    // the label must still land so run-meta never persists a forced render
    // that reads as a natural one.
    expect(foldRenderDataProvenance('loading', undefined)).toEqual(['dataState-forced']);
  });

  it("appends the label AFTER the request-log classification (A4's fold is preserved)", () => {
    expect(foldRenderDataProvenance('empty', ['declared-mock', 'proxy-fallback'])).toEqual([
      'declared-mock',
      'proxy-fallback',
      'dataState-forced',
    ]);
  });

  it('an unforced render passes the classification through untouched (absent stays absent)', () => {
    expect(foldRenderDataProvenance(undefined, undefined)).toBeUndefined();
    const captured = ['proxy-fallback' as const];
    expect(foldRenderDataProvenance(undefined, captured)).toBe(captured);
  });
});
