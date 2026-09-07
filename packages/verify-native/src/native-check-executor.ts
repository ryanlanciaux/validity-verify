/**
 * Deterministic hard-tier check executor for the NATIVE playground — the
 * on-device analog of the web sandbox's `check-executor.ts` (which drives a
 * Playwright `Page`). Here we drive a {@link NativeDriver} (agent-device over a
 * simulator/emulator) instead: clicks/types go through the device-automation
 * binary, and element assertions are read off agent-device's ACCESSIBILITY
 * SNAPSHOT rather than the DOM.
 *
 * The verdict semantics are IDENTICAL to the web executor (and folded by the
 * same `foldCheckVerdicts`), so a spec means the same thing on both runtimes:
 *
 *   • `unverifiable` = a selector-DURABILITY finding — the target isn't in the
 *     a11y tree, has no accessible name, or the native primitive the assertion
 *     needs simply doesn't exist (e.g. the snapshot doesn't encode enabled/
 *     disabled/checked). NOT a fail: the agent should fix the durability gap.
 *   • `fail` = a genuine assertion mismatch — element present when it should be
 *     hidden, network status ≠ matcher, console errors over budget.
 *   • `pass` = the assertion held.
 *
 * CASCADE: once a prior ACTION (navigate/click/fill) is unverifiable we never
 * actually drove the flow, so downstream "element not found" / "no network
 * candidate" assertions are unverifiable too (not fails) — mirrors web.
 *
 * SNAPSHOT FORMAT (driver.snapshot()): newline-delimited, one node per line,
 *   `# @eNN [role] "label"`   e.g.   `# @e2 [button] "Submit"`
 * The `@eNN` token is the ref handed to driver.click()/inputText(). The tree
 * encodes ONLY role + accessible name + ref — no visible/enabled/checked state
 * and no count — which is why several web assertions degrade to `unverifiable`
 * here (the channel to observe them doesn't exist on device).
 */
import {
  CHECK_TIMEOUT_MS,
  foldCheckVerdicts,
  isCatchAllPattern,
  isClickCheck,
  isExpectCheck,
  isFillCheck,
  isHoverCheck,
  isNavigateCheck,
  isPressCheck,
  isScrollCheck,
  isSelectCheck,
  isWaitCheck,
  isWaitForRequestCheck,
  matchName,
  parseRegexLiteral,
  pressKeyAndTimes,
  roleMatches,
  rollupNetworkProvenance,
  type A11yExpect,
  type Check,
  type CheckVerdict,
  type CriterionVerdict,
  type NetworkEvidence,
  type Selector,
  type SpecCriterion,
  type StatusMatcher,
} from '@validity.ai/verify-spec';
import { capabilityMissing, type CapabilityProbe } from './agent-device-driver.js';
import type { ExecResult, NativeDriver } from './agent-device-driver.js';
import type { NativePerf } from './native-bridge.js';
import { planRecordedFill, redactSecrets, type ResolvedSecret } from './replay-recording.js';

/** One element parsed out of an agent-device a11y snapshot line. */
export interface SnapshotElement {
  /** The `@eNN` ref token — what driver.click()/inputText()/waitForRef() take. */
  ref: string;
  /** ARIA-ish role, e.g. `button`, `text`, `textbox`. Lower-cased as captured. */
  role: string;
  /** Accessible name/label (the quoted string). */
  name: string;
}

/**
 * A network response observed by the companion's matched-request channel.
 *
 * `provenance` (A4): `declared` = a configured handler served it (pattern on
 * `handlerUrl`); `fabricated` = the device's catch-all invented the body;
 * `undefined` = unknown (old companion without the provenance channel — the
 * executor never promotes unknown to declared, and taint falls back to the
 * unmatched-list inference). The device is UNTRUSTED: run entries through
 * `applyNativeProvenanceGuards` before use so a claimed `declared` that also
 * appears in the unmatched list — or that cites a catch-all pattern — is
 * forced back to `fabricated`.
 */
export interface NativeObservedRequest {
  method: string;
  url: string;
  status: number;
  provenance?: 'declared' | 'fabricated';
  handlerUrl?: string;
}

/**
 * Belt-and-braces provenance guards over the device-reported matched list
 * (A4). The companion stamps `provenance` itself, but the device is untrusted:
 *   1. any entry whose method+url also appears in the parsed `unmatched` list
 *      is forced to `fabricated` regardless of its claim (the catch-all
 *      answered it — the same request cannot ALSO be declared evidence);
 *   2. a declared claim citing a catch-all handler pattern (`'*'`, `'/*'`, …)
 *      is demoted to `fabricated` — not endpoint-specific evidence. The
 *      pattern is KEPT on `handlerUrl` so reason strings can name it.
 * Downward-only: nothing is ever promoted toward `declared`. Pure —
 * unit-testable.
 */
export function applyNativeProvenanceGuards(
  matchedRequests: readonly NativeObservedRequest[],
  unmatchedUrls?: readonly string[],
): NativeObservedRequest[] {
  const unmatched = parseUnmatchedUrls(unmatchedUrls);
  return matchedRequests.map((r) => {
    let provenance = r.provenance;
    if (
      provenance === 'declared' &&
      // methodMatches treats the tolerated bare-URL parse ('*') as any-method.
      unmatched.some((u) => methodMatches(u.method, r.method) && u.url === r.url)
    ) {
      provenance = 'fabricated';
    }
    if (provenance === 'declared' && r.handlerUrl && isCatchAllPattern(r.handlerUrl)) {
      provenance = 'fabricated';
    }
    return provenance === r.provenance ? r : { ...r, provenance };
  });
}

/**
 * Parse an agent-device a11y snapshot into `{ ref, role, name }` rows. Lines
 * look like `# @e2 [button] "Submit"`; blank/garbage lines (no ref+role+label
 * triple) are tolerated and skipped. PURE — unit-tested without a device.
 */
export function parseA11ySnapshot(text: string): SnapshotElement[] {
  const out: SnapshotElement[] = [];
  // `@eNN` … `[role]` … `"label"`. The leading `# ` and any extra columns are
  // ignored; the empty-label case (`""`) is allowed (yields name === '').
  // The label capture is ESCAPE-AWARE — `(?:[^"\\]|\\.)*` consumes `\"` so a
  // label containing a literal double-quote isn't truncated at the inner quote
  // (which would silently break selector resolution → wrong count/state
  // verdicts); the captured value is then unescaped.
  const line = /(@e\d+)\s*\[([^\]]*)\]\s*"((?:[^"\\]|\\.)*)"/;
  for (const raw of text.split('\n')) {
    const m = raw.match(line);
    if (!m) continue;
    const [, ref, role, name] = m;
    out.push({ ref: ref!, role: role!.trim().toLowerCase(), name: unescapeLabel(name!) });
  }
  return out;
}

