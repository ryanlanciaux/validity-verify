/**
 * Tests for the NL→checks compiler. The adversarial section is the important
 * one: the compiler must DEMOTE anything whose naive check would assert the
 * opposite of intent (negations, conditionals) or that is purely aesthetic.
 * A false `soft` is harmless; a false `hard` could false-green the gate.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECK_COMPILER_VERSION,
  compileCriteria,
  compileCriterion,
  compilerMigrationReport,
  detectDataState,
  isCompilerStale,
  recompileSpecCriteria,
} from './compile-checks.js';
import { buildRepoTypecheckCriterion } from './command-check.js';
import type { SpecCriterion } from './spec-schema.js';
import { specCriterionSchema } from './spec-schema.js';
import type { AcceptanceCriterion } from './types.js';

/** Every compiled hard criterion must be a SCHEMA-VALID spec criterion. */
function assertValid(c: ReturnType<typeof compileCriteria>[number]) {
  expect(() => specCriterionSchema.parse(c)).not.toThrow();
}

describe('compileCriterion — shapes it SHOULD compile', () => {
  it('console invariant: "no console errors" → expect.console', () => {
    const r = compileCriterion('The page renders with no console errors');
    expect(r.tier).toBe('hard');
    expect(r.checks).toContainEqual({ expect: { console: { errors: 0 } } });
  });

  it('element presence: named status message → role/name visible', () => {
    const r = compileCriterion('A success confirmation is shown on the page');
    expect(r.tier).toBe('hard');
    expect(r.checks?.[0]).toEqual({ expect: { element: { role: 'status', state: 'visible' } } });
  });

  it('plural messages still resolve a role', () => {
    const r = compileCriterion('Error messages are displayed for invalid fields');
    expect(r.tier).toBe('hard');
    expect(r.checks?.[0]).toEqual({ expect: { element: { role: 'alert', state: 'visible' } } });
  });

  it('element presence: quoted button name → role+name visible', () => {
    const r = compileCriterion('The "Sign in" button is visible on load');
    expect(r.checks?.[0]).toEqual({
      expect: { element: { role: 'button', name: 'Sign in', state: 'visible' } },
    });
  });

  it('empty-state: "no results found" message is shown → text visible', () => {
    const r = compileCriterion('Shows a "No results found" message when the search is empty');
    expect(r.tier).toBe('hard');
    expect(r.checks?.some((c) => JSON.stringify(c).includes('No results'))).toBe(true);
  });

  it('hidden: "the error message is hidden initially" → state hidden', () => {
    const r = compileCriterion('The error message is hidden initially');
    expect(r.tier).toBe('hard');
    expect(r.checks?.[0]).toEqual({ expect: { element: { role: 'alert', state: 'hidden' } } });
  });

  it('performance: "loads in under 1 second" → ready budget 1000ms', () => {
    const r = compileCriterion('The dashboard loads in under 1 second');
    expect(r.checks).toContainEqual({ expect: { performance: { metric: 'ready', maxMs: 1000 } } });
  });

  it('performance: "renders within 800ms"', () => {
    const r = compileCriterion('The list renders within 800ms');
    expect(r.checks).toContainEqual({ expect: { performance: { metric: 'ready', maxMs: 800 } } });
  });

  it('network: explicit method + path → expect.network + mocking required', () => {
    const r = compileCriterion('Submitting the form POSTs to /api/contact and succeeds');
    expect(r.tier).toBe('hard');
    expect(r.mocking).toBe('required');
    expect(r.checks).toContainEqual({
      expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } },
    });
  });

  it('contact-form criterion: network + console (matches the real spec intent)', () => {
    const r = compileCriterion(
      'User can submit the contact form (POST /api/contact succeeds, no console errors)',
    );
    expect(r.tier).toBe('hard');
    expect(r.checks).toContainEqual({
      expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } },
    });
    expect(r.checks).toContainEqual({ expect: { console: { errors: 0 } } });
  });
});

