/**
 * Export warnings — surface lossy mappings loudly at the CLI, not just inline
 * in the generated files.
 *
 * Both the Playwright and Maestro exporters degrade certain spec constructs to
 * TODO comments / `test.fixme` stubs. Without a CLI warning, the user only
 * sees that degradation by reading the generated file — which they often
 * don't, until CI runs the suite and the assertion is silently absent.
 *
 * These are advisory strings, not verdicts — they can't false-green a gate.
 * The integrity concern is the INVERSE: a degradation that fires NO warning
 * lets a user trust an exported `test.fixme`/TODO as if it asserted something.
 * So every degradation the exporters perform must produce a warning, and a
 * fully-supported spec must produce none (no cry-wolf).
 *
 * Severity (ordered by how broken the exported test is):
 *   - `wont-run`     — the generated step can't run at all (e.g. Maestro
 *                      can't observe network). The exported file has a TODO
 *                      comment / `test.fixme` in place of a real assertion.
 *   - `needs-setup`  — the step runs but needs the user to wire something up
 *                      (e.g. `mocking: required` with no config handlers →
 *                      the exported test hits the real backend).
 *   - `degraded`     — the step runs but is weaker than the sandbox check
 *                      (e.g. Playwright's `toHaveScreenshot` needs a committed
 *                      baseline; without one, the first run just captures).
 */
import type {
  MaestroExportConfig,
  MockNetworkConfig,
  Spec,
  SpecCriterion,
  Check,
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
} from '@validity.ai/verify-spec';

export type ExportWarningSeverity = 'wont-run' | 'needs-setup' | 'degraded';

export interface ExportWarning {
  /** Which part of the spec triggered the warning. */
  scope: string;
  severity: ExportWarningSeverity;
  message: string;
}

/** True when this criterion has at least one `expect.console` check. */
function hasConsoleExpect(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isExpectCheck(ch) && Boolean(ch.expect.console));
}

/** True when this criterion has at least one `expect.network` check. */
function hasNetworkExpect(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isExpectCheck(ch) && Boolean(ch.expect.network));
}

/** True when this criterion has at least one `expect.performance` check. */
function hasPerformanceExpect(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isExpectCheck(ch) && Boolean(ch.expect.performance));
}

/** True when this criterion has at least one `expect.screenshot` check. */
function hasScreenshotExpect(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isExpectCheck(ch) && Boolean(ch.expect.screenshot));
}

/** True when this criterion has at least one `expect.a11y` check. */
function hasA11yExpect(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isExpectCheck(ch) && Boolean(ch.expect.a11y));
}

/** True when this criterion has at least one `expect.command` check. */
function hasCommandExpect(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isExpectCheck(ch) && Boolean(ch.expect.command));
}

/** True when this criterion has at least one navigate check. */
function hasNavigate(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isNavigateCheck(ch));
}

/** True when this criterion has at least one `press` (keyboard) check. */
function hasPress(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isPressCheck(ch));
}

/** True when this criterion has at least one `hover` check. */
function hasHover(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isHoverCheck(ch));
}

function hasWaitMs(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isWaitCheck(ch) && ch.wait.ms !== undefined);
}

function hasWaitForRequest(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isWaitForRequestCheck(ch));
}

function hasSelect(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => isSelectCheck(ch));
}

/** Scroll forms Maestro cannot emit as real steps (to:top, by-delta, id-intoView). */
function maestroLossyScrolls(c: SpecCriterion): string[] {
  const out: string[] = [];
  for (const ch of c.checks ?? []) {
    if (!isScrollCheck(ch)) continue;
    const body = ch.scroll;
    if (body.to === 'top') out.push('to: top');
    if (body.by) out.push('by');
    if (
      body.intoView &&
      body.selector &&
      !body.selector.name &&
      !body.selector.text &&
      !body.selector.label &&
      !body.selector.placeholder &&
      body.selector.testId
    ) {
      out.push('intoView (testId)');
    }
  }
  return out;
}

