/**
 * Generate the `msw/native` network-mock module the playground harness
 * imports. Validity's existing `mockNetwork.handlers` drive it — no new
 * config surface; the same handlers that drive web isolation drive the
 * native playground.
 *
 * DATA, NOT CODE: the generated module body is STATIC (identical for every
 * project). The project-specific part — handlers, fallback policy, the
 * AsyncStorage seed — is pure JSON data (`MockNetworkHandler` has no function
 * members) and lives in the generated `validity-native-data.ts` module, which
 * is deliberately EXCLUDED from contentHash: editing a mock handler in
 * `.validity/config.ts` must NOT cost a Metro `--clear` restart. Fresh data
 * reaches the device out-of-band instead:
 *   - per-navigation: the bridge `navigate` message carries `mockNetwork`,
 *     applied via `applyMockNetwork()` before the target renders;
 *   - at boot: ValidityNativeRoot fetches the bridge's GET /data endpoint and
 *     applies its payload, degrading to the baked data module when the bridge
 *     is unreachable (offline / genuinely cold).
 * Anything FUNCTION-BEARING cannot travel this way and must stay baked code
 * (tracked by contentHash) — there is currently nothing in the native mock
 * surface that is (play functions never run on native).
 *
 * Why `msw/native` (verified against MSW's RN integration docs): in React
 * Native, `fetch` is the whatwg-fetch polyfill implemented on top of RN's
 * native `XMLHttpRequest`. `msw/native` wires MSW's XHR interceptor to that
 * global, so a single setup catches BOTH fetch and XHR traffic. It requires
 * two polyfills imported BEFORE `server.listen()`:
 *   - `react-native-url-polyfill/auto` (URL)
 *   - `fast-text-encoding` (TextEncoder/TextDecoder)
 *
 * The generated module is written into the user's project (bundled by Metro)
 * — it is NOT compiled by this package's tsc. We emit source text only.
 */
import type { DataState, MockNetworkConfig, MockNetworkHandler } from '@validity.ai/verify-spec';

/**
 * The JSON-serializable mock-network payload the native runtime consumes —
 * the data half of the data/code split above. Travels three ways (baked
 * `validity-native-data.ts`, bridge `navigate.mockNetwork`, bridge GET /data)
 * and is applied identically whichever way it arrives.
 *
 * `fallback` is normalized to the two policies the native runtime implements:
 * a custom `MockHandlerResponse` fallback degrades to 'permissive' (matching
 * the pre-data behavior, where only 'reject' was distinguished).
 */
export interface NativeMockNetworkData {
  /** Handlers tried in order; first match wins. Pure data — no functions. */
  handlers: MockNetworkHandler[];
  /**
   * Un-mocked-request policy:
   *   - 'permissive' (default) — empty shape-correct bodies (crash-proofing).
   *   - 'populate'             — synthetic POPULATED bodies (arrays of items,
   *                              RSS for feeds) so list/feed screens render
   *                              content instead of their empty state.
   *   - 'reject'               — no catch-all; un-mocked requests 599.
   */
  fallback: 'permissive' | 'populate' | 'reject';
  /**
   * WIRE SEAM ONLY (A2): the forced data-state axis is NOT implemented on
   * native yet — this field travels so a newer host can address a future
   * companion runtime without a wire-format bump. Today's companion's
   * MSW-ish layer ignores unknown JSON fields, so older builds are
   * wire-compatible; the forced branches (mirroring the web sandbox's MSW
   * layer) are the follow-up item's scope. Native dataState criteria
   * resolve `unverifiable` in the meantime — never pass.
   */
  dataState?: DataState;
}

/**
 * Runtime mock-network state the device reports back to the host (in the bridge
 * `hello`), so a native verify can tell the agent whether the screenshots were
 * scored against FIXTURES or against the REAL network.
 *
 * `startMockNetwork()` wraps msw's setup in a try/catch and degrades to "no
 * mocking" on failure (a missing polyfill, an msw/native version drift) — that
 * degradation used to be silent (a console.warn nobody reads), so the agent
 * could score real-API data (or unreachable-API error states) against criteria
 * that assume the configured fixtures. This is the signal that closes that gap.
 *   - { active: true }                  — msw is intercepting; fixtures apply.
 *   - { active: false, reason }         — mocking is OFF; `reason` says why
 *                                         (setup threw / production build).
 */
export interface NativeMockStatus {
  active: boolean;
  reason?: string;
}

/**
 * Normalize the merged config's mockNetwork into the wire/baked data shape.
 * Handlers pass through verbatim (they are already pure JSON data).
 */