describe('compileCriterion — testId lowering', () => {
  it('exact fixture case: testId presence → testId-ONLY selector (never name)', () => {
    const r = compileCriterion('A control with testId "retest-loop" is present.');
    expect(r.tier).toBe('hard');
    expect(r.checks).toEqual([
      { expect: { element: { testId: 'retest-loop', state: 'visible' } } },
    ]);
    // The old bug misfiled the id value as an accessible name — assert it's gone.
    const el = (r.checks![0] as { expect: { element: Record<string, unknown> } }).expect.element;
    expect('name' in el).toBe(false);
  });

  it('capital-D "testID" (RN prop spelling)', () => {
    const r = compileCriterion('The screen shows an element with testID "retest-loop"');
    expect(r.checks?.[0]).toEqual({
      expect: { element: { testId: 'retest-loop', state: 'visible' } },
    });
  });

  it('data-testid="save-btn" (web attribute spelling, = connective)', () => {
    const r = compileCriterion('An element with data-testid="save-btn" is visible');
    expect(r.checks?.[0]).toEqual({
      expect: { element: { testId: 'save-btn', state: 'visible' } },
    });
  });

  it('single-quoted id value', () => {
    const r = compileCriterion("A control with testId 'save-btn' is present");
    expect(r.checks?.[0]).toEqual({
      expect: { element: { testId: 'save-btn', state: 'visible' } },
    });
  });

  it('backticked id value', () => {
    const r = compileCriterion('A control with testId `save-btn` is present');
    expect(r.checks?.[0]).toEqual({
      expect: { element: { testId: 'save-btn', state: 'visible' } },
    });
  });

  it('role + testId: testId wins ALONE (role would make the executor drop it)', () => {
    const r = compileCriterion('A button with testId "save-btn" is shown');
    expect(r.checks?.[0]).toEqual({
      expect: { element: { testId: 'save-btn', state: 'visible' } },
    });
  });

  it('interaction-gated testId presence stays soft', () => {
    const r = compileCriterion('After tapping save, a toast with testId "toast" appears');
    expect(r.tier).toBe('soft');
  });

  it('negated testId presence stays soft (intent flip)', () => {
    const r = compileCriterion('The control with testId "x" is never shown');
    expect(r.tier).toBe('soft');
  });

  it('hidden testId → state hidden', () => {
    const r = compileCriterion('The spinner with testId "spinner" is hidden');
    expect(r.checks?.[0]).toEqual({ expect: { element: { testId: 'spinner', state: 'hidden' } } });
  });

  it('compiles through compileCriteria to a schema-valid hard criterion', () => {
    const out = compileCriteria([
      { id: 'AC-1', description: 'A control with testId "retest-loop" is present.' },
    ]);
    expect(out[0]!.tier).toBe('hard');
    expect(out[0]!.checks).toEqual([
      { expect: { element: { testId: 'retest-loop', state: 'visible' } } },
    ]);
    out.forEach(assertValid);
  });
});

