/**
 * Unit tests for the deterministic check executor. These deliberately do NOT
 * launch chromium — pure helpers are tested directly, and the page-driven
 * paths are exercised with a FAKE page/locator that records calls (or throws
 * to assert the selector-durability `unverifiable` verdict).
 */
import type { Check, CheckVerdict, SpecCriterion } from '@validity.ai/verify-spec';
import { describe, expect, it, vi } from 'vitest';

// expect.a11y drives `new AxeBuilder({ page }).analyze()`. Mock the module so
// the cascade/can-fail-through-the-executor tests stay browser-free and can
// dictate the violation list. Tests override `__violations` per case; analyze
// throws when `__throw` is set (the axe-disposed-page → unverifiable path).
const axeState: { violations: { impact?: string; id?: string }[]; throw?: boolean } = {
  violations: [],
};
vi.mock('@axe-core/playwright', () => ({
  AxeBuilder: class {
    async analyze() {
      if (axeState.throw) throw new Error('axe injection failed');
      return { violations: axeState.violations };
    }
  },
}));

import {
  a11yImpactsToKeep,
  a11yVerdict,
  countA11yViolations,
  deriveRenderDataProvenance,
  evaluateScreenshotExpects,
  executeChecks,
  isTaintedByNetworkExpect,
  locatorFor,
  readInPageRequests,
  refoldAfterScreenshot,
  requestUrlMatches,
  runCriterionChecks,
  statusMatches,
  urlMatches,
  type ObservedResponse,
} from './check-executor.js';

describe('statusMatches', () => {
  it('exact number matches', () => {
    expect(statusMatches(404, 404)).toBe(true);
  });
  it('exact number rejects a different status', () => {
    expect(statusMatches(200, 404)).toBe(false);
  });
  it('2xx class accepts 200', () => {
    expect(statusMatches(200, '2xx')).toBe(true);
  });
  it('2xx class accepts 299 boundary', () => {
    expect(statusMatches(299, '2xx')).toBe(true);
  });
  it('2xx class rejects 500', () => {
    expect(statusMatches(500, '2xx')).toBe(false);
  });
  it('5xx class accepts 503', () => {
    expect(statusMatches(503, '5xx')).toBe(true);
  });
});

describe('urlMatches', () => {
  it('matches an exact path against a full request URL', () => {
    expect(urlMatches('http://localhost:5173/api/contact', '/api/contact')).toBe(true);
  });
  it('rejects a different path', () => {
    expect(urlMatches('http://localhost:5173/api/other', '/api/contact')).toBe(false);
  });
  it('prefix wildcard /api/* matches a nested path', () => {
    expect(urlMatches('http://localhost:5173/api/users/42', '/api/*')).toBe(true);
  });
  it('full URL pattern matches verbatim', () => {
    const u = 'https://example.test/api/me';
    expect(urlMatches(u, u)).toBe(true);
  });
});

describe('requestUrlMatches', () => {
  it('delegates a path pattern to urlMatches', () => {
    expect(requestUrlMatches('http://localhost/api/contact', '/api/contact')).toBe(true);
  });
  it('matches a /regex/flags literal against the full URL', () => {
    expect(requestUrlMatches('https://api.example/v2/save', '/api\\.example\\/v2/')).toBe(true);
    expect(requestUrlMatches('https://other.test/v2/save', '/api\\.example\\/v2/')).toBe(false);
  });
});

/**
 * Records the method + args used to build a locator, plus any `.nth()`.
 * Optional `onAction` callbacks let a test make `.click()` etc. throw.
 */
interface LocatorRec {
  via: string;
  args: unknown[];
  nthArg?: number;
}

function makeRecordingLocator(
  via: string,
  args: unknown[],
  actions: Record<string, () => Promise<unknown>> = {},
): LocatorRec & Record<string, unknown> {
  const rec: LocatorRec & Record<string, unknown> = { via, args };
  rec.nth = (n: number) => {
    rec.nthArg = n;
    return rec;
  };
  rec.click = actions.click ?? (async () => undefined);
  rec.fill = actions.fill ?? (async () => undefined);
  rec.hover = actions.hover ?? (async () => undefined);
  rec.press = actions.press ?? (async () => undefined);
  rec.selectOption = actions.selectOption ?? (async () => undefined);
  rec.scrollIntoViewIfNeeded = actions.scrollIntoViewIfNeeded ?? (async () => undefined);
  // `evaluate((el) => el === el.ownerDocument.activeElement)` backs the
  // `focused` state; the fake returns a test-controlled boolean (default false =
  // not focused) or throws to assert the unresolvable-element unverifiable path.
  rec.evaluate = actions.evaluate ?? (async () => false);
  rec.count = actions.count ?? (async () => 1);
  rec.isVisible = actions.isVisible ?? (async () => true);
  rec.isEnabled = actions.isEnabled ?? (async () => true);
  rec.isDisabled = actions.isDisabled ?? (async () => false);
  rec.isChecked = actions.isChecked ?? (async () => false);
  // Only wire `waitFor` when a test provides one — the default fake locator has
  // none, so evalState falls back to the instantaneous isVisible() path (which
  // is what the existing visible/hidden tests assert against).
  if (actions.waitFor) rec.waitFor = actions.waitFor;
  return rec;
}

/** Build a fake Playwright page that records getBy* calls. */
function makeFakePage(actions: Record<string, () => Promise<unknown>> = {}) {
  const calls: LocatorRec[] = [];
  const make =
    (via: string) =>
    (...args: unknown[]) => {
      const loc = makeRecordingLocator(via, args, actions);
      calls.push(loc);
      return loc;
    };
  const presses: string[] = [];
  const page = {
    calls,
    presses,
    on: () => {},
    off: () => {},
    goto: async () => undefined,
    keyboard: {
      press: async (key: string) => {
        if (actions.keyboardPress) return actions.keyboardPress();
        presses.push(key);
      },
    },
    getByRole: make('role'),
    getByLabel: make('label'),
    getByPlaceholder: make('placeholder'),
    getByTestId: make('testId'),
    getByText: make('text'),
  };
  return page;
}

describe('locatorFor mapping', () => {
  it('prefers role + name', () => {
    const page = makeFakePage();
    const loc = locatorFor(page as never, {
      role: 'button',
      name: 'Send',
    }) as unknown as LocatorRec;
    expect(loc.via).toBe('role');
    expect(loc.args).toEqual(['button', { name: 'Send' }]);
  });

  it('uses bare role when no name', () => {
    const page = makeFakePage();
    const loc = locatorFor(page as never, { role: 'textbox' }) as unknown as LocatorRec;
    expect(loc.via).toBe('role');
    expect(loc.args).toEqual(['textbox']);
  });

  it('falls back to label', () => {
    const page = makeFakePage();
    const loc = locatorFor(page as never, { label: 'Email' }) as unknown as LocatorRec;
    expect(loc.via).toBe('label');
    expect(loc.args).toEqual(['Email']);
  });

  it('falls back to placeholder', () => {
    const page = makeFakePage();
    const loc = locatorFor(page as never, { placeholder: 'you@x.com' }) as unknown as LocatorRec;
    expect(loc.via).toBe('placeholder');
    expect(loc.args).toEqual(['you@x.com']);
  });

  it('falls back to testId', () => {
    const page = makeFakePage();
    const loc = locatorFor(page as never, { testId: 'submit' }) as unknown as LocatorRec;
    expect(loc.via).toBe('testId');
    expect(loc.args).toEqual(['submit']);
  });

  it('prioritizes testId OVER label + placeholder (must match the exporter order)', () => {
    // F2a: a stable data-testid is more durable than a copy/i18n-mutable label.
    // If this order diverges from spec-playwright.ts locatorExpr, export ≠ verify.
    const page = makeFakePage();
    const loc = locatorFor(page as never, {
      testId: 'submit',
      label: 'Email',
      placeholder: 'you@x.com',
    }) as unknown as LocatorRec;
    expect(loc.via).toBe('testId');
    expect(loc.args).toEqual(['submit']);
  });

  it('prioritizes label over placeholder when no role/testId', () => {
    const page = makeFakePage();
    const loc = locatorFor(page as never, {
      label: 'Email',
      placeholder: 'you@x.com',
    }) as unknown as LocatorRec;
    expect(loc.via).toBe('label');
  });

  it('falls back to text', () => {
    const page = makeFakePage();
    const loc = locatorFor(page as never, { text: 'Welcome' }) as unknown as LocatorRec;
    expect(loc.via).toBe('text');
    expect(loc.args).toEqual(['Welcome']);
  });

  it('name WITHOUT role resolves via text (schema-legal; must not throw)', () => {
    const page = makeFakePage();
    const loc = locatorFor(page as never, { name: 'retest-loop' }) as unknown as LocatorRec;
    expect(loc.via).toBe('text');
    expect(loc.args).toEqual(['retest-loop']);
  });

  it('applies nth last', () => {
    const page = makeFakePage();
    const loc = locatorFor(page as never, { role: 'listitem', nth: 2 }) as unknown as LocatorRec;
    expect(loc.via).toBe('role');
    expect(loc.nthArg).toBe(2);
  });

  it('lowers a /regex/ name literal to a RegExp (parity with native matchName)', () => {
    const page = makeFakePage();
    const loc = locatorFor(page as never, {
      role: 'button',
      name: '/^Toggle Theme/',
    }) as unknown as LocatorRec;
    expect(loc.via).toBe('role');
    const [role, opts] = loc.args as [string, { name: RegExp }];
    expect(role).toBe('button');
    expect(opts.name).toBeInstanceOf(RegExp);
    expect((opts.name as RegExp).test('Toggle Theme: dark')).toBe(true);
  });

  it('passes a plain name through as a string (substring match)', () => {
    const page = makeFakePage();
    const loc = locatorFor(page as never, { text: 'Welcome' }) as unknown as LocatorRec;
    expect(loc.args).toEqual(['Welcome']);
  });
});