/** wait { for } whose selector isn't a Maestro text matcher (id-only). */
function hasMaestroLossyWaitFor(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => {
    if (!isWaitCheck(ch) || !ch.wait.for) return false;
    const sel = ch.wait.for;
    const text = sel.name ?? sel.text ?? sel.label ?? sel.placeholder;
    return !text;
  });
}

/** The distinct navigate-target urls in this criterion. */
function navigateUrls(c: SpecCriterion): string[] {
  const urls: string[] = [];
  for (const ch of c.checks ?? []) {
    if (isNavigateCheck(ch) && !urls.includes(ch.navigate.url)) urls.push(ch.navigate.url);
  }
  return urls;
}

/** Extract the selector from a click/fill/expect.element check, if any. */
function selectorOf(check: Check): {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
} | null {
  if (isClickCheck(check)) return check.click;
  if (isHoverCheck(check)) return check.hover;
  if (isFillCheck(check)) {
    const { value: _v, ...sel } = check.fill;
    return sel;
  }
  if (isWaitCheck(check) && check.wait.for) return check.wait.for;
  if (isSelectCheck(check)) return check.select.selector;
  if (isScrollCheck(check) && check.scroll.selector) return check.scroll.selector;
  if (isPressCheck(check) && typeof check.press !== 'string' && check.press.selector) {
    return check.press.selector;
  }
  if (isExpectCheck(check) && check.expect.element) {
    const { state: _s, count: _c, ...sel } = check.expect.element;
    return sel;
  }
  return null;
}

/**
 * Element expects whose STATE/COUNT Maestro degrades to a bare `assertVisible`
 * + inline TODO. Mirrors `emitElementExpect`'s degradation branches EXACTLY:
 * `count: 0` and `state: 'hidden'` map to a REAL `assertNotVisible` (no
 * warning); `enabled`/`disabled`/`checked` and `count > 0` only get
 * visibility, so the exported flow never proves the actual assertion.
 */
function maestroDegradedElementExpects(c: SpecCriterion): string[] {
  const degraded: string[] = [];
  for (const ch of c.checks ?? []) {
    if (!isExpectCheck(ch) || !ch.expect.element) continue;
    const el = ch.expect.element;
    if (el.count === 0 || el.state === 'hidden') continue; // real assertNotVisible
    if (
      el.state === 'enabled' ||
      el.state === 'disabled' ||
      el.state === 'checked' ||
      el.state === 'focused'
    ) {
      degraded.push(`state: '${el.state}'`);
    }
    if (el.count !== undefined && el.count > 0) {
      degraded.push(`count: ${el.count}`);
    }
  }
  return degraded;
}

/**
 * True when this criterion has at least one role-only selector. Mirrors
 * `maestroSelector`'s null path EXACTLY: a selector with `role` set and none
 * of name/text/label/placeholder/testId — the case Maestro degrades to a TODO.
 */
function hasRoleOnlySelector(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => {
    if (isNavigateCheck(ch)) return false;
    // A hover degrades WHOLESALE to a wont-run TODO in Maestro (no hover verb),
    // so its selector durability is moot — adding a name/testId wouldn't help.
    // Skip it here so the role-only advice isn't misleading (the hover wont-run
    // warning already covers it).
    if (isHoverCheck(ch)) return false;
    // These verbs degrade wholesale to a TODO in Maestro — their selector
    // durability is moot (the wait.for / select / waitForRequest warning
    // already covers them).
    if (isWaitForRequestCheck(ch) || isSelectCheck(ch)) return false;
    if (isWaitCheck(ch) && ch.wait.ms !== undefined) return false;
    const sel = selectorOf(ch);
    if (!sel || !sel.role) return false;
    const hasMatcher = Boolean(sel.name || sel.text || sel.label || sel.placeholder || sel.testId);
    return !hasMatcher;
  });
}

/**
 * True when a criterion has a name-only selector — `name` set with
 * role/testId/label/placeholder/text all absent. Mirrors the Playwright
 * exporter's `usesNameFallback` / locatorExpr last branch EXACTLY: that
 * selector compiles to `getByText(name)`, which matches VISIBLE TEXT rather
 * than the accessible name (an aria-label icon button silently mis-targets).
 */
