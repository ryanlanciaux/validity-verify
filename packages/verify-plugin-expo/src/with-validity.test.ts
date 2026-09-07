import { describe, expect, it } from 'vitest';
import {
  applyValidityExpoConfig,
  withValidity,
  type ValidityPluginLogger,
} from './with-validity.js';
import { VALIDITY_EXTRA_KEY, type ExpoConfigLike } from './expo-config.js';
import { PLUGIN_VERSION } from './version.js';

/** A minimal, realistic `npx create-expo-app` config. */
function fixtureConfig(over: Partial<ExpoConfigLike> = {}): ExpoConfigLike {
  return { name: 'My App', slug: 'my-app', ...over };
}

function codes(result: { notices: { code: string }[] }): string[] {
  return result.notices.map((n) => n.code);
}

function stampOf(config: ExpoConfigLike): Record<string, unknown> | undefined {
  return config.extra?.[VALIDITY_EXTRA_KEY] as Record<string, unknown> | undefined;
}

describe('applyValidityExpoConfig — scheme establishment', () => {
  it('adds a slug-derived scheme when the app declares none', () => {
    const result = applyValidityExpoConfig(fixtureConfig());
    expect(result.config.scheme).toBe('my-app');
    expect(result.scheme).toBe('my-app');
    expect(codes(result)).toContain('scheme-added');
  });

  it('keeps an existing string scheme verbatim', () => {
    // The plugin makes an app deep-linkable; it does not rename one that is.
    const result = applyValidityExpoConfig(fixtureConfig({ scheme: 'acme' }));
    expect(result.config.scheme).toBe('acme');
    expect(result.scheme).toBe('acme');
    expect(codes(result)).toEqual(['scheme-kept']);
  });

  it('keeps an existing scheme array untouched and stamps its first entry', () => {
    const result = applyValidityExpoConfig(fixtureConfig({ scheme: ['acme', 'acme-dev'] }));
    expect(result.config.scheme).toEqual(['acme', 'acme-dev']);
    expect(result.scheme).toBe('acme');
  });

  it('treats a hand-rolled iOS CFBundleURLTypes app as already having a scheme', () => {
    const config = fixtureConfig({
      ios: { infoPlist: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['acme'] }] } },
    });
    const result = applyValidityExpoConfig(config);
    // The discovered scheme is promoted into expo.scheme so prebuild registers
    // it on BOTH platforms and Linking.createURL() can see it — but the value is
    // the app's own, never an invented one.
    expect(result.config.scheme).toBe('acme');
    expect(result.scheme).toBe('acme');
    // The raw platform keys are read, never rewritten.
    expect(result.config.ios).toEqual(config.ios);
  });

  it('treats a hand-rolled Android intent filter as already having a scheme', () => {
    const config = fixtureConfig({
      android: { intentFilters: [{ action: 'VIEW', data: { scheme: 'acme' } }] },
    });
    const result = applyValidityExpoConfig(config);
    expect(result.config.scheme).toBe('acme');
    expect(result.config.android).toEqual(config.android);
  });

  it('falls back to the name when there is no slug', () => {
    const result = applyValidityExpoConfig({ name: 'My Great App' });
    expect(result.config.scheme).toBe('my-great-app');
  });

  it('warns, stamps, and adds nothing when no scheme can be established', () => {
    const result = applyValidityExpoConfig({});
    expect(result.config.scheme).toBeUndefined();
    expect(result.scheme).toBeUndefined();
    expect(codes(result)).toContain('scheme-underivable');
    // Still stamped: the readiness checklist must be able to distinguish
    // "plugin never ran" from "plugin ran and could not find a scheme".
    expect(stampOf(result.config)).toEqual({ pluginVersion: PLUGIN_VERSION });
  });
});

describe('applyValidityExpoConfig — props.scheme', () => {
  it('uses an explicit scheme on an app that declares none', () => {
    const result = applyValidityExpoConfig(fixtureConfig(), { scheme: 'chosen' });
    expect(result.config.scheme).toBe('chosen');
    expect(codes(result)).toContain('scheme-added');
  });

  it('APPENDS to existing schemes rather than replacing index 0', () => {
    // Linking.createURL() uses the first entry; replacing it would silently
    // repoint every link the app builds at runtime.
    const result = applyValidityExpoConfig(fixtureConfig({ scheme: 'acme' }), { scheme: 'extra' });
    expect(result.config.scheme).toEqual(['acme', 'extra']);
    expect(codes(result)).toContain('scheme-appended');
  });

  it('is a no-op when the explicit scheme is already registered', () => {
    const result = applyValidityExpoConfig(fixtureConfig({ scheme: ['acme', 'extra'] }), {
      scheme: 'extra',
    });
    expect(result.config.scheme).toEqual(['acme', 'extra']);
  });

  it('coerces an illegal explicit scheme and says so', () => {
    const result = applyValidityExpoConfig(fixtureConfig(), { scheme: 'My App' });
    expect(result.config.scheme).toBe('my-app');
    expect(codes(result)).toContain('scheme-normalized');
  });

  it('falls back to the app’s own scheme when the explicit one is unusable', () => {
    const result = applyValidityExpoConfig(fixtureConfig({ scheme: 'acme' }), { scheme: '///' });
    expect(result.config.scheme).toBe('acme');
    expect(codes(result)).toContain('scheme-invalid');
  });

  it('ignores a blank explicit scheme without complaining', () => {
    const result = applyValidityExpoConfig(fixtureConfig(), { scheme: '   ' });
    expect(result.config.scheme).toBe('my-app');
    expect(codes(result)).not.toContain('scheme-invalid');
  });
});

