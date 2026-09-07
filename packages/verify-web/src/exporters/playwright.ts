/**
 * Playwright test scaffold exporter. Takes a finished verify run and emits
 * one `.spec.ts` per scenario into the user's `tests/e2e/` directory.
 *
 * **Framing — read this before changing anything:**
 *
 * This is NOT "Validity generates your tests." It IS "Validity saves you
 * the 15 minutes of boilerplate." The generated spec is a SCAFFOLD —
 * `mockNetwork` becomes `page.route()`, cookies become
 * `context.addCookies()`, the scenario's `play({ page })` body inlines,
 * each acceptance criterion becomes a `test.step('TODO assertion: …')`
 * block. The user replaces every TODO with a real assertion before the
 * scaffold is a test worth running.
 *
 * Cypress and Maestro targets are explicitly NOT supported. Adding them
 * is out of scope until a user actually asks for one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  MockHandlerResponse,
  MockNetworkConfig,
  MockNetworkHandler,
  PlayFunction,
  RunMeta,
  ScenarioConfig,
  ValidityConfig,
} from '@validity.ai/verify-spec';
import { slugify } from '@validity.ai/verify-spec';

export interface ExportCriterion {
  description: string;
  status?: 'pass' | 'fail' | 'unverifiable';
  reasoning?: string;
  suggestion?: string;
}

export interface ExportArgs {
  /** Run metadata produced by `validity__verify`. */
  runMeta: RunMeta;
  /** Resolved validity config — needed for scenario play / mockNetwork / cookies. */
  config: ValidityConfig;
  /** Output directory for generated specs. */
  outDir: string;
  /**
   * Base URL for URL-mode tests. URL-mode renders already carry their
   * absolute URL, so this is used as a hint in the file-header comment.
   * Isolation-mode scaffolds get a TODO comment telling the user to
   * navigate to a real route in their app.
   */
  baseUrl?: string;
  /**
   * Emit `await expect(page).toHaveScreenshot()` after the play body.
   * Off by default — visual assertions need baseline images, which the
   * user typically manages separately from Validity's screenshots.
   */
  includeVisualAssertions?: boolean;
  /** Overwrite existing spec files. Default: false (skip with reason). */
  force?: boolean;
  /**
   * Acceptance criteria to emit as `test.step('TODO assertion: …')`
   * blocks. Falls back to a generic single-TODO step when omitted.
   */
  criteria?: ExportCriterion[];
}

export interface ExportResult {
  /** Absolute paths of generated .spec.ts files. */
  written: string[];
  /**
   * Reasons we skipped a render (already-existing file, missing screenshot,
   * etc.). Each entry is "<componentId or pageId>: <reason>".
   */
  skipped: string[];
}

interface ExportRender {
  kind: 'isolation' | 'url';
  /** Unique-within-run id; combines into the filename. */
  componentOrPageId: string;
  scenarioId?: string;
  /** Filesystem-safe filename (without extension). */
  slug: string;
  /** Display title shown in `test.describe()`. */
  title: string;
  /** For URL mode: the absolute URL to navigate to. */
  url?: string;
  /** For isolation mode: the project-relative component path. */
  componentPath?: string;
}

/**
 * Top-level entrypoint. Pure function: it neither reads run-meta off
 * disk nor loads the config — that's the CLI's job. This way the
 * exporter is straightforward to unit-test with synthetic inputs.
 */
