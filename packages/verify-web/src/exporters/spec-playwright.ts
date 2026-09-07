/**
 * Spec-driven Playwright compiler (Phase 5).
 *
 * Distinct from `playwright.ts`: that exporter scaffolds a run-meta into
 * TODO `test.step` placeholders. THIS one compiles a FROZEN `Spec` directly
 * into real, executable assertions — the "hard proofs" with no Validity and
 * no LLM in the loop. Hard/property criteria become concrete getByRole /
 * waitForResponse / expect(...) calls; only soft criteria degrade (to
 * `test.fixme` stubs, so they stay visible rather than silently dropped).
 *
 * Pure string generation — no disk I/O. The caller decides `outDir` and
 * writes the returned files. Paths are relative.
 *
 * Mocking handoff: criteria flagged `mocking: 'required'` assume Validity's
 * mocked network was active. We translate the config's mockNetwork handlers
 * into a sibling `<id>.fixtures.ts` exporting `installMocks(page)` (page.route
 * calls) and have the spec file import + call it.
 */
import type {
  Check,
  ElementExpect,
  ExpectBody,
  MockNetworkConfig,
  MockNetworkHandler,
  Selector,
  Spec,
  SpecCriterion,
  StatusMatcher,
  ValidityConfig,
} from '@validity.ai/verify-spec';
import {
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
  type SelectOption,
} from '@validity.ai/verify-spec';
import { collectPlaywrightWarnings, type ExportWarning } from './spec-export-warnings.js';

export interface ExportSpecPlaywrightArgs {
  /** The (ideally frozen) spec to compile. */
  spec: Spec;
  /** Resolved validity config — needed for the mockNetwork → fixtures handoff. */
  config?: ValidityConfig;
  /** Base URL prepended to navigate() targets and emitted as a header hint. */
  baseUrl?: string;
}

export interface ExportedFile {
  /** RELATIVE path; the caller joins it with the chosen outDir. */
  path: string;
  contents: string;
}

export interface ExportSpecPlaywrightResult {
  files: ExportedFile[];
  /** Lossy-mapping warnings — surface at the CLI, not just inline in the file. */
  warnings: ExportWarning[];
}

/* ------------------------------------------------------------------ *
 * Local string helpers — copied (not imported) from playwright.ts so   *
 * this module owns no private cross-file coupling.                     *
 * ------------------------------------------------------------------ */

/** Safest JS-string serializer in Node: handles quotes/backslashes/unicode. */
function jsString(s: string): string {
  return JSON.stringify(s);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * Translate Validity's url-pattern dialect (`/api/contact`, `/api/*`, full
 * URLs) into a Playwright glob string for `page.route` / a predicate-friendly
 * fragment. The glob `**\/api/contact` matches any host.
 */
