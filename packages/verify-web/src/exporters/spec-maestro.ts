/**
 * Spec-driven Maestro compiler (Phase 5).
 *
 * Compiles a frozen native `Spec` into a Maestro YAML flow. Maestro's
 * assertion vocabulary is smaller than Playwright's: it can tap, type, and
 * assert visibility, but it CANNOT observe network traffic or the JS console.
 * So the mapping is intentionally lossy and we say so loudly:
 *
 *   navigate           → real steps when `export.maestro.routes[url]` maps the
 *                        target (deep link → `openLink`, or a tapOn sequence);
 *                        otherwise a `# TODO` comment + a needs-setup warning.
 *   click  {role,name} → `- tapOn: { text: <name|text> }`  (or id: <testId>)
 *   fill   {…, value}  → `- tapOn` the field then `- inputText: <value>`
 *   expect element     → `- assertVisible` / `- assertNotVisible` (hidden/count:0)
 *   expect network     → `# TODO (lossy): Maestro can't assert network …`
 *   expect console     → `# TODO (lossy): Maestro can't assert the JS console …`
 *   expect screenshot  → `- takeScreenshot: <name>`  (no built-in pixel diff)
 *   soft criteria      → comment stubs (LLM-scored; not mechanically checkable)
 *
 * Isolation → E2E bridging: Validity verifies components in ISOLATION, but
 * Maestro runs the whole installed app. The generated flow therefore opens
 * with a launch preamble — `launchApp` with `clearState` plus best-effort
 * dismissal of dev-build overlays (Android ANR dialog, expo-dev-client
 * onboarding/menu) — so a first run against a real device isn't blocked by
 * shell chrome the isolated render never sees. Both knobs live in
 * `.validity/config.ts` under `export.maestro` and are inputs-hashed.
 *
 * Checks within a criterion that compile to byte-identical Maestro steps
 * (e.g. `role: header` + `role: button` with the same name — Maestro has no
 * role matcher) are deduped to a single step + an explanatory comment.
 *
 * Pure string generation — the caller writes the returned file(s).
 */
import type {
  Check,
  ElementExpect,
  ExpectBody,
  MaestroExportConfig,
  MaestroRouteStep,
  Selector,
  Spec,
  SpecCriterion,
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
  pressKeyAndTimes,
} from '@validity.ai/verify-spec';
import { collectMaestroWarnings, type ExportWarning } from './spec-export-warnings.js';
import { lintMaestroSubset } from './maestro-subset.js';

export interface ExportSpecMaestroArgs {
  spec: Spec;
  /**
   * Bundle/package identifier stamped into the flow's `appId:` line (from
   * `.validity/config.ts` `export.appId`). Absent ⇒ a placeholder + TODO is
   * emitted AND a `needs-setup` warning fires — a flow that can't launch the
   * real app is not runnable anywhere, so the gap must never be silent.
   */
  appId?: string;
  /**
   * Maestro exporter knobs (`export.maestro` in .validity/config.ts): launch
   * preamble behavior + navigate-route mappings. Changes exported bytes, so
   * the caller folds it into the manifest's inputsHash.
   */
  maestro?: MaestroExportConfig;
}

export interface ExportedFile {
  /** RELATIVE path; the caller joins it with the chosen outDir. */
  path: string;
  contents: string;
}

export interface ExportSpecMaestroResult {
  files: ExportedFile[];
  /** Lossy-mapping warnings — surface at the CLI, not just inline in the file. */
  warnings: ExportWarning[];
}

/** Collapse whitespace + clip — keeps generated comments single-line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * Pick the best Maestro selector for an element. Maestro matches by visible
 * `text` or by accessibility `id`. role has no Maestro analog, so role+name
 * collapses to the name (the visible label). testId → id.
 *
 * Returns `null` when nothing maps to a real Maestro matcher — e.g. a role-only
 * selector. Emitting `text: ""` there would silently match everything/nothing,
 * so callers degrade to a visible TODO comment instead (see FIX 10).
 */
