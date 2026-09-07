/**
 * Unit tests for the spec-driven export compilers. Pure string generation —
 * we assert the SOURCE the compilers emit contains the right real assertions
 * (getByRole().click(), .fill(), waitForResponse, test.fixme for soft,
 * per-viewport describes, a fixtures file when mocking is required) and that
 * the Maestro output carries tapOn + the documented lossy TODOs.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  MaestroExportConfig,
  MockNetworkConfig,
  Spec,
  SpecCriterion,
  ValidityConfig,
} from '@validity.ai/verify-spec';
import { exportSpecToPlaywright } from './spec-playwright.js';
import { exportSpecToMaestro } from './spec-maestro.js';
import {
  collectPlaywrightWarnings,
  collectMaestroWarnings,
  type ExportWarning,
} from './spec-export-warnings.js';

// `yaml` and `typescript` are transitive deps (via @validity.ai/verify-spec) — not direct
// deps of this package — so Vite can't resolve a bare import. Anchor a CJS
// `require` at core's installed entry, which CAN see them, to load them at runtime.
const requireFromCore = createRequire(
  fileURLToPath(new URL('../../node_modules/@validity.ai/verify-spec/dist/index.js', import.meta.url)),
);
const { parseAllDocuments } = requireFromCore('yaml') as typeof import('yaml');
const ts = requireFromCore('typescript') as typeof import('typescript');

/** A frozen contact-form spec used as the export fixture. */
function makeContactSpec(overrides?: Partial<Spec>): Spec {
  return {
    id: 'spec-7f3a',
    version: 3,
    status: 'frozen',
    hash: 'sha256-deadbeef',
    source: {
      prompt: 'User can submit the contact form and it posts to /api/contact',
      createdBy: 'agent',
    },
    runtime: 'web',
    criteria: [
      {
        id: 'AC-1',
        text: 'User can submit the contact form',
        tier: 'hard',
        mocking: 'required',
        checks: [
          { navigate: { url: '/contact' } },
          { fill: { role: 'textbox', name: 'Email', value: 'a@b.com' } },
          { click: { role: 'button', name: 'Send' } },
          { expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } } },
          { expect: { console: { errors: 0 } } },
          { expect: { element: { role: 'alert', name: 'Thanks!', state: 'visible' } } },
        ],
      },
      {
        id: 'AC-2',
        text: 'Form looks polished and on-brand',
        tier: 'soft',
      },
    ],
    conditions: {
      viewports: [375, 1280],
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeConfig(): ValidityConfig {
  return {
    renderMode: 'web',
    framework: 'auto',
    wrapper: './.validity/wrapper.gen.tsx',
    mockNetwork: {
      handlers: [
        { url: '/api/contact', method: 'POST', status: 201, json: { ok: true } },
        { url: '/api/me', method: 'GET', json: { id: '1', name: 'Ada' } },
      ],
    },
  };
}

describe('exportSpecToPlaywright', () => {
  it('compiles hard checks into real Playwright assertions', () => {
    const { files } = exportSpecToPlaywright({
      spec: makeContactSpec(),
      config: makeConfig(),
      baseUrl: 'http://localhost:3000',
    });

    const spec = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts');
    expect(spec).toBeDefined();
    const src = spec!.contents;

    // click → getByRole(...).click()
    expect(src).toContain(`page.getByRole("button", { name: "Send" }).click()`);
    // fill → getByRole(...).fill('a@b.com')
    expect(src).toContain('.fill(');
    expect(src).toContain(`page.getByRole("textbox", { name: "Email" }).fill("a@b.com")`);
    // navigate → goto joined onto baseUrl
    expect(src).toContain(`await page.goto("http://localhost:3000/contact")`);
    // network expect → waitForResponse
    expect(src).toContain('waitForResponse');
    expect(src).toContain('/api/contact');
    // console expect → collector + budget assertion
    expect(src).toContain('consoleErrors');
    expect(src).toContain('toBeLessThanOrEqual(0)');
    // element expect → toBeVisible
    expect(src).toContain('toBeVisible()');
    // status-class helper present for the 2xx matcher
    expect(src).toContain('statusClass');

    // soft criterion → test.fixme stub
    expect(src).toContain('test.fixme(');
    expect(src).toContain('AC-2');
    expect(src).toContain('soft — review visually');

    // header + content hash
    expect(src).toContain('// GENERATED from spec-7f3a@v3 (sha256-deadbeef) — DO NOT EDIT;');
    expect(src).toContain('// regenerate with `validity spec export spec-7f3a`.');

    expect(src).toContain(`import { test, expect } from '@playwright/test';`);
  });

  it('emits one describe per viewport', () => {
    const { files } = exportSpecToPlaywright({
      spec: makeContactSpec(),
      config: makeConfig(),
      baseUrl: 'http://localhost:3000',
    });
    const src = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;

    const describeCount = (src.match(/test\.describe\(/g) ?? []).length;
    expect(describeCount).toBe(2);
    expect(src).toContain('spec-7f3a @ 375w');
    expect(src).toContain('spec-7f3a @ 1280w');
    expect(src).toContain('width: 375');
    expect(src).toContain('width: 1280');
  });

  it('emits a fixtures file and imports installMocks when mocking is required', () => {
    const { files } = exportSpecToPlaywright({
      spec: makeContactSpec(),
      config: makeConfig(),
      baseUrl: 'http://localhost:3000',
    });

    const fixtures = files.find((f) => f.path === 'spec-7f3a.v3.fixtures.ts');
    expect(fixtures).toBeDefined();
    expect(fixtures!.contents).toContain('export async function installMocks(page: Page)');
    expect(fixtures!.contents).toContain('page.route(');
    expect(fixtures!.contents).toContain('/api/contact');

    const spec = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;
    expect(spec).toContain(`import { installMocks } from './spec-7f3a.v3.fixtures';`);
    expect(spec).toContain('await installMocks(page);');
  });

  it('omits fixtures when no criterion requires mocking', () => {
    const spec = makeContactSpec();
    spec.criteria[0]!.mocking = 'none';
    const { files } = exportSpecToPlaywright({ spec, config: makeConfig() });
    expect(files.find((f) => f.path === 'spec-7f3a.v3.fixtures.ts')).toBeUndefined();
    const src = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;
    expect(src).not.toContain('installMocks');
  });

  it('falls back to a single describe and a baseURL TODO without viewports/baseUrl', () => {
    const spec = makeContactSpec({ conditions: undefined });
    const { files } = exportSpecToPlaywright({ spec, config: makeConfig() });
    const src = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;
    const describeCount = (src.match(/test\.describe\(/g) ?? []).length;
    expect(describeCount).toBe(1);
    expect(src).toContain('TODO: set baseURL');
    // relative navigate retained when no baseUrl is configured
    expect(src).toContain(`await page.goto("/contact")`);
  });

  it('FIX 9: registers waitForResponse BEFORE the triggering click (no race)', () => {
    const { files } = exportSpecToPlaywright({
      spec: makeContactSpec(),
      config: makeConfig(),
      baseUrl: 'http://localhost:3000',
    });
    const src = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;

    // The hoisted, un-awaited listener must appear in source order before the click.
    const listenerIdx = src.indexOf('= page.waitForResponse(');
    const clickIdx = src.indexOf('{ name: "Send" }).click()');
    expect(listenerIdx).toBeGreaterThanOrEqual(0);
    expect(clickIdx).toBeGreaterThanOrEqual(0);
    expect(listenerIdx).toBeLessThan(clickIdx);

    // It is hoisted (assigned to a promise var), not awaited inline.
    expect(src).toContain('const resp1 = page.waitForResponse(');
    // …then awaited at the expect position and asserted.
    expect(src).toContain('const resp1Resp = await resp1;');
    expect(src).toContain('expect(statusClass(resp1Resp.status())).toBe("2xx");');
  });

  it('FIX 9: the generated spec is syntactically valid TypeScript', () => {
    const { files } = exportSpecToPlaywright({
      spec: makeContactSpec(),
      config: makeConfig(),
      baseUrl: 'http://localhost:3000',
    });
    for (const f of files.filter((x) => x.path.endsWith('.ts'))) {
      const out = ts.transpileModule(f.contents, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
        reportDiagnostics: true,
      });
      const syntactic = (out.diagnostics ?? []).filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      );
      const msgs = syntactic.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      expect(msgs).toEqual([]);
    }
  });

  it('FIX 9: numbers per-criterion so multiple network expects do not collide', () => {
    const spec = makeContactSpec({
      criteria: [
        {
          id: 'AC-1',
          text: 'two posts',
          tier: 'hard',
          mocking: 'none',
          checks: [
            { click: { role: 'button', name: 'One' } },
            { expect: { network: { method: 'POST', url: '/api/one', status: '2xx' } } },
            { click: { role: 'button', name: 'Two' } },
            { expect: { network: { method: 'POST', url: '/api/two', status: 201 } } },
          ],
        },
      ],
      conditions: undefined,
    });
    const { files } = exportSpecToPlaywright({ spec, config: makeConfig() });
    const src = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;
    expect(src).toContain('const resp1 = page.waitForResponse(');
    expect(src).toContain('const resp2 = page.waitForResponse(');
    expect(src).toContain('const resp1Resp = await resp1;');
    expect(src).toContain('const resp2Resp = await resp2;');
    // Still valid TypeScript with two listeners in one block.
    const out = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
      reportDiagnostics: true,
    });
    const errs = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    expect(errs).toEqual([]);
  });

  it('FIX 11: warns when mocking is required but no handlers were configured', () => {
    const spec = makeContactSpec();
    // config WITHOUT mockNetwork handlers → no fixtures file is emitted.
    const { files } = exportSpecToPlaywright({
      spec,
      config: { renderMode: 'web', framework: 'auto', wrapper: './.validity/wrapper.gen.tsx' },
    });
    expect(files.find((f) => f.path === 'spec-7f3a.v3.fixtures.ts')).toBeUndefined();
    const src = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;
    expect(src).toContain(
      '// TODO: mocking: required, but no mockNetwork handlers were configured',
    );
    expect(src).not.toContain('installMocks');
  });

  it('produces balanced braces / parens (no obvious syntax breakage)', () => {
    const { files } = exportSpecToPlaywright({
      spec: makeContactSpec(),
      config: makeConfig(),
      baseUrl: 'http://localhost:3000',
    });
    for (const f of files) {
      // Count braces/parens ignoring those inside string literals would be
      // ideal, but a coarse balance check still catches gross codegen bugs.
      const opens = (f.contents.match(/\{/g) ?? []).length;
      const closes = (f.contents.match(/\}/g) ?? []).length;
      expect(opens).toBe(closes);
      const popen = (f.contents.match(/\(/g) ?? []).length;
      const pclose = (f.contents.match(/\)/g) ?? []).length;
      expect(popen).toBe(pclose);
    }
  });
});