export function resolveNativeMockData(
  mockNetwork: MockNetworkConfig | undefined,
  dataState?: DataState,
): NativeMockNetworkData {
  const fb = mockNetwork?.fallback;
  // DEFAULT is 'populate' (undefined → populate) so list/feed screens render
  // content out of the box; opt out with 'permissive'. 'reject' is preserved; a
  // custom MockHandlerResponse object can't travel as the native enum policy, so
  // it degrades to 'permissive' (unchanged crash-safe behavior).
  const fallback: NativeMockNetworkData['fallback'] =
    fb === 'reject'
      ? 'reject'
      : fb === 'permissive'
        ? 'permissive'
        : fb && typeof fb === 'object'
          ? 'permissive'
          : 'populate';
  return {
    handlers: mockNetwork?.handlers ?? [],
    fallback,
    // Wire seam only — see NativeMockNetworkData.dataState. 'populated'
    // normalizes to "not forced" (mirrors the web MSW layer's contract).
    ...(dataState && dataState !== 'populated' ? { dataState } : {}),
  };
}

/**
 * Normalize a handler URL so msw matches it regardless of the request's
 * origin. A path-only pattern like `/api/me` is prefixed with a wildcard
 * host (an asterisk) so it matches any host the RN app talks to; absolute
 * URLs pass through untouched.
 *
 * Embedded VERBATIM into the generated mock module (via `.toString()`) AND
 * unit-tested directly, so the runtime behaviour and the test can't drift.
 * Must stay self-contained (no references to module scope).
 */
