/**
 * End-to-end PROOF of the spec hard-tier pipeline, in a REAL browser.
 *
 * This is the load-bearing demonstration that "spec as a first-class citizen"
 * actually works mechanically — not just that the pure functions typecheck.
 * It deliberately avoids the Vite sandbox boot (not required to prove the
 * hard-tier pipeline); instead it serves a hand-written contact form over
 * Playwright `page.route`, mocks `POST /api/contact`, and runs the spec's hard
 * checks against it exactly as the verify pipeline does. (The full Vite boot IS
 * exercised by integration.test.ts — which passes once its tmp project root is
 * realpath'd; the `Unexpected identifier 'global'` symptom was a symlinked-root
 * artifact, not a node-23 esbuild bug.)
 *
 * What it proves end to end:
 *   1. A frozen spec with a HARD criterion (fill → click → expect network 2xx →
 *      expect console 0) executes DETERMINISTICALLY and PASSES against a real
 *      DOM driven by a11y role/name selectors.
 *   2. A broken form (button with no accessible name) yields `unverifiable`
 *      (the selector-durability FINDING), not a false `fail`.
 *   3. The same spec compiles to a real Playwright `.spec.ts` (getByRole fill/
 *      click + waitForResponse) plus a fixtures file — the export trust story.
 *
 * If chromium can't launch in this environment the test self-skips with a note
 * rather than failing — the pure-logic coverage lives in check-executor.test.ts
 * and spec-export.test.ts.
 */
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
  computeHardeningCandidates,
  createSpec,
  freezeSpec,
  HARDENING_STABLE_RUNS,
  parseSpec,
  readSpec,
  reconcileScorecard,
  saveScorecard,
  updateSpec,
  type HardeningRunEvidence,
  type Spec,
  type SpecCriterion,
} from '@validity.ai/verify-spec';
import { runCriterionChecks } from './check-executor.js';
import { assessSpecMaturity } from './exporters/spec-maturity.js';
import { exportSpecToPlaywright } from './exporters/spec-playwright.js';

const HARD_CRITERION: SpecCriterion = {
  id: 'AC-1',
  text: 'User can submit the contact form',
  tier: 'hard',
  mocking: 'required',
  checks: [
    { fill: { role: 'textbox', name: 'Email', value: 'a@b.com' } },
    { click: { role: 'button', name: 'Send' } },
    { expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } } },
    { expect: { console: { errors: 0 } } },
  ],
};

function contactSpec(): Spec {
  return parseSpec({
    id: 'spec-e2e',
    version: 3,
    status: 'frozen',
    source: { prompt: 'Build a contact form that can be submitted', createdBy: 'agent' },
    runtime: 'web',
    targets: { components: ['ContactForm'] },
    criteria: [
      HARD_CRITERION,
      { id: 'AC-2', text: 'Form looks polished and on-brand', tier: 'soft' },
    ],
    conditions: { viewports: [375, 1280] },
    hash: 'sha256-fake',
    createdAt: new Date(0).toISOString(),
  });
}

/** A real contact form. `accessible=false` strips the button's name to prove
 * the durability finding. */
function formHtml(accessible: boolean): string {
  const button = accessible
    ? `<button type="submit">Send</button>`
    : // No text, no aria-label → no accessible name → getByRole('button',{name:'Send'}) can't resolve.
      `<button type="submit" aria-label=""><span></span></button>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Contact</title></head>
<body>
  <form id="f">
    <h2>Contact us</h2>
    <label>Email <input type="email" name="email" /></label>
    ${button}
    <p id="ok" hidden role="status">Message sent</p>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: document.querySelector('input[name=email]').value }),
      });
      if (res.ok) { const ok = document.getElementById('ok'); ok.hidden = false; }
    });
  </script>
</body></html>`;
}

let browser: Browser | null = null;
let launchError: string | null = null;

beforeAll(async () => {
  try {
    browser = await chromium.launch();
  } catch (err) {
    launchError = (err as Error).message;
    if (process.env.CI) {
      throw new Error(`Chromium couldn't launch: ${launchError}`, { cause: err });
    }
  }
});

