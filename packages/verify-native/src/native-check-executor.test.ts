import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Check, SpecCriterion } from '@validity.ai/verify-spec';
import type { ExecResult, NativeDriver } from './agent-device-driver.js';
import type { NativeA11yViolation } from './native-check-executor.js';
import {
  applyNativeProvenanceGuards,
  countNativeA11yViolations,
  executeNativeChecks,
  nativeA11yVerdict,
  parseA11ySnapshot,
  resolveRefs,
  runNativeCriterionChecks,
  statusMatches,
  urlMatches,
  type NativeObservedRequest,
} from './native-check-executor.js';

const ok: ExecResult = { code: 0, stdout: '', stderr: '' };

/**
 * Build a fake NativeDriver: `snapshot()` returns a canned a11y tree; the
 * action verbs are vi.fn()s returning `ok` (override per test to throw or
 * return a non-zero exit). No device involved.
 */
function fakeDriver(
  opts: {
    snapshot?: string | (() => Promise<string>);
    click?: NativeDriver['click'];
    inputText?: NativeDriver['inputText'];
    openUrl?: NativeDriver['openUrl'];
    scroll?: NativeDriver['scroll'];
  } = {},
): NativeDriver {
  const snapshot =
    typeof opts.snapshot === 'function'
      ? vi.fn(opts.snapshot)
      : vi.fn(async () => (opts.snapshot as string) ?? '');
  return {
    platform: 'ios',
    targetUrl: () => 'myapp://validity?component=x',
    openTarget: vi.fn(async () => ok),
    openUrl: opts.openUrl ?? vi.fn(async () => ok),
    openControlLink: vi.fn(async () => ok),
    dismissOverlay: vi.fn(async () => ok),
    dismissDevMenu: vi.fn(async () => false),
    click: opts.click ?? vi.fn(async () => ok),
    inputText: opts.inputText ?? vi.fn(async () => ok),
    acceptAlert: vi.fn(async () => ok),
    waitForRef: vi.fn(async () => ok),
    screenshot: vi.fn(async () => ok),
    snapshot,
    ...(opts.scroll ? { scroll: opts.scroll } : {}),
    terminateApp: vi.fn(async () => ok),
  };
}

const SNAP = [
  '# @e1 [text] "Validity"',
  '# @e2 [button] "Submit"',
  '# @e3 [textbox] "Email address"',
  '# @e4 [button] "Submit"',
].join('\n');

describe('parseA11ySnapshot', () => {
  it('parses `# @eNN [role] "label"` lines into ref/role/name', () => {
    expect(parseA11ySnapshot('# @e2 [button] "Submit"')).toEqual([
      { ref: '@e2', role: 'button', name: 'Submit' },
    ]);
  });

  it('parses a multi-line tree and tolerates blank/garbage lines', () => {
    const text = ['', '# @e1 [text] "Validity"', 'not a node', '   ', '# @e2 [button] "Go"'].join(
      '\n',
    );
    expect(parseA11ySnapshot(text)).toEqual([
      { ref: '@e1', role: 'text', name: 'Validity' },
      { ref: '@e2', role: 'button', name: 'Go' },
    ]);
  });

  it('lower-cases the role and allows an empty label', () => {
    expect(parseA11ySnapshot('# @e9 [BUTTON] ""')).toEqual([
      { ref: '@e9', role: 'button', name: '' },
    ]);
  });
});

describe('resolveRefs', () => {
  const els = parseA11ySnapshot(SNAP);

  it('matches on role + exact name', () => {
    expect(resolveRefs(els, { role: 'button', name: 'Submit' })).toEqual(['@e2', '@e4']);
  });

  it('matches a name substring (case-insensitive)', () => {
    expect(resolveRefs(els, { role: 'textbox', name: 'email' })).toEqual(['@e3']);
    expect(resolveRefs(els, { text: 'valid' })).toEqual(['@e1']);
  });

  it('respects the role filter (no cross-role matches)', () => {
    expect(resolveRefs(els, { role: 'text', name: 'Submit' })).toEqual([]);
  });

  it('yields [] for a testId-only selector (no test-id channel in the tree)', () => {
    expect(resolveRefs(els, { testId: 'submit-btn' })).toEqual([]);
  });

  it('applies nth last', () => {
    expect(resolveRefs(els, { role: 'button', name: 'Submit', nth: 1 })).toEqual(['@e4']);
    expect(resolveRefs(els, { role: 'button', name: 'Submit', nth: 5 })).toEqual([]);
  });

  // Both native platforms drop the `accessibilityRole="header"` trait, so a
  // heading comes through as a plain text/generic node. role=heading with a
  // name must still resolve against that node (otherwise every native heading
  // check is spuriously unverifiable), while never loosening non-heading roles.
  describe('heading-role native fallback', () => {
    const headEls = parseA11ySnapshot(
      ['# @e1 [statictext] "Welcome back"', '# @e2 [button] "Welcome back"'].join('\n'),
    );

    it('resolves role=heading name against a named text/statictext node', () => {
      expect(resolveRefs(headEls, { role: 'heading', name: 'Welcome' })).toEqual(['@e1']);
      // `header` is the same class as `heading`.
      expect(resolveRefs(headEls, { role: 'header', name: 'Welcome' })).toEqual(['@e1']);
    });

    it('does NOT let a non-heading role match a text node', () => {
      // role=button must still be strict — it only matches the real button.
      expect(resolveRefs(headEls, { role: 'button', name: 'Welcome back' })).toEqual(['@e2']);
    });

    it('keeps a bare role=heading (no name) unresolvable on iOS text nodes', () => {
      // Without a name we cannot tell a header from arbitrary text.
      expect(resolveRefs(headEls, { role: 'heading' })).toEqual([]);
    });

    it('still matches a real heading-role node when present', () => {
      const realHead = parseA11ySnapshot('# @e7 [header] "Section"');
      expect(resolveRefs(realHead, { role: 'heading', name: 'Section' })).toEqual(['@e7']);
    });

    // Android buckets the degraded header into `group`, not `text`/`other` —
    // verbatim lines from emulator-5554 rendering LoginScreen (2026-07-29).
    // spec-e221 AC-4 (`role: header name: "Log In"`) passed on iOS 26 and was
    // deterministically unverifiable on Android before `group` was covered.
    describe('Android `group` bucket', () => {
      const androidEls = parseA11ySnapshot(
        [
          '                @e26 [group] "Log In"',
          '                @e27 [text] "Welcome back. Sign in to your account to continue."',
          '                @e38 [button] "Log In"',
        ].join('\n'),
      );

      it('resolves role=header name against the degraded group node', () => {
        expect(resolveRefs(androidEls, { role: 'header', name: 'Log In' })).toEqual(['@e26']);
      });

      it('keeps role=button strict against the same snapshot', () => {
        // The button half of AC-4 must keep matching only the real button.
        expect(resolveRefs(androidEls, { role: 'button', name: 'Log In' })).toEqual(['@e38']);
      });

      it('keeps a bare role=header (no name) unresolvable', () => {
        expect(resolveRefs(androidEls, { role: 'header' })).toEqual([]);
      });
    });
  });

  it('matches a /regex/ name literal (dynamic suffix labels)', () => {
    const dyn = parseA11ySnapshot('# @e1 [button] "Toggle Theme: dark"');
    expect(resolveRefs(dyn, { role: 'button', name: '/^Toggle Theme/' })).toEqual(['@e1']);
    expect(resolveRefs(dyn, { role: 'button', name: '/^Reset/' })).toEqual([]);
  });
});