function routePattern(url: string): string {
  if (/^https?:\/\//.test(url)) return jsString(url);
  if (url.endsWith('/*')) return jsString(`**${url.slice(0, -2)}/**`);
  return jsString(`**${url}`);
}

/* ------------------------------------------------------------------ *
 * Selector → locator codegen.                                          *
 * ------------------------------------------------------------------ */

/**
 * Map an accessibility-first selector to a Playwright locator expression
 * (the text after `page.`). role+name is the durable pair → getByRole; the
 * remaining strategies fall through in priority order:
 *   role → testId → label → placeholder → text → name-fallback.
 * testId sits ABOVE label/placeholder because a stable `data-testid` is a more
 * durable target than a form label/placeholder that can change with copy/i18n
 * (this ORDER MUST match check-executor.ts `locatorFor`, or export and sandbox
 * resolution target different elements for the same selector). `.nth(n)` is
 * appended when the selector disambiguates by index.
 */
function locatorExpr(sel: Selector): string {
  let base: string;
  if (sel.role) {
    base = sel.name
      ? `getByRole(${jsString(sel.role)}, { name: ${jsString(sel.name)} })`
      : `getByRole(${jsString(sel.role)})`;
  } else if (sel.testId) {
    base = `getByTestId(${jsString(sel.testId)})`;
  } else if (sel.label) {
    base = `getByLabel(${jsString(sel.label)})`;
  } else if (sel.placeholder) {
    base = `getByPlaceholder(${jsString(sel.placeholder)})`;
  } else if (sel.text) {
    base = `getByText(${jsString(sel.text)})`;
  } else if (sel.name) {
    // No role but a name: best-effort fall back to an accessible-name text
    // match. getByText matches VISIBLE TEXT, not the accessible name, so this
    // is flagged inline (NAME_FALLBACK_NOTE) and warned (see usesNameFallback).
    base = `getByText(${jsString(sel.name)})`;
  } else {
    // Should be unreachable — the schema requires at least one field.
    base = `getByText('')`;
  }
  if (sel.nth !== undefined) base += `.nth(${sel.nth})`;
  return `page.${base}`;
}

/**
 * True when a selector will compile to the accessible-name → `getByText`
 * fallback: a `name` set with role/testId/label/placeholder/text all absent.
 * Mirrors the last real branch of locatorExpr EXACTLY so the inline note and
 * the `collectPlaywrightWarnings` degraded warning fire on the same selectors.
 */
function usesNameFallback(sel: Selector): boolean {
  return (
    Boolean(sel.name) && !sel.role && !sel.testId && !sel.label && !sel.placeholder && !sel.text
  );
}

const NAME_FALLBACK_NOTE =
  '// NOTE: accessible-name fallback — getByText matches VISIBLE TEXT, not the accessible name; add a role or testId.';

/** Build a `r.url().includes(...)`-style predicate fragment for waitForResponse. */
function networkPredicate(url: string, method?: string, statusVarName = 'r'): string {
  const urlGuard = `${statusVarName}.url().includes(${jsString(stripGlob(url))})`;
  const methodGuard = method
    ? ` && ${statusVarName}.request().method() === ${jsString(method)}`
    : '';
  return `${urlGuard}${methodGuard}`;
}

/** Strip glob/asterisk noise so `includes()` matching is meaningful. */
function stripGlob(url: string): string {
  return url.replace(/^\*+/, '').replace(/\/\*$/, '').replace(/\*/g, '');
}

/* ------------------------------------------------------------------ *
 * Status-class matching (`2xx`, `4xx`, exact numbers).                 *
 * ------------------------------------------------------------------ */

function statusAssertion(matcher: StatusMatcher | undefined, respVar = 'resp'): string {
  // Default to 2xx when omitted, matching NetworkExpect's documented default.
  const m = matcher ?? '2xx';
  if (typeof m === 'number') {
    return `expect(${respVar}.status()).toBe(${m});`;
  }
  // Class like '2xx' → check the leading digit via the inline `statusClass` helper.
  const lead = m[0];
  return `expect(statusClass(${respVar}.status())).toBe(${jsString(`${lead}xx`)});`;
}

/* ------------------------------------------------------------------ *
 * Check → statement codegen.                                           *
 * ------------------------------------------------------------------ */

interface CheckCodegenCtx {
  /** Indentation prefix for each emitted line. */
  indent: string;
  baseUrl?: string;
  /** Set true once a network expect is emitted (so we know to declare helpers). */
  flags: { usedNetwork: boolean; usedConsole: boolean };
}

/** Join a navigate target onto baseUrl when one is configured. */
function joinUrl(baseUrl: string | undefined, url: string): string {
  if (/^https?:\/\//.test(url)) return url;
  if (!baseUrl) return url;
  const left = baseUrl.replace(/\/+$/, '');
  const right = url.replace(/^\/+/, '');
  return `${left}/${right}`;
}

function emitCheck(check: Check, ctx: CheckCodegenCtx): string[] {
  const { indent } = ctx;
  if (isNavigateCheck(check)) {
    return [`${indent}await page.goto(${jsString(joinUrl(ctx.baseUrl, check.navigate.url))});`];
  }
  if (isClickCheck(check)) {
    const note = usesNameFallback(check.click) ? [`${indent}${NAME_FALLBACK_NOTE}`] : [];
    return [...note, `${indent}await ${locatorExpr(check.click)}.click();`];
  }
  if (isPressCheck(check)) {
    // Keyboard press: page-level (active element) or locator.press when scoped.
    const { key, times, selector } = pressKeyAndTimes(check.press);
    if (selector) {
      const note = usesNameFallback(selector) ? [`${indent}${NAME_FALLBACK_NOTE}`] : [];
      const line = `${indent}await ${locatorExpr(selector)}.press(${jsString(key)});`;
      return [...note, ...Array.from({ length: times }, () => line)];
    }
    const line = `${indent}await page.keyboard.press(${jsString(key)});`;
    return Array.from({ length: times }, () => line);
  }
  if (isHoverCheck(check)) {
    const note = usesNameFallback(check.hover) ? [`${indent}${NAME_FALLBACK_NOTE}`] : [];
    return [...note, `${indent}await ${locatorExpr(check.hover)}.hover();`];
  }
  if (isFillCheck(check)) {
    const { value, ...sel } = check.fill;
    const note = usesNameFallback(sel) ? [`${indent}${NAME_FALLBACK_NOTE}`] : [];
    return [...note, `${indent}await ${locatorExpr(sel)}.fill(${jsString(value)});`];
  }
  if (isWaitCheck(check)) {
    const body = check.wait;
    if (body.ms !== undefined) {
      return [`${indent}await page.waitForTimeout(${body.ms});`];
    }
    const sel = body.for!;
    const state = body.state ?? 'visible';
    const note = usesNameFallback(sel) ? [`${indent}${NAME_FALLBACK_NOTE}`] : [];
    return [...note, `${indent}await ${locatorExpr(sel)}.waitFor({ state: ${jsString(state)} });`];
  }
  if (isWaitForRequestCheck(check)) {
    const want = check.waitForRequest;
    const timeout = want.timeoutMs !== undefined ? `, { timeout: ${want.timeoutMs} }` : '';
    const re = parseRegexLiteral(want.url);
    const urlGuard = re
      ? `new RegExp(${jsString(re.source)}, ${jsString(re.flags)}).test(r.url())`
      : `r.url().includes(${jsString(stripGlob(want.url))})`;
    const methodGuard = want.method ? ` && r.method() === ${jsString(want.method)}` : '';
    return [`${indent}await page.waitForRequest((r) => ${urlGuard}${methodGuard}${timeout});`];
  }
  if (isSelectCheck(check)) {
    const { selector, option } = check.select;
    const note = usesNameFallback(selector) ? [`${indent}${NAME_FALLBACK_NOTE}`] : [];
    return [
      ...note,
      `${indent}await ${locatorExpr(selector)}.selectOption(${selectOptionExpr(option)});`,
    ];
  }
  if (isScrollCheck(check)) {
    const body = check.scroll;
    if (body.intoView && body.selector) {
      const note = usesNameFallback(body.selector) ? [`${indent}${NAME_FALLBACK_NOTE}`] : [];
      return [...note, `${indent}await ${locatorExpr(body.selector)}.scrollIntoViewIfNeeded();`];
    }
    if (body.to) {
      if (body.selector) {
        const note = usesNameFallback(body.selector) ? [`${indent}${NAME_FALLBACK_NOTE}`] : [];
        const top = body.to === 'bottom' ? 'el.scrollHeight' : '0';
        return [
          ...note,
          `${indent}await ${locatorExpr(body.selector)}.evaluate((el) => { el.scrollTo(0, ${top}); });`,
        ];
      }
      const top = body.to === 'bottom' ? 'document.documentElement.scrollHeight' : '0';
      return [`${indent}await page.evaluate(() => { window.scrollTo(0, ${top}); });`];
    }
    if (body.by) {
      const dx = body.by.x ?? 0;
      const dy = body.by.y ?? 0;
      if (body.selector) {
        const note = usesNameFallback(body.selector) ? [`${indent}${NAME_FALLBACK_NOTE}`] : [];
        return [
          ...note,
          `${indent}await ${locatorExpr(body.selector)}.evaluate((el) => { el.scrollBy(${dx}, ${dy}); });`,
        ];
      }
      return [`${indent}await page.mouse.wheel(${dx}, ${dy});`];
    }
    return [`${indent}// (scroll skipped — no to/by/intoView)`];
  }
  if (isExpectCheck(check)) {
    return emitExpect(check.expect, ctx);
  }
  return [`${indent}// (unrecognized check skipped)`];
}

function selectOptionExpr(option: SelectOption): string {
  if (typeof option === 'string') return jsString(option);
  const parts: string[] = [];
  if (option.label !== undefined) parts.push(`label: ${jsString(option.label)}`);
  if (option.value !== undefined) parts.push(`value: ${jsString(option.value)}`);
  if (option.index !== undefined) parts.push(`index: ${option.index}`);
  return `{ ${parts.join(', ')} }`;
}

function emitExpect(body: ExpectBody, ctx: CheckCodegenCtx): string[] {
  const { indent } = ctx;
  if (body.element) return emitElementExpect(body.element).map((l) => `${indent}${l}`);
  if (body.network) {
    ctx.flags.usedNetwork = true;
    const net = body.network;
    return [
      `${indent}const resp = await page.waitForResponse((r) => ${networkPredicate(
        net.url,
        net.method,
      )});`,
      `${indent}${statusAssertion(net.status)}`,
    ];
  }
  if (body.console) {
    ctx.flags.usedConsole = true;
    return [`${indent}expect(consoleErrors.length).toBeLessThanOrEqual(${body.console.errors});`];
  }
  if (body.performance) {
    // Performance budgets are measured in Validity's sandbox via a React
    // Profiler + Navigation/Paint Timing; an exported Playwright test runs
    // against the real app with no such instrumentation, so we emit an honest
    // TODO rather than a green assertion that proves nothing. `load` / FCP can
    // be approximated from Playwright's Navigation Timing if desired.
    const p = body.performance;
    return [
      `${indent}// TODO (perf): budget "${oneLine(`${p.metric} <= ${p.maxMs}ms`)}" is measured in Validity's`,
      `${indent}//   sandbox (React Profiler + timing) — not portable to an exported test.`,
      `${indent}//   Verify it in Validity, or approximate via page.evaluate(() => performance...).`,
    ];
  }
  if (body.screenshot) {
    const name = body.screenshot.name;
    const maxDiff = body.screenshot.maxDiffPixels;
    const optObj = maxDiff !== undefined ? `, { maxDiffPixels: ${maxDiff} }` : '';
    if (name) {
      // Sanitize the baseline name into a filesystem-safe snapshot filename
      // (Playwright uses it verbatim on disk): 'after: open' → 'after-open.png'.
      const file = `${name.replace(/\W+/g, '-')}.png`;
      return [`${indent}await expect(page).toHaveScreenshot(${jsString(file)}${optObj});`];
    }
    // No name: the arg list is just the (optional) options object — slice off the
    // leading ', ' so `toHaveScreenshot({ … })` / `toHaveScreenshot()` stay valid.
    return [`${indent}await expect(page).toHaveScreenshot(${optObj ? optObj.slice(2) : ''});`];
  }
  if (body.a11y) {
    // Axe-core's Playwright adapter exposes `AxeBuilder.analyze()`. We emit a
    // self-contained analyze+impact-filter+assert (no tag filter — to match the
    // web executor's unfiltered run so the exported counts agree with Validity's)
    // rather than depending on the custom `expect(page).toPassA11y()` matcher.
    const severity = body.a11y.severity ?? 'serious';
    const maxViolations = body.a11y.maxViolations ?? 0;
    const impacts =
      severity === 'critical'
        ? "['critical']"
        : severity === 'serious'
          ? "['serious', 'critical']"
          : severity === 'moderate'
            ? "['moderate', 'serious', 'critical']"
            : "['minor', 'moderate', 'serious', 'critical']";
    return [
      `${indent}const axeResults = await new AxeBuilder({ page }).analyze();`,
      `${indent}const a11yViolations = axeResults.violations.filter((v) => ${impacts}.includes(v.impact ?? 'minor'));`,
      `${indent}expect(a11yViolations.length).toBeLessThanOrEqual(${maxViolations});`,
    ];
  }
  if (body.command) {
    // Command checks are run-level (executed once per verify on the host, not
    // in the browser) — emit an honest TODO, never a green assertion.
    return [
      `${indent}// TODO (run-level): Validity runs the named command '${oneLine(body.command.run)}' once`,
      `${indent}//   per verify (resolved from .validity/config.ts \`commands\`). Run it as a`,
      `${indent}//   separate CI step — it is not a browser assertion.`,
    ];
  }
  return [`${indent}// (empty expect skipped)`];
}

/**
 * element expect → toBeVisible/Hidden/Enabled/Disabled/Checked or toHaveCount.
 * Returns un-indented lines (the caller adds indent): the accessible-name
 * fallback note and the count+state degradation TODO ride alongside the
 * assertion.
 */
function emitElementExpect(el: ElementExpect): string[] {
  const { state, count, ...sel } = el;
  const s = sel as Selector;
  const loc = locatorExpr(s);
  const note = usesNameFallback(s) ? [NAME_FALLBACK_NOTE] : [];
  if (count !== undefined) {
    const lines = [...note, `await expect(${loc}).toHaveCount(${count});`];
    if (state !== undefined) {
      // count + state both set: toHaveCount is the assertion; the state can't be
      // co-asserted on the same matcher (a parity-exact 'degraded' warning fires
      // for exactly this branch). Flag the dropped state so the loss is visible.
      lines.push(`// TODO (lossy): state '${state}' not asserted alongside count ${count}.`);
    }
    return lines;
  }
  switch (state) {
    case 'hidden':
      return [...note, `await expect(${loc}).toBeHidden();`];
    case 'enabled':
      return [...note, `await expect(${loc}).toBeEnabled();`];
    case 'disabled':
      return [...note, `await expect(${loc}).toBeDisabled();`];
    case 'checked':
      return [...note, `await expect(${loc}).toBeChecked();`];
    case 'focused':
      return [...note, `await expect(${loc}).toBeFocused();`];
    case 'visible':
    default:
      return [...note, `await expect(${loc}).toBeVisible();`];
  }
}

/* ------------------------------------------------------------------ *
 * Test body assembly.                                                  *
 * ------------------------------------------------------------------ */

/** Does any check in this criterion assert console errors? */
function criterionUsesConsole(criterion: SpecCriterion): boolean {
  return (criterion.checks ?? []).some((c) => isExpectCheck(c) && Boolean(c.expect.console));
}

/** Does this criterion need the mocks installed? */
function criterionRequiresMocks(criterion: SpecCriterion): boolean {
  return criterion.mocking === 'required';
}

function emitTest(
  criterion: SpecCriterion,
  args: ExportSpecPlaywrightArgs,
  hasFixtures: boolean,
): string[] {
  const indent = '    ';
  const lines: string[] = [];
  const title = `${criterion.id}: ${criterion.text}`;
  lines.push(`  test(${jsString(title)}, async ({ page }) => {`);

  const usesConsole = criterionUsesConsole(criterion);
  if (usesConsole) {
    lines.push(`${indent}// Collect console errors so the console expect can assert the budget.`);
    lines.push(`${indent}const consoleErrors: string[] = [];`);
    lines.push(
      `${indent}page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });`,
    );
    lines.push('');
  }

  if (hasFixtures && criterionRequiresMocks(criterion)) {
    lines.push(`${indent}// mocking: required — install the sandbox network fixtures.`);
    lines.push(`${indent}await installMocks(page);`);
    lines.push('');
  } else if (criterionRequiresMocks(criterion)) {
    // FIX 11: the spec asked for mocks but no mockNetwork handlers were configured,
    // so the fixtures file was never emitted. Say so loudly — the network assertions
    // below will hit the real backend.
    lines.push(
      `${indent}// TODO: mocking: required, but no mockNetwork handlers were configured — these network assertions will hit the real backend and may not match the sandbox.`,
    );
    lines.push('');
  }

  const ctx: CheckCodegenCtx = {
    indent,
    baseUrl: args.baseUrl,
    flags: { usedNetwork: false, usedConsole: usesConsole },
  };

  // FIX 9: a `page.waitForResponse` registered AFTER its triggering action races
  // the response — it can arrive before the listener exists, so the test hangs or
  // misses it. Pre-scan the checks: for each network expect that follows an action
  // (click/fill) in this criterion, HOIST an un-awaited `const respN = page.wait…`
  // BEFORE the triggering action, then `await` it at the expect position.
  const checks = criterion.checks ?? [];
  const hoistBefore = new Map<number, string[]>(); // action index → listener lines
  const hoistedVar = new Map<number, string>(); // network-expect index → promise var
  let netCount = 0;
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i]!;
    if (!(isExpectCheck(c) && c.expect.network)) continue;
    // Nearest preceding action check is the trigger (a press like Enter or a
    // hover-to-prefetch can fire a request just as a click/fill can).
    let j = i - 1;
    while (
      j >= 0 &&
      !(
        isClickCheck(checks[j]!) ||
        isFillCheck(checks[j]!) ||
        isPressCheck(checks[j]!) ||
        isHoverCheck(checks[j]!) ||
        isSelectCheck(checks[j]!)
      )
    )
      j--;
    if (j < 0) continue; // no triggering action → fall back to the inline form.
    netCount += 1;
    const promiseVar = `resp${netCount}`;
    hoistedVar.set(i, promiseVar);
    const net = c.expect.network;
    const listener = `${indent}const ${promiseVar} = page.waitForResponse((r) => ${networkPredicate(
      net.url,
      net.method,
    )});`;
    const arr = hoistBefore.get(j) ?? [];
    arr.push(listener);
    hoistBefore.set(j, arr);
  }

  for (let i = 0; i < checks.length; i++) {
    const c = checks[i]!;
    const hoist = hoistBefore.get(i);
    if (hoist) lines.push(...hoist);
    const promiseVar = hoistedVar.get(i);
    if (promiseVar && isExpectCheck(c) && c.expect.network) {
      // Await the pre-registered listener, then assert its status.
      ctx.flags.usedNetwork = true;
      const resolved = `${promiseVar}Resp`;
      lines.push(`${indent}const ${resolved} = await ${promiseVar};`);
      lines.push(`${indent}${statusAssertion(c.expect.network.status, resolved)}`);
      continue;
    }
    lines.push(...emitCheck(c, ctx));
  }

  lines.push(`  });`);
  return lines;
}