/** Undo backslash-escaping in an a11y label (e.g. `Say \"hi\"` → `Say "hi"`). */
function unescapeLabel(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/**
 * Resolve a spec `Selector` to the matching `@eNN` refs in a parsed snapshot.
 *
 * Match rule (pragmatic — the snapshot only carries role + accessible name):
 *   • `role`, when set, must satisfy `roleMatches` — strict equality for most
 *     roles, but `heading`/`header`/`sectionheader` are one class and, when the
 *     selector also has a name, fall back to a named text/generic node (iOS
 *     drops the header trait, surfacing headers as plain text). See
 *     `@validity.ai/verify-spec`'s selector-match module.
 *   • `name`/`text`/`label`/`placeholder` are each matched via `matchName`
 *     (case-insensitive SUBSTRING, or a `/regex/flags` literal for dynamic
 *     labels). Multiple set fields must ALL match (AND).
 *   • `testId` is NOT resolvable from this tree (there's no test-id channel in
 *     the snapshot), so a testId-ONLY selector — no role and no text field —
 *     yields `[]`.
 *   • `nth` is applied LAST to the surviving matches.
 */
export function resolveRefs(elements: SnapshotElement[], sel: Selector): string[] {
  const needles = [sel.name, sel.text, sel.label, sel.placeholder].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  // Only `testId` (or an empty selector) gives us nothing to match on against a
  // tree that has no test-id channel → unresolvable.
  if (!sel.role && needles.length === 0) return [];

  const hasName = needles.length > 0;
  const matches = elements.filter((el) => {
    if (sel.role && !roleMatches(sel.role, el.role, hasName)) return false;
    return needles.every((n) => matchName(n, el.name));
  });

  if (sel.nth != null) {
    const picked = matches[sel.nth];
    return picked ? [picked.ref] : [];
  }
  return matches.map((m) => m.ref);
}

/** Human-readable selector for verdict details, e.g. `role=button name="Send"`. */
function describeSelector(sel: Selector): string {
  const parts: string[] = [];
  if (sel.role) parts.push(`role=${sel.role}`);
  if (sel.name) parts.push(`name=${JSON.stringify(sel.name)}`);
  if (sel.text) parts.push(`text=${JSON.stringify(sel.text)}`);
  if (sel.label) parts.push(`label=${JSON.stringify(sel.label)}`);
  if (sel.placeholder) parts.push(`placeholder=${JSON.stringify(sel.placeholder)}`);
  if (sel.testId) parts.push(`testId=${sel.testId}`);
  if (sel.nth != null) parts.push(`nth=${sel.nth}`);
  return parts.join(' ') || '(empty selector)';
}

/**
 * Does an actual HTTP status satisfy a `StatusMatcher`? Exact number, or a
 * class like `2xx` (200–299). Local mirror of the sandbox executor's helper.
 */
export function statusMatches(actual: number, matcher: StatusMatcher): boolean {
  if (typeof matcher === 'number') return actual === matcher;
  const klass = Number(matcher[0]);
  if (Number.isNaN(klass)) return false;
  return Math.floor(actual / 100) === klass;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Does an actual request URL satisfy a spec `url` pattern? Same dialect as the
 * sandbox network-matcher: `'/x/*'` → pathname prefix; a full `http(s)://…`
 * pattern → full-URL substring; a bare path → exact pathname (with a full-URL
 * substring fallback). Local (~8 lines) so @validity.ai/verify-native needn't depend on
 * the sandbox.
 */
export function urlMatches(actual: string, pattern: string): boolean {
  if (pattern.endsWith('/*')) return pathOf(actual).startsWith(pattern.slice(0, -1));
  if (/^https?:\/\//.test(pattern)) return actual.includes(pattern);
  return pathOf(actual) === pattern || actual.includes(pattern);
}

function methodMatches(want: string | undefined, actual: string): boolean {
  if (!want || want === '*') return true;
  return want.toUpperCase() === actual.toUpperCase();
}

/**
 * One un-mocked request the device's PERMISSIVE catch-all answered, parsed from
 * the `rendered` ack's `unmatched` list (entries look like `"GET /api/feed"` or
 * `"GET https://api.example.com/users"`). These are the native analog of web's
 * `matched=false` / `permissive=true` taint signals: the response body was
 * FABRICATED by the catch-all, never produced by a real backend.
 */
interface ParsedUnmatched {
  method: string;
  url: string;
}

/** Parse `"METHOD URL"` unmatched entries into `{method, url}`. A bare URL (no
 * leading method token) is tolerated with an unknown method (matches ANY). */
export function parseUnmatchedUrls(unmatched: readonly string[] | undefined): ParsedUnmatched[] {
  const out: ParsedUnmatched[] = [];
  for (const raw of unmatched ?? []) {
    if (typeof raw !== 'string') continue;
    const m = raw.trim().match(/^([A-Za-z]+)\s+(\S.*)$/);
    if (m) out.push({ method: m[1]!, url: m[2]! });
    else if (raw.trim()) out.push({ method: '*', url: raw.trim() });
  }
  return out;
}

/**
 * Decide whether a native `expect.network` assertion consumed TAINTED evidence.
 *
 * The native bridge has no per-response `permissive`/`matched` flags (unlike
 * web's in-page mock log), so taint is inferred from the `unmatched` channel:
 * any request the device's permissive catch-all answered is recorded there. If
 * a request matching this expect's url/method appears in that list, the
 * "passing" response was a FABRICATED catch-all body — the assertion never ran
 * against a real backend, so a pass over-claims. Mirrors the web executor's
 * `isTaintedByNetworkExpect`. Pure — unit-testable.
 */
export function isTaintedByNativeNetworkExpect(
  unmatched: ParsedUnmatched[],
  want: { url: string; method?: string },
): { tainted: boolean; reasons: string[] } {
  const methodLabel = want.method ?? 'ANY';
  const reasons: string[] = [];
  for (const r of unmatched) {
    // The unmatched entry's own method must satisfy the expect's method filter,
    // AND the entry's url must match the expect's url pattern — the same
    // predicate the expect used to find its "passing" candidate.
    if (!methodMatches(want.method, r.method) && r.method !== '*') continue;
    if (!urlMatches(r.url, want.url)) continue;
    reasons.push(`unmatched ${methodLabel} ${want.url} (answered by the permissive catch-all)`);
  }
  return { tainted: reasons.length > 0, reasons };
}

/**
 * Map an observed native response onto the persisted `NetworkEvidence` shape
 * (A4). Unknown provenance (old companion) yields NO evidence — the executor
 * must never stamp a claim the device didn't make (and the taint step's
 * unmatched-list fallback stays in charge for those). `handlerUrl` is stamped
 * ONLY on declared evidence (the foundation contract) — a guarded-down
 * fabricated entry keeps its pattern on `NativeObservedRequest` for reason
 * strings, never on the evidence.
 */
function nativeEvidence(r: NativeObservedRequest): NetworkEvidence | undefined {
  if (r.provenance !== 'declared' && r.provenance !== 'fabricated') return undefined;
  const evidence: NetworkEvidence = {
    provenance: r.provenance,
    method: r.method,
    url: r.url,
    status: r.status,
  };
  if (r.provenance === 'declared' && r.handlerUrl) evidence.handlerUrl = r.handlerUrl;
  return evidence;
}

/** First line of an error/exec failure, for compact verdict details. */
function firstLine(s: string): string {
  return s.split('\n')[0] ?? s;
}

// Native has no Playwright-style actionability auto-wait: a check takes a
// single a11y snapshot, so it can race a screen transition (after a navigate
// or a click). To heal that, presence-oriented resolution RE-SNAPSHOTS a few
// times, and an action SETTLES briefly so the transition begins before the
// next check reads the tree. Delays are zeroed under vitest so the fake-driver
// suites stay fast (the retry loop still runs, just without wall-clock sleep).
const RESOLVE_RETRIES = 5;
const RESOLVE_DELAY_MS = process.env.VITEST ? 0 : 250;
const ACTION_SETTLE_MS = process.env.VITEST ? 0 : 500;
// How many page-downs to try when scroll-to-find hunts for an off-screen
// element (and, +2, how many page-ups scroll-to-top tries to restore). Bounded
// so an infinite/very-long list can't spin forever; the identical-snapshot
// end-of-content check usually stops it well before the cap.
const SCROLL_FIND_PAGES = 6;

/** Mutable flag threaded through a criterion's checks so the executor knows it
 * scrolled the screen (and must restore the top before the evidence shot). */
interface ScrollState {
  scrolled: boolean;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * Snapshot the device + resolve a selector to refs. When `waitForPresence` is
 * true (click / fill / expect-present), re-snapshot up to RESOLVE_RETRIES times
 * until at least one element matches — the native analog of Playwright's
 * actionability wait, so a check doesn't resolve against a pre-transition tree.
 * Absence assertions (state:hidden / count:0) pass `waitForPresence: false` and
 * take a single shot (their expected end state is "not there").
 *
 * SCROLL-TO-FIND: a static native snapshot only encodes the VISIBLE viewport
 * (RN virtualized lists mount only on-screen rows), so a below-the-fold element
 * is absent from the tree and would falsely degrade to `unverifiable`. When the
 * retry loop can't find a presence-oriented target and the driver supports
 * scrolling, scroll DOWN page-by-page and re-resolve — the native analog of
 * Playwright's scroll-into-view — stopping at the asserted element or
 * end-of-content. Best-effort: a driver without `scroll`, or an unsupported
 * scroll verb, leaves the result exactly as it was (today's behavior; no new
 * false fail). Absence assertions never scroll (an off-screen element still
 * satisfies "not in the visible viewport").
 */
async function resolveOnDevice(
  driver: NativeDriver,
  sel: Selector,
  waitForPresence: boolean,
  scrollState?: ScrollState,
): Promise<{ refs: string[]; snapshotError?: string }> {
  const attempts = waitForPresence ? RESOLVE_RETRIES : 1;
  let refs: string[] = [];
  let lastSnap = '';
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(RESOLVE_DELAY_MS);
    try {
      lastSnap = await driver.snapshot();
    } catch (err) {
      return { refs: [], snapshotError: firstLine((err as Error).message) };
    }
    refs = resolveRefs(parseA11ySnapshot(lastSnap), sel);
    if (refs.length > 0) return { refs };
  }

  if (
    waitForPresence &&
    typeof driver.scroll === 'function' &&
    !(await verbUnsupported(driver, 'scroll'))
  ) {
    const scroll = driver.scroll.bind(driver);
    for (let p = 0; p < SCROLL_FIND_PAGES; p++) {
      const res = await tryExec(() => scroll('down'));
      if (!res.ok) break; // scroll unsupported → keep the pre-scroll result
      if (scrollState) scrollState.scrolled = true;
      await sleep(RESOLVE_DELAY_MS);
      let snap: string;
      try {
        snap = await driver.snapshot();
      } catch (err) {
        return { refs: [], snapshotError: firstLine((err as Error).message) };
      }
      refs = resolveRefs(parseA11ySnapshot(snap), sel);
      if (refs.length > 0) return { refs };
      // A scroll that didn't change the tree = we hit the bottom; stop early.
      if (snap === lastSnap) break;
      lastSnap = snap;
    }
  }
  return { refs };
}

/**
 * Best-effort scroll back to the top after scroll-to-find, so the screenshot the
 * verify run captures AFTER the checks shows the same top-of-screen frame a
 * non-scrolling render would. Stops once the tree stops changing (top reached)
 * or the cap is hit; any failure is swallowed (the shot is still useful).
 */
async function scrollToTop(driver: NativeDriver): Promise<void> {
  if (typeof driver.scroll !== 'function') return;
  if (await verbUnsupported(driver, 'scroll')) return;
  const scroll = driver.scroll.bind(driver);
  let last = '';
  for (let p = 0; p < SCROLL_FIND_PAGES + 2; p++) {
    const res = await tryExec(() => scroll('up'));
    if (!res.ok) return;
    await sleep(RESOLVE_DELAY_MS);
    let snap: string;
    try {
      snap = await driver.snapshot();
    } catch {
      return;
    }
    if (snap === last) return; // tree stopped changing → at the top
    last = snap;
  }
}

/**
 * Run a driver exec, normalizing BOTH a thrown error AND a non-zero exit code
 * into a failure signal — agent-device reports an unsupported/failed verb via a
 * non-zero exit (defaultRunner resolves, it does not throw), so a `type` the
 * binary lacks must still register as "did not happen".
 */
/**
 * One `agent-device capabilities` answer per driver, for the life of the
 * process.
 *
 * Memoized because the check executor asks "can this device scroll?" once per
 * unresolved selector, and a subprocess per question would cost more than the
 * wasted scroll it is there to avoid. Keyed weakly so a driver can be collected
 * normally; the promise (not the value) is cached so concurrent askers share
 * one probe instead of racing several.
 */
const capabilityProbes = new WeakMap<NativeDriver, Promise<CapabilityProbe | undefined>>();

function probeCapabilities(driver: NativeDriver): Promise<CapabilityProbe | undefined> {
  let cached = capabilityProbes.get(driver);
  if (!cached) {
    // A driver without the method, or a probe that throws, resolves undefined —
    // "could not ask", which every caller must treat as "assume supported and
    // find out the old way", never as "unsupported".
    cached = (driver.capabilities?.() ?? Promise.resolve(undefined)).catch(() => undefined);
    capabilityProbes.set(driver, cached);
  }
  return cached;
}

/**
 * Can we skip attempting `verb` outright, because the tool says this device
 * does not support it?
 *
 * Only a probe that ANSWERED and omits the verb returns true. This replaces
 * spending a real command to discover an `UNSUPPORTED_OPERATION`, but it does
 * NOT replace handling that error: `capabilities` reports which verbs exist,
 * not which argv shapes they accept (0.20.3 lists `type` while rejecting
 * `type <ref> <text>`), so the failed-exec path stays as the backstop.
 *
 * Still true on 0.20.5, re-checked 2026-08-06 against the CLI's own help:
 * `agent-device type <text> [--delay-ms <ms>]` — "Append text to the focused
 * field", no target positional. The driver's text-entry argv remains `fill
 * <target> <text>`.
 */
async function verbUnsupported(driver: NativeDriver, verb: string): Promise<boolean> {
  return capabilityMissing(await probeCapabilities(driver), verb) === true;
}

async function tryExec(fn: () => Promise<ExecResult>): Promise<{ ok: boolean; err?: string }> {
  try {
    const res = await fn();
    if (res && res.code !== 0) {
      return { ok: false, err: firstLine(res.stderr || res.stdout || `exit ${res.code}`) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, err: firstLine((err as Error).message) };
  }
}

/**
 * Execute a criterion's checks against a native driver, returning one verdict
 * per check. Network/console observation is PUSHED in (matchedRequests /
 * consoleErrorCount) by the orchestrator from the companion bridge — unlike the
 * web executor we can't attach listeners to the device — and an absent channel
 * is `unverifiable`, not a fail.
 */
export async function executeNativeChecks(args: {
  driver: NativeDriver;
  checks: Check[];
  navigate?: (url: string) => Promise<void>;
  matchedRequests?: NativeObservedRequest[];
  consoleErrorCount?: number;
  perf?: NativePerf;
  /**
   * Why `perf` is absent for this render, when the caller knows (see
   * capture-native's nativePerfUnavailableReason). Used verbatim as the
   * `expect.performance` unverifiable detail so "old companion" and "confirmed
   * off the ack path" stop sharing one misleading message.
   */
  perfUnavailableReason?: string;
  /** Resolved scenario secrets for secret-safe fills (see runOneNativeCheck). */
  secrets?: ReadonlyArray<ResolvedSecret>;
}): Promise<CheckVerdict[]> {
  const { driver, checks, navigate, matchedRequests, consoleErrorCount, perf } = args;
  const { perfUnavailableReason } = args;

  const verdicts: CheckVerdict[] = [];
  // Tracks whether scroll-to-find moved the screen during this criterion, so we
  // can restore the top before the verify run's post-checks screenshot.
  const scrollState: ScrollState = { scrolled: false };
  // Once a prerequisite action (navigate/click/fill) is unverifiable, the flow
  // was never driven — downstream "no candidate" / "not found" assertions are
  // unverifiable too, not hard fails (mirrors the web executor).
  let priorActionUnverifiable = false;
  // Whether ANY action (pass OR unverifiable) preceded this check. Native's
  // network/console observation is captured at the RENDER ACK — BEFORE any
  // check action runs. So a request triggered by a click/fill (after the ack)
  // is NOT observable via the current bridge: a `expect.network` after an
  // action must be `unverifiable` ("observed at render time only"), never a
  // false `fail`. A render-time `expect.network` (no preceding action) with no
  // match is a genuine `fail` (the screen should have fetched on mount).
  let priorActionRan = false;

  for (const check of checks) {
    const verdict = await runOneNativeCheck({
      driver,
      check,
      navigate,
      matchedRequests,
      consoleErrorCount,
      perf,
      perfUnavailableReason,
      secrets: args.secrets,
      priorActionUnverifiable,
      priorActionRan,
      scrollState,
    });
    if (verdict.detail !== undefined) {
      verdict.detail = redactSecrets(verdict.detail, args.secrets ?? []);
    }
    verdicts.push(verdict);
    const isAction =
      isNavigateCheck(check) ||
      isClickCheck(check) ||
      isPressCheck(check) ||
      isHoverCheck(check) ||
      isFillCheck(check) ||
      isWaitCheck(check) ||
      isWaitForRequestCheck(check) ||
      isSelectCheck(check) ||
      isScrollCheck(check);
    if (isAction) {
      priorActionRan = true;
      if (verdict.status === 'unverifiable') priorActionUnverifiable = true;
    }
  }
  // If any check scrolled to reach off-screen content, restore the top so the
  // evidence screenshot the verify run takes next matches a non-scrolling
  // render (best-effort — see scrollToTop).
  if (scrollState.scrolled) await scrollToTop(driver);
  return verdicts;
}

async function runOneNativeCheck(args: {
  driver: NativeDriver;
  check: Check;
  navigate?: (url: string) => Promise<void>;
  matchedRequests?: NativeObservedRequest[];
  consoleErrorCount?: number;
  perf?: NativePerf;
  perfUnavailableReason?: string;
  /**
   * Resolved scenario secrets (`scenarios[].secrets` declarations whose env
   * vars are set), for secret-safe fills — see the fill branch and
   * `planRecordedFill`. Absent means "no secrets resolved": a placeholder
   * fill then blocks (unverifiable), never types the literal.
   */
  secrets?: ReadonlyArray<ResolvedSecret>;
  priorActionUnverifiable: boolean;
  priorActionRan: boolean;
  scrollState?: ScrollState;
}): Promise<CheckVerdict> {
  const {
    driver,
    check,
    navigate,
    matchedRequests,
    consoleErrorCount,
    perf,
    perfUnavailableReason,
    priorActionUnverifiable,
    priorActionRan,
    scrollState,
  } = args;
  const pass = (detail?: string): CheckVerdict => ({ check, status: 'pass', detail });
  const fail = (detail: string): CheckVerdict => ({ check, status: 'fail', detail });
  const unverifiable = (detail: string): CheckVerdict => ({
    check,
    status: 'unverifiable',
    detail,
  });

  // ---- navigate ---------------------------------------------------------
  if (isNavigateCheck(check)) {
    const url = check.navigate.url;
    const res = await tryExec(() =>
      navigate
        ? navigate(url).then(() => ({ code: 0, stdout: '', stderr: '' }))
        : driver.openUrl(url),
    );
    // navigate is a PREREQUISITE ACTION (like click/fill), not an assertion: a
    // failed navigate means the flow was never driven onto the target screen,
    // so it's `unverifiable` ("couldn't test"), NOT a `fail` ("feature broken").
    // Returning unverifiable here sets priorActionUnverifiable in
    // executeNativeChecks, cascading every downstream assertion to unverifiable
    // — the same outcome the web executor produces (where navigate happens at
    // capture level before page-driving, never as a fail-able CHECK).
    if (!res.ok)
      return unverifiable(
        `AC unverifiable: navigation to ${url} failed (could not change screen) — ${res.err}`,
      );
    // openUrl is a fire-and-forget deep-link intent — it returns on DISPATCH,
    // not on render. Settle so the transition begins before the next check
    // snapshots (which also re-snapshots via resolveOnDevice). NOTE: without a
    // bridge `rendered` ack the executor can't positively confirm the new
    // screen, so a navigate verdict is "dispatched", not "render-confirmed".
    await sleep(ACTION_SETTLE_MS);
    return pass(`navigated to ${url}`);
  }

  // ---- click ------------------------------------------------------------
  if (isClickCheck(check)) {
    const sel = check.click;
    const desc = describeSelector(sel);
    const { refs, snapshotError } = await resolveOnDevice(driver, sel, true, scrollState);
    if (snapshotError !== undefined) {
      return unverifiable(
        `AC unverifiable: could not snapshot the a11y tree for ${desc} — ${snapshotError}`,
      );
    }
    const ref = refs[0];
    if (ref === undefined) {
      return unverifiable(
        `AC unverifiable: no element ${desc} in the a11y tree (add an accessible name/testId)`,
      );
    }
    const res = await tryExec(() => driver.click(ref));
    if (!res.ok)
      return unverifiable(`AC unverifiable: could not click ${desc} (${ref}) — ${res.err}`);
    // Let any transition the click triggered begin before the next check reads.
    await sleep(ACTION_SETTLE_MS);
    return pass(`clicked ${desc} (${ref})`);
  }

  // ---- press / hover — no honest native analog --------------------------
  // Keyboard press and pointer hover have no channel in agent-device automation
  // (there is no hardware-keyboard press verb, and a touch UI has no hover
  // state), so we never fake them. Both are ACTIONS returning `unverifiable`,
  // which cascades downstream expects to unverifiable (the flow was never
  // driven) — mirrors the action-network honesty message: point at the web
  // runtime / the Playwright export.
  if (isPressCheck(check)) {
    const { key } = pressKeyAndTimes(check.press);
    return unverifiable(
      `press '${key}' is not executable on the native runtime (no hardware-keyboard press ` +
        `channel) — assert keyboard reachability in the web runtime or the Playwright export`,
    );
  }
  if (isHoverCheck(check)) {
    return unverifiable(
      `hover ${describeSelector(check.hover)} is not executable on the native runtime (touch UIs ` +
        `have no hover state) — assert hover in the web runtime or the Playwright export`,
    );
  }

  // ---- fill -------------------------------------------------------------
  if (isFillCheck(check)) {
    const { value, ...sel } = check.fill;
    const desc = describeSelector(sel);
    const { refs, snapshotError } = await resolveOnDevice(driver, sel, true, scrollState);
    if (snapshotError !== undefined) {
      return unverifiable(
        `AC unverifiable: could not snapshot the a11y tree for ${desc} — ${snapshotError}`,
      );
    }
    const ref = refs[0];
    if (ref === undefined) {
      return unverifiable(
        `AC unverifiable: no element ${desc} in the a11y tree (add an accessible name/testId)`,
      );
    }
    // SECRET-SAFE FILL. `planRecordedFill` decides three things at once: the
    // live text the device receives (a `${NAME}` placeholder resolves to the
    // declared secret's value), whether the armed `.ad` recording may keep
    // publishing, and whether the fill may run at all — a placeholder nothing
    // supplies is BLOCKED, because typing the literal "${NAME}" would score a
    // typo, not the app. `recordAs` re-derives the driver-side `--record-as`
    // from the plan's flags so the policy lives in exactly one place.
    const rec = driver.recordingState?.();
    const armed = rec !== undefined && !rec.published && rec.abandoned === undefined;
    const plan = planRecordedFill({ armed, target: ref, value, secrets: args.secrets ?? [] });
    if (plan.blocked) {
      return unverifiable(`AC unverifiable: ${plan.reason}`);
    }
    const recordAsAt = plan.flags.indexOf('--record-as');
    const recordAs = recordAsAt >= 0 ? plan.flags[recordAsAt + 1] : undefined;
    const res = await tryExec(() =>
      recordAs !== undefined
        ? driver.inputText(ref, plan.value, { recordAs })
        : driver.inputText(ref, plan.value),
    );
    if (!res.ok) {
      return unverifiable(
        `AC unverifiable: native text input unavailable (agent-device \`fill\` failed; ` +
          `configure native.agentDevice.commands.type) — ${res.err}`,
      );
    }
    // A literal that CONTAINS a declared secret's value poisons the armed
    // recording (the .ad would carry the secret to disk) — the fill itself ran,
    // only the publication is withdrawn, and the reason travels with it.
    if (!plan.publishable && plan.reason !== undefined) {
      driver.abandonRecording?.(plan.reason);
    }
    await sleep(ACTION_SETTLE_MS);
    return pass(`filled ${desc} (${ref})`);
  }

  // ---- wait -------------------------------------------------------------
  if (isWaitCheck(check)) {
    const body = check.wait;
    if (body.ms !== undefined) {
      await sleep(body.ms);
      return pass(`waited ${body.ms}ms`);
    }
    const sel = body.for!;
    const state = body.state ?? 'visible';
    const desc = describeSelector(sel);
    if (state === 'hidden') {
      const deadline = Date.now() + CHECK_TIMEOUT_MS;
      for (;;) {
        const { refs, snapshotError } = await resolveOnDevice(driver, sel, false, scrollState);
        if (snapshotError !== undefined) {
          return unverifiable(
            `AC unverifiable: could not snapshot the a11y tree for ${desc} — ${snapshotError}`,
          );
        }
        if (refs.length === 0) return pass(`waited for ${desc} to be hidden`);
        if (Date.now() >= deadline) {
          return priorActionUnverifiable
            ? unverifiable(
                `timed out waiting for ${desc} to be hidden — prior action was unverifiable`,
              )
            : fail(`timed out waiting for ${desc} to be hidden`);
        }
        await sleep(RESOLVE_DELAY_MS || 50);
      }
    }
    // visible / attached — resolveOnDevice already retries + scroll-to-find.
    const { refs, snapshotError } = await resolveOnDevice(driver, sel, true, scrollState);
    if (snapshotError !== undefined) {
      return unverifiable(
        `AC unverifiable: could not snapshot the a11y tree for ${desc} — ${snapshotError}`,
      );
    }
    if (refs.length === 0) {
      return priorActionUnverifiable
        ? unverifiable(
            `timed out waiting for ${desc} to be ${state} — prior action was unverifiable`,
          )
        : fail(`timed out waiting for ${desc} to be ${state}`);
    }
    const ref = refs[0]!;
    if (typeof driver.waitForRef === 'function') {
      const res = await tryExec(() => driver.waitForRef(ref, CHECK_TIMEOUT_MS));
      if (!res.ok) {
        return priorActionUnverifiable
          ? unverifiable(`waitForRef ${desc} failed — prior action was unverifiable`)
          : fail(`timed out waiting for ${desc} to be ${state}`);
      }
    }
    return pass(`waited for ${desc} to be ${state} (${ref})`);
  }

  // ---- waitForRequest ---------------------------------------------------
  // Native observes network ONLY at the render ack (matchedRequests), same
  // channel as expect.network. After an action the log is stale → unverifiable.
  // No match on a render-time wait is fail, never pass.
  if (isWaitForRequestCheck(check)) {
    const want = check.waitForRequest;
    const methodLabel = want.method ?? 'ANY';
    const matches = (r: NativeObservedRequest): boolean => {
      if (!methodMatches(want.method, r.method)) return false;
      const re = parseRegexLiteral(want.url);
      return re ? re.test(r.url) : urlMatches(r.url, want.url);
    };
    const detail = `no request observed for ${methodLabel} ${want.url}`;
    // Stale-match guard: render-time matchedRequests are captured at the ack,
    // BEFORE any check action. A boot-time GET must never satisfy a
    // waitForRequest that follows a click. When a prior action ran, the log
    // is stale regardless of candidates — same honesty as expect.network.
    if (priorActionRan) {
      return unverifiable(
        `${detail} — native observes network only at render time; a request triggered ` +
          `by a preceding interaction is not observable via the bridge (use the web ` +
          `runtime or the Playwright export to assert action-triggered network)`,
      );
    }
    const candidates = (matchedRequests ?? []).filter(matches);
    if (candidates.length > 0) {
      const hit = candidates[0]!;
      return pass(`${hit.method} ${hit.url} matched ${methodLabel} ${want.url}`);
    }
    if (matchedRequests === undefined) {
      return unverifiable(`${detail} — native request log unavailable (rebuild the companion)`);
    }
    if (priorActionUnverifiable) {
      return unverifiable(`${detail} — prior action was unverifiable`);
    }
    return fail(detail);
  }

  // ---- select -----------------------------------------------------------
  // Native pickers (iOS wheel, Android dialog, custom RN lists) are not
  // `<select>` — guessing would false-green. Honest degradation.
  if (isSelectCheck(check)) {
    return unverifiable(
      `select is not executable on the native runtime (pickers differ per platform) — ` +
        `use click + click on the option, or assert the selection in the web runtime`,
    );
  }

  // ---- scroll -----------------------------------------------------------
  if (isScrollCheck(check)) {
    const body = check.scroll;
    if (body.intoView && body.selector) {
      const desc = describeSelector(body.selector);
      if (typeof driver.scroll !== 'function' || (await verbUnsupported(driver, 'scroll'))) {
        return unverifiable(
          `scroll intoView is not executable on this device (no scroll verb) — ${desc}`,
        );
      }
      const { refs, snapshotError } = await resolveOnDevice(
        driver,
        body.selector,
        true,
        scrollState,
      );
      if (snapshotError !== undefined) {
        return unverifiable(
          `AC unverifiable: could not snapshot the a11y tree for ${desc} — ${snapshotError}`,
        );
      }
      if (refs.length === 0) {
        return unverifiable(
          `AC unverifiable: no element ${desc} in the a11y tree to scroll into view`,
        );
      }
      return pass(`scrolled ${desc} into view (${refs[0]})`);
    }
    if (body.to) {
      if (typeof driver.scroll !== 'function' || (await verbUnsupported(driver, 'scroll'))) {
        return unverifiable(
          `scroll to ${body.to} is not executable on this device (no scroll verb)`,
        );
      }
      const dir = body.to === 'bottom' ? 'down' : 'up';
      const scroll = driver.scroll.bind(driver);
      let last = '';
      for (let p = 0; p < SCROLL_FIND_PAGES + 2; p++) {
        const res = await tryExec(() => scroll(dir));
        if (!res.ok) {
          return unverifiable(`could not scroll ${dir} — ${res.err}`);
        }
        if (scrollState) scrollState.scrolled = true;
        await sleep(RESOLVE_DELAY_MS);
        let snap: string;
        try {
          snap = await driver.snapshot();
        } catch (err) {
          return unverifiable(
            `AC unverifiable: could not snapshot after scroll — ${firstLine((err as Error).message)}`,
          );
        }
        if (snap === last) break;
        last = snap;
      }
      return pass(`scrolled to ${body.to}`);
    }
    if (body.by) {
      return unverifiable(
        `scroll by pixel delta is not executable on the native runtime (no pixel-level ` +
          `wheel) — use to: top/bottom or intoView, or the web runtime`,
      );
    }
    return unverifiable('scroll check has no to/by/intoView (schema should have rejected this)');
  }

  // ---- expect -----------------------------------------------------------
  if (isExpectCheck(check)) {
    const body = check.expect;

    // expect.element
    if (body.element) {
      const el = body.element;
      const sel: Selector = el;
      const desc = describeSelector(sel);
      // Absence assertions (state:hidden / count:0) expect "not there" as the
      // end state, so don't re-snapshot waiting for presence; everything else
      // waits for the element to appear (heals a transition race).
      const isAbsenceAssertion = el.state === 'hidden' || el.count === 0;
      const { refs, snapshotError } = await resolveOnDevice(
        driver,
        sel,
        !isAbsenceAssertion,
        scrollState,
      );
      if (snapshotError !== undefined) {
        return unverifiable(
          `AC unverifiable: could not snapshot the a11y tree for ${desc} — ${snapshotError}`,
        );
      }
      const n = refs.length;

      // Explicit count assertion is a genuine assertion → a mismatch is a fail
      // (or unverifiable when a prior action couldn't be driven).
      if (el.count !== undefined) {
        if (n !== el.count) {
          return priorActionUnverifiable
            ? unverifiable(
                `expected ${el.count} element(s) matching ${desc}, found ${n} — prior action was unverifiable`,
              )
            : fail(`expected ${el.count} element(s) matching ${desc}, found ${n}`);
        }
        // count matched (incl. count:0 absence) and no further state to check.
        if (!el.state) return pass(`found ${n} element(s) matching ${desc}`);
      }

      // State assertion.
      if (el.state) {
        // The snapshot encodes only presence (role + name), so presence ≈
        // visible. enabled/disabled/checked aren't encoded → durability finding.
        if (el.state === 'visible' || el.state === 'hidden') {
          const present = n > 0;
          const ok = el.state === 'visible' ? present : !present;
          if (!ok) {
            return priorActionUnverifiable
              ? unverifiable(`expected ${desc} to be ${el.state} — prior action was unverifiable`)
              : fail(`expected ${desc} to be ${el.state} (a11y tree presence: ${present})`);
          }
          return pass(`${desc} is ${el.state} (a11y tree presence: ${present})`);
        }
        if (el.state === 'focused') {
          return unverifiable('focus state is not encoded in the native accessibility snapshot');
        }
        return unverifiable(`native a11y snapshot does not encode ${el.state} state`);
      }

      // No count, no state → presence check. Not-found is a durability FINDING
      // (unverifiable), not a feature failure.
      if (n < 1) {
        return unverifiable(
          `AC unverifiable: no element ${desc} in the a11y tree (add an accessible name/testId)`,
        );
      }
      return pass(`found ${n} element(s) matching ${desc}`);
    }

    // expect.network
    if (body.network) {
      if (matchedRequests === undefined) {
        return unverifiable('native matched-request channel unavailable — rebuild the companion');
      }
      const want = body.network;
      const wantStatus: StatusMatcher = want.status ?? '2xx';
      const methodLabel = want.method ?? 'ANY';
      const candidates = matchedRequests.filter(
        (r) => methodMatches(want.method, r.method) && urlMatches(r.url, want.url),
      );
      if (candidates.length === 0) {
        const detail = `no ${methodLabel} ${want.url} observed`;
        // A prior unverifiable action means the flow never ran.
        if (priorActionUnverifiable) {
          return unverifiable(`${detail} — prior action was unverifiable`);
        }
        // Native observes network ONLY at the render ack (before check actions
        // run). A request a click/fill should have triggered fires AFTER that
        // window and isn't observable via the current bridge — so this is
        // unverifiable (a known native limitation), NOT a false fail. Only a
        // RENDER-TIME network expect (no preceding action) is a genuine fail.
        if (priorActionRan) {
          return unverifiable(
            `${detail} — native observes network only at render time; a request triggered ` +
              `by a preceding interaction is not observable via the bridge (use the web ` +
              `runtime or the Maestro/Playwright export to assert action-triggered network)`,
          );
        }
        return fail(detail);
      }
      const satisfying = candidates.filter((r) => statusMatches(r.status, wantStatus));
      if (satisfying.length > 0) {
        // Attribution (A4, web parity): the verdict is keyed to the response
        // that DECIDED it. Prefer declared > unknown (old companion — no
        // provenance channel) > fabricated. An unknown winner gets NO evidence
        // stamp (never promoted to declared); the criterion-level taint step
        // then falls back to the unmatched-list inference for it.
        const winner =
          satisfying.find((r) => r.provenance === 'declared') ??
          satisfying.find((r) => r.provenance === undefined) ??
          satisfying[0]!;
        const base = `${winner.method} ${winner.url} → ${winner.status} matches ${wantStatus}`;
        const detail =
          winner.provenance === 'declared'
            ? winner.handlerUrl
              ? `${base} — proven against declared mock (handler '${winner.handlerUrl}' in .validity/config.ts)`
              : `${base} — proven against declared mock`
            : winner.provenance === 'fabricated'
              ? winner.handlerUrl
                ? `${base} — response fabricated: catch-all handler '${winner.handlerUrl}' is not endpoint-specific evidence`
                : `${base} — response fabricated by the device catch-all (no declared handler for this endpoint)`
              : base;
        const evidence = nativeEvidence(winner);
        return evidence ? { ...pass(detail), networkEvidence: evidence } : pass(detail);
      }
      const seen = candidates.map((r) => r.status).join(', ');
      const evidence = nativeEvidence(candidates[0]!);
      const failVerdict = fail(
        `${methodLabel} ${want.url} responded ${seen} but expected status ${wantStatus}`,
      );
      // Stamp the deciding (first) candidate on the fail too — provenance never
      // upgrades/downgrades a fail, it only annotates the report.
      return evidence ? { ...failVerdict, networkEvidence: evidence } : failVerdict;
    }

    // expect.console
    if (body.console) {
      if (consoleErrorCount === undefined) {
        return unverifiable('native console channel unavailable — rebuild the companion');
      }
      if (consoleErrorCount <= body.console.errors) {
        return pass(`console.error count ${consoleErrorCount} ≤ ${body.console.errors}`);
      }
      return fail(
        `console.error count ${consoleErrorCount} exceeds allowed ${body.console.errors}`,
      );
    }

    // expect.screenshot — the executor can't compare against a baseline (no
    // screenshot path / project root here), exactly as in the web executor.
    // The verify run computes the baseline diff after the shot and upgrades
    // this stub to pass/fail; this stub only survives when no baseline exists
    // yet for the variant. Keep the message in parity with the web executor.
    if (body.screenshot) {
      return unverifiable('no baseline exists yet for this variant');
    }

    // expect.performance — timing is measured INSIDE the companion app's JS
    // (React.Profiler + a monotonic ready clock) and rides the existing bridge
    // `rendered` ack as `perf` (see NativePerf). Mirrors the web executor at
    // packages/verify-web/src/check-executor.ts: map the metric enum to a
    // `<metric>Ms` field and budget it against maxMs. HONESTY INVARIANT: an
    // unmeasurable metric is `unverifiable`, NEVER a silent pass.
    if (body.performance) {
      const { metric, maxMs } = body.performance;
      // RULE 1: load / firstContentfulPaint have no RN source (no Navigation or
      // Paint Timing analog on device) — never claim them, always unverifiable.
      if (metric === 'load' || metric === 'firstContentfulPaint') {
        return unverifiable(
          `${metric} not measurable on native (no Navigation/Paint Timing analog)`,
        );
      }
      // RULE 2: no perf object at all — no timing was carried for THIS render.
      // The caller knows why (old companion vs. a render confirmed off the
      // bridge-ack path, which has no ack to carry timing) and passes the
      // reason; the generic message is the legacy fallback for callers that
      // don't. Never a pass, and never a silent one either: this used to be a
      // ~1-in-4-per-sweep lottery that told everyone to rebuild a companion
      // that was already current.
      if (perf === undefined) {
        return unverifiable(
          perfUnavailableReason ?? 'native perf channel unavailable — rebuild the companion',
        );
      }
      // RULE 3: perf present but this metric's field is absent (e.g. updateMs
      // when no update commit fired) — web parity: not measured on this render.
      const field = `${metric}Ms` as keyof NativePerf;
      const measured = perf[field];
      if (typeof measured !== 'number') {
        return unverifiable(`${metric} not measured on this render`);
      }
      // RULES 4/5: measured against the budget.
      if (measured <= maxMs) {
        return pass(`${metric} ${measured}ms ≤ budget ${maxMs}ms`);
      }
      return fail(`${metric} ${measured}ms exceeds budget ${maxMs}ms`);
    }

    // expect.a11y — the native a11y snapshot carries ONLY role + accessible
    // name (no severity, no axe rule id, no DOM/CSS), so it can detect the
    // single most common CRITICAL violation — a labelable element with no
    // accessible name (axe `button-name` / `aria-input-field-name`) — but NOT
    // the rest of the axe rule catalog (color-contrast, tab-order, valid-aria,
    // …). Because we can only OBSERVE missing-name and cannot certify the
    // ABSENCE of the rules we can't see, native returns ONLY two verdicts:
    //   • `fail`  — detected critical missing-name violations strictly exceed
    //     maxViolations. A critical violation exceeds ANY severity floor, so
    //     this fail is valid at every `severity` setting.
    //   • `unverifiable` — otherwise. We never return `pass`: a pass would
    //     launder the unobservable rules into a green, claiming the page meets
    //     the full axe budget when the snapshot can't see most of it. Use the
    //     web runtime or the Playwright export for a real axe pass/fail.
    if (body.a11y) {
      const want = body.a11y;
      let snapshotText: string;
      try {
        snapshotText = await driver.snapshot();
      } catch (err) {
        return unverifiable(
          `AC unverifiable: could not snapshot the a11y tree for expect.a11y — ${firstLine(
            (err as Error).message,
          )}`,
        );
      }
      const violations = countNativeA11yViolations(parseA11ySnapshot(snapshotText));
      const verdict = nativeA11yVerdict(violations, want);
      const maxViolations = want.maxViolations ?? 0;
      if (verdict.status === 'fail') {
        // A detected over-budget violation is real regardless of any prior
        // action: the element with no accessible name is on the screen we DID
        // snapshot. So a fail stays a fail even after an unverifiable action.
        const offenders = violations
          .slice(0, 5)
          .map((v) => `${v.role} ${v.ref}`)
          .join(', ');
        return fail(
          `native a11y: ${verdict.count} critical missing-name violation${
            verdict.count === 1 ? '' : 's'
          } exceeds ${maxViolations} allowed (${offenders})`,
        );
      }
      // unverifiable — either a prior action was unverifiable (we never reached
      // the asserted state) or the detected count is within budget but the
      // snapshot cannot certify the absence of the rest of the axe rule set.
      if (priorActionUnverifiable) {
        return unverifiable(`expect.a11y could not be evaluated — prior action was unverifiable`);
      }
      return unverifiable(
        `native a11y: ${verdict.count} critical missing-name violation${
          verdict.count === 1 ? '' : 's'
        } detected (≤ ${maxViolations}); the a11y snapshot carries only role + name, so it ` +
          `cannot certify the absence of the rest of the axe rule set (color-contrast, ` +
          `tab-order, valid-aria, …) — use the web runtime or the Playwright export for a ` +
          `real axe pass/fail`,
      );
    }

    // expect.command — RUN-LEVEL (A5): executed once per verify run on the
    // HOST (see @validity.ai/verify-spec command-check.ts), never on the device.
    // Defense in depth (parity with the web executor): if the run-level
    // exclusion regresses and one leaks into a device render, this stub can
    // only mint `unverifiable` — never a pass.
    if (body.command) {
      return unverifiable(
        `expect.command executes once per verify run at the run level — it is never ` +
          `executed on the device (if you see this, run-level wiring skipped it)`,
      );
    }
  }

  // Unreachable: a Check is always one of the kinds above.
  return unverifiable('unknown check kind');
}

/**
 * Roles whose accessible name axe-core requires — a labelable element with an
 * empty name is a CRITICAL violation (axe `button-name`,
 * `aria-input-field-name`, `link-name`, …). This is the subset of the axe rule
 * set that the native a11y snapshot (role + name only) lets us detect honestly.
 */
const LABELABLE_ROLES = new Set([
  'button',
  'textbox',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'combobox',
  'searchbox',
  'slider',
  'spinbutton',
]);

/** A native a11y violation we CAN detect from the snapshot — always the axe
 * `critical` impact (a labelable element with no accessible name). */
export interface NativeA11yViolation {
  ref: string;
  role: string;
  impact: 'critical';
}

/**
 * Detect missing-accessible-name violations from a parsed native a11y
 * snapshot: a labelable role (button/textbox/link/…) with an empty or
 * whitespace-only name. The snapshot carries ONLY role + name, so this is the
 * only axe subset evaluable on device — other rules (color contrast, tab
 * order, valid-aria, …) need DOM/CSS the snapshot doesn't encode. Every
 * detected violation is axe `critical` impact. PURE — unit-tested without a
 * device.
 */
export function countNativeA11yViolations(elements: SnapshotElement[]): NativeA11yViolation[] {
  const out: NativeA11yViolation[] = [];
  for (const el of elements) {
    if (!LABELABLE_ROLES.has(el.role)) continue;
    if (el.name.trim() === '') out.push({ ref: el.ref, role: el.role, impact: 'critical' });
  }
  return out;
}

/**
 * Fold detected native a11y violations into a verdict. KEY GATE-INTEGRITY
 * DECISION: native NEVER returns `pass`. The snapshot only sees missing-name
 * (critical) violations, so it cannot certify the absence of the full axe rule
 * set at any severity floor — returning `pass` would launder the unobservable
 * rules into a green. So we return:
 *   • `fail` — detected critical violations strictly exceed `maxViolations`.
 *     A critical violation exceeds ANY severity floor (minor/moderate/serious/
 *     critical), so this fail is valid regardless of `want.severity` — do NOT
 *     early-return unverifiable for a low floor before checking for a fail.
 *   • `unverifiable` — otherwise (the count is within budget, but absence is
 *     unobservable).
 * PURE — unit-tested without a device.
 */
export function nativeA11yVerdict(
  violations: NativeA11yViolation[],
  want: A11yExpect,
): { status: 'fail' | 'unverifiable'; count: number } {
  const maxViolations = want.maxViolations ?? 0;
  const count = violations.length;
  return { status: count > maxViolations ? 'fail' : 'unverifiable', count };
}

/**
 * Run a single criterion's checks on the native driver and fold them into one
 * `CriterionVerdict`. Mechanical: any fail → fail; else any unverifiable →
 * unverifiable; else pass — the SAME fold as the web executor.
 */
export async function runNativeCriterionChecks(args: {
  driver: NativeDriver;
  criterion: SpecCriterion;
  navigate?: (url: string) => Promise<void>;
  matchedRequests?: NativeObservedRequest[];
  consoleErrorCount?: number;
  /**
   * Per-render performance fold from the companion's `rendered` ack (React
   * Profiler mount/update + a monotonic ready clock). Threaded into the
   * executor for `expect.performance` verdicts. Absent on old companion
   * binaries (no perf channel) → that metric is `unverifiable`, never a fail.
   */
  perf?: NativePerf;
  /**
   * Why `perf` is absent, from the caller that knows the confirmation path —
   * see capture-native's `nativePerfUnavailableReason`. Surfaced verbatim as
   * the `expect.performance` unverifiable detail.
   */
  perfUnavailableReason?: string;
  /**
   * Un-mocked request URLs the device's permissive catch-all answered (the
   * `unmatched` channel from the render ack, `"METHOD URL"` strings). Used for
   * the post-execution NETWORK TAINT step below — parity with the web executor.
   * Absent on old companion binaries → no taint inferred (degrade gracefully).
   */
  unmatchedUrls?: string[];
  /**
   * Reader for navigation attempts the device's AUTO-MOCKED navigator swallowed
   * (bridge `nav-intent` channel). Supplied by the capture flow; absent on old
   * companions, where the navigation demotion below simply never fires.
   */
  navIntentsSince?: (
    sinceMs: number,
  ) => Array<{ method: string; at: number }> | Promise<Array<{ method: string; at: number }>>;
  /** Resolved scenario secrets for secret-safe fills (see executeNativeChecks). */
  secrets?: ReadonlyArray<ResolvedSecret>;
}): Promise<CriterionVerdict> {
  const {
    driver,
    criterion,
    navigate,
    matchedRequests,
    consoleErrorCount,
    perf,
    perfUnavailableReason,
    unmatchedUrls,
    navIntentsSince,
  } = args;
  // Bracket the execution so only navigations attempted BY THIS CRITERION count
  // — an intent from an earlier criterion must not demote this one.
  const criterionStartedAt = Date.now();
  const checks = criterion.checks ?? [];
  // Provenance guards BEFORE any check reads the list (A4): the device's
  // declared claims are cross-checked against the unmatched list and the
  // catch-all pattern rule — downward-only, never a promotion.
  const guardedRequests = matchedRequests
    ? applyNativeProvenanceGuards(matchedRequests, unmatchedUrls)
    : undefined;
  const verdicts = await executeNativeChecks({
    driver,
    checks,
    navigate,
    matchedRequests: guardedRequests,
    consoleErrorCount,
    perf,
    perfUnavailableReason,
    secrets: args.secrets,
  });
  const status = foldCheckVerdicts(verdicts);

  const tally = { pass: 0, fail: 0, unverifiable: 0 };
  for (const v of verdicts) tally[v.status] += 1;
  const detail =
    verdicts.length === 0
      ? 'no checks to execute'
      : `${tally.pass} pass, ${tally.fail} fail, ${tally.unverifiable} unverifiable`;

  // NETWORK TAINT (parity with the web executor's runCriterionChecks): a
  // criterion that would PASS but whose `expect.network` checks were satisfied
  // by a request the permissive catch-all FABRICATED is demoted to
  // `unverifiable` — the assertion never ran against a real backend, so a pass
  // over-claims. EVIDENCE-FIRST (A4): each passing network verdict carries the
  // response that DECIDED it; a fabricated decider taints, a declared one does
  // not. Verdicts WITHOUT evidence (old companion — no provenance channel)
  // keep the legacy unmatched-list inference, i.e. exactly today's behavior.
  // Only a clean pass is a candidate; a `fail` stays `fail` and an
  // already-`unverifiable` verdict keeps its reasoning. Soft is filtered out
  // upstream (checks only on hard/property).
  const hasNetworkExpect = checks.some((c) => isExpectCheck(c) && !!c.expect.network);
  if (status === 'pass' && hasNetworkExpect) {
    const networkVerdicts = verdicts.filter(
      (v) => isExpectCheck(v.check) && !!v.check.expect.network,
    );
    const parsedUnmatched = parseUnmatchedUrls(unmatchedUrls);
    const reasons: string[] = [];
    for (const v of networkVerdicts) {
      const ev = v.networkEvidence;
      if (ev) {
        if (ev.provenance !== 'fabricated') continue;
        // Name the catch-all pattern when one served it: fabricated evidence
        // never carries a handlerUrl (the foundation contract reserves it for
        // declared), so look the deciding response back up in the guarded list.
        const src = (guardedRequests ?? []).find(
          (r) => r.method === ev.method && r.url === ev.url && r.status === ev.status,
        );
        reasons.push(
          src?.handlerUrl && isCatchAllPattern(src.handlerUrl)
            ? `catch-all handler '${src.handlerUrl}' is not endpoint-specific evidence: ${ev.method} ${ev.url}; status ${ev.status}`
            : `fabricated response: ${ev.method} ${ev.url}; status ${ev.status}`,
        );
        continue;
      }
      const c = v.check;
      if (!isExpectCheck(c) || !c.expect.network) continue;
      const t = isTaintedByNativeNetworkExpect(parsedUnmatched, c.expect.network);
      if (t.tainted) reasons.push(...t.reasons);
    }
    if (reasons.length > 0) {
      return {
        id: criterion.id,
        tier: criterion.tier,
        status: 'unverifiable',
        detail: `${detail} — tainted: ${reasons.join('; ')}`,
        checks: verdicts,
        // Dual-written (parity with the web executor): the legacy boolean keeps
        // an older reader's refold sticky; new readers use `evidenceTaintsOf`.
        networkTainted: true,
        evidenceTaints: ['network'],
        networkProvenance: 'fabricated',
      };
    }
    // Untainted network pass: roll the per-check evidence up for readers.
    // `declared` requires every network verdict to carry declared evidence —
    // the rollup yields undefined on any gap (old companions never gain a claim).
    const provenance = rollupNetworkProvenance(networkVerdicts.map((v) => v.networkEvidence));
    return {
      id: criterion.id,
      tier: criterion.tier,
      status,
      detail: provenance === 'declared' ? `${detail} — proven against declared mock` : detail,
      checks: verdicts,
      ...(provenance !== undefined ? { networkProvenance: provenance } : {}),
    };
  }

  // NAVIGATION DEMOTION: in isolation the navigator is AUTO-MOCKED, so a screen
  // that calls navigate()/push()/replace() never actually goes anywhere. A
  // criterion like "pressing Let's go! advances off the welcome screen" then
  // fails on the follow-up assertion — reporting a confident product FAILURE
  // for something that is simply not decidable in this harness. When the device
  // reports that it TRIED to navigate while this criterion ran, the failure is
  // demoted to `unverifiable` and says why.
  //
  // Deliberately narrow, so real regressions still fail:
  //   - only a `fail` is a candidate (a pass stays a pass; unverifiable keeps
  //     its own reasoning);
  //   - only when an intent was recorded DURING this criterion;
  //   - only for a visibility/presence assertion, which is what a navigation
  //     would have changed. A criterion failing on, say, a colour or a
  //     performance budget is unaffected by a swallowed navigation and keeps
  //     its fail.
  if (status === 'fail' && navIntentsSince) {
    const intents = await navIntentsSince(criterionStartedAt);
    const failedOnVisibility = verdicts.some(
      (v) => v.status === 'fail' && isExpectCheck(v.check) && !!v.check.expect.element,
    );
    if (intents.length > 0 && failedOnVisibility) {
      const methods = [...new Set(intents.map((i) => i.method))].join(', ');
      return {
        id: criterion.id,
        tier: criterion.tier,
        status: 'unverifiable',
        detail:
          `${detail} — undecidable in isolation: the screen called ${methods}() but the ` +
          'navigator is auto-mocked, so the navigation never happened. Move this criterion to ' +
          'a flow-level spec, or assert the navigation intent instead of the screen change.',
        checks: verdicts,
      };
    }
  }

  return { id: criterion.id, tier: criterion.tier, status, detail, checks: verdicts };
}