describe('statusMatches / urlMatches', () => {
  it('matches exact status and class matchers', () => {
    expect(statusMatches(200, 200)).toBe(true);
    expect(statusMatches(204, '2xx')).toBe(true);
    expect(statusMatches(500, '2xx')).toBe(false);
  });

  it('matches exact path, /x/* prefix, and full-url substring', () => {
    expect(urlMatches('https://api.test/api/contact', '/api/contact')).toBe(true);
    expect(urlMatches('https://api.test/api/users/7', '/api/*')).toBe(true);
    expect(urlMatches('https://api.test/api/contact?x=1', 'https://api.test/api/contact')).toBe(
      true,
    );
    expect(urlMatches('https://api.test/other', '/api/contact')).toBe(false);
  });
});

describe('executeNativeChecks — click', () => {
  it('resolves a ref and clicks it (pass)', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ click: { role: 'button', name: 'Submit' } }],
    });
    expect(v.status).toBe('pass');
    expect(driver.click).toHaveBeenCalledWith('@e2');
  });

  it('is unverifiable when the target is not in the tree', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ click: { role: 'button', name: 'Delete' } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/a11y tree/);
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('is unverifiable when the click exec throws', async () => {
    const driver = fakeDriver({
      snapshot: SNAP,
      click: vi.fn(async () => {
        throw new Error('device offline');
      }),
    });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ click: { role: 'button', name: 'Submit' } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/could not click/);
  });
});

describe('executeNativeChecks — fill', () => {
  it.each(['stderr', 'timeout'])(
    'redacts resolved fill secrets from %s verdict diagnostics and persisted JSON',
    async (failure) => {
      const secret = 'DUMMY_NATIVE_PRIVATE_SENTINEL';
      const driver = fakeDriver({
        snapshot: SNAP,
        inputText: async (_ref, value) => {
          expect(value).toBe(secret);
          const error = `agent-device fill failed or timed out: ${value}`;
          if (failure === 'timeout') throw new Error(error);
          return { code: 1, stdout: '', stderr: error };
        },
      });
      const verdicts = await executeNativeChecks({
        driver,
        secrets: [{ name: 'PASSWORD', env: 'TEST_PASSWORD', value: secret }],
        checks: [{ fill: { role: 'textbox', name: 'Email', value: '${PASSWORD}' } }],
      });
      expect(verdicts[0]!.status).toBe('unverifiable');
      expect(verdicts[0]!.detail).toContain('${PASSWORD}');
      expect(JSON.stringify(verdicts)).not.toContain(secret);
      const dir = mkdtempSync(resolve(tmpdir(), 'validity-secret-verdict-'));
      try {
        const path = resolve(dir, 'verdicts.json');
        writeFileSync(path, JSON.stringify(verdicts));
        expect(readFileSync(path, 'utf8')).not.toContain(secret);
        expect(JSON.parse(readFileSync(path, 'utf8'))[0].detail).toContain('${PASSWORD}');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('resolves a ref and types into it (pass)', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ fill: { role: 'textbox', name: 'Email', value: 'a@b.com' } }],
    });
    expect(v.status).toBe('pass');
    expect(driver.inputText).toHaveBeenCalledWith('@e3', 'a@b.com');
  });

  it('is unverifiable when inputText throws (agent-device has no `type`)', async () => {
    const driver = fakeDriver({
      snapshot: SNAP,
      inputText: vi.fn(async () => {
        throw new Error('unknown command: type');
      }),
    });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ fill: { role: 'textbox', name: 'Email', value: 'x' } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/native text input unavailable/);
  });

  it('is unverifiable when inputText exits non-zero (verb unsupported)', async () => {
    const driver = fakeDriver({
      snapshot: SNAP,
      inputText: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such subcommand' })),
    });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ fill: { role: 'textbox', name: 'Email', value: 'x' } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/native text input unavailable/);
  });
});

describe('executeNativeChecks — navigate', () => {
  it('passes on a successful openUrl', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ navigate: { url: '/contact' } }],
    });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/navigated to \/contact/);
    expect(driver.openUrl).toHaveBeenCalledWith('/contact');
  });

  it('passes via an injected navigate() callback instead of openUrl', async () => {
    const navigate = vi.fn(async () => {});
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      navigate,
      checks: [{ navigate: { url: '/contact' } }],
    });
    expect(v.status).toBe('pass');
    expect(navigate).toHaveBeenCalledWith('/contact');
    expect(driver.openUrl).not.toHaveBeenCalled();
  });

  // navigate is a PREREQUISITE ACTION, not an assertion. A failed navigate
  // means the flow was never driven onto the target screen — so it's
  // `unverifiable` ("couldn't test"), NOT a `fail` ("feature broken"). This is
  // the parity fix: the web executor never has a fail-able navigate CHECK.
  it('is unverifiable (not fail) when openUrl throws', async () => {
    const driver = fakeDriver({
      snapshot: SNAP,
      openUrl: vi.fn(async () => {
        throw new Error('device offline');
      }),
    });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ navigate: { url: '/contact' } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/navigation to \/contact failed/);
  });

  it('is unverifiable (not fail) when openUrl exits non-zero', async () => {
    const driver = fakeDriver({
      snapshot: SNAP,
      openUrl: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such device' })),
    });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ navigate: { url: '/contact' } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/could not change screen/);
  });

  // The cascade: a failed navigate sets priorActionUnverifiable, so the
  // following assertion is unverifiable too (not a fail) — the flow was never
  // driven. This mirrors the web executor's click/fill cascade.
  it('cascades: a downstream element fail becomes unverifiable after a failed navigate', async () => {
    const driver = fakeDriver({
      snapshot: SNAP,
      openUrl: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no such device' })),
    });
    const verdicts = await executeNativeChecks({
      driver,
      checks: [
        { navigate: { url: '/contact' } },
        { expect: { element: { role: 'text', name: 'Thanks', state: 'visible' } } },
      ],
    });
    expect(verdicts[0].status).toBe('unverifiable');
    expect(verdicts[1].status).toBe('unverifiable');
    expect(verdicts[1].detail).toMatch(/prior action was unverifiable/);
  });

  it('cascades to a click after a failed navigate', async () => {
    const driver = fakeDriver({
      snapshot: SNAP,
      openUrl: vi.fn(async () => {
        throw new Error('device offline');
      }),
    });
    const verdicts = await executeNativeChecks({
      driver,
      checks: [{ navigate: { url: '/contact' } }, { click: { role: 'button', name: 'Submit' } }],
    });
    expect(verdicts[0].status).toBe('unverifiable');
    // The click still RESOLVES + clicks (the tree is readable), so it passes on
    // its own; the cascade only downgrades assertions that would otherwise fail.
    // What matters is that the navigate failure did not become a hard fail.
    expect(verdicts[0].status).not.toBe('fail');
  });
});