function hasNameFallbackSelector(c: SpecCriterion): boolean {
  return (c.checks ?? []).some((ch) => {
    if (isNavigateCheck(ch)) return false;
    const sel = selectorOf(ch);
    if (!sel || !sel.name) return false;
    return !sel.role && !sel.testId && !sel.label && !sel.placeholder && !sel.text;
  });
}

/**
 * True when a criterion has an `expect.element` with BOTH `count` and `state`.
 * Mirrors `emitElementExpect`'s count branch EXACTLY: Playwright asserts the
 * count via `toHaveCount` and the state is dropped (flagged inline as a TODO).
 */
function hasCountAndStateElement(c: SpecCriterion): boolean {
  return (c.checks ?? []).some(
    (ch) =>
      isExpectCheck(ch) &&
      ch.expect.element !== undefined &&
      ch.expect.element.count !== undefined &&
      ch.expect.element.state !== undefined,
  );
}

/* ------------------------------------------------------------------ *
 * Playwright warnings.                                                 *
 * ------------------------------------------------------------------ */

export interface CollectPlaywrightWarningsArgs {
  spec: Spec;
  /**
   * True when the exporter actually emitted a fixtures file — i.e. some
   * criterion requires mocks AND the config has mockNetwork handlers. MUST be
   * the same value the exporter computed (passed in, not recomputed) so the
   * warning agrees with the file that was written.
   */
  hasFixtures: boolean;
  /** True when a baseUrl was passed / detected. */
  hasBaseUrl: boolean;
  /**
   * The sandbox `mockNetwork.fallback` the fixtures' catch-all compiled with —
   * MUST be the same value the exporter used. Only `'populate'` warns (the
   * exported catch-all can't reproduce synthetic populated data — it returns
   * `{}`), and only when fixtures were emitted (the catch-all lives in them).
   * `'reject'` (→abort) and `'permissive'` (→`{}`) are faithful and don't warn.
   */
  mockFallback?: MockNetworkConfig['fallback'];
}

/**
 * Lossy cases for the Playwright exporter. Each warning corresponds to a real
 * degradation in the generated test file — never cry wolf.
 */