function maestroSelector(sel: Selector): { key: 'text' | 'id'; value: string } | null {
  if (sel.testId) return { key: 'id', value: sel.testId };
  const text = sel.name ?? sel.text ?? sel.label ?? sel.placeholder;
  if (text) return { key: 'text', value: text };
  // Role-only (or otherwise matcher-less): Maestro has no role matcher.
  return null;
}

/** Honest-degradation comment when a selector has no Maestro-usable matcher. */
function noMatcherTodo(sel: Selector): string {
  const what = sel.role ? `role=${sel.role}` : 'this selector';
  return `# TODO (lossy): Maestro has no role matcher for ${what}; add a name/testId or drive manually.`;
}

/** YAML-quote a scalar value defensively (handles colons, quotes, etc.). */
function yamlString(s: string): string {
  return JSON.stringify(s);
}

/** Human description of a check for dedup/skip comments — includes the role. */
function describeSelector(sel: Selector): string {
  const parts: string[] = [];
  if (sel.role) parts.push(`role=${sel.role}`);
  const label = sel.name ?? sel.text ?? sel.label ?? sel.placeholder;
  if (label) parts.push(JSON.stringify(label));
  if (sel.testId) parts.push(`testId=${sel.testId}`);
  return parts.join(' ') || 'selector';
}

function describeCheck(check: Check): string {
  if (isClickCheck(check)) return `click ${describeSelector(check.click)}`;
  if (isFillCheck(check)) {
    const { value: _v, ...sel } = check.fill;
    return `fill ${describeSelector(sel)}`;
  }
  if (isExpectCheck(check) && check.expect.element) {
    const { state: _s, count: _c, ...sel } = check.expect.element;
    return `expect element ${describeSelector(sel as Selector)}`;
  }
  return 'check';
}

/** The role of a check's selector, if any — used to explain dedup collapses. */
function checkRole(check: Check): string | undefined {
  if (isClickCheck(check)) return check.click.role;
  if (isFillCheck(check)) return check.fill.role;
  if (isExpectCheck(check) && check.expect.element) return check.expect.element.role;
  return undefined;
}

interface EmitCtx {
  routes?: MaestroExportConfig['routes'];
}

function emitRouteSteps(url: string, route: string | MaestroRouteStep[]): string[] {
  const lines: string[] = [
    `# navigate: ${oneLine(url)} (route preamble from export.maestro.routes)`,
  ];
  if (typeof route === 'string') {
    lines.push(`- openLink: ${yamlString(route)}`);
    return lines;
  }
  for (const step of route) {
    if ('tapOn' in step) {
      lines.push(`- tapOn:`, `    text: ${yamlString(step.tapOn)}`);
    } else {
      lines.push(`- tapOn:`, `    id: ${yamlString(step.tapOnId)}`);
    }
  }
  return lines;
}

