import { describe, expect, it, vi } from 'vitest';
import {
  validityConfigSchema,
  validityReportSchema,
  lockedTaskSchema,
  criterionSchema,
  mockNetworkConfigSchema,
  scenarioConfigSchema,
  reportConfigSchema,
  nativeConfigSchema,
  nativeRecordReplayEnabled,
  resolveReportConfig,
  componentEntrySchema,
  componentFixtureSchema,
} from './schema.js';
import { slugify, newRunId, newTaskId } from './util.js';

describe('schemas', () => {
  it('accepts a minimal config', () => {
    const result = validityConfigSchema.safeParse({
      renderMode: 'web',
      framework: 'vite',
      wrapper: './.validity/wrapper.tsx',
    });
    expect(result.success).toBe(true);
  });

  it("accepts renderMode: 'native'", () => {
    const result = validityConfigSchema.safeParse({
      renderMode: 'native',
      framework: 'expo-native',
      wrapper: './.validity/wrapper.tsx',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown renderMode', () => {
    const result = validityConfigSchema.safeParse({
      renderMode: 'ios',
      framework: 'vite',
      wrapper: './w.tsx',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a native config block + asyncStorage', () => {
    const result = validityConfigSchema.safeParse({
      renderMode: 'native',
      framework: 'expo-native',
      wrapper: './.validity/wrapper.tsx',
      native: { scheme: 'myapp', target: 'android' },
      mockNetwork: { asyncStorage: { authToken: 'mock' } },
    });
    expect(result.success).toBe(true);
  });

  it("accepts framework: 'expo-web'", () => {
    const result = validityConfigSchema.safeParse({
      renderMode: 'web',
      framework: 'expo-web',
      wrapper: './.validity/wrapper.tsx',
    });
    expect(result.success).toBe(true);
  });

  it("accepts framework: 'auto'", () => {
    const result = validityConfigSchema.safeParse({
      renderMode: 'web',
      framework: 'auto',
      wrapper: './.validity/wrapper.tsx',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown framework string', () => {
    const result = validityConfigSchema.safeParse({
      renderMode: 'web',
      framework: 'remix',
      wrapper: './.validity/wrapper.tsx',
    });
    expect(result.success).toBe(false);
  });

  it('parses a criterion', () => {
    const r = criterionSchema.safeParse({
      id: 'a',
      description: 'x',
      status: 'pass',
    });
    expect(r.success).toBe(true);
  });

  it('parses a report', () => {
    const r = validityReportSchema.safeParse({
      runId: 'run_1',
      prompt: 'p',
      criteria: [],
      components: [],
      verdict: 'pass',
      createdAt: new Date().toISOString(),
    });
    expect(r.success).toBe(true);
  });

  it('parses a locked task', () => {
    const r = lockedTaskSchema.safeParse({
      taskId: 't_1',
      prompt: 'p',
      criteria: [],
      createdAt: new Date().toISOString(),
    });
    expect(r.success).toBe(true);
  });

  describe('mockNetworkConfigSchema', () => {
    it('accepts minimal config (all optional)', () => {
      expect(mockNetworkConfigSchema.safeParse({}).success).toBe(true);
    });

    it('accepts a fully-populated config', () => {
      const r = mockNetworkConfigSchema.safeParse({
        fallback: 'permissive',
        handlers: [
          { url: '/api/me', json: { id: '1' } },
          { url: '/api/issues', method: 'GET', status: 200, json: [] },
          { url: '/api/issues', method: 'POST', status: 201, json: { id: 99 } },
          { url: '/health', text: 'ok', headers: { 'x-trace': 'a' } },
        ],
        cookies: { session: 'abc' },
        localStorage: { token: 'xyz' },
        sessionStorage: { foo: 'bar' },
      });
      expect(r.success).toBe(true);
    });

    it('rejects non-string localStorage values', () => {
      const r = mockNetworkConfigSchema.safeParse({
        localStorage: { count: 5 as unknown as string },
      });
      expect(r.success).toBe(false);
    });

    it('rejects a handler with both json and text', () => {
      const r = mockNetworkConfigSchema.safeParse({
        handlers: [{ url: '/x', json: {}, text: 'oops' }],
      });
      expect(r.success).toBe(false);
    });

    it('accepts a custom fallback response object', () => {
      const r = mockNetworkConfigSchema.safeParse({
        fallback: { status: 404, json: { error: 'not found' } },
      });
      expect(r.success).toBe(true);
    });

    it('rejects an unknown fallback string', () => {
      const r = mockNetworkConfigSchema.safeParse({
        fallback: 'hostile' as unknown as 'permissive',
      });
      expect(r.success).toBe(false);
    });
  });

  describe('scenarioConfigSchema', () => {
    it('accepts an empty scenario', () => {
      expect(scenarioConfigSchema.safeParse({}).success).toBe(true);
    });

    it('accepts description + nested mockNetwork', () => {
      const r = scenarioConfigSchema.safeParse({
        description: 'auth as user 1',
        mockNetwork: {
          cookies: { session: 'mock' },
          handlers: [{ url: '/api/me', json: { id: '1' } }],
        },
      });
      expect(r.success).toBe(true);
    });
  });

  describe('validityConfigSchema with new fields', () => {
    it('accepts a config with mockNetwork + scenarios', () => {
      const r = validityConfigSchema.safeParse({
        renderMode: 'web',
        framework: 'vite',
        wrapper: './.validity/wrapper.tsx',
        mockNetwork: {
          fallback: 'permissive',
          handlers: [{ url: '/api/health', json: { ok: true } }],
        },
        scenarios: {
          'logged-in': {
            mockNetwork: {
              cookies: { session: 'mock' },
              handlers: [{ url: '/api/me', json: { id: '1' } }],
            },
          },
          'logged-out': {
            mockNetwork: {
              handlers: [{ url: '/api/me', status: 401 }],
            },
          },
        },
      });
      expect(r.success).toBe(true);
    });

    it('keeps scenarios[].secrets through the parse, in both declaration forms', () => {
      // z.object STRIPS unknown keys, so a scenario secret that has no zod twin
      // is silently dropped at loadConfig — and a dropped secret declaration
      // means a literal gets recorded into a `.ad`. This test is the guard on
      // that: the field must SURVIVE the parse, not merely be tolerated.
      const r = validityConfigSchema.safeParse({
        renderMode: 'native',
        framework: 'expo-native',
        wrapper: './.validity/wrapper.tsx',
        scenarios: {
          'logged-in': {
            secrets: ['LOGIN_PASSWORD', { name: 'ADMIN_TOKEN', env: 'CI_ADMIN_TOKEN' }],
          },
        },
      });
      expect(r.success).toBe(true);
      expect(r.success && r.data.scenarios?.['logged-in']?.secrets).toEqual([
        'LOGIN_PASSWORD',
        { name: 'ADMIN_TOKEN', env: 'CI_ADMIN_TOKEN' },
      ]);
    });

    it('rejects a malformed secret declaration LOUDLY rather than degrading it', () => {
      // A silently-dropped secret is a literal in a recording; a hard parse
      // error is one confusing line in a terminal. The trade is not close.
      const base = {
        renderMode: 'native',
        framework: 'expo-native',
        wrapper: './.validity/wrapper.tsx',
      };
      expect(
        validityConfigSchema.safeParse({ ...base, scenarios: { s: { secrets: [{ env: 'X' }] } } })
          .success,
      ).toBe(false);
      expect(
        validityConfigSchema.safeParse({ ...base, scenarios: { s: { secrets: [''] } } }).success,
      ).toBe(false);
      expect(
        validityConfigSchema.safeParse({ ...base, scenarios: { s: { secrets: 'PW' } } }).success,
      ).toBe(false);
    });

    it('accepts coverageFloorPercent as a 0–100 integer', () => {
      const base = { renderMode: 'web', framework: 'vite', wrapper: './.validity/wrapper.tsx' };
      expect(validityConfigSchema.safeParse({ ...base, coverageFloorPercent: 0 }).success).toBe(
        true,
      );
      expect(validityConfigSchema.safeParse({ ...base, coverageFloorPercent: 80 }).success).toBe(
        true,
      );
      expect(validityConfigSchema.safeParse({ ...base, coverageFloorPercent: 100 }).success).toBe(
        true,
      );
    });

    it('treats omitted coverageFloorPercent as valid (no gate)', () => {
      const r = validityConfigSchema.safeParse({
        renderMode: 'web',
        framework: 'vite',
        wrapper: './.validity/wrapper.tsx',
      });
      expect(r.success).toBe(true);
    });

    it('rejects out-of-range or non-integer coverageFloorPercent', () => {
      const base = { renderMode: 'web', framework: 'vite', wrapper: './.validity/wrapper.tsx' };
      expect(validityConfigSchema.safeParse({ ...base, coverageFloorPercent: 101 }).success).toBe(
        false,
      );
      expect(validityConfigSchema.safeParse({ ...base, coverageFloorPercent: -1 }).success).toBe(
        false,
      );
      expect(validityConfigSchema.safeParse({ ...base, coverageFloorPercent: 80.5 }).success).toBe(
        false,
      );
      expect(
        validityConfigSchema.safeParse({ ...base, coverageFloorPercent: 'high' }).success,
      ).toBe(false);
    });
  });

  describe('foundation config knobs (Track 0)', () => {
    const base = { renderMode: 'web', framework: 'vite', wrapper: './.validity/wrapper.tsx' };

    it('accepts commands / commandTimeoutMs / dataStates / scoring / enforcement / historyCommitted', () => {
      const r = validityConfigSchema.safeParse({
        ...base,
        commands: { typecheck: 'tsc --noEmit', test: 'vitest run' },
        commandTimeoutMs: 120_000,
        dataStates: ['loading', 'empty'],
        scoring: { judge: 'fresh-context' },
        enforcement: 'strict',
        historyCommitted: true,
      });
      expect(r.success).toBe(true);
    });

    it('rejects a command name with shell metacharacters', () => {
      expect(
        validityConfigSchema.safeParse({ ...base, commands: { 'type check': 'tsc' } }).success,
      ).toBe(false);
    });

    it('rejects an out-of-range commandTimeoutMs', () => {
      expect(validityConfigSchema.safeParse({ ...base, commandTimeoutMs: 600_001 }).success).toBe(
        false,
      );
    });

    it("rejects enforcement outside {'advisory','strict'}", () => {
      expect(validityConfigSchema.safeParse({ ...base, enforcement: 'blocked' }).success).toBe(
        false,
      );
    });

    it('a11y survives loadConfig (strip-bug regression — was silently dropped)', () => {
      const r = validityConfigSchema.safeParse({ ...base, a11y: { severity: 'critical' } });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.a11y).toEqual({ severity: 'critical' });
    });

    it('scenarios.*.viewports and scenarios.*.native survive loadConfig (strip-bug regression)', () => {
      const r = validityConfigSchema.safeParse({
        ...base,
        scenarios: {
          mobile: {
            viewports: ['mobile', { width: 320, height: 640, name: 'tiny' }],
            native: { context: { auth: { isAuthenticated: true } } },
            dataState: 'empty',
          },
        },
      });
      expect(r.success).toBe(true);
      if (r.success) {
        const sc = r.data.scenarios!.mobile!;
        expect(sc.viewports).toHaveLength(2);
        expect(sc.native?.context).toEqual({ auth: { isAuthenticated: true } });
        expect(sc.dataState).toBe('empty');
      }
    });

    it('strip-bug tolerance regression: an old config with INVALID previously-ignored fields still loads (warn + drop, never throw)', () => {
      // Pre-twin, loadConfig silently stripped `a11y` and scenario
      // `viewports`/`native`/`dataState` — so a project whose config carried
      // invalid shapes there loaded fine yesterday. The new twins must not
      // turn that into a hard loadConfig failure: warn on stderr, drop the
      // field, keep the rest of the config intact.
      const writes: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });
      try {
        const r = validityConfigSchema.safeParse({
          ...base,
          a11y: { severity: 'moderate' }, // invalid enum value
          scenarios: {
            'logged-in': {
              description: 'kept',
              viewports: [{ width: 400, height: 800 }], // missing `name`
              native: 'yes', // wrong type entirely
              dataState: 'weird', // unknown data state
            },
          },
        });
        expect(r.success).toBe(true);
        if (r.success) {
          expect(r.data.a11y).toBeUndefined();
          const sc = r.data.scenarios!['logged-in']!;
          expect(sc.description).toBe('kept'); // the rest of the scenario survives
          expect(sc.viewports).toBeUndefined();
          expect(sc.native).toBeUndefined();
          expect(sc.dataState).toBeUndefined();
        }
        const warned = writes.join('');
        expect(warned).toMatch(/ignoring invalid `a11y`/);
        expect(warned).toMatch(/ignoring invalid `scenarios\.\*\.viewports`/);
        expect(warned).toMatch(/ignoring invalid `scenarios\.\*\.native`/);
        expect(warned).toMatch(/ignoring invalid `scenarios\.\*\.dataState`/);
      } finally {
        spy.mockRestore();
      }
    });

    it('strip-bug tolerance: VALID shapes still take effect (tolerance never strips good config)', () => {
      const r = validityConfigSchema.safeParse({
        ...base,
        a11y: { severity: 'serious' },
        scenarios: { mobile: { viewports: ['mobile'] } },
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.a11y).toEqual({ severity: 'serious' });
        expect(r.data.scenarios!.mobile!.viewports).toEqual(['mobile']);
      }
    });
  });

  describe('componentFixtureSchema', () => {
    it('accepts an empty fixture', () => {
      expect(componentFixtureSchema.safeParse({}).success).toBe(true);
    });

    it('accepts props + description', () => {
      const r = componentFixtureSchema.safeParse({
        description: 'Primary in loading state',
        props: { variant: 'primary', isLoading: true, children: 'Saving' },
      });
      expect(r.success).toBe(true);
    });

    it('accepts a function as play', () => {
      const r = componentFixtureSchema.safeParse({
        play: () => Promise.resolve(),
      });
      expect(r.success).toBe(true);
    });

    it('rejects a non-function play (e.g., a stringified body)', () => {
      const r = componentFixtureSchema.safeParse({
        play: 'await page.click("button")',
      });
      expect(r.success).toBe(false);
    });

    it('rejects null/undefined play (must be omitted, not falsy-set)', () => {
      // undefined is fine via optional()
      expect(componentFixtureSchema.safeParse({ play: undefined }).success).toBe(true);
      // null is invalid — Zod treats it as a present value and play must be a function.
      expect(componentFixtureSchema.safeParse({ play: null }).success).toBe(false);
    });
  });

  describe('componentEntrySchema with fixtures', () => {
    it('accepts default props alongside named fixtures', () => {
      const r = componentEntrySchema.safeParse({
        props: { children: 'Default' },
        fixtures: {
          primary: { props: { children: 'Sign in' } },
          loading: { props: { isLoading: true } },
        },
      });
      expect(r.success).toBe(true);
    });

    it('rejects fixtures with non-function play', () => {
      const r = componentEntrySchema.safeParse({
        fixtures: {
          bad: { play: 42 },
        },
      });
      expect(r.success).toBe(false);
    });
  });

  describe('scenarioConfigSchema with play', () => {
    it('accepts a play function on a scenario', () => {
      const r = scenarioConfigSchema.safeParse({
        mockNetwork: { handlers: [] },
        play: async () => {},
      });
      expect(r.success).toBe(true);
    });

    it('rejects a non-function play on a scenario', () => {
      const r = scenarioConfigSchema.safeParse({ play: { not: 'a function' } });
      expect(r.success).toBe(false);
    });
  });

  describe('reportConfigSchema + resolveReportConfig', () => {
    it('accepts the empty object', () => {
      expect(reportConfigSchema.safeParse({}).success).toBe(true);
    });

    it('accepts brand: validity / none', () => {
      expect(reportConfigSchema.safeParse({ brand: 'validity' }).success).toBe(true);
      expect(reportConfigSchema.safeParse({ brand: 'none' }).success).toBe(true);
    });

    it('rejects unknown brand', () => {
      expect(reportConfigSchema.safeParse({ brand: 'partner' }).success).toBe(false);
    });

    it('top-level config accepts boolean and object', () => {
      const ok1 = validityConfigSchema.safeParse({
        renderMode: 'web',
        framework: 'vite',
        wrapper: './w.tsx',
        report: true,
      });
      const ok2 = validityConfigSchema.safeParse({
        renderMode: 'web',
        framework: 'vite',
        wrapper: './w.tsx',
        report: { enabled: false },
      });
      expect(ok1.success).toBe(true);
      expect(ok2.success).toBe(true);
    });

    it('resolveReportConfig defaults', () => {
      expect(resolveReportConfig(undefined)).toEqual({ enabled: true, brand: 'validity' });
      expect(resolveReportConfig(true)).toEqual({ enabled: true, brand: 'validity' });
      expect(resolveReportConfig(false)).toEqual({ enabled: false, brand: 'validity' });
      expect(resolveReportConfig({})).toEqual({ enabled: true, brand: 'validity' });
      expect(resolveReportConfig({ enabled: false })).toEqual({
        enabled: false,
        brand: 'validity',
      });
      expect(resolveReportConfig({ brand: 'none' })).toEqual({ enabled: true, brand: 'none' });
    });
  });
});

describe('util', () => {
  it('slugifies', () => {
    expect(slugify('Add a logout button to the Header!')).toBe('add-a-logout-button-to-the-header');
  });

  it('generates unique-ish ids', () => {
    const a = newRunId();
    const b = newRunId();
    expect(a).not.toBe(b);
    expect(a.startsWith('run_')).toBe(true);
    expect(newTaskId().startsWith('task_')).toBe(true);
  });
});
describe('nativeConfigSchema + nativeRecordReplayEnabled', () => {
  it('accepts recordReplay as a plain optional boolean', () => {
    expect(nativeConfigSchema.safeParse({ recordReplay: false }).success).toBe(true);
    expect(nativeConfigSchema.safeParse({ recordReplay: true }).success).toBe(true);
    expect(nativeConfigSchema.safeParse({ recordReplay: 'yes' }).success).toBe(false);
  });

  it('defaults ON — unset, empty, and absent all record', () => {
    // A trust artifact that is off by default is a trust artifact nobody has,
    // and a config written before the option existed must not silently opt out.
    expect(nativeRecordReplayEnabled(undefined)).toBe(true);
    expect(nativeRecordReplayEnabled({})).toBe(true);
    expect(nativeRecordReplayEnabled({ target: 'android' })).toBe(true);
    expect(nativeRecordReplayEnabled({ recordReplay: true })).toBe(true);
  });

  it('turns off only on an explicit false', () => {
    expect(nativeRecordReplayEnabled({ recordReplay: false })).toBe(false);
  });

  it('rides through the top-level config schema', () => {
    const parsed = validityConfigSchema.safeParse({
      renderMode: 'native',
      framework: 'expo-native',
      wrapper: './w.tsx',
      native: { target: 'android', recordReplay: false },
    });
    expect(parsed.success).toBe(true);
  });

  it('carries deviceEvidence through the parse as a plain optional boolean (default off)', () => {
    // z.object STRIPS unknown keys, so an opt-in with no zod twin would parse
    // clean and then do nothing — the failure mode is a user who turned the
    // feature on and got no artifact and no error.
    expect(nativeConfigSchema.safeParse({ deviceEvidence: true }).data?.deviceEvidence).toBe(true);
    expect(nativeConfigSchema.safeParse({ deviceEvidence: false }).data?.deviceEvidence).toBe(
      false,
    );
    expect(nativeConfigSchema.safeParse({}).data?.deviceEvidence).toBeUndefined();
    expect(nativeConfigSchema.safeParse({ deviceEvidence: 'yes' }).success).toBe(false);
    const full = validityConfigSchema.safeParse({
      renderMode: 'native',
      framework: 'expo-native',
      wrapper: './w.tsx',
      native: { target: 'android', deviceEvidence: true },
    });
    expect(full.success && full.data.native?.deviceEvidence).toBe(true);
  });
});

describe('export.maestro.run — default target binding for `spec export --run`', () => {
  const base = {
    renderMode: 'native' as const,
    framework: 'expo-native' as const,
    wrapper: './.validity/wrapper.tsx',
  };

  it('SURVIVES the parse (z.object strips unknown keys — a dropped default is a silent no-op)', () => {
    const r = validityConfigSchema.safeParse({
      ...base,
      export: {
        appId: 'com.example.app',
        maestro: { enabled: true, run: { platform: 'android', device: 'emulator-5554' } },
      },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.export?.maestro?.run).toEqual({
      platform: 'android',
      device: 'emulator-5554',
    });
  });

  it('accepts each field on its own — the CI shape is a fixed platform with a per-runner device', () => {
    expect(
      validityConfigSchema.safeParse({ ...base, export: { maestro: { run: { platform: 'ios' } } } })
        .success,
    ).toBe(true);
    expect(
      validityConfigSchema.safeParse({
        ...base,
        export: { maestro: { run: { device: 'ABC-123' } } },
      }).success,
    ).toBe(true);
    expect(
      validityConfigSchema.safeParse({ ...base, export: { maestro: { run: {} } } }).success,
    ).toBe(true);
  });

  it('rejects a platform outside ios|android and an empty device, LOUDLY', () => {
    // A default that cannot bind a target is worse than no default: it would
    // fail at the device with an argv the user never typed.
    expect(
      validityConfigSchema.safeParse({ ...base, export: { maestro: { run: { platform: 'web' } } } })
        .success,
    ).toBe(false);
    expect(
      validityConfigSchema.safeParse({ ...base, export: { maestro: { run: { device: '' } } } })
        .success,
    ).toBe(false);
    expect(
      validityConfigSchema.safeParse({ ...base, export: { maestro: { run: 'android' } } }).success,
    ).toBe(false);
  });
});
