import { describe, expect, it } from 'vitest';
import { deriveDefaultScheme, discoverSchemes, isValidScheme, normalizeScheme } from './scheme.js';

describe('isValidScheme', () => {
  it('accepts the RFC 3986 scheme grammar', () => {
    for (const ok of ['myapp', 'my-app', 'my.app', 'my+app', 'a1', 'exp']) {
      expect(isValidScheme(ok), ok).toBe(true);
    }
  });

  it('rejects schemes a device would refuse to register', () => {
    for (const bad of ['', '1app', '-app', 'My App', 'my_app', 'my/app', 'MYAPP']) {
      expect(isValidScheme(bad), bad).toBe(false);
    }
  });
});

describe('normalizeScheme', () => {
  it('lowercases and slugs separators', () => {
    expect(normalizeScheme('My App')).toBe('my-app');
    expect(normalizeScheme('Acme_Store')).toBe('acme-store');
    expect(normalizeScheme('  spaced  ')).toBe('spaced');
  });

  it('keeps already-legal schemes byte-identical', () => {
    expect(normalizeScheme('myapp')).toBe('myapp');
    expect(normalizeScheme('my-app.dev')).toBe('my-app.dev');
  });

  it('repairs a leading digit rather than dropping the scheme', () => {
    // A leading digit is the one grammar violation that is mechanically
    // repairable without guessing at intent.
    expect(normalizeScheme('1password')).toBe('app-1password');
  });

  it('trims separator characters off both ends', () => {
    expect(normalizeScheme('--app--')).toBe('app');
    expect(normalizeScheme('.app.')).toBe('app');
  });

  it('returns undefined when nothing usable survives', () => {
    expect(normalizeScheme('')).toBeUndefined();
    expect(normalizeScheme('   ')).toBeUndefined();
    expect(normalizeScheme('///')).toBeUndefined();
  });
});

describe('discoverSchemes', () => {
  it('reads a string expo.scheme', () => {
    expect(discoverSchemes({ scheme: 'myapp' })).toEqual({
      fromScheme: ['myapp'],
      fromIos: [],
      fromAndroid: [],
      all: ['myapp'],
    });
  });

  it('reads an array expo.scheme in order', () => {
    const found = discoverSchemes({ scheme: ['primary', 'secondary'] });
    expect(found.fromScheme).toEqual(['primary', 'secondary']);
    expect(found.all[0]).toBe('primary');
  });

  it('reads a hand-rolled iOS CFBundleURLTypes registration', () => {
    // An app migrated from bare RN, or one that needs several URL types,
    // commonly writes this instead of expo.scheme. It DOES own a scheme.
    const found = discoverSchemes({
      ios: {
        infoPlist: {
          CFBundleURLTypes: [
            { CFBundleURLName: 'com.acme.app', CFBundleURLSchemes: ['acme', 'acme-dev'] },
          ],
        },
      },
    });
    expect(found.fromScheme).toEqual([]);
    expect(found.fromIos).toEqual(['acme', 'acme-dev']);
    expect(found.all).toEqual(['acme', 'acme-dev']);
  });

  it('reads a hand-rolled Android intent filter, with data as an object or an array', () => {
    const found = discoverSchemes({
      android: {
        intentFilters: [
          { action: 'VIEW', category: ['DEFAULT', 'BROWSABLE'], data: { scheme: 'acme' } },
          { action: 'VIEW', data: [{ scheme: 'acme-alt' }, { host: 'example.com' }] },
        ],
      },
    });
    expect(found.fromAndroid).toEqual(['acme', 'acme-alt']);
  });

  it('orders `all` expo.scheme → iOS → Android and de-duplicates', () => {
    const found = discoverSchemes({
      scheme: 'canonical',
      ios: { infoPlist: { CFBundleURLTypes: [{ CFBundleURLSchemes: ['canonical', 'ios-only'] }] } },
      android: { intentFilters: [{ data: { scheme: 'android-only' } }] },
    });
    expect(found.all).toEqual(['canonical', 'ios-only', 'android-only']);
  });

  it('contributes nothing (never throws) for malformed shapes', () => {
    // A config plugin that crashes takes `expo prebuild` down with it.
    const found = discoverSchemes({
      scheme: 42 as unknown as string,
      ios: { infoPlist: { CFBundleURLTypes: 'nonsense' as unknown as unknown[] } },
      android: { intentFilters: [null, 7, { data: 'nope' }] as unknown[] },
    });
    expect(found.all).toEqual([]);
  });

  it('handles an entirely empty config', () => {
    expect(discoverSchemes({}).all).toEqual([]);
  });
});

describe('deriveDefaultScheme', () => {
  it('prefers the slug — Expo’s own convention', () => {
    expect(deriveDefaultScheme({ slug: 'my-app', name: 'My App' })).toBe('my-app');
  });

  it('slugs the name when there is no slug', () => {
    expect(deriveDefaultScheme({ name: 'My Great App' })).toBe('my-great-app');
  });

  it('skips a slug that cannot be coerced and falls through to the name', () => {
    expect(deriveDefaultScheme({ slug: '///', name: 'Fallback App' })).toBe('fallback-app');
  });

  it('returns undefined rather than inventing a name', () => {
    // A config with neither slug nor name is not an app config we understand;
    // guessing would bake an arbitrary string into a native binary.
    expect(deriveDefaultScheme({})).toBeUndefined();
    expect(deriveDefaultScheme({ slug: '   ' })).toBeUndefined();
  });
});
