/**
 * Contract tests for the RAW ValidityNativeRoot template (it imports
 * react-native, so it's never compiled/executed in this package's test env —
 * we pin the host↔device contract by inspecting the shipped source instead).
 *
 * The load-bearing contract here is the PER-NAVIGATION render marker: the host
 * deep-links with `token=<nav token>` and waits for the testID
 * `validity-root:<token>` (see DEFAULT_RENDER_MARKER in capture-native.ts).
 * If the template stops parsing the token or stops tokenizing the marker, the
 * deep-link fallback silently degrades to 'unconfirmed' on every call — these
 * assertions fail loudly instead.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const templatePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../templates/ValidityNativeRoot.tsx',
);
const source = readFileSync(templatePath, 'utf-8');

describe('ValidityNativeRoot template — per-navigation render marker contract', () => {
  it('parses the token= param from deep links', () => {
    expect(source).toContain("token: params.get('token') ?? undefined");
  });

  it('tokenizes the render marker, falling back to the legacy shared marker without a token', () => {
    // The exact marker scheme the host's capture flow waits on.
    expect(source).toContain('`validity-root:${token}`');
    expect(source).toContain("'validity-root'");
  });

  it('carries the bridge navigate token into the target (marker fallback for lost acks)', () => {
    expect(source).toMatch(/token: typeof msg\.token === 'string' \? msg\.token : undefined/);
  });

  it('renders the marker via renderMarkerId on both the component and view screens', () => {
    const uses = source.match(/testID=\{renderMarkerId\(markerToken\)\}/g) ?? [];
    expect(uses).toHaveLength(2); // ComponentScreen + ViewScreen
    const labels = source.match(/accessibilityLabel=\{renderMarkerId\(markerToken\)\}/g) ?? [];
    expect(labels).toHaveLength(2);
  });
});

describe('ValidityNativeRoot template — bridge hello (contentHash + device identity)', () => {
  it('imports the generated content-hash and identity modules', () => {
    expect(source).toContain("from './validity-content-hash'");
    expect(source).toContain("from './validity-native-identity'");
  });

  it('the hello announces the baked contentHash, guarded so a missing constant degrades', () => {
    // The host's stale-bundle guard reads hello.contentHash — if the template
    // stops sending it, staleness detection silently dies on every install.
    expect(source).toMatch(
      /contentHash:\s*typeof VALIDITY_CONTENT_HASH === 'string' \? VALIDITY_CONTENT_HASH : undefined/,
    );
  });

  it('the hello carries device identity + platform', () => {
    expect(source).toContain('id: deviceIdentityRef.current ?? undefined');
    expect(source).toContain('platform: Platform.OS');
    // Identity resolves async; the template must re-announce once it lands.
    expect(source).toContain('getDeviceIdentity()');
  });
});

describe('ValidityNativeRoot template — in-place reload contract', () => {
  it("announces the 'reload' capability in the hello", () => {
    // The host pushes {type:'reload'} ONLY to companions that declared the
    // capability (reloadViaBridge's gate) — if the template stops announcing
    // it, every stale-bundle refresh silently regresses to the terminate +
    // cold-launch ladder.
    expect(source).toMatch(/caps: \[[^\]]*'reload'/);
  });

  it('the hello reports mock-network state (guarded) so verify can flag real-network scoring', () => {
    // getMockStatus() is read into a `mock` field on the hello; a native verify
    // surfaces ACTIVE/DISABLED from it. Guarded so an old mocks module (no
    // getMockStatus export) degrades to "no signal", never a crashed hello.
    expect(source).toContain("typeof getMockStatus === 'function' ? getMockStatus() : undefined");
    expect(source).toMatch(/\bmock,/);
  });

  it('handles the bridge reload message via DevSettings.reload()', () => {
    expect(source).toMatch(/msg\.type === 'reload'/);
    expect(source).toContain('DevSettings.reload()');
  });

  it('imports DevSettings from react-native (the dev-client in-place reload API)', () => {
    expect(source).toMatch(/import \{[\s\S]*?\bDevSettings\b[\s\S]*?\} from 'react-native'/);
  });
});

describe('ValidityNativeRoot template — data travels as DATA (boot fetch + inline slices)', () => {
  it('imports applyMockNetwork + setBridgePassthrough to overlay data without a rebuild', () => {
    // Multi-line import (the symbol list grew with getUnmatchedUrls/resetUnmatched)
    // — match the named members rather than an exact one-line spelling.
    expect(source).toMatch(
      /import \{[\s\S]*?\bapplyMockNetwork\b[\s\S]*?\bsetBridgePassthrough\b[\s\S]*?\bgetMockStatus\b[\s\S]*?\} from '\.\/validity-native-mocks'/,
    );
  });

  it('imports getUnmatchedUrls + resetUnmatched so the rendered ack carries un-mocked URLs', () => {
    expect(source).toMatch(
      /import \{[\s\S]*?\bgetUnmatchedUrls\b[\s\S]*?\bresetUnmatched\b[\s\S]*?\} from '\.\/validity-native-mocks'/,
    );
    // Reset at the START of a navigation; snapshot into the rendered ack.
    expect(source).toContain('resetUnmatchedSafe()');
    expect(source).toContain('getUnmatchedSafe()');
  });

  it('imports getMatchedRequests + resetMatched so the ack carries observed network responses', () => {
    expect(source).toMatch(
      /import \{[\s\S]*?\bgetMatchedRequests\b[\s\S]*?\bresetMatched\b[\s\S]*?\} from '\.\/validity-native-mocks'/,
    );
    // Reset alongside the other channels at the START of each navigation.
    expect(source).toContain('function resetNavObservations()');
    expect(source).toContain('resetMatchedSafe()');
    expect(source).toContain('getMatchedSafe()');
    // matched is included in the ack (omitted when empty, mirroring unmatched).
    expect(source).toContain('...(matched.length > 0 ? { matched } : {})');
  });

  it('patches console.error ONCE (guarded, original preserved) and acks consoleErrorCount', () => {
    // The console channel for expect.console: patched once behind a guard so
    // repeated mounts/HMR don't stack patches, original behaviour kept.
    expect(source).toContain('function patchConsoleErrorOnce()');
    expect(source).toContain('__validityConsoleErrorPatched');
    expect(source).toContain('__validityConsoleErrorCount += 1');
    // Installed at module load so the first render's errors are observed.
    expect(source).toMatch(/patchConsoleErrorOnce\(\);/);
    // Reset per navigation, and ALWAYS sent (0 must be distinguishable from
    // "field absent" so an old companion degrades to unverifiable, not pass).
    expect(source).toContain('resetConsoleErrorsSafe()');
    expect(source).toContain('consoleErrorCount: getConsoleErrorCount()');
  });

  it('boot-fetches the bridge GET /data on the same port (ws→http) and verifies the signature', () => {
    // The endpoint rides the WS port, so Android's existing adb reverse covers it.
    expect(source).toContain("bridgeUrl.replace(/^ws/i, 'http').replace(/\\/$/, '')");
    expect(source).toContain("fetch(httpBase + '/data')");
    // The bridge origin must be exempted from msw BEFORE the fetch, else the
    // permissive catch-all answers it with {} and host data never loads.
    expect(source).toContain('setBridgePassthrough(httpBase)');
    // Only a real Validity bridge's payload is applied (never a random holder).
    expect(source).toContain('body.validityNativeBridge !== true');
  });

  it('applies host-pushed mock-network data with priority over the baked fallback', () => {
    // Boot fetch path…
    expect(source).toMatch(
      /if \(data\.mockNetwork\) \{[\s\S]*?applyMockNetwork\(data\.mockNetwork\)/,
    );
    // …and the per-navigation inline path (a warm mock edit re-targets as data).
    expect(source).toMatch(
      /if \(msg\.mockNetwork\) \{[\s\S]*?applyMockNetwork\(msg\.mockNetwork\)/,
    );
    // Host-fetched views/scenarios win over the baked props.
    expect(source).toContain('const views = hostData?.views ?? bakedViews;');
    expect(source).toContain('const scenarios = hostData?.scenarios ?? bakedScenarios;');
  });

  it('materializes the wire-format scenario seed (re-adds literal-undefined keys), inline first', () => {
    // The inline navigate.scenarioSeed wins over the baked scenarios map.
    expect(source).toContain(
      'target.scenarioSeed ?? (target.scenario ? scenarios[target.scenario] : null)',
    );
    // undefinedKeys are re-added as own-properties so cleared keys (authToken)
    // override the proxy heuristic via hasOwnProperty.
    expect(source).toContain('for (const k of wire.undefinedKeys || []) out[k] = undefined;');
  });
});

describe('ValidityNativeRoot template — render-perf channel (expect.performance)', () => {
  it('defines a monotonic clock that prefers performance.now() over Date.now()', () => {
    // readyMs/mount/update must be measured on a monotonic clock so a wall-clock
    // jump can't poison a budget verdict.
    expect(source).toContain('global.performance.now');
    expect(source).toContain(': Date.now()');
  });

  it('declares the module-level perf collectors and resets them per navigation', () => {
    expect(source).toContain('let __perfMount');
    expect(source).toContain('let __perfWorstUpdate');
    expect(source).toContain('let __perfCommits = 0');
    // resetPerf is wired into resetNavObservations so each capture starts clean.
    expect(source).toContain('function resetPerf()');
    expect(source).toMatch(/function resetNavObservations\(\)[\s\S]*?resetPerf\(\);/);
  });

  it('records mount vs worst-update and counts every commit in onProfileRender', () => {
    expect(source).toContain('function onProfileRender(');
    // Every commit (mount + updates) bumps the count → commitCount >= 1 once the
    // target's mount commit fires.
    expect(source).toContain('__perfCommits += 1');
    expect(source).toContain("phase === 'mount'");
    expect(source).toContain("phase === 'update'");
    // Worst (max) update duration across re-render + play.
    expect(source).toContain('Math.max(__perfWorstUpdate, ms)');
  });

  it('wraps BOTH the component and view targets in <React.Profiler id="validity-target">', () => {
    // The Profiler must remount per target (these screens are recreated on
    // navigation) so phase 'mount' fires once per capture.
    const profilers =
      source.match(/<React\.Profiler id="validity-target" onRender=\{onProfileRender\}>/g) ?? [];
    expect(profilers).toHaveLength(2); // ComponentScreen + ViewScreen
  });

  it('REMOUNTS the target subtree per navigation (else phase is never "mount")', () => {
    // <React.Profiler id="validity-target"> lives inside these screens, so it
    // reports phase 'mount' only when its own subtree mounts. Without a key,
    // React reconciles ComponentScreen in place on a warm re-target and every
    // commit is an 'update' — observed on Android as
    // `perf: {readyMs, updateMs, commitCount: 1}` with NO mountMs, so
    // `expect.performance metric: mount` reported "mount not measured on this
    // render" about a component that had just rendered.
    //
    // The key also enforces capture isolation: without it, screen state
    // carries from one capture into the next.
    expect(source).toContain('const targetKey = [');
    const keyed = source.match(/key=\{targetKey\}/g) ?? [];
    expect(keyed).toHaveLength(2); // ComponentScreen + ViewScreen
    // The token is part of the identity, so re-navigating to the SAME target
    // still remounts rather than continuing the previous render.
    expect(source).toMatch(/const targetKey = \[[\s\S]*?target\.token[\s\S]*?\]\.join/);
  });

  it('stamps navStart for HOST navigations — bridge navigate + home AND a tokenized deep link', () => {
    // readyMs origin is stamped wherever a host pendingToken is set. A TOKENIZED
    // deep link is a host navigation too (the host mints the token and confirms
    // via the tokenized marker), and it must stamp: that rung is where captures
    // land whenever a bridge ack times out, and leaving it unstamped is what
    // made expect.performance a per-sweep lottery. UNtokenized deep links and
    // on-device navigation still owe no ack and never stamp.
    const stamps = source.match(/stampPerfNavStart\(\)/g) ?? [];
    // definition + navigate + home + the deep-link helper
    expect(stamps.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('__perfNavStart != null ? Math.round(perfNow() - __perfNavStart)');
    // navigateLocal (on-device taps) must NOT stamp — it clears the pending token.
    expect(source).toMatch(
      /pendingTokenRef\.current = null;\s*\n\s*hasNavigatedRef\.current = true/,
    );
  });

  it('a TOKENIZED deep link owes a rendered ack (the fallback rung carries perf too)', () => {
    // The ack is the only carrier of perf/matched/consoleErrorCount. Before this
    // the deep-link rung set no pending token, so a render confirmed by the
    // marker reported `expect.performance metric: mount` unverifiable on a
    // current companion — rotating to a different spec every sweep.
    expect(source).toMatch(
      /if \(typeof t\.token === 'string' && t\.token\) \{\s*\n\s*pendingTokenRef\.current = t\.token;/,
    );
    // Both deep-link entry points (initial URL + live 'url' event) go through it.
    const applied = source.match(/applyDeepLink\(t\)/g) ?? [];
    expect(applied).toHaveLength(2);
  });

  it('announces the deep-link-ack capability so the host knows to read that ack', () => {
    // A host that does not see this capability must not spend its adopt budget
    // waiting for an ack an old binary never sends.
    expect(source).toContain("caps: ['reload', 'dismiss-dev-menu', 'deep-link-ack']");
  });

  it('ALWAYS sends the perf object in the rendered ack (new companion vs absent = old)', () => {
    // A new companion always emits `perf`; an old one omits the field entirely
    // so the host can degrade it to unverifiable rather than a silent pass.
    expect(source).toContain('const perf = getPerfSnapshot()');
    expect(source).toMatch(/type: 'rendered',[\s\S]*?perf,/);
  });

  it('emits the agreed perf object shape (readyMs/mountMs/updateMs/commitCount)', () => {
    // Host-plumbing agent relies on exactly these keys; updateMs is omitted when
    // no update commit fired (undefined serializes away).
    expect(source).toContain('readyMs,');
    expect(source).toContain('mountMs: __perfMount');
    expect(source).toContain('updateMs: __perfWorstUpdate');
    expect(source).toContain('commitCount: __perfCommits');
  });
});

describe('ValidityNativeRoot template — replay handling', () => {
  it('ignores a tagged replay once any navigation happened this JS session', () => {
    // The host replays its last drive command (tagged replay:true) on every
    // (re)connect. A session that already navigated must not be yanked back to
    // an older target by a replay racing a newer navigate.
    expect(source).toMatch(/msg\.replay === true && hasNavigatedRef\.current\) return/);
  });

  it('every applied navigation marks the session as navigated', () => {
    // bridge navigate + home, on-device navigation, and the deep-link helper
    // (which BOTH deep-link entry points — initial URL + live 'url' event — go
    // through, so one mark there covers both; see applyDeepLink).
    const marks = source.match(/hasNavigatedRef\.current = true/g) ?? [];
    expect(marks.length).toBeGreaterThanOrEqual(4);
    expect(source).toMatch(/const applyDeepLink[\s\S]{0,200}hasNavigatedRef\.current = true/);
  });
});

describe('ValidityNativeRoot template — nav-intent channel', () => {
  it('publishes __validitySendNavIntent on the open socket', () => {
    // The auto-mocked navigator calls this global; without it the host never
    // learns a navigation was attempted and reports an undecidable check as a
    // confident FAIL.
    expect(source).toContain('__validitySendNavIntent');
    expect(source).toContain("type: 'nav-intent'");
  });

  it('drops the sender when the socket closes (never writes to a dead WS)', () => {
    const close = source.slice(source.indexOf('ws.onclose'));
    expect(close).toContain('__validitySendNavIntent = undefined');
  });
});

describe('ValidityNativeRoot template — Expo dev-menu suppression', () => {
  // THE Android blocker after the setColorScheme fix. expo-dev-menu's
  // DevMenuFragment.onCreate opens the menu whenever
  //   showsAtLaunch || !isOnboardingFinished
  // and `isOnboardingFinished` defaults to FALSE, flipping only when a human
  // taps through the onboarding sheet — which never happens on a companion the
  // installer provisions. So the menu auto-opens on every React-context init,
  // and it is a MODAL bottom sheet: while it is up the host's paint
  // cross-check cannot see `validity-root:<token>` underneath and demotes every
  // render to `unconfirmed`, which is exactly "all Android criteria
  // unverifiable".

  it('resolves the dev-menu module with ZERO imports (a bad import kills the bundle)', () => {
    // `import { requireOptionalNativeModule } from 'expo'` bundles fine against
    // a WARM Metro cache and then takes the whole companion down on the next
    // --clear rebuild: expo's entry re-exports EventEmitter/SharedObject from
    // expo-modules-core, pnpm does not hoist it, and the re-export can resolve
    // to undefined —
    //   [runtime not ready]: TypeError: Cannot read property 'EventEmitter'
    //   of undefined … registerExportsForReactRefresh … metroRequire
    // i.e. a redbox where the app should be, caused by a dismissal helper.
    // Anchored to real import STATEMENTS — the comment above the resolver
    // quotes the bad spelling on purpose, and must not trip this.
    expect(source).not.toMatch(/^\s*import\b[^\n]*\bfrom 'expo'/m);
    expect(source).not.toMatch(/^\s*import\b[^\n]*\bfrom 'expo-modules-core'/m);
    expect(source).not.toMatch(/^\s*import\b[^\n]*\bfrom 'expo-dev-menu'/m);
    // requireOptionalNativeModule itself reads this registry first, and
    // expo-modules-core installs it at startup — long before a navigate/ack.
    expect(source).toContain('expo?.modules?.ExpoDevMenu');
  });

  it('closes via closeMenu with hideMenu as the fallback', () => {
    // Both exist on both platforms under the same module name in 55.0.30.
    expect(source).toContain('mod.closeMenu');
    expect(source).toContain('mod.hideMenu');
  });

  it('closes the dev menu BEFORE sending the rendered ack, not after', () => {
    // The load-bearing ordering. The host treats the ack as "go look at the
    // device" and immediately queries the view hierarchy; acking with the menu
    // still up means it queries a tree that structurally cannot contain the
    // marker. If these two ever swap, Android silently returns to reporting
    // every render unconfirmed — with nothing pointing at why.
    const closeAt = source.indexOf('await closeDevMenuBounded()');
    const sendAt = source.indexOf('wsRef.current?.send(ackPayload)');
    expect(closeAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(closeAt);
    // The ack payload — including readyMs — is serialized BEFORE the close, so
    // the dismissal can never inflate the perf metric.
    const payloadAt = source.indexOf('const ackPayload = JSON.stringify(');
    expect(payloadAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(payloadAt);
  });

  it('bounds the pre-ack close so a wedged native call cannot swallow the ack', () => {
    // Losing the ack costs a whole capture; acking behind a menu costs one
    // retry. The bound picks the cheaper failure.
    expect(source).toContain('DEV_MENU_CLOSE_ACK_BUDGET_MS');
    expect(source).toMatch(/function closeDevMenuBounded\(\)/);
    expect(source).toContain('Promise.race(');
  });

  it("announces the 'dismiss-dev-menu' capability so the host may push the message", () => {
    // The host capability-gates the push: without this the message would be
    // silently dropped by the device and the host would wait out its timeout.
    expect(source).toMatch(/caps: \[[^\]]*'dismiss-dev-menu'/);
  });

  it('handles a host-pushed dismissal and acks it per token', () => {
    expect(source).toMatch(/msg\.type === 'dismiss-dev-menu'/);
    expect(source).toMatch(/type: 'dev-menu-dismissed'/);
    // `ok` must reflect what actually happened — a no-op reported as success
    // would tell the host the screen is readable when it is not.
    expect(source).toMatch(/async function closeDevMenu\(\): Promise<boolean>/);
  });

  it('clears the menu as each host navigation starts, too', () => {
    // Covers a menu opened by a shake / three-finger press between captures.
    const marks = source.match(/closeDevMenuSoon\(\)/g) ?? [];
    expect(marks.length).toBeGreaterThanOrEqual(3); // definition + navigate + home
  });

  it('NEVER dismisses by pressing BACK', () => {
    // BACK was tried and reverted: once the menu is gone a BACK lands on the
    // app root and exits to the launcher, so a lagging snapshot could walk the
    // app out from under the run. Evidence captured of the Android home screen
    // is worse than evidence captured behind a menu, because only the latter is
    // reported honestly as unconfirmed.
    expect(source).not.toMatch(/BackHandler/);
    expect(source).not.toMatch(/goBack\(\)/);
  });
});

describe('ValidityNativeRoot template — Appearance.setColorScheme(null) is Android-fatal', () => {
  // THE bug that made Android never work while iOS was fine on the same tree.
  // `setColorScheme(null)` is the documented "restore the system default" call
  // and is what EVERY navigation without a forced theme passed. On Android the
  // Kotlin signature is non-null, so it throws
  //   java.lang.NullPointerException: Parameter specified as non-null is null
  //   at com.facebook.react.modules.appearance.AppearanceModule.setColorScheme
  // on the native module queue (com.facebook.jni.NativeRunnable.run) — NOT
  // synchronously in JS, so the surrounding try/catch cannot catch it. It kills
  // the React instance and expo-dev-launcher shows "There was a problem loading
  // the project", which is exactly the blank/launcher-error screen every
  // Android run hit.
  it('never calls setColorScheme(null) on Android', () => {
    // The guard must sit BEFORE the call, and be keyed on both the null case
    // and the platform — either half alone reintroduces the crash.
    const guard = /if\s*\(\s*forced === null && Platform\.OS === 'android'\s*\)\s*return;/;
    expect(source).toMatch(guard);
    const guardAt = source.search(guard);
    const callAt = source.indexOf('Appearance.setColorScheme(forced)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(guardAt);
  });

  it('still forces a CONCRETE scheme on both platforms (the axis keeps working)', () => {
    // The fix must not disable the color-scheme axis — only the null reset is
    // skipped, and only on Android.
    expect(source).toMatch(
      /const forced =\s*scheme === 'light' \|\| scheme === 'dark' \? scheme : null;/,
    );
    expect(source).toContain('Appearance.setColorScheme(forced)');
  });
});