export function mockUrlPattern(url: string): string {
  const u = String(url || '');
  if (/^https?:\/\//i.test(u)) return u;
  const path = u.startsWith('/') ? u : `/${u}`;
  return `*${path}`;
}

/**
 * "Permissive" auto-mock body for an un-mocked request: return a body whose
 * SHAPE plausibly matches what the endpoint name implies, so a native screen
 * that maps/destructures the response doesn't crash on `[].map`/`undefined`.
 * The bare `{}` the native catch-all used to return crashed list-driven
 * screens that web survived — this is the native-side port of web's
 * `permissiveBody` (kept BEHAVIOURALLY IDENTICAL; both run the shared
 * PERMISSIVE_BODY_CASES table so they cannot drift).
 *
 *   - non-GET (POST/PUT/PATCH/DELETE) → `{ ok: true }` (mutation handlers)
 *   - GET, last segment count-ish      → `{ count: 0 }`
 *   - GET, last segment stats-ish      → `{ count: 0, total: 0 }`
 *   - GET, last segment state-ish      → `{ status: 'ok' }`
 *   - GET, ANY list-ish segment        → `[]`
 *   - GET, plural last segment         → `[]`
 *   - everything else                  → `{}`
 *
 * Embedded VERBATIM into the generated mock module via `.toString()` (like
 * mockUrlPattern) AND unit-tested directly, so the runtime behaviour and the
 * test can't drift. Must stay self-contained (only globals: URL, JSON).
 */
export function permissiveBody(method: string, url: string): string {
  if (String(method).toUpperCase() !== 'GET') return JSON.stringify({ ok: true });
  let path = String(url);
  try {
    path = new URL(url, 'http://x').pathname;
  } catch {
    /* fall through: treat the raw input as the path */
  }
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const last = segments[segments.length - 1] ?? '';
  // Scalar-shape hints win over list hints (count/stats/status are always
  // single-value endpoints even when their path also contains a plural).
  if (last === 'count' || /count$/.test(last)) return JSON.stringify({ count: 0 });
  if (last === 'stats' || last === 'metrics' || last === 'summary') {
    return JSON.stringify({ count: 0, total: 0 });
  }
  if (last === 'state' || last === 'status' || last === 'health') {
    return JSON.stringify({ status: 'ok' });
  }
  // List heuristic: ANY segment in the path is list-shaped (catches both a
  // plural last segment and an intermediate one like /courses/progress/user).
  const listSegments = new Set([
    'list',
    'all',
    'items',
    'results',
    'search',
    'feed',
    'messages',
    'games',
    'openings',
    'analyses',
    'puzzles',
    'plans',
    'courses',
    'variations',
    'challenges',
    'events',
    'notifications',
    'comments',
    'reviews',
    'posts',
    'orders',
    'users',
    'products',
    'tags',
    'categories',
    'projects',
    'tasks',
    'progress',
    'structures',
  ]);
  for (const seg of segments) {
    if (listSegments.has(seg)) return '[]';
  }
  // Plural-noun heuristic on the LAST segment: ends in -s but not a common
  // false positive (-ss / -us / -is / -os / -as).
  if (/^[a-z][a-z0-9_-]+s$/.test(last) && !/(ss|us|is|os|as)$/.test(last)) {
    return '[]';
  }
  return '{}';
}

/**
 * Does a URL look like an RSS/Atom feed? Used ONLY under the opt-in
 * `fallback: 'populate'` policy, where an un-mocked feed must answer with XML
 * (a JSON `[]`/`{}` never parses as a feed → empty list). Detection is
 * deliberately broad — extension (`.rss`/`.xml`/`.atom`), a feed-ish path
 * segment, OR a feed-ish host (`feeds.simplecast.com`, `rss.x.com`) — because a
 * user who opted into `populate` is asking for content screens to render and
 * can pin a real handler if a guess is wrong.
 *
 * Embedded VERBATIM into the generated mock module via `.toString()` AND
 * unit-tested directly (shared POPULATED_BODY_CASES), so runtime and test can't
 * drift. Must stay self-contained (only globals: URL, String).
 */
export function isFeedUrl(url: string): boolean {
  let host = '';
  let path = String(url).toLowerCase();
  try {
    const u = new URL(url, 'http://x');
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    /* fall through: treat the raw input as the path */
  }
  if (/\.(rss|atom|xml)(\?|$)/.test(path)) return true;
  if (/(^|\/)(feed|feeds|rss|atom)(\/|$)/.test(path)) return true;
  if (/(^|\.)(feeds?|rss)\./.test(host)) return true;
  return false;
}

/**
 * A minimal but VALID RSS 2.0 document with a few synthetic items, returned for
 * an un-mocked feed URL under `fallback: 'populate'` so a podcast/news list
 * renders cards instead of its empty state. Self-contained (only globals:
 * String) — inner helpers keep it embeddable via `.toString()`.
 */
export function feedBody(url: string): string {
  const esc = (s: string): string =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const titles = [
    'The First Episode',
    'Building in Public',
    'Lessons From the Field',
    'A Deep Dive',
    'Looking Ahead',
  ];
  const dates = [
    'Mon, 01 Jan 2024 12:00:00 GMT',
    'Mon, 08 Jan 2024 12:00:00 GMT',
    'Mon, 15 Jan 2024 12:00:00 GMT',
    'Mon, 22 Jan 2024 12:00:00 GMT',
    'Mon, 29 Jan 2024 12:00:00 GMT',
  ];
  let items = '';
  for (let i = 0; i < 5; i++) {
    items +=
      '<item>' +
      '<title>' +
      esc(titles[i % 5]!) +
      '</title>' +
      '<link>https://example.com/episode/' +
      (i + 1) +
      '</link>' +
      '<guid>episode-' +
      (i + 1) +
      '</guid>' +
      '<pubDate>' +
      dates[i % 5]! +
      '</pubDate>' +
      '<description>A synthetic episode generated by Validity for isolated rendering.</description>' +
      '<enclosure url="https://example.com/episode/' +
      (i + 1) +
      '.mp3" type="audio/mpeg" length="0"/>' +
      '</item>';
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0"><channel>' +
    '<title>Validity Sample Feed</title>' +
    '<link>' +
    esc(url) +
    '</link>' +
    '<description>Synthetic feed for isolated rendering</description>' +
    items +
    '</channel></rss>'
  );
}

/**
 * "Populate" auto-mock body (opt-in `fallback: 'populate'`). Unlike
 * `permissiveBody` (which returns EMPTY shapes to merely prevent crashes), this
 * returns a few synthetic items so list/detail screens render real-looking
 * content. Non-GET → `{ ok: true }`; scalar-shape endpoints (count/stats/state)
 * stay scalar; list-ish endpoints → an array of N items; everything else → a
 * single item. Feed URLs are handled separately by {@link feedBody}.
 *
 * Embedded VERBATIM via `.toString()` AND unit-tested directly. Self-contained
 * (only globals: URL, JSON, String) — inner `item()` keeps it embeddable.
 */
export function populatedBody(method: string, url: string): string {
  if (String(method).toUpperCase() !== 'GET') return JSON.stringify({ ok: true });
  const item = (i: number): Record<string, unknown> => {
    const titles = [
      'Welcome back',
      'Project overview',
      'Latest updates',
      'Quick stats',
      'Recent activity',
    ];
    const names = ['Jane Doe', 'Alice Carter', 'Bob Singh', 'Yuki Tanaka', 'Marcus Chen'];
    return {
      id: 'id-' + (1000 + i),
      title: titles[i % 5],
      name: names[i % 5],
      description: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.',
      imageUrl: 'https://picsum.photos/seed/' + (i + 1) + '/400/300',
      url: 'https://example.com/item/' + (i + 1),
      publishedAt: '2024-01-' + String((i % 28) + 1).padStart(2, '0') + 'T12:00:00.000Z',
    };
  };
  let path = String(url);
  try {
    path = new URL(url, 'http://x').pathname;
  } catch {
    /* fall through: treat the raw input as the path */
  }
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const last = segments[segments.length - 1] ?? '';
  // Scalar-shape hints stay scalar (a "populated" count is meaningless) but use
  // non-zero values so a screen that hides on count===0 shows its populated UI.
  if (last === 'count' || /count$/.test(last)) return JSON.stringify({ count: 3 });
  if (last === 'stats' || last === 'metrics' || last === 'summary') {
    return JSON.stringify({ count: 3, total: 3 });
  }
  if (last === 'state' || last === 'status' || last === 'health') {
    return JSON.stringify({ status: 'ok' });
  }
  const listSegments = new Set([
    'list',
    'all',
    'items',
    'results',
    'search',
    'feed',
    'messages',
    'games',
    'openings',
    'analyses',
    'puzzles',
    'plans',
    'courses',
    'variations',
    'challenges',
    'events',
    'notifications',
    'comments',
    'reviews',
    'posts',
    'orders',
    'users',
    'products',
    'tags',
    'categories',
    'projects',
    'tasks',
    'progress',
    'structures',
    'episodes',
    'articles',
    'stories',
  ]);
  const isList =
    segments.some((s) => listSegments.has(s)) ||
    (/^[a-z][a-z0-9_-]+s$/.test(last) && !/(ss|us|is|os|as)$/.test(last));
  if (isList) {
    const arr: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 5; i++) arr.push(item(i));
    return JSON.stringify(arr);
  }
  return JSON.stringify(item(0));
}