export function collectPlaywrightWarnings(args: CollectPlaywrightWarningsArgs): ExportWarning[] {
  const warnings: ExportWarning[] = [];
  const { spec, hasFixtures, hasBaseUrl } = args;

  for (const c of spec.criteria) {
    if (c.tier === 'soft') {
      warnings.push({
        scope: `${c.id} (soft)`,
        severity: 'wont-run',
        message:
          `soft criterion exports as \`test.fixme\` — not a real assertion. ` +
          `Score it in Validity, or promote to hard tier with observable checks.`,
      });
    }

    if (c.mocking === 'required' && !hasFixtures) {
      warnings.push({
        scope: `${c.id} (mocking: required)`,
        severity: 'needs-setup',
        message:
          `criterion assumes Validity's mocked network, but no mockNetwork ` +
          `handlers are configured — the exported test hits the real backend ` +
          `and may not match the sandbox. Add handlers in .validity/config.ts ` +
          `or point the test at an env with equivalent test data.`,
      });
    }

    if (hasScreenshotExpect(c)) {
      warnings.push({
        scope: `${c.id} (expect.screenshot)`,
        severity: 'degraded',
        message:
          `expect.screenshot exports as \`expect(page).toHaveScreenshot()\` — ` +
          `Playwright requires a committed baseline. The first run CAPTURES ` +
          `the baseline; subsequent runs diff against it. Commit the ` +
          `generated __screenshots__/ dir or the check fails on a clean checkout.`,
      });
    }

    if (hasPerformanceExpect(c)) {
      warnings.push({
        scope: `${c.id} (expect.performance)`,
        severity: 'wont-run',
        message:
          `expect.performance exports as a TODO comment — the metric is ` +
          `measured in Validity's sandbox (React Profiler + Navigation/Paint ` +
          `Timing) and isn't portable to an exported Playwright test. Verify ` +
          `it in Validity, or approximate via page.evaluate(() => performance...).`,
      });
    }

    if (hasA11yExpect(c)) {
      // The Playwright exporter DOES emit a real AxeBuilder assertion — but it
      // requires `@axe-core/playwright` installed in the target project. Surface
      // as needs-setup so the user installs it before running the exported test.
      warnings.push({
        scope: `${c.id} (expect.a11y)`,
        severity: 'needs-setup',
        message:
          `expect.a11y exports as an AxeBuilder assertion — requires ` +
          `\`@axe-core/playwright\` installed in the project. Run ` +
          `\`npm i -D @axe-core/playwright\` if the exported test fails to import.`,
      });
    }

    if (hasCommandExpect(c)) {
      warnings.push({
        scope: `${c.id} (expect.command)`,
        severity: 'wont-run',
        message:
          `expect.command exports as a TODO comment — the named command runs ` +
          `once per Validity verify on the host, not in the browser. Run the ` +
          `command as its own CI step.`,
      });
    }

    if (hasNameFallbackSelector(c)) {
      warnings.push({
        scope: `${c.id} (accessible-name fallback)`,
        severity: 'degraded',
        message:
          `a name-only selector compiles to \`getByText(name)\` — Playwright ` +
          `matches VISIBLE TEXT, not the accessible name, so an aria-label / icon ` +
          `button can silently mis-target. Add a \`role\` or \`testId\` to the ` +
          `selector to target it durably.`,
      });
    }

    if (hasCountAndStateElement(c)) {
      warnings.push({
        scope: `${c.id} (expect.element count + state)`,
        severity: 'degraded',
        message:
          `an expect.element sets BOTH count and state — the exported test asserts ` +
          `the count (\`toHaveCount\`); the state is dropped (flagged inline as a ` +
          `TODO). Assert the state in a separate check if it also matters.`,
      });
    }
  }

  // Only warn about a missing baseURL when the spec actually navigates — a spec
  // with no navigate check has no relative target, so the warning would be
  // misleading (cry-wolf).
  if (!hasBaseUrl && spec.criteria.some(hasNavigate)) {
    warnings.push({
      scope: 'navigate',
      severity: 'needs-setup',
      message:
        `no baseURL configured — \`navigate()\` targets are relative. Set ` +
        `\`baseURL\` in playwright.config.ts or pass --base-url to the export.`,
    });
  }

  // A 'populate' mock fallback synthesizes populated bodies in the sandbox, but
  // the exported catch-all can only return `{}` — warn so the user wires real
  // handlers. Parity: only when fixtures were emitted (the catch-all lives in
  // them) and exactly for 'populate' (reject→abort, permissive→{} are faithful).
  if (args.hasFixtures && args.mockFallback === 'populate') {
    warnings.push({
      scope: 'mockNetwork.fallback (populate)',
      severity: 'needs-setup',
      message:
        `mockNetwork.fallback is 'populate' — the sandbox synthesizes populated ` +
        `response bodies for unmatched requests, but the exported catch-all can ` +
        `only return an empty {}. Add explicit mockNetwork handlers for the URLs ` +
        `the tests assert, or point the test at an env with equivalent data.`,
    });
  }

  return warnings;
}

/* ------------------------------------------------------------------ *
 * Maestro warnings.                                                    *
 * ------------------------------------------------------------------ */

export interface CollectMaestroWarningsArgs {
  spec: Spec;
  /**
   * True when a real `appId` was supplied to the exporter (config
   * `export.appId`). MUST be the same value the exporter used (passed in, not
   * recomputed) so the warning agrees with the file that was written: without
   * it the flow launches the `com.example.app` placeholder — not runnable
   * against any real app, so the gap must warn (and block certification).
   */
  hasAppId: boolean;
  /**
   * The Maestro export config the exporter compiled with (config
   * `export.maestro`) — MUST be the same value, so the navigate-route warning
   * agrees with the file: a `navigate` check whose url has a `routes` mapping
   * compiled to real steps (no warning); one without degraded to a TODO
   * comment (warn — the flow can't reach the screen in the real app).
   */
  maestro?: MaestroExportConfig;
}