function emitCheckLines(check: Check, ctx: EmitCtx): string[] {
  if (isNavigateCheck(check)) {
    const url = check.navigate.url;
    const route = ctx.routes?.[url];
    if (route !== undefined) return emitRouteSteps(url, route);
    return [
      `# (navigate) target route: ${oneLine(url)}`,
      `# TODO: no route mapping — Maestro launched the app at the top of this flow`,
      `#   and stays on the launch screen. Declare export.maestro.routes[${yamlString(url)}]`,
      `#   in .validity/config.ts (a deep link or tapOn steps) so this flow can`,
      `#   reach the screen in the real app.`,
    ];
  }
  if (isClickCheck(check)) {
    const s = maestroSelector(check.click);
    if (!s) return [noMatcherTodo(check.click)];
    // Steps are siblings of `- launchApp` at column 0; the mapping body is the
    // only thing indented (4 spaces) — otherwise the flow sequence is invalid YAML.
    return [`- tapOn:`, `    ${s.key}: ${yamlString(s.value)}`];
  }
  if (isPressCheck(check)) {
    const { key, times } = pressKeyAndTimes(check.press);
    return [
      `# TODO (lossy): Maestro has no hardware-keyboard press — key '${key}'${
        times > 1 ? ` ×${times}` : ''
      } can't`,
      `#   be asserted. Verify keyboard reachability in Validity or the Playwright export.`,
    ];
  }
  if (isHoverCheck(check)) {
    return [
      `# TODO (lossy): Maestro has no hover (touch UIs have no hover state) — ${describeSelector(
        check.hover,
      )}`,
      `#   can't be asserted. Verify hover in Validity or the Playwright export.`,
    ];
  }
  if (isFillCheck(check)) {
    const { value, ...sel } = check.fill;
    const s = maestroSelector(sel);
    if (!s) return [noMatcherTodo(sel)];
    return [
      `- tapOn:`,
      `    ${s.key}: ${yamlString(s.value)}`,
      `- inputText: ${yamlString(value)}`,
    ];
  }
  if (isWaitCheck(check)) {
    const body = check.wait;
    if (body.ms !== undefined) {
      return [
        `# TODO (lossy): Maestro has no sleep — wait ${body.ms}ms can't be asserted.`,
        `#   Verify timed waits in Validity or the Playwright export.`,
      ];
    }
    const sel = body.for!;
    const s = maestroSelector(sel);
    const state = body.state ?? 'visible';
    if (!s) return [noMatcherTodo(sel)];
    // Scalar `visible: "text"` (not a nested mapping) stays inside the 0.20.5
    // field allow-list. An id matcher needs a nested mapping the subset linter
    // would flag — degrade honestly rather than emit a flow that won't parse.
    if (s.key !== 'text') {
      return [
        `# TODO (lossy): Maestro extendedWaitUntil can't target id ${yamlString(s.value)} without a nested mapping the 0.20.5 subset refuses.`,
        `#   Add a name/text or verify wait in Validity / Playwright.`,
      ];
    }
    const field = state === 'hidden' ? 'notVisible' : 'visible';
    return [`- extendedWaitUntil:`, `    ${field}: ${yamlString(s.value)}`];
  }
  if (isWaitForRequestCheck(check)) {
    const want = check.waitForRequest;
    return [
      `# TODO (lossy): Maestro can't observe network — waitForRequest ${oneLine(
        `${want.method ?? 'ANY'} ${want.url}`,
      )} can't be asserted. Verify it in Validity or Playwright.`,
    ];
  }
  if (isSelectCheck(check)) {
    return [
      `# TODO (lossy): Maestro has no selectOption (pickers differ per platform) — ${describeSelector(
        check.select.selector,
      )}`,
      `#   option ${yamlString(
        typeof check.select.option === 'string'
          ? check.select.option
          : JSON.stringify(check.select.option),
      )}. Use tapOn + tapOn on the option, or the Playwright export.`,
    ];
  }
  if (isScrollCheck(check)) {
    const body = check.scroll;
    if (body.intoView && body.selector) {
      const s = maestroSelector(body.selector);
      if (!s) return [noMatcherTodo(body.selector)];
      if (s.key !== 'text') {
        return [
          `# TODO (lossy): Maestro scrollUntilVisible can't target id ${yamlString(s.value)} without a nested mapping the 0.20.5 subset refuses.`,
        ];
      }
      return [
        `- scrollUntilVisible:`,
        `    element: ${yamlString(s.value)}`,
        `    direction: DOWN`,
      ];
    }
    if (body.to === 'bottom') {
      return [`- scroll`];
    }
    if (body.to === 'top') {
      return [
        `# TODO (lossy): Maestro has no scroll-to-top — verify in Validity or the Playwright export.`,
      ];
    }
    if (body.by) {
      return [
        `# TODO (lossy): Maestro has no pixel-delta scroll — verify in Validity or the Playwright export.`,
      ];
    }
    return [`# (scroll skipped — no to/by/intoView)`];
  }
  if (isExpectCheck(check)) {
    return emitExpectLines(check.expect);
  }
  return [`# (unrecognized check skipped)`];
}