describe('expect.performance export (web-sandbox-only signal degrades honestly)', () => {
  function perfSpec(): Spec {
    return makeContactSpec({
      criteria: [
        {
          id: 'AC-perf',
          text: 'renders within 1s',
          tier: 'hard',
          checks: [{ expect: { performance: { metric: 'ready', maxMs: 1000 } } }],
        },
      ],
      conditions: undefined,
    });
  }

  it('Playwright emits an honest TODO (no green assertion that proves nothing)', () => {
    const { files } = exportSpecToPlaywright({ spec: perfSpec(), config: makeConfig() });
    const src = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;
    expect(src).toContain('TODO (perf): budget "ready <= 1000ms"');
    expect(src).not.toContain('toBeLessThan(');
  });

  it('Maestro emits a lossy TODO', () => {
    const { files } = exportSpecToMaestro({ spec: perfSpec() });
    const y = files[0]!.contents;
    expect(y).toContain("# TODO (lossy): Maestro can't measure performance");
    expect(y).toContain('ready <= 1000ms');
  });
});

describe('expect.command export (run-level check degrades honestly — A5)', () => {
  function commandSpec(): Spec {
    return makeContactSpec({
      criteria: [
        {
          id: 'AC-typecheck',
          text: 'repo typechecks',
          tier: 'property',
          checks: [{ expect: { command: { run: 'typecheck', exitCode: 0 } } }],
        },
      ],
      conditions: undefined,
    });
  }

  it('Playwright emits an honest run-level TODO (never a green assertion)', () => {
    const { files } = exportSpecToPlaywright({ spec: commandSpec(), config: makeConfig() });
    const src = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;
    expect(src).toContain("TODO (run-level): Validity runs the named command 'typecheck'");
    expect(src).toContain('separate CI step');
    // No shell execution smuggled into the browser test.
    expect(src).not.toContain('child_process');
  });

  it('Maestro emits a lossy TODO', () => {
    const { files } = exportSpecToMaestro({ spec: commandSpec() });
    const y = files[0]!.contents;
    expect(y).toContain("# TODO (lossy): Maestro can't run repo commands");
    expect(y).toContain("'typecheck'");
  });

  it('both warning collectors fire a wont-run warning per command criterion', () => {
    const pw = collectPlaywrightWarnings({
      spec: commandSpec(),
      hasFixtures: true,
      hasBaseUrl: true,
    });
    const pwWarning = pw.find((w) => w.scope === 'AC-typecheck (expect.command)');
    expect(pwWarning?.severity).toBe('wont-run');
    expect(pwWarning?.message).toContain('own CI step');

    const maestro = collectMaestroWarnings({ spec: commandSpec(), hasAppId: true });
    const mWarning = maestro.find((w) => w.scope === 'AC-typecheck (expect.command)');
    expect(mWarning?.severity).toBe('wont-run');
    expect(mWarning?.message).toContain("can't run repo commands");
  });
});