describe('applyValidityExpoConfig — companion collision guard', () => {
  it('warns when the app would answer a validity-* scheme', () => {
    // Two installed apps answering one scheme is exactly the nondeterministic
    // iOS routing the companion's unique-scheme derivation exists to avoid.
    const result = applyValidityExpoConfig(fixtureConfig(), {
      scheme: 'validity-ai-validity-playground',
    });
    expect(codes(result)).toContain('scheme-validity-branded');
  });

  it('warns for a pre-existing validity-* scheme too', () => {
    const result = applyValidityExpoConfig(fixtureConfig({ scheme: 'validity-my-app' }));
    expect(codes(result)).toContain('scheme-validity-branded');
  });

  it('stays quiet for an ordinary scheme', () => {
    const result = applyValidityExpoConfig(fixtureConfig({ scheme: 'acme' }));
    expect(codes(result)).not.toContain('scheme-validity-branded');
  });
});

describe('applyValidityExpoConfig — the extra.validity stamp', () => {
  it('stamps pluginVersion and scheme', () => {
    const result = applyValidityExpoConfig(fixtureConfig({ scheme: 'acme' }));
    expect(stampOf(result.config)).toEqual({ pluginVersion: PLUGIN_VERSION, scheme: 'acme' });
  });

  it('preserves unrelated extra keys, including EAS project ids', () => {
    const result = applyValidityExpoConfig(
      fixtureConfig({ extra: { eas: { projectId: 'abc-123' }, router: { origin: false } } }),
    );
    expect(result.config.extra?.['eas']).toEqual({ projectId: 'abc-123' });
    expect(result.config.extra?.['router']).toEqual({ origin: false });
    expect(stampOf(result.config)).toEqual({ pluginVersion: PLUGIN_VERSION, scheme: 'my-app' });
  });
});

describe('applyValidityExpoConfig — purity and idempotence', () => {
  it('never mutates the input config', () => {
    const config = fixtureConfig({ extra: { eas: { projectId: 'abc' } } });
    const snapshot = JSON.parse(JSON.stringify(config)) as ExpoConfigLike;
    applyValidityExpoConfig(config);
    expect(config).toEqual(snapshot);
  });

  it('applying twice equals applying once', () => {
    // A user can list the plugin twice, or a preset can include it alongside a
    // manual entry. The second pass must not double-register anything.
    const once = applyValidityExpoConfig(fixtureConfig()).config;
    const twice = applyValidityExpoConfig(once).config;
    expect(twice).toEqual(once);
  });

  it('applying twice with the same explicit scheme equals applying once', () => {
    const props = { scheme: 'acme' };
    const once = applyValidityExpoConfig(fixtureConfig(), props).config;
    const twice = applyValidityExpoConfig(once, props).config;
    expect(twice).toEqual(once);
  });

  it('warns — never silently — when applied twice with different explicit schemes', () => {
    const once = applyValidityExpoConfig(fixtureConfig(), { scheme: 'first' }).config;
    const second = applyValidityExpoConfig(once, { scheme: 'second' });
    expect(codes(second)).toContain('reapplied-different-scheme');
    // Both are genuinely registered; the stamp records the later one.
    expect(second.config.scheme).toEqual(['first', 'second']);
    expect(stampOf(second.config)).toEqual({ pluginVersion: PLUGIN_VERSION, scheme: 'second' });
  });

  it('is deterministic — the same input yields a byte-identical config', () => {
    const a = JSON.stringify(applyValidityExpoConfig(fixtureConfig()).config);
    const b = JSON.stringify(applyValidityExpoConfig(fixtureConfig()).config);
    expect(a).toBe(b);
  });
});

describe('withValidity', () => {
  function recordingLogger(): ValidityPluginLogger & { lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      debug: (m) => lines.push(`debug:${m}`),
      info: (m) => lines.push(`info:${m}`),
      warn: (m) => lines.push(`warn:${m}`),
    };
  }

  it('returns the transformed config', () => {
    const logger = recordingLogger();
    const config = withValidity(fixtureConfig(), undefined, logger);
    expect(config.scheme).toBe('my-app');
    expect(stampOf(config)?.['pluginVersion']).toBe(PLUGIN_VERSION);
  });

  it('routes notices to the matching logger channel', () => {
    const logger = recordingLogger();
    withValidity(fixtureConfig(), { scheme: 'My App' }, logger);
    expect(logger.lines.some((l) => l.startsWith('warn:'))).toBe(true);
  });

  it('says nothing louder than debug on the happy path', () => {
    // An Expo config is re-evaluated by start/config/prebuild/eas build. A line
    // that fires when nothing changed is a line the user stops reading.
    const logger = recordingLogger();
    withValidity(fixtureConfig({ scheme: 'acme' }), undefined, logger);
    expect(logger.lines.filter((l) => !l.startsWith('debug:'))).toEqual([]);
  });

  it('drops debug notices entirely with the default console logger', () => {
    const seen: string[] = [];
    const original = { log: console.log, warn: console.warn };
    console.log = (...args: unknown[]) => void seen.push(`log:${String(args[0])}`);
    console.warn = (...args: unknown[]) => void seen.push(`warn:${String(args[0])}`);
    try {
      withValidity(fixtureConfig({ scheme: 'acme' }));
    } finally {
      console.log = original.log;
      console.warn = original.warn;
    }
    expect(seen).toEqual([]);
  });

  it('preserves the caller’s config type (generic passthrough)', () => {
    interface TypedConfig extends ExpoConfigLike {
      owner: string;
    }
    const typed: TypedConfig = { name: 'My App', slug: 'my-app', owner: 'acme' };
    const out = withValidity(typed, undefined, recordingLogger());
    // `owner` survives the transform AND stays on the type.
    expect(out.owner).toBe('acme');
  });
});