function emitExpectLines(body: ExpectBody): string[] {
  if (body.element) return emitElementExpect(body.element);
  if (body.network) {
    return [
      `# TODO (lossy): Maestro can't assert network — verify "${oneLine(
        `${body.network.method ?? 'ANY'} ${body.network.url} → ${body.network.status ?? '2xx'}`,
      )}" in Validity or Playwright.`,
    ];
  }
  if (body.console) {
    return [
      `# TODO (lossy): Maestro can't assert the JS console (errors <= ${body.console.errors})`,
      `#   — verify console expectations in Validity or Playwright.`,
    ];
  }
  if (body.performance) {
    return [
      `# TODO (lossy): Maestro can't measure performance — verify "${oneLine(
        `${body.performance.metric} <= ${body.performance.maxMs}ms`,
      )}" in Validity's web sandbox.`,
    ];
  }
  if (body.screenshot) {
    const name = body.screenshot.name ?? 'screenshot';
    return [
      `- takeScreenshot: ${yamlString(name)}`,
      `    # NOTE: Maestro has no built-in pixel-diff baseline; this just captures an image.`,
    ];
  }
  if (body.a11y) {
    const severity = body.a11y.severity ?? 'serious';
    const maxViolations = body.a11y.maxViolations ?? 0;
    return [
      `# TODO (lossy): Maestro can't assert axe a11y violations — verify "${severity}+ ≤ ${maxViolations}"`,
      `#   in Validity or the Playwright export (axe-core).`,
    ];
  }
  if (body.command) {
    return [
      `# TODO (lossy): Maestro can't run repo commands — run '${body.command.run}' as its own CI step.`,
    ];
  }
  return [`# (empty expect skipped)`];
}

function emitElementExpect(el: ElementExpect): string[] {
  const { state, count, ...sel } = el;
  const s = maestroSelector(sel as Selector);
  if (!s) return [noMatcherTodo(sel as Selector)];
  // Absence: count:0 or state hidden → assertNotVisible.
  if (count === 0 || state === 'hidden') {
    return [`- assertNotVisible:`, `    ${s.key}: ${yamlString(s.value)}`];
  }
  const lines = [`- assertVisible:`, `    ${s.key}: ${yamlString(s.value)}`];
  if (state === 'enabled' || state === 'disabled' || state === 'checked' || state === 'focused') {
    lines.push(
      `    # TODO (lossy): Maestro can't directly assert "${state}" — assertVisible is the closest.`,
    );
  }
  if (count !== undefined && count > 0) {
    lines.push(`    # TODO (lossy): Maestro can't assert an exact count (${count}).`);
  }
  return lines;
}

/** True when an emitted block is a real step (vs a comment-only degradation). */
function isStepBlock(lines: string[]): boolean {
  return lines[0]?.startsWith('- ') ?? false;
}

/**
 * True when an emitted step is an ASSERTION (`assertVisible`/`assertNotVisible`)
 * — the only kind we deduplicate. Actions (tapOn/inputText/takeScreenshot/…)
 * are never deduped: two taps on "Increment" are two real interactions, and a
 * screenshot taken twice captures two frames.
 */
function isAssertionBlock(lines: string[]): boolean {
  return (
    lines[0]?.startsWith('- assertVisible') === true ||
    lines[0]?.startsWith('- assertNotVisible') === true
  );
}

/** True when an emitted step matches by visible text (vs id/testID). */
function usesTextMatcher(lines: string[]): boolean {
  return lines.some((l) => l.startsWith('    text: '));
}

const I18N_RISK_NOTE =
  '    # (text matcher — string from the isolated render; may drift from app i18n/copy. Prefer a testID → id:.)';