export function exportPlaywright(args: ExportArgs): ExportResult {
  const written: string[] = [];
  const skipped: string[] = [];

  const renders = enumerateRenders(args.runMeta);
  if (renders.length === 0) {
    skipped.push('run: no renders found in run-meta');
    return { written, skipped };
  }

  ensureDir(args.outDir);

  for (const r of renders) {
    const targetPath = resolve(args.outDir, `${r.slug}.spec.ts`);
    if (!args.force && existsSync(targetPath)) {
      skipped.push(
        `${r.componentOrPageId}: ${targetPath} already exists (pass --force to overwrite)`,
      );
      continue;
    }
    const source = renderSpec({
      render: r,
      runMeta: args.runMeta,
      config: args.config,
      baseUrl: args.baseUrl,
      includeVisualAssertions: args.includeVisualAssertions === true,
      criteria: args.criteria ?? [],
    });
    writeFileSync(targetPath, source);
    written.push(targetPath);
  }

  return { written, skipped };
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Turn the run-meta's components/pages list into a deduplicated, ordered
 * list of (componentOrPage × scenario) pairs to emit. We collapse
 * duplicate viewports / fixtures down to a single render per
 * (component × scenario) pair — a Playwright spec doesn't need three
 * separate "mobile / tablet / desktop" tests just because Validity took
 * three screenshots. The user can add `test.use({ viewport: ... })` if
 * they want viewport coverage in their suite.
 */
function enumerateRenders(meta: RunMeta): ExportRender[] {
  const seen = new Set<string>();
  const out: ExportRender[] = [];

  if ((meta.mode ?? 'isolation') === 'url') {
    for (const page of meta.pages ?? []) {
      const key = `${page.pathId}__${page.scenarioId ?? 'base'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: 'url',
        componentOrPageId: page.pathId,
        scenarioId: page.scenarioId,
        slug: filenameSlug(page.pathId, page.scenarioId),
        title: page.url,
        url: page.url,
      });
    }
    return out;
  }

  for (const c of meta.components ?? []) {
    const key = `${c.id}__${c.scenarioId ?? 'base'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'isolation',
      componentOrPageId: c.id,
      scenarioId: c.scenarioId,
      slug: filenameSlug(c.id, c.scenarioId),
      title: c.filePath,
      componentPath: c.filePath,
    });
  }
  return out;
}

function filenameSlug(componentOrPageId: string, scenarioId?: string): string {
  const left = slugify(componentOrPageId) || 'render';
  if (!scenarioId) return `${left}.base`;
  return `${left}.${slugify(scenarioId) || 'scenario'}`;
}

interface RenderSpecArgs {
  render: ExportRender;
  runMeta: RunMeta;
  config: ValidityConfig;
  baseUrl?: string;
  includeVisualAssertions: boolean;
  criteria: ExportCriterion[];
}

function renderSpec(args: RenderSpecArgs): string {
  const { render, runMeta, config, baseUrl, includeVisualAssertions, criteria } = args;
  const scenarioId = render.scenarioId;
  const scenario: ScenarioConfig | undefined = scenarioId
    ? config.scenarios?.[scenarioId]
    : undefined;
  const merged = mergeNetwork(config.mockNetwork, scenario?.mockNetwork);

  const isIsolation = render.kind === 'isolation';
  const headerLines: string[] = [
    `// Generated by Validity. Edit freely.`,
    `//`,
    `// This file is a SCAFFOLD — Validity translated your verify run into`,
    `// Playwright boilerplate. Before this is a real test, you need to:`,
    `//   1. Replace each \`TODO assertion:\` step with a concrete \`expect(...)\`.`,
    `//   2. Harden selectors (prefer \`data-testid\` over text matchers).`,
    `//   3. Swap \`page.route(...)\` mocks for real backend fixtures if your`,
    `//      suite already manages test data.`,
    `//   4. Decide whether the visual screenshot assertion (if enabled below)`,
    `//      belongs in this suite or in a separate visual-regression run.`,
    `//`,
    `// Source run: ${runMeta.runId} @ ${runMeta.createdAt}`,
  ];
  if (runMeta.git) {
    const sha = runMeta.git.sha?.slice(0, 7) ?? 'unknown';
    const dirty = runMeta.git.dirty ? ' dirty' : '';
    headerLines.push(`// git: ${runMeta.git.branch ?? '?'} @ ${sha}${dirty}`);
  }
  if (isIsolation) {
    headerLines.push(`//`);
    headerLines.push(`// TODO: this scaffold was produced for a component Validity rendered in`);
    headerLines.push(`//   isolation. Isolation renders aren't reachable from a real Playwright`);
    headerLines.push(`//   test — replace the goto() below with a route in your app that`);
    headerLines.push(
      `//   actually renders \`${render.componentPath ?? render.componentOrPageId}\`.`,
    );
  }

  const body: string[] = [];
  body.push(headerLines.join('\n'));
  body.push('');
  body.push(`import { test, expect } from '@playwright/test';`);
  body.push('');

  const describeTitle = scenarioId
    ? `${render.componentOrPageId} — ${scenarioId}`
    : render.componentOrPageId;
  body.push(`test.describe(${jsString(describeTitle)}, () => {`);

  const testTitle = scenarioId ? scenarioId : 'base render';
  body.push(`  test(${jsString(testTitle)}, async ({ page, context }) => {`);

  // Cookies — addCookies needs a url or domain. We don't always know that
  // statically, so we emit a TODO that asks the user to set it.
  const cookieEntries = Object.entries(merged.cookies ?? {});
  if (cookieEntries.length > 0) {
    body.push('    // Cookies seeded by Validity scenario. addCookies() needs a url or domain —');
    body.push('    // set it to whatever host your app runs at in this suite.');
    body.push('    await context.addCookies([');
    for (const [name, value] of cookieEntries) {
      body.push(
        `      { name: ${jsString(name)}, value: ${jsString(value)}, url: ${jsString(
          baseUrl ?? 'http://localhost:3000',
        )} },`,
      );
    }
    body.push('    ]);');
    body.push('');
  }

  // localStorage / sessionStorage — addInitScript ensures the values are
  // present before any page script runs.
  const storage = collectStorage(merged);
  if (storage.local.length > 0 || storage.session.length > 0) {
    body.push('    // Pre-navigation storage seed. Mirrors mockNetwork.localStorage /');
    body.push('    // mockNetwork.sessionStorage from .validity/config.ts.');
    const storageUrl =
      render.kind === 'url' && render.url ? render.url : (baseUrl ?? 'http://localhost:3000/');
    body.push('    // Keep this origin aligned with the goto() target below.');
    body.push('    await context.addInitScript(() => {');
    body.push(`      if (location.origin !== ${jsString(new URL(storageUrl).origin)}) return;`);
    for (const [k, v] of storage.local) {
      body.push(`      window.localStorage.setItem(${jsString(k)}, ${jsString(v)});`);
    }
    for (const [k, v] of storage.session) {
      body.push(`      window.sessionStorage.setItem(${jsString(k)}, ${jsString(v)});`);
    }
    body.push('    });');
    body.push('');
  }

  // Network mocks. Each handler → one `page.route()` call. We translate
  // the same shape Validity's MSW interceptor understands.
  const handlers = merged.handlers ?? [];
  if (handlers.length > 0) {
    body.push('    // Network mocks — each handler in your scenario becomes one page.route().');
    body.push('    // Adjust the URL pattern to match how your real app issues these requests.');
    for (const h of handlers) {
      body.push(...renderRoute(h));
    }
    body.push('');
  }

  // Fallback as a catch-all if it's an explicit fixed response. 'permissive'
  // and 'populate' are Validity-harness auto-mock policies (empty / synthetic
  // bodies) with no real-app Playwright equivalent, so they don't emit a route.
  if (merged.fallback && merged.fallback !== 'permissive' && merged.fallback !== 'populate') {
    body.push('    // Fallback handler — Validity scenario specified a non-permissive fallback.');
    body.push(...renderFallback(merged.fallback));
    body.push('');
  }

  // Navigation.
  if (render.kind === 'url' && render.url) {
    body.push(`    await page.goto(${jsString(render.url)});`);
  } else {
    body.push(`    // TODO: navigate to a route in your app that renders this component.`);
    if (baseUrl) {
      body.push(`    await page.goto(${jsString(baseUrl)});`);
    } else {
      body.push(`    await page.goto('http://localhost:3000/'); // TODO: pick the right path`);
    }
  }
  body.push('');

  // Play function — inline if present. Scenario-level only for now;
  // fixture-level play isn't part of the (component × scenario) key
  // dimension this exporter walks.
  if (scenario?.play) {
    const playBody = serializePlay(scenario.play);
    if (playBody.kind === 'ok') {
      body.push('    // Scenario play() body inlined from .validity/config.ts.');
      for (const line of playBody.lines) body.push('    ' + line);
      body.push('');
    } else {
      body.push(`    // TODO: paste your play function body here — Validity couldn't`);
      body.push(`    //   serialize it cleanly (${playBody.reason}).`);
      body.push('');
    }
  }

  // Criteria → test.step blocks. Each is a TODO assertion.
  if (criteria.length > 0) {
    for (const c of criteria) {
      body.push(
        `    await test.step(${jsString(`TODO assertion: ${c.description}`)}, async () => {`,
      );
      if (c.reasoning) {
        body.push(`      // Agent saw: ${oneLine(c.reasoning)}`);
      }
      if (c.suggestion) {
        body.push(`      // Suggested fix: ${oneLine(c.suggestion)}`);
      }
      body.push(`      // TODO: replace this with a concrete expect(...) call.`);
      body.push('    });');
    }
  } else {
    body.push(`    await test.step('TODO assertion: replace with acceptance check', async () => {`);
    body.push(`      // TODO: assert what the user prompt actually required.`);
    body.push(`      // Prompt: ${oneLine(runMeta.prompt)}`);
    body.push('    });');
  }
  body.push('');

  if (includeVisualAssertions) {
    body.push('    // Visual assertion — Playwright manages its own baseline image,');
    body.push("    // separate from Validity's screenshots. First run will fail; commit");
    body.push('    // the generated PNG to lock the baseline in.');
    body.push('    await expect(page).toHaveScreenshot();');
  }

  body.push('  });');
  body.push('});');
  body.push('');

  return body.join('\n');
}

function mergeNetwork(base?: MockNetworkConfig, override?: MockNetworkConfig): MockNetworkConfig {
  const merged: MockNetworkConfig = {
    handlers: [
      // Scenario handlers first → "first match wins" gives them priority.
      ...(override?.handlers ?? []),
      ...(base?.handlers ?? []),
    ],
    cookies: { ...(base?.cookies ?? {}), ...(override?.cookies ?? {}) },
    localStorage: { ...(base?.localStorage ?? {}), ...(override?.localStorage ?? {}) },
    sessionStorage: { ...(base?.sessionStorage ?? {}), ...(override?.sessionStorage ?? {}) },
    fallback: override?.fallback ?? base?.fallback,
  };
  return merged;
}

function collectStorage(merged: MockNetworkConfig): {
  local: Array<[string, string]>;
  session: Array<[string, string]>;
} {
  return {
    local: Object.entries(merged.localStorage ?? {}),
    session: Object.entries(merged.sessionStorage ?? {}),
  };
}

function renderRoute(h: MockNetworkHandler): string[] {
  const status = h.status ?? 200;
  const headersObj = h.headers ?? {};
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
  const lines: string[] = [];
  lines.push(`    await page.route(${routePattern(h.url)}, async (route) => {`);
  if (methodGuard) {
    lines.push(`      if (route.request().method() !== ${jsString(methodGuard)}) {`);
    lines.push(`        return route.fallback();`);
    lines.push(`      }`);
  }
  lines.push(`      await route.fulfill({`);
  lines.push(`        status: ${status},`);
  const headers = { ...(contentType ? { 'content-type': contentType } : {}), ...headersObj };
  if (Object.keys(headers).length > 0) {
    lines.push(`        headers: ${JSON.stringify(headers)},`);
  }
  lines.push(`        body: ${bodyLiteral},`);
  lines.push(`      });`);
  lines.push(`    });`);
  return lines;
}

function renderFallback(fallback: 'reject' | MockHandlerResponse): string[] {
  if (fallback === 'reject') {
    return [
      `    await page.route('**/*', async (route) => {`,
      `      if (route.request().resourceType() !== 'document' && route.request().resourceType() !== 'xhr' && route.request().resourceType() !== 'fetch') {`,
      `        return route.fallback();`,
      `      }`,
      `      await route.fulfill({ status: 599, body: 'Validity scenario: unmatched request rejected.' });`,
      `    });`,
    ];
  }
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
  return [
    `    await page.route('**/*', async (route) => {`,
    `      const t = route.request().resourceType();`,
    `      if (t !== 'document' && t !== 'xhr' && t !== 'fetch') return route.fallback();`,
    `      await route.fulfill({`,
    `        status: ${status},`,
    `        headers: ${JSON.stringify(headers)},`,
    `        body: ${bodyLiteral},`,
    `      });`,
    `    });`,
  ];
}

/**
 * Translate Validity's url-pattern dialect (`/api/me`, `/api/*`, full
 * URLs) to a Playwright pattern. Playwright's `page.route` accepts
 * glob strings, regex, or predicate functions; the glob `**\/api/me`
 * matches any host.
 */
function routePattern(url: string): string {
  if (/^https?:\/\//.test(url)) {
    return jsString(url);
  }
  if (url.endsWith('/*')) {
    return jsString(`**${url.slice(0, -2)}/**`);
  }
  if (url.includes('*')) {
    return jsString(`**${url}`);
  }
  return jsString(`**${url}`);
}

interface PlaySerializationOk {
  kind: 'ok';
  lines: string[];
}
interface PlaySerializationErr {
  kind: 'err';
  reason: string;
}
type PlaySerialization = PlaySerializationOk | PlaySerializationErr;

/**
 * Defensively pull the body out of a `play` function so we can paste it
 * into the test. Bound functions, classes, and native code all show up
 * as opaque `function (args) { [native code] }` strings — return an
 * error in that case rather than emitting unparseable garbage.
 *
 * Closures over local variables in the user's `.validity/config.ts`
 * (e.g. `const url = '/api/me'; play: async ({ page }) => page.goto(url)`)
 * also produce broken specs — the inlined body references `url` which
 * doesn't exist in the test scope. We warn loudly in that case.
 */
function serializePlay(play: PlayFunction): PlaySerialization {
  let raw: string;
  try {
    raw = play.toString();
  } catch (err) {
    return { kind: 'err', reason: (err as Error).message };
  }

  if (raw.includes('[native code]')) {
    return { kind: 'err', reason: 'function is native or bound' };
  }

  // Strip wrapper: `async ({ page }) => { ... }` or
  // `({ page }) => page.click(...)` or `async function ({ page }) { ... }`
  // or `function play({ page }) { ... }`. We don't try to handle every
  // exotic case — when we miss, we emit the TODO comment.
  const bodyMatch = raw.match(/=>\s*\{([\s\S]*)\}\s*$/) ?? raw.match(/\)\s*\{([\s\S]*)\}\s*$/);
  let body: string;
  if (bodyMatch) {
    body = bodyMatch[1] ?? '';
  } else {
    // Arrow with expression body: `({ page }) => page.click('x')`
    const exprMatch = raw.match(/=>\s*([\s\S]*)$/);
    if (exprMatch && exprMatch[1] != null) {
      body = `return ${exprMatch[1].trim()};`;
    } else {
      return { kind: 'err', reason: 'could not locate function body' };
    }
  }

  body = dedent(body.replace(/^\n/, '').replace(/\n\s*$/, ''));
  if (body.length === 0) {
    return { kind: 'ok', lines: ['// (play body was empty)'] };
  }

  const lines = body.split('\n');
  // Lightweight closure smell-test: if the body references a top-level
  // identifier we'd commonly close over in a config file (an API base,
  // a shared client, a store) AND doesn't declare it inside the body,
  // tag a TODO comment. False positives are fine — we only ever add a
  // comment, never refuse to emit.
  const closureNames = ['api', 'baseUrl', 'cfg', 'client', 'store'];
  for (const n of closureNames) {
    const ref = new RegExp(`(^|[^\\w$.])${n}\\b`);
    const decl = new RegExp(`\\b(const|let|var)\\s+${n}\\b`);
    if (ref.test(body) && !decl.test(body)) {
      lines.unshift('// TODO: this play body may reference closure variables from your');
      lines.unshift('//   .validity/config.ts. Review and replace with explicit values.');
      break;
    }
  }
  return { kind: 'ok', lines };
}

function dedent(s: string): string {
  const lines = s.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (l.trim().length === 0) continue;
    const m = l.match(/^(\s*)/);
    const w = m && m[1] ? m[1].length : 0;
    if (w < min) min = w;
  }
  if (!isFinite(min) || min === 0) return s;
  return lines.map((l) => l.slice(min)).join('\n');
}

function jsString(s: string): string {
  // JSON.stringify is the safest js-string serializer in Node — handles
  // quotes, backslashes, control chars, unicode. Wrap in same-shaped
  // quotes so it round-trips as a TS string literal.
  return JSON.stringify(s);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * Convenience: load a sidecar `report-meta.json` that `submit_report`
 * writes alongside the HTML report. Returns `null` when the file isn't
 * there — the CLI falls back to a generic TODO step in that case.
 */
export function loadReportCriteria(runDir: string): ExportCriterion[] | null {
  const path = resolve(runDir, 'report-meta.json');
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as { criteria?: ExportCriterion[] };
    return parsed.criteria ?? null;
  } catch {
    return null;
  }
}