describe('compileCriterion — command criteria compile to expect.command (B7 §3)', () => {
  it('"the named command typecheck exits 0" → expect.command (NOT console)', () => {
    const r = compileCriterion('the named command typecheck exits 0');
    expect(r.tier).toBe('hard');
    expect(r.checks).toEqual([{ expect: { command: { run: 'typecheck', exitCode: 0 } } }]);
    // The regression: this used to emit expect.console instead.
    expect(
      r.checks?.some((c) => 'console' in (c as { expect: Record<string, unknown> }).expect),
    ).toBe(false);
  });

  it('"command `lint` exits with code 0" → expect.command run lint', () => {
    const r = compileCriterion('command `lint` exits with code 0');
    expect(r.tier).toBe('hard');
    expect(r.checks).toEqual([{ expect: { command: { run: 'lint', exitCode: 0 } } }]);
  });

  it('"`typecheck` command returns 0" → expect.command run typecheck', () => {
    const r = compileCriterion('`typecheck` command returns 0');
    expect(r.checks).toEqual([{ expect: { command: { run: 'typecheck', exitCode: 0 } } }]);
  });

  it('"the typecheck command exits 0" → expect.command run typecheck', () => {
    const r = compileCriterion('the typecheck command exits 0');
    expect(r.checks).toEqual([{ expect: { command: { run: 'typecheck', exitCode: 0 } } }]);
  });

  it('a command criterion is command-ONLY (never mixes a console/element check)', () => {
    // A command criterion saying ".. exits 0 with no errors" must NOT also mint
    // a console check — the no-mixing refine forbids page checks here, and the
    // bare "no errors" is no longer a console trigger (requires "console").
    const r = compileCriterion('the typecheck command exits 0 with no errors');
    expect(r.tier).toBe('hard');
    expect(r.checks).toEqual([{ expect: { command: { run: 'typecheck', exitCode: 0 } } }]);
  });

  it('non-zero exit phrasing stays soft ("exits 1")', () => {
    expect(compileCriterion('the typecheck command exits 1').tier).toBe('soft');
  });

  it('a bare exit-0 with no "command" word stays soft', () => {
    expect(compileCriterion('the process exits 0').tier).toBe('soft');
  });

  it('compiled command criterion is schema-valid through compileCriteria', () => {
    const out = compileCriteria([
      { id: 'AC-1', description: 'the named command typecheck exits 0' },
    ]);
    expect(out[0]!.tier).toBe('hard');
    expect(out[0]!.checks).toEqual([{ expect: { command: { run: 'typecheck', exitCode: 0 } } }]);
    assertValid(out[0]!);
  });
});

describe('compileCriterion — exemplar literals stay soft (B7 §2)', () => {
  it('a quoted exemplar after "e.g." does NOT become an exact name check', () => {
    // The real-world regression: `name: "2 left"` asserted against a live render
    // whose value is "5 left". The literal is an illustration, not a contract.
    const r = compileCriterion('the badge shows the remaining count, e.g. "2 left" is visible');
    expect(r.tier).toBe('soft');
    expect(JSON.stringify(r.checks ?? [])).not.toContain('"2 left"');
  });

  it('an exemplar with the long form "for example" stays soft', () => {
    const r = compileCriterion(
      'the progress label shows a ratio, for example "1 of 3 done · 33%" is shown',
    );
    expect(r.tier).toBe('soft');
    expect(JSON.stringify(r.checks ?? [])).not.toContain('1 of 3 done');
  });

  it('an exemplar after "such as" stays soft', () => {
    const r = compileCriterion('shows a category label such as "Admin" is visible');
    expect(r.tier).toBe('soft');
  });

  it('an exemplar after "like" stays soft', () => {
    const r = compileCriterion('shows a short status like "2 left" is visible');
    expect(r.tier).toBe('soft');
  });

  it('an exemplar testId literal does NOT pin an exact testId', () => {
    const r = compileCriterion('a control with testId e.g. "retest-loop" is present');
    expect(JSON.stringify(r.checks ?? [])).not.toContain('retest-loop');
  });

  it('an exemplar literal with a role still compiles the role (drops only the name)', () => {
    // "a button e.g. \"Save\" is visible" — the role survives; the exemplar
    // name is dropped so we don't assert `name: "Save"` against a dynamic label.
    const r = compileCriterion('a button labelled, e.g. "Save", is visible');
    expect(r.tier).toBe('hard');
    expect(r.checks?.[0]).toEqual({ expect: { element: { role: 'button', state: 'visible' } } });
    expect(JSON.stringify(r.checks ?? [])).not.toContain('"Save"');
  });

  it('NEGATIVE: a plain quoted literal (no exemplar marker) still compiles to a name', () => {
    const r = compileCriterion('The "Sign in" button is visible on load');
    expect(r.checks?.[0]).toEqual({
      expect: { element: { role: 'button', name: 'Sign in', state: 'visible' } },
    });
  });

  it('NEGATIVE: a plain empty-state quoted message still compiles its exact text', () => {
    const r = compileCriterion('Shows a "No results found" message when the search is empty');
    expect(r.tier).toBe('hard');
    expect(JSON.stringify(r.checks ?? [])).toContain('No results');
  });
});

