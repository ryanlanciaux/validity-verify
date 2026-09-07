import {
  DEEP_DEFAULT_PROXY_CASES,
  FEED_URL_CASES,
  PERMISSIVE_BODY_CASES,
  POPULATED_BODY_CASES,
  type PopulatedBodyCase,
} from '@validity.ai/verify-spec/mock-heuristics-cases';
import { describe, expect, it } from 'vitest';
import {
  feedBody,
  isFeedUrl,
  makePermissiveResponseProxy,
  mockUrlPattern,
  permissiveBody,
  populatedBody,
  renderAsyncStorageSeed,
  renderNativeMockModule,
  resolveNativeMockData,
} from './network-native.js';

/**
 * Assert a populate-policy body matches the expected KIND. Shared by the native
 * (direct) and web (extracted-from-source) suites via POPULATED_BODY_CASES so
 * the two implementations cannot drift. Feed bodies are produced by feedBody;
 * everything else by populatedBody.
 */
export function assertPopulatedKind(kind: PopulatedBodyCase['kind'], body: string): void {
  if (kind === 'xml') {
    expect(body).toMatch(/^<\?xml/);
    expect(body).toContain('<item>');
    expect(body).toContain('<title>');
    return;
  }
  const v = JSON.parse(body);
  if (kind === 'array') {
    expect(Array.isArray(v)).toBe(true);
    expect(v.length).toBeGreaterThan(0);
    expect(typeof v[0]).toBe('object');
  } else if (kind === 'count') {
    expect(Array.isArray(v)).toBe(false);
    expect(typeof v.count).toBe('number');
    expect(v.count).toBeGreaterThan(0);
  } else if (kind === 'ok') {
    expect(v).toEqual({ ok: true });
  } else {
    expect(Array.isArray(v)).toBe(false);
    expect(typeof v).toBe('object');
  }
}