describe('executeChecks verdict folding', () => {
  it('a click whose target cannot be found is unverifiable, not fail', async () => {
    const page = makeFakePage({
      click: async () => {
        throw new Error('Timeout 5000ms exceeded.\nwaiting for getByRole...');
      },
    });
    const checks: Check[] = [{ click: { role: 'button', name: 'Send' } }];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].status).toBe('unverifiable');
    expect(verdicts[0].detail).toMatch(/AC unverifiable/);
  });

  it('a clean console expect (0 errors) passes', async () => {
    const page = makeFakePage();
    const checks: Check[] = [{ expect: { console: { errors: 0 } } }];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('pass');
  });

  // CAN'T-FALSE-GREEN: render/mount-time console.errors happen BEFORE the
  // executor installs its own listener. Seeded via priorConsoleErrors (sourced
  // from the capture's diagnostics collector), so the console gate is not blind
  // to them. Without the seed a component that logged 50 render-time errors
  // would pass `console.errors: 0`.
  it('render-time console errors (priorConsoleErrors) fail the console gate', async () => {
    const page = makeFakePage();
    const checks: Check[] = [{ expect: { console: { errors: 0 } } }];
    const verdicts = await executeChecks({ page: page as never, checks, priorConsoleErrors: 3 });
    expect(verdicts[0].status).toBe('fail');
    expect(verdicts[0].detail).toMatch(/count 3 exceeds/);
  });

  it('priorConsoleErrors within the allowance still passes', async () => {
    const page = makeFakePage();
    const checks: Check[] = [{ expect: { console: { errors: 2 } } }];
    const verdicts = await executeChecks({ page: page as never, checks, priorConsoleErrors: 2 });
    expect(verdicts[0].status).toBe('pass');
  });

  // CAN'T-FALSE-GREEN (A5, defense in depth): expect.command is run-level and
  // must never execute — or pass — inside the sandbox, even if the run-level
  // exclusion in prepareVerification regresses and one leaks into a render.
  it('an expect.command leaking into the sandbox is unverifiable, never pass', async () => {
    const page = makeFakePage();
    const checks: Check[] = [{ expect: { command: { run: 'typecheck', exitCode: 0 } } }];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('unverifiable');
    expect(verdicts[0].detail).toMatch(/once per verify run at the run level/);
  });

  it('element count:0 (absence) passes when nothing matches', async () => {
    const page = makeFakePage({ count: async () => 0 });
    const checks: Check[] = [{ expect: { element: { testId: 'banner', count: 0 } } }];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('pass');
  });

  it('element expected visible but hidden is a genuine fail', async () => {
    const page = makeFakePage({ isVisible: async () => false });
    const checks: Check[] = [{ expect: { element: { role: 'alert', state: 'visible' } } }];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('fail');
  });

  it('expect.network with no observed response fails with the isolation caveat', async () => {
    const page = makeFakePage();
    const checks: Check[] = [
      { expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } } },
    ];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('fail');
    expect(verdicts[0].detail).toMatch(/no network response observed/);
  });

  // FIX 12 — an element state assertion downstream of an unverifiable action
  // folds to unverifiable, not a hard fail (the flow never reached that state).
  it('an unverifiable click then a visible-expect folds to unverifiable, not fail', async () => {
    const page = makeFakePage({
      click: async () => {
        throw new Error('Timeout 5000ms exceeded.\nwaiting for getByRole...');
      },
      // Would otherwise be a genuine state fail — gated by the prior action.
      isVisible: async () => false,
    });
    const checks: Check[] = [
      { click: { role: 'button', name: 'Submit' } },
      { expect: { element: { role: 'alert', state: 'visible' } } },
    ];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('unverifiable');
    expect(verdicts[1].status).toBe('unverifiable');
    expect(verdicts[1].detail).toMatch(/prior action was unverifiable/);
  });

  // FIX 12 — a count mismatch downstream of an unverifiable action is also
  // unverifiable rather than fail.
  it('an unverifiable click then a count mismatch folds to unverifiable', async () => {
    const page = makeFakePage({
      click: async () => {
        throw new Error('Timeout 5000ms exceeded.');
      },
      count: async () => 0,
    });
    const checks: Check[] = [
      { click: { role: 'button', name: 'Add' } },
      { expect: { element: { role: 'listitem', count: 3 } } },
    ];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[1].status).toBe('unverifiable');
    expect(verdicts[1].detail).toMatch(/prior action was unverifiable/);
  });

  // FIX 12 — a count mismatch with NO prior unverifiable action stays a fail.
  it('a count mismatch with no prior unverifiable action is still a fail', async () => {
    const page = makeFakePage({ count: async () => 0 });
    const checks: Check[] = [{ expect: { element: { role: 'listitem', count: 3 } } }];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('fail');
  });

  // FIX 13 — 'visible' auto-waits via waitFor: an element that resolves visible
  // a tick later passes even though the instantaneous isVisible() reads false.
  it("element 'visible' auto-waits via waitFor and passes when it resolves", async () => {
    const page = makeFakePage({
      waitFor: async () => undefined,
      isVisible: async () => false, // would fail on the instantaneous path
    });
    const checks: Check[] = [{ expect: { element: { role: 'alert', state: 'visible' } } }];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('pass');
  });

  // FIX 13 — 'visible' fails (not throws) when waitFor times out.
  it("element 'visible' fails when waitFor times out", async () => {
    const page = makeFakePage({
      waitFor: async () => {
        throw new Error('Timeout 5000ms exceeded waiting for visible');
      },
      isVisible: async () => true, // would pass on the instantaneous path
    });
    const checks: Check[] = [{ expect: { element: { role: 'alert', state: 'visible' } } }];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('fail');
  });

  // FIX 14 — the in-page request log is scoped to this executeChecks run via the
  // snapshotted length: a request appended DURING the run (here by the click) is
  // matched, while pre-existing log entries are sliced off. Full prior-criterion
  // exclusion is browser-only (a non-match polls until CHECK_TIMEOUT_MS); this
  // fast positive proves sinceIndex is threaded through readInPageRequests.
  it('expect.network matches a request logged during the run, after the snapshot', async () => {
    // Live in-page log: index 0 is a PRIOR criterion's request (before snapshot).
    const log: { method: string; url: string; status: number }[] = [
      { method: 'POST', url: '/api/old', status: 200 },
    ];
    const page = makeFakePage({
      // The click fires this criterion's own request, appended after snapshot.
      click: async () => {
        log.push({ method: 'POST', url: '/api/contact', status: 201 });
      },
    });
    // Simulate Playwright's page.evaluate against the live log via globalThis.window.
    (page as Record<string, unknown>).evaluate = async (fn: () => unknown) => {
      const prev = (globalThis as Record<string, unknown>).window;
      (globalThis as Record<string, unknown>).window = { __VALIDITY_REQUESTS__: log };
      try {
        return fn();
      } finally {
        (globalThis as Record<string, unknown>).window = prev;
      }
    };
    (page as Record<string, unknown>).waitForTimeout = async () => undefined;

    const checks: Check[] = [
      { click: { role: 'button', name: 'Send' } },
      { expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } } },
    ];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[1].status).toBe('pass');
    expect(verdicts[1].detail).toMatch(/201/);
  });
});