describe('compileCriterion — console checks still compile (B7 §3 regression)', () => {
  it('"no console errors" → expect.console (ANCHORED, requires "console")', () => {
    const r = compileCriterion('The page renders with no console errors');
    expect(r.tier).toBe('hard');
    expect(r.checks).toContainEqual({ expect: { console: { errors: 0 } } });
  });

  it('"console is clean" → expect.console', () => {
    const r = compileCriterion('After load the console is clean');
    expect(r.checks).toContainEqual({ expect: { console: { errors: 0 } } });
  });

  it('"zero console errors" → expect.console', () => {
    const r = compileCriterion('the page produces zero console errors');
    expect(r.checks).toContainEqual({ expect: { console: { errors: 0 } } });
  });

  it('"console-free" → expect.console', () => {
    const r = compileCriterion('the render is console-free');
    expect(r.checks).toContainEqual({ expect: { console: { errors: 0 } } });
  });

  it('a bare "no errors" (no "console") stays soft — ambiguous channel', () => {
    // Previously: "no errors" alone triggered a console check via the optional
    // `(console\s+)?`. That mis-compiled command criteria phrased ".. exits 0
    // with no errors". Now it stays soft (no unambiguous console channel).
    const r = compileCriterion('the build completes with no errors');
    expect(r.tier).toBe('soft');
    expect(r.checks).toBeUndefined();
  });
});

describe('buildRepoTypecheckCriterion — dedupes against a compiled command criterion', () => {
  it('a plan with "the named command typecheck exits 0" yields exactly ONE typecheck command criterion', () => {
    // Simulates handlePlan (server.ts ~4456): compileCriteria then offer
    // buildRepoTypecheckCriterion the compiled set as existingCriteria. With the
    // command compiler both producing `run: 'typecheck'`, the auto-attach's
    // alreadyChecked guard must dedupe so only one typecheck criterion remains.
    const compiled = compileCriteria([
      { id: 'AC-1', description: 'the named command typecheck exits 0' },
    ]);
    const autoAttached = buildRepoTypecheckCriterion({
      hasTsconfig: true,
      typecheckCommand: 'tsc --build',
      existingCriteria: compiled,
    });
    expect(autoAttached).toBeUndefined(); // deduped — AC-1 already covers typecheck
    const typecheckCriteria = compiled.filter((c) =>
      c.checks?.some(
        (ch) =>
          'expect' in ch &&
          (ch as { expect: { command?: { run?: string } } }).expect.command?.run === 'typecheck',
      ),
    );
    expect(typecheckCriteria).toHaveLength(1);
    expect(typecheckCriteria[0]!.id).toBe('AC-1');
  });

  it('auto-attaches the repo-typecheck when the plan does NOT name typecheck', () => {
    const compiled = compileCriteria([{ id: 'AC-1', description: 'a "Submit" button is visible' }]);
    const autoAttached = buildRepoTypecheckCriterion({
      hasTsconfig: true,
      typecheckCommand: 'tsc --build',
      existingCriteria: compiled,
    });
    expect(autoAttached).toBeDefined();
    expect(autoAttached!.id).toBe('repo-typecheck');
    expect(autoAttached!.checks).toEqual([
      { expect: { command: { run: 'typecheck', exitCode: 0 } } },
    ]);
  });
});