describe('press / hover / focused export (keyboard-focus-hover verbs)', () => {
  function kbdSpec(): Spec {
    return makeContactSpec({
      criteria: [
        {
          id: 'AC-kbd',
          text: 'Tab moves focus to Save and the toolbar reveals on hover',
          tier: 'hard',
          checks: [
            { press: 'Tab' },
            { press: { key: 'Shift+Tab', times: 2 } },
            { hover: { role: 'button', name: 'Save' } },
            { expect: { element: { role: 'button', name: 'Save', state: 'focused' } } },
          ],
        },
      ],
      conditions: undefined,
    });
  }

  it('Playwright emits real keyboard.press / .hover() / toBeFocused() (nothing lossy)', () => {
    const { files } = exportSpecToPlaywright({ spec: kbdSpec(), config: makeConfig() });
    const src = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;
    // press → page.keyboard.press('key'); a `times` press repeats the line.
    expect(src).toContain(`await page.keyboard.press("Tab");`);
    expect(src.match(/await page\.keyboard\.press\("Shift\+Tab"\);/g)?.length).toBe(2);
    // hover → getByRole(...).hover()
    expect(src).toContain(`page.getByRole("button", { name: "Save" }).hover();`);
    // focused → toBeFocused()
    expect(src).toContain(`.toBeFocused();`);
    // No honest-degradation TODO — these are all portable to a real Playwright run.
    expect(src).not.toContain('TODO (lossy)');
  });

  it('the generated keyboard spec is syntactically valid TypeScript', () => {
    const { files } = exportSpecToPlaywright({
      spec: kbdSpec(),
      config: makeConfig(),
      baseUrl: 'http://localhost:3000',
    });
    for (const f of files.filter((x) => x.path.endsWith('.ts'))) {
      const out = ts.transpileModule(f.contents, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
        reportDiagnostics: true,
      });
      const errs = (out.diagnostics ?? []).filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      );
      expect(errs.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    }
  });

  it('Maestro degrades press + hover to lossy TODOs and focus to assertVisible + TODO', () => {
    const { files } = exportSpecToMaestro({ spec: kbdSpec() });
    const y = files[0]!.contents;
    expect(y).toContain('# TODO (lossy): Maestro has no hardware-keyboard press');
    expect(y).toContain("key 'Tab'");
    expect(y).toContain("key 'Shift+Tab' ×2");
    expect(y).toContain('# TODO (lossy): Maestro has no hover');
    // focused element expect degrades to assertVisible + an inline lossy TODO.
    expect(y).toContain('- assertVisible:');
    expect(y).toContain('# TODO (lossy): Maestro can\'t directly assert "focused"');
  });

  it('the Maestro flow stays valid YAML with the new degradations', () => {
    const { files } = exportSpecToMaestro({ spec: kbdSpec(), appId: 'com.x' });
    const docs = parseAllDocuments(files[0]!.contents);
    for (const d of docs) expect(d.errors).toEqual([]);
  });

  it('Playwright fires NO wont-run warning for press/hover/focused (all portable)', () => {
    const warnings = collectPlaywrightWarnings({
      spec: kbdSpec(),
      hasFixtures: false,
      hasBaseUrl: true,
    });
    // The keyboard/hover/focus verbs export faithfully — no degradation warnings
    // scoped to them (the selectors here are durable role/name, so no name-fallback).
    expect(warnings.filter((w) => w.scope.startsWith('AC-kbd'))).toEqual([]);
  });

  it('Maestro warns wont-run per press + hover and degraded for the focused state', () => {
    const warnings = collectMaestroWarnings({ spec: kbdSpec(), hasAppId: true });
    const press = warnings.find((w) => w.scope === 'AC-kbd (press)');
    expect(press?.severity).toBe('wont-run');
    expect(press?.message).toContain('hardware-keyboard press');
    const hover = warnings.find((w) => w.scope === 'AC-kbd (hover)');
    expect(hover?.severity).toBe('wont-run');
    expect(hover?.message).toContain('no hover');
    const focus = warnings.find((w) => w.scope === "AC-kbd (expect.element state: 'focused')");
    expect(focus?.severity).toBe('degraded');
  });

  it('a name-only hover selector still trips the Playwright name-fallback warning', () => {
    const spec = makeContactSpec({
      criteria: [
        {
          id: 'AC-hoveronly',
          text: 'hovering the icon reveals the tooltip',
          tier: 'hard',
          checks: [{ hover: { name: 'Info' } }],
        },
      ],
      conditions: undefined,
    });
    const warnings = collectPlaywrightWarnings({ spec, hasFixtures: false, hasBaseUrl: true });
    expect(
      warnings.find((w) => w.scope === 'AC-hoveronly (accessible-name fallback)'),
    ).toBeDefined();
    // …and its Maestro export degrades the whole hover to a wont-run TODO (not a
    // misleading role-only warning — a name/testId wouldn't let Maestro hover).
    const m = collectMaestroWarnings({ spec, hasAppId: true });
    expect(m.find((w) => w.scope === 'AC-hoveronly (hover)')?.severity).toBe('wont-run');
    expect(m.find((w) => w.scope.includes('role-only'))).toBeUndefined();
  });
});

describe('wait / waitForRequest / select / scroll export', () => {
  function verbsSpec(): Spec {
    return makeContactSpec({
      criteria: [
        {
          id: 'AC-verbs',
          text: 'wait, select, scroll, wait for a request',
          tier: 'hard',
          checks: [
            { wait: { ms: 200 } },
            { wait: { for: { text: 'Ready' }, state: 'visible' } },
            { waitForRequest: { url: '/api/boot', method: 'GET' } },
            { select: { selector: { label: 'Country' }, option: 'US' } },
            { scroll: { to: 'bottom' } },
            { scroll: { selector: { text: 'Footer' }, intoView: true } },
            { press: { key: 'Enter', selector: { label: 'Email' } } },
          ],
        },
      ],
      conditions: undefined,
    });
  }

  it('Playwright emits real waitForTimeout / waitFor / waitForRequest / selectOption / scroll / locator.press', () => {
    const { files } = exportSpecToPlaywright({ spec: verbsSpec(), config: makeConfig() });
    const src = files.find((f) => f.path.endsWith('.spec.ts'))!.contents;
    expect(src).toContain('await page.waitForTimeout(200);');
    expect(src).toContain('.waitFor({ state: "visible" })');
    expect(src).toContain(
      'await page.waitForRequest((r) => r.url().includes("/api/boot") && r.method() === "GET");',
    );
    expect(src).toContain('.selectOption("US")');
    expect(src).toContain('window.scrollTo(0, document.documentElement.scrollHeight)');
    expect(src).toContain('.scrollIntoViewIfNeeded()');
    expect(src).toContain('.press("Enter")');
    expect(src).not.toContain('TODO (lossy)');
  });

  it('the generated verbs spec is syntactically valid TypeScript', () => {
    const { files } = exportSpecToPlaywright({
      spec: verbsSpec(),
      config: makeConfig(),
      baseUrl: 'http://localhost:3000',
    });
    for (const f of files.filter((x) => x.path.endsWith('.ts'))) {
      const out = ts.transpileModule(f.contents, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
        reportDiagnostics: true,
      });
      const errs = (out.diagnostics ?? []).filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      );
      expect(errs.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    }
  });

  it('Maestro maps wait.for + scroll-to-bottom + intoView, degrades the rest', () => {
    const { files } = exportSpecToMaestro({ spec: verbsSpec() });
    const y = files[0]!.contents;
    expect(y).toContain('- extendedWaitUntil:');
    expect(y).toContain('visible: "Ready"');
    expect(y).toContain('- scroll');
    expect(y).toContain('- scrollUntilVisible:');
    expect(y).toContain('element: "Footer"');
    expect(y).toContain('# TODO (lossy): Maestro has no sleep');
    expect(y).toContain("# TODO (lossy): Maestro can't observe network");
    expect(y).toContain('# TODO (lossy): Maestro has no selectOption');
    expect(y).toContain('# TODO (lossy): Maestro has no hardware-keyboard press');
  });

  it('Playwright fires no wont-run warning for the new verbs', () => {
    const warnings = collectPlaywrightWarnings({
      spec: verbsSpec(),
      hasFixtures: false,
      hasBaseUrl: true,
    });
    expect(
      warnings.filter((w) => w.scope.startsWith('AC-verbs') && w.severity === 'wont-run'),
    ).toEqual([]);
  });

  it('Maestro warns wont-run for wait.ms, waitForRequest, select, and press', () => {
    const warnings = collectMaestroWarnings({ spec: verbsSpec(), hasAppId: true });
    expect(warnings.find((w) => w.scope === 'AC-verbs (wait.ms)')?.severity).toBe('wont-run');
    expect(warnings.find((w) => w.scope === 'AC-verbs (waitForRequest)')?.severity).toBe(
      'wont-run',
    );
    expect(warnings.find((w) => w.scope === 'AC-verbs (select)')?.severity).toBe('wont-run');
    expect(warnings.find((w) => w.scope === 'AC-verbs (press)')?.severity).toBe('wont-run');
    // Real mappings: wait.for text, intoView text — no warning. scroll-to-bottom
    // is a real `- scroll` step but only one page-down → degraded.
    expect(warnings.find((w) => w.scope === 'AC-verbs (wait.for)')).toBeUndefined();
    expect(warnings.find((w) => w.scope === 'AC-verbs (scroll to: bottom)')?.severity).toBe(
      'degraded',
    );
  });

  it('Playwright waitForRequest with a /regex/ url emits RegExp.test, not includes', () => {
    const spec = makeContactSpec({
      criteria: [
        {
          id: 'AC-re',
          text: 'wait for the save request',
          tier: 'hard',
          checks: [{ waitForRequest: { url: '/foo.*/' } }],
        },
      ],
      conditions: undefined,
    });
    const { files } = exportSpecToPlaywright({ spec, config: makeConfig() });
    const src = files.find((f) => f.path.endsWith('.spec.ts'))!.contents;
    expect(src).toContain('new RegExp(');
    expect(src).toContain('.test(r.url())');
    expect(src).not.toContain('r.url().includes("/^');
  });
});