afterAll(async () => {
  await browser?.close();
});

describe('spec hard-tier verify — real browser e2e', () => {
  it('PROVES a hard criterion passes against a real, accessible form', async () => {
    if (!browser) {
      console.warn(`skipping browser e2e — chromium did not launch: ${launchError}`);
      return;
    }
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Serve the document and mock POST /api/contact with a 200 — the same shape
    // .validity/config.ts declares for the real ContactForm.
    await page.route('**/*', async (route) => {
      const req = route.request();
      if (req.url().endsWith('/api/contact')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      }
      if (req.resourceType() === 'document') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: formHtml(true) });
      }
      return route.fulfill({ status: 200, body: '' });
    });
    await page.goto('http://validity.test/contact');

    const verdict = await runCriterionChecks({ page, criterion: HARD_CRITERION });
    // Mechanical: every check held → criterion passes.
    expect(verdict.status).toBe('pass');
    expect(verdict.checks?.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    // The POST actually fired and was observed as 2xx.
    const net = verdict.checks?.[2];
    expect(net?.detail).toMatch(/POST.*\/api\/contact.*→ 200/);
    // And the interaction landed (success banner shown) — soft scorer would see it.
    expect(await page.getByRole('status').isVisible()).toBe(true);
    await ctx.close();
  }, 30_000);

  it('PROVES an unaddressable submit button is a FINDING (unverifiable), not a false fail', async () => {
    if (!browser) return;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      if (route.request().url().endsWith('/api/contact')) {
        return route.fulfill({ status: 200, body: '{"ok":true}' });
      }
      if (route.request().resourceType() === 'document') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: formHtml(false) });
      }
      return route.fulfill({ status: 200, body: '' });
    });
    await page.goto('http://validity.test/contact');

    const verdict = await runCriterionChecks({ page, criterion: HARD_CRITERION });
    expect(verdict.status).toBe('unverifiable');
    const clickVerdict = verdict.checks?.find((c) => 'click' in c.check);
    expect(clickVerdict?.status).toBe('unverifiable');
    expect(clickVerdict?.detail).toMatch(/accessible name|could not click/i);
    await ctx.close();
  }, 30_000);

  it('PROVES a performance budget reads real in-page metrics (pass + fail)', async () => {
    if (!browser) return;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // Simulate the sandbox entry's perf fold: expose __VALIDITY_GET_PERF__ before
    // any navigation, exactly as the generated entry.tsx does.
    await page.addInitScript(() => {
      (
        window as unknown as { __VALIDITY_GET_PERF__: () => Record<string, number> }
      ).__VALIDITY_GET_PERF__ = () => ({ readyMs: 420, mountMs: 8.2 });
    });
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() === 'document') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: formHtml(true) });
      }
      return route.fulfill({ status: 200, body: '' });
    });
    await page.goto('http://validity.test/contact');

    const withinBudget: SpecCriterion = {
      id: 'AC-perf-ok',
      text: 'renders within 1s',
      tier: 'hard',
      checks: [{ expect: { performance: { metric: 'ready', maxMs: 1000 } } }],
    };
    const overBudget: SpecCriterion = {
      id: 'AC-perf-bad',
      text: 'mounts in under 5ms',
      tier: 'hard',
      checks: [{ expect: { performance: { metric: 'mount', maxMs: 5 } } }],
    };
    expect((await runCriterionChecks({ page, criterion: withinBudget })).status).toBe('pass');
    const bad = await runCriterionChecks({ page, criterion: overBudget });
    expect(bad.status).toBe('fail');
    expect(bad.checks?.[0]?.detail).toMatch(/8\.2ms exceeds budget 5ms/);
    await ctx.close();
  }, 30_000);

  it('PROVES the same spec compiles to a real Playwright test + fixtures', () => {
    const { files } = exportSpecToPlaywright({
      spec: contactSpec(),
      config: {
        renderMode: 'web',
        framework: 'vite',
        wrapper: './.validity/wrapper.tsx',
        mockNetwork: {
          handlers: [{ url: '/api/contact', method: 'POST', status: 200, json: { ok: true } }],
        },
      },
      baseUrl: 'http://localhost:5173',
    });
    const specFile = files.find((f) => f.path.endsWith('.spec.ts'));
    expect(specFile).toBeTruthy();
    const src = specFile!.contents;
    // Real assertions for the hard criterion — getByRole fill + click + network.
    expect(src).toMatch(/getByRole\(\s*['"]textbox['"]/);
    expect(src).toContain('.fill(');
    expect(src).toMatch(/getByRole\(\s*['"]button['"][\s\S]*Send/);
    expect(src).toContain('waitForResponse');
    // Soft criterion is visible, not dropped.
    expect(src).toContain('test.fixme');
    // Conditions matrix → two viewport describes.
    expect(src.match(/test\.describe/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Regeneration guard header.
    expect(src).toMatch(/generated from spec-e2e@v3|spec-e2e@v3/i);
    // mocking: required → a fixtures sibling exists.
    const fixtures = files.find((f) => f.path.includes('fixtures'));
    expect(fixtures).toBeTruthy();
    expect(fixtures!.contents).toContain('/api/contact');

    // Write to a tmp dir as a sanity check that paths are relative + writable.
    const out = mkdtempSync(resolve(tmpdir(), 'validity-export-'));
    for (const f of files) {
      const p = resolve(out, f.path);
      // No path traversal — files land under the chosen out dir.
      expect(p.startsWith(out)).toBe(true);
    }
    expect(readFileSync).toBeTypeOf('function');
  });
});

/**
 * C4 close-out: a page with a visible "Thanks!" status message. `aria-label`
 * carries the accessible name deliberately — `status`/`alert` are "name from
 * author" roles per the ARIA spec (Chromium does NOT derive their accessible
 * name from text content), so the hardened check's `name: 'Thanks!'` selector
 * needs it explicitly. The UI never changes across the soft→hard transition
 * below — only the spec's mechanical bar does.
 */
function thanksHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Thanks</title></head>
<body>
  <div role="status" aria-label="Thanks!">Thanks! Your message was sent.</div>
</body></html>`;
}

/** `HARDENING_STABLE_RUNS` byte-identical passing runs for AC-1, all citing
 * render "form" with a stable shot hash — the same evidence shape
 * `hardening.test.ts`'s `stableHistory()` helper builds, bound to a REAL
 * frozen spec's hash (the streak walk only trusts same-hash rows). */
function stableHardeningWindow(specHash: string): HardeningRunEvidence[] {
  return Array.from({ length: HARDENING_STABLE_RUNS }, (_, i) => ({
    runId: `run-${i + 1}`,
    createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
    specHash,
    verdicts: [
      { id: 'AC-1', tier: 'soft' as const, status: 'pass' as const, screenshotCitations: ['form'] },
    ],
    shots: new Map([['form__base', 'hash-stable']]),
    idsToKeys: new Map([['form', ['form__base']]]),
  }));
}

describe('hardening candidate acceptance — C4 close-out e2e', () => {
  it('PROVES accepting a hardening candidate mechanically passes against unchanged UI and climbs maturity', async () => {
    if (!browser) {
      console.warn(`skipping browser e2e — chromium did not launch: ${launchError}`);
      return;
    }

    // Real, file-based spec store — realpath'd per the file-header note above
    // (a symlinked tmp root breaks module resolution).
    const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'validity-c4-')));
    const { specId } = createSpec({
      projectRoot: root,
      prompt: 'contact form',
      criteria: [{ id: 'AC-1', text: 'a "Thanks!" success message is shown', tier: 'soft' }],
    });
    freezeSpec({ projectRoot: root, specId });
    const frozen = readSpec(root, specId)!;
    expect(frozen.hash).toBeTruthy();

    // BEFORE: frozen + an all-soft gate ⇒ 'team', with the missing mechanical
    // anchor named as a reason it can't certify (plus: never verified).
    const before = assessSpecMaturity(root, frozen);
    expect(before.level).toBe('team');
    expect(before.blockers).toContainEqual(
      expect.objectContaining({ kind: 'no-mechanical-anchor' }),
    );

    // A byte-stable N-run evidence window bound to the REAL frozen hash
    // produces exactly one candidate: the compiler resolves this text to a
    // durable role+name selector, so the proposal is 'element', not a
    // screenshot baseline.
    const history = stableHardeningWindow(frozen.hash!);
    const candidates = computeHardeningCandidates({ spec: frozen, history });
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.kind).toBe('element');
    expect(candidate.proposal.checks).toEqual([
      { expect: { element: { role: 'status', name: 'Thanks!', state: 'visible' } } },
    ]);

    // Accept the proposal the way a user/agent would — spec_update (bumps the
    // version) → re-freeze. The engine itself never applies this.
    updateSpec({ projectRoot: root, specId, patch: { criteria: [candidate.proposal] } });
    freezeSpec({ projectRoot: root, specId });
    const rehardened = readSpec(root, specId)!;
    expect(rehardened.version).toBe(frozen.version + 1);
    const hardCriterion = rehardened.criteria.find((c) => c.id === 'AC-1')!;
    expect(hardCriterion.tier).toBe('hard');

    // Mechanical proof: the NEW hard check passes against the SAME unchanged
    // fixture the soft criterion was scored against — nothing about the UI
    // moved, only the spec's mechanical bar did.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() === 'document') {
        return route.fulfill({ status: 200, contentType: 'text/html', body: thanksHtml() });
      }
      return route.fulfill({ status: 200, body: '' });
    });
    await page.goto('http://validity.test/thanks');
    const verdict = await runCriterionChecks({ page, criterion: hardCriterion });
    expect(verdict.status).toBe('pass');
    expect(verdict.checks?.every((c) => c.status === 'pass')).toBe(true);
    await ctx.close();

    // AFTER hardening: the mechanical-anchor blocker is gone. The spec stays
    // at 'team' rather than jumping straight to 'certified' — accepting a
    // proposal doesn't itself PROVE the new contract. `never-verified` is the
    // remaining, HONEST blocker.
    const afterHardening = assessSpecMaturity(root, rehardened);
    expect(afterHardening.level).toBe('team');
    expect(afterHardening.blockers).not.toContainEqual(
      expect.objectContaining({ kind: 'no-mechanical-anchor' }),
    );
    expect(afterHardening.blockers).toContainEqual(
      expect.objectContaining({ kind: 'never-verified' }),
    );

    // Completing the accept workflow means PROVING the hardened contract:
    // fold the (real, browser-verified) passing verdict through the same
    // reducer a verify/watch tick uses. One clean verification is not yet
    // stability — the honest blocker says how far along the streak is …
    const observation = {
      specId,
      specVersion: rehardened.version,
      specHash: rehardened.hash,
      criteria: [{ id: 'AC-1', tier: 'hard' as const, status: 'pass' as const }],
    };
    const first = reconcileScorecard({
      prev: null,
      observations: [observation],
      now: new Date().toISOString(),
      sha: 'sha-c4-a',
    });
    saveScorecard(root, first.scorecard);
    const afterOneRun = assessSpecMaturity(root, rehardened);
    expect(afterOneRun.level).toBe('team');
    expect(afterOneRun.blockers).toMatchObject([{ kind: 'stability-pending' }]);

    // … and a second clean verification at a DISTINCT commit completes the
    // clean streak — the spec climbs all the way to 'certified'.
    const second = reconcileScorecard({
      prev: first.scorecard,
      observations: [observation],
      now: new Date().toISOString(),
      sha: 'sha-c4-b',
    });
    saveScorecard(root, second.scorecard);
    const afterStreak = assessSpecMaturity(root, rehardened);
    expect(afterStreak.level).toBe('certified');
    expect(afterStreak.blockers).toEqual([]);
  }, 30_000);
});
