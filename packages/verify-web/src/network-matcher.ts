/**
 * Pure, framework-agnostic network matcher used by URL mode (Node side,
 * via Playwright's `page.route`) and conceptually mirrored by the
 * in-browser entry.tsx interceptor for isolation mode. Returns a plain
 * object so the caller can build a Response, fulfill a Playwright route,
 * or write a test assertion against it.
 *
 * Note: the isolation-mode interceptor in `prepare.ts` currently embeds
 * its own copy of these functions inside the entry.tsx string template
 * (it has to — that code runs in the browser sandbox). Keep the two
 * implementations behaviorally identical; if you change one, change the
 * other or extract a shared module that's emitted into the browser bundle.
 */
import type { MockNetworkConfig, MockNetworkHandler } from '@validity.ai/verify-spec';

export interface ResolvedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** True when a configured handler matched. False when the fallback fired. */
  matched: boolean;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function matchUrl(pattern: string, requestUrl: string): boolean {
  const requestSide = /^https?:\/\//.test(pattern) ? requestUrl : pathOf(requestUrl);
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1);
    return requestSide.startsWith(prefix);
  }
  if (pattern.includes('*')) {
    // Escape regex metacharacters EXCEPT `*` (which we then convert to `.*`).
    const re = new RegExp(
      '^' + pattern.replace(/[.+?^$(){}|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    );
    return re.test(requestSide);
  }
  return requestSide === pattern;
}

export function methodMatches(want: string | undefined, actual: string): boolean {
  if (!want || want === '*') return true;
  return want.toUpperCase() === actual.toUpperCase();
}

function bodyAndContentType(
  handler: { json?: unknown; text?: string },
  existingHeaders: Record<string, string>,
): { body: string; contentType?: string } {
  const hasContentType = Object.keys(existingHeaders).some(
    (k) => k.toLowerCase() === 'content-type',
  );
  if (handler.json !== undefined) {
    return {
      body: JSON.stringify(handler.json),
      contentType: hasContentType ? undefined : 'application/json',
    };
  }
  if (handler.text !== undefined) {
    return {
      body: handler.text,
      contentType: hasContentType ? undefined : 'text/plain; charset=utf-8',
    };
  }
  return { body: '' };
}

function buildResponse(handler: {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
}): Omit<ResolvedResponse, 'matched'> {
  const headers = { ...(handler.headers ?? {}) };
  const status = handler.status ?? 200;
  const { body, contentType } = bodyAndContentType(handler, headers);
  if (contentType) headers['content-type'] = contentType;
  return { status, headers, body };
}

function fallbackResponse(
  fallback: NonNullable<MockNetworkConfig['fallback']>,
): Omit<ResolvedResponse, 'matched'> {
  if (fallback === 'permissive' || fallback === 'populate') {
    // 'populate' (synthetic POPULATED bodies) is an isolation-sandbox-only
    // policy — it lives in the MSW template's catch-all. URL-mode matching has
    // no body synthesizer here, so it degrades to the permissive empty {}.
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    };
  }
  if (fallback === 'reject') {
    return {
      status: 599,
      headers: {},
      body: 'Validity: no handler matched',
    };
  }
  return buildResponse(fallback);
}

/**
 * Merge a scenario's mockNetwork on top of the base config. Mirrors the
 * implementation in `render.ts` (kept here so this module is self-contained
 * for tests and direct use from URL mode).
 *   - cookies / localStorage / sessionStorage merge by key (scenario wins)
 *   - handlers concatenate with the scenario's first (so it wins on URL match)
 *   - fallback replaces base's fallback when the scenario sets one
 */
export function combineMockNetwork(
  base: MockNetworkConfig | undefined,
  scenario: MockNetworkConfig | undefined,
): MockNetworkConfig {
  if (!base && !scenario) return {};
  if (!scenario) return base!;
  if (!base) return scenario;
  return {
    fallback: scenario.fallback ?? base.fallback,
    handlers: [...(scenario.handlers ?? []), ...(base.handlers ?? [])],
    cookies: { ...(base.cookies ?? {}), ...(scenario.cookies ?? {}) },
    localStorage: { ...(base.localStorage ?? {}), ...(scenario.localStorage ?? {}) },
    sessionStorage: { ...(base.sessionStorage ?? {}), ...(scenario.sessionStorage ?? {}) },
  };
}

/**
 * Resolve a request against a mockNetwork configuration. Returns a plain
 * shape the caller can fulfill via Playwright's `route.fulfill`, build a
 * Response from, or assert against in tests.
 */
export function resolveResponse(
  method: string,
  url: string,
  network: MockNetworkConfig | undefined,
): ResolvedResponse {
  const handlers: MockNetworkHandler[] = network?.handlers ?? [];
  for (const h of handlers) {
    if (!methodMatches(h.method, method)) continue;
    if (matchUrl(h.url, url)) {
      return { ...buildResponse(h), matched: true };
    }
  }
  // DEFAULT 'populate' system-wide; in URL mode (no body synthesizer here) it
  // resolves identically to 'permissive' — an empty {} — so this is a
  // consistency alignment, not a behavior change for the matcher.
  const fallback = network?.fallback ?? 'populate';
  return { ...fallbackResponse(fallback), matched: false };
}