describe('exportSpecToMaestro', () => {
  it('emits tapOn / inputText / assertVisible and lossy network/console TODOs', () => {
    const { files } = exportSpecToMaestro({ spec: makeContactSpec() });
    expect(files).toHaveLength(1);
    const flow = files[0]!;
    expect(flow.path).toBe('spec-7f3a.v3.flow.yaml');
    const y = flow.contents;

    // click → tapOn
    expect(y).toContain('- tapOn:');
    expect(y).toContain('text: "Send"');
    // fill → tapOn + inputText
    expect(y).toContain('- inputText: "a@b.com"');
    // element expect → assertVisible
    expect(y).toContain('- assertVisible:');
    // network expect → lossy TODO
    expect(y).toContain("# TODO (lossy): Maestro can't assert network");
    // console expect → lossy TODO
    expect(y).toContain("# TODO (lossy): Maestro can't assert the JS console");
    // soft criterion → comment stub, not a step
    expect(y).toContain('soft — LLM-scored');
    // header + hash
    expect(y).toContain('# GENERATED from spec-7f3a@v3 (sha256-deadbeef) — DO NOT EDIT;');
    expect(y).toContain('# regenerate with `validity spec export spec-7f3a`.');

    expect(y).toContain('# LOSSY MAPPING');
    expect(y).toContain('- launchApp');
  });

  it('maps testId selectors to Maestro id and count:0 to assertNotVisible', () => {
    const spec = makeContactSpec();
    spec.criteria = [
      {
        id: 'AC-1',
        text: 'gated content hidden',
        tier: 'hard',
        checks: [
          { click: { testId: 'menu-btn' } },
          { expect: { element: { text: 'Secret', count: 0 } } },
        ],
      },
    ];
    const { files } = exportSpecToMaestro({ spec });
    const y = files[0]!.contents;
    expect(y).toContain('id: "menu-btn"');
    expect(y).toContain('- assertNotVisible:');
  });

  it('FIX 10: role-only selector degrades to a TODO comment, not an empty matcher', () => {
    const spec = makeContactSpec();
    spec.criteria = [
      {
        id: 'AC-1',
        text: 'role-only selectors',
        tier: 'hard',
        checks: [
          { click: { role: 'button' } },
          { expect: { element: { role: 'alert', state: 'visible' } } },
        ],
      },
    ];
    // Disable the launch preamble so its overlay-dismissing `- tapOn:` guards
    // don't mask the point of this test: the CRITERION emits no step.
    const { files } = exportSpecToMaestro({
      spec,
      maestro: { clearState: false, dismissDevOverlays: false },
    });
    const y = files[0]!.contents;
    // No empty matcher emitted.
    expect(y).not.toContain('text: ""');
    // Honest-degradation comments naming the role instead.
    expect(y).toContain('# TODO (lossy): Maestro has no role matcher for role=button');
    expect(y).toContain('# TODO (lossy): Maestro has no role matcher for role=alert');
    // No tapOn/assertVisible step was emitted for the matcher-less selectors.
    expect(y).not.toContain('- tapOn:');
    expect(y).not.toContain('- assertVisible:');
  });

  it('FIX 8: every emitted Maestro flow is valid YAML', () => {
    const specs: Spec[] = [
      // The canonical contact spec (navigate/fill/click/network/console/element + soft).
      makeContactSpec(),
      // testId + count:0 (assertNotVisible) + screenshot.
      makeContactSpec({
        criteria: [
          {
            id: 'AC-1',
            text: 'menu',
            tier: 'hard',
            checks: [
              { click: { testId: 'menu-btn' } },
              { expect: { element: { text: 'Secret', count: 0 } } },
              { expect: { element: { testId: 'list', count: 3, state: 'visible' } } },
              { expect: { screenshot: { name: 'after: open' } } },
            ],
          },
        ],
        conditions: undefined,
      }),
      // Role-only selectors (FIX 10 degradation path) — must still parse.
      makeContactSpec({
        criteria: [
          {
            id: 'AC-1',
            text: 'role only',
            tier: 'hard',
            checks: [
              { click: { role: 'button' } },
              { expect: { element: { role: 'alert', state: 'visible' } } },
            ],
          },
        ],
        conditions: undefined,
      }),
      // A value with YAML-hostile characters (colon, quote) to exercise quoting.
      makeContactSpec({
        criteria: [
          {
            id: 'AC-1',
            text: 'tricky text',
            tier: 'hard',
            checks: [
              { fill: { label: 'Note:', value: 'a: "b" #c' } },
              { expect: { element: { state: 'disabled', text: 'Save: now' } } },
            ],
          },
        ],
        conditions: undefined,
      }),
    ];

    for (const spec of specs) {
      const { files } = exportSpecToMaestro({ spec });
      const contents = files[0]!.contents;
      const docs = parseAllDocuments(contents);
      const errors = docs.flatMap((d) => d.errors);
      expect(errors.map((e) => e.message)).toEqual([]);
    }
  });
});

