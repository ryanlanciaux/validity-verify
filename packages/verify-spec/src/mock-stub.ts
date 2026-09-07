import type { UnmatchedRequest } from './types.js';

/**
 * Turn a concrete request URL into a `mockNetwork` handler `url` pattern: the
 * origin collapses to `*` (host + port vary across machines and runs), the path
 * stays verbatim, and any query string collapses to a trailing `*` (its values
 * are request-specific). Relative or malformed inputs keep their path.
 */
export function generalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return '*' + u.pathname + (u.search ? '*' : '');
  } catch {
    const q = rawUrl.indexOf('?');
    const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const normalized = path.startsWith('/') ? path : '/' + path;
    return '*' + normalized + (q === -1 ? '' : '*');
  }
}

/** Upper bound on a serialized stub body — a second guard over the in-page cap. */
const MAX_BODY_CHARS = 2000;

/**
 * Pick the handler body field for a fabricated fallback body: a raw (non-JSON)
 * string maps to `text`, everything else — objects, arrays, scalars — to `json`.
 * An absent (or unserializable) body defaults to an empty `json: {}` placeholder.
 * An over-long value is truncated with a visible marker (the stub is advisory —
 * the reader edits it). Keeps the emitted field aligned with the handler schema.
 */
function bodyField(body: unknown): { key: 'json' | 'text'; value: string } {
  if (body === undefined) return { key: 'json', value: '{}' };
  // A string body never parsed as JSON at capture time → answered as text.
  const key: 'json' | 'text' = typeof body === 'string' ? 'text' : 'json';
  const raw = JSON.stringify(body) ?? '{}';
  const value =
    raw.length > MAX_BODY_CHARS ? raw.slice(0, MAX_BODY_CHARS) + ' /* …truncated */' : raw;
  return { key, value };
}

/**
 * Build a paste-ready `.validity/config.ts` `mockNetwork.handlers` entry from an
 * unmatched request and the body the permissive/populate fallback fabricated for
 * it. Advisory text only — Validity never writes it (fabricated data must not
 * silently become declared-mock provenance). The emitted fields are exactly the
 * ones `mockNetworkHandlerSchema` accepts (`url`, optional `method`, one of
 * `json` / `text`): GET omits `method` (the matcher's default matches any verb),
 * other verbs carry it. Pure.
 */
export function buildHandlerStub(req: UnmatchedRequest): string {
  const pattern = generalizeUrl(req.url);
  const { key, value } = bodyField(req.body);
  const method = req.method.toUpperCase();
  const parts: string[] = [];
  if (method !== 'GET') parts.push(`method: ${JSON.stringify(method)}`);
  parts.push(`url: ${JSON.stringify(pattern)}`);
  parts.push(`${key}: ${value}`);
  return `{ ${parts.join(', ')} }`;
}
