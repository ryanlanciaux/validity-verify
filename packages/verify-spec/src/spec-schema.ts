/**
 * Spec schema — the keystone of "spec as a first-class citizen".
 *
 * A Validity *spec* promotes the plan's acceptance criteria from a per-task
 * ephemeral record into a durable, versioned, reviewable, exportable entity.
 * This module owns the SHAPE (zod schemas + inferred TS types); persistence
 * lives in `specs.ts` and lifecycle/verification consume these types.
 *
 * Two ideas carry the whole design:
 *
 *   1. **Tiered criteria.** Each criterion declares a `tier`:
 *        - `hard`     — machine-checkable. Carries a `checks` block of
 *                       structured, compilable actions/assertions. Verified
 *                       DETERMINISTICALLY in the sandbox and exported 1:1 to
 *                       Playwright/Maestro. These are the "proofs".
 *        - `property` — a hard-ish invariant that holds across the conditions
 *                       matrix (e.g. "no console errors on any viewport").
 *                       Same `checks` vocabulary, fanned across conditions.
 *        - `soft`     — LLM-scored from screenshots. No `checks`. Never
 *                       presented as proof.
 *
 *   2. **Small check verb set.** navigate / click / press / hover / fill /
 *      wait / waitForRequest / select / scroll / expect(element | network |
 *      console | screenshot | performance | a11y | command). Enough for ~80%
 *      of ACs and BOTH export targets. We resist a full DSL on purpose (see
 *      the spec doc's "Check schema scope creep" risk).
 *
 * Role/name selectors are the only durable strategy: the agent invents the
 * DOM, so accessibility-based selection (getByRole/byName) is what survives a
 * rebuild. An element with no accessible name is a *finding*, not a checker
 * bug.
 */
import { z } from 'zod';

/** Criterion tiers. See the module header. */
export const criterionTierSchema = z.enum(['hard', 'property', 'soft']);
export type CriterionTier = z.infer<typeof criterionTierSchema>;

/** Spec lifecycle status. Frozen specs are immutable (edits create v+1). */
export const specStatusSchema = z.enum(['draft', 'reviewed', 'approved', 'frozen', 'superseded']);
export type SpecStatus = z.infer<typeof specStatusSchema>;

/**
 * Which runtime a spec verifies against. Drives both the verify branch
 * (Playwright sandbox vs native bridge) and the export target (Playwright vs
 * Maestro) — there is no separate `--target` flag, only an override.
 */
export const specRuntimeSchema = z.enum(['web', 'native']);
export type SpecRuntime = z.infer<typeof specRuntimeSchema>;

/**
 * Whether a criterion's checks assume Validity's mocked network is ACTIVE.
 * `required` → exported tests must install the sandbox fixtures (Playwright
 * `page.route`) for this check to mean the same thing against a real app.
 */
export const mockingModeSchema = z.enum(['required', 'none']);
export type MockingMode = z.infer<typeof mockingModeSchema>;

export const httpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

/**
 * Accessibility-first element selector. At least one field is required.
 * `role` + `name` is the durable pair (maps to Playwright `getByRole(role,
 * { name })` and is the closest Maestro can get). `testId` is the escape
 * hatch when an element genuinely has no accessible name.
 *
 * NAME MATCHING: `name`/`text`/`label`/`placeholder` are case-insensitive
 * SUBSTRING matches by default (an exact label is a substring of itself), so
 * `name: "Toggle Theme"` already matches a dynamic `"Toggle Theme: dark"`
 * label. For an anchored/dynamic match, wrap the value in slashes to make it a
 * regular expression: `name: "/^Toggle Theme/"`. The `/regex/flags` convention
 * is honoured identically by the web (Playwright) and native (agent-device)
 * executors — see `@validity.ai/verify-spec`'s selector-match module.
 *
 * ROLE: `role: "heading"` is a portable class — it resolves a web ARIA heading
 * AND a React Native `accessibilityRole="header"`, and on iOS (where the header
 * trait is dropped from the a11y snapshot) it falls back to a NAMED text node.
 * Pair `role: "heading"` with a `name` so the native fallback can anchor.
 */
export const selectorSchema = z
  .object({
    role: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    placeholder: z.string().min(1).optional(),
    testId: z.string().min(1).optional(),
    /** Disambiguate when a selector matches several elements (0-based). */
    nth: z.number().int().min(0).optional(),
  })
  .refine((s) => Boolean(s.role || s.name || s.text || s.label || s.placeholder || s.testId), {
    message: 'a selector needs at least one of role/name/text/label/placeholder/testId',
  });
export type Selector = z.infer<typeof selectorSchema>;

/** Match an HTTP status: an exact number or a class like `2xx`. */
export const statusMatcherSchema = z.union([
  z.number().int().min(100).max(599),
  z.enum(['1xx', '2xx', '3xx', '4xx', '5xx']),
]);
export type StatusMatcher = z.infer<typeof statusMatcherSchema>;

export const networkExpectSchema = z.object({
  method: httpMethodSchema.optional(),
  /** URL pattern — same dialect as MockNetworkHandler.url (path / prefix / full). */
  url: z.string().min(1),
  /** Expected status. Default `2xx` when omitted. */
  status: statusMatcherSchema.optional(),
});
export type NetworkExpect = z.infer<typeof networkExpectSchema>;