describe('compileCriterion — ADVERSARIAL: must stay soft (no false-green)', () => {
  const mustBeSoft = [
    'Form looks polished and on-brand',
    'The empty state feels reassuring and friendly',
    'The design is clean and uncluttered',
    'Trend arrows are green for positive and red for negative',
    'Animations are smooth, not abrupt',
    'The user cannot submit without entering an email',
    'The submit button is disabled until the form is valid',
    "Don't show the modal until the user clicks the trigger",
    'The page does not show an error message on valid input',
    'It works',
    'Looks good',
    'The layout is responsive',
    // Interaction-gated presence — not on the base render, so soft (the
    // compiler can't synthesize the triggering action).
    'A success confirmation is shown after submitting',
    'The modal shows an error message on invalid input',
    'The dropdown opens when the user clicks the trigger',
    'A toast appears after clicking save',
  ];
  it.each(mustBeSoft)('soft: %s', (text) => {
    expect(compileCriterion(text).tier).toBe('soft');
  });

  it('never emits a network check for a negated submit', () => {
    const r = compileCriterion('The user cannot submit to /api/contact without an email');
    expect(r.tier).toBe('soft');
    expect(r.checks).toBeUndefined();
  });

  it('never asserts visible for a NEGATED presence', () => {
    const r = compileCriterion('The error message should not be shown on a valid form');
    // "not ... shown" must not compile to element-visible.
    const json = JSON.stringify(r.checks ?? []);
    expect(json).not.toContain('"visible"');
  });
});