describe('exportSpecToMaestro — v2 (dedup, routes, launch preamble, build type)', () => {
  it('A2: dedups byte-identical assertVisible steps, naming the dropped role', () => {
    // The §A2 case: role: header + role: button, same name — Maestro has no
    // role matcher, so both compile to the same assertVisible. One survives.
    const spec = makeContactSpec({
      runtime: 'native',
      criteria: [
        {
          id: 'AC-4',
          text: 'the Log In heading and button are present',
          tier: 'hard',
          checks: [
            { expect: { element: { role: 'header', name: 'Log In', state: 'visible' } } },
            { expect: { element: { role: 'button', name: 'Log In', state: 'visible' } } },
          ],
        },
      ],
      conditions: undefined,
    });
    const y = exportSpecToMaestro({ spec, appId: 'com.x' }).files[0]!.contents;
    // Exactly ONE assertVisible (the second collapses to a comment).
    expect((y.match(/- assertVisible:/g) ?? []).length).toBe(1);
    expect((y.match(/^ {4}text: "Log In"$/gm) ?? []).length).toBe(1);
    // …and the collapse is explained, naming the role that was dropped.
    expect(y).toContain('# (duplicate skipped:');
    expect(y).toContain('no role matcher');
  });

  describe('B2: navigate route preambles (export.maestro.routes)', () => {
    function navSpec(): Spec {
      return makeContactSpec({
        runtime: 'native',
        criteria: [
          {
            id: 'AC-1',
            text: 'the welcome screen shows the tagline',
            tier: 'hard',
            checks: [
              { navigate: { url: '/welcome' } },
              { expect: { element: { text: 'Almost ready', state: 'visible' } } },
            ],
          },
        ],
        conditions: undefined,
      });
    }

    it('a deep-link string route compiles to openLink and warns nothing for that navigate', () => {
      const { files, warnings } = exportSpecToMaestro({
        spec: navSpec(),
        appId: 'com.x',
        maestro: { routes: { '/welcome': 'myapp://welcome' } },
      });
      const y = files[0]!.contents;
      expect(y).toContain('- openLink: "myapp://welcome"');
      // Real steps, not the TODO comment.
      expect(y).not.toContain('# (navigate) target route:');
      expect(warnings.find((w) => w.scope.startsWith('AC-1 (navigate'))).toBeUndefined();
    });

    it('a tapOn step array compiles to text + id tap steps', () => {
      const y = exportSpecToMaestro({
        spec: navSpec(),
        appId: 'com.x',
        maestro: { routes: { '/welcome': [{ tapOn: 'Get started' }, { tapOnId: 'welcome-tab' }] } },
      }).files[0]!.contents;
      expect(y).toContain('- tapOn:');
      expect(y).toContain('text: "Get started"');
      expect(y).toContain('id: "welcome-tab"');
    });

    it('an unmapped navigate degrades to a TODO comment AND a needs-setup warning', () => {
      const { files, warnings } = exportSpecToMaestro({ spec: navSpec(), appId: 'com.x' });
      const y = files[0]!.contents;
      expect(y).toContain('# (navigate) target route: /welcome');
      expect(y).toContain('export.maestro.routes');
      const w = warnings.find((x) => x.scope === 'AC-1 (navigate /welcome)');
      expect(w).toBeDefined();
      expect(w!.severity).toBe('needs-setup');
    });

    it('parity: the warning fires IFF the flow degraded (mapped ⇒ no warn, unmapped ⇒ warn)', () => {
      const mapped = collectMaestroWarnings({
        spec: navSpec(),
        hasAppId: true,
        maestro: { routes: { '/welcome': 'myapp://welcome' } },
      });
      expect(scopes(mapped)).not.toContain('AC-1 (navigate /welcome)');

      const unmapped = collectMaestroWarnings({ spec: navSpec(), hasAppId: true });
      expect(scopes(unmapped)).toContain('AC-1 (navigate /welcome)');
    });
  });

  describe('B1/B3: launch preamble + build-type header', () => {
    it('default preamble clears state and guards the three dev-build overlays', () => {
      const y = exportSpecToMaestro({ spec: makeContactSpec(), appId: 'com.x' }).files[0]!.contents;
      expect(y).toContain('- launchApp:');
      expect(y).toContain('clearState: true');
      expect((y.match(/- runFlow:/g) ?? []).length).toBe(3);
      expect(y).toContain('visible: "Wait"');
      expect(y).toContain('visible: "Continue"');
      expect(y).toContain('visible: "Reload"');
    });

    it('clearState:false + dismissDevOverlays:false → bare launchApp, no guards', () => {
      const y = exportSpecToMaestro({
        spec: makeContactSpec(),
        appId: 'com.x',
        maestro: { clearState: false, dismissDevOverlays: false },
      }).files[0]!.contents;
      // Bare `- launchApp` (immediately followed by a newline — no clearState body).
      expect(y).toContain('- launchApp\n');
      expect(y).not.toContain('clearState: true');
      expect(y).not.toContain('- runFlow:');
    });

    it('header carries BUILD TYPE guidance (release/preview build)', () => {
      const y = exportSpecToMaestro({ spec: makeContactSpec(), appId: 'com.x' }).files[0]!.contents;
      expect(y).toContain('# BUILD TYPE:');
      expect(y).toContain('release/preview build');
    });
  });
});

describe('F5: Maestro dedup collapses ONLY consecutive identical assertions', () => {
  // Disable the launch preamble so its overlay `- tapOn:` guards don't skew the
  // per-criterion step counts.
  const bare: MaestroExportConfig = { clearState: false, dismissDevOverlays: false };
  function nativeCrit(checks: SpecCriterion['checks']): Spec {
    return makeContactSpec({
      runtime: 'native',
      criteria: [{ id: 'AC-1', text: 'one', tier: 'hard', mocking: 'none', checks }],
      conditions: undefined,
    });
  }
  const flow = (checks: SpecCriterion['checks']): string =>
    exportSpecToMaestro({ spec: nativeCrit(checks), appId: 'com.x', maestro: bare }).files[0]!
      .contents;

  it('(1) two identical clicks emit TWO taps — actions are never deduped', () => {
    const y = flow([{ click: { name: 'Increment' } }, { click: { name: 'Increment' } }]);
    expect((y.match(/- tapOn:/g) ?? []).length).toBe(2);
    expect(y).not.toContain('duplicate skipped');
  });

  it('(2) role header/button same name → ONE assert + a skip comment', () => {
    const y = flow([
      { expect: { element: { role: 'header', name: 'Log In', state: 'visible' } } },
      { expect: { element: { role: 'button', name: 'Log In', state: 'visible' } } },
    ]);
    expect((y.match(/- assertVisible:/g) ?? []).length).toBe(1);
    expect(y).toContain('# (duplicate skipped:');
    expect(y).toContain('no role matcher');
  });

  it('(3) assert X → tap Y → assert X keeps BOTH asserts (not criterion-global)', () => {
    const y = flow([
      { expect: { element: { text: 'Total: 1', state: 'visible' } } },
      { click: { name: 'Increment' } },
      { expect: { element: { text: 'Total: 1', state: 'visible' } } },
    ]);
    expect((y.match(/- assertVisible:/g) ?? []).length).toBe(2);
    expect(y).not.toContain('duplicate skipped');
  });

  it('(4) two takeScreenshot steps are both kept — screenshots are actions', () => {
    const y = flow([
      { expect: { screenshot: { name: 'first' } } },
      { expect: { screenshot: { name: 'first' } } },
    ]);
    expect((y.match(/- takeScreenshot:/g) ?? []).length).toBe(2);
    expect(y).not.toContain('duplicate skipped');
  });
});

/* ------------------------------------------------------------------ *
 * Export warnings (Item 5) — advisory strings that must fire on every  *
 * real degradation and never cry wolf on a fully-supported spec.       *
 * ------------------------------------------------------------------ */

/** A spec whose single hard criterion maps cleanly to both targets. */
function makeFullySupportedSpec(): Spec {
  return makeContactSpec({
    criteria: [
      {
        id: 'AC-1',
        text: 'submit posts to the API',
        tier: 'hard',
        mocking: 'none',
        checks: [
          { navigate: { url: '/contact' } },
          { fill: { role: 'textbox', name: 'Email', value: 'a@b.com' } },
          { click: { role: 'button', name: 'Send' } },
          { expect: { element: { role: 'alert', name: 'Thanks!', state: 'visible' } } },
        ],
      },
    ],
    conditions: undefined,
  });
}