export const elementStateSchema = z.enum([
  'visible',
  'hidden',
  'enabled',
  'disabled',
  'checked',
  // `focused` asserts the resolved element IS document.activeElement (Playwright
  // strict `toBeFocused` semantics) — the mechanical way to prove focus
  // management. WEB-only: the native a11y snapshot doesn't encode focus, so it
  // degrades to `unverifiable` there (never a silent pass).
  'focused',
]);
export type ElementState = z.infer<typeof elementStateSchema>;

export const elementExpectSchema = selectorSchema
  .innerType()
  .extend({
    state: elementStateSchema.optional(),
    /** Exact number of matches expected (e.g. `count: 0` to assert absence). */
    count: z.number().int().min(0).optional(),
  })
  .refine((s) => Boolean(s.role || s.name || s.text || s.label || s.placeholder || s.testId), {
    message: 'an element expect needs at least one selector field',
  });
export type ElementExpect = z.infer<typeof elementExpectSchema>;

export const consoleExpectSchema = z.object({
  /** Maximum number of console.error calls tolerated (usually 0). */
  errors: z.number().int().min(0),
});
export type ConsoleExpect = z.infer<typeof consoleExpectSchema>;

export const screenshotExpectSchema = z.object({
  /** Optional baseline name; defaults to the criterion id. */
  name: z.string().min(1).optional(),
  /** Allowed mismatched pixels before the check fails. Default 0. */
  maxDiffPixels: z.number().int().min(0).optional(),
});
export type ScreenshotExpect = z.infer<typeof screenshotExpectSchema>;

/**
 * Performance metrics a `expect.performance` check can budget. Each maps 1:1
 * to a field on the captured `PerformanceMetrics` (`<metric>Ms`), measured in
 * the web sandbox at verify time:
 *   - `load`               — full navigation→load timing (ms).
 *   - `firstContentfulPaint` — FCP from the Paint Timing API (ms).
 *   - `ready`              — harness-boot→`data-validity-ready` (component
 *                            mounted + first commit settled) (ms). The truest
 *                            "how fast does this screen become usable" number.
 *                            The sandbox's own cold start is SUBTRACTED (it is
 *                            reported separately as `harnessBootMs`), so a
 *                            budget here measures the component and not Vite's
 *                            first-request transform. Budgets written against
 *                            the older navigation-relative numbers are now far
 *                            too loose — retune them.
 *   - `mount`              — React Profiler initial-mount commit cost (ms).
 *   - `update`             — worst React Profiler update (re-render) commit
 *                            cost across the render + any `play` interactions
 *                            (ms). This is "how fast it re-renders when data
 *                            changes".
 * Native + export targets can't observe these → they degrade to `unverifiable`
 * / a TODO comment, never a silent pass.
 */
export const performanceMetricSchema = z.enum([
  'load',
  'firstContentfulPaint',
  'ready',
  'mount',
  'update',
]);
export type PerformanceMetric = z.infer<typeof performanceMetricSchema>;

export const performanceExpectSchema = z.object({
  metric: performanceMetricSchema,
  /** Upper bound in milliseconds. Measured value must be `<= maxMs` to pass. */
  maxMs: z.number().int().positive(),
});
export type PerformanceExpect = z.infer<typeof performanceExpectSchema>;

/**
 * Severity floor for an `expect.a11y` check — mirrors axe-core's impact
 * vocabulary (`minor` | `moderate` | `serious` | `critical`). A violation
 * with impact at or above `severity` counts toward the budget; lower-impact
 * ones are ignored. The default `serious` matches the capture pipeline's
 * default severity floor (see `impactsToKeep` in `packages/verify-web/src/a11y.ts`).
 */
export const a11ySeveritySchema = z.enum(['minor', 'moderate', 'serious', 'critical']);
export type A11ySeverityFloor = z.infer<typeof a11ySeveritySchema>;

/**
 * `expect.a11y` — assert the page has at most `maxViolations` axe-core
 * violations at or above `severity`. The web executor runs `AxeBuilder` and
 * counts (can pass/fail); the native executor reads the a11y snapshot and can
 * only FAIL or be UNVERIFIABLE (the snapshot cannot certify the absence of the
 * full axe rule set — it never falsely passes).
 */
export const a11yExpectSchema = z.object({
  /**
   * Minimum severity to count. `serious` (default) keeps `serious` + `critical`;
   * `critical` keeps only `critical`; `moderate` adds `moderate`; `minor` keeps
   * all four.
   */
  severity: a11ySeveritySchema.optional(),
  /** Max violations at or above `severity` tolerated. Default 0. */
  maxViolations: z.number().int().min(0).optional(),
});
export type A11yExpect = z.infer<typeof a11yExpectSchema>;

/**
 * `expect.command` — run a NAMED command from `.validity/config.ts` `commands`
 * and assert its exit code. Named refs only: the frozen spec hash binds the
 * name + expected exit code, never a shell string. Executed ONCE PER VERIFY
 * RUN (not per render) at the run level; the resolved command string is
 * stamped into the verdict so post-freeze config drift is auditable.
 * Not configured ⇒ `unverifiable` with a finding, never pass.
 */
