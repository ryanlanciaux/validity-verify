import type { MockNetworkConfig } from '@validity.ai/verify-spec';
import { describe, expect, it } from 'vitest';
import { combineMockNetwork, matchUrl, methodMatches, resolveResponse } from './network-matcher.js';

describe('matchUrl', () => {
  it('exact path matches when request URL has same pathname', () => {
    expect(matchUrl('/api/me', 'http://example.test/api/me')).toBe(true);
  });

  it('exact path does not match a different pathname', () => {
    expect(matchUrl('/api/me', 'http://example.test/api/you')).toBe(false);
  });

  it('exact path ignores host of the request when pattern has no protocol', () => {
    expect(matchUrl('/api/me', 'http://other.host:9999/api/me')).toBe(true);
  });

  it('exact full URL matches verbatim', () => {
    const url = 'https://example.test/api/me';
    expect(matchUrl(url, url)).toBe(true);
  });

  it('exact full URL with different host does not match', () => {
    expect(matchUrl('https://example.test/api/me', 'https://other.test/api/me')).toBe(false);
  });

  it('/api/* prefix matches a deeper path', () => {
    expect(matchUrl('/api/*', 'http://x.test/api/users/42')).toBe(true);
  });

  it('/api/* prefix matches the immediate child', () => {
    expect(matchUrl('/api/*', 'http://x.test/api/me')).toBe(true);
  });

  it('/api/* prefix does not match a sibling path', () => {
    expect(matchUrl('/api/*', 'http://x.test/notapi/me')).toBe(false);
  });

  it('arbitrary * wildcard matches in the middle', () => {
    expect(matchUrl('/api/*/me', 'http://x.test/api/v2/me')).toBe(true);
  });

  it('arbitrary * wildcard requires anchored end', () => {
    expect(matchUrl('/api/*/me', 'http://x.test/api/v2/me/extra')).toBe(false);
  });

  it('arbitrary * wildcard escapes regex metacharacters in the pattern', () => {
    // The dot in the pattern must NOT match anything else.
    expect(matchUrl('/api/v.2/*', 'http://x.test/api/v.2/me')).toBe(true);
    expect(matchUrl('/api/v.2/*', 'http://x.test/api/vX2/me')).toBe(false);
  });

  it('returns false for a non-match on plain pattern', () => {
    expect(matchUrl('/foo', 'http://x.test/bar')).toBe(false);
  });

  it('matches when request URL is a bare path (not a full URL)', () => {
    // pathOf falls back to the raw string when URL parsing throws.
    expect(matchUrl('/api/me', '/api/me')).toBe(true);
  });
});

describe('methodMatches', () => {
  it('undefined want matches any method', () => {
    expect(methodMatches(undefined, 'GET')).toBe(true);
    expect(methodMatches(undefined, 'POST')).toBe(true);
  });

  it('"*" want matches any method', () => {
    expect(methodMatches('*', 'GET')).toBe(true);
    expect(methodMatches('*', 'DELETE')).toBe(true);
  });

  it('case-insensitive match', () => {
    expect(methodMatches('get', 'GET')).toBe(true);
    expect(methodMatches('GET', 'get')).toBe(true);
    expect(methodMatches('PoSt', 'post')).toBe(true);
  });

  it('mismatch returns false', () => {
    expect(methodMatches('GET', 'POST')).toBe(false);
  });
});

describe('combineMockNetwork', () => {
  it('returns {} when both base and scenario are undefined', () => {
    expect(combineMockNetwork(undefined, undefined)).toEqual({});
  });

  it('returns base unchanged when scenario is undefined', () => {
    const base: MockNetworkConfig = { handlers: [{ url: '/x', json: {} }] };
    expect(combineMockNetwork(base, undefined)).toBe(base);
  });

  it('returns scenario unchanged when base is undefined', () => {
    const scenario: MockNetworkConfig = { cookies: { a: '1' } };
    expect(combineMockNetwork(undefined, scenario)).toBe(scenario);
  });

  it('handles empty objects on both sides', () => {
    expect(combineMockNetwork({}, {})).toEqual({
      fallback: undefined,
      handlers: [],
      cookies: {},
      localStorage: {},
      sessionStorage: {},
    });
  });

  it('concatenates handlers with scenario handlers FIRST', () => {
    const base: MockNetworkConfig = {
      handlers: [{ url: '/api/me', json: { from: 'base' } }],
    };
    const scenario: MockNetworkConfig = {
      handlers: [{ url: '/api/me', json: { from: 'scenario' } }],
    };
    expect(combineMockNetwork(base, scenario).handlers).toEqual([
      { url: '/api/me', json: { from: 'scenario' } },
      { url: '/api/me', json: { from: 'base' } },
    ]);
  });

  it('merges cookies with scenario winning on key conflict', () => {
    const base: MockNetworkConfig = { cookies: { a: 'base', b: 'base' } };
    const scenario: MockNetworkConfig = { cookies: { b: 'scenario', c: 'sc' } };
    expect(combineMockNetwork(base, scenario).cookies).toEqual({
      a: 'base',
      b: 'scenario',
      c: 'sc',
    });
  });

  it('merges localStorage with scenario winning on key conflict', () => {
    const base: MockNetworkConfig = { localStorage: { k: 'base' } };
    const scenario: MockNetworkConfig = { localStorage: { k: 'sc' } };
    expect(combineMockNetwork(base, scenario).localStorage).toEqual({ k: 'sc' });
  });

  it('merges sessionStorage with scenario winning on key conflict', () => {
    const base: MockNetworkConfig = { sessionStorage: { t: 'base' } };
    const scenario: MockNetworkConfig = { sessionStorage: { t: 'sc' } };
    expect(combineMockNetwork(base, scenario).sessionStorage).toEqual({ t: 'sc' });
  });

  it('scenario fallback wins when both define one', () => {
    const merged = combineMockNetwork({ fallback: 'permissive' }, { fallback: 'reject' });
    expect(merged.fallback).toBe('reject');
  });

  it('falls back to base fallback when scenario does not define one', () => {
    const merged = combineMockNetwork({ fallback: 'reject' }, { handlers: [] });
    expect(merged.fallback).toBe('reject');
  });
});