describe('press / hover / focused', () => {
  it('a press to the page passes and dispatches the key', async () => {
    const page = makeFakePage();
    const checks: Check[] = [{ press: 'Tab' }];
    const [v] = await executeChecks({ page: page as never, checks });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/pressed Tab/);
    expect((page as { presses: string[] }).presses).toEqual(['Tab']);
  });

  it('a press with times repeats the key that many times', async () => {
    const page = makeFakePage();
    const checks: Check[] = [{ press: { key: 'Shift+Tab', times: 3 } }];
    const [v] = await executeChecks({ page: page as never, checks });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/pressed Shift\+Tab ×3/);
    expect((page as { presses: string[] }).presses).toEqual([
      'Shift+Tab',
      'Shift+Tab',
      'Shift+Tab',
    ]);
  });

  // A press is an ACTION: a keyboard failure is unverifiable (couldn't drive the
  // flow) and cascades to downstream expects — never a hard fail.
  it('a press whose keyboard throws is unverifiable and cascades', async () => {
    const page = makeFakePage({
      keyboardPress: async () => {
        throw new Error('keyboard detached');
      },
      isVisible: async () => false, // would be a genuine fail if not cascaded
    });
    const checks: Check[] = [
      { press: 'Tab' },
      { expect: { element: { role: 'button', name: 'Save', state: 'visible' } } },
    ];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('unverifiable');
    expect(verdicts[0].detail).toMatch(/could not press Tab/);
    expect(verdicts[1].status).toBe('unverifiable');
    expect(verdicts[1].detail).toMatch(/prior action was unverifiable/);
  });

  it('a hover resolves the selector and passes', async () => {
    const page = makeFakePage();
    const checks: Check[] = [{ hover: { role: 'button', name: 'Save' } }];
    const [v] = await executeChecks({ page: page as never, checks });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/hovered/);
    // Resolved via getByRole (the durable pair) — the recorded call proves it.
    expect(page.calls[0]!.via).toBe('role');
  });

  it('a hover whose target cannot be found is unverifiable (not fail) and cascades', async () => {
    const page = makeFakePage({
      hover: async () => {
        throw new Error('Timeout 5000ms exceeded.\nwaiting for getByRole...');
      },
      isVisible: async () => false,
    });
    const checks: Check[] = [
      { hover: { role: 'button', name: 'Menu' } },
      { expect: { element: { role: 'menu', state: 'visible' } } },
    ];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('unverifiable');
    expect(verdicts[0].detail).toMatch(/could not hover/);
    expect(verdicts[1].status).toBe('unverifiable');
  });

  it("element state 'focused' passes when the element IS the active element", async () => {
    const page = makeFakePage({ evaluate: async () => true });
    const checks: Check[] = [
      { expect: { element: { role: 'button', name: 'Save', state: 'focused' } } },
    ];
    const [v] = await executeChecks({ page: page as never, checks });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/is focused/);
  });

  // CAN-FAIL: a genuine focus miss with no prior unverifiable action is a fail.
  it("element state 'focused' fails when the element is NOT the active element", async () => {
    const page = makeFakePage({ evaluate: async () => false });
    const checks: Check[] = [
      { expect: { element: { role: 'button', name: 'Save', state: 'focused' } } },
    ];
    const [v] = await executeChecks({ page: page as never, checks });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/to be focused/);
  });

  it("element state 'focused' is unverifiable when the element can't be resolved", async () => {
    const page = makeFakePage({
      evaluate: async () => {
        throw new Error('strict mode violation: resolved to 0 elements');
      },
    });
    const checks: Check[] = [
      { expect: { element: { role: 'button', name: 'Ghost', state: 'focused' } } },
    ];
    const [v] = await executeChecks({ page: page as never, checks });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/could not resolve/);
  });

  // FIX-12 parity: a focus miss downstream of an unverifiable press is
  // unverifiable, not a fail (the flow never reached the focused state).
  it("a 'focused' miss after an unverifiable press folds to unverifiable", async () => {
    const page = makeFakePage({
      keyboardPress: async () => {
        throw new Error('keyboard detached');
      },
      evaluate: async () => false, // would be a genuine focus fail if not cascaded
    });
    const checks: Check[] = [
      { press: 'Tab' },
      { expect: { element: { role: 'button', name: 'Save', state: 'focused' } } },
    ];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[1].status).toBe('unverifiable');
    expect(verdicts[1].detail).toMatch(/prior action was unverifiable/);
  });

  // A press then a focus assertion is the canonical keyboard-reachability spec:
  // Tab moves focus to the next control, and the whole criterion folds to pass.
  it('press Tab then expect focused folds the criterion to pass', async () => {
    const page = makeFakePage({ evaluate: async () => true });
    const criterion: SpecCriterion = {
      id: 'AC-kbd',
      text: 'Tab moves focus to Save',
      tier: 'hard',
      checks: [
        { press: 'Tab' },
        { expect: { element: { role: 'button', name: 'Save', state: 'focused' } } },
      ],
    };
    const verdict = await runCriterionChecks({ page: page as never, criterion });
    expect(verdict.status).toBe('pass');
  });

  it('an element-scoped press dispatches locator.press (not page.keyboard)', async () => {
    const presses: string[] = [];
    const page = makeFakePage({
      press: async () => {
        presses.push('Enter');
      },
    });
    const [v] = await executeChecks({
      page: page as never,
      checks: [{ press: { key: 'Enter', selector: { label: 'Email' } } }],
    });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/pressed Enter in/);
    expect(presses).toEqual(['Enter']);
    expect((page as { presses: string[] }).presses).toEqual([]);
  });
});

describe('wait / waitForRequest / select / scroll', () => {
  it('wait { ms } passes after sleeping', async () => {
    const page = makeFakePage();
    const [v] = await executeChecks({
      page: page as never,
      checks: [{ wait: { ms: 1 } }],
    });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/waited 1ms/);
  });

  it('wait { for, visible } passes when waitFor resolves', async () => {
    const page = makeFakePage({ waitFor: async () => undefined });
    const [v] = await executeChecks({
      page: page as never,
      checks: [{ wait: { for: { text: 'Saved' }, state: 'visible' } }],
    });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/waited for/);
  });

  it("wait { for } timeout is fail, never pass (can't-false-green)", async () => {
    const page = makeFakePage({
      waitFor: async () => {
        throw new Error('Timeout 5000ms exceeded.');
      },
    });
    const [v] = await executeChecks({
      page: page as never,
      checks: [{ wait: { for: { text: 'Never' }, state: 'visible' } }],
    });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/timed out waiting/);
  });

  it("waitForRequest with no matching request fails after timeout (can't-false-green)", async () => {
    const page = makeFakePage();
    const [v] = await executeChecks({
      page: page as never,
      checks: [{ waitForRequest: { url: '/api/never', method: 'POST' } }],
    });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/no request observed/);
    expect(v.status).not.toBe('pass');
  });

  it('waitForRequest passes when the in-page request log already has a match', async () => {
    const logPage = makeFakePage();
    (logPage as Record<string, unknown>).evaluate = async () => [
      { method: 'POST', url: 'http://localhost/api/save', status: 200 },
    ];
    const [ok] = await executeChecks({
      page: logPage as never,
      checks: [{ waitForRequest: { url: '/api/save', method: 'POST' } }],
    });
    expect(ok.status).toBe('pass');
    expect(ok.detail).toMatch(/POST/);
  });

  it('select on a native <select> passes', async () => {
    const selected: unknown[] = [];
    const page = makeFakePage({
      evaluate: async () => 'SELECT',
      selectOption: async (...args: unknown[]) => {
        selected.push(args[0]);
      },
    });
    const [v] = await executeChecks({
      page: page as never,
      checks: [{ select: { selector: { label: 'Country' }, option: 'US' } }],
    });
    expect(v.status).toBe('pass');
    expect(selected).toEqual(['US']);
  });

  it("select on a non-select fails honestly (can't-false-green)", async () => {
    const page = makeFakePage({ evaluate: async () => 'DIV' });
    const [v] = await executeChecks({
      page: page as never,
      checks: [{ select: { selector: { role: 'button', name: 'Country' }, option: 'US' } }],
    });
    expect(v.status).toBe('fail');
    expect(v.detail).toBe('not a native select — use click + click on the option');
  });

  it('scroll intoView passes', async () => {
    const page = makeFakePage();
    const [v] = await executeChecks({
      page: page as never,
      checks: [{ scroll: { selector: { text: 'Footer' }, intoView: true } }],
    });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/into view/);
  });

  it('scroll to bottom on the page passes', async () => {
    const page = makeFakePage() as Record<string, unknown>;
    page.evaluate = async () => undefined;
    const [v] = await executeChecks({
      page: page as never,
      checks: [{ scroll: { to: 'bottom' } }],
    });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/to bottom/);
  });
});