/**
 * Lossy cases for the Maestro exporter. Maestro's assertion vocabulary is
 * smaller than Playwright's — network, console, performance, a11y, and
 * role-only selectors all degrade.
 *
 * Deliberately NOT warned (inline notes only, in the generated flow):
 *   - text matchers (i18n-drift risk) — the step still asserts exactly what
 *     the spec asked (visibility of that name); brittleness is not a semantic
 *     degradation, and warning would block certification for every spec
 *     without testIDs.
 *   - deduped duplicate steps — the surviving step asserts the same thing;
 *     only the (unrepresentable) role distinction was lost, and role loss is
 *     inherent to every Maestro selector, not a per-check degradation.
 */
export function collectMaestroWarnings(args: CollectMaestroWarningsArgs): ExportWarning[] {
  const warnings: ExportWarning[] = [];
  const { spec } = args;

  if (!args.hasAppId) {
    warnings.push({
      scope: 'appId',
      severity: 'needs-setup',
      message:
        `no appId configured — the exported flow launches the placeholder ` +
        `\`com.example.app\`. Set \`export.appId\` in .validity/config.ts to your ` +
        `app's bundle/package identifier.`,
    });
  }

  for (const c of spec.criteria) {
    if (c.tier === 'soft') {
      warnings.push({
        scope: `${c.id} (soft)`,
        severity: 'wont-run',
        message:
          `soft criterion exports as a comment stub — Maestro can't score ` +
          `aesthetics. Review this visually in Validity.`,
      });
    }

    if (hasNetworkExpect(c)) {
      warnings.push({
        scope: `${c.id} (expect.network)`,
        severity: 'wont-run',
        message:
          `Maestro can't observe network traffic — the exported flow has a ` +
          `TODO comment in place of this assertion. Verify it in Validity or ` +
          `the Playwright export.`,
      });
    }

    if (hasConsoleExpect(c)) {
      warnings.push({
        scope: `${c.id} (expect.console)`,
        severity: 'wont-run',
        message:
          `Maestro can't observe the JS console — the exported flow has a ` +
          `TODO comment in place of this assertion. Verify it in Validity or ` +
          `the Playwright export.`,
      });
    }

    if (hasPerformanceExpect(c)) {
      warnings.push({
        scope: `${c.id} (expect.performance)`,
        severity: 'wont-run',
        message:
          `Maestro can't measure performance — the exported flow has a TODO ` +
          `comment in place of this assertion. Verify it in Validity's web ` +
          `sandbox.`,
      });
    }

    if (hasA11yExpect(c)) {
      warnings.push({
        scope: `${c.id} (expect.a11y)`,
        severity: 'wont-run',
        message:
          `Maestro can't assert axe-core a11y violations — the exported flow ` +
          `has a TODO comment in place of this assertion. Verify it in ` +
          `Validity or the Playwright export (axe-core).`,
      });
    }

    if (hasPress(c)) {
      warnings.push({
        scope: `${c.id} (press)`,
        severity: 'wont-run',
        message:
          `Maestro has no hardware-keyboard press — the exported flow has a TODO ` +
          `comment in place of this key press. Assert keyboard reachability in ` +
          `Validity or the Playwright export.`,
      });
    }

    if (hasHover(c)) {
      warnings.push({
        scope: `${c.id} (hover)`,
        severity: 'wont-run',
        message:
          `Maestro has no hover (touch UIs have no hover state) — the exported ` +
          `flow has a TODO comment in place of this hover. Verify hover in ` +
          `Validity or the Playwright export.`,
      });
    }

    if (hasWaitMs(c)) {
      warnings.push({
        scope: `${c.id} (wait.ms)`,
        severity: 'wont-run',
        message:
          `Maestro has no sleep — the exported flow has a TODO comment in place of ` +
          `this timed wait. Verify it in Validity or the Playwright export.`,
      });
    }

    if (hasMaestroLossyWaitFor(c)) {
      warnings.push({
        scope: `${c.id} (wait.for)`,
        severity: 'wont-run',
        message:
          `Maestro extendedWaitUntil needs a text matcher — this wait.for has no ` +
          `name/text/label. Add one, or verify the wait in Validity / Playwright.`,
      });
    }

    if (hasWaitForRequest(c)) {
      warnings.push({
        scope: `${c.id} (waitForRequest)`,
        severity: 'wont-run',
        message:
          `Maestro can't observe network — the exported flow has a TODO comment in ` +
          `place of this waitForRequest. Verify it in Validity or Playwright.`,
      });
    }

    if (hasSelect(c)) {
      warnings.push({
        scope: `${c.id} (select)`,
        severity: 'wont-run',
        message:
          `Maestro has no selectOption (pickers differ per platform) — the exported ` +
          `flow has a TODO comment. Use tapOn + tapOn on the option, or the Playwright export.`,
      });
    }

    for (const what of maestroLossyScrolls(c)) {
      warnings.push({
        scope: `${c.id} (scroll ${what})`,
        severity: 'wont-run',
        message:
          `Maestro can't express this scroll (${what}) — the exported flow has a TODO ` +
          `comment. Verify it in Validity or the Playwright export.`,
      });
    }

    if ((c.checks ?? []).some((ch) => isScrollCheck(ch) && ch.scroll.to === 'bottom')) {
      warnings.push({
        scope: `${c.id} (scroll to: bottom)`,
        severity: 'degraded',
        message:
          `Maestro \`- scroll\` is one page-down, not scroll-to-end — the exported ` +
          `flow does not prove the bottom was reached. Verify it in Validity or Playwright.`,
      });
    }

    if (hasScreenshotExpect(c)) {
      warnings.push({
        scope: `${c.id} (expect.screenshot)`,
        severity: 'degraded',
        message:
          `Maestro's \`takeScreenshot\` captures an image but has no built-in ` +
          `pixel-diff baseline — the assertion is "the screenshot was taken," ` +
          `not "it matches." Verify pixel diffs in Validity or Playwright.`,
      });
    }

    if (hasCommandExpect(c)) {
      warnings.push({
        scope: `${c.id} (expect.command)`,
        severity: 'wont-run',
        message:
          `Maestro can't run repo commands — the exported flow has a TODO ` +
          `comment in place of this assertion. Run the named command as its ` +
          `own CI step.`,
      });
    }

    if (hasRoleOnlySelector(c)) {
      warnings.push({
        scope: `${c.id} (role-only selector)`,
        severity: 'degraded',
        message:
          `Maestro has no role matcher — a role-only selector degrades to a ` +
          `TODO comment. Add a \`name\`/\`testId\` to the selector so Maestro ` +
          `can match by text or accessibility id.`,
      });
    }

    for (const what of maestroDegradedElementExpects(c)) {
      warnings.push({
        scope: `${c.id} (expect.element ${what})`,
        severity: 'degraded',
        message:
          `Maestro can't directly assert ${what} — the exported flow only ` +
          `asserts the element is VISIBLE (the real assertion degrades to an ` +
          `inline TODO). Verify it in Validity or the Playwright export.`,
      });
    }

    if (c.mocking === 'required') {
      warnings.push({
        scope: `${c.id} (mocking: required)`,
        severity: 'needs-setup',
        message:
          `criterion assumes Validity's mocked network. Maestro hits the ` +
          `real app — point it at an env/build with equivalent test data, ` +
          `or the assertions won't mean the same thing they did in the sandbox.`,
      });
    }

    // Navigate checks: parity with `emitCheckLines` in spec-maestro.ts. A url
    // WITH an `export.maestro.routes` mapping compiles to real steps (deep link
    // → openLink, or a tapOn sequence) and warns nothing; a url WITHOUT one
    // degrades to a TODO comment — the exported flow launches the app but never
    // leaves the launch screen, so this criterion's assertions run against the
    // wrong screen. That is a real degradation, so it must warn.
    for (const url of navigateUrls(c)) {
      if (args.maestro?.routes?.[url] !== undefined) continue;
      warnings.push({
        scope: `${c.id} (navigate ${url})`,
        severity: 'needs-setup',
        message:
          `no route mapping for \`navigate(${url})\` — the exported flow stays on ` +
          `the launch screen, so this criterion asserts against the wrong screen. ` +
          `Declare \`export.maestro.routes['${url}']\` in .validity/config.ts ` +
          `(a deep link or a tapOn step array) so the flow can reach the screen ` +
          `in the real app.`,
      });
    }
  }

  return warnings;
}