export const commandExpectSchema = z.object({
  run: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, {
    message:
      "run must be a command NAME from .validity/config.ts `commands` (e.g. 'typecheck') — no shell strings in specs",
  }),
  /** Expected exit code. Default 0. */
  exitCode: z.number().int().min(0).max(255).optional(),
});
export type CommandExpect = z.infer<typeof commandExpectSchema>;

/**
 * `expect: { ... }` — exactly one assertion family per check. Enforced by a
 * refine so an export compiler can switch on a single populated key.
 */
export const expectBodySchema = z
  .object({
    element: elementExpectSchema.optional(),
    network: networkExpectSchema.optional(),
    console: consoleExpectSchema.optional(),
    screenshot: screenshotExpectSchema.optional(),
    performance: performanceExpectSchema.optional(),
    a11y: a11yExpectSchema.optional(),
    command: commandExpectSchema.optional(),
  })
  .refine(
    (e) =>
      [e.element, e.network, e.console, e.screenshot, e.performance, e.a11y, e.command].filter(
        (v) => v !== undefined,
      ).length === 1,
    {
      message:
        'an expect must assert exactly one of element/network/console/screenshot/performance/a11y/command',
    },
  );
export type ExpectBody = z.infer<typeof expectBodySchema>;

export const navigateCheckSchema = z.object({
  navigate: z.object({
    /** Path or URL. For isolation renders this is usually a hash/route. */
    url: z.string().min(1),
  }),
});
export const clickCheckSchema = z.object({ click: selectorSchema });
export const hoverCheckSchema = z.object({ hover: selectorSchema });

/**
 * Per-check action/assertion budget in milliseconds. Shared by the schema
 * (`wait.ms` / `waitForRequest.timeoutMs` ceiling) and both executors. A wait
 * longer than this is rejected at parse time so a runaway wait can't stall a
 * verify. Alias `CHECK_TIMEOUT` is the brief/docs name for the same number.
 */
export const CHECK_TIMEOUT_MS = 5_000;
export const CHECK_TIMEOUT = CHECK_TIMEOUT_MS;

/**
 * A keyboard press. Page-level (the active element) by default —
 * `{ press: 'Tab' }` or `{ press: { key: 'Shift+Tab', times: 3 } }`. An
 * optional `selector` scopes the press to a located element (`locator.press`
 * after focusing it); page-level behavior is unchanged when it's absent.
 * `key` is Playwright `page.keyboard.press()` syntax ('Tab', 'Enter',
 * 'Shift+Tab', 'ArrowDown', …). `times` (1..25) repeats the press; default 1,
 * bounded so a runaway repeat can't stall a verify. A press is an ACTION: like
 * a click, a failure cascades (downstream expects become `unverifiable`, not
 * `fail`). WEB-only: native has no hardware-keyboard channel → `unverifiable`.
 */
export const pressBodySchema = z.union([
  z.string().min(1),
  z.object({
    key: z.string().min(1),
    times: z.number().int().min(1).max(25).optional(),
    selector: selectorSchema.optional(),
  }),
]);
export type PressBody = z.infer<typeof pressBodySchema>;
export const pressCheckSchema = z.object({ press: pressBodySchema });

/**
 * Normalize a `press` body into `{ key, times, selector? }` (default times 1).
 * The single reader for BOTH the sandbox executor's press loop and the
 * Playwright exporter's emitted loop, so the two can never disagree on the
 * repeat count or the scoped-vs-page target.
 */
export function pressKeyAndTimes(p: PressBody): {
  key: string;
  times: number;
  selector?: Selector;
} {
  if (typeof p === 'string') return { key: p, times: 1 };
  const out: { key: string; times: number; selector?: Selector } = {
    key: p.key,
    times: p.times ?? 1,
  };
  if (p.selector) out.selector = p.selector;
  return out;
}

/** Wait-for element state. Subset of Playwright `locator.waitFor` states. */
export const waitForStateSchema = z.enum(['visible', 'hidden', 'attached']);
export type WaitForState = z.infer<typeof waitForStateSchema>;

/**
 * Pause the check sequence. Exactly one of:
 *   - `{ wait: { ms } }` — sleep, bounded by `CHECK_TIMEOUT_MS` at schema
 *     level (a wait longer than the per-check budget is rejected, not run).
 *   - `{ wait: { for: Selector, state? } }` — Playwright `locator.waitFor`
 *     (`visible` default). Native implements `ms` as sleep and `for` via the
 *     a11y snapshot / `waitForRef`; never a silent pass.
 *     Timeout is `fail` for `{ text }` selectors: the matcher IS the visible
 *     copy, so "that string never appeared" is an assertion miss, not a
 *     selector-durability finding (those use role/name/testId).
 */
export const waitBodySchema = z
  .object({
    ms: z.number().int().positive().max(CHECK_TIMEOUT_MS).optional(),
    for: selectorSchema.optional(),
    state: waitForStateSchema.optional(),
  })
  .refine((w) => (w.ms !== undefined) !== (w.for !== undefined), {
    message: 'wait must specify exactly one of `ms` or `for`',
  })
  .refine((w) => w.state === undefined || w.for !== undefined, {
    message: 'wait.state requires wait.for',
  });
export type WaitBody = z.infer<typeof waitBodySchema>;
export const waitCheckSchema = z.object({ wait: waitBodySchema });