describe('expect.performance', () => {
  // A fake page whose evaluate() exposes a __VALIDITY_GET_PERF__ returning the
  // supplied metrics — mirrors the in-page fold the real sandbox installs.
  function pageWithPerf(metrics: Record<string, number> | null) {
    const page = makeFakePage();
    (page as Record<string, unknown>).evaluate = async (fn: () => unknown) => {
      const prev = (globalThis as Record<string, unknown>).window;
      (globalThis as Record<string, unknown>).window = {
        __VALIDITY_GET_PERF__: metrics ? () => metrics : undefined,
      };
      try {
        return fn();
      } finally {
        (globalThis as Record<string, unknown>).window = prev;
      }
    };
    return page;
  }

  it('passes when the measured metric is within budget', async () => {
    const page = pageWithPerf({ readyMs: 420 });
    const checks: Check[] = [{ expect: { performance: { metric: 'ready', maxMs: 1000 } } }];
    const [v] = await executeChecks({ page: page as never, checks });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/420ms ≤ budget 1000ms/);
  });

  it('fails when the measured metric exceeds budget', async () => {
    const page = pageWithPerf({ updateMs: 90 });
    const checks: Check[] = [{ expect: { performance: { metric: 'update', maxMs: 50 } } }];
    const [v] = await executeChecks({ page: page as never, checks });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/90ms exceeds budget 50ms/);
  });

  it('is unverifiable when the metric was not measured', async () => {
    const page = pageWithPerf({ readyMs: 100 }); // no mountMs captured
    const checks: Check[] = [{ expect: { performance: { metric: 'mount', maxMs: 16 } } }];
    const [v] = await executeChecks({ page: page as never, checks });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/mount not measured/);
  });

  it('is unverifiable when no perf instrumentation is present', async () => {
    const page = pageWithPerf(null);
    const checks: Check[] = [{ expect: { performance: { metric: 'load', maxMs: 2000 } } }];
    const [v] = await executeChecks({ page: page as never, checks });
    expect(v.status).toBe('unverifiable');
  });
});

describe('runCriterionChecks', () => {
  it('folds a failing-then-unverifiable mix to fail and echoes id/tier', async () => {
    const page = makeFakePage({
      isVisible: async () => false, // makes the visible-expect fail
    });
    const criterion: SpecCriterion = {
      id: 'AC-1',
      text: 'shows an error banner',
      tier: 'hard',
      checks: [{ expect: { element: { role: 'alert', state: 'visible' } } }],
    };
    const verdict = await runCriterionChecks({ page: page as never, criterion });
    expect(verdict.id).toBe('AC-1');
    expect(verdict.tier).toBe('hard');
    expect(verdict.status).toBe('fail');
    expect(verdict.checks).toHaveLength(1);
    expect(verdict.detail).toMatch(/1 fail/);
  });

  it('an all-unverifiable criterion folds to unverifiable', async () => {
    const page = makeFakePage({
      click: async () => {
        throw new Error('strict mode violation: resolved to 2 elements');
      },
    });
    const criterion: SpecCriterion = {
      id: 'AC-2',
      text: 'clicking submit posts the form',
      tier: 'hard',
      checks: [{ click: { role: 'button', name: 'Submit' } }],
    };
    const verdict = await runCriterionChecks({ page: page as never, criterion });
    expect(verdict.status).toBe('unverifiable');
  });
});

describe('evaluateScreenshotExpects', () => {
  /** A stub screenshot verdict as the executor emits it (always unverifiable). */
  const stub = (screenshot: Record<string, unknown> = {}): CheckVerdict => ({
    check: { expect: { screenshot } } as Check,
    status: 'unverifiable',
    detail: 'no baseline exists yet for this variant',
  });

  it('passes when mismatchedPixels=0 and maxDiffPixels=0 (default)', () => {
    const out = evaluateScreenshotExpects([stub()], { mismatchedPixels: 0 });
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe('pass');
    expect(out[0]!.detail).toMatch(/0 mismatched pixels/);
  });

  it('fails when mismatchedPixels > maxDiffPixels', () => {
    const out = evaluateScreenshotExpects([stub({ maxDiffPixels: 10 })], { mismatchedPixels: 50 });
    expect(out[0]!.status).toBe('fail');
    expect(out[0]!.detail).toMatch(/50 pixels > 10 allowed/);
  });

  it('passes when mismatchedPixels equals maxDiffPixels (boundary)', () => {
    const out = evaluateScreenshotExpects([stub({ maxDiffPixels: 10 })], { mismatchedPixels: 10 });
    expect(out[0]!.status).toBe('pass');
    expect(out[0]!.detail).toMatch(/10 mismatched pixels/);
  });

  it('defaults a missing maxDiffPixels to 0 (any variance fails)', () => {
    const out = evaluateScreenshotExpects([stub()], { mismatchedPixels: 1 });
    expect(out[0]!.status).toBe('fail');
    expect(out[0]!.detail).toMatch(/1 pixels > 0 allowed/);
  });

  it('fails loudly on a huge full-screen diff', () => {
    const out = evaluateScreenshotExpects([stub({ maxDiffPixels: 0 })], {
      mismatchedPixels: 1_024_000,
    });
    expect(out[0]!.status).toBe('fail');
    expect(out[0]!.detail).toMatch(/1024000 pixels > 0 allowed/);
  });

  it('leaves non-screenshot checks unchanged', () => {
    const elementVerdict: CheckVerdict = {
      check: { expect: { element: { role: 'alert', state: 'visible' } } } as Check,
      status: 'pass',
      detail: 'alert is visible',
    };
    const out = evaluateScreenshotExpects([elementVerdict], { mismatchedPixels: 999 });
    expect(out[0]).toBe(elementVerdict);
  });

  it('leaves a non-expect (action) check unchanged', () => {
    const clickVerdict: CheckVerdict = {
      check: { click: { role: 'button', name: 'Submit' } } as Check,
      status: 'pass',
      detail: 'clicked Submit',
    };
    const out = evaluateScreenshotExpects([clickVerdict], { mismatchedPixels: 5 });
    expect(out[0]).toBe(clickVerdict);
  });

  it('upgrades only the screenshot verdicts in a mixed array', () => {
    const elementVerdict: CheckVerdict = {
      check: { expect: { element: { role: 'alert', state: 'visible' } } } as Check,
      status: 'pass',
      detail: 'alert is visible',
    };
    const out = evaluateScreenshotExpects([elementVerdict, stub({ maxDiffPixels: 0 })], {
      mismatchedPixels: 0,
    });
    expect(out[0]).toBe(elementVerdict);
    expect(out[1]!.status).toBe('pass');
    expect(out[1]!.detail).toMatch(/0 mismatched pixels/);
  });
});