describe('executeNativeChecks — expect.element', () => {
  const driver = () => fakeDriver({ snapshot: SNAP });

  it('presence: pass when present, unverifiable when absent', async () => {
    const [present] = await executeNativeChecks({
      driver: driver(),
      checks: [{ expect: { element: { role: 'text', name: 'Validity' } } }],
    });
    expect(present.status).toBe('pass');
    const [absent] = await executeNativeChecks({
      driver: driver(),
      checks: [{ expect: { element: { role: 'text', name: 'Nope' } } }],
    });
    expect(absent.status).toBe('unverifiable');
  });

  it('state visible: pass present, fail absent', async () => {
    const [vis] = await executeNativeChecks({
      driver: driver(),
      checks: [{ expect: { element: { role: 'button', name: 'Submit', state: 'visible' } } }],
    });
    expect(vis.status).toBe('pass');
    const [missing] = await executeNativeChecks({
      driver: driver(),
      checks: [{ expect: { element: { role: 'button', name: 'Ghost', state: 'visible' } } }],
    });
    expect(missing.status).toBe('fail');
  });

  it('state hidden: pass when absent, fail when present', async () => {
    const [hiddenOk] = await executeNativeChecks({
      driver: driver(),
      checks: [{ expect: { element: { role: 'button', name: 'Ghost', state: 'hidden' } } }],
    });
    expect(hiddenOk.status).toBe('pass');
    const [stillThere] = await executeNativeChecks({
      driver: driver(),
      checks: [{ expect: { element: { role: 'text', name: 'Validity', state: 'hidden' } } }],
    });
    expect(stillThere.status).toBe('fail');
  });

  it('count: 0 (absence) passes; count: N matches the tally', async () => {
    const [absent] = await executeNativeChecks({
      driver: driver(),
      checks: [{ expect: { element: { role: 'button', name: 'Ghost', count: 0 } } }],
    });
    expect(absent.status).toBe('pass');
    const [two] = await executeNativeChecks({
      driver: driver(),
      checks: [{ expect: { element: { role: 'button', name: 'Submit', count: 2 } } }],
    });
    expect(two.status).toBe('pass');
    const [wrong] = await executeNativeChecks({
      driver: driver(),
      checks: [{ expect: { element: { role: 'button', name: 'Submit', count: 1 } } }],
    });
    expect(wrong.status).toBe('fail');
  });

  it('enabled/disabled/checked are unverifiable (not encoded in the snapshot)', async () => {
    const [v] = await executeNativeChecks({
      driver: driver(),
      checks: [{ expect: { element: { role: 'button', name: 'Submit', state: 'enabled' } } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/does not encode enabled/);
  });
});

describe('executeNativeChecks — scroll-to-find (below the fold)', () => {
  // A device whose first viewport lacks the target; after one scroll-down the
  // below-the-fold node enters the a11y tree. Models RN virtualized lists.
  function scrollingDriver() {
    let scrolledDown = 0;
    const top = '# @e1 [text] "Header"';
    const afterScroll = ['# @e1 [text] "Header"', '# @e9 [button] "Contribute to Ignite"'].join(
      '\n',
    );
    const scroll = vi.fn(async (dir: 'up' | 'down') => {
      scrolledDown += dir === 'down' ? 1 : -1;
      if (scrolledDown < 0) scrolledDown = 0;
      return ok;
    });
    const driver = fakeDriver({
      snapshot: async () => (scrolledDown > 0 ? afterScroll : top),
      scroll,
    });
    return { driver, scroll, getScrolled: () => scrolledDown };
  }

  it('finds an off-screen element by scrolling, then restores the top', async () => {
    const { driver, scroll, getScrolled } = scrollingDriver();
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ expect: { element: { name: 'Contribute to Ignite' } } }],
    });
    expect(v.status).toBe('pass');
    // It scrolled down to find, then back up to restore the evidence frame.
    expect(scroll).toHaveBeenCalledWith('down');
    expect(scroll).toHaveBeenCalledWith('up');
    expect(getScrolled()).toBe(0);
  });

  it('still unverifiable when a driver has no scroll capability', async () => {
    const driver = fakeDriver({ snapshot: '# @e1 [text] "Header"' });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ expect: { element: { name: 'Contribute to Ignite' } } }],
    });
    expect(v.status).toBe('unverifiable');
  });

  it('does NOT scroll for an absence assertion (count:0)', async () => {
    const { driver, scroll } = scrollingDriver();
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ expect: { element: { name: 'Contribute to Ignite', count: 0 } } }],
    });
    // count:0 wants "not in the visible viewport" — scrolling to hunt would
    // wrongly flip a pass to a fail, so it must take a single shot.
    expect(v.status).toBe('pass');
    expect(scroll).not.toHaveBeenCalledWith('down');
  });
});

describe('executeNativeChecks — press / hover / focused (web-only, honest on native)', () => {
  it('press is unverifiable (no hardware-keyboard channel), never faked', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({ driver, checks: [{ press: 'Tab' }] });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/not executable on the native runtime/);
    expect(v.detail).toMatch(/web runtime or the Playwright export/);
  });

  it('hover is unverifiable (touch UIs have no hover state)', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ hover: { role: 'button', name: 'Submit' } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/no hover state/);
  });

  it("element state 'focused' is unverifiable (focus not in the a11y snapshot)", async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ expect: { element: { role: 'button', name: 'Submit', state: 'focused' } } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/focus state is not encoded/);
  });

  // press/hover are ACTIONS: their unverifiable verdict cascades — a downstream
  // expect that assumed the press/hover happened is unverifiable, not a fail.
  it('press cascades: a downstream element assertion becomes unverifiable', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const verdicts = await executeNativeChecks({
      driver,
      // 'Delete' is absent from SNAP → would be a genuine miss, but the prior
      // unverifiable press means we never drove the flow.
      checks: [
        { press: 'Enter' },
        { expect: { element: { role: 'button', name: 'Delete', state: 'visible' } } },
      ],
    });
    expect(verdicts[0].status).toBe('unverifiable');
    expect(verdicts[1].status).toBe('unverifiable');
    expect(verdicts[1].detail).toMatch(/prior action was unverifiable/);
  });
});

