/**
 * The paste-ready mock-promotion stub is advisory config the agent/user copies
 * into `.validity/config.ts` to turn an unverified fallback response into a
 * declared mock. Its shape is load-bearing: the emitted fields must match
 * `mockNetworkHandlerSchema` exactly (`url`, optional `method`, one of
 * `json`/`text`), the URL must generalize the same way every run, and the body
 * must never run away. These tables pin all of that.
 */
import { describe, expect, it } from 'vitest';
import { buildHandlerStub, generalizeUrl } from './index.js';

describe('generalizeUrl', () => {
  it('collapses the origin to `*` and keeps the path', () => {
    expect(generalizeUrl('http://127.0.0.1:3001/billing/status')).toBe('*/billing/status');
    expect(generalizeUrl('https://api.example.com/user/profile')).toBe('*/user/profile');
  });

  it('collapses a query string to a trailing `*`', () => {
    expect(generalizeUrl('http://127.0.0.1:3001/search?q=foo&page=2')).toBe('*/search*');
    expect(generalizeUrl('http://x/items?since=0')).toBe('*/items*');
  });

  it('keeps the path for relative URLs (with and without a query)', () => {
    expect(generalizeUrl('/billing/status')).toBe('*/billing/status');
    expect(generalizeUrl('/search?q=foo')).toBe('*/search*');
  });

  it('normalizes a leading-slash-less relative path', () => {
    expect(generalizeUrl('api/foo')).toBe('*/api/foo');
    expect(generalizeUrl('api/foo?x=1')).toBe('*/api/foo*');
  });

  it('handles a root path', () => {
    expect(generalizeUrl('http://x/')).toBe('*/');
  });
});

describe('buildHandlerStub', () => {
  it('GET omits `method` and emits `json` from an object body', () => {
    expect(
      buildHandlerStub({ method: 'GET', url: 'http://127.0.0.1:3001/billing/status', body: {} }),
    ).toBe('{ url: "*/billing/status", json: {} }');
  });

  it('serializes an object/array body verbatim into `json`', () => {
    expect(
      buildHandlerStub({ method: 'GET', url: 'http://x/user/status', body: { status: 'ok' } }),
    ).toBe('{ url: "*/user/status", json: {"status":"ok"} }');
    expect(buildHandlerStub({ method: 'GET', url: 'http://x/items', body: [1, 2, 3] })).toBe(
      '{ url: "*/items", json: [1,2,3] }',
    );
  });

  it('a lowercase get is still GET (no `method`)', () => {
    expect(buildHandlerStub({ method: 'get', url: 'http://x/feed', body: [] })).toBe(
      '{ url: "*/feed", json: [] }',
    );
  });

  it('non-GET verbs carry an uppercased `method`', () => {
    expect(buildHandlerStub({ method: 'post', url: 'http://x/orders', body: { ok: true } })).toBe(
      '{ method: "POST", url: "*/orders", json: {"ok":true} }',
    );
    expect(buildHandlerStub({ method: 'DELETE', url: 'http://x/orders/7', body: {} })).toBe(
      '{ method: "DELETE", url: "*/orders/7", json: {} }',
    );
  });

  it('a non-JSON raw string body emits `text` (quoted)', () => {
    const feed = '<?xml version="1.0"?><rss></rss>';
    expect(buildHandlerStub({ method: 'GET', url: 'http://x/feed.xml', body: feed })).toBe(
      `{ url: "*/feed.xml", text: ${JSON.stringify(feed)} }`,
    );
  });

  it('an absent body defaults to `json: {}`', () => {
    expect(buildHandlerStub({ method: 'GET', url: 'http://x/thing' })).toBe(
      '{ url: "*/thing", json: {} }',
    );
  });

  it('carries a query string through to a trailing `*` pattern', () => {
    expect(buildHandlerStub({ method: 'GET', url: 'http://x/search?q=hi', body: [] })).toBe(
      '{ url: "*/search*", json: [] }',
    );
  });

  it('truncates an over-long body with a visible marker', () => {
    const huge = { blob: 'x'.repeat(5000) };
    const stub = buildHandlerStub({ method: 'GET', url: 'http://x/big', body: huge });
    expect(stub).toContain('…truncated');
    // Bounded: 2000 body chars + the marker + the wrapper, not the full 5000.
    expect(stub.length).toBeLessThan(2100);
  });
});