describe('refoldAfterScreenshot (network-taint stickiness)', () => {
  // A passing screenshot check, as evaluateScreenshotExpects would produce.
  const screenshotPass: CheckVerdict = {
    check: { expect: { screenshot: {} } } as Check,
    status: 'pass',
    detail: 'screenshot baseline match: 0 mismatched pixels',
  };
  const screenshotFail: CheckVerdict = {
    check: { expect: { screenshot: {} } } as Check,
    status: 'fail',
    detail: 'screenshot baseline mismatch: 50 pixels > 0 allowed',
  };
  // A network expect that the executor recorded as a pass (it folded clean
  // before taint demotion happened at the criterion level).
  const networkPass: CheckVerdict = {
    check: { expect: { network: { url: '/api/users' } } } as Check,
    status: 'pass',
    detail: 'GET /api/users → 200 matches 2xx',
  };

  it('keeps a network-tainted criterion unverifiable even when the screenshot passes', () => {
    // The CRITICAL regression: without the sticky flag, folding [networkPass,
    // screenshotPass] yields `pass`, laundering the taint demotion away.
    const status = refoldAfterScreenshot({
      networkTainted: true,
      checks: [networkPass, screenshotPass],
    });
    expect(status).toBe('unverifiable');
  });

  it('lets a genuine screenshot fail win over the taint demotion (fail is stricter)', () => {
    const status = refoldAfterScreenshot({
      networkTainted: true,
      checks: [networkPass, screenshotFail],
    });
    expect(status).toBe('fail');
  });

  it('folds normally (pass) when the criterion was not network-tainted', () => {
    const status = refoldAfterScreenshot({
      networkTainted: false,
      checks: [networkPass, screenshotPass],
    });
    expect(status).toBe('pass');
  });

  it('treats an absent networkTainted flag as untainted', () => {
    const status = refoldAfterScreenshot({ checks: [networkPass, screenshotPass] });
    expect(status).toBe('pass');
  });

  it("CAN'T FALSE-GREEN: a passing screenshot cannot launder a wrapper taint", () => {
    // The verdict was tainted because it rendered under a degraded wrapper
    // clone — a screenshot pass upgraded later must not lift it back to pass.
    const status = refoldAfterScreenshot({
      evidenceTaints: ['wrapper'],
      checks: [screenshotPass],
    });
    expect(status).toBe('unverifiable');
  });

  it('a genuine screenshot fail still wins over a wrapper taint (fail is stricter)', () => {
    const status = refoldAfterScreenshot({
      evidenceTaints: ['wrapper'],
      checks: [screenshotFail],
    });
    expect(status).toBe('fail');
  });

  it('synthetic-data alone is PROVENANCE-ONLY — a clean fold stays pass', () => {
    const status = refoldAfterScreenshot({
      evidenceTaints: ['synthetic-data'],
      checks: [networkPass, screenshotPass],
    });
    expect(status).toBe('pass');
  });

  it('declared-provenance network evidence (A4) is not a taint — the refold still reaches pass', () => {
    // Sibling of the sticky cases above: a declared-mock pass carries
    // networkEvidence but NO taint, so the screenshot upgrade folds normally.
    const declaredPass: CheckVerdict = {
      ...networkPass,
      networkEvidence: {
        provenance: 'declared',
        method: 'GET',
        url: '/api/users',
        status: 200,
        handlerUrl: '/api/users',
      },
    };
    const status = refoldAfterScreenshot({ checks: [declaredPass, screenshotPass] });
    expect(status).toBe('pass');
  });
});

describe('isTaintedByNetworkExpect', () => {
  // The function takes the internal ObservedResponse[]; build plain rows and let
  // the signature widen them. `matched: true` is the untainted default.
  type Row = {
    method: string;
    url: string;
    status: number;
    permissive?: boolean;
    matched?: boolean;
  };
  const run = (rows: Row[], want: { url: string; method?: 'GET' | 'POST' }) =>
    isTaintedByNetworkExpect(rows as never, want as never);

  it('an empty response set is not tainted', () => {
    expect(run([], { url: '/api/users', method: 'GET' })).toEqual({ tainted: false, reasons: [] });
  });

  it('a matched, non-permissive response is not tainted', () => {
    const out = run(
      [{ method: 'GET', url: '/api/users', status: 200, matched: true, permissive: false }],
      { url: '/api/users', method: 'GET' },
    );
    expect(out).toEqual({ tainted: false, reasons: [] });
  });

  it('an unmatched response matching the expect is tainted with an unmatched reason', () => {
    const out = run(
      [{ method: 'GET', url: '/api/users', status: 599, matched: false, permissive: false }],
      { url: '/api/users', method: 'GET' },
    );
    expect(out.tainted).toBe(true);
    expect(out.reasons).toEqual(['unmatched GET /api/users; status 599']);
  });

  it('a permissive response matching the expect is tainted with a permissive reason', () => {
    const out = run(
      [{ method: 'GET', url: '/api/users', status: 200, matched: true, permissive: true }],
      { url: '/api/users', method: 'GET' },
    );
    expect(out.tainted).toBe(true);
    expect(out.reasons).toEqual(['permissive proxy response: GET /api/users; status 200']);
  });

  it('a response that is both permissive and unmatched lists both signals', () => {
    const out = run(
      [{ method: 'GET', url: '/api/users', status: 200, matched: false, permissive: true }],
      { url: '/api/users', method: 'GET' },
    );
    expect(out.tainted).toBe(true);
    expect(out.reasons).toEqual([
      'permissive proxy response: GET /api/users; status 200',
      'unmatched GET /api/users; status 200',
    ]);
  });

  it('ignores a response whose URL does not match the expect', () => {
    const out = run(
      [{ method: 'GET', url: '/api/posts', status: 200, matched: false, permissive: true }],
      { url: '/api/users', method: 'GET' },
    );
    expect(out).toEqual({ tainted: false, reasons: [] });
  });

  it('ignores a response whose method does not match the expect', () => {
    const out = run(
      [{ method: 'POST', url: '/api/users', status: 200, matched: false, permissive: true }],
      { url: '/api/users', method: 'GET' },
    );
    expect(out).toEqual({ tainted: false, reasons: [] });
  });

  it('lists a reason per tainted response when several match', () => {
    const out = run(
      [
        { method: 'GET', url: '/api/users', status: 200, matched: true, permissive: true },
        { method: 'GET', url: '/api/users/42', status: 200, matched: false, permissive: false },
      ],
      { url: '/api/*', method: 'GET' },
    );
    expect(out.tainted).toBe(true);
    expect(out.reasons).toEqual([
      'permissive proxy response: GET /api/users; status 200',
      'unmatched GET /api/*; status 200',
    ]);
  });

  it('treats an undefined matched flag (URL-mode / Playwright) as untainted', () => {
    const out = run([{ method: 'GET', url: '/api/users', status: 200 }], {
      url: '/api/users',
      method: 'GET',
    });
    expect(out).toEqual({ tainted: false, reasons: [] });
  });
});