describe('executeNativeChecks — wait / waitForRequest / select / scroll', () => {
  it('wait { ms } sleeps and passes (implementable on device)', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({ driver, checks: [{ wait: { ms: 1 } }] });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/waited 1ms/);
  });

  it('wait { for, visible } passes when the element is in the a11y tree', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ wait: { for: { role: 'button', name: 'Submit' }, state: 'visible' } }],
    });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/waited for/);
  });

  it("wait { for } of a missing element fails (can't-false-green), never pass", async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ wait: { for: { role: 'button', name: 'Nope' }, state: 'visible' } }],
    });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/timed out waiting/);
  });

  it('waitForRequest with no request log is unverifiable, never pass', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ waitForRequest: { url: '/api/x' } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.status).not.toBe('pass');
    expect(v.detail).toMatch(/request log unavailable/);
  });

  it("waitForRequest with an empty log and no prior action fails (can't-false-green)", async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ waitForRequest: { url: '/api/never' } }],
      matchedRequests: [],
    });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/no request observed/);
  });

  it('waitForRequest passes on a render-time matching request', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ waitForRequest: { url: '/api/boot', method: 'GET' } }],
      matchedRequests: [{ method: 'GET', url: 'http://localhost/api/boot', status: 200 }],
    });
    expect(v.status).toBe('pass');
  });

  it('waitForRequest after a click is unverifiable even if the boot GET matches (stale log)', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const verdicts = await executeNativeChecks({
      driver,
      checks: [
        { click: { role: 'button', name: 'Submit' } },
        { waitForRequest: { url: '/api/boot', method: 'GET' } },
      ],
      matchedRequests: [{ method: 'GET', url: 'http://localhost/api/boot', status: 200 }],
    });
    expect(verdicts[0]!.status).toBe('pass');
    expect(verdicts[1]!.status).toBe('unverifiable');
    expect(verdicts[1]!.status).not.toBe('pass');
    expect(verdicts[1]!.detail).toMatch(/render time/);
  });

  it('select is unverifiable on native (pickers differ), never pass', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ select: { selector: { label: 'Country' }, option: 'US' } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.status).not.toBe('pass');
    expect(v.detail).toMatch(/pickers differ per platform/);
  });

  it('scroll intoView uses scroll-to-find when the driver can scroll', async () => {
    let scrolledDown = 0;
    const top = '# @e1 [text] "Validity"';
    const after = '# @e1 [text] "Validity"\n# @e9 [text] "Footer"';
    const scroll = vi.fn(async (dir: 'up' | 'down') => {
      scrolledDown += dir === 'down' ? 1 : -1;
      if (scrolledDown < 0) scrolledDown = 0;
      return ok;
    });
    const driver = fakeDriver({
      snapshot: async () => (scrolledDown > 0 ? after : top),
      scroll,
    });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ scroll: { selector: { text: 'Footer' }, intoView: true } }],
    });
    expect(v.status).toBe('pass');
    expect(scroll).toHaveBeenCalledWith('down');
  });

  it('scroll by pixel delta is unverifiable (no pixel wheel), never pass', async () => {
    const driver = fakeDriver({ snapshot: SNAP, scroll: vi.fn(async () => ok) });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ scroll: { by: { y: 400 } } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.status).not.toBe('pass');
    expect(v.detail).toMatch(/pixel/);
  });

  it('element-scoped press degrades the same as page-level press (never pass)', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ press: { key: 'Enter', selector: { label: 'Email' } } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.status).not.toBe('pass');
    expect(v.detail).toMatch(/no hardware-keyboard press/);
  });
});

describe('executeNativeChecks — expect.network', () => {
  const netCheck: Check = {
    expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } },
  };

  it('passes on a matching 2xx', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [netCheck],
      matchedRequests: [{ method: 'POST', url: 'https://api.test/api/contact', status: 200 }],
    });
    expect(v.status).toBe('pass');
  });

  it('fails on a status mismatch (500)', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [netCheck],
      matchedRequests: [{ method: 'POST', url: 'https://api.test/api/contact', status: 500 }],
    });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/500/);
  });

  it('fails when no candidate request was observed', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [netCheck],
      matchedRequests: [{ method: 'GET', url: 'https://api.test/other', status: 200 }],
    });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/no POST \/api\/contact/);
  });

  it('is unverifiable when the matched-request channel is absent', async () => {
    const [v] = await executeNativeChecks({ driver: fakeDriver(), checks: [netCheck] });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/matched-request channel unavailable/);
  });

  it('is unverifiable (not fail) when an ACTION preceded the network expect — native observes network only at render time', async () => {
    const verdicts = await executeNativeChecks({
      driver: fakeDriver({ snapshot: SNAP }),
      // click fires the request AFTER the render-ack observation window, so the
      // matched log (captured at render time) can't see it — that's a known
      // native limitation, not a feature failure.
      checks: [{ click: { role: 'button', name: 'Submit' } }, netCheck],
      matchedRequests: [], // channel present, but nothing matched (post-action request invisible)
    });
    expect(verdicts[0]!.status).toBe('pass'); // the click itself succeeded
    expect(verdicts[1]!.status).toBe('unverifiable');
    expect(verdicts[1]!.detail).toMatch(/render time/i);
  });
});

describe('executeNativeChecks — re-snapshot retry (native auto-wait)', () => {
  it('heals a transition race: resolves on a later snapshot, not just the first', async () => {
    // First snapshot is empty (screen still transitioning), second has the
    // element — a single-shot resolve would have spuriously failed.
    const snap = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('')
      .mockResolvedValue('# @e9 [button] "Send"');
    const driver = fakeDriver();
    driver.snapshot = snap;
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ click: { role: 'button', name: 'Send' } }],
    });
    expect(v.status).toBe('pass');
    expect(snap.mock.calls.length).toBeGreaterThan(1); // it re-snapshotted
  });

  it('does NOT wait-for-presence on an absence assertion (count:0 is single-shot)', async () => {
    const snap = vi.fn<() => Promise<string>>().mockResolvedValue('# @e1 [text] "Validity"');
    const driver = fakeDriver();
    driver.snapshot = snap;
    const [v] = await executeNativeChecks({
      driver,
      checks: [{ expect: { element: { role: 'alert', count: 0 } } }],
    });
    expect(v.status).toBe('pass'); // no alert present → count 0 holds
    expect(snap.mock.calls.length).toBe(1); // absence assertion takes one shot
  });
});

