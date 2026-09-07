/**
 * Deterministic hard/property-tier check executor for the WEB sandbox.
 *
 * Given a live Playwright `Page` and a criterion's `checks` block, this runs
 * the small check verb set (navigate / click / fill / expect(element |
 * network | console | screenshot)) and returns MECHANICAL verdicts. No LLM,
 * no judgement — just "did the assertion hold". The verdicts fold into a
 * criterion status via `@validity.ai/verify-spec`'s `foldCheckVerdicts`, so the sandbox
 * and any native executor agree on the rule.
 *
 * SELECTOR DURABILITY is the load-bearing idea (see spec-schema.ts header):
 * the agent invents the DOM, so accessibility-based selection is the only
 * strategy that survives a rebuild. When a click/fill/element target can't be
 * found, is ambiguous, or has no accessible name, the right verdict is
 * `unverifiable` — a FINDING the agent should fix ("add an accessible name"),
 * NOT a `fail` (which would imply the feature is broken). A genuine assertion
 * mismatch (network 500 instead of 2xx, an element visible when it should be
 * hidden) is a real `fail`.
 *
 * Network note: in ISOLATION mode the mocked fetches are served inside the
 * page's JS realm by `@mswjs/interceptors`, so they never fire Playwright's
 * `page.on('response')` (see diagnostics.ts). `expect.network` assertions are
 * therefore only observable in URL mode; we surface that caveat in the detail
 * when nothing matched so the agent isn't misled.
 */
import type { Page, Locator } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import {
  applyEvidenceTaints,
  CHECK_TIMEOUT_MS,
  demotingTaintsOf,
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
  parseRegexLiteral,
  pressKeyAndTimes,
  rollupNetworkProvenance,
  type A11yExpect,
  type A11ySeverityFloor,
  type Check,
  type CheckVerdict,
  type CriterionVerdict,
  type DataProvenance,
  type ElementExpect,
  type EvidenceTaint,
  type NetworkEvidence,
  type NetworkExpect,
  type SelectOption,
  type Selector,
  type SpecCriterion,
  type StatusMatcher,
} from '@validity.ai/verify-spec';
import { matchUrl, methodMatches } from './network-matcher.js';

/** Per-check action/assertion budget — sourced from `@validity.ai/verify-spec` so the
 * schema (`wait.ms` ceiling) and the executor can never disagree. */

/**
 * Collected (method, url, status) for one observed network response.
 *
 * `permissive` and `matched` are TAINT signals carried out of the in-page mock
 * log (`window.__VALIDITY_REQUESTS__`): `permissive` means the response body was
 * the deeply-defaulting Proxy (fabricated data, x-validity-permissive header),
 * and `matched=false` means no handler matched and a fallback was served. They
 * are absent on responses observed via Playwright's `page.on('response')` (URL
 * mode / real network), which carry no such guarantee — those are treated as
 * untainted. See `isTaintedByNetworkExpect`.
 *
 * `provenance` is the A4 fold of those signals: `declared` = a config handler
 * with a non-catch-all pattern served it (pattern on `handlerUrl`);
 * `fabricated` = a fallback / permissive body / catch-all handler answered;
 * `undefined` = Playwright-observed (live network — no synthetic guarantee
 * either way) or a pre-provenance in-page log entry.
 */
export interface ObservedResponse {
  method: string;
  url: string;
  status: number;
  permissive?: boolean;
  matched?: boolean;
  provenance?: 'declared' | 'fabricated';
  handlerUrl?: string;
  /**
   * Data state the response was FORCED into by the sandbox's dataState axis
   * (A2) — 'empty'/'error'/'loading' from the in-page log. Forced responses
   * are synthetic BY DESIGN, so `expect.network` is never exempt from the
   * taint on them (see `isTaintedByNetworkExpect`).
   */
  dataState?: string;
}

/**
 * Does an actual HTTP status satisfy a `StatusMatcher`? Exact number, or a
 * class like `2xx` (matches 200–299). Pure — unit-testable without a browser.
 */
export function statusMatches(actual: number, matcher: StatusMatcher): boolean {
  if (typeof matcher === 'number') return actual === matcher;
  // '2xx' → leading digit is the class.
  const klass = Number(matcher[0]);
  if (Number.isNaN(klass)) return false;
  return Math.floor(actual / 100) === klass;
}

/**
 * Does an actual request URL satisfy a spec `url` pattern? Same dialect as the
 * mock network handlers (exact path / `'/x/*'` prefix / full-url substring),
 * so a check reads the same as the mock it was written against. Thin wrapper
 * over `matchUrl` (which takes `(pattern, url)`). Pure — unit-testable.
 */
export function urlMatches(actual: string, pattern: string): boolean {
  return matchUrl(pattern, actual);
}

/**
 * `waitForRequest.url` is a path/prefix/full URL (same dialect as
 * `expect.network`) OR a `/regex/flags` literal. Pure — unit-testable.
 */
export function requestUrlMatches(actual: string, pattern: string): boolean {
  const re = parseRegexLiteral(pattern);
  if (re) return re.test(actual);
  return urlMatches(actual, pattern);
}

function selectOptionArg(
  option: SelectOption,
): string | { label?: string; value?: string; index?: number } {
  return typeof option === 'string' ? option : option;
}

function describeSelectOption(option: SelectOption): string {
  if (typeof option === 'string') return JSON.stringify(option);
  if (option.label !== undefined) return `label=${JSON.stringify(option.label)}`;
  if (option.value !== undefined) return `value=${JSON.stringify(option.value)}`;
  if (option.index !== undefined) return `index=${option.index}`;
  return JSON.stringify(option);
}

/**
 * A selector name/text/label/placeholder is normally a (case-insensitive
 * substring) string, but a `/pattern/flags` literal is lowered to a real
 * `RegExp` so a dynamic/anchored label means the same here as it does in the
 * native executor's `matchName`. Playwright's getBy* name/text args accept
 * `string | RegExp`.
 */
function nameMatcher(value: string): string | RegExp {
  return parseRegexLiteral(value) ?? value;
}

/**
 * Map an accessibility-first `Selector` onto a Playwright `Locator`. Prefers
 * `role` + `name` (the durable pair), then testId / label / placeholder /
 * text, then bare name (as a text match). Applies `.nth(n)` last when present.
 *
 * testId sits ABOVE label/placeholder because a stable `data-testid` is a more
 * durable target than a copy/i18n-mutable label. This ORDER MUST match the
 * exporter's `locatorExpr` (spec-playwright.ts) — if they diverge, an exported
 * test and the sandbox verify resolve the SAME selector to DIFFERENT elements.
 */