/** Round a viewport width into a sensible height (4:3-ish), 800 default. */
function viewportHeight(width: number): number {
  return Math.round(width * 0.75) || 800;
}

/**
 * The exporter's fixtures decision, exported so every consumer (the exporter
 * itself, the warning collectors' callers, the maturity assessor) computes the
 * SAME value — "the warning agrees with the file that was written" must hold
 * across all of them (see CollectPlaywrightWarningsArgs.hasFixtures).
 */
export function computeHasFixtures(spec: Spec, config?: ValidityConfig): boolean {
  const anyMockRequired = spec.criteria.some(criterionRequiresMocks);
  return anyMockRequired && (config?.mockNetwork?.handlers?.length ?? 0) > 0;
}

/**
 * Canonical artifact basenames: `<specId>.v<version>.*`. The version is IN the
 * filename so an artifact is unambiguously bound to one frozen contract and a
 * version bump can never silently overwrite the file a CI run is executing
 * (the drift check prunes superseded versions instead).
 */
export function playwrightSpecFileName(spec: Pick<Spec, 'id' | 'version'>): string {
  return `${spec.id}.v${spec.version}.spec.ts`;
}
export function playwrightFixturesFileName(spec: Pick<Spec, 'id' | 'version'>): string {
  return `${spec.id}.v${spec.version}.fixtures.ts`;
}