describe('executeNativeChecks — expect.console', () => {
  const consoleCheck: Check = { expect: { console: { errors: 0 } } };

  it('passes when the error count is within budget', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [consoleCheck],
      consoleErrorCount: 0,
    });
    expect(v.status).toBe('pass');
  });

  it('fails when over budget', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [consoleCheck],
      consoleErrorCount: 3,
    });
    expect(v.status).toBe('fail');
  });

  it('is unverifiable when the console channel is absent', async () => {
    const [v] = await executeNativeChecks({ driver: fakeDriver(), checks: [consoleCheck] });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/console channel unavailable/);
  });
});

describe('executeNativeChecks — expect.screenshot', () => {
  it('defers to the verify run (unverifiable — no baseline)', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [{ expect: { screenshot: {} } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/no baseline exists yet/);
  });
});

describe('executeNativeChecks — expect.command (A5 defense in depth)', () => {
  // CAN'T-FALSE-GREEN: expect.command is run-level (host-executed, once per
  // verify) and must never execute — or pass — on the device, even if the
  // run-level exclusion regresses and one leaks into a device render.
  it('an expect.command leaking onto the device is unverifiable, never pass', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [{ expect: { command: { run: 'typecheck', exitCode: 0 } } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/once per verify run at the run level/);
  });
});

describe('executeNativeChecks — expect.performance', () => {
  // Timing now rides the companion's `rendered` ack as a `perf` object (React
  // Profiler mount/update + a monotonic ready clock). The native executor
  // mirrors the web executor: map the metric to a `<metric>Ms` field and budget
  // it against maxMs. HONESTY INVARIANT: an unmeasurable metric is unverifiable,
  // never a silent pass.

  // RULE 1: load / FCP have no RN source — always unverifiable, never claimed.
  it('is unverifiable for load (no Navigation Timing analog) even with a perf object', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [{ expect: { performance: { metric: 'load', maxMs: 1000 } } }],
      perf: { readyMs: 10, mountMs: 5, commitCount: 1 },
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/not measurable on native/);
  });

  it('is unverifiable for firstContentfulPaint (no Paint Timing analog)', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [{ expect: { performance: { metric: 'firstContentfulPaint', maxMs: 1000 } } }],
      perf: { readyMs: 10, mountMs: 5, commitCount: 1 },
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/not measurable on native/);
  });

  // RULE 2: no perf object at all = old companion → rebuild.
  it('is unverifiable when the perf channel is absent (old companion)', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [{ expect: { performance: { metric: 'ready', maxMs: 1000 } } }],
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/perf channel unavailable — rebuild the companion/);
  });

  // RULE 2, the important half: WHY the channel is absent. "Rebuild the
  // companion" covered two different problems, and the common one was not a
  // stale binary at all — it was a render confirmed off the bridge-ack path
  // (deep-link fallback), which had no ack to carry timing. That conflation is
  // what made `metric: mount` look like a random 1-in-4 loss per sweep instead
  // of a diagnosable path difference.
  it('uses the caller-supplied reason for the absent channel, verbatim', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [{ expect: { performance: { metric: 'mount', maxMs: 1500 } } }],
      perfUnavailableReason:
        'native perf channel unavailable — this render was confirmed via the tokenized render marker',
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toBe(
      'native perf channel unavailable — this render was confirmed via the tokenized render marker',
    );
  });

  it('a supplied reason never turns an absent metric into a pass or a fail', async () => {
    // The reason is diagnostic text, not evidence: with no measurement the
    // verdict stays unverifiable regardless of the budget.
    for (const maxMs of [1, 100_000]) {
      const [v] = await executeNativeChecks({
        driver: fakeDriver(),
        checks: [{ expect: { performance: { metric: 'mount', maxMs } } }],
        perfUnavailableReason: 'confirmed via a settle fallback',
      });
      expect(v.status).toBe('unverifiable');
    }
  });

  it('a PRESENT perf object ignores the reason (a measured render is judged, not explained)', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [{ expect: { performance: { metric: 'mount', maxMs: 1500 } } }],
      perf: { readyMs: 900, mountMs: 41, commitCount: 1 },
      perfUnavailableReason: 'should not be used',
    });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/mount 41ms ≤ budget 1500ms/);
  });

  // RULE 4: measured within budget → pass.
  it('passes when ready is within budget', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [{ expect: { performance: { metric: 'ready', maxMs: 1000 } } }],
      perf: { readyMs: 420, mountMs: 30, commitCount: 1 },
    });
    expect(v.status).toBe('pass');
    expect(v.detail).toMatch(/ready 420ms ≤ budget 1000ms/);
  });

  // RULE 5: measured over budget → fail.
  it('fails when mount exceeds budget', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [{ expect: { performance: { metric: 'mount', maxMs: 50 } } }],
      perf: { readyMs: 420, mountMs: 120, commitCount: 1 },
    });
    expect(v.status).toBe('fail');
    expect(v.detail).toMatch(/mount 120ms exceeds budget 50ms/);
  });

  // RULE 3: perf present but this metric's field absent (no update commit fired)
  // → web parity: not measured on this render.
  it('is unverifiable when update was not measured on a present perf object', async () => {
    const [v] = await executeNativeChecks({
      driver: fakeDriver(),
      checks: [{ expect: { performance: { metric: 'update', maxMs: 50 } } }],
      perf: { readyMs: 420, mountMs: 30, commitCount: 1 },
    });
    expect(v.status).toBe('unverifiable');
    expect(v.detail).toMatch(/update not measured on this render/);
  });
});

describe('executeNativeChecks — priorActionUnverifiable cascade', () => {
  it('downgrades a downstream element fail to unverifiable after an unverifiable click', async () => {
    // The click target is absent → unverifiable action; the following visible
    // assertion would normally fail, but the flow was never driven.
    const driver = fakeDriver({ snapshot: SNAP });
    const verdicts = await executeNativeChecks({
      driver,
      checks: [
        { click: { role: 'button', name: 'Missing' } },
        { expect: { element: { role: 'text', name: 'Thanks', state: 'visible' } } },
      ],
    });
    expect(verdicts[0].status).toBe('unverifiable');
    expect(verdicts[1].status).toBe('unverifiable');
    expect(verdicts[1].detail).toMatch(/prior action was unverifiable/);
  });

  it('downgrades a downstream network "no candidate" fail to unverifiable', async () => {
    const driver = fakeDriver({ snapshot: SNAP });
    const verdicts = await executeNativeChecks({
      driver,
      checks: [
        { click: { role: 'button', name: 'Missing' } },
        { expect: { network: { method: 'POST', url: '/api/contact' } } },
      ],
      matchedRequests: [],
    });
    expect(verdicts[0].status).toBe('unverifiable');
    expect(verdicts[1].status).toBe('unverifiable');
    expect(verdicts[1].detail).toMatch(/prior action was unverifiable/);
  });
});