describe('runCriterionChecks taint demotion', () => {
  /**
   * Fake page whose `evaluate` reads a live raw `__VALIDITY_REQUESTS__` log
   * carrying `permissive`/`matched` flags — mirrors readInPageRequests against
   * the real in-page log. `onClick` lets a test append this criterion's own
   * request so it lands after the snapshot index.
   */
  function pageWithLog(
    log: Array<{
      method: string;
      url: string;
      status: number;
      permissive?: boolean;
      matched?: boolean;
    }>,
    actions: Record<string, () => Promise<unknown>> = {},
  ) {
    const page = makeFakePage(actions);
    (page as Record<string, unknown>).evaluate = async (fn: () => unknown) => {
      const prev = (globalThis as Record<string, unknown>).window;
      (globalThis as Record<string, unknown>).window = { __VALIDITY_REQUESTS__: log };
      try {
        return fn();
      } finally {
        (globalThis as Record<string, unknown>).window = prev;
      }
    };
    (page as Record<string, unknown>).waitForTimeout = async () => undefined;
    return page;
  }

  it('demotes a passing expect.network over a permissive response to unverifiable', async () => {
    const log: Array<{
      method: string;
      url: string;
      status: number;
      permissive?: boolean;
      matched?: boolean;
    }> = [];
    const page = pageWithLog(log, {
      click: async () => {
        log.push({
          method: 'GET',
          url: '/api/users',
          status: 200,
          permissive: true,
          matched: false,
        });
      },
    });
    const criterion: SpecCriterion = {
      id: 'AC-net',
      text: 'loads the user list',
      tier: 'hard',
      checks: [
        { click: { role: 'button', name: 'Load' } },
        { expect: { network: { method: 'GET', url: '/api/users', status: '2xx' } } },
      ],
    };
    const verdict = await runCriterionChecks({ page: page as never, criterion });
    expect(verdict.status).toBe('unverifiable');
    // A4 evidence attribution: the reason names the DECIDING fabricated
    // response (the old predicate-wide "permissive proxy response" phrasing is
    // the no-evidence fallback path's).
    expect(verdict.detail).toMatch(/fabricated response: GET \/api\/users; status 200/);
    expect(verdict.networkProvenance).toBe('fabricated');
    // Sticky marker so a later re-fold (capture.ts screenshot upgrade) can't
    // launder this demotion back into a pass. DUAL-WRITTEN: the legacy boolean
    // keeps an older reader's refold sticky, and the unified evidenceTaints
    // list is what new readers consume — both must be present.
    expect(verdict.networkTainted).toBe(true);
    expect(verdict.evidenceTaints).toEqual(['network']);
  });

  it('leaves a passing expect.network over a real (matched) response as pass', async () => {
    const log: Array<{
      method: string;
      url: string;
      status: number;
      permissive?: boolean;
      matched?: boolean;
    }> = [];
    const page = pageWithLog(log, {
      click: async () => {
        log.push({
          method: 'GET',
          url: '/api/users',
          status: 200,
          permissive: false,
          matched: true,
        });
      },
    });
    const criterion: SpecCriterion = {
      id: 'AC-net2',
      text: 'loads the user list from a real handler',
      tier: 'hard',
      checks: [
        { click: { role: 'button', name: 'Load' } },
        { expect: { network: { method: 'GET', url: '/api/users', status: '2xx' } } },
      ],
    };
    const verdict = await runCriterionChecks({ page: page as never, criterion });
    expect(verdict.status).toBe('pass');
    expect(verdict.detail).not.toMatch(/tainted/);
    // Old-bundle entry (matched flag, no provenance/handlerUrl): derived
    // declared, so the positive rollup lands even without the pattern.
    expect(verdict.networkProvenance).toBe('declared');
    expect(verdict.detail).toMatch(/proven against declared mock/);
  });

  it('does not demote a failing status mismatch — a fail stays fail', async () => {
    const log: Array<{
      method: string;
      url: string;
      status: number;
      permissive?: boolean;
      matched?: boolean;
    }> = [];
    const page = pageWithLog(log, {
      click: async () => {
        // Permissive (tainted) but the status does NOT satisfy the expect.
        log.push({
          method: 'GET',
          url: '/api/users',
          status: 500,
          permissive: true,
          matched: false,
        });
      },
    });
    const criterion: SpecCriterion = {
      id: 'AC-net3',
      text: 'loads the user list',
      tier: 'hard',
      checks: [
        { click: { role: 'button', name: 'Load' } },
        { expect: { network: { method: 'GET', url: '/api/users', status: '2xx' } } },
      ],
    };
    const verdict = await runCriterionChecks({ page: page as never, criterion });
    expect(verdict.status).toBe('fail');
    expect(verdict.detail).not.toMatch(/tainted/);
  });

  it('keeps a cascading unverifiable verdict (prior action) without appending taint reasons', async () => {
    // No `evaluate` → the expect.network resolves immediately (canPoll=false)
    // and taint detection's in-page read returns [] — the cascading
    // unverifiable from the un-driven click is the sole, primary reason.
    const page = makeFakePage({
      // The click can't be driven → prior action unverifiable; the network
      // request is never fired, so the expect.network is unverifiable too.
      click: async () => {
        throw new Error('Timeout 5000ms exceeded.\nwaiting for getByRole...');
      },
    });
    const criterion: SpecCriterion = {
      id: 'AC-net4',
      text: 'loads the user list after clicking',
      tier: 'hard',
      checks: [
        { click: { role: 'button', name: 'Load' } },
        { expect: { network: { method: 'GET', url: '/api/users', status: '2xx' } } },
      ],
    };
    const verdict = await runCriterionChecks({ page: page as never, criterion });
    expect(verdict.status).toBe('unverifiable');
    // Cascading is primary; we do NOT override it with taint reasons.
    expect(verdict.detail).not.toMatch(/tainted/);
    expect(verdict.checks?.[1]!.detail).toMatch(/prior action was unverifiable/);
  });

  it('does not taint a criterion with no network checks', async () => {
    const log = [
      { method: 'GET', url: '/api/users', status: 200, permissive: true, matched: false },
    ];
    const page = pageWithLog(log, { isVisible: async () => true });
    const criterion: SpecCriterion = {
      id: 'AC-el',
      text: 'shows the heading',
      tier: 'hard',
      checks: [{ expect: { element: { role: 'heading', state: 'visible' } } }],
    };
    const verdict = await runCriterionChecks({ page: page as never, criterion });
    expect(verdict.status).toBe('pass');
    expect(verdict.detail).not.toMatch(/tainted/);
  });
});

/* ------------------------------------------------------------------ *
 * A4 — declared-mock network provenance.                              *
 * ------------------------------------------------------------------ */