function emitCriterion(criterion: SpecCriterion, ctx: EmitCtx): string[] {
  const lines: string[] = [];
  lines.push(`# ── ${criterion.id}: ${oneLine(criterion.text)} [${criterion.tier}]`);
  if (criterion.tier === 'soft') {
    lines.push(`# (soft — LLM-scored from screenshots; no mechanical Maestro step.`);
    lines.push(`#   Review this visually in Validity.)`);
    return lines;
  }
  if (criterion.mocking === 'required') {
    lines.push(`# NOTE: this criterion assumed Validity's mocked network. Maestro hits the`);
    lines.push(`#   real app — point it at an env/build with equivalent test data.`);
  }
  // Collapse a run of BYTE-IDENTICAL ASSERTIONS: two distinct checks (e.g.
  // role: header vs role: button with the same name — Maestro has no role
  // matcher) can compile to the same `assertVisible`, and emitting each reads
  // as a redundant flow. The scope is deliberately narrow:
  //   - ASSERTIONS only (see isAssertionBlock) — repeated ACTIONS like two taps
  //     on "Increment" are real interactions and must both survive;
  //   - only when identical to the IMMEDIATELY PRECEDING emitted step — an
  //     assertion repeated after an intervening step (assert X → tap Y →
  //     assert X) is a genuine re-check and is kept.
  // Comparison is against the pre-i18n-note step lines (`emitted`); the note is
  // appended to the output below, AFTER this bookkeeping.
  let prevStepKey: string | null = null;
  let prevCheck: Check | null = null;
  let i18nNoted = false;
  for (const check of criterion.checks ?? []) {
    const emitted = emitCheckLines(check, ctx);
    if (!isStepBlock(emitted)) {
      // A comment-only degradation is not a step; leave the preceding-step
      // tracking untouched (only a real intervening step breaks a dup run).
      lines.push(...emitted);
      continue;
    }
    const key = emitted.join('\n');
    if (isAssertionBlock(emitted) && prevCheck && key === prevStepKey) {
      const roleClause =
        checkRole(check) || checkRole(prevCheck)
          ? ` — Maestro has no role matcher to distinguish them`
          : '';
      lines.push(
        `# (duplicate skipped: ${describeCheck(check)} compiles to the same step as`,
        `#   ${describeCheck(prevCheck)} above${roleClause}.)`,
      );
      // Keep prev* on the SURVIVING assertion so a third identical one collapses too.
      continue;
    }
    lines.push(...emitted);
    if (!i18nNoted && usesTextMatcher(emitted)) {
      lines.push(I18N_RISK_NOTE);
      i18nNoted = true;
    }
    prevStepKey = key;
    prevCheck = check;
  }
  return lines;
}

/** Canonical artifact basename — version-bound like the Playwright twin. */
export function maestroFlowFileName(spec: Pick<Spec, 'id' | 'version'>): string {
  return `${spec.id}.v${spec.version}.flow.yaml`;
}

/**
 * The generated launch preamble (isolation → E2E bridge, §B1 of the 2026-07-07
 * deficiency report). `clearState` gives run-to-run determinism; the guarded
 * taps dismiss dev-build overlays and no-op on release builds. Conditions in
 * `runFlow.when` are evaluated once — absent overlays cost no wait time.
 */