describe('runNativeCriterionChecks', () => {
  it('folds verdicts into a criterion status (pass)', async () => {
    const criterion: SpecCriterion = {
      id: 'AC-1',
      text: 'submit works',
      tier: 'hard',
      checks: [
        { click: { role: 'button', name: 'Submit' } },
        { expect: { network: { method: 'POST', url: '/api/contact', status: '2xx' } } },
      ],
    };
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver({ snapshot: SNAP }),
      criterion,
      matchedRequests: [{ method: 'POST', url: 'https://api.test/api/contact', status: 200 }],
    });
    expect(verdict.status).toBe('pass');
    expect(verdict.id).toBe('AC-1');
    expect(verdict.tier).toBe('hard');
    expect(verdict.checks).toHaveLength(2);
  });

  it('folds to fail when any check fails', async () => {
    const criterion: SpecCriterion = {
      id: 'AC-2',
      text: 'network ok',
      tier: 'hard',
      checks: [{ expect: { network: { method: 'POST', url: '/api/contact' } } }],
    };
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver(),
      criterion,
      matchedRequests: [{ method: 'POST', url: 'https://api.test/api/contact', status: 500 }],
    });
    expect(verdict.status).toBe('fail');
  });

  it('uses navigate() when provided instead of driver.openUrl', async () => {
    const navigate = vi.fn(async () => {});
    const driver = fakeDriver({ snapshot: SNAP });
    const criterion: SpecCriterion = {
      id: 'AC-3',
      text: 'navigates',
      tier: 'hard',
      checks: [{ navigate: { url: '/contact' } }],
    };
    const verdict = await runNativeCriterionChecks({ driver, criterion, navigate });
    expect(navigate).toHaveBeenCalledWith('/contact');
    expect(driver.openUrl).not.toHaveBeenCalled();
    expect(verdict.status).toBe('pass');
  });

  it('folds element passes + performance to unverifiable (perf channel absent)', async () => {
    // A criterion mixing real assertions (which pass) with an expect.performance
    // check folds to unverifiable when no perf object is supplied (old companion):
    // the perf gap taints the whole criterion, never silently passing it.
    const criterion: SpecCriterion = {
      id: 'AC-4',
      text: 'submit renders fast enough',
      tier: 'hard',
      checks: [
        { expect: { element: { role: 'text', name: 'Validity' } } },
        { expect: { element: { role: 'textbox', name: 'Email address' } } },
        { expect: { performance: { metric: 'ready', maxMs: 1000 } } },
      ],
    };
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver({ snapshot: SNAP }),
      criterion,
    });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.detail).toBe('2 pass, 0 fail, 1 unverifiable');
  });
});

describe('runNativeCriterionChecks — navigation demotion (auto-mocked navigator)', () => {
  /** "click the CTA, then the current screen should be gone" — the flow shape. */
  const advancesAway: SpecCriterion = {
    id: 'AC-3',
    text: 'pressing Submit advances off this screen',
    tier: 'hard',
    checks: [
      { click: { role: 'button', name: 'Submit' } },
      { expect: { element: { name: 'Validity', state: 'hidden' } } },
    ],
  };

  it('FALSE-RED: a swallowed navigate demotes the fail to unverifiable, and says why', async () => {
    // Regression: in isolation the navigator is auto-mocked, so navigate() is a
    // no-op and the screen never changes. The criterion reported a confident
    // hard FAIL — a product defect claim about something the harness simply
    // cannot decide.
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver({ snapshot: SNAP }),
      criterion: advancesAway,
      navIntentsSince: () => [{ method: 'navigate', at: Date.now() }],
    });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.detail).toMatch(/navigator is auto-mocked/);
    expect(verdict.detail).toMatch(/navigate\(\)/);
  });

  it('keeps the FAIL when no navigation was attempted (a real regression still fails)', async () => {
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver({ snapshot: SNAP }),
      criterion: advancesAway,
      navIntentsSince: () => [],
    });
    expect(verdict.status).toBe('fail');
  });

  it('keeps the FAIL with no intent channel at all (old companion degrades to today)', async () => {
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver({ snapshot: SNAP }),
      criterion: advancesAway,
    });
    expect(verdict.status).toBe('fail');
  });

  it('does NOT demote a non-visibility failure that happened to navigate', async () => {
    // A navigation in flight must not launder an unrelated failing assertion —
    // this one fails on the network, which a swallowed navigate cannot explain.
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver({ snapshot: SNAP }),
      criterion: {
        id: 'AC-4',
        text: 'posts the form',
        tier: 'hard',
        checks: [{ expect: { network: { method: 'POST', url: '/api/contact' } } }],
      },
      matchedRequests: [{ method: 'POST', url: 'https://api.test/api/contact', status: 500 }],
      navIntentsSince: () => [{ method: 'navigate', at: Date.now() }],
    });
    expect(verdict.status).toBe('fail');
  });
});

describe('runNativeCriterionChecks — network taint (permissive catch-all)', () => {
  // A render-time network expect (no preceding action) that matched a request,
  // but the SAME request was answered by the permissive catch-all (it appears in
  // the `unmatched` list). Mirrors the web executor: the pass over-claims
  // because the body was fabricated, so demote to unverifiable.
  const criterion: SpecCriterion = {
    id: 'AC-net',
    text: 'loads the feed on mount',
    tier: 'hard',
    checks: [{ expect: { network: { method: 'GET', url: '/api/feed', status: '2xx' } } }],
  };

  it('demotes a passing render-time expect.network to unverifiable when the catch-all answered it', async () => {
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver(),
      criterion,
      matchedRequests: [{ method: 'GET', url: 'https://api.test/api/feed', status: 200 }],
      unmatchedUrls: ['GET /api/feed'],
    });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.detail).toMatch(/tainted/);
    expect(verdict.detail).toMatch(/permissive catch-all/);
    // DUAL-WRITE parity with the web executor: the legacy boolean keeps an
    // older reader's refold sticky, the unified list is what new readers use.
    expect(verdict.networkTainted).toBe(true);
    expect(verdict.evidenceTaints).toEqual(['network']);
  });

  it('leaves a passing expect.network as pass when the request was NOT in the unmatched list', async () => {
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver(),
      criterion,
      matchedRequests: [{ method: 'GET', url: 'https://api.test/api/feed', status: 200 }],
      unmatchedUrls: ['GET /api/other'],
    });
    expect(verdict.status).toBe('pass');
    expect(verdict.detail).not.toMatch(/tainted/);
    expect(verdict.networkTainted).toBeUndefined();
    expect(verdict.evidenceTaints).toBeUndefined();
  });

  it('leaves a pass untouched when no unmatched channel is reported (old companion)', async () => {
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver(),
      criterion,
      matchedRequests: [{ method: 'GET', url: 'https://api.test/api/feed', status: 200 }],
      // unmatchedUrls omitted → no taint inferred.
    });
    expect(verdict.status).toBe('pass');
    expect(verdict.detail).not.toMatch(/tainted/);
  });

  it('does not demote a failing status mismatch — a fail stays fail', async () => {
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver(),
      criterion,
      matchedRequests: [{ method: 'GET', url: 'https://api.test/api/feed', status: 500 }],
      unmatchedUrls: ['GET /api/feed'],
    });
    expect(verdict.status).toBe('fail');
    expect(verdict.detail).not.toMatch(/tainted/);
  });

  it('does not taint a criterion with no network checks', async () => {
    const elementCriterion: SpecCriterion = {
      id: 'AC-el',
      text: 'shows the title',
      tier: 'hard',
      checks: [{ expect: { element: { role: 'text', name: 'Validity' } } }],
    };
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver({ snapshot: SNAP }),
      criterion: elementCriterion,
      unmatchedUrls: ['GET /api/feed'],
    });
    expect(verdict.status).toBe('pass');
    expect(verdict.detail).not.toMatch(/tainted/);
  });
});