export function locatorFor(page: Page, sel: Selector): Locator {
  let loc: Locator;
  if (sel.role) {
    // `role` is a free string in the spec; Playwright wants its ARIA-role union.
    const role = sel.role as Parameters<Page['getByRole']>[0];
    loc = sel.name ? page.getByRole(role, { name: nameMatcher(sel.name) }) : page.getByRole(role);
  } else if (sel.testId) {
    loc = page.getByTestId(sel.testId);
  } else if (sel.label) {
    loc = page.getByLabel(nameMatcher(sel.label));
  } else if (sel.placeholder) {
    loc = page.getByPlaceholder(nameMatcher(sel.placeholder));
  } else if (sel.text) {
    loc = page.getByText(nameMatcher(sel.text));
  } else if (sel.name) {
    // `name` without `role` is schema-legal; approximate the accessible-name
    // match via visible text on web (the native executor's resolveRefs already
    // matches name-only against the a11y name — this keeps the two symmetric).
    loc = page.getByText(nameMatcher(sel.name));
  } else {
    // Only a truly EMPTY selector reaches here — the schema rejects that
    // upstream; the throw keeps the type total.
    throw new Error('selector has no usable field');
  }
  if (sel.nth != null) loc = loc.nth(sel.nth);
  return loc;
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
 * Read the in-page mock-request log maintained by the isolation sandbox's MSW
 * layer. Returns [] when the page can't be evaluated (e.g. the fake page used
 * in unit tests, or URL mode where the log doesn't exist).
 *
 * TAMPER RESISTANCE (A4): reads through the frozen `__VALIDITY_GET_REQUESTS__`
 * closure getter when present — component code pushing forged
 * `provenance: 'declared'` entries into the mutable `window.__VALIDITY_REQUESTS__`
 * mirror is then inert. The window array is only consulted as a fallback for a
 * stale sandbox bundle without the getter (same exposure as before the getter
 * existed; prepare regenerates the bundle every run).
 *
 * `sinceIndex` scopes the read to entries logged AFTER executeChecks began, so
 * a network expect can't match a request fired by a PRIOR criterion sharing the
 * same page (the in-page log is page-lifetime; Playwright's `responses[]` is
 * already per-executeChecks-scoped).
 */
export async function readInPageRequests(page: Page, sinceIndex = 0): Promise<ObservedResponse[]> {
  if (typeof page.evaluate !== 'function') return [];
  try {
    const log = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      if (typeof w.__VALIDITY_GET_REQUESTS__ === 'function') {
        try {
          return w.__VALIDITY_GET_REQUESTS__();
        } catch {
          return [];
        }
      }
      return w.__VALIDITY_REQUESTS__ ?? [];
    });
    if (!Array.isArray(log)) return [];
    return log
      .slice(sinceIndex)
      .filter((r) => r && typeof r.method === 'string' && typeof r.url === 'string')
      .map((r) => {
        const handlerUrl = typeof r.handlerUrl === 'string' ? r.handlerUrl : undefined;
        // Provenance: trust the entry's own stamp when present (the getter path
        // makes it unforgeable); derive it from the legacy flags for an old
        // bundle. `declared` requires the positive conjunction (matched AND not
        // permissive) — every ambiguity resolves to fabricated or undefined.
        let provenance: ObservedResponse['provenance'] =
          r.provenance === 'declared' || r.provenance === 'fabricated'
            ? r.provenance
            : r.permissive || r.matched === false
              ? 'fabricated'
              : r.matched === true
                ? 'declared'
                : undefined;
        if (r.permissive && provenance === 'declared') provenance = 'fabricated';
        // Executor-side demotion (cannot be dodged by a stale in-page bundle):
        // a catch-all handler pattern is not endpoint-specific evidence.
        if (provenance === 'declared' && handlerUrl && isCatchAllPattern(handlerUrl)) {
          provenance = 'fabricated';
        }
        return {
          method: r.method,
          url: r.url,
          status: Number(r.status) || 0,
          // Carry the taint signals through verbatim — `permissive` (fabricated
          // proxy body) and `matched` (a handler matched). The raw log always
          // writes both booleans (prepare.ts trackRequest); coerce defensively in
          // case an older sandbox bundle omitted them.
          permissive: !!r.permissive,
          matched: r.matched !== false,
          provenance,
          handlerUrl,
          dataState: typeof r.dataState === 'string' ? r.dataState : undefined,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Fold a render's whole request log into `ComponentRender.dataProvenance`
 * (A4 — best-effort, DISPLAY-ONLY; never feeds a verdict). Any declared
 * handler hit ⇒ `declared-mock`; any permissive/unmatched/fabricated response
 * ⇒ `proxy-fallback`; both can coexist. Undefined when the render produced no
 * classifiable traffic (URL mode, no requests). Pure — unit-testable.
 */
export function deriveRenderDataProvenance(
  observed: ObservedResponse[],
): DataProvenance[] | undefined {
  const out: DataProvenance[] = [];
  if (observed.some((r) => r.provenance === 'declared')) out.push('declared-mock');
  if (observed.some((r) => r.provenance === 'fabricated' || r.permissive || r.matched === false)) {
    out.push('proxy-fallback');
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Length of the in-page request log — the `sinceIndex` snapshot both
 * `executeChecks` and `runCriterionChecks` take before running. MUST read the
 * same source `readInPageRequests` reads (the frozen getter first), otherwise
 * a tampered window array could skew the slice offset. 0 when the page can't
 * be evaluated (fake/unit pages, URL mode).
 */
async function readInPageRequestCount(page: Page): Promise<number> {
  if (typeof page.evaluate !== 'function') return 0;
  try {
    const n = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      if (typeof w.__VALIDITY_GET_REQUESTS__ === 'function') {
        try {
          return w.__VALIDITY_GET_REQUESTS__().length;
        } catch {
          return 0;
        }
      }
      return (w.__VALIDITY_REQUESTS__ || []).length;
    });
    return typeof n === 'number' ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Decide whether an `expect.network` assertion consumed TAINTED evidence.
 *
 * A network expect "passes" by finding a response whose status matches — but in
 * ISOLATION mode that response may be FABRICATED: either a permissive-proxy body
 * (x-validity-permissive header → `permissive=true`) or a fallback served
 * because no handler matched (`matched=false`). Either way the assertion never
 * ran against a real backend, so a passing verdict over-claims. We filter the
 * already-scoped responses by the SAME url/method predicate the expect used (so
 * a tainted request is matched by the identical rule that matched it for the
 * assertion — no false negatives from divergent matching) and collect a reason
 * per tainted candidate.
 *
 * Pure — unit-testable. `responses` are expected to be pre-scoped to this
 * criterion's run (the caller passes the result of `readInPageRequests`, which
 * already slices the page-lifetime log by `sinceIndex`).
 */
export function isTaintedByNetworkExpect(
  responses: ObservedResponse[],
  want: NetworkExpect,
): { tainted: boolean; reasons: string[] } {
  const methodLabel = want.method ?? 'ANY';
  const matches = (r: ObservedResponse): boolean =>
    methodMatches(want.method, r.method) && urlMatches(r.url, want.url);
  const reasons: string[] = [];
  for (const r of responses.filter(matches)) {
    // Forced by the dataState axis (A2): synthetic BY DESIGN. Belt-and-braces
    // — a forced 'empty' is already permissive and a forced 'error' already
    // `matched:false` — but the explicit reason keeps the message honest and
    // the invariant intact even if those implementations change. Network
    // expects are NEVER exempt on forced renders: asserting a status against
    // a response Validity fabricated is self-referential proof.
    if (r.dataState && r.dataState !== 'populated') {
      reasons.push(
        `response forced by dataState '${r.dataState}' (synthetic by design): ${r.method} ${r.url}`,
      );
    }
    if (r.permissive) {
      reasons.push(`permissive proxy response: ${r.method} ${r.url}; status ${r.status}`);
    }
    // `matched === false` is the unmatched-URL signal (a fallback was served).
    // Only an explicit `false` taints; `undefined` (e.g. Playwright-observed
    // responses in URL mode) carries no synthetic guarantee. A response can be
    // BOTH unmatched and permissive (the permissive fallback) — list both.
    if (r.matched === false) {
      reasons.push(`unmatched ${methodLabel} ${want.url}; status ${r.status}`);
    }
  }
  return { tainted: reasons.length > 0, reasons };
}

/**
 * Map an observed response onto the persisted `NetworkEvidence` shape (A4).
 * Playwright-observed responses (no in-page provenance flag) are `live`.
 * `handlerUrl` is stamped ONLY on declared evidence (the foundation contract:
 * present iff provenance === 'declared') — a catch-all-demoted fabricated
 * response keeps its pattern on the executor-internal `ObservedResponse` for
 * the reason strings, never on the evidence.
 */
function observedEvidence(r: ObservedResponse): NetworkEvidence {
  const evidence: NetworkEvidence = {
    provenance: r.provenance ?? 'live',
    method: r.method,
    url: r.url,
    status: r.status,
  };
  if (r.provenance === 'declared' && r.handlerUrl) evidence.handlerUrl = r.handlerUrl;
  return evidence;
}

/** Sleep `ms` using the page clock when available, else a plain timer (so the
 * fake page used in unit tests doesn't need a waitForTimeout). */
async function waitMs(page: Page, ms: number): Promise<void> {
  if (typeof page.waitForTimeout === 'function') {
    await page.waitForTimeout(ms);
    return;
  }
  await new Promise((r) => setTimeout(r, ms));
}

function resolveUrl(url: string, baseUrl?: string): string {
  if (!baseUrl) return url;
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return url;
  }
}

/** Evaluate an element-state predicate. May THROW when the element can't be
 * resolved (no match / ambiguous) — callers treat that as `unverifiable`. */
async function evalState(
  loc: Locator,
  state: NonNullable<ElementExpect['state']>,
): Promise<boolean> {
  switch (state) {
    case 'visible':
      // Auto-wait so an element that renders a tick later isn't a flaky false
      // fail. The fake page used in unit tests has no `waitFor` — fall back to
      // the instantaneous `isVisible()` there.
      if (typeof loc.waitFor === 'function') {
        try {
          await loc.waitFor({ state: 'visible', timeout: CHECK_TIMEOUT_MS });
          return true;
        } catch {
          return false;
        }
      }
      return loc.isVisible();
    case 'hidden':
      if (typeof loc.waitFor === 'function') {
        try {
          await loc.waitFor({ state: 'hidden', timeout: CHECK_TIMEOUT_MS });
          return true;
        } catch {
          return false;
        }
      }
      return !(await loc.isVisible());
    case 'enabled':
      return loc.isEnabled({ timeout: CHECK_TIMEOUT_MS });
    case 'disabled':
      return loc.isDisabled({ timeout: CHECK_TIMEOUT_MS });
    case 'checked':
      return loc.isChecked({ timeout: CHECK_TIMEOUT_MS });
    case 'focused':
      // Strict `toBeFocused` semantics — the resolved element IS its document's
      // active element. `evaluate` throws when nothing matches (callers treat a
      // throw as `unverifiable`, like the other states). Uses the element's own
      // ownerDocument so a same-origin iframe resolves against its own focus.
      return loc.evaluate((el) => el === el.ownerDocument.activeElement);
  }
}

/**
 * Execute a criterion's checks against a live page, returning one verdict per
 * check. Installs its OWN response + console-error listeners for the duration
 * and tears them down at the end, so a criterion's network/console assertions
 * only see traffic that happened DURING its own run.
 */
export async function executeChecks(args: {
  page: Page;
  checks: Check[];
  baseUrl?: string;
  /**
   * `console.error`s already observed on the page BEFORE this call installs its
   * own listener — i.e. during mount, render, and play. Without this seed the
   * `expect.console` gate only ever sees errors emitted inside its own (tiny)
   * window, so a component that logged 50 render-time errors passes
   * `console.errors: 0`. Sourced from the capture's diagnostics collector.
   */
  priorConsoleErrors?: number;
}): Promise<CheckVerdict[]> {
  const { page, checks, baseUrl } = args;
  const responses: ObservedResponse[] = [];
  let consoleErrorCount = args.priorConsoleErrors ?? 0;

  const onResponse = (res: {
    request(): { method(): string };
    url(): string;
    status(): number;
  }) => {
    try {
      responses.push({ method: res.request().method(), url: res.url(), status: res.status() });
    } catch {
      // Ignore — a torn-down response object late in the run.
    }
  };
  const onConsole = (msg: { type(): string }) => {
    try {
      if (msg.type() === 'error') consoleErrorCount += 1;
    } catch {
      // Ignore.
    }
  };

  const hasOn = typeof page.on === 'function';
  if (hasOn) {
    page.on('response', onResponse as never);
    page.on('console', onConsole as never);
  }

  // Snapshot the in-page request-log length so this run's network expects only
  // see traffic that happened during it (the log is page-lifetime; see
  // readInPageRequests). Fake pages have no `evaluate` → start at 0.
  const sinceIndex = await readInPageRequestCount(page);

  const verdicts: CheckVerdict[] = [];
  // Once a prerequisite action (navigate/click/fill) is unverifiable, the flow
  // couldn't be driven — downstream "no response"/"not found" assertions are
  // then unverifiable too, not hard fails (we never got to exercise them).
  let priorActionUnverifiable = false;
  try {
    for (const check of checks) {
      const verdict = await runOneCheck(
        page,
        check,
        baseUrl,
        responses,
        () => consoleErrorCount,
        priorActionUnverifiable,
        sinceIndex,
      );
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
      if (isAction && verdict.status === 'unverifiable') priorActionUnverifiable = true;
    }
  } finally {
    if (hasOn && typeof page.off === 'function') {
      page.off('response', onResponse as never);
      page.off('console', onConsole as never);
    }
  }
  return verdicts;
}

async function runOneCheck(
  page: Page,
  check: Check,
  baseUrl: string | undefined,
  responses: ObservedResponse[],
  consoleErrors: () => number,
  priorActionUnverifiable = false,
  sinceIndex = 0,
): Promise<CheckVerdict> {
  const pass = (detail?: string): CheckVerdict => ({ check, status: 'pass', detail });
  const fail = (detail: string): CheckVerdict => ({ check, status: 'fail', detail });
  const unverifiable = (detail: string): CheckVerdict => ({
    check,
    status: 'unverifiable',
    detail,
  });

  // ---- navigate ---------------------------------------------------------
  if (isNavigateCheck(check)) {
    const target = resolveUrl(check.navigate.url, baseUrl);
    try {
      await page.goto(target, { timeout: CHECK_TIMEOUT_MS * 2 });
      return pass(`navigated to ${target}`);
    } catch (err) {
      return fail(`navigation to ${target} failed: ${(err as Error).message}`);
    }
  }

  // ---- click ------------------------------------------------------------
  if (isClickCheck(check)) {
    const desc = describeSelector(check.click);
    try {
      await locatorFor(page, check.click).click({ timeout: CHECK_TIMEOUT_MS });
      return pass(`clicked ${desc}`);
    } catch (err) {
      return unverifiable(
        `AC unverifiable: could not click ${desc} (add an accessible name or testId) — ${(err as Error).message.split('\n')[0]}`,
      );
    }
  }

  // ---- press ------------------------------------------------------------
  // Keyboard press to the PAGE (active element) or, when `selector` is set, to
  // a located element (`locator.press` focuses it first). Repeated `times`.
  // An action: a failure is `unverifiable` (couldn't drive the flow) and
  // cascades, exactly like a click — never a `fail`.
  if (isPressCheck(check)) {
    const { key, times, selector } = pressKeyAndTimes(check.press);
    try {
      if (selector) {
        const loc = locatorFor(page, selector);
        for (let i = 0; i < times; i++) await loc.press(key, { timeout: CHECK_TIMEOUT_MS });
        const desc = describeSelector(selector);
        return pass(
          times === 1 ? `pressed ${key} in ${desc}` : `pressed ${key} ×${times} in ${desc}`,
        );
      }
      for (let i = 0; i < times; i++) await page.keyboard.press(key);
      return pass(times === 1 ? `pressed ${key}` : `pressed ${key} ×${times}`);
    } catch (err) {
      return unverifiable(
        `AC unverifiable: could not press ${key} — ${(err as Error).message.split('\n')[0]}`,
      );
    }
  }

  // ---- hover ------------------------------------------------------------
  if (isHoverCheck(check)) {
    const desc = describeSelector(check.hover);
    try {
      await locatorFor(page, check.hover).hover({ timeout: CHECK_TIMEOUT_MS });
      return pass(`hovered ${desc}`);
    } catch (err) {
      return unverifiable(
        `AC unverifiable: could not hover ${desc} (add an accessible name or testId) — ${(err as Error).message.split('\n')[0]}`,
      );
    }
  }

  // ---- fill -------------------------------------------------------------
  if (isFillCheck(check)) {
    const { value, ...sel } = check.fill;
    const desc = describeSelector(sel);
    try {
      await locatorFor(page, sel).fill(value, { timeout: CHECK_TIMEOUT_MS });
      return pass(`filled ${desc}`);
    } catch (err) {
      return unverifiable(
        `AC unverifiable: could not fill ${desc} (add an accessible name or testId) — ${(err as Error).message.split('\n')[0]}`,
      );
    }
  }

  // ---- wait -------------------------------------------------------------
  if (isWaitCheck(check)) {
    const body = check.wait;
    if (body.ms !== undefined) {
      await waitMs(page, body.ms);
      return pass(`waited ${body.ms}ms`);
    }
    const sel = body.for!;
    const state = body.state ?? 'visible';
    const desc = describeSelector(sel);
    try {
      await locatorFor(page, sel).waitFor({ state, timeout: CHECK_TIMEOUT_MS });
      return pass(`waited for ${desc} to be ${state}`);
    } catch (err) {
      const msg = (err as Error).message.split('\n')[0] ?? '';
      // Timeout = the condition was tested and did not hold → fail (never a
      // silent pass). Other locator errors (strict-mode, invalid selector) are
      // durability findings → unverifiable.
      if (/timeout/i.test(msg)) {
        return priorActionUnverifiable
          ? unverifiable(
              `timed out waiting for ${desc} to be ${state} — prior action was unverifiable`,
            )
          : fail(`timed out waiting for ${desc} to be ${state}`);
      }
      return unverifiable(
        `AC unverifiable: could not wait for ${desc} (add an accessible name or testId) — ${msg}`,
      );
    }
  }

  // ---- waitForRequest ---------------------------------------------------
  // Polls the same two sources `expect.network` reads (Playwright responses +
  // the in-page MSW log). Timeout with no match is `fail`, never a pass.
  if (isWaitForRequestCheck(check)) {
    const want = check.waitForRequest;
    const timeoutMs = want.timeoutMs ?? CHECK_TIMEOUT_MS;
    const methodLabel = want.method ?? 'ANY';
    const matches = (r: ObservedResponse): boolean =>
      methodMatches(want.method, r.method) && requestUrlMatches(r.url, want.url);
    const canPoll = typeof page.evaluate === 'function';
    const deadline = canPoll ? Date.now() + timeoutMs : Date.now();
    let candidates: ObservedResponse[] = [];
    for (;;) {
      const inPage = await readInPageRequests(page, sinceIndex);
      candidates = [...responses, ...inPage].filter(matches);
      if (candidates.length > 0 || Date.now() >= deadline) break;
      await waitMs(page, 100);
    }
    if (candidates.length === 0) {
      const detail = `no request observed for ${methodLabel} ${want.url} within ${timeoutMs}ms`;
      return priorActionUnverifiable
        ? unverifiable(`${detail} — prior action was unverifiable`)
        : fail(detail);
    }
    const hit = candidates[0]!;
    return pass(`${hit.method} ${hit.url} matched ${methodLabel} ${want.url}`);
  }

  // ---- select -----------------------------------------------------------
  if (isSelectCheck(check)) {
    const { selector, option } = check.select;
    const desc = describeSelector(selector);
    let loc: Locator;
    try {
      loc = locatorFor(page, selector);
    } catch (err) {
      return unverifiable(`AC unverifiable: bad selector ${desc} — ${(err as Error).message}`);
    }
    try {
      const tag = await loc.evaluate((el) => (el as { tagName: string }).tagName);
      if (String(tag).toUpperCase() !== 'SELECT') {
        return fail('not a native select — use click + click on the option');
      }
      await loc.selectOption(selectOptionArg(option), { timeout: CHECK_TIMEOUT_MS });
      return pass(`selected ${describeSelectOption(option)} on ${desc}`);
    } catch (err) {
      const msg = (err as Error).message.split('\n')[0] ?? '';
      if (/timeout|strict mode/i.test(msg)) {
        return unverifiable(
          `AC unverifiable: could not select on ${desc} (add an accessible name or testId) — ${msg}`,
        );
      }
      // Playwright throws when the node isn't a <select> even if evaluate
      // somehow passed (or wasn't available on a fake page). Same honest fail.
      if (/not a (native )?select|selectoption/i.test(msg)) {
        return fail('not a native select — use click + click on the option');
      }
      return unverifiable(
        `AC unverifiable: could not select on ${desc} (add an accessible name or testId) — ${msg}`,
      );
    }
  }

  // ---- scroll -----------------------------------------------------------
  if (isScrollCheck(check)) {
    const body = check.scroll;
    try {
      if (body.intoView && body.selector) {
        const desc = describeSelector(body.selector);
        await locatorFor(page, body.selector).scrollIntoViewIfNeeded({
          timeout: CHECK_TIMEOUT_MS,
        });
        return pass(`scrolled ${desc} into view`);
      }
      if (body.to) {
        if (body.selector) {
          const desc = describeSelector(body.selector);
          await locatorFor(page, body.selector).evaluate((el, to) => {
            const node = el as {
              scrollTo: (o: { top: number; left: number }) => void;
              scrollHeight: number;
            };
            node.scrollTo({ top: to === 'bottom' ? node.scrollHeight : 0, left: 0 });
          }, body.to);
          return pass(`scrolled ${desc} to ${body.to}`);
        }
        if (typeof page.evaluate === 'function') {
          await page.evaluate((to) => {
            const top = to === 'bottom' ? document.documentElement.scrollHeight : 0;
            window.scrollTo(0, top);
          }, body.to);
        }
        return pass(`scrolled page to ${body.to}`);
      }
      if (body.by) {
        const dx = body.by.x ?? 0;
        const dy = body.by.y ?? 0;
        if (body.selector) {
          const desc = describeSelector(body.selector);
          await locatorFor(page, body.selector).evaluate(
            (el, delta) => {
              (el as { scrollBy: (x: number, y: number) => void }).scrollBy(delta.dx, delta.dy);
            },
            { dx, dy },
          );
          return pass(`scrolled ${desc} by (${dx}, ${dy})`);
        }
        if (page.mouse && typeof page.mouse.wheel === 'function') {
          await page.mouse.wheel(dx, dy);
        } else if (typeof page.evaluate === 'function') {
          await page.evaluate((delta) => window.scrollBy(delta.dx, delta.dy), { dx, dy });
        }
        return pass(`scrolled page by (${dx}, ${dy})`);
      }
      return unverifiable('scroll check has no to/by/intoView (schema should have rejected this)');
    } catch (err) {
      const msg = (err as Error).message.split('\n')[0] ?? '';
      const desc = body.selector ? describeSelector(body.selector) : 'page';
      return unverifiable(`AC unverifiable: could not scroll ${desc} — ${msg}`);
    }
  }

  // ---- expect -----------------------------------------------------------
  if (isExpectCheck(check)) {
    const body = check.expect;

    // expect.element
    if (body.element) {
      const el = body.element;
      const sel: Selector = el;
      const desc = describeSelector(sel);
      let loc: Locator;
      try {
        loc = locatorFor(page, sel);
      } catch (err) {
        return unverifiable(`AC unverifiable: bad selector ${desc} — ${(err as Error).message}`);
      }
      try {
        // Explicit count assertion is a genuine assertion → mismatch is fail.
        if (el.count !== undefined) {
          const n = await loc.count();
          if (n !== el.count) {
            // If a prior action couldn't be driven, the page never reached the
            // state this count assertion describes — that's unverifiable, not a
            // feature failure. A mismatch with NO prior unverifiable action is a
            // genuine fail.
            return priorActionUnverifiable
              ? unverifiable(
                  `expected ${el.count} element(s) matching ${desc}, found ${n} — prior action was unverifiable`,
                )
              : fail(`expected ${el.count} element(s) matching ${desc}, found ${n}`);
          }
          // count:0 (absence) with no state assertion → satisfied.
          if (!el.state) return pass(`found ${n} element(s) matching ${desc}`);
        }
        // State assertion.
        if (el.state) {
          const ok = await evalState(loc, el.state);
          if (!ok) {
            // Same rule as count: an unmet state after an unverifiable prior
            // action is unverifiable, not a fail.
            return priorActionUnverifiable
              ? unverifiable(`expected ${desc} to be ${el.state} — prior action was unverifiable`)
              : fail(`expected ${desc} to be ${el.state}`);
          }
          return pass(`${desc} is ${el.state}`);
        }
        // No count, no state → presence check. Not-found is a durability
        // FINDING (unverifiable), not a failure of the feature.
        const n = await loc.count();
        if (n < 1) {
          return unverifiable(
            `AC unverifiable: no element matching ${desc} (add an accessible name or testId)`,
          );
        }
        return pass(`found ${n} element(s) matching ${desc}`);
      } catch (err) {
        // Resolution threw (ambiguous / not found while computing state).
        return unverifiable(
          `AC unverifiable: could not resolve ${desc} (add an accessible name or testId) — ${(err as Error).message.split('\n')[0]}`,
        );
      }
    }

    // expect.network
    if (body.network) {
      const want = body.network;
      const wantStatus: StatusMatcher = want.status ?? '2xx';
      const methodLabel = want.method ?? 'ANY';
      // The request that satisfies this expect is usually triggered by the
      // PRECEDING action (a click that fires an async submit), so it may still
      // be in flight when we get here. Poll two observation sources until a
      // candidate appears or we time out:
      //   1. Playwright page.on('response') — URL mode (real network).
      //   2. The in-page __VALIDITY_REQUESTS__ log written by validity-msw —
      //      ISOLATION mode, where mocked fetches are served inside the page's
      //      JS realm and never reach Playwright. See prepare.ts trackRequest.
      const matches = (r: ObservedResponse): boolean =>
        methodMatches(want.method, r.method) && urlMatches(r.url, want.url);
      // Only a real Playwright page (has `evaluate`) can produce more traffic
      // while we wait; against a fake/unit page we evaluate once and decide.
      const canPoll = typeof page.evaluate === 'function';
      const deadline = canPoll ? Date.now() + CHECK_TIMEOUT_MS : Date.now();
      let candidates: ObservedResponse[] = [];
      for (;;) {
        const inPage = await readInPageRequests(page, sinceIndex);
        candidates = [...responses, ...inPage].filter(matches);
        if (candidates.length > 0 || Date.now() >= deadline) break;
        await waitMs(page, 100);
      }
      if (candidates.length === 0) {
        const detail =
          `no network response observed for ${methodLabel} ${want.url} ` +
          `(checked both Playwright responses and the in-page mock log)`;
        // If a prior action couldn't be driven, we never got to trigger this
        // request — that's unverifiable, not a feature failure.
        return priorActionUnverifiable
          ? unverifiable(`${detail} — prior action was unverifiable`)
          : fail(detail);
      }
      const satisfying = candidates.filter((r) => statusMatches(r.status, wantStatus));
      if (satisfying.length > 0) {
        // Attribution (A4): the verdict is keyed to the response that DECIDED
        // it. Prefer a declared satisfying candidate over a live
        // (Playwright-observed, provenance undefined) one over a fabricated
        // one — so a wildcard expect satisfied by a declared hit isn't tainted
        // by unrelated fabricated traffic matching the same predicate.
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
                : `${base} — response fabricated by the sandbox fallback (no declared handler for this endpoint)`
              : base;
        return { ...pass(detail), networkEvidence: observedEvidence(winner) };
      }
      const seen = candidates.map((r) => r.status).join(', ');
      return {
        ...fail(`${methodLabel} ${want.url} responded ${seen} but expected status ${wantStatus}`),
        // Stamp the deciding (first) candidate on the fail too — provenance
        // never upgrades/downgrades a fail, it only annotates the report.
        networkEvidence: observedEvidence(candidates[0]!),
      };
    }

    // expect.console
    if (body.console) {
      const count = consoleErrors();
      if (count <= body.console.errors) {
        return pass(`console.error count ${count} ≤ ${body.console.errors}`);
      }
      return fail(`console.error count ${count} exceeds allowed ${body.console.errors}`);
    }

    // expect.performance — read the in-page perf fold (Profiler commits +
    // Navigation/Paint Timing) and budget one metric against maxMs. The metric
    // enum value maps to a `<metric>Ms` field on the captured object. A metric
    // the runtime couldn't observe (no Profiler commit of that phase, no paint
    // entry yet, or a non-instrumented page) is `unverifiable`, NOT a fail —
    // the budget was never actually tested.
    if (body.performance) {
      const { metric, maxMs } = body.performance;
      const field = `${metric}Ms`;
      let perf: Record<string, number> | null = null;
      if (typeof page.evaluate === 'function') {
        try {
          perf = await page.evaluate(() => {
            const get = (
              window as unknown as { __VALIDITY_GET_PERF__?: () => Record<string, number> }
            ).__VALIDITY_GET_PERF__;
            return typeof get === 'function' ? get() : null;
          });
        } catch {
          perf = null;
        }
      }
      const measured = perf ? perf[field] : undefined;
      if (typeof measured !== 'number') {
        return unverifiable(
          `AC unverifiable: ${metric} not measured on this render (perf instrumentation produced no value)`,
        );
      }
      if (measured <= maxMs) {
        return pass(`${metric} ${measured}ms ≤ budget ${maxMs}ms`);
      }
      return fail(`${metric} ${measured}ms exceeds budget ${maxMs}ms`);
    }

    // expect.screenshot — the executor can't compare against a baseline: it
    // has no screenshot path or project root. Emit a stub `unverifiable`
    // verdict here; the caller (capture.ts) computes the baseline diff AFTER
    // the shot is taken and upgrades this verdict to pass/fail via
    // `evaluateScreenshotExpects`. If no baseline exists yet (or the diff
    // fails), this stub stays as-is — the agent re-runs after the baseline is
    // established.
    if (body.screenshot) {
      return unverifiable('no baseline exists yet for this variant');
    }

    // expect.a11y — run axe-core against the LIVE page (after any preceding
    // click/fill, so the assertion sees the post-interaction DOM) and count
    // violations at or above `severity`. A genuine over-budget count is a real
    // FAIL — the spec explicitly asserted an a11y budget, this is not a
    // durability finding. Axe throwing (page disposed, CSP blocked injection,
    // a fake/unit page with no real target) → `unverifiable`, never a silent
    // pass. CRITICAL false-green guard: if a prior action couldn't be driven,
    // the asserted post-interaction state was never reached, so a `pass` (e.g.
    // axe finding 0 violations on a blank/wrong-state page) is demoted to
    // `unverifiable`; a real violation `fail` still wins.
    if (body.a11y) {
      return evaluateA11yExpect(page, body.a11y, check, priorActionUnverifiable);
    }

    // expect.command — RUN-LEVEL (A5): executed once per verify run on the
    // host (see @validity.ai/verify-spec command-check.ts), never in the sandbox.
    // Defense in depth: if the run-level exclusion regresses and one leaks
    // into a render, this stub can only mint `unverifiable` — never a pass.
    if (body.command) {
      return unverifiable(
        `expect.command executes once per verify run at the run level — it is never ` +
          `executed in the sandbox (if you see this, run-level wiring skipped it)`,
      );
    }
  }

  // Unreachable: a Check is always one of the kinds above.
  return unverifiable('unknown check kind');
}

/**
 * Impacts kept for a given severity floor. Mirrors `a11y.ts`'s `impactsToKeep`
 * so a gating `expect.a11y` and the passive a11y report agree on what counts.
 */
export function a11yImpactsToKeep(severity: A11ySeverityFloor): Set<string> {
  switch (severity) {
    case 'critical':
      return new Set(['critical']);
    case 'serious':
      return new Set(['serious', 'critical']);
    case 'moderate':
      return new Set(['moderate', 'serious', 'critical']);
    case 'minor':
      return new Set(['minor', 'moderate', 'serious', 'critical']);
  }
}

/**
 * Count axe violations at or above `severity`. An ungraded (null/absent) impact
 * is treated as `minor` — matching `a11y.ts` (the passive report) and the
 * Playwright exporter, so the gate, the report, and the exported test all count
 * the same violations. (At the default `serious` floor `minor` is excluded, so
 * this only affects the `minor` floor, where the gate stays at least as strict
 * as the exported test — never more lenient.) Pure — unit-testable, no browser.
 */
export function countA11yViolations(
  violations: { impact?: string }[],
  severity: A11ySeverityFloor,
): number {
  const keep = a11yImpactsToKeep(severity);
  return violations.filter((v) => keep.has(v.impact ?? 'minor')).length;
}

/**
 * Mechanical pass/fail verdict for an `expect.a11y` against a list of axe
 * violations. Pure — extracted so the can-fail negative test needs no browser.
 * `pass` when the at-or-above-`severity` count is within `maxViolations` (both
 * with their schema defaults: severity `serious`, maxViolations 0); `fail`
 * otherwise, carrying the offending rule ids for the verdict detail.
 */
export function a11yVerdict(
  violations: { impact?: string; id?: string }[],
  want: A11yExpect,
): { status: 'pass' | 'fail'; count: number; ruleIds: string[] } {
  const severity = want.severity ?? 'serious';
  const maxViolations = want.maxViolations ?? 0;
  const count = countA11yViolations(violations, severity);
  const keep = a11yImpactsToKeep(severity);
  const ruleIds = violations
    .filter((v) => keep.has(v.impact ?? 'minor'))
    .map((v) => v.id)
    .filter((id): id is string => typeof id === 'string');
  return { status: count <= maxViolations ? 'pass' : 'fail', count, ruleIds };
}

/**
 * Run axe against the live page and fold into a single `CheckVerdict`. See the
 * `body.a11y` branch in `runOneCheck` for the false-green semantics; the verdict
 * arithmetic lives in the pure `a11yVerdict` so it is browser-free testable.
 */
async function evaluateA11yExpect(
  page: Page,
  want: A11yExpect,
  check: Check,
  priorActionUnverifiable: boolean,
): Promise<CheckVerdict> {
  const severity = want.severity ?? 'serious';
  const maxViolations = want.maxViolations ?? 0;
  let results: { violations: { impact?: string | null; id?: string }[] };
  try {
    results = await new AxeBuilder({ page }).analyze();
  } catch (err) {
    return {
      check,
      status: 'unverifiable',
      detail: `AC unverifiable: axe analysis failed (${(err as Error).message.split('\n')[0]}) — the a11y assertion could not be evaluated`,
    };
  }
  const verdict = a11yVerdict(
    results.violations.map((v) => ({ impact: v.impact ?? undefined, id: v.id })),
    want,
  );
  if (verdict.status === 'pass') {
    // False-green guard: a clean axe run on a page whose post-interaction state
    // was never reached (a prior action was unverifiable) proves nothing.
    if (priorActionUnverifiable) {
      return {
        check,
        status: 'unverifiable',
        detail: `a11y: ${verdict.count} violation${verdict.count === 1 ? '' : 's'} at ${severity}+ — prior action was unverifiable`,
      };
    }
    return {
      check,
      status: 'pass',
      detail: `a11y: ${verdict.count} violation${verdict.count === 1 ? '' : 's'} at ${severity}+ (≤ ${maxViolations} allowed)`,
    };
  }
  const ids = verdict.ruleIds.slice(0, 5).join(', ');
  return {
    check,
    status: 'fail',
    detail:
      `a11y: ${verdict.count} violation${verdict.count === 1 ? '' : 's'} at ${severity}+ exceeds ${maxViolations} allowed` +
      (ids ? ` (rules: ${ids})` : ''),
  };
}

/**
 * Run a single criterion's checks and fold them into one `CriterionVerdict`.
 * Mechanical: any fail → fail; else any unverifiable → unverifiable; else pass.
 *
 * TAINT post-step: after the fold, a criterion that would PASS but whose
 * `expect.network` checks consumed FABRICATED evidence (a permissive-proxy body
 * or an unmatched-URL fallback) is demoted to `unverifiable` — the assertion
 * never ran against a real backend, so a pass over-claims. We scope the read to
 * THIS criterion's requests (the log length snapshotted before its checks ran),
 * then run `isTaintedByNetworkExpect` with the same url/method predicate the
 * expect used. Cascading is primary: a `fail` stays `fail`, and an already
 * `unverifiable` verdict (e.g. a prior action couldn't be driven) keeps its
 * reasoning untouched — we only demote a clean `pass`.
 */
export async function runCriterionChecks(args: {
  page: Page;
  criterion: SpecCriterion;
  baseUrl?: string;
  /** See {@link executeChecks} `priorConsoleErrors` — seeds the console gate. */
  priorConsoleErrors?: number;
}): Promise<CriterionVerdict> {
  const { page, criterion, baseUrl, priorConsoleErrors } = args;
  const checks = criterion.checks ?? [];

  // Snapshot the in-page request-log length BEFORE the checks run, so the taint
  // read below sees only requests this criterion produced (the log is
  // page-lifetime and shared across criteria). Fake pages have no `evaluate`.
  const sinceIndex = await readInPageRequestCount(page);

  const verdicts = await executeChecks({ page, checks, baseUrl, priorConsoleErrors });
  const status = foldCheckVerdicts(verdicts);

  const tally = { pass: 0, fail: 0, unverifiable: 0 };
  for (const v of verdicts) tally[v.status] += 1;
  const detail =
    verdicts.length === 0
      ? 'no checks to execute'
      : `${tally.pass} pass, ${tally.fail} fail, ${tally.unverifiable} unverifiable`;

  // Only a clean PASS is a candidate for taint demotion, and only when the
  // criterion actually has an `expect.network` check (otherwise there is no
  // network evidence to be tainted).
  const hasNetworkExpect = checks.some((c) => isExpectCheck(c) && !!c.expect.network);
  if (status === 'pass' && hasNetworkExpect) {
    // Evidence attribution (A4): a folded `pass` means every check passed, so
    // each network expect's verdict carries the response that DECIDED it
    // (networkEvidence, stamped by the expect.network branch). Taint on the
    // DECIDING response only — a fabricated candidate that merely matched the
    // predicate without deciding the verdict no longer demotes. Verdicts
    // without evidence (old run data, fake unit pages) keep the legacy
    // predicate-wide fallback so behavior degrades to exactly today's.
    const networkVerdicts = verdicts.filter(
      (v) => isExpectCheck(v.check) && !!v.check.expect.network,
    );
    const reasons: string[] = [];
    let observedCache: ObservedResponse[] | undefined;
    const readObserved = async (): Promise<ObservedResponse[]> =>
      (observedCache ??= await readInPageRequests(page, sinceIndex));
    for (const v of networkVerdicts) {
      const ev = v.networkEvidence;
      if (ev) {
        if (ev.provenance !== 'fabricated') continue;
        // Name the catch-all pattern when one served it: fabricated evidence
        // never carries a handlerUrl (the foundation contract reserves it for
        // declared), so look the deciding response back up in the scoped log.
        const src = (await readObserved()).find(
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
      const t = isTaintedByNetworkExpect(await readObserved(), c.expect.network);
      if (t.tainted) reasons.push(...t.reasons);
    }
    if (reasons.length > 0) {
      return {
        id: criterion.id,
        tier: criterion.tier,
        status: 'unverifiable',
        detail: `${detail} — tainted: ${reasons.join('; ')}`,
        checks: verdicts,
        // Sticky marker so a downstream re-fold (e.g. capture.ts upgrading
        // screenshot checks then re-folding) can't flip this back to `pass`.
        // Dual-written: the legacy boolean keeps an OLDER Validity build's
        // refold sticky when it reads this run-meta; the unified list is what
        // new readers consume (via `evidenceTaintsOf`).
        networkTainted: true,
        evidenceTaints: ['network'],
        networkProvenance: 'fabricated',
      };
    }
    // Untainted network pass: roll the per-check evidence up for readers.
    // `declared` requires every network verdict to carry declared evidence —
    // the rollup yields undefined on any gap, so old data never gains a claim.
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

  return { id: criterion.id, tier: criterion.tier, status, detail, checks: verdicts };
}

/**
 * Post-execution upgrade for `expect.screenshot` verdicts.
 *
 * The executor itself can't compare against a baseline — it has no screenshot
 * path or project root, so `runOneCheck` emits a stub `unverifiable` verdict for
 * every `expect.screenshot` (see the `body.screenshot` branch above). Once the
 * shot is taken and the caller (capture.ts) has a `diffAgainstBaseline` result,
 * it threads the mismatched-pixel count back in here and we upgrade each
 * screenshot verdict to `pass`/`fail` against the criterion's `maxDiffPixels`
 * threshold (default 0 = exact match).
 *
 * Pure: returns a new array; non-screenshot verdicts and verdicts whose check
 * is not an `expect.screenshot` are returned unchanged. Only called when a
 * baseline diff actually exists — a missing baseline leaves the stub verdict in
 * place so the agent knows to re-run after the baseline is established.
 */
/**
 * Re-fold a criterion's status after its screenshot checks were upgraded from
 * the `unverifiable` stub to pass/fail (see `evaluateScreenshotExpects`), WHILE
 * preserving an evidence-taint demotion.
 *
 * SECURITY-CRITICAL: a criterion demoted to `unverifiable` because its evidence
 * carries a DEMOTING taint (fabricated network response, degraded wrapper,
 * unconfirmed native render — the legacy `networkTainted` boolean normalizes to
 * `'network'`) must NOT be flipped back to `pass` just because its screenshot
 * check now passes — that would let a passing screenshot launder the taint. The
 * demotion is STICKY: we only ever move toward a STRICTER status. A genuine
 * screenshot `fail` still wins (fail ⊐ unverifiable ⊐ pass); a screenshot `pass`
 * cannot lift the taint. Untainted verdicts fold normally. Pure — unit-testable.
 */
export function refoldAfterScreenshot(verdict: {
  networkTainted?: boolean;
  evidenceTaints?: EvidenceTaint[];
  checks: CheckVerdict[];
}): 'pass' | 'fail' | 'unverifiable' {
  const folded = foldCheckVerdicts(verdict.checks);
  return applyEvidenceTaints(folded, demotingTaintsOf(verdict));
}

export function evaluateScreenshotExpects(
  checks: CheckVerdict[],
  diffMetadata: { mismatchedPixels: number },
): CheckVerdict[] {
  return checks.map((check) => {
    const c = check.check;
    if (!isExpectCheck(c) || !c.expect.screenshot) return check;
    const maxDiffPixels = c.expect.screenshot.maxDiffPixels ?? 0;
    if (diffMetadata.mismatchedPixels <= maxDiffPixels) {
      return {
        ...check,
        status: 'pass',
        detail: `screenshot baseline match: ${diffMetadata.mismatchedPixels} mismatched pixels`,
      };
    }
    return {
      ...check,
      status: 'fail',
      detail: `screenshot baseline mismatch: ${diffMetadata.mismatchedPixels} pixels > ${maxDiffPixels} allowed`,
    };
  });
}