/**
 * The canonical DO-NOT-EDIT header (plan §B2). Byte-deterministic for a given
 * (spec, exporter version): no timestamps — `generatedAt` lives ONLY in the
 * exports manifest, never in artifact bytes.
 */
function generatedHeader(spec: Spec, comment: string): string[] {
  return [
    `${comment} GENERATED from ${spec.id}@v${spec.version} (${spec.hash ?? 'unfrozen'}) — DO NOT EDIT;`,
    `${comment} regenerate with \`validity spec export ${spec.id}\`.`,
  ];
}

export function exportSpecToPlaywright(args: ExportSpecPlaywrightArgs): ExportSpecPlaywrightResult {
  const { spec } = args;
  const files: ExportedFile[] = [];

  // Partition criteria by tier.
  const hardish = spec.criteria.filter((c) => c.tier === 'hard' || c.tier === 'property');
  const soft = spec.criteria.filter((c) => c.tier === 'soft');

  // Fixtures handoff — only if some criterion requires mocks AND we have handlers.
  const mergedMock = mergeMockNetwork(args.config?.mockNetwork);
  const hasFixtures = computeHasFixtures(spec, args.config);
  const fixturesPath = playwrightFixturesFileName(spec);
  if (hasFixtures) {
    files.push({ path: fixturesPath, contents: renderFixtures(spec, mergedMock) });
  }

  // Header.
  const header: string[] = [
    ...generatedHeader(spec, '//'),
    `//`,
    `// Source prompt: ${oneLine(spec.source.prompt)}`,
  ];
  if (args.baseUrl) {
    header.push(`// baseURL: ${args.baseUrl}`);
  } else {
    header.push(
      `// TODO: set baseURL (via playwright.config.ts) — navigate() targets are relative.`,
    );
  }

  const body: string[] = [];
  body.push(header.join('\n'));
  body.push('');
  body.push(`import { test, expect } from '@playwright/test';`);
  if (hasFixtures) {
    body.push(`import { installMocks } from './${spec.id}.v${spec.version}.fixtures';`);
  }
  // Axe import only when at least one expect.a11y check is present.
  const anyA11y = hardish.some((c) =>
    (c.checks ?? []).some((ch) => isExpectCheck(ch) && Boolean(ch.expect.a11y)),
  );
  if (anyA11y) {
    body.push(`import { AxeBuilder } from '@axe-core/playwright';`);
  }
  body.push('');

  // Inline status-class helper if any network check is present.
  const anyNetwork = hardish.some((c) =>
    (c.checks ?? []).some((ch) => isExpectCheck(ch) && Boolean(ch.expect.network)),
  );
  if (anyNetwork) {
    body.push(`// Maps an HTTP status to its class string ('2xx', '4xx', …) for class matchers.`);
    body.push(`const statusClass = (s: number): string => \`\${Math.floor(s / 100)}xx\`;`);
    body.push('');
  }

  // The describe bodies (one per viewport, or a single un-viewporting describe).
  const viewports = spec.conditions?.viewports ?? [];
  const innerLines: string[] = [];
  for (const c of hardish) innerLines.push(...emitTest(c, args, hasFixtures));
  for (const c of soft) {
    innerLines.push(
      `  test.fixme(${jsString(`${c.id}: ${c.text} (soft — review visually)`)}, async () => {});`,
    );
  }

  if (viewports.length > 0) {
    for (const w of viewports) {
      const h = viewportHeight(w);
      body.push(`test.describe(${jsString(`${spec.id} @ ${w}w`)}, () => {`);
      body.push(`  test.use({ viewport: { width: ${w}, height: ${h} } });`);
      body.push('');
      body.push(...innerLines);
      body.push(`});`);
      body.push('');
    }
  } else {
    body.push(`test.describe(${jsString(spec.id)}, () => {`);
    body.push(...innerLines);
    body.push(`});`);
    body.push('');
  }

  files.push({ path: playwrightSpecFileName(spec), contents: body.join('\n') });

  const warnings = collectPlaywrightWarnings({
    spec,
    hasFixtures,
    hasBaseUrl: Boolean(args.baseUrl),
    mockFallback: args.config?.mockNetwork?.fallback,
  });
  return { files, warnings };
}