/* ------------------------------------------------------------------ *
 * A4 — declared-mock network provenance (native parity).              *
 * ------------------------------------------------------------------ */
describe('applyNativeProvenanceGuards (A4 — the device is untrusted)', () => {
  const req = (over: Partial<NativeObservedRequest>): NativeObservedRequest => ({
    method: 'GET',
    url: 'https://api.test/api/feed',
    status: 200,
    ...over,
  });

  it('forces a declared claim to fabricated when the same method+url is in the unmatched list', () => {
    const [out] = applyNativeProvenanceGuards(
      [req({ provenance: 'declared', handlerUrl: '/api/feed' })],
      ['GET https://api.test/api/feed'],
    );
    expect(out!.provenance).toBe('fabricated');
  });

  it('demotes a declared claim citing a catch-all handler pattern (pattern kept for reasons)', () => {
    const [out] = applyNativeProvenanceGuards([req({ provenance: 'declared', handlerUrl: '*' })]);
    expect(out!.provenance).toBe('fabricated');
    expect(out!.handlerUrl).toBe('*');
  });

  it('never promotes: unknown stays unknown, fabricated stays fabricated, clean declared survives', () => {
    const out = applyNativeProvenanceGuards(
      [
        req({}),
        req({ provenance: 'fabricated' }),
        req({ provenance: 'declared', handlerUrl: '/api/feed' }),
      ],
      ['GET https://api.test/api/other'],
    );
    expect(out.map((r) => r.provenance)).toEqual([undefined, 'fabricated', 'declared']);
  });
});

describe('runNativeCriterionChecks — network provenance (A4)', () => {
  const criterion: SpecCriterion = {
    id: 'AC-net-prov',
    text: 'loads the feed from the declared mock',
    tier: 'hard',
    checks: [{ expect: { network: { method: 'GET', url: '/api/feed', status: '2xx' } } }],
  };
  const declared: NativeObservedRequest = {
    method: 'GET',
    url: 'https://api.test/api/feed',
    status: 200,
    provenance: 'declared',
    handlerUrl: '/api/feed',
  };

  it('a declared handler hit passes with positive evidence (handler pattern cited, no taint)', async () => {
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver(),
      criterion,
      matchedRequests: [declared],
      unmatchedUrls: [],
    });
    expect(verdict.status).toBe('pass');
    expect(verdict.networkTainted).toBeUndefined();
    expect(verdict.networkProvenance).toBe('declared');
    expect(verdict.detail).toMatch(/proven against declared mock/);
    expect(verdict.checks?.[0]?.networkEvidence).toEqual({
      provenance: 'declared',
      method: 'GET',
      url: 'https://api.test/api/feed',
      status: 200,
      handlerUrl: '/api/feed',
    });
  });

  it('a fabricated (device catch-all) response satisfying the expect is demoted with evidence attribution', async () => {
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver(),
      criterion,
      matchedRequests: [{ ...declared, provenance: 'fabricated', handlerUrl: undefined }],
      unmatchedUrls: [],
    });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.networkTainted).toBe(true);
    expect(verdict.evidenceTaints).toEqual(['network']);
    expect(verdict.networkProvenance).toBe('fabricated');
    expect(verdict.detail).toMatch(/fabricated response: GET https:\/\/api\.test\/api\/feed/);
  });

  it("CAN'T FALSE-GREEN (cross-check): a declared claim also present in the unmatched list is fabricated", async () => {
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver(),
      criterion,
      matchedRequests: [declared],
      // The device contradicts itself: the same request was catch-all-answered.
      unmatchedUrls: ['GET https://api.test/api/feed'],
    });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.networkTainted).toBe(true);
    expect(verdict.networkProvenance).toBe('fabricated');
  });

  it("CAN'T FALSE-GREEN (catch-all): a declared claim through a catch-all pattern demotes, reason names it", async () => {
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver(),
      criterion,
      matchedRequests: [{ ...declared, handlerUrl: '*' }],
      unmatchedUrls: [],
    });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.networkTainted).toBe(true);
    expect(verdict.detail).toMatch(/catch-all handler '\*' is not endpoint-specific evidence/);
  });

  it('old companion (no provenance channel): a pass never gains a declared stamp', async () => {
    const verdict = await runNativeCriterionChecks({
      driver: fakeDriver(),
      criterion,
      matchedRequests: [{ method: 'GET', url: 'https://api.test/api/feed', status: 200 }],
      unmatchedUrls: [],
    });
    expect(verdict.status).toBe('pass');
    expect(verdict.networkProvenance).toBeUndefined();
    expect(verdict.detail).not.toMatch(/declared mock/);
  });
});

/* ------------------------------------------------------------------ *
 * expect.a11y — native subset (missing-accessible-name detection).    *
 * Gate-integrity headline: native NEVER returns `pass` — only `fail`  *
 * (detected critical missing-name > maxViolations) or `unverifiable`. *
 * ------------------------------------------------------------------ */