function emitLaunchPreamble(maestro?: MaestroExportConfig): string[] {
  const clearState = maestro?.clearState ?? true;
  const dismiss = maestro?.dismissDevOverlays ?? true;
  const lines: string[] = [];
  if (clearState) {
    lines.push(`# Fresh install state — deterministic run-to-run (export.maestro.clearState).`);
    lines.push(`- launchApp:`, `    clearState: true`);
  } else {
    lines.push(`- launchApp`);
  }
  if (dismiss) {
    lines.push('');
    lines.push(
      `# Best-effort dismissal of dev-build overlays (export.maestro.dismissDevOverlays).`,
    );
    lines.push(`# Each guard no-ops on release builds. Android ANR dialog — keep waiting:`);
    lines.push(
      `- runFlow:`,
      `    when:`,
      `      visible: "Wait"`,
      `    commands:`,
      `      - tapOn: "Wait"`,
    );
    lines.push(`# expo-dev-client first-launch onboarding — "Continue" enters the app:`);
    lines.push(
      `- runFlow:`,
      `    when:`,
      `      visible: "Continue"`,
      `    commands:`,
      `      - tapOn: "Continue"`,
    );
    lines.push(`# expo-dev-client dev menu (Reload / Go home / …) — back closes the sheet`);
    lines.push(`# (Android; iOS dev menus need a manual swipe — release builds never show one):`);
    lines.push(
      `- runFlow:`,
      `    when:`,
      `      visible: "Reload"`,
      `    commands:`,
      `      - back`,
    );
  }
  return lines;
}

export function exportSpecToMaestro(args: ExportSpecMaestroArgs): ExportSpecMaestroResult {
  const { spec, appId, maestro } = args;
  const warnings = collectMaestroWarnings({ spec, hasAppId: Boolean(appId), maestro });

  const header: string[] = [
    // Byte-deterministic DO-NOT-EDIT header (plan §B2) — no timestamps; the
    // manifest carries `generatedAt`, never the artifact bytes.
    `# GENERATED from ${spec.id}@v${spec.version} (${spec.hash ?? 'unfrozen'}) — DO NOT EDIT;`,
    `# regenerate with \`validity spec export ${spec.id}\`.`,
    `#`,
    `# Source prompt: ${oneLine(spec.source.prompt)}`,
    `#`,
    `# BUILD TYPE: run this flow against a release/preview build (e.g.`,
    `#   \`eas build -p android --profile preview\` or \`expo run:android --variant release\`).`,
    `#   Dev-client builds boot into the expo-dev-client shell, depend on Metro, and`,
    `#   are ANR-prone — the launch preamble below dismisses those overlays`,
    `#   best-effort, but a clean release/preview build is the reliable path.`,
    `#`,
    `# LOSSY MAPPING — read before trusting this flow:`,
    `#   Maestro can tap, type, and assert visibility. It CANNOT observe network`,
    `#   traffic or the JS console, so any \`expect.network\` / \`expect.console\``,
    `#   criterion degrades to a TODO comment (verify those in Validity or the`,
    `#   Playwright export). Element state (enabled/disabled/checked) and exact`,
    `#   counts also have no direct Maestro assertion and are flagged inline.`,
    `#   \`text:\` matchers use strings from Validity's ISOLATED render — real-app`,
    `#   i18n/copy changes will not match them; prefer testIDs (exported as \`id:\`).`,
  ];
  if (!appId) {
    header.push(
      `#`,
      `# TODO: set export.appId in .validity/config.ts to your app's bundle/package id.`,
    );
  }

  const body: string[] = [];
  body.push(header.join('\n'));
  body.push(
    appId
      ? `appId: ${yamlString(appId)}`
      : `appId: com.example.app # TODO: replace with your real appId (config export.appId)`,
  );
  body.push(`---`);
  body.push(emitLaunchPreamble(maestro).join('\n'));

  const ctx: EmitCtx = { routes: maestro?.routes };
  for (const criterion of spec.criteria) {
    body.push('');
    body.push(emitCriterion(criterion, ctx).join('\n'));
  }
  body.push('');

  const contents = body.join('\n');

  // Subset lint over the bytes we just emitted (agent-device 0.20.5 engine).
  // Placed HERE rather than in a spec-shaped predicate so the warning can never
  // drift from what the file actually contains: whatever a future emitter change
  // writes is exactly what gets checked. A well-formed export lints clean, so
  // this appends nothing in the ordinary case.
  warnings.push(...lintMaestroSubset(contents));

  return { files: [{ path: maestroFlowFileName(spec), contents }], warnings };
}