/**
 * Resolve when the in-page request log (isolation-mode MSW mirror, same
 * source `expect.network` reads) shows a matching request. `url` is a path /
 * prefix / full URL, or a `/regex/flags` literal. `timeoutMs` defaults to
 * `CHECK_TIMEOUT_MS` and is capped at it. Timeout with no match is `fail`,
 * never a silent pass.
 */
export const waitForRequestBodySchema = z.object({
  url: z.string().min(1),
  method: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(CHECK_TIMEOUT_MS).optional(),
});
export type WaitForRequestBody = z.infer<typeof waitForRequestBodySchema>;
export const waitForRequestCheckSchema = z.object({ waitForRequest: waitForRequestBodySchema });

/** Native `<select>` option: a visible label string, or `{ label | value | index }`. */
export const selectOptionSchema = z.union([
  z.string().min(1),
  z
    .object({
      label: z.string().min(1).optional(),
      value: z.string().min(1).optional(),
      index: z.number().int().min(0).optional(),
    })
    .refine((o) => o.label !== undefined || o.value !== undefined || o.index !== undefined, {
      message: 'select option needs label, value, or index',
    }),
]);
export type SelectOption = z.infer<typeof selectOptionSchema>;

/**
 * `{ select: { selector, option } }` → Playwright `locator.selectOption`.
 * If the target is not a native `<select>`, the executor FAILS with
 * "not a native select — use click + click on the option" (never guesses a
 * custom listbox). Native pickers differ per platform → `unverifiable`.
 */
export const selectBodySchema = z.object({
  selector: selectorSchema,
  option: selectOptionSchema,
});
export type SelectBody = z.infer<typeof selectBodySchema>;
export const selectCheckSchema = z.object({ select: selectBodySchema });

/**
 * Scroll the page or a located element. At least one of `to` / `by` /
 * `intoView` is required; `intoView: true` also requires `selector`.
 */
export const scrollBodySchema = z
  .object({
    selector: selectorSchema.optional(),
    to: z.enum(['top', 'bottom']).optional(),
    by: z
      .object({
        x: z.number().optional(),
        y: z.number().optional(),
      })
      .optional(),
    intoView: z.literal(true).optional(),
  })
  .refine((s) => s.to !== undefined || s.by !== undefined || s.intoView === true, {
    message: 'scroll needs `to`, `by`, or `intoView`',
  })
  .refine((s) => s.intoView !== true || s.selector !== undefined, {
    message: 'scroll.intoView requires a selector',
  });
export type ScrollBody = z.infer<typeof scrollBodySchema>;
export const scrollCheckSchema = z.object({ scroll: scrollBodySchema });

export const fillCheckSchema = z.object({
  fill: selectorSchema
    .innerType()
    .extend({ value: z.string() })
    .refine((s) => Boolean(s.role || s.name || s.text || s.label || s.placeholder || s.testId), {
      message: 'a fill needs at least one selector field',
    }),
});
export const expectCheckSchema = z.object({ expect: expectBodySchema });

/**
 * One step in a hard-tier criterion's `checks` block. Each check is a
 * single-key object so the YAML reads as an action list:
 *
 *   - fill:   { role: textbox, name: Email, value: a@b.com }
 *   - click:  { role: button, name: Send }
 *   - press:  Tab
 *   - hover:  { role: button, name: Save }
 *   - wait:   { ms: 200 } | { for: { text: "Saved" }, state: visible }
 *   - select: { selector: { label: Country }, option: "US" }
 *   - scroll: { to: bottom }
 *   - expect: { element: { role: button, name: Save, state: focused } }
 *   - expect: { network: { method: POST, url: /api/contact, status: 2xx } }
 *   - expect: { console: { errors: 0 } }
 */
export const checkSchema = z.union([
  navigateCheckSchema,
  clickCheckSchema,
  pressCheckSchema,
  hoverCheckSchema,
  fillCheckSchema,
  waitCheckSchema,
  waitForRequestCheckSchema,
  selectCheckSchema,
  scrollCheckSchema,
  expectCheckSchema,
]);
export type Check = z.infer<typeof checkSchema>;

/** Narrowing helpers — the union is by single key, so this is just presence. */
export function isNavigateCheck(c: Check): c is z.infer<typeof navigateCheckSchema> {
  return 'navigate' in c;
}
export function isClickCheck(c: Check): c is z.infer<typeof clickCheckSchema> {
  return 'click' in c;
}
export function isPressCheck(c: Check): c is z.infer<typeof pressCheckSchema> {
  return 'press' in c;
}
export function isHoverCheck(c: Check): c is z.infer<typeof hoverCheckSchema> {
  return 'hover' in c;
}
export function isFillCheck(c: Check): c is z.infer<typeof fillCheckSchema> {
  return 'fill' in c;
}
export function isWaitCheck(c: Check): c is z.infer<typeof waitCheckSchema> {
  return 'wait' in c;
}
export function isWaitForRequestCheck(c: Check): c is z.infer<typeof waitForRequestCheckSchema> {
  return 'waitForRequest' in c;
}
export function isSelectCheck(c: Check): c is z.infer<typeof selectCheckSchema> {
  return 'select' in c;
}
export function isScrollCheck(c: Check): c is z.infer<typeof scrollCheckSchema> {
  return 'scroll' in c;
}
export function isExpectCheck(c: Check): c is z.infer<typeof expectCheckSchema> {
  return 'expect' in c;
}