describe('countNativeA11yViolations', () => {
  it('flags labelable roles with an empty accessible name', () => {
    const els = parseA11ySnapshot(
      [
        '# @e1 [button] "Submit"',
        '# @e2 [button] ""',
        '# @e3 [textbox] "Email"',
        '# @e4 [textbox] ""',
        '# @e5 [link] "Home"',
        '# @e6 [link] ""',
        '# @e7 [text] "Some heading"',
      ].join('\n'),
    );
    const violations = countNativeA11yViolations(els);
    expect(violations).toHaveLength(3);
    expect(violations.map((v) => v.ref).sort()).toEqual(['@e2', '@e4', '@e6']);
    expect(violations.every((v) => v.impact === 'critical')).toBe(true);
  });

  it('returns no violations when every labelable role is labeled', () => {
    const els = parseA11ySnapshot(
      ['# @e1 [button] "Submit"', '# @e2 [textbox] "Email"', '# @e3 [link] "Home"'].join('\n'),
    );
    expect(countNativeA11yViolations(els)).toEqual([]);
  });

  it('treats a whitespace-only name as missing', () => {
    const els = parseA11ySnapshot('# @e1 [button] "   "');
    expect(countNativeA11yViolations(els)).toHaveLength(1);
  });

  it('ignores non-labelable roles even with empty names', () => {
    const els = parseA11ySnapshot(
      ['# @e1 [text] ""', '# @e2 [view] ""', '# @e3 [image] ""'].join('\n'),
    );
    expect(countNativeA11yViolations(els)).toEqual([]);
  });
});

describe('nativeA11yVerdict', () => {
  const v = (n: number): NativeA11yViolation[] =>
    Array.from({ length: n }, (_, i) => ({ ref: `@e${i}`, role: 'button', impact: 'critical' }));

  it('FALSE-GREEN NEGATIVE: 2 detected > maxViolations 0 → fail (can fail)', () => {
    expect(nativeA11yVerdict(v(2), { maxViolations: 0 })).toEqual({ status: 'fail', count: 2 });
  });

  it('GATE INTEGRITY: 0 detected → unverifiable, NOT pass (absence unobservable)', () => {
    expect(nativeA11yVerdict(v(0), { maxViolations: 0 })).toEqual({
      status: 'unverifiable',
      count: 0,
    });
  });

  it('within budget (1 ≤ 2) → still unverifiable (cannot certify absence)', () => {
    expect(nativeA11yVerdict(v(1), { maxViolations: 2 })).toEqual({
      status: 'unverifiable',
      count: 1,
    });
  });

  it('a detected fail holds at a minor floor too (critical exceeds any floor)', () => {
    // A low severity floor must NOT short-circuit to unverifiable before the
    // detectable critical fail is checked.
    expect(nativeA11yVerdict(v(3), { severity: 'minor', maxViolations: 0 })).toEqual({
      status: 'fail',
      count: 3,
    });
  });

  it('defaults maxViolations to 0 when omitted', () => {
    expect(nativeA11yVerdict(v(1), {}).status).toBe('fail');
    expect(nativeA11yVerdict(v(0), {}).status).toBe('unverifiable');
  });
});

describe('runNativeCriterionChecks — expect.a11y', () => {
  it('a clean snapshot → criterion unverifiable (never pass)', async () => {
    const criterion: SpecCriterion = {
      id: 'AC-a11y',
      text: 'a11y budget',
      tier: 'hard',
      checks: [{ expect: { a11y: { severity: 'serious', maxViolations: 0 } } }],
    };
    const driver = fakeDriver({ snapshot: '# @e1 [button] "OK"\n# @e2 [textbox] "Email"' });
    const verdict = await runNativeCriterionChecks({ driver, criterion });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.checks?.[0]?.detail).toMatch(/cannot certify the absence/i);
  });

  it('FALSE-GREEN NEGATIVE: an unlabeled button over budget → criterion fail', async () => {
    const criterion: SpecCriterion = {
      id: 'AC-a11y',
      text: 'a11y budget',
      tier: 'hard',
      checks: [{ expect: { a11y: { severity: 'critical', maxViolations: 0 } } }],
    };
    const driver = fakeDriver({ snapshot: '# @e1 [button] ""\n# @e2 [textbox] ""' });
    const verdict = await runNativeCriterionChecks({ driver, criterion });
    expect(verdict.status).toBe('fail');
    expect(verdict.checks?.[0]?.detail).toMatch(/exceeds 0 allowed/);
  });

  it('within budget (1 ≤ 2) → still unverifiable (absence unobservable)', async () => {
    const criterion: SpecCriterion = {
      id: 'AC-a11y',
      text: 'a11y budget',
      tier: 'hard',
      checks: [{ expect: { a11y: { severity: 'serious', maxViolations: 2 } } }],
    };
    const driver = fakeDriver({ snapshot: '# @e1 [button] ""\n# @e2 [button] "OK"' });
    const verdict = await runNativeCriterionChecks({ driver, criterion });
    expect(verdict.status).toBe('unverifiable');
  });

  it('snapshot() throwing → unverifiable (never a silent pass)', async () => {
    const criterion: SpecCriterion = {
      id: 'AC-a11y',
      text: 'a11y budget',
      tier: 'hard',
      checks: [{ expect: { a11y: { severity: 'serious' } } }],
    };
    const driver = fakeDriver({
      snapshot: () => Promise.reject(new Error('device disconnected')),
    });
    const verdict = await runNativeCriterionChecks({ driver, criterion });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.checks?.[0]?.detail).toMatch(/device disconnected/);
  });

  it('prior unverifiable action cascades a within-budget a11y to unverifiable', async () => {
    // A failing navigate makes the flow unverifiable; the a11y check must not
    // launder a within-budget snapshot into a false signal — it stays
    // unverifiable with the prior-action reason.
    const criterion: SpecCriterion = {
      id: 'AC-a11y',
      text: 'navigate then a11y',
      tier: 'hard',
      checks: [
        { navigate: { url: 'myapp://broken' } },
        { expect: { a11y: { severity: 'serious', maxViolations: 0 } } },
      ],
    };
    const driver = fakeDriver({ snapshot: '# @e1 [button] "OK"' });
    driver.openUrl = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no activity' }));
    const verdict = await runNativeCriterionChecks({ driver, criterion });
    expect(verdict.status).toBe('unverifiable');
    expect(verdict.checks?.[1]?.detail).toMatch(/prior action was unverifiable/);
  });

  it('a detected over-budget violation still FAILS even after an unverifiable action', async () => {
    // The unlabeled element is on the screen we DID snapshot, so a real
    // violation must win over the prior-action cascade.
    const criterion: SpecCriterion = {
      id: 'AC-a11y',
      text: 'navigate then a11y',
      tier: 'hard',
      checks: [
        { navigate: { url: 'myapp://broken' } },
        { expect: { a11y: { severity: 'critical', maxViolations: 0 } } },
      ],
    };
    const driver = fakeDriver({ snapshot: '# @e1 [button] ""' });
    driver.openUrl = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'no activity' }));
    const verdict = await runNativeCriterionChecks({ driver, criterion });
    expect(verdict.status).toBe('fail');
    expect(verdict.checks?.[1]?.detail).toMatch(/exceeds 0 allowed/);
  });
});
