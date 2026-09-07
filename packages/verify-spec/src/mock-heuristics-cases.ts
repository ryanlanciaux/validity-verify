/**
 * Shared TEST-FIXTURE tables for the permissive network-mock heuristics that
 * BOTH the web sandbox and the native playground implement independently.
 *
 * WHY THIS EXISTS (and why it is CASES, not shared code):
 * The web isolation sandbox embeds its permissive `permissiveBody` shape
 * heuristic + deep-default `Proxy` inside a load-bearing template literal
 * (`VALIDITY_MSW_SOURCE` in @validity.ai/verify-web) whose synchronous
 * patch-before-import ordering and `Response.prototype.json` shim are fragile
 * by design. The native runtime (@validity.ai/verify-native) re-implements the SAME
 * behaviours as real exported functions embedded via `.toString()`. We
 * deliberately do NOT extract the web copy into shared code (that would touch
 * web's frozen runtime contract). Instead both suites import THESE cases and
 * assert their own implementation against them, so the two implementations
 * cannot silently diverge even though the code is duplicated.
 *
 * This module is consumed ONLY by test suites; it is plain data (plus probe
 * closures) and adds nothing to either runtime's behaviour.
 */

/**
 * Expected `permissiveBody(method, url)` output, expressed as the PARSED JSON
 * value (each implementation returns a JSON string; tests `JSON.parse` it and
 * compare). The heuristic: an un-mocked GET defaults to a shape that satisfies
 * the access pattern its URL implies (list-ish → `[]`, count/stats → numbers,
 * state/status → `{ status: 'ok' }`, otherwise `{}`); a non-GET defaults to
 * `{ ok: true }` so mutation handlers don't break.
 */
export interface PermissiveBodyCase {
  method: string;
  url: string;
  /** Parsed JSON the implementation's returned body string must `JSON.parse` to. */
  expected: unknown;
  /** Human-readable reason this case locks a specific branch. */
  why: string;
}

export const PERMISSIVE_BODY_CASES: ReadonlyArray<PermissiveBodyCase> = [
  // Non-GET → { ok: true } regardless of URL shape.
  { method: 'POST', url: '/api/users', expected: { ok: true }, why: 'non-GET → { ok: true }' },
  { method: 'PUT', url: '/api/user/1', expected: { ok: true }, why: 'non-GET → { ok: true }' },
  {
    method: 'DELETE',
    url: '/api/games/42',
    expected: { ok: true },
    why: 'non-GET wins even over a list-ish URL',
  },

  // Scalar-shape hints win over list hints (checked on the LAST segment first).
  {
    method: 'GET',
    url: '/api/posts/count',
    expected: { count: 0 },
    why: 'trailing /count → { count: 0 } even though "posts" is list-ish',
  },
  {
    method: 'GET',
    url: '/api/users/count',
    expected: { count: 0 },
    why: 'last segment "count" beats the list segment "users"',
  },
  {
    method: 'GET',
    url: '/api/openingsCount',
    expected: { count: 0 },
    why: 'name ending in Count → { count: 0 }',
  },
  {
    method: 'GET',
    url: '/api/stats',
    expected: { count: 0, total: 0 },
    why: 'stats → { count, total }',
  },
  {
    method: 'GET',
    url: '/api/metrics',
    expected: { count: 0, total: 0 },
    why: 'metrics → { count, total }',
  },
  {
    method: 'GET',
    url: '/api/summary',
    expected: { count: 0, total: 0 },
    why: 'summary → { count, total }',
  },
  {
    method: 'GET',
    url: '/api/games/stats',
    expected: { count: 0, total: 0 },
    why: 'last segment "stats" beats the list segment "games"',
  },
  { method: 'GET', url: '/api/state', expected: { status: 'ok' }, why: 'state → { status: ok }' },
  { method: 'GET', url: '/api/status', expected: { status: 'ok' }, why: 'status → { status: ok }' },
  { method: 'GET', url: '/api/health', expected: { status: 'ok' }, why: 'health → { status: ok }' },

  // List heuristic: ANY segment in the known list set → [].
  { method: 'GET', url: '/api/users', expected: [], why: 'users is list-ish → []' },
  { method: 'GET', url: '/api/games', expected: [], why: 'games is list-ish → []' },
  { method: 'GET', url: '/api/feed', expected: [], why: 'feed is list-ish → []' },
  { method: 'GET', url: '/api/openings', expected: [], why: 'openings is list-ish → []' },
  { method: 'GET', url: '/api/categories', expected: [], why: 'categories is list-ish → []' },
  {
    method: 'GET',
    url: '/api/courses/progress/user',
    expected: [],
    why: 'INTERMEDIATE list segment ("courses"/"progress") → [] even though last is "user"',
  },

  // Plural-noun heuristic on the LAST segment (not in the known list set).
  { method: 'GET', url: '/api/widgets', expected: [], why: 'plural -s last segment → []' },
  {
    method: 'GET',
    url: 'https://example.com/v2/gadgets',
    expected: [],
    why: 'absolute URL, plural last segment → []',
  },

  // Plural false-positives (-ss / -us / -is / -os / -as) stay singular → {}.
  { method: 'GET', url: '/api/address', expected: {}, why: '-ss false positive → {}' },
  { method: 'GET', url: '/api/bus', expected: {}, why: '-us false positive → {}' },
  { method: 'GET', url: '/api/analysis', expected: {}, why: '-is false positive → {}' },

  // Plain singular / unknown shape → {}.
  { method: 'GET', url: '/api/me', expected: {}, why: 'singular, unknown → {}' },
  { method: 'GET', url: '/api/user', expected: {}, why: 'singular "user" → {}' },
  { method: 'GET', url: '/', expected: {}, why: 'no path segments → {}' },
];