describe('network provenance (A4)', () => {
  /**
   * Fake page exposing the NEW in-page contract: the frozen
   * `__VALIDITY_GET_REQUESTS__` closure getter over `getter`, PLUS the mutable
   * `__VALIDITY_REQUESTS__` mirror (`windowArray`) that forged entries land in.
   * Omitting `getter` simulates a stale bundle (window-array fallback).
   */
  function pageWithSources(
    sources: {
      getter?: Array<Record<string, unknown>>;
      windowArray?: Array<Record<string, unknown>>;
    },
    actions: Record<string, () => Promise<unknown>> = {},
  ) {
    const page = makeFakePage(actions);
    (page as Record<string, unknown>).evaluate = async (fn: () => unknown) => {
      const prev = (globalThis as Record<string, unknown>).window;
      (globalThis as Record<string, unknown>).window = {
        ...(sources.getter
          ? { __VALIDITY_GET_REQUESTS__: () => sources.getter!.map((e) => ({ ...e })) }
          : {}),
        __VALIDITY_REQUESTS__: sources.windowArray ?? [],
      };
      try {
        return fn();
      } finally {
        (globalThis as Record<string, unknown>).window = prev;
      }
    };
    (page as Record<string, unknown>).waitForTimeout = async () => undefined;
    return page;
  }

  const declaredEntry = (url = '/api/send', handlerUrl = '/api/send') => ({
    method: 'POST',
    url,
    status: 200,
    matched: true,
    permissive: false,
    provenance: 'declared',
    handlerUrl,
  });
  const fabricatedEntry = (url = '/api/other', status = 200) => ({
    method: 'POST',
    url,
    status,
    matched: false,
    permissive: true,
    provenance: 'fabricated',
  });

  const networkCriterion = (url: string): SpecCriterion => ({
    id: 'AC-a4',
    text: 'sends the message',
    tier: 'hard',
    checks: [
      { click: { role: 'button', name: 'Send' } },
      { expect: { network: { method: 'POST', url, status: '2xx' } } },
    ],
  });

  it('readInPageRequests derives provenance for old-bundle entries and demotes catch-all handlerUrls', async () => {
    const page = pageWithSources({
      getter: [
        { method: 'GET', url: '/a', status: 200, matched: true, permissive: false }, // old shape → declared
        { method: 'GET', url: '/b', status: 200, matched: false, permissive: true }, // fallback → fabricated
        { method: 'GET', url: '/c', status: 200 }, // no flags → unknown (live)
        declaredEntry('/d', '*'), // claimed declared via a catch-all → demoted
        { ...declaredEntry('/e'), permissive: true }, // permissive can never be declared
      ],
    });
    const out = await readInPageRequests(page as never);
    expect(out.map((r) => r.provenance)).toEqual([
      'declared',
      'fabricated',
      undefined,
      'fabricated',
      'fabricated',
    ]);
    // The demoted catch-all keeps its pattern for the reason strings.
    expect(out[3]!.handlerUrl).toBe('*');
  });

  it('a declared handler hit passes with positive evidence (handler pattern cited, no taint)', async () => {
    const log: Array<Record<string, unknown>> = [];
    const page = pageWithSources(
      { getter: log },
      { click: async () => void log.push(declaredEntry()) },
    );
    const verdict = await runCriterionChecks({
      page: page as never,
      criterion: networkCriterion('/api/send'),
    });
    expect(verdict.status).toBe('pass');
    expect(verdict.networkTainted).toBeUndefined();
    expect(verdict.networkProvenance).toBe('declared');
    expect(verdict.detail).toMatch(/proven against declared mock/);
    const netCheck = verdict.checks?.[1];
    expect(netCheck?.networkEvidence).toEqual({
      provenance: 'declared',
      method: 'POST',
      url: '/api/send',
      status: 200,
      handlerUrl: '/api/send',
    });
    expect(netCheck?.detail).toMatch(/handler '\/api\/send' in \.validity\/config\.ts/);
  });

  it('mixed traffic under a wildcard expect: the declared hit DECIDES, unrelated fabricated traffic no longer taints', async () => {
    // Semantic change vs the predicate-wide taint (documented in the A4
    // design): the assertion is existential and the winner that proves it is
    // attributable and declared — the fabricated response never decided it.
    const log: Array<Record<string, unknown>> = [];
    const page = pageWithSources(
      { getter: log },
      {
        click: async () => {
          log.push(fabricatedEntry('/api/other'));
          log.push(declaredEntry('/api/send'));
        },
      },
    );
    const verdict = await runCriterionChecks({
      page: page as never,
      criterion: networkCriterion('/api/*'),
    });
    expect(verdict.status).toBe('pass');
    expect(verdict.networkProvenance).toBe('declared');
    expect(verdict.checks?.[1]?.networkEvidence?.provenance).toBe('declared');
  });

  it("CAN'T FALSE-GREEN (forgery): a forged declared entry in the window array is inert — the frozen getter decides", async () => {
    const real: Array<Record<string, unknown>> = [];
    const forged: Array<Record<string, unknown>> = [];
    const page = pageWithSources(
      { getter: real, windowArray: forged },
      {
        click: async () => {
          // What actually happened: the fallback fabricated the response.
          real.push(fabricatedEntry('/api/send'));
          // What the component (agent-authored, same JS realm) forged:
          forged.push(declaredEntry('/api/send'));
        },
      },
    );
    const verdict = await runCriterionChecks({
      page: page as never,
      criterion: networkCriterion('/api/send'),
    });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.networkTainted).toBe(true);
    expect(verdict.evidenceTaints).toEqual(['network']);
    expect(verdict.networkProvenance).toBe('fabricated');
    expect(verdict.detail).toMatch(/fabricated response: POST \/api\/send/);
  });

  it("CAN'T FALSE-GREEN (catch-all): a declared hit through a catch-all handler pattern is fabricated, reason names the pattern", async () => {
    const log: Array<Record<string, unknown>> = [];
    const page = pageWithSources(
      { getter: log },
      { click: async () => void log.push(declaredEntry('/api/send', '*')) },
    );
    const verdict = await runCriterionChecks({
      page: page as never,
      criterion: networkCriterion('/api/send'),
    });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.networkTainted).toBe(true);
    expect(verdict.detail).toMatch(/catch-all handler '\*' is not endpoint-specific evidence/);
  });

  it('a status-mismatch fail is stamped with the deciding evidence but stays a fail', async () => {
    const log: Array<Record<string, unknown>> = [];
    const page = pageWithSources(
      { getter: log },
      { click: async () => void log.push(fabricatedEntry('/api/send', 500)) },
    );
    const verdict = await runCriterionChecks({
      page: page as never,
      criterion: networkCriterion('/api/send'),
    });
    expect(verdict.status).toBe('fail');
    expect(verdict.checks?.[1]?.networkEvidence).toEqual({
      provenance: 'fabricated',
      method: 'POST',
      url: '/api/send',
      status: 500,
    });
    expect(verdict.networkTainted).toBeUndefined();
  });

  it('Playwright-observed (URL-mode) evidence reads live and never claims declared', async () => {
    // No in-page log at all — the response arrives via page.on('response').
    // makeFakePage has no evaluate → the expect branch sees only `responses`.
    const page = makeFakePage();
    (page as Record<string, unknown>).on = (
      event: string,
      cb: (r: { request(): { method(): string }; url(): string; status(): number }) => void,
    ) => {
      if (event === 'response') {
        cb({
          request: () => ({ method: () => 'POST' }),
          url: () => '/api/send',
          status: () => 200,
        });
      }
    };
    const criterion: SpecCriterion = {
      id: 'AC-live',
      text: 'sends live',
      tier: 'hard',
      checks: [{ expect: { network: { method: 'POST', url: '/api/send', status: '2xx' } } }],
    };
    const verdict = await runCriterionChecks({ page: page as never, criterion });
    expect(verdict.status).toBe('pass');
    expect(verdict.networkProvenance).toBe('live');
    expect(verdict.checks?.[0]?.networkEvidence?.provenance).toBe('live');
    expect(verdict.detail).not.toMatch(/declared mock/);
  });
});

describe('deriveRenderDataProvenance (A4 — display-only render summary)', () => {
  const r = (over: Partial<ObservedResponse>): ObservedResponse => ({
    method: 'GET',
    url: '/api/x',
    status: 200,
    ...over,
  });

  it('undefined when nothing classifiable was observed', () => {
    expect(deriveRenderDataProvenance([])).toBeUndefined();
    expect(deriveRenderDataProvenance([r({})])).toBeUndefined();
  });

  it('declared hit ⇒ declared-mock; permissive/unmatched ⇒ proxy-fallback; both coexist', () => {
    expect(deriveRenderDataProvenance([r({ provenance: 'declared' })])).toEqual(['declared-mock']);
    expect(deriveRenderDataProvenance([r({ provenance: 'fabricated' })])).toEqual([
      'proxy-fallback',
    ]);
    expect(deriveRenderDataProvenance([r({ permissive: true })])).toEqual(['proxy-fallback']);
    expect(deriveRenderDataProvenance([r({ matched: false })])).toEqual(['proxy-fallback']);
    expect(
      deriveRenderDataProvenance([r({ provenance: 'declared' }), r({ provenance: 'fabricated' })]),
    ).toEqual(['declared-mock', 'proxy-fallback']);
  });
});

/* ------------------------------------------------------------------ *
 * expect.a11y — pure verdict arithmetic (no browser needed).          *
 * ------------------------------------------------------------------ */
describe('countA11yViolations', () => {
  const violations = [
    { impact: 'minor' },
    { impact: 'moderate' },
    { impact: 'serious' },
    { impact: 'critical' },
    { impact: 'critical' },
  ];

  it('critical floor drops serious and below', () => {
    expect(countA11yViolations(violations, 'critical')).toBe(2);
  });
  it('serious floor keeps serious + critical', () => {
    expect(countA11yViolations(violations, 'serious')).toBe(3);
  });
  it('moderate floor adds moderate', () => {
    expect(countA11yViolations(violations, 'moderate')).toBe(4);
  });
  it('minor floor keeps all four impacts', () => {
    expect(countA11yViolations(violations, 'minor')).toBe(5);
  });
  it('does NOT count an unrecognized (non-null) impact string', () => {
    // `unknown` is a real string, so `?? 'minor'` leaves it as-is — and it is in
    // no keep-set, mirroring a11y.ts which also only coalesces null/undefined.
    expect(countA11yViolations([{ impact: 'unknown' }, { impact: 'critical' }], 'minor')).toBe(1);
    expect(countA11yViolations([{ impact: 'unknown' }, { impact: 'critical' }], 'serious')).toBe(1);
  });
  it('treats an ungraded (null/absent) impact as minor — parity with a11y.ts + the Playwright export', () => {
    // At the `minor` floor an ungraded violation counts (gate >= exported test);
    // at higher floors it does not, so the default `serious` floor is unaffected.
    expect(countA11yViolations([{}, { impact: 'critical' }], 'minor')).toBe(2);
    expect(countA11yViolations([{}, { impact: 'critical' }], 'serious')).toBe(1);
  });
  it('returns 0 for an empty list regardless of severity', () => {
    expect(countA11yViolations([], 'critical')).toBe(0);
    expect(countA11yViolations([], 'minor')).toBe(0);
  });
});

describe('a11yImpactsToKeep', () => {
  it('nests each floor inside the next-looser one', () => {
    expect([...a11yImpactsToKeep('critical')]).toEqual(['critical']);
    expect([...a11yImpactsToKeep('serious')].sort()).toEqual(['critical', 'serious']);
    expect([...a11yImpactsToKeep('minor')].sort()).toEqual([
      'critical',
      'minor',
      'moderate',
      'serious',
    ]);
  });
});