describe('compileCriteria — wiring + schema validity', () => {
  it('preserves id + order and validates every compiled criterion', () => {
    const input: AcceptanceCriterion[] = [
      { id: 'AC-1', description: 'A "Submit" button is visible' },
      { id: 'AC-2', description: 'Looks polished and on-brand' },
      { id: 'AC-3', description: 'No console errors on load' },
    ];
    const out = compileCriteria(input);
    expect(out.map((c) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(out[0]!.tier).toBe('hard');
    expect(out[1]!.tier).toBe('soft');
    expect(out[2]!.tier).toBe('hard');
    out.forEach(assertValid);
  });

  it('every hard criterion carries a non-empty checks block', () => {
    const out = compileCriteria([
      { id: 'AC-1', description: 'The heading is displayed' },
      { id: 'AC-2', description: 'Shows a "No items" message when empty' },
    ]);
    for (const c of out) {
      if (c.tier === 'hard') expect(c.checks && c.checks.length > 0).toBe(true);
    }
  });

  it('exposes a stable compiler version', () => {
    expect(typeof CHECK_COMPILER_VERSION).toBe('string');
    expect(CHECK_COMPILER_VERSION.length).toBeGreaterThan(0);
  });
});

describe('detectDataState (A2)', () => {
  it("empty-state phrasing → 'empty'", () => {
    expect(detectDataState("shows 'No results found' when the list is empty")).toBe('empty');
    expect(detectDataState('renders the empty state with a call to action')).toBe('empty');
    expect(detectDataState('displays "Nothing to show" for a new user')).toBe('empty');
  });

  it("loading phrasing → 'loading'", () => {
    expect(detectDataState('a skeleton is shown while loading')).toBe('loading');
    expect(detectDataState('shows a spinner until data arrives')).toBe('loading');
    expect(detectDataState('the loading state shows placeholder cards')).toBe('loading');
  });

  it("fetch/server error phrasing → 'error'", () => {
    expect(detectDataState('shows an error banner when the request fails')).toBe('error');
    expect(detectDataState('renders the error state when the API is down')).toBe('error');
    expect(detectDataState('handles a 500 from the server gracefully')).toBe('error');
  });

  it('SUPPRESSES error for interaction-gated form validation (no false forcing)', () => {
    // "error after submitting an invalid email" is form validation, NOT a
    // fetch error — forcing 500s there would test the wrong premise.
    expect(detectDataState('shows an error message after submitting an invalid email')).toBe(
      undefined,
    );
    expect(detectDataState('an error appears on invalid input')).toBe(undefined);
  });

  it('one state per criterion by fixed precedence loading > empty > error', () => {
    expect(detectDataState('shows a skeleton while loading, then no results if empty')).toBe(
      'loading',
    );
    expect(detectDataState('no results shown when the fetch fails')).toBe('empty');
  });

  it('plain populated criteria detect nothing', () => {
    expect(detectDataState('the dashboard lists recent orders')).toBe(undefined);
    expect(detectDataState('a "Submit" button is visible')).toBe(undefined);
  });
});

describe('compileCriterion/compileCriteria — dataState stamping (A2)', () => {
  it('stamps dataState on a HARD empty-state criterion (Shape C now reaches its render)', () => {
    const out = compileCriteria([
      { id: 'AC-1', description: 'Shows a "No results found" message when the list is empty' },
    ]);
    expect(out[0]!.tier).toBe('hard');
    expect(out[0]!.dataState).toBe('empty');
    assertValid(out[0]!);
  });

  it('stamps dataState on a SOFT aesthetic criterion (scored against the forced render)', () => {
    const compiled = compileCriterion('the empty state feels friendly');
    expect(compiled.tier).toBe('soft');
    expect(compiled.dataState).toBe('empty');
    const out = compileCriteria([{ id: 'AC-1', description: 'the empty state feels friendly' }]);
    expect(out[0]!.tier).toBe('soft');
    expect(out[0]!.dataState).toBe('empty');
    assertValid(out[0]!);
  });

  it('omits the field entirely when no state is detected (old spec YAML byte-stable)', () => {
    const out = compileCriteria([{ id: 'AC-1', description: 'A "Submit" button is visible' }]);
    expect('dataState' in out[0]!).toBe(false);
  });

  it("the compiler version bumped to '4' for the exemplar + command rules", () => {
    // §9.5: exactly ONE bump per rules change — '4' owns the exemplar-literal
    // guard (B7 §2) and the command-criterion compilation (B7 §3). '3' was the
    // testId selector lowering. Frozen specs are untouched (verify never
    // re-compiles); new specs hash differently by design.
    expect(CHECK_COMPILER_VERSION).toBe('4');
  });
});

describe('compiler migration (W2 #4)', () => {
  it('isCompilerStale: current stamp fresh, old/absent stamp stale', () => {
    expect(isCompilerStale(CHECK_COMPILER_VERSION)).toBe(false);
    expect(isCompilerStale('1')).toBe(true);
    expect(isCompilerStale(undefined)).toBe(true);
  });

  it('recompileSpecCriteria re-derives checks from the stored text', () => {
    const stored: SpecCriterion[] = [
      { id: 'AC-1', text: 'renders with no console errors', tier: 'soft' },
    ];
    const out = recompileSpecCriteria(stored);
    // The current compiler promotes the console invariant to a hard check.
    expect(out[0]!.tier).toBe('hard');
    expect(out[0]!.checks?.length).toBeGreaterThan(0);
  });

  it('compilerMigrationReport flags a stale stamp whose recompile CHANGES the bar', () => {
    // Frozen as `soft` under an old contract, but today it compiles to hard.
    const frozen: SpecCriterion[] = [
      { id: 'AC-1', text: 'renders with no console errors', tier: 'soft' },
    ];
    const report = compilerMigrationReport(frozen, '1');
    expect(report.stale).toBe(true);
    expect(report.fromVersion).toBe('1');
    expect(report.toVersion).toBe(CHECK_COMPILER_VERSION);
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({ id: 'AC-1', fromTier: 'soft', toTier: 'hard' });
    expect(report.recompiled[0]!.tier).toBe('hard');
  });

  it('compilerMigrationReport reports NO changes when the recompile is identical', () => {
    // An aesthetic criterion stays soft under every contract → identical bar.
    const frozen: SpecCriterion[] = [
      { id: 'AC-1', text: 'looks polished and on-brand', tier: 'soft' },
    ];
    const report = compilerMigrationReport(frozen, '1');
    expect(report.stale).toBe(true); // stamp is old…
    expect(report.changes).toHaveLength(0); // …but the bar is unchanged (safe re-stamp)
  });

  it('a current-contract spec is not stale and has no changes', () => {
    const frozen: SpecCriterion[] = [{ id: 'AC-1', text: 'looks polished', tier: 'soft' }];
    const report = compilerMigrationReport(frozen, CHECK_COMPILER_VERSION);
    expect(report.stale).toBe(false);
    expect(report.changes).toHaveLength(0);
  });
});

// Hover/focused stay author-only (the field names + trigger aren't in the
// text, and interaction-gated phrasing is deliberately demoted to soft).
// "Pressing Tab moves focus…" stays soft (INTERACTION_GATED).
describe('compiler never emits hover/focused (or unscoped press) from NL', () => {
  const hasVerb = (checks: ReturnType<typeof compileCriterion>['checks']): boolean =>
    /"(press|hover)"|"state":"focused"/.test(JSON.stringify(checks ?? []));

  for (const text of [
    'Pressing Tab moves focus to the Save button',
    'The toolbar reveals its actions on hover',
    'Keyboard focus is visible on the primary CTA',
    'Shift+Tab returns focus to the search box',
  ]) {
    it(`"${text}" never compiles to a press/hover/focused check`, () => {
      expect(hasVerb(compileCriterion(text).checks)).toBe(false);
    });
  }
});

describe("compileCriterion — action verbs never mint action-only HARD (can't-false-green)", () => {
  // Each of these would be a mechanical green with zero proof: the action
  // passes whenever it executes, and the assertion in the prose is dropped.
  for (const text of [
    'the toast disappears after 2 seconds',
    'after 500ms the spinner is gone',
    'scroll to the bottom of the page shows a footer',
    "press Enter in 'Email' submits the form",
    'wait 200ms',
    'scroll to the bottom',
    "press Enter in 'Email'",
    "select 'United States' from Country",
    "scroll 'Footer' into view",
  ]) {
    it(`"${text}" stays soft`, () => {
      const r = compileCriterion(text);
      expect(r.tier).toBe('soft');
      expect(r.checks).toBeUndefined();
    });
  }
});

describe('compileCriterion — action verbs only alongside a compiled assertion', () => {
  it('"wait for \'Message sent\' to appear" stays expect.element visible (v4 mapping)', () => {
    const r = compileCriterion("wait for 'Message sent' to appear");
    expect(r.tier).toBe('hard');
    expect(r.checks).toEqual([{ expect: { element: { name: 'Message sent', state: 'visible' } } }]);
  });

  it('select + visible assertion compiles both the action and the expect', () => {
    const r = compileCriterion("select 'US' from Country and the 'State' field is visible");
    expect(r.tier).toBe('hard');
    expect(r.checks?.some((c) => 'select' in c)).toBe(true);
    expect(r.checks?.some((c) => 'expect' in c)).toBe(true);
    assertValid({ id: 'AC-1', text: 'x', tier: 'hard', checks: r.checks });
  });

  it('scroll into view + visible assertion compiles both', () => {
    const r = compileCriterion("scroll 'Footer' into view and the 'Footer' heading is visible");
    expect(r.tier).toBe('hard');
    expect(r.checks?.some((c) => 'scroll' in c)).toBe(true);
    expect(r.checks?.some((c) => 'expect' in c)).toBe(true);
  });

  it('press in label + visible assertion compiles both', () => {
    const r = compileCriterion("press Enter in Email and the 'Saved' status is visible");
    expect(r.tier).toBe('hard');
    expect(r.checks?.some((c) => 'press' in c)).toBe(true);
    expect(r.checks?.some((c) => 'expect' in c)).toBe(true);
  });

  it('a duration above CHECK_TIMEOUT_MS stays uncompiled (schema would reject it)', () => {
    const r = compileCriterion('wait 30 seconds');
    expect(r.tier).toBe('soft');
  });

  it('existing presence prose is unchanged: "The \\"Sign in\\" button is visible on load"', () => {
    const r = compileCriterion('The "Sign in" button is visible on load');
    expect(r.checks).toEqual([
      { expect: { element: { role: 'button', name: 'Sign in', state: 'visible' } } },
    ]);
  });
});