/** True when a check is an `expect: { command: … }` check. */
export function isCommandExpectCheck(c: Check): boolean {
  return isExpectCheck(c) && c.expect.command !== undefined;
}
/** True when any of a criterion's checks is a command check. */
export function criterionUsesCommandChecks(c: Pick<SpecCriterion, 'checks'>): boolean {
  return (c.checks ?? []).some(isCommandExpectCheck);
}

/**
 * The data-population axis (A2). A forced `dataState` renders a target in a
 * specific data condition — `loading` (in-flight), `empty` (no rows), `error`
 * (fetch failed), or `populated` (real-looking content) — so a criterion like
 * "shows a spinner while loading" is verifiable. Absent ⇒ the render uses the
 * config's fallback behavior unchanged.
 */
export const dataStateSchema = z.enum(['loading', 'empty', 'error', 'populated']);
export type DataState = z.infer<typeof dataStateSchema>;
export const DATA_STATES = dataStateSchema.options;

export const specCriterionSchema = z
  .object({
    /** Stable id, e.g. 'AC-1'. */
    id: z.string().min(1),
    /** Human-readable statement of the criterion. */
    text: z.string().min(1),
    tier: criterionTierSchema,
    /** Structured, compilable checks. Required (non-empty) for hard tier. */
    checks: z.array(checkSchema).optional(),
    /** Carries the ACTIVE/DISABLED mocking assumption. Default 'none'. */
    mocking: mockingModeSchema.optional(),
    /** Sign-off weight. Absent ⇒ treated as 'blocking'. 'advisory' criteria may fail without blocking sign-off. */
    severity: z.enum(['blocking', 'advisory']).optional(),
    /** Soft-tier only: minimum normalized score [0,1] a numeric soft score must reach to count as pass. */
    softThreshold: z.number().min(0).max(1).optional(),
    /** Data-population condition this criterion is scored under (A2). */
    dataState: dataStateSchema.optional(),
  })
  .refine((c) => c.tier !== 'hard' || (c.checks && c.checks.length > 0), {
    message: 'hard-tier criteria require a non-empty `checks` block',
  })
  .refine(
    (c) => {
      const checks = c.checks ?? [];
      const cmd = checks.filter(isCommandExpectCheck).length;
      return cmd === 0 || cmd === checks.length;
    },
    {
      message:
        'expect.command checks run once per verify run, outside any render — a criterion may not mix command checks with page checks; split into two criteria',
    },
  );
export type SpecCriterion = z.infer<typeof specCriterionSchema>;

/**
 * Sign-off weight test. A criterion is BLOCKING unless it explicitly opts out
 * with `severity: 'advisory'`. Absent severity ⇒ blocking (the safe default:
 * an un-annotated criterion gates sign-off). This is the one place the
 * blocking/advisory rule is expressed so the stop rule and any consumer agree.
 */
export function criterionIsBlocking(c: { severity?: 'blocking' | 'advisory' }): boolean {
  return c.severity !== 'advisory';
}

export const specSourceSchema = z.object({
  /** Original user/agent request, verbatim. */
  prompt: z.string(),
  createdBy: z.enum(['agent', 'user']),
  /** Multi-agent review trail — ids/names of agents that reviewed. */
  reviewedBy: z.array(z.string()).optional(),
  /**
   * Version of the NL→checks compiler that produced this spec's hard checks
   * (see `CHECK_COMPILER_VERSION`). Part of the hashed content, so a spec
   * compiled under one contract version can never be silently re-judged under
   * another — the hash changes with the bar. Absent on hand-authored specs.
   */
  compiledWith: z.string().optional(),
});
export type SpecSource = z.infer<typeof specSourceSchema>;

export const specTargetsSchema = z.object({
  /** Resolved component names (via catalog/resolve) — enables change-mapping. */
  components: z.array(z.string()).optional(),
  /** View/screen ids this spec exercises. */
  views: z.array(z.string()).optional(),
});
export type SpecTargets = z.infer<typeof specTargetsSchema>;

export const specConditionsSchema = z.object({
  /** Viewport widths to fan property/hard checks across. */
  viewports: z.array(z.number().int().positive()).optional(),
  /** Network condition labels (normal / slow-3g / api-500). */
  network: z.array(z.string()).optional(),
  /** Data-population states to fan property/hard checks across (A2). */
  dataStates: z.array(dataStateSchema).optional(),
});
export type SpecConditions = z.infer<typeof specConditionsSchema>;

/**
 * Git binding captured when a spec is frozen (B2). Records the working tree
 * state at freeze time so a reader can classify the spec's temporal relationship
 * to the work (was it frozen before the change, or mid-change?). Best-effort and
 * EXCLUDED from `computeSpecHash` (like `updatedAt`) so it never perturbs a
 * frozen content hash. Absent on hand-authored specs / non-git projects.
 */
export const specGitBindingSchema = z.object({
  /** HEAD sha at freeze time. */
  sha: z.string(),
  /** Whether the working tree was dirty at freeze time. */
  dirty: z.boolean(),
  /** Files changed vs HEAD at freeze time (project-relative). */
  changedFiles: z.array(z.string()),
  /** True when `changedFiles` was truncated (large diffs). */
  changedFilesTruncated: z.boolean().optional(),
});
export type SpecGitBinding = z.infer<typeof specGitBindingSchema>;