function scopes(warnings: ExportWarning[]): string[] {
  return warnings.map((w) => w.scope);
}

describe('collectPlaywrightWarnings', () => {
  it('warns on a soft criterion (test.fixme is not a real assertion)', () => {
    const warnings = collectPlaywrightWarnings({
      spec: makeContactSpec(),
      hasFixtures: true,
      hasBaseUrl: true,
    });
    const soft = warnings.find((w) => w.scope === 'AC-2 (soft)');
    expect(soft).toBeDefined();
    expect(soft!.severity).toBe('wont-run');
    expect(soft!.message).toContain('test.fixme');
  });

  it('warns when mocking:required but no fixtures were emitted', () => {
    const warnings = collectPlaywrightWarnings({
      spec: makeContactSpec(),
      hasFixtures: false,
      hasBaseUrl: true,
    });
    const w = warnings.find((x) => x.scope === 'AC-1 (mocking: required)');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('needs-setup');
    expect(w!.message).toContain('real backend');
  });

  it('NEGATIVE: mocking:required WITH fixtures emits no mocking warning', () => {
    const warnings = collectPlaywrightWarnings({
      spec: makeContactSpec(),
      hasFixtures: true,
      hasBaseUrl: true,
    });
    expect(scopes(warnings)).not.toContain('AC-1 (mocking: required)');
  });

  it('warns (degraded) on expect.screenshot — needs a committed baseline', () => {
    const spec = makeContactSpec({
      criteria: [
        {
          id: 'AC-1',
          text: 'looks right',
          tier: 'hard',
          mocking: 'none',
          checks: [{ expect: { screenshot: { name: 'home' } } }],
        },
      ],
      conditions: undefined,
    });
    const warnings = collectPlaywrightWarnings({ spec, hasFixtures: true, hasBaseUrl: true });
    const w = warnings.find((x) => x.scope === 'AC-1 (expect.screenshot)');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('degraded');
    expect(w!.message).toContain('baseline');
  });

  it('warns when no baseURL is set AND the spec navigates', () => {
    const warnings = collectPlaywrightWarnings({
      spec: makeContactSpec(),
      hasFixtures: true,
      hasBaseUrl: false,
    });
    const w = warnings.find((x) => x.scope === 'navigate');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('needs-setup');
    expect(w!.message).toContain('baseURL');
  });

  it('does NOT warn about baseURL when the spec has no navigate check', () => {
    const spec = makeContactSpec({
      criteria: [
        {
          id: 'AC-1',
          text: 'no navigation',
          tier: 'hard',
          mocking: 'none',
          checks: [{ expect: { element: { role: 'button', name: 'Send', state: 'visible' } } }],
        },
      ],
      conditions: undefined,
    });
    const warnings = collectPlaywrightWarnings({ spec, hasFixtures: true, hasBaseUrl: false });
    expect(scopes(warnings)).not.toContain('navigate');
  });

  it('NEGATIVE (no cry-wolf): a fully-supported spec yields zero warnings', () => {
    const warnings = collectPlaywrightWarnings({
      spec: makeFullySupportedSpec(),
      hasFixtures: true,
      hasBaseUrl: true,
    });
    expect(warnings).toEqual([]);
  });

  it('severity vocabulary: soft→wont-run, screenshot→degraded (no swap)', () => {
    const spec = makeContactSpec({
      criteria: [
        { id: 'AC-1', text: 'polish', tier: 'soft' },
        {
          id: 'AC-2',
          text: 'looks right',
          tier: 'hard',
          mocking: 'none',
          checks: [{ expect: { screenshot: { name: 'home' } } }],
        },
      ],
      conditions: undefined,
    });
    const warnings = collectPlaywrightWarnings({ spec, hasFixtures: true, hasBaseUrl: true });
    expect(warnings.find((w) => w.scope === 'AC-1 (soft)')!.severity).toBe('wont-run');
    expect(warnings.find((w) => w.scope === 'AC-2 (expect.screenshot)')!.severity).toBe('degraded');
  });
});

describe('collectMaestroWarnings', () => {
  function single(checks: SpecCriterion['checks'], tier: SpecCriterion['tier'] = 'hard'): Spec {
    return makeContactSpec({
      criteria: [{ id: 'AC-1', text: 'one', tier, mocking: 'none', checks }],
      conditions: undefined,
    });
  }

  it('warns (wont-run) on expect.network', () => {
    const w = collectMaestroWarnings({
      hasAppId: true,
      spec: single([{ expect: { network: { url: '/api/x', status: '2xx' } } }]),
    }).find((x) => x.scope === 'AC-1 (expect.network)');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('wont-run');
    expect(w!.message).toContain("can't observe network");
  });

  it('warns (wont-run) on expect.console', () => {
    const w = collectMaestroWarnings({
      hasAppId: true,
      spec: single([{ expect: { console: { errors: 0 } } }]),
    }).find((x) => x.scope === 'AC-1 (expect.console)');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('wont-run');
  });

  it('warns (wont-run) on expect.performance', () => {
    const w = collectMaestroWarnings({
      hasAppId: true,
      spec: single([{ expect: { performance: { metric: 'ready', maxMs: 1000 } } }]),
    }).find((x) => x.scope === 'AC-1 (expect.performance)');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('wont-run');
  });

  it('warns (degraded) on a role-only selector, but NOT when a name is present', () => {
    const roleOnly = collectMaestroWarnings({
      hasAppId: true,
      spec: single([{ click: { role: 'button' } }]),
    }).find((x) => x.scope === 'AC-1 (role-only selector)');
    expect(roleOnly).toBeDefined();
    expect(roleOnly!.severity).toBe('degraded');
    expect(roleOnly!.message).toContain('no role matcher');

    const named = collectMaestroWarnings({
      hasAppId: true,
      spec: single([{ click: { role: 'button', name: 'Send' } }]),
    });
    expect(scopes(named)).not.toContain('AC-1 (role-only selector)');
  });

  it('warns (degraded) on expect.screenshot — no built-in pixel-diff', () => {
    const w = collectMaestroWarnings({
      hasAppId: true,
      spec: single([{ expect: { screenshot: { name: 'home' } } }]),
    }).find((x) => x.scope === 'AC-1 (expect.screenshot)');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('degraded');
    expect(w!.message).toContain('no built-in');
    expect(w!.message).toContain('pixel-diff');
  });

  it('warns (needs-setup) on mocking:required — Maestro hits the real app', () => {
    const w = collectMaestroWarnings({
      hasAppId: true,
      spec: makeContactSpec({
        criteria: [{ id: 'AC-1', text: 'one', tier: 'hard', mocking: 'required', checks: [] }],
        conditions: undefined,
      }),
    }).find((x) => x.scope === 'AC-1 (mocking: required)');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('needs-setup');
    expect(w!.message).toContain('real app');
  });

  it('NEGATIVE (no cry-wolf): a fully-supported spec yields zero warnings', () => {
    // Fully supported for Maestro means the navigate has a route too — without
    // one the flow can't reach the screen, which is a real (warned) degradation.
    expect(
      collectMaestroWarnings({
        spec: makeFullySupportedSpec(),
        hasAppId: true,
        maestro: { routes: { '/contact': 'myapp://contact' } },
      }),
    ).toEqual([]);
  });
});