/**
 * Expected `isFeedUrl(url)` result. Feed detection is used ONLY under
 * `fallback: 'populate'`, where an un-mocked feed must answer XML. Detection is
 * broad: extension (`.rss`/`.xml`/`.atom`), a feed-ish path segment, or a
 * feed-ish host. Both runtimes assert their own copy against this table.
 */
export interface FeedUrlCase {
  url: string;
  expected: boolean;
  why: string;
}

export const FEED_URL_CASES: ReadonlyArray<FeedUrlCase> = [
  { url: 'https://example.com/podcast.rss', expected: true, why: '.rss extension' },
  { url: 'https://example.com/feed.xml', expected: true, why: '.xml extension' },
  { url: 'https://example.com/atom.atom?x=1', expected: true, why: '.atom extension w/ query' },
  { url: 'https://example.com/podcast/feed', expected: true, why: 'trailing /feed segment' },
  { url: 'https://example.com/rss/latest', expected: true, why: 'leading /rss segment' },
  {
    url: 'https://feeds.simplecast.com/hEI_f9Dx',
    expected: true,
    why: 'feeds.* host (no extension)',
  },
  { url: 'https://rss.cnn.com/edition', expected: true, why: 'rss.* host' },
  { url: 'https://api.example.com/users', expected: false, why: 'plain JSON list endpoint' },
  { url: 'https://api.example.com/me', expected: false, why: 'plain JSON object endpoint' },
  { url: '/api/redfeed', expected: false, why: 'feed must be a whole segment, not a substring' },
];

/**
 * Shape expected from `populatedBody(method, url)` (and feed URLs from
 * `feedBody`) under `fallback: 'populate'`. Unlike PERMISSIVE_BODY_CASES (which
 * locks exact empty values), populate returns synthetic data, so each case
 * asserts the KIND:
 *   - 'array'  → JSON.parse is a non-empty array of objects (so `.map` renders).
 *   - 'object' → JSON.parse is a non-array object.
 *   - 'xml'    → the body is a `<?xml … <item> …` RSS document (use feedBody).
 *   - 'count'  → JSON.parse is `{ count: N }` with N > 0.
 *   - 'ok'     → JSON.parse is `{ ok: true }` (non-GET).
 */
export interface PopulatedBodyCase {
  method: string;
  url: string;
  kind: 'array' | 'object' | 'xml' | 'count' | 'ok';
  why: string;
}

export const POPULATED_BODY_CASES: ReadonlyArray<PopulatedBodyCase> = [
  { method: 'POST', url: '/api/users', kind: 'ok', why: 'non-GET → { ok: true }' },
  {
    method: 'GET',
    url: '/api/episodes',
    kind: 'array',
    why: 'list-ish (episodes) → populated array',
  },
  { method: 'GET', url: '/api/users', kind: 'array', why: 'list segment → populated array' },
  {
    method: 'GET',
    url: '/api/widgets',
    kind: 'array',
    why: 'plural last segment → populated array',
  },
  { method: 'GET', url: '/api/me', kind: 'object', why: 'singular → single populated object' },
  {
    method: 'GET',
    url: '/api/posts/count',
    kind: 'count',
    why: 'count scalar stays scalar (non-zero)',
  },
  {
    method: 'GET',
    url: 'https://feeds.simplecast.com/hEI_f9Dx',
    kind: 'xml',
    why: 'feed host → RSS document',
  },
  {
    method: 'GET',
    url: 'https://example.com/podcast.rss',
    kind: 'xml',
    why: 'feed extension → RSS document',
  },
];