/**
 * Probation marker for bulk-created specs (Phase C onboarding).
 *
 * Set on specs minted by the bulk onboarding pass; EXCLUDED from
 * `computeSpecHash` (like `git`/`updatedAt`) so clearing it never perturbs a
 * frozen content hash. While present, the spec CANNOT generate high-severity
 * signals — a watch-tick failure surfaces as `needs-review` (severity low),
 * never `regression`-high, so a wrong bulk spec can't poison the inbox before a
 * human confirms it. Cleared after the spec's first confirmed clean pass (see
 * `clearSpecProbation` in specs.ts).
 */
export const specProbationSchema = z.object({
  /** ISO timestamp the probation was stamped (bulk-create time). */
  since: z.string(),
  /** Bulk-batch id the spec was minted under (advisory; groups the review pass). */
  batchId: z.string().optional(),
});
export type SpecProbation = z.infer<typeof specProbationSchema>;

/**
 * Rubric baseline stamped when a spec is FROZEN (E2.2). Records which version
 * of the soft-scoring rubric the spec's soft criteria were written against, so
 * verify can say "this spec was baselined under an older rubric; its soft
 * scores may not be comparable to today's".
 *
 * EXCLUDED from `computeSpecHash` (like `git`/`probation`): the rubric governs
 * how a judge is INSTRUCTED, not what the spec asks for. Hashing it would make
 * a rubric bump silently unbind every frozen spec's prior reports and
 * approvals — a much louder event than the advisory warning this is for.
 */
export const specRubricStampSchema = z.object({
  /** `RUBRIC_VERSION` at freeze time. */
  version: z.string(),
});
export type SpecRubricStamp = z.infer<typeof specRubricStampSchema>;

/**
 * The full spec entity, as persisted to `.validity/specs/<id>/spec.yaml`.
 */
export const specSchema = z.object({
  // `spec-` prefix + word chars only: a spec id is a directory name under
  // `.validity/specs/` and feeds export paths, so it must never carry a path
  // separator or `.` (defense against path traversal on export/write).
  id: z.string().regex(/^spec-[A-Za-z0-9_-]+$/, {
    message: 'spec id must match /^spec-[A-Za-z0-9_-]+$/ (no path separators or dots)',
  }),
  version: z.number().int().min(1),
  status: specStatusSchema,
  source: specSourceSchema,
  runtime: specRuntimeSchema,
  targets: specTargetsSchema.optional(),
  criteria: z.array(specCriterionSchema).min(1),
  conditions: specConditionsSchema.optional(),
  /** sha256 of the frozen content. Present once status reaches `frozen`. */
  hash: z.string().optional(),
  /** Lineage pointer, e.g. `spec-7f3a@v2`. Set when a frozen spec is edited. */
  supersedes: z.string().optional(),
  /** Working-tree state at freeze time (B2). Excluded from `computeSpecHash`. */
  git: specGitBindingSchema.optional(),
  /**
   * Bulk-onboarding probation marker (Phase C). Set on bulk-created specs;
   * EXCLUDED from `computeSpecHash` (like `git`); while present the spec cannot
   * generate high-severity signals (failures surface as `needs-review` low);
   * cleared after the spec's first confirmed clean pass.
   */
  probation: specProbationSchema.optional(),
  /**
   * Soft-scoring rubric this spec was baselined under, stamped at freeze (E2.2).
   * EXCLUDED from `computeSpecHash`. Absent ⇒ frozen before the stamp existed,
   * which is UNKNOWN rather than drift — no warning fires for it, and the next
   * freeze stamps it. See `specRubricVersion`.
   */
  rubric: specRubricStampSchema.optional(),
  /** ISO creation timestamp. */
  createdAt: z.string(),
  /** ISO timestamp of the last mutation. */
  updatedAt: z.string().optional(),
});
export type Spec = z.infer<typeof specSchema>;

/**
 * Evidence taints (A3) — provenance flags on a verdict recording that the
 * evidence behind it was fabricated or degraded in some way. They ride along
 * every status-writing surface so a reader (and the lattice) can tell an honest
 * pass from one propped up by synthetic data or a stubbed wrapper.
 *
 *   - `network`            — an `expect.network` assertion was satisfied by a
 *                            fabricated (permissive/unmatched) response.
 *   - `wrapper`            — the render ran under a degraded wrapper clone.
 *   - `synthetic-data`     — the render's data came from the permissive proxy /
 *                            auto-populate fallback (PROVENANCE ONLY — never demoting).
 *   - `unconfirmed-render` — a native render was never confirmed; the screenshot
 *                            is not evidence.
 *   - `dep-scan`           — the sandbox's dependency pre-scan aborted (a stray
 *                            unresolvable import), so deps were discovered
 *                            lazily and any render may have raced a re-optimize
 *                            reload that swapped the React instance. Evidence
 *                            from the session is unconfirmed wholesale.
 *   - `data-state`         — the criterion is conditioned on a non-`populated`
 *                            `dataState` (A2) whose render never happened: the
 *                            clone was dropped by the render budget, the axis
 *                            was off, the forced render errored, or the runtime
 *                            (native) can't force data states at all. The
 *                            loading/empty/error branch the criterion is ABOUT
 *                            was never on screen, so nothing here can be proof.
 */