/**
 * Build a deeply-defaulting Proxy that satisfies essentially any property
 * access without throwing — the deserialized form of a permissive un-mocked
 * response (returned by the shimmed `Response.json()` below). A component
 * calling `data.partialResults.length` against an un-mocked endpoint sees `0`
 * instead of crashing with "Cannot read properties of undefined".
 *
 * Native-side port of web's `makeDeepDefaultProxy`, kept BEHAVIOURALLY
 * IDENTICAL via the shared DEEP_DEFAULT_PROXY_CASES table. Must stay
 * self-contained (only globals: Proxy, Symbol) — embedded verbatim via
 * `.toString()`.
 *
 * DELIBERATELY DISTINCT from prepare-native's `makeDeepDefaultProxy` (the
 * context auto-mock): that one bridges the active scenario's
 * `__VALIDITY_CONTEXT_SEED__` into the proxy so `useAuth().isAuthenticated`
 * reflects the scenario. A NETWORK response body must NOT pull from the context
 * seed (it would leak auth/theme flags into fetched data), so this is its own
 * pure factory rather than a reuse.
 */
export function makePermissiveResponseProxy(callable = false): unknown {
  // TOP-level proxy uses an object target so `typeof data === 'object'` (like
  // parsed JSON); CHILD proxies use a function target so chained method calls
  // (`data.foo.someMethod()`) don't throw.
  const recurse = (): unknown => makePermissiveResponseProxy(true);
  const target: Record<string | symbol, unknown> = callable
    ? (function shim() {
        return recurse();
      } as unknown as Record<string | symbol, unknown>)
    : {};
  return new Proxy(target, {
    get(target, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(target, prop);
      if (desc && desc.configurable === false && 'value' in desc) return desc.value;
      // Primitive coercion hooks — sane conversion to string/number.
      if (prop === Symbol.toPrimitive) {
        return (hint: string) => (hint === 'number' ? 0 : hint === 'string' ? '' : 0);
      }
      if (prop === 'toString') return () => '';
      if (prop === 'valueOf') return () => 0;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.asyncIterator) return async function* () {};
      // Skip thenable detection — a function here would make `await proxy` hang.
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      // Collection-shape: empty length / no items.
      if (prop === 'length' || prop === 'size') return 0;
      if (prop === 'map' || prop === 'filter') return () => [];
      if (prop === 'reduce' || prop === 'reduceRight') return (_fn: unknown, init: unknown) => init;
      if (prop === 'forEach' || prop === 'flat' || prop === 'flatMap') return () => [];
      if (prop === 'every') return () => true;
      if (prop === 'some') return () => false;
      if (prop === 'find' || prop === 'findIndex' || prop === 'findLast') {
        return () => (prop === 'findIndex' ? -1 : undefined);
      }
      if (prop === 'includes' || prop === 'indexOf') {
        return () => (prop === 'includes' ? false : -1);
      }
      if (prop === 'join') return () => '';
      if (prop === 'concat' || prop === 'slice' || prop === 'splice') return () => [];
      // Number-shape format methods.
      if (prop === 'toFixed' || prop === 'toPrecision' || prop === 'toExponential')
        return () => '0';
      if (prop === 'toLocaleString') return () => '0';
      // Name-shape defaults so flag-style checks don't render error branches.
      if (typeof prop === 'string') {
        const lower = prop.toLowerCase();
        if (/^(is|has|can|should|did|was|will|are)[A-Z_]/.test(prop)) return false;
        if (/^loading$|^pending$|^error$|^errored$|^disabled$|^success$/.test(lower)) return false;
        if (lower === 'count' || lower === 'total' || lower === 'index' || /count$/.test(lower)) {
          return 0;
        }
        // Verb-prefixed names that ALSO end in 's' are methods, not plural nouns:
        // keep them CALLABLE so `obj.fetchEpisodes()` no-ops instead of throwing
        // "X is not a function". A callable proxy still satisfies .map()->[],
        // .length->0. Must precede the plural-noun rule below. Kept identical to
        // the web proxy + the native createContext proxy (shared DEEP_DEFAULT_PROXY_CASES).
        if (
          /^(get|set|fetch|load|create|update|delete|remove|add|submit|save|handle|toggle|clear|reset|select|find|refresh|open|close|on)[A-Z]/.test(
            prop,
          )
        ) {
          return recurse();
        }
        if (/^[a-z][a-z0-9_]+s$/i.test(prop) && !/(ss|us|is|os|as)$/.test(lower)) return [];
      }
      // Numeric index / unknown field — recurse so chained access works.
      return recurse();
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

/**
 * Render the native mock module source. STATIC (takes no config): the
 * project's handlers/fallback live in `validity-native-data.ts` and are
 * (re)applied as data — see the module header. Exposes:
 *   - `startMockNetwork()` — called once by native-entry; sets msw up with
 *     whatever data is current (host-pushed if it already arrived, else baked).
 *   - `applyMockNetwork(data)` — re-applies a fresher data payload (bridge
 *     navigate / boot fetch) via `server.resetHandlers()`. Keyed by the
 *     payload's JSON so identical re-pushes don't churn the handler stack.
 *   - `setBridgePassthrough(origin)` — exempts the control-bridge's loopback
 *     origin from interception so the device's GET /data boot fetch reaches the
 *     real bridge instead of the permissive catch-all (which would answer {}).
 *   - `getUnmatchedUrls()` / `resetUnmatched()` — the un-mocked URLs the
 *     permissive catch-all answered; the host snapshots them into the
 *     'rendered' ack (web's unmatched-fetch diagnostic, native side) and resets
 *     per navigation.
 *   - `getMatchedRequests()` / `resetMatched()` — the network responses the
 *     screen OBSERVED ({method,url,status}: every configured-handler AND
 *     permissive-catch-all answer); snapshotted into the 'rendered' ack so a
 *     native verify can evaluate expect.network on device, reset per navigation
 *     exactly like the unmatched tracker. ADDITIVE: an old host that never reads
 *     them is unaffected; an old companion that omits them degrades to "channel
 *     unavailable" (expect.network → unverifiable, never a fail).
 * The permissive catch-all returns a SHAPE-HEURISTIC body (permissiveBody) and
 * tags it so the shimmed Response.json() yields a deep-default Proxy — web
 * parity so native screens hitting an un-mocked list endpoint don't crash.
 * The unhandled-request STRATEGY ('warn' vs 'bypass') is fixed at listen time
 * from the boot data — only the handler list re-applies. In practice the
 * permissive catch-all makes the strategy moot except under fallback:'reject'.
 */
export function renderNativeMockModule(): string {
  return `// @validity-generated — React Native mock network runtime (msw/native).
// Regenerate via 'validity browse --native'. Edit your mockNetwork handlers
// in .validity/config.ts, not this file.
//
// This module is STATIC code; the project's handlers are DATA (see
// ./validity-native-data, and applyMockNetwork for host-pushed updates) — so
// editing a mock handler never flips contentHash / restarts Metro.
//
// IMPORTANT (RN 0.83+): everything is LAZY + guarded. msw/native and the URL/
// TextEncoder polyfills have import-time side effects that redefine frozen
// globals — doing that at module load crashes RN's core init
// ("property is not writable"). So we defer all of it to startMockNetwork()
// (called after RN core is up), only load polyfills if the globals are
// actually missing (modern RN/Hermes already provide them), and wrap the whole
// thing in try/catch so a failure degrades to "no network mocking" rather than
// taking down the app.
/* eslint-disable */
// @ts-nocheck
import { mockNetwork as BAKED_MOCK_DATA } from './validity-native-data';

// Embedded verbatim from @validity.ai/verify-native's mockUrlPattern()/permissiveBody()/
// makeDeepDefaultProxy() so the generated runtime behaviour and the
// unit-tested implementations never drift (all three are self-contained, and
// run the shared PERMISSIVE_BODY_CASES / DEEP_DEFAULT_PROXY_CASES tables that
// the web sandbox runs against its own copies).
${mockUrlPattern.toString()}
${permissiveBody.toString()}
${isFeedUrl.toString()}
${feedBody.toString()}
${populatedBody.toString()}
${makePermissiveResponseProxy.toString()}

let __validityStarted = false;
let __server = null;
let __http = null;
let __HttpResponse = null;
let __passthrough = null;
// Runtime mock-network state, reported to the host in the bridge 'hello' so a
// native verify never scores real-API data against fixture criteria unknowingly.
// 'not started' until startMockNetwork() runs; then { active:true } on success
// or { active:false, reason } on the degrade path. See getMockStatus().
let __mockStatus = { active: false, reason: 'mock network not started yet' };
// JSON key of the currently-applied data — identical re-pushes are no-ops.
let __appliedKey = null;
// The currently-applied data object — re-used when setBridgePassthrough has to
// rebuild handlers (so toggling the passthrough doesn't lose the live handlers).
let __appliedData = null;
// Data pushed BEFORE startMockNetwork ran (host raced the entry) — wins at start.
let __pendingData = null;
// http origin of the Validity control bridge (e.g. http://127.0.0.1:8083). Its
// loopback endpoints (GET /data, …) must NOT be intercepted — see buildHandlers.
let __bridgeOrigin = null;
// URLs the rendered screen fetched that NO configured handler matched (the
// permissive catch-all answered them). Reported back to the host in the
// 'rendered' ack so a native verify surfaces them exactly like web's
// unmatched-fetch block ('add a handler for these endpoints'). The host
// snapshots + resets this per navigation (resetUnmatched) so each capture only
// reports the URLs THAT target hit; capped so a polling screen can't grow it
// unbounded across a long warm session.
let __unmatched = [];
const __UNMATCHED_CAP = 200;
// Network responses the rendered screen actually OBSERVED — every request a
// configured handler OR the permissive catch-all answered, recorded as
// { method, url, status } with the status it returned. The native analog of the
// web executor's page.on('response') collection: snapshotted into the 'rendered'
// ack (getMatchedRequests) so a native verify can evaluate expect.network on
// device (filter by method+url, test the status against the criterion's
// matcher). Reset per navigation (resetMatched) like __unmatched, and capped so
// a screen polling an endpoint can't grow it unbounded across a warm session.
let __matched = [];
const __MATCHED_CAP = 200;

const METHOD_TO_MSW = {
  GET: 'get', POST: 'post', PUT: 'put', PATCH: 'patch',
  DELETE: 'delete', OPTIONS: 'options', '*': 'all',
};

// Translate the pure-data handler list into msw handlers. Built with push()
// (never a joined literal) so an empty handler list can't produce a sparse
// array — setupServer(undefined, …) throws "Expected a request handler".
function buildHandlers(data) {
  const handlers = [];
  // FIRST (first match wins): let the control-bridge's own loopback origin pass
  // through UNINTERCEPTED. The device boot-fetches its DATA payload from the
  // bridge's GET /data; without this, the permissive catch-all below would
  // answer that fetch with 200 {} and the host's fresh views/scenarios/mock
  // would never load. The bridge is a local control channel, never a mocked
  // user API, so passing it through is always correct.
  if (__bridgeOrigin && __passthrough) {
    handlers.push(__http.all(__bridgeOrigin + '/*', () => __passthrough()));
  }
  const list = data && Array.isArray(data.handlers) ? data.handlers : [];
  for (const h of list) {
    if (!h || typeof h.url !== 'string') continue;
    const method = METHOD_TO_MSW[h.method || 'GET'] || 'all';
    const status = typeof h.status === 'number' ? h.status : 200;
    handlers.push(
      __http[method](mockUrlPattern(h.url), (info) => {
        // Record the OBSERVED response (method/url from the live request, the
        // status this handler returns) so expect.network can assert against it.
        const req = (info && info.request) || {};
        // 'declared' + the config handler pattern: a configured handler served
        // this response, so an expect.network verdict can cite positive
        // evidence (A4). The host cross-checks against the unmatched list and
        // demotes catch-all patterns — the device's claim is never trusted raw.
        trackMatched(req.method || h.method || 'GET', req.url || h.url, status, 'declared', h.url);
        if (h.text !== undefined) return __HttpResponse.text(String(h.text), { status });
        if (h.json !== undefined) return __HttpResponse.json(h.json, { status });
        return new __HttpResponse(null, { status });
      }),
    );
  }
  if (!data || data.fallback !== 'reject') {
    // Catch-all: intercept everything else so an un-mocked fetch doesn't crash
    // the screen. Two policies:
    //   POPULATE (DEFAULT): list-ish + feed URLs answer real SYNTHETIC data so
    //     those screens render content (a populated array of items, or an RSS
    //     document) — untagged, so .json()/.text() yield the actual body.
    //     EVERYTHING ELSE (singular/object/scalar GETs, non-GET) still answers
    //     the SHAPE-HEURISTIC permissive body tagged 'x-validity-permissive: 1',
    //     so the shimmed Response.json() returns the deep-default Proxy and
    //     destructuring an un-mocked field can't throw. Populate therefore only
    //     CHANGES the list/feed cases vs permissive — non-collection endpoints
    //     keep the exact crash-safety guarantee.
    //   PERMISSIVE: every un-mocked request answers the tagged shape-heuristic
    //     body (no synthetic collections). Opt in with mockNetwork.fallback set
    //     to 'permissive' to restore empty-by-default screens.
    // The URL is recorded as unmatched + observed in both policies.
    const populate = !data || data.fallback !== 'permissive';
    handlers.push(
      __http.all('*', (info) => {
        const req = (info && info.request) || {};
        const method = req.method || 'GET';
        const url = req.url || '';
        trackUnmatched(method + ' ' + url);
        // Also record it as an OBSERVED response (status 200) so expect.network
        // can still assert against an un-mocked endpoint the screen hit —
        // stamped 'fabricated': the catch-all invented this body (A4).
        trackMatched(method, url, 200, 'fabricated');
        if (populate) {
          if (isFeedUrl(url)) {
            return new __HttpResponse(feedBody(url), {
              status: 200,
              headers: { 'content-type': 'application/xml' },
            });
          }
          // Only a list-ish URL gets real populated data (an array). Singular /
          // scalar / non-GET fall through to the tagged crash-safe permissive
          // body below — never returned untagged, so field access stays safe.
          const pb = populatedBody(method, url);
          if (pb.charAt(0) === '[') {
            return new __HttpResponse(pb, {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
        }
        return new __HttpResponse(permissiveBody(method, url), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-validity-permissive': '1' },
        });
      }),
    );
  }
  return handlers;
}

// Record an un-mocked request the permissive catch-all answered. Capped so a
// component polling an un-mocked endpoint can't grow the list unbounded.
function trackUnmatched(entry) {
  if (typeof entry !== 'string') return;
  if (__unmatched.length >= __UNMATCHED_CAP) return;
  __unmatched.push(entry);
}

// Snapshot the un-mocked URLs seen since the last reset (host reads this when it
// gets the device's 'rendered' ack). Returns a copy so the caller can't mutate.
export function getUnmatchedUrls() {
  return __unmatched.slice();
}

// Clear the un-mocked tracker. The host (ValidityNativeRoot) calls this at the
// START of each navigation so a capture only reports the URLs that target hit,
// not a cumulative pile from earlier targets in the same warm session.
export function resetUnmatched() {
  __unmatched = [];
}

// Record an OBSERVED network response (a configured handler or the permissive
// catch-all answered it). Mirrors trackUnmatched: capped so a polling screen
// can't grow the list unbounded across a warm session. Normalizes a missing
// method to 'GET' and a non-numeric status to 0 so the host always gets a
// well-typed { method, url, status }. \`provenance\` ('declared' | 'fabricated',
// A4) records WHO answered — a configured handler (its pattern rides along as
// \`handlerUrl\`) or the catch-all; anything else is dropped so a garbage value
// can never masquerade as declared. Additive: old hosts ignore the new fields.
function trackMatched(method, url, status, provenance, handlerUrl) {
  if (typeof url !== 'string') return;
  if (__matched.length >= __MATCHED_CAP) return;
  const entry = {
    method: typeof method === 'string' ? method : 'GET',
    url,
    status: typeof status === 'number' ? status : 0,
  };
  if (provenance === 'declared' || provenance === 'fabricated') entry.provenance = provenance;
  if (typeof handlerUrl === 'string') entry.handlerUrl = handlerUrl;
  __matched.push(entry);
}

// Snapshot the observed network responses since the last reset (host reads this
// when it gets the device's 'rendered' ack, to evaluate expect.network).
// Returns a copy so the caller can't mutate the module's state.
export function getMatchedRequests() {
  return __matched.slice();
}

// Clear the observed-response tracker. The host (ValidityNativeRoot) calls this
// at the START of each navigation — same lifecycle as resetUnmatched — so each
// capture only reports the responses THAT target observed.
export function resetMatched() {
  __matched = [];
}

// Shim the global Response.prototype.json so any response the permissive
// catch-all tagged ('x-validity-permissive: 1') resolves to a deeply-defaulting
// Proxy instead of the (too-empty) parsed body — destructuring an un-mocked
// field then yields a benign default instead of throwing "Cannot read
// properties of undefined". Untagged responses (real handlers, the bridge boot
// fetch, real network) pass through to the original json(). Idempotent: guarded
// with a marker so repeated startMockNetwork/HMR runs don't stack patches.
function shimResponseJson() {
  try {
    const R = typeof globalThis !== 'undefined' ? globalThis.Response : undefined;
    if (!R || !R.prototype) return;
    const proto = R.prototype;
    if (proto.__validityJsonPatched) return;
    const original = proto.json;
    proto.json = async function patchedJson() {
      try {
        if (this && this.headers && this.headers.get('x-validity-permissive') === '1') {
          return makePermissiveResponseProxy();
        }
      } catch (_e) {
        /* fall through to the original below */
      }
      return original.call(this);
    };
    proto.__validityJsonPatched = true;
  } catch (_e) {
    /* no global Response (or frozen) — skip; permissiveBody is still returned */
  }
}

// Re-apply a fresher mock-network data payload (bridge navigate / boot fetch).
// Before start: stashed so startMockNetwork uses it. After a failed start
// (mocking disabled): silently a no-op — same degradation as the start path.
export function applyMockNetwork(data) {
  if (!data || typeof data !== 'object') return;
  if (!__validityStarted) {
    __pendingData = data;
    return;
  }
  if (!__server || !__http) return; // mocking disabled — keep degrading silently
  try {
    const key = JSON.stringify(data);
    if (key === __appliedKey) return;
    __server.resetHandlers(...buildHandlers(data));
    __appliedKey = key;
    __appliedData = data;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[validity] applying mock-network data failed:', (err && err.message) || err);
  }
}

// Register the control-bridge origin as a passthrough so the device's boot fetch
// of GET /data reaches the real bridge instead of the permissive catch-all.
// Called by ValidityNativeRoot with the bridge's http origin BEFORE it fetches.
// Re-applies the live handlers in place when mocking is already running.
export function setBridgePassthrough(origin) {
  if (typeof origin !== 'string' || !origin || origin === __bridgeOrigin) return;
  __bridgeOrigin = origin;
  if (__validityStarted && __server && __http) {
    try {
      __server.resetHandlers(...buildHandlers(__appliedData));
    } catch {
      /* keep the current handlers — worst case the boot fetch is a no-op */
    }
  }
}

// Current mock-network state for the host's bridge 'hello' (ValidityNativeRoot
// reads this and announces it). Returns a fresh object so callers can't mutate
// the module's state. Old host binaries that don't read it are unaffected.
export function getMockStatus() {
  return { active: __mockStatus.active, reason: __mockStatus.reason };
}

export function startMockNetwork() {
  if (__validityStarted) return;
  __validityStarted = true;
  if (typeof __DEV__ !== 'undefined' && !__DEV__) {
    // Production bundle: msw is dev-only, so mocking is intentionally off. Report
    // it so the host doesn't read the absence of mocking as a failure.
    __mockStatus = { active: false, reason: 'production build — network mocking is dev-only' };
    return;
  }
  try {
    if (typeof globalThis.URL === 'undefined') require('react-native-url-polyfill/auto');
    if (typeof globalThis.TextEncoder === 'undefined') require('fast-text-encoding');
    const { setupServer } = require('msw/native');
    const { http, HttpResponse, passthrough } = require('msw');
    __http = http;
    __HttpResponse = HttpResponse;
    __passthrough = passthrough;
    // Make the permissive fallback's tagged responses deserialize to the
    // deep-default Proxy (web parity) so destructuring an un-mocked field can't
    // throw. Safe before listen(): it only patches Response.prototype.json.
    shimResponseJson();
    const data = __pendingData || BAKED_MOCK_DATA;
    __pendingData = null;
    const server = setupServer(...buildHandlers(data));
    server.listen({
      onUnhandledRequest: data && data.fallback === 'reject' ? 'warn' : 'bypass',
    });
    __server = server;
    __appliedKey = JSON.stringify(data);
    __appliedData = data;
    __mockStatus = { active: true, reason: undefined };
  } catch (err) {
    // Degrade to "no network mocking" rather than crashing the app — but record
    // WHY so the host's verify response can warn the agent instead of letting it
    // silently score real-API data against fixture criteria.
    __mockStatus = { active: false, reason: (err && err.message) || String(err) };
    // eslint-disable-next-line no-console
    console.warn('[validity] network mocking disabled:', (err && err.message) || err);
  }
}
`;
}

/**
 * AsyncStorage seed module source. STATIC like the mock module: the seed
 * pairs are DATA (`validity-native-data.ts` / the bridge boot fetch) so a
 * scenario's asyncStorage edit doesn't flip contentHash; ValidityNativeRoot
 * passes the freshest pairs it has (boot-fetched, else baked) before mount.
 */
export function renderAsyncStorageSeed(): string {
  return `// @validity-generated — seeds AsyncStorage before the target mounts.
// Data-driven: the pairs come from ./validity-native-data (baked fallback) or
// the host's fresher boot-fetched payload — see ValidityNativeRoot.
/* eslint-disable */
// @ts-nocheck
import AsyncStorage from '@react-native-async-storage/async-storage';

export async function seedAsyncStorage(seed: Array<[string, string]>): Promise<void> {
  const pairs = Array.isArray(seed)
    ? seed.filter(
        (p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'string',
      )
    : [];
  if (pairs.length === 0) return;
  await AsyncStorage.multiSet(pairs);
}
`;
}