/**
 * Probes for the deep-default `Proxy` that both runtimes return as the
 * deserialized form of an un-mocked permissive response, so a component that
 * destructures or maps over an un-mocked field sees a benign default instead of
 * crashing on "Cannot read properties of undefined". Each probe is run against
 * a freshly-built proxy and its result compared (deep-equal) to `expected`.
 */
export interface DeepDefaultProxyCase {
  name: string;
  probe: (p: any) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  expected: unknown;
}

export const DEEP_DEFAULT_PROXY_CASES: ReadonlyArray<DeepDefaultProxyCase> = [
  { name: '.length → 0', probe: (p) => p.length, expected: 0 },
  { name: '.size → 0', probe: (p) => p.size, expected: 0 },
  { name: '.map() → []', probe: (p) => p.map(() => 1), expected: [] },
  { name: '.filter() → []', probe: (p) => p.filter(() => true), expected: [] },
  { name: '.forEach() → []', probe: (p) => p.forEach(() => {}), expected: [] },
  { name: '.reduce(fn, init) → init', probe: (p) => p.reduce((a: number) => a, 42), expected: 42 },
  { name: '.find() → undefined', probe: (p) => p.find(() => true), expected: undefined },
  { name: '.findIndex() → -1', probe: (p) => p.findIndex(() => true), expected: -1 },
  { name: '.includes() → false', probe: (p) => p.includes(1), expected: false },
  { name: '.indexOf() → -1', probe: (p) => p.indexOf(1), expected: -1 },
  { name: '.join() → ""', probe: (p) => p.join('-'), expected: '' },
  { name: '.every() → true', probe: (p) => p.every(() => false), expected: true },
  { name: '.some() → false', probe: (p) => p.some(() => true), expected: false },
  { name: '.toFixed() → "0"', probe: (p) => p.toFixed(2), expected: '0' },
  { name: '.toLocaleString() → "0"', probe: (p) => p.toLocaleString(), expected: '0' },
  { name: 'String(p) → ""', probe: (p) => String(p), expected: '' },
  { name: 'Number(p) → 0', probe: (p) => Number(p), expected: 0 },
  { name: '.isLoading → false', probe: (p) => p.isLoading, expected: false },
  { name: '.hasError → false', probe: (p) => p.hasError, expected: false },
  { name: '.loading → false', probe: (p) => p.loading, expected: false },
  { name: '.count → 0', probe: (p) => p.count, expected: 0 },
  { name: '.total → 0', probe: (p) => p.total, expected: 0 },
  { name: '.items → [] (plural)', probe: (p) => p.items, expected: [] },
  // Unknown field recurses into another (callable) proxy — typeof 'function'.
  { name: '.unknownField → child proxy', probe: (p) => typeof p.user, expected: 'function' },
  // Verb-prefixed names that ALSO end in 's' are methods, not plural nouns: they
  // must stay CALLABLE (return a child proxy) so `const { fetchEpisodes } =
  // useContext(C); fetchEpisodes()` no-ops instead of throwing "X is not a
  // function (it is Object)". Regression guard for the plural-heuristic misfire.
  { name: '.fetchEpisodes → callable', probe: (p) => typeof p.fetchEpisodes, expected: 'function' },
  { name: '.getUsers → callable', probe: (p) => typeof p.getUsers, expected: 'function' },
  { name: '.loadItems → callable', probe: (p) => typeof p.loadItems, expected: 'function' },
  {
    name: '.toggleFavorites → callable',
    probe: (p) => typeof p.toggleFavorites,
    expected: 'function',
  },
  { name: '.onPress → callable', probe: (p) => typeof p.onPress, expected: 'function' },
  {
    name: '.fetchEpisodes() does not throw',
    probe: (p) => {
      try {
        p.fetchEpisodes();
        return 'ok';
      } catch {
        return 'threw';
      }
    },
    expected: 'ok',
  },
  // A genuine plural NOUN (no verb prefix) must still be an array so `.map`
  // works AND `Array.isArray` passes — the verb-prefix carve-out must not regress it.
  { name: '.episodes → [] (plural noun)', probe: (p) => p.episodes, expected: [] },
];