export const evidenceTaintSchema = z.enum([
  'network',
  'wrapper',
  'synthetic-data',
  'unconfirmed-render',
  'dep-scan',
  'data-state',
]);
export type EvidenceTaint = z.infer<typeof evidenceTaintSchema>;

/**
 * Taints that force non-pass. `synthetic-data` is deliberately absent — it is
 * PROVENANCE-ONLY (A3 §4.3 decision): a render fed by synthetic data can still
 * mechanically pass its checks, so it must not be clamped to `unverifiable`.
 */
export const DEMOTING_EVIDENCE_TAINTS: ReadonlySet<EvidenceTaint> = new Set([
  'network',
  'wrapper',
  'unconfirmed-render',
  'dep-scan',
  'data-state',
]);

/**
 * THE single reader: unions a verdict's `evidenceTaints` with the legacy
 * `networkTainted` boolean (→ `'network'`), deduped. Every surface that inspects
 * taints must go through this so the old boolean and the new list can never
 * disagree.
 */
export function evidenceTaintsOf(v: {
  networkTainted?: boolean;
  evidenceTaints?: EvidenceTaint[];
}): EvidenceTaint[] {
  const out: EvidenceTaint[] = [];
  for (const t of v.evidenceTaints ?? []) {
    if (!out.includes(t)) out.push(t);
  }
  if (v.networkTainted && !out.includes('network')) out.push('network');
  return out;
}

/**
 * The DEMOTING subset of a verdict's taints. Non-empty ⇒ the verdict may never
 * read `pass`. Keyed on the demoting set (not list emptiness) so a
 * `synthetic-data`-only verdict is not demoted.
 */
export function demotingTaintsOf(v: {
  networkTainted?: boolean;
  evidenceTaints?: EvidenceTaint[];
}): EvidenceTaint[] {
  return evidenceTaintsOf(v).filter((t) => DEMOTING_EVIDENCE_TAINTS.has(t));
}

/**
 * The ONE lattice rule: `fail` stays `fail`; a `pass` carrying any DEMOTING
 * taint becomes `unverifiable`; everything else is unchanged. This is the single
 * clamp — every status-writing surface (submit_report soft-override,
 * applySoftScores, refolds, headline downgrade) routes through here so a
 * tainted verdict can never launder up to `pass`.
 */
export function applyEvidenceTaints(
  status: 'pass' | 'fail' | 'unverifiable',
  taints: EvidenceTaint[],
): 'pass' | 'fail' | 'unverifiable' {
  if (status === 'fail') return 'fail';
  if (status === 'pass' && taints.some((t) => DEMOTING_EVIDENCE_TAINTS.has(t))) {
    return 'unverifiable';
  }
  return status;
}

/** Append-dedupe helper. Taints can only be added, never removed. */
export function withEvidenceTaint(
  existing: EvidenceTaint[] | undefined,
  t: EvidenceTaint,
): EvidenceTaint[] {
  const out = existing ? [...existing] : [];
  if (!out.includes(t)) out.push(t);
  return out;
}

/**
 * Scorer provenance (A3) — who scored a soft criterion. Stamped by
 * `submit_report`. `model` is the host-reported agent id (optional); `session`
 * is the MCP-server session fingerprint (always present when stamped).
 */
export interface ScorerProvenance {
  /** Model/agent id self-reported by the host. Optional. */
  model?: string;
  /** MCP-server session fingerprint (always present when stamped). */
  session: string;
  /**
   * Soft-scoring rubric version this judgment was produced under (E2.2). ADD-ONLY.
   * See `RUBRIC_VERSION` in judge-gate.ts. Absent only on verdicts scored before
   * the stamp existed.
   */
  rubricVersion?: string;
  /**
   * True when `rubricVersion` was ASSUMED (the submitter didn't declare one, so
   * the server stamped its own current rubric) rather than reported by the
   * scorer. A scorer running an older skill copy would still be stamped with
   * the server's version — this flag says "not attested", so an audit can tell
   * a claim from an inference.
   */
  rubricVersionAssumed?: boolean;
}

/** Provenance of the response an `expect.network` assertion consumed (A4). */
export type NetworkEvidenceProvenance = 'declared' | 'fabricated' | 'live';

/**
 * What served the response behind an `expect.network` check (A4). `declared` =
 * a configured handler matched (its pattern is on `handlerUrl`); `fabricated` =
 * the permissive proxy / unmatched fallback answered; `live` = a real backend.
 */
export interface NetworkEvidence {
  provenance: NetworkEvidenceProvenance;
  method: string;
  url: string;
  status: number;
  /** Config handler pattern that served it. Present iff provenance === 'declared'. */
  handlerUrl?: string;
}

/**
 * Pure: a handler URL pattern with no endpoint-specific content — `'*'`, `'/*'`,
 * `'**'`, `'http://*'`, … all reduce to pure wildcards once the scheme/host is
 * stripped. Shared by the web AND native executors — do not duplicate.
 */
export function isCatchAllPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return false;
  // Drop a leading scheme (http://, https://, …); a catch-all is nothing but
  // wildcards and separators once the scheme is gone.
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return withoutScheme.replace(/[*/]/g, '').length === 0;
}

/**
 * Outcome of executing a SINGLE hard/property check deterministically in the
 * sandbox (or native bridge). `unverifiable` is reserved for the
 * selector-durability finding: e.g. "the submit button has no accessible
 * name", which the spec doc explicitly calls a feature, not a checker bug.
 */