describe('a11yVerdict', () => {
  it('0 violations within a 0 budget → pass', () => {
    const v = a11yVerdict([], { severity: 'serious', maxViolations: 0 });
    expect(v.status).toBe('pass');
    expect(v.count).toBe(0);
  });

  // FALSE-GREEN NEGATIVE: proves an over-budget a11y assertion can actually FAIL.
  it('3 serious violations over a 0 budget → fail (can-fail proof)', () => {
    const v = a11yVerdict(
      [
        { impact: 'serious', id: 'color-contrast' },
        { impact: 'serious', id: 'label' },
        { impact: 'critical', id: 'button-name' },
      ],
      { severity: 'serious', maxViolations: 0 },
    );
    expect(v.status).toBe('fail');
    expect(v.count).toBe(3);
    expect(v.ruleIds).toEqual(['color-contrast', 'label', 'button-name']);
  });

  it('count == maxViolations boundary → pass', () => {
    const v = a11yVerdict([{ impact: 'serious', id: 'label' }], { maxViolations: 1 });
    expect(v.status).toBe('pass');
  });
  it('count == maxViolations + 1 → fail', () => {
    const v = a11yVerdict([{ impact: 'serious', id: 'label' }, { impact: 'critical' }], {
      maxViolations: 1,
    });
    expect(v.status).toBe('fail');
  });

  it('applies the schema defaults (severity serious, maxViolations 0) when omitted', () => {
    // A lone minor violation is BELOW the default serious floor → not counted.
    expect(a11yVerdict([{ impact: 'minor', id: 'region' }], {}).status).toBe('pass');
    // A serious violation breaches the default 0 budget.
    expect(a11yVerdict([{ impact: 'serious', id: 'label' }], {}).status).toBe('fail');
  });
});

/* ------------------------------------------------------------------ *
 * expect.a11y — driven through the executor (AxeBuilder mocked).       *
 * ------------------------------------------------------------------ */
describe('executeChecks expect.a11y', () => {
  it('a clean axe run within budget passes', async () => {
    axeState.violations = [];
    axeState.throw = false;
    const page = makeFakePage();
    const checks: Check[] = [{ expect: { a11y: { severity: 'serious', maxViolations: 0 } } }];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('pass');
  });

  // CAN-FAIL through the real branch: an over-budget violation is a hard fail.
  it('an over-budget violation is a genuine fail with the rule id', async () => {
    axeState.violations = [{ impact: 'critical', id: 'button-name' }];
    axeState.throw = false;
    const page = makeFakePage();
    const checks: Check[] = [{ expect: { a11y: { severity: 'serious', maxViolations: 0 } } }];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('fail');
    expect(verdicts[0].detail).toMatch(/button-name/);
  });

  // FALSE-GREEN guard: axe passing on a page whose post-interaction state was
  // never reached (a prior click was unverifiable) must NOT green the budget.
  it('demotes a passing axe run to unverifiable when a prior action was unverifiable', async () => {
    axeState.violations = [];
    axeState.throw = false;
    const page = makeFakePage({
      click: async () => {
        throw new Error('Timeout 5000ms exceeded.\nwaiting for getByRole...');
      },
    });
    const checks: Check[] = [
      { click: { role: 'button', name: 'Open dialog' } },
      { expect: { a11y: { severity: 'serious', maxViolations: 0 } } },
    ];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('unverifiable');
    expect(verdicts[1].status).toBe('unverifiable');
    expect(verdicts[1].detail).toMatch(/prior action was unverifiable/);
  });

  // A real violation still FAILS even after an unverifiable prior action — the
  // cascade only demotes a would-be pass, never launders a fail into a pass.
  it('a real violation still fails even after an unverifiable prior action', async () => {
    axeState.violations = [{ impact: 'critical', id: 'button-name' }];
    axeState.throw = false;
    const page = makeFakePage({
      click: async () => {
        throw new Error('Timeout 5000ms exceeded.');
      },
    });
    const checks: Check[] = [
      { click: { role: 'button', name: 'Open dialog' } },
      { expect: { a11y: { severity: 'serious', maxViolations: 0 } } },
    ];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[1].status).toBe('fail');
  });

  it('axe throwing (disposed page / blocked injection) is unverifiable, never a silent pass', async () => {
    axeState.violations = [];
    axeState.throw = true;
    const page = makeFakePage();
    const checks: Check[] = [{ expect: { a11y: { maxViolations: 0 } } }];
    const verdicts = await executeChecks({ page: page as never, checks });
    expect(verdicts[0].status).toBe('unverifiable');
    expect(verdicts[0].detail).toMatch(/axe analysis failed/);
  });
});

/* ------------------------------------------------------------------ *
 * A2 — forced dataState renders: expect.network is NEVER exempt.      *
 * ------------------------------------------------------------------ */
describe('dataState-forced responses (A2)', () => {
  it('isTaintedByNetworkExpect names the forced dataState as an explicit taint reason', () => {
    const rows: ObservedResponse[] = [
      {
        method: 'GET',
        url: '/api/users',
        status: 500,
        matched: false,
        permissive: false,
        dataState: 'error',
      },
    ];
    const out = isTaintedByNetworkExpect(rows, { url: '/api/users', method: 'GET' } as never);
    expect(out.tainted).toBe(true);
    expect(out.reasons[0]).toBe(
      "response forced by dataState 'error' (synthetic by design): GET /api/users",
    );
    // Belt-and-braces: the matched:false signal still fires alongside it.
    expect(out.reasons).toContain('unmatched GET /api/users; status 500');
  });

  it('readInPageRequests carries the dataState field through from the in-page log', async () => {
    const page = makeFakePage();
    (page as Record<string, unknown>).evaluate = async (fn: () => unknown) => {
      const prev = (globalThis as Record<string, unknown>).window;
      (globalThis as Record<string, unknown>).window = {
        __VALIDITY_REQUESTS__: [
          {
            method: 'GET',
            url: '/api/items',
            status: 200,
            matched: false,
            permissive: true,
            dataState: 'empty',
          },
        ],
      };
      try {
        return fn();
      } finally {
        (globalThis as Record<string, unknown>).window = prev;
      }
    };
    const out = await readInPageRequests(page as never);
    expect(out[0]!.dataState).toBe('empty');
  });

  it("CAN'T FALSE-GREEN: a passing expect.network over forced-empty responses demotes to unverifiable and the taint is STICKY through refold", async () => {
    // Fake page whose in-page log only ever contains forced-empty entries —
    // exactly what a render under ?dataState=empty produces (permissive-tagged,
    // matched:false, dataState stamped by the MSW layer).
    const log: Array<Record<string, unknown>> = [];
    const page = makeFakePage({
      click: async () => {
        log.push({
          method: 'GET',
          url: '/api/users',
          status: 200,
          permissive: true,
          matched: false,
          dataState: 'empty',
        });
      },
    });
    (page as Record<string, unknown>).evaluate = async (fn: () => unknown) => {
      const prev = (globalThis as Record<string, unknown>).window;
      (globalThis as Record<string, unknown>).window = { __VALIDITY_REQUESTS__: log };
      try {
        return fn();
      } finally {
        (globalThis as Record<string, unknown>).window = prev;
      }
    };
    (page as Record<string, unknown>).waitForTimeout = async () => undefined;

    const criterion: SpecCriterion = {
      id: 'AC-forced',
      text: 'the list endpoint answers 2xx',
      tier: 'hard',
      dataState: 'empty',
      checks: [
        { click: { role: 'button', name: 'Load' } },
        { expect: { network: { method: 'GET', url: '/api/users', status: '2xx' } } },
      ],
    };
    const verdict = await runCriterionChecks({ page: page as never, criterion });
    // The status matched (200 vs 2xx) but the response was fabricated BY the
    // axis — self-referential proof is demoted, whatever the intent.
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.networkTainted).toBe(true);
    expect(verdict.evidenceTaints).toEqual(['network']);

    // Sticky: a later screenshot-check upgrade + refold cannot launder the
    // demotion back into a pass.
    const refolded = refoldAfterScreenshot({
      networkTainted: verdict.networkTainted,
      evidenceTaints: verdict.evidenceTaints,
      checks: (verdict.checks ?? []).map((c) =>
        c.status === 'unverifiable' ? { ...c, status: 'pass' as const } : c,
      ),
    });
    expect(refolded).toBe('unverifiable');
  });
});