describe('export result wiring (warnings field)', () => {
  it('both exporters return warnings; Maestro degrades more than Playwright', () => {
    const playwright = exportSpecToPlaywright({
      spec: makeContactSpec(),
      config: makeConfig(),
      baseUrl: 'http://localhost:3000',
    });
    const maestro = exportSpecToMaestro({ spec: makeContactSpec() });

    expect(playwright.warnings.length).toBeGreaterThan(0);
    // Maestro additionally degrades network + console on top of the shared soft warning.
    expect(maestro.warnings.length).toBeGreaterThan(playwright.warnings.length);

    for (const w of [...playwright.warnings, ...maestro.warnings]) {
      expect(w.scope).toBeTruthy();
      expect(w.severity).toMatch(/^(wont-run|needs-setup|degraded)$/);
      expect(w.message).toBeTruthy();
    }
  });
});

/* ------------------------------------------------------------------ *
 * A11y export codegen (Item 8) — real AxeBuilder assertion in          *
 * Playwright, honest TODO in Maestro, warnings on both.                *
 * ------------------------------------------------------------------ */

describe('expect.a11y export', () => {
  function a11ySpec(): Spec {
    return makeContactSpec({
      criteria: [
        {
          id: 'AC-1',
          text: 'page has no serious a11y violations',
          tier: 'hard',
          mocking: 'none',
          checks: [{ expect: { a11y: { severity: 'serious', maxViolations: 0 } } }],
        },
      ],
      conditions: undefined,
    });
  }

  it('Playwright emits a real AxeBuilder analyze + impact filter + assertion', () => {
    const { files, warnings } = exportSpecToPlaywright({ spec: a11ySpec(), config: makeConfig() });
    const src = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;
    // Conditional import only when a11y is present.
    expect(src).toContain(`import { AxeBuilder } from '@axe-core/playwright';`);
    expect(src).toContain('new AxeBuilder({ page })');
    // No tag filter — must match the unfiltered web executor run.
    expect(src).not.toContain('.withTags(');
    expect(src).toContain("['serious', 'critical']");
    expect(src).toContain('toBeLessThanOrEqual(0)');
    // Warning: needs @axe-core/playwright installed in the target project.
    const w = warnings.find((x) => x.scope === 'AC-1 (expect.a11y)');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('needs-setup');
    expect(w!.message).toContain('@axe-core/playwright');
  });

  it('Playwright omits the AxeBuilder import when no a11y check is present', () => {
    const { files } = exportSpecToPlaywright({
      spec: makeContactSpec(),
      config: makeConfig(),
      baseUrl: 'http://localhost:3000',
    });
    const src = files.find((f) => f.path === 'spec-7f3a.v3.spec.ts')!.contents;
    expect(src).not.toContain('@axe-core/playwright');
  });

  it('the generated a11y Playwright source is syntactically valid TypeScript', () => {
    const { files } = exportSpecToPlaywright({ spec: a11ySpec(), config: makeConfig() });
    for (const f of files.filter((x) => x.path.endsWith('.ts'))) {
      const out = ts.transpileModule(f.contents, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
        reportDiagnostics: true,
      });
      const errs = (out.diagnostics ?? []).filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      );
      expect(errs.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    }
  });

  it('Maestro emits an honest a11y TODO + a wont-run warning', () => {
    const { files, warnings } = exportSpecToMaestro({ spec: a11ySpec() });
    const y = files[0]!.contents;
    expect(y).toContain("# TODO (lossy): Maestro can't assert axe a11y violations");
    expect(y).toContain('serious+ ≤ 0');
    const w = warnings.find((x) => x.scope === 'AC-1 (expect.a11y)');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('wont-run');
  });
});