/* ------------------------------------------------------------------ *
 * Fixtures file generation.                                            *
 * ------------------------------------------------------------------ */

function mergeMockNetwork(mock?: MockNetworkConfig): MockNetworkConfig {
  return { handlers: mock?.handlers ?? [], fallback: mock?.fallback };
}

function renderFixtures(spec: Spec, mock: MockNetworkConfig): string {
  const handlers = mock.handlers ?? [];
  const lines: string[] = [];
  lines.push(...generatedHeader(spec, '//'));
  lines.push(`//`);
  lines.push(`// Network fixtures translated from Validity's mocked network. These let an`);
  lines.push(`// exported test mean the SAME thing it did in the sandbox for criteria`);
  lines.push(`// flagged \`mocking: required\`. Swap for real backend fixtures if your suite`);
  lines.push(`// already manages test data.`);
  lines.push('');
  lines.push(`import type { Page } from '@playwright/test';`);
  lines.push('');
  lines.push(`export interface MockHandler {`);
  lines.push(`  url: string;`);
  lines.push(`  method?: string;`);
  lines.push(`  status: number;`);
  lines.push(`  body: string;`);
  lines.push(`  headers?: Record<string, string>;`);
  lines.push(`}`);
  lines.push('');
  lines.push(`export const handlers: MockHandler[] = [`);
  for (const h of handlers) {
    lines.push(`  ${serializeHandlerLiteral(h)},`);
  }
  lines.push(`];`);
  lines.push('');
  lines.push(`/** Install every fixture as a page.route() interceptor. */`);
  lines.push(`export async function installMocks(page: Page): Promise<void> {`);
  // The unmatched-request catch-all is registered FIRST so the explicit
  // handlers below take precedence (Playwright: most-recently-registered wins).
  lines.push(...renderFallbackCatchAll(mock.fallback));
  for (const h of handlers) {
    lines.push(...renderRouteLines(h));
  }
  lines.push(`}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * The catch-all `page.route('**', …)` that mirrors the sandbox's
 * `mockNetwork.fallback` for requests no explicit handler matched — without it,
 * an unmatched call silently hits the REAL backend (and `fallback: 'reject'`,
 * which the sandbox BLOCKS, would invert to a success). Scoped to fetch/xhr so
 * documents/scripts/styles/images still load. Registered before the explicit
 * handlers by the caller; explicit handlers win via Playwright's
 * most-recently-registered-first matching.
 */
function renderFallbackCatchAll(fallback: MockNetworkConfig['fallback']): string[] {
  const lines: string[] = [];
  lines.push(`  // Fallback for requests no explicit handler matched — mirrors the sandbox's`);
  lines.push(`  // mockNetwork.fallback so unmatched calls can't silently hit the real backend.`);
  lines.push(`  // Playwright matches routes most-recently-first, so registering this before the`);
  lines.push(`  // explicit handlers lets them take precedence. Only fetch/xhr are intercepted.`);
  lines.push(`  await page.route('**', async (route) => {`);
  lines.push(`    const type = route.request().resourceType();`);
  lines.push(`    if (type !== 'fetch' && type !== 'xhr') return route.continue();`);
  if (fallback === 'reject') {
    lines.push(`    // Sandbox fallback 'reject' blocked unmatched API calls — abort to match.`);
    lines.push(`    return route.abort();`);
  } else if (fallback && typeof fallback === 'object') {
    // Custom fallback response object — replay it verbatim (portable; no warning).
    const status = fallback.status ?? 200;
    const contentType =
      fallback.json !== undefined
        ? 'application/json'
        : fallback.text !== undefined
          ? 'text/plain; charset=utf-8'
          : undefined;
    const bodyLiteral =
      fallback.json !== undefined
        ? `JSON.stringify(${JSON.stringify(fallback.json)})`
        : fallback.text !== undefined
          ? jsString(fallback.text)
          : `''`;
    const headers = {
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(fallback.headers ?? {}),
    };
    lines.push(`    // Sandbox fallback was a custom response — replayed here verbatim.`);
    lines.push(`    return route.fulfill({`);
    lines.push(`      status: ${status},`);
    if (Object.keys(headers).length > 0) {
      lines.push(`      headers: ${JSON.stringify(headers)},`);
    }
    lines.push(`      body: ${bodyLiteral},`);
    lines.push(`    });`);
  } else if (fallback === 'populate') {
    // Synthetic populated data in the sandbox — NOT portable; return {} and warn.
    lines.push(`    // Sandbox fallback 'populate' returned SYNTHETIC data — not portable; this`);
    lines.push(
      `    //   returns an empty {}. Add explicit handlers for anything the tests assert.`,
    );
    lines.push(...fulfillEmptyJsonLines());
  } else {
    // 'permissive' (or unset default): sandbox returned a shape-aware empty body.
    lines.push(`    // Sandbox fallback 'permissive' returned a shape-aware empty body; this`);
    lines.push(
      `    //   returns an empty {}. Add explicit handlers for anything the tests assert.`,
    );
    lines.push(...fulfillEmptyJsonLines());
  }
  lines.push(`  });`);
  return lines;
}

/** The `route.fulfill` that returns an empty JSON object (permissive/populate). */
function fulfillEmptyJsonLines(): string[] {
  return [
    `    return route.fulfill({`,
    `      status: 200,`,
    `      headers: { 'content-type': 'application/json' },`,
    `      body: '{}',`,
    `    });`,
  ];
}

function serializeHandlerLiteral(h: MockNetworkHandler): string {
  const status = h.status ?? 200;
  const body =
    h.json !== undefined
      ? `JSON.stringify(${JSON.stringify(h.json)})`
      : h.text !== undefined
        ? jsString(h.text)
        : `''`;
  const parts = [`url: ${jsString(h.url)}`];
  if (h.method && h.method !== '*') parts.push(`method: ${jsString(h.method)}`);
  parts.push(`status: ${status}`);
  parts.push(`body: ${body}`);
  if (h.headers && Object.keys(h.headers).length > 0) {
    parts.push(`headers: ${JSON.stringify(h.headers)}`);
  }
  return `{ ${parts.join(', ')} }`;
}

function renderRouteLines(h: MockNetworkHandler): string[] {
  const status = h.status ?? 200;
  const contentType =
    h.json !== undefined
      ? 'application/json'
      : h.text !== undefined
        ? 'text/plain; charset=utf-8'
        : undefined;
  const bodyLiteral =
    h.json !== undefined
      ? `JSON.stringify(${JSON.stringify(h.json)})`
      : h.text !== undefined
        ? jsString(h.text)
        : `''`;
  const methodGuard = h.method && h.method !== '*' ? h.method : undefined;
  const headers = { ...(contentType ? { 'content-type': contentType } : {}), ...(h.headers ?? {}) };
  const lines: string[] = [];
  lines.push(`  await page.route(${routePattern(h.url)}, async (route) => {`);
  if (methodGuard) {
    lines.push(
      `    if (route.request().method() !== ${jsString(methodGuard)}) return route.fallback();`,
    );
  }
  lines.push(`    await route.fulfill({`);
  lines.push(`      status: ${status},`);
  if (Object.keys(headers).length > 0) {
    lines.push(`      headers: ${JSON.stringify(headers)},`);
  }
  lines.push(`      body: ${bodyLiteral},`);
  lines.push(`    });`);
  lines.push(`  });`);
  return lines;
}
