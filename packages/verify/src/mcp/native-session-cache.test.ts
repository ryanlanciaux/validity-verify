/**
 * The warm-session cache must make a back-to-back native_browse spawn ZERO
 * device probes: prepared (catalog + app) is reused while the source signature
 * holds, and the device facts (booted devices, readiness) survive across calls
 * until a failed capture or an explicit reload nukes them. These tests assert
 * the probe callbacks run ONCE and are not re-invoked on the warm second call,
 * and that invalidation forces a full re-derivation.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Catalog } from '@validity.ai/verify-spec';
import type { BootedDevice, NativeReadiness, PrepareNativeAppResult } from '@validity.ai/verify-native';
import { NativeSessionCache, computeNativeSourceSignature } from './native-session-cache.js';

const ROOT = '/proj';
const fakeBundle = (tag: string) =>
  ({
    catalog: { tag } as unknown as Catalog,
    app: { appDir: `/app/${tag}` } as unknown as PrepareNativeAppResult,
  }) as const;
const fakeDevices = (tag: string): BootedDevice[] => [{ id: `udid-${tag}`, name: tag }];
const fakeReadiness = (ready: boolean): NativeReadiness =>
  ({ ready, steps: [] }) as unknown as NativeReadiness;

describe('NativeSessionCache.prepared', () => {
  it('computes once on a miss and REUSES while the signature holds (no re-invoke)', () => {
    const cache = new NativeSessionCache();
    let calls = 0;
    const compute = () => {
      calls += 1;
      return fakeBundle('a');
    };
    const first = cache.prepared(ROOT, 'sig-1', compute);
    const second = cache.prepared(ROOT, 'sig-1', compute);
    expect(calls).toBe(1);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.value).toBe(first.value);
  });

  it('recomputes when the signature changes (a source add/remove/config edit)', () => {
    const cache = new NativeSessionCache();
    let calls = 0;
    const a = fakeBundle('a');
    const b = fakeBundle('b');
    cache.prepared(ROOT, 'sig-1', () => {
      calls += 1;
      return a;
    });
    const next = cache.prepared(ROOT, 'sig-2', () => {
      calls += 1;
      return b;
    });
    expect(calls).toBe(2);
    expect(next.reused).toBe(false);
    expect(next.value).toBe(b);
  });

  it('PRESERVES cached device facts across a pure source change', async () => {
    const cache = new NativeSessionCache();
    cache.prepared(ROOT, 'sig-1', () => fakeBundle('a'));
    let deviceProbes = 0;
    await cache.bootedDevices(ROOT, 'ios', async () => {
      deviceProbes += 1;
      return fakeDevices('phone');
    });
    // Source changed → prepared recomputes, but the booted-device probe must NOT
    // re-run (devices don't depend on source).
    cache.prepared(ROOT, 'sig-2', () => fakeBundle('b'));
    const after = await cache.bootedDevices(ROOT, 'ios', async () => {
      deviceProbes += 1;
      return fakeDevices('phone');
    });
    expect(deviceProbes).toBe(1);
    expect(after.reused).toBe(true);
  });
});

describe('NativeSessionCache device facts', () => {
  it('booted devices: probed once, reused after (no re-invoke on the warm call)', async () => {
    const cache = new NativeSessionCache();
    cache.prepared(ROOT, 'sig', () => fakeBundle('a'));
    let probes = 0;
    const probe = async () => {
      probes += 1;
      return fakeDevices('phone');
    };
    const first = await cache.bootedDevices(ROOT, 'ios', probe);
    const second = await cache.bootedDevices(ROOT, 'ios', probe);
    expect(probes).toBe(1);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
  });

  it('booted devices: a platform switch re-probes (ios/android sets are disjoint) and resets adb reverse', async () => {
    const cache = new NativeSessionCache();
    cache.prepared(ROOT, 'sig', () => fakeBundle('a'));
    let probes = 0;
    await cache.bootedDevices(ROOT, 'ios', async () => {
      probes += 1;
      return fakeDevices('iphone');
    });
    cache.markAdbReversed(ROOT, 'udid-iphone');
    // Switch ios → android: the cached iOS list must NOT be reused for android.
    const android = await cache.bootedDevices(ROOT, 'android', async () => {
      probes += 1;
      return fakeDevices('pixel');
    });
    expect(probes).toBe(2);
    expect(android.reused).toBe(false);
    expect(android.value).toEqual(fakeDevices('pixel'));
    // The switch reset the adb-reverse flag (new platform → new device ids).
    expect(cache.needsAdbReverse(ROOT, 'udid-pixel')).toBe(true);
  });

  it('readiness: reused on the same key, recomputed when the key changes (dep/expo bump)', async () => {
    const cache = new NativeSessionCache();
    cache.prepared(ROOT, 'sig', () => fakeBundle('a'));
    let probes = 0;
    const probe = (ready: boolean) => async () => {
      probes += 1;
      return fakeReadiness(ready);
    };
    await cache.readiness(ROOT, 'ios:udid:hash-1', probe(true));
    const same = await cache.readiness(ROOT, 'ios:udid:hash-1', probe(true));
    expect(probes).toBe(1);
    expect(same.reused).toBe(true);
    // A native-dep / expo-config bump flips the build hash → readiness re-probes.
    const bumped = await cache.readiness(ROOT, 'ios:udid:hash-2', probe(false));
    expect(probes).toBe(2);
    expect(bumped.reused).toBe(false);
    expect(bumped.value.ready).toBe(false);
  });

  it('adb reverse is asserted once per (project, device); markAdbReversed flips it', () => {
    const cache = new NativeSessionCache();
    cache.prepared(ROOT, 'sig', () => fakeBundle('a'));
    expect(cache.needsAdbReverse(ROOT, 'udid-phone')).toBe(true);
    cache.markAdbReversed(ROOT, 'udid-phone');
    expect(cache.needsAdbReverse(ROOT, 'udid-phone')).toBe(false);
    // A different device still needs its own reverse.
    expect(cache.needsAdbReverse(ROOT, 'udid-pad')).toBe(true);
  });
});

describe('NativeSessionCache.invalidate (failed capture / reload)', () => {
  it('nukes prepared AND device facts so the next call re-derives from scratch', async () => {
    const cache = new NativeSessionCache();
    let prepareCalls = 0;
    let deviceProbes = 0;
    const compute = () => {
      prepareCalls += 1;
      return fakeBundle('a');
    };
    const probe = async () => {
      deviceProbes += 1;
      return fakeDevices('phone');
    };
    cache.prepared(ROOT, 'sig', compute);
    await cache.bootedDevices(ROOT, 'ios', probe);
    cache.markAdbReversed(ROOT, 'udid-phone');

    // A failed capture invalidates the whole entry.
    cache.invalidate(ROOT);

    const prepared = cache.prepared(ROOT, 'sig', compute);
    const devices = await cache.bootedDevices(ROOT, 'ios', probe);
    expect(prepareCalls).toBe(2); // re-derived
    expect(deviceProbes).toBe(2); // re-probed
    expect(prepared.reused).toBe(false);
    expect(devices.reused).toBe(false);
    // adb reverse must be re-asserted after an invalidate.
    expect(cache.needsAdbReverse(ROOT, 'udid-phone')).toBe(true);
  });

  it('is scoped per project root', () => {
    const cache = new NativeSessionCache();
    let calls = 0;
    cache.prepared('/a', 'sig', () => {
      calls += 1;
      return fakeBundle('a');
    });
    cache.prepared('/b', 'sig', () => {
      calls += 1;
      return fakeBundle('b');
    });
    cache.invalidate('/a');
    const b = cache.prepared('/b', 'sig', () => {
      calls += 1;
      return fakeBundle('b');
    });
    expect(b.reused).toBe(true); // /b untouched
    expect(calls).toBe(2);
  });
});

describe('computeNativeSourceSignature', () => {
  const dirs: string[] = [];
  const make = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'sig-'));
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }));
    writeFileSync(
      join(root, 'src', 'Button.tsx'),
      'export default function Button({ label }: { label: string }) { return <button>{label}</button>; }\n',
    );
    return root;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('is stable across calls with no change', () => {
    const root = make();
    expect(computeNativeSourceSignature(root)).toBe(computeNativeSourceSignature(root));
  });

  it('changes when a source file is ADDED (registry must change)', () => {
    const root = make();
    const before = computeNativeSourceSignature(root);
    writeFileSync(
      join(root, 'src', 'Card.tsx'),
      'export default function Card() { return <div>card</div>; }\n',
    );
    expect(computeNativeSourceSignature(root)).not.toBe(before);
  });

  it('changes when a config file (package.json) is edited', () => {
    const root = make();
    const before = computeNativeSourceSignature(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { 'react-native-reanimated': '4.0.0' } }),
    );
    expect(computeNativeSourceSignature(root)).not.toBe(before);
  });

  it('folds the scheme in (an explicit scheme override re-derives)', () => {
    const root = make();
    expect(computeNativeSourceSignature(root, 'validity-a')).not.toBe(
      computeNativeSourceSignature(root, 'validity-b'),
    );
  });
});