export interface CheckVerdict {
  /** The check that ran, echoed for the report. */
  check: Check;
  status: 'pass' | 'fail' | 'unverifiable';
  /** Human-readable detail — what matched, what was expected, what was seen. */
  detail?: string;
  /** Provenance of the response an `expect.network` check consumed (A4). */
  networkEvidence?: NetworkEvidence;
  /**
   * `expect.command` execution evidence (A5). `resolved` is the EXACT shell
   * string that ran (resolved from the named command at run time), so
   * post-freeze config drift is auditable.
   */
  command?: { resolved: string; exitCode: number | null; durationMs: number; timedOut: boolean };
}

/**
 * Aggregated verdict for one criterion. Hard/property criteria carry the
 * per-check breakdown and a MECHANICAL status (all checks pass → pass; any
 * fail → fail; any unverifiable and none fail → unverifiable). Soft criteria
 * carry no checks — they're scored by the host LLM and their status is filled
 * in later from the agent's `submit_report`.
 */
export interface CriterionVerdict {
  id: string;
  tier: CriterionTier;
  status: 'pass' | 'fail' | 'unverifiable';
  detail?: string;
  /** Per-check breakdown for hard/property tiers. Absent for soft. */
  checks?: CheckVerdict[];
  /**
   * Set when this verdict was DEMOTED to `unverifiable` because an
   * `expect.network` assertion consumed FABRICATED evidence (a permissive-proxy
   * body or an unmatched-URL fallback). It is a STICKY flag: any later
   * re-folding of `checks` (e.g. the post-screenshot baseline upgrade in
   * capture.ts) must keep the criterion `unverifiable` while this is true,
   * otherwise a passing screenshot check could silently flip a network-tainted
   * criterion back to `pass` and the over-claim would resurface. Absent on
   * untainted verdicts.
   */
  networkTainted?: boolean;
  /**
   * For SOFT criteria only: the screenshot ids the host agent cited as the
   * source of its verdict. Required by the soft-scoring quality floor —
   * `submit_report` rejects a soft submission without valid citations.
   * Absent on hard/property verdicts (those are mechanically proven, not
   * scored from a screenshot). Persisted so the HTML report can show
   * "scored from: <id>" and a reader can audit the trail.
   */
  screenshotCitations?: string[];
  /**
   * Evidence taints on this verdict (A3). Provenance flags that the evidence was
   * fabricated or degraded — see `evidenceTaintSchema`. `networkTainted` above is
   * kept and dual-written (→ `'network'`); read both through `evidenceTaintsOf`.
   */
  evidenceTaints?: EvidenceTaint[];
  /** SOFT only: who scored this criterion (A3). Stamped by submit_report. */
  scoredBy?: ScorerProvenance;
  /**
   * SOFT only: true when this verdict's pass was scored self / unproven-judge
   * (A6, mirrors `RunMeta.scoring.selfScored` at the moment this criterion was
   * scored). Stamped by submit_report alongside `scoredBy`; feeds
   * `computeSignedOff` ONLY when `requireFreshJudge` is on.
   */
  selfScored?: boolean;
  /** Rollup of the network provenance across this criterion's checks (A4). */
  networkProvenance?: 'declared' | 'fabricated' | 'live' | 'mixed';
}

/**
 * Fold a list of check verdicts into a single mechanical criterion status.
 * Exported so the sandbox executor and any native executor agree on the rule.
 */
export function foldCheckVerdicts(verdicts: CheckVerdict[]): 'pass' | 'fail' | 'unverifiable' {
  if (verdicts.length === 0) return 'unverifiable';
  if (verdicts.some((v) => v.status === 'fail')) return 'fail';
  if (verdicts.some((v) => v.status === 'unverifiable')) return 'unverifiable';
  return 'pass';
}

/**
 * Roll a criterion's per-check network evidence up into one
 * `CriterionVerdict.networkProvenance` label (A4). Downward-safe: any
 * fabricated evidence wins outright; a positive claim (`declared` / `live` /
 * `mixed`) requires EVERY entry to carry evidence — a missing entry (old run
 * data, the no-evidence fallback path) yields `undefined`, never a claim.
 * Shared by the web AND native executors — do not duplicate.
 */
export function rollupNetworkProvenance(
  evidences: ReadonlyArray<NetworkEvidence | undefined>,
): 'declared' | 'fabricated' | 'live' | 'mixed' | undefined {
  if (evidences.length === 0) return undefined;
  if (evidences.some((e) => e?.provenance === 'fabricated')) return 'fabricated';
  if (evidences.some((e) => e === undefined)) return undefined;
  if (evidences.every((e) => e?.provenance === 'declared')) return 'declared';
  if (evidences.every((e) => e?.provenance === 'live')) return 'live';
  return 'mixed';
}

/** Validation error with an actionable message (mirrors PlanValidationError). */
export class SpecValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecValidationError';
  }
}

/**
 * Parse + validate an untrusted object into a Spec, raising a
 * `SpecValidationError` with a flattened, agent-actionable message on the
 * first failure.
 */
export function parseSpec(input: unknown): Spec {
  const result = specSchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path?.join('.') ?? '(root)';
    throw new SpecValidationError(`${path}: ${first?.message ?? 'invalid spec'}`);
  }
  return result.data;
}