describe('resolveResponse', () => {
  it('returns matched=true with handler json body', () => {
    const network: MockNetworkConfig = {
      handlers: [{ url: '/api/me', json: { id: 1 } }],
    };
    const r = resolveResponse('GET', 'http://x.test/api/me', network);
    expect(r.matched).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"id":1}');
  });

  it('json sets content-type application/json', () => {
    const network: MockNetworkConfig = {
      handlers: [{ url: '/x', json: { ok: true } }],
    };
    const r = resolveResponse('GET', 'http://h/x', network);
    expect(r.headers['content-type']).toBe('application/json');
  });

  it('text sets content-type text/plain', () => {
    const network: MockNetworkConfig = {
      handlers: [{ url: '/x', text: 'hello' }],
    };
    const r = resolveResponse('GET', 'http://h/x', network);
    expect(r.body).toBe('hello');
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('preserves caller-supplied content-type', () => {
    const network: MockNetworkConfig = {
      handlers: [
        { url: '/x', json: { ok: true }, headers: { 'content-type': 'application/vnd.api+json' } },
      ],
    };
    const r = resolveResponse('GET', 'http://h/x', network);
    expect(r.headers['content-type']).toBe('application/vnd.api+json');
  });

  it('preserves caller-supplied content-type case-insensitively', () => {
    const network: MockNetworkConfig = {
      handlers: [{ url: '/x', text: 'hi', headers: { 'Content-Type': 'text/html' } }],
    };
    const r = resolveResponse('GET', 'http://h/x', network);
    expect(r.headers['Content-Type']).toBe('text/html');
    expect(r.headers['content-type']).toBeUndefined();
  });

  it('respects custom status', () => {
    const network: MockNetworkConfig = {
      handlers: [{ url: '/x', status: 401, json: { error: 'unauth' } }],
    };
    const r = resolveResponse('GET', 'http://h/x', network);
    expect(r.status).toBe(401);
  });

  it('handler with no body returns empty string', () => {
    const network: MockNetworkConfig = {
      handlers: [{ url: '/x', status: 204 }],
    };
    const r = resolveResponse('GET', 'http://h/x', network);
    expect(r.status).toBe(204);
    expect(r.body).toBe('');
  });

  it('skips handler when method does not match', () => {
    const network: MockNetworkConfig = {
      handlers: [
        { method: 'POST', url: '/x', json: { post: true } },
        { method: 'GET', url: '/x', json: { get: true } },
      ],
    };
    const r = resolveResponse('GET', 'http://h/x', network);
    expect(r.matched).toBe(true);
    expect(r.body).toBe('{"get":true}');
  });

  it('first handler match wins when multiple match', () => {
    const network: MockNetworkConfig = {
      handlers: [
        { url: '/api/*', json: { which: 'wildcard' } },
        { url: '/api/me', json: { which: 'exact' } },
      ],
    };
    const r = resolveResponse('GET', 'http://h/api/me', network);
    expect(r.body).toBe('{"which":"wildcard"}');
  });

  it('no handlers + no network: defaults to permissive (200, "{}")', () => {
    const r = resolveResponse('GET', 'http://h/x', undefined);
    expect(r.matched).toBe(false);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{}');
    expect(r.headers['content-type']).toBe('application/json');
  });

  it('no match + permissive fallback: 200 "{}"', () => {
    const r = resolveResponse('GET', 'http://h/x', { fallback: 'permissive' });
    expect(r.matched).toBe(false);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{}');
  });

  it('no match + reject fallback: 599', () => {
    const r = resolveResponse('GET', 'http://h/x', { fallback: 'reject' });
    expect(r.matched).toBe(false);
    expect(r.status).toBe(599);
  });

  it('no match + custom MockHandlerResponse fallback', () => {
    const r = resolveResponse('GET', 'http://h/x', {
      fallback: { status: 503, json: { down: true } },
    });
    expect(r.matched).toBe(false);
    expect(r.status).toBe(503);
    expect(r.body).toBe('{"down":true}');
    expect(r.headers['content-type']).toBe('application/json');
  });

  it('no match + custom text fallback', () => {
    const r = resolveResponse('GET', 'http://h/x', {
      fallback: { status: 418, text: 'teapot' },
    });
    expect(r.body).toBe('teapot');
    expect(r.status).toBe(418);
  });
});