// mockUrlPattern is embedded VERBATIM into the generated runtime via
// .toString(), so the implementation the runtime executes IS what we test here.
describe('mockUrlPattern', () => {
  it('wildcard-prefixes a path-only pattern so it matches any host', () => {
    expect(mockUrlPattern('/api/me')).toBe('*/api/me');
  });
  it('adds the leading slash when the path lacks one', () => {
    expect(mockUrlPattern('api/me')).toBe('*/api/me');
  });
  it('passes absolute http(s) URLs through untouched', () => {
    expect(mockUrlPattern('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(mockUrlPattern('http://api.example.com/v1')).toBe('http://api.example.com/v1');
  });
});

// permissiveBody + makePermissiveResponseProxy are the native-side ports of
// web's permissive shape heuristic + deep-default Proxy. They run the SAME
// shared fixture tables the web suite runs against its own copies, so the two
// implementations cannot silently drift (the heuristic CASES are shared, the
// code is not — see @validity.ai/verify-spec/mock-heuristics-cases).
describe('permissiveBody (shared heuristics table)', () => {
  for (const c of PERMISSIVE_BODY_CASES) {
    it(`${c.method} ${c.url} → ${JSON.stringify(c.expected)} (${c.why})`, () => {
      expect(JSON.parse(permissiveBody(c.method, c.url))).toEqual(c.expected);
    });
  }
});

describe('isFeedUrl (shared cases)', () => {
  for (const c of FEED_URL_CASES) {
    it(`${c.url} → ${c.expected} (${c.why})`, () => {
      expect(isFeedUrl(c.url)).toBe(c.expected);
    });
  }
});

describe('populatedBody / feedBody (shared cases)', () => {
  for (const c of POPULATED_BODY_CASES) {
    it(`${c.method} ${c.url} → ${c.kind} (${c.why})`, () => {
      const body = c.kind === 'xml' ? feedBody(c.url) : populatedBody(c.method, c.url);
      assertPopulatedKind(c.kind, body);
    });
  }
});

describe('makePermissiveResponseProxy (shared deep-default table)', () => {
  for (const c of DEEP_DEFAULT_PROXY_CASES) {
    it(c.name, () => {
      // A fresh proxy per case so one probe can't pollute the next.
      expect(c.probe(makePermissiveResponseProxy())).toEqual(c.expected);
    });
  }

  it('does NOT bridge the context-auto-mock scenario seed (unlike the context proxy)', () => {
    // A network response body must never pull from __VALIDITY_CONTEXT_SEED__ —
    // that would leak auth/theme flags into fetched data. Set a seed and prove
    // the response proxy ignores it (returns the heuristic default, not the seed).
    const g = globalThis as unknown as { __VALIDITY_CONTEXT_SEED__?: unknown };
    const prev = g.__VALIDITY_CONTEXT_SEED__;
    g.__VALIDITY_CONTEXT_SEED__ = { isAuthenticated: true, profile: 'seeded' };
    try {
      const p = makePermissiveResponseProxy() as { isAuthenticated: unknown; profile: unknown };
      // is*-prefixed heuristic default — NOT the seed's `true`.
      expect(p.isAuthenticated).toBe(false);
      // Unknown field recurses into a child proxy — NOT the seed's 'seeded'.
      expect(p.profile).not.toBe('seeded');
      expect(typeof p.profile).toBe('function');
    } finally {
      if (prev === undefined) delete g.__VALIDITY_CONTEXT_SEED__;
      else g.__VALIDITY_CONTEXT_SEED__ = prev;
    }
  });
});

describe('resolveNativeMockData', () => {
  it('defaults to a POPULATE payload when no mockNetwork is configured', () => {
    // Populate is the system-wide default so list/feed screens render content.
    expect(resolveNativeMockData(undefined)).toEqual({ handlers: [], fallback: 'populate' });
  });
  it('passes handlers through verbatim (they are already pure JSON data)', () => {
    const handlers = [
      { url: '/api/me', json: { id: '1' } },
      { url: '/api/issues', method: 'POST' as const, status: 201, json: { ok: true } },
    ];
    expect(resolveNativeMockData({ handlers })).toEqual({ handlers, fallback: 'populate' });
  });
  it('preserves reject/populate/permissive; a custom-response fallback degrades to permissive', () => {
    expect(resolveNativeMockData({ fallback: 'reject' }).fallback).toBe('reject');
    expect(resolveNativeMockData({ fallback: 'populate' }).fallback).toBe('populate');
    // An explicit opt-out is honored.
    expect(resolveNativeMockData({ fallback: 'permissive' }).fallback).toBe('permissive');
    // A custom MockHandlerResponse fallback can't travel as the native enum
    // policy, so it degrades to permissive (crash-safe, unchanged).
    expect(resolveNativeMockData({ fallback: { json: {} } } as never).fallback).toBe('permissive');
  });
  it('stamps the dataState WIRE SEAM when provided (A2 — no runtime behavior yet)', () => {
    // 'populated' normalizes to "not forced" (mirrors the web MSW contract);
    // absent stays absent so today's payloads are byte-identical.
    expect(resolveNativeMockData(undefined, 'empty')).toEqual({
      handlers: [],
      fallback: 'populate',
      dataState: 'empty',
    });
    expect(resolveNativeMockData(undefined, 'populated')).toEqual({
      handlers: [],
      fallback: 'populate',
    });
    expect(resolveNativeMockData(undefined)).toEqual({ handlers: [], fallback: 'populate' });
  });
});

describe('renderNativeMockModule', () => {
  // The module body is now STATIC (takes no config) — the project's handlers are
  // DATA in validity-native-data.ts and are (re)applied at runtime.
  const src = renderNativeMockModule();

  it('loads msw + polyfills LAZILY and guarded (no import-time side effects — RN 0.83 core-init safety)', () => {
    // No top-level imports of msw / the polyfills (those crash RN 0.83 init).
    expect(src).not.toMatch(/^import .*msw\/native/m);
    expect(src).not.toMatch(/^import 'react-native-url-polyfill/m);
    // Everything happens inside startMockNetwork via require(), feature-detected,
    // and wrapped in try/catch so failure degrades to "no network mocking".
    expect(src).toContain("require('msw/native')");
    expect(src).toContain("typeof globalThis.URL === 'undefined'");
    expect(src).toContain('try {');
    expect(src).toContain('catch');
  });

  it('reads the baked handler/fallback DATA from validity-native-data (not baked into this code)', () => {
    expect(src).toContain(
      "import { mockNetwork as BAKED_MOCK_DATA } from './validity-native-data'",
    );
  });

  it('embeds mockUrlPattern VERBATIM so the runtime and the unit-tested impl cannot drift', () => {
    expect(src).toContain('function mockUrlPattern');
    expect(src).toContain('mockUrlPattern(h.url)');
  });

  it('exports both startMockNetwork (boot) and applyMockNetwork (host-pushed data refresh)', () => {
    expect(src).toContain('export function startMockNetwork()');
    expect(src).toContain('export function applyMockNetwork(data)');
    // applyMockNetwork re-applies via resetHandlers, keyed by the payload JSON so
    // identical re-pushes don't churn the handler stack.
    expect(src).toContain('resetHandlers(...buildHandlers(data))');
    expect(src).toContain('__appliedKey');
  });

  it('builds a permissive catch-all by default and omits it under fallback:reject', () => {
    // Runtime branch (the data is supplied at runtime, not baked): the catch-all
    // is pushed unless the applied data says fallback === 'reject'.
    expect(src).toContain("data.fallback !== 'reject'");
    expect(src).toContain("__http.all('*'");
  });

  it('the permissive catch-all returns a SHAPE-HEURISTIC body (not bare {}) and tags it for the json proxy', () => {
    // Regression: the catch-all used to answer every un-mocked request with a
    // bare 200 {} — a native screen mapping a list endpoint then crashed where
    // web survived. Now it embeds permissiveBody + tags the response so the
    // shimmed json() returns the deep-default proxy.
    expect(src).toContain('function permissiveBody');
    expect(src).toContain('permissiveBody(method, url)');
    expect(src).toContain("'x-validity-permissive': '1'");
    // The old bare-{} catch-all must be gone.
    expect(src).not.toContain('__HttpResponse.json({}, { status: 200 })');
  });

  it('embeds the populate functions and a SAFE populate catch-all (default; lists/feeds only)', () => {
    // POPULATE is the default (the catch-all runs it unless fallback is
    // explicitly 'permissive'). It returns real data ONLY for feeds (RSS) and
    // list-ish URLs (a populated array, detected via the leading '['); every
    // other un-mocked request falls through to the tagged crash-safe permissive
    // body, preserving the no-throw guarantee for singular/object endpoints.
    expect(src).toContain('function isFeedUrl');
    expect(src).toContain('function feedBody');
    expect(src).toContain('function populatedBody');
    // Default = populate (anything but an explicit 'permissive' opt-out).
    expect(src).toContain("data.fallback !== 'permissive'");
    expect(src).toContain('isFeedUrl(url)');
    expect(src).toContain('feedBody(url)');
    expect(src).toContain('populatedBody(method, url)');
    // List detection (real array) vs. the crash-safe permissive fallthrough.
    expect(src).toContain("pb.charAt(0) === '['");
    expect(src).toContain("'x-validity-permissive': '1'");
  });

  it('embeds the deep-default response proxy and shims Response.prototype.json to use it', () => {
    expect(src).toContain('function makePermissiveResponseProxy');
    expect(src).toContain('function shimResponseJson');
    expect(src).toContain('shimResponseJson()');
    // The shim returns the proxy ONLY for the tagged permissive responses.
    expect(src).toContain("this.headers.get('x-validity-permissive') === '1'");
    expect(src).toContain('return makePermissiveResponseProxy()');
    // Idempotent guard so repeated start/HMR runs don't stack patches.
    expect(src).toContain('__validityJsonPatched');
  });

  it('tracks un-mocked URLs and exposes getUnmatchedUrls()/resetUnmatched() for the rendered ack', () => {
    expect(src).toContain('trackUnmatched(method + ');
    expect(src).toContain('export function getUnmatchedUrls()');
    expect(src).toContain('export function resetUnmatched()');
    // Capped so a polling screen can't grow the list unbounded across a session.
    expect(src).toContain('__UNMATCHED_CAP');
  });

  it('tracks OBSERVED responses and exposes getMatchedRequests()/resetMatched() for expect.network', () => {
    // Mirrors the unmatched tracker: a configured handler AND the permissive
    // catch-all record { method, url, status } so the host can evaluate
    // expect.network on device.
    expect(src).toContain('function trackMatched(method, url, status, provenance, handlerUrl)');
    expect(src).toContain('export function getMatchedRequests()');
    expect(src).toContain('export function resetMatched()');
    // Capped like the unmatched tracker.
    expect(src).toContain('__MATCHED_CAP');
    // Recorded from BOTH the configured handler and the permissive catch-all.
    expect(src).toContain(
      "trackMatched(req.method || h.method || 'GET', req.url || h.url, status, 'declared', h.url)",
    );
    expect(src).toContain("trackMatched(method, url, 200, 'fabricated')");
    // The matched entry carries a numeric status (the executor tests it against
    // the criterion's StatusMatcher).
    expect(src).toContain("status: typeof status === 'number' ? status : 0");
  });

  it('stamps network provenance (A4): declared + handler pattern on handler hits, fabricated on the catch-all, garbage dropped', () => {
    // The handler branch records positive declared evidence with the config
    // pattern; the catch-all branch records fabricated. trackMatched WHITELISTS
    // the provenance value so a garbage call can never masquerade as declared.
    expect(src).toContain(
      "if (provenance === 'declared' || provenance === 'fabricated') entry.provenance = provenance;",
    );
    expect(src).toContain("if (typeof handlerUrl === 'string') entry.handlerUrl = handlerUrl;");
  });

  it('gates listen() on __DEV__', () => {
    expect(src).toContain('__DEV__');
  });

  it('exposes getMockStatus(), set active on success and disabled+reason on the degrade path', () => {
    // The host reads this in the bridge hello so a native verify never scores
    // real-network data against fixture criteria unknowingly.
    expect(src).toContain('export function getMockStatus()');
    // Success: msw is intercepting.
    expect(src).toContain('__mockStatus = { active: true');
    // Degrade (catch): record WHY, not just a silent console.warn.
    expect(src).toContain(
      '__mockStatus = { active: false, reason: (err && err.message) || String(err) }',
    );
    // Production bundle: mocking intentionally off, reported (not a failure).
    expect(src).toContain('production build');
    // Returns a fresh object so callers can't mutate module state.
    expect(src).toContain('return { active: __mockStatus.active, reason: __mockStatus.reason }');
  });

  it('never emits a sparse handlers array (built with push(), never a joined literal)', () => {
    // A `,`-prefixed join produced `[\n,\n http.all(...)]` — a hole that makes
    // setupServer throw "Expected a request handler". buildHandlers starts the
    // array empty and pushes, so an empty handler list can't produce a hole.
    expect(src).toContain('const handlers = [];');
    expect(src).not.toMatch(/\[\s*,/);
  });

  it('exempts the control-bridge origin from interception so the GET /data boot fetch survives', () => {
    // Without this, the permissive catch-all would answer the device's boot
    // fetch with 200 {} and the host's fresh data would never load.
    expect(src).toContain('export function setBridgePassthrough(origin)');
    // The passthrough handler is pushed FIRST (first match wins) for the bridge
    // origin, ahead of the permissive catch-all.
    expect(src).toContain('__http.all(__bridgeOrigin + ');
    expect(src).toContain('__passthrough()');
    expect(src).toContain("const { http, HttpResponse, passthrough } = require('msw')");
  });
});

describe('renderAsyncStorageSeed', () => {
  // Also STATIC now: the seed pairs are DATA passed to seedAsyncStorage(seed).
  const src = renderAsyncStorageSeed();

  it('exports a seedAsyncStorage(seed) that multiSets the given pairs', () => {
    expect(src).toContain('export async function seedAsyncStorage(seed: Array<[string, string]>)');
    expect(src).toContain('multiSet');
    expect(src).toContain('AsyncStorage');
  });

  it('is a no-op for an empty seed and filters non-string pairs (no baked data)', () => {
    expect(src).toContain('pairs.length === 0');
    // Defensive filter so a malformed pair can't crash the seed.
    expect(src).toContain('typeof p[0]');
  });
});