describe('collectMaestroWarnings — element state/count degradation must warn (no silent certify)', () => {
  const specWith = (element: Record<string, unknown>) =>
    makeContactSpec({
      runtime: 'native',
      criteria: [
        {
          id: 'AC-1',
          text: 'the terms checkbox is checked',
          tier: 'hard',
          checks: [{ expect: { element } }],
        },
      ],
    });

  it('warns (degraded) for state checked/enabled/disabled — assertVisible is weaker', () => {
    for (const state of ['checked', 'enabled', 'disabled'] as const) {
      const w = collectMaestroWarnings({
        spec: specWith({ testId: 'terms', state }),
        hasAppId: true,
      });
      expect(w).toMatchObject([{ severity: 'degraded' }]);
      expect(w[0]!.scope).toContain(`state: '${state}'`);
    }
  });

  it('warns (degraded) for an exact count > 0', () => {
    const w = collectMaestroWarnings({
      spec: specWith({ testId: 'rows', count: 5 }),
      hasAppId: true,
    });
    expect(w).toMatchObject([{ severity: 'degraded' }]);
    expect(w[0]!.scope).toContain('count: 5');
  });

  it('does NOT warn for the REAL mappings: visible, hidden, count: 0', () => {
    for (const element of [
      { testId: 'x', state: 'visible' },
      { testId: 'x', state: 'hidden' },
      { testId: 'x', count: 0 },
    ]) {
      expect(collectMaestroWarnings({ spec: specWith(element), hasAppId: true })).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Playwright fix package (adversarial review): F1 fallback catch-all,  *
 * F2 selector priority + name fallback, Q3 screenshot, Q8 minors.      *
 * ------------------------------------------------------------------ */

/** The generated `<id>.v<v>.spec.ts` source for a spec. */
function pwSpecSrc(spec: Spec, config?: ValidityConfig, baseUrl?: string): string {
  return exportSpecToPlaywright({ spec, config: config ?? makeConfig(), baseUrl }).files.find((f) =>
    f.path.endsWith('.spec.ts'),
  )!.contents;
}
/** A single-criterion web spec with the given checks. */
function pwCritSpec(checks: SpecCriterion['checks'], tier: SpecCriterion['tier'] = 'hard'): Spec {
  return makeContactSpec({
    criteria: [{ id: 'AC-1', text: 'one', tier, mocking: 'none', checks }],
    conditions: undefined,
  });
}
/** Assert a generated file transpiles with zero syntactic TS errors. */
function expectValidTs(src: string): void {
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    reportDiagnostics: true,
  });
  const errs = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  expect(errs.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
}

describe('F1: fixtures catch-all mirrors mockNetwork.fallback', () => {
  function mockSpec(): Spec {
    return makeContactSpec({
      criteria: [
        {
          id: 'AC-1',
          text: 'submit posts',
          tier: 'hard',
          mocking: 'required',
          checks: [
            { click: { role: 'button', name: 'Send' } },
            { expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } } },
          ],
        },
      ],
      conditions: undefined,
    });
  }
  function configWith(fallback?: MockNetworkConfig['fallback']): ValidityConfig {
    return {
      renderMode: 'web',
      framework: 'auto',
      wrapper: './.validity/wrapper.gen.tsx',
      mockNetwork: {
        fallback,
        handlers: [{ url: '/api/contact', method: 'POST', status: 201, json: { ok: true } }],
      },
    };
  }
  const fixturesOf = (config: ValidityConfig): string =>
    exportSpecToPlaywright({ spec: mockSpec(), config, baseUrl: 'http://x' }).files.find((f) =>
      f.path.endsWith('.fixtures.ts'),
    )!.contents;
  const warningsOf = (config: ValidityConfig): ExportWarning[] =>
    exportSpecToPlaywright({ spec: mockSpec(), config, baseUrl: 'http://x' }).warnings;

  it('scopes the catch-all to fetch/xhr and continues other resource types', () => {
    const f = fixturesOf(configWith('permissive'));
    expect(f).toContain(`await page.route('**', async (route) => {`);
    expect(f).toContain(`const type = route.request().resourceType();`);
    expect(f).toContain(`if (type !== 'fetch' && type !== 'xhr') return route.continue();`);
  });

  it('registers the catch-all BEFORE the explicit handlers (Playwright most-recent-wins)', () => {
    const f = fixturesOf(configWith('permissive'));
    const catchAll = f.indexOf(`page.route('**',`);
    const explicit = f.indexOf('**/api/contact');
    expect(catchAll).toBeGreaterThanOrEqual(0);
    expect(explicit).toBeGreaterThan(catchAll);
  });

  it("'reject' → route.abort() (faithful — no populate warning)", () => {
    const f = fixturesOf(configWith('reject'));
    expect(f).toContain('return route.abort();');
    expect(f).not.toContain(`body: '{}'`);
    expect(scopes(warningsOf(configWith('reject')))).not.toContain(
      'mockNetwork.fallback (populate)',
    );
  });

  it("'permissive' and the unset default → fulfill 200 {} (no populate warning)", () => {
    for (const fb of ['permissive', undefined] as const) {
      const f = fixturesOf(configWith(fb));
      expect(f).toContain(`body: '{}'`);
      expect(f).toContain('status: 200,');
      expect(scopes(warningsOf(configWith(fb)))).not.toContain('mockNetwork.fallback (populate)');
    }
  });

  it("'populate' → fulfill {} + a needs-setup warning (synthetic data isn't portable)", () => {
    expect(fixturesOf(configWith('populate'))).toContain(`body: '{}'`);
    const w = warningsOf(configWith('populate')).find(
      (x) => x.scope === 'mockNetwork.fallback (populate)',
    );
    expect(w).toBeDefined();
    expect(w!.severity).toBe('needs-setup');
  });

  it('a custom fallback response object is replayed verbatim', () => {
    const f = fixturesOf(configWith({ status: 503, json: { down: true } }));
    expect(f).toContain('status: 503,');
    expect(f).toContain('JSON.stringify({"down":true})');
    expect(scopes(warningsOf(configWith({ status: 503, json: { down: true } })))).not.toContain(
      'mockNetwork.fallback (populate)',
    );
  });

  it('the populate warning needs fixtures — parity: the catch-all lives in the fixtures file', () => {
    // No criterion requires mocks → no fixtures file → no catch-all → no warning.
    const { files, warnings } = exportSpecToPlaywright({
      spec: makeFullySupportedSpec(),
      config: configWith('populate'),
      baseUrl: 'http://x',
    });
    expect(files.find((f) => f.path.endsWith('.fixtures.ts'))).toBeUndefined();
    expect(scopes(warnings)).not.toContain('mockNetwork.fallback (populate)');
  });

  it('generated fixtures with a catch-all are valid TypeScript for every fallback', () => {
    for (const fb of ['permissive', 'reject', 'populate'] as const) {
      expectValidTs(fixturesOf(configWith(fb)));
    }
    expectValidTs(fixturesOf(configWith({ status: 503, json: { down: true } })));
  });
});

describe('F2a: selector priority — testId above label/placeholder', () => {
  it('Playwright locator prefers testId over label + placeholder', () => {
    const src = pwSpecSrc(
      pwCritSpec([{ click: { testId: 'submit-btn', label: 'Submit', placeholder: 'type' } }]),
    );
    expect(src).toContain('page.getByTestId("submit-btn").click()');
    expect(src).not.toContain('getByLabel("Submit")');
  });
});

describe('F2b: name-only selector → getByText fallback note + degraded warning', () => {
  const nameOnly = (): Spec => pwCritSpec([{ click: { name: 'Save' } }]);

  it('emits the accessible-name NOTE above the getByText statement', () => {
    const src = pwSpecSrc(nameOnly());
    expect(src).toContain(
      '// NOTE: accessible-name fallback — getByText matches VISIBLE TEXT, not the accessible name; add a role or testId.',
    );
    expect(src).toContain('page.getByText("Save").click()');
    expectValidTs(src);
  });

  it('warns (degraded) — parity with the inline note', () => {
    const w = collectPlaywrightWarnings({
      spec: nameOnly(),
      hasFixtures: false,
      hasBaseUrl: true,
    }).find((x) => x.scope === 'AC-1 (accessible-name fallback)');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('degraded');
  });

  it('NEGATIVE: a role+name selector triggers no fallback note/warning', () => {
    const spec = pwCritSpec([{ click: { role: 'button', name: 'Save' } }]);
    expect(pwSpecSrc(spec)).not.toContain('accessible-name fallback');
    expect(
      scopes(collectPlaywrightWarnings({ spec, hasFixtures: false, hasBaseUrl: true })),
    ).not.toContain('AC-1 (accessible-name fallback)');
  });
});

describe('Q3: screenshot baseline name sanitized; all maxDiff combos valid', () => {
  const shotSrc = (screenshot: Record<string, unknown>): string =>
    pwSpecSrc(pwCritSpec([{ expect: { screenshot } }]));

  it("sanitizes 'after: open' → after-open.png", () => {
    expect(shotSrc({ name: 'after: open' })).toContain('toHaveScreenshot("after-open.png")');
  });

  it('all four (name × maxDiffPixels) combos render valid TS', () => {
    for (const s of [
      { name: 'home' },
      { name: 'home', maxDiffPixels: 100 },
      {},
      { maxDiffPixels: 100 },
    ]) {
      expectValidTs(shotSrc(s));
    }
    expect(shotSrc({})).toContain('toHaveScreenshot();');
    expect(shotSrc({ maxDiffPixels: 100 })).toContain('toHaveScreenshot({ maxDiffPixels: 100 });');
    expect(shotSrc({ name: 'home', maxDiffPixels: 100 })).toContain(
      'toHaveScreenshot("home.png", { maxDiffPixels: 100 });',
    );
  });
});

describe('Q8: element count+state degradation + newline-safe TODO interpolations', () => {
  const countState = (): Spec =>
    pwCritSpec([{ expect: { element: { testId: 'rows', count: 3, state: 'visible' } } }]);

  it('count + state emits toHaveCount + a dropped-state TODO', () => {
    const src = pwSpecSrc(countState());
    expect(src).toContain('toHaveCount(3)');
    expect(src).toContain("// TODO (lossy): state 'visible' not asserted alongside count 3.");
  });

  it('count + state warns (degraded) — parity with the inline TODO', () => {
    const w = collectPlaywrightWarnings({
      spec: countState(),
      hasFixtures: false,
      hasBaseUrl: true,
    }).find((x) => x.scope === 'AC-1 (expect.element count + state)');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('degraded');
  });

  it('NEGATIVE: count WITHOUT state has no dropped-state TODO/warning', () => {
    const spec = pwCritSpec([{ expect: { element: { testId: 'rows', count: 3 } } }]);
    expect(pwSpecSrc(spec)).not.toContain('not asserted alongside count');
    expect(
      scopes(collectPlaywrightWarnings({ spec, hasFixtures: false, hasBaseUrl: true })),
    ).not.toContain('AC-1 (expect.element count + state)');
  });

  it('a command with an embedded newline stays on one comment line (oneLine)', () => {
    const spec = pwCritSpec(
      [{ expect: { command: { run: 'typecheck\n&& evil', exitCode: 0 } } }],
      'property',
    );
    const src = pwSpecSrc(spec);
    expect(src).toContain("command 'typecheck && evil' once");
    // A raw newline would break the `//` comment into invalid TS — this proves it doesn't.
    expectValidTs(src);
  });
});
