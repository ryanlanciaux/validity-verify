/**
 * Prepare the React Native playground for a project — the native analog of
 * `prepareSandbox()` / `prepareExpoWeb()`.
 *
 * Writes a generated entry + component registry + mock modules into
 * `node_modules/.validity-native/`, then the user points their app's root at
 * the generated entry (or runs a Validity dev build). The harness mounts ONE
 * component, selected by the `?component=…` deep-link / launch param — the
 * same target contract as web.
 *
 * Metro can't `require()` a dynamic path, so we generate a STATIC registry
 * (one import per discovered component) and the harness looks up by path.
 *
 * This module only emits source text + copies the raw templates — it never
 * imports `react-native`, so it compiles and unit-tests without an RN
 * install (exactly like `expo-web.test.ts` validates the prepare contract).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, type ValidityConfig, type ViewDefinition } from '@validity.ai/verify-spec';
import { detectNative, type NativeDetection } from './detect-native.js';
import {
  renderAsyncStorageSeed,
  renderNativeMockModule,
  resolveNativeMockData,
  type NativeMockNetworkData,
} from './network-native.js';
import { renderNativeFontsModule, resolveNativeFonts } from './fonts-native.js';

export interface PrepareNativeOptions {
  projectRoot: string;
  config?: Partial<ValidityConfig>;
  /** Output dir. Defaults to `<projectRoot>/node_modules/.validity-native`. */
  outDir?: string;
  /** Cap on registered components (keeps the Metro graph sane). Default 500. */
  maxComponents?: number;
  /** Optional WebSocket bridge URL for live re-targeting (cold-open works without it). */
  bridgeUrl?: string;
  /**
   * Scaffold a starter `.validity/wrapper.native.tsx` in the project root when
   * one doesn't exist yet (mirrors how the web flow scaffolds wrapper.gen.tsx).
   * Default true. Set false to keep prepareNative side-effect-free in the
   * project tree (e.g. in tests that only assert the generated outDir).
   */
  scaffoldWrapper?: boolean;
}

export interface PrepareNativeResult {
  outDir: string;
  /** Generated entry the app's root should point at (registerRootComponent). */
  entryPath: string;
  registryPath: string;
  mockModulePath: string;
  asyncStorageModulePath: string;
  /**
   * Module exporting the baked DATA fallback (views / scenario seeds /
   * mock-network / AsyncStorage seed). Deliberately EXCLUDED from contentHash
   * (see {@link prepareNative}) — editing any of it never costs a Metro
   * `--clear` restart; the host ships fresher copies inline per-navigation and
   * over the bridge's GET /data boot fetch.
   */
  dataModulePath: string;
  /**
   * The full DATA payload behind the data/code split: the host serves it from
   * the bridge's GET /data endpoint (boot fetch) and ships the per-target slices
   * (view items / scenario seed / mock-network) inline with every navigate, so
   * a views_create / scenario / mock edit reaches the device as data instead of
   * regenerated, contentHash-flipping code. Identical to what the baked
   * `validity-native-data.ts` fallback contains.
   */
  dataPayload: NativeDataPayload;
  /** Module exporting `loadFonts()` — registers the host's runtime fonts. */
  fontsModulePath: string;
  /** Module exporting `hideSplash()` — dismisses the native launch screen. */
  splashModulePath: string;
  /** Module exporting `NavigationMockProvider` — auto-mocked RN/expo-router nav contexts. */
  navModulePath: string;
  /** Number of custom fonts the companion will load (scanned + config). */
  registeredFontCount: number;
  /** Project-relative component/screen paths registered for mounting. */
  registeredComponents: string[];
  detection: NativeDetection;
  /** The launch/deep-link param contract the harness reads. */
  targetContract: { params: string[]; example: string };
  /**
   * Stable identity of the registered component set — changes exactly when a
   * component is added to / removed from the registry, never on plain code
   * edits. NO LONGER part of buildHash: the registry is plain JS, so a new
   * component reaches the device via the contentHash → Metro path (Fast
   * Refresh / --clear restart), not a native rebuild — folding this into the
   * rebuild gate used to prompt a minutes-long prebuild for adding a single
   * component file. Kept as a cheap diagnostic for "did the registered set
   * change?" comparisons.
   *
   * Views are deliberately EXCLUDED: a view is just data (components already in
   * the registry + props) that the host ships inline per-navigation over the
   * bridge / deep-link. (It used to be folded in here, which forced a
   * multi-minute rebuild for every `views_create` — the slow surface that
   * exposed the stale-registry bug.)
   */
  structureHash: string;
  /**
   * Hash of the EXACT generated/copied source Metro serves (every bundled body
   * — registry, entry, mocks, polyfills, fonts, splash, wrapper, async-storage,
   * and the copied templates). Changes whenever a generated file's CONTENT
   * changes, even when the component set (structureHash) is unchanged. The
   * companion-Metro helper restarts Metro with `--clear` when this differs from
   * the last-served marker, so a stale transform cache can't keep serving the
   * old bundle after a fix lands. Distinct from buildHash — a content change
   * needs a cache reset, not a native rebuild.
   */
  contentHash: string;
  /** Absolute path of a freshly scaffolded `.validity/wrapper.native.tsx`, if one was written. */
  scaffoldedWrapperPath?: string;
}

/**
 * Locate the raw RN templates across all three layouts (mirrors the sandbox's
 * resolver):
 *   1. Dev / monorepo:  `<native>/src/prepare-native.ts` → `../templates/`
 *   2. Published tsc:   `<native>/dist/prepare-native.js` → `../templates/`
 *   3. Esbuild bundle:  `<install>/cli.js` (or mcp.js) → `templates/` (sibling)
 * In a bundled CLI `import.meta.url` points at the install root, so the
 * templates sit next to cli.js.
 */
function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '..', 'templates'), resolve(here, 'templates')];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, 'ValidityNativeRoot.tsx'))) return dir;
  }
  return candidates[0]!;
}

function rel(fromDir: string, toAbs: string): string {
  let r = relative(fromDir, toAbs).replaceAll('\\', '/');
  if (!r.startsWith('.')) r = './' + r;
  return r;
}

/** One item of a native view — a component (by registry path) + props + label. */
export interface NativeViewItem {
  path: string;
  label: string;
  props: Record<string, unknown>;
}

/**
 * Resolve a view definition into the renderable `{ path, label, props }[]` the
 * playground mounts. Items whose component isn't registered are dropped (a
 * stale reference can't crash the view). Prop precedence: explicit `props` →
 * the named fixture's props → empty.
 *
 * Shared by BOTH the baked registry map (cold-open / home-listing fallback) and
 * the host-side bridge/deep-link payload — a view is just data, so it travels
 * inline per-navigation (ephemeral, NO native rebuild) exactly like prop
 * overrides, and renders identically whichever way it arrives.
 */
export function resolveNativeViewItems(
  view: ViewDefinition | undefined,
  registered: Set<string>,
  components: Record<string, { fixtures?: Record<string, { props?: Record<string, unknown> }> }>,
): NativeViewItem[] {
  if (!view) return [];
  const items: NativeViewItem[] = [];
  for (const it of view.items) {
    if (!registered.has(it.componentPath)) continue;
    const fixtureProps = it.fixtureName
      ? components[it.componentPath]?.fixtures?.[it.fixtureName]?.props
      : undefined;
    items.push({
      path: it.componentPath,
      label:
        it.label ??
        it.fixtureName ??
        it.componentPath
          .split('/')
          .pop()!
          .replace(/\.\w+$/, ''),
      props: (it.props ?? fixtureProps ?? {}) as Record<string, unknown>,
    });
  }
  return items;
}

/**
 * Per-scenario context seed in WIRE format — the JSON-safe encoding used by
 * BOTH the baked `validity-native-data.ts` module and every host→device hop
 * (bridge `navigate.scenarioSeed`, bridge GET /data), so the device decodes
 * one shape regardless of how the seed arrived.
 *
 * Why not the raw seed object: scenario seeds carry SEMANTIC `undefined`
 * values (`logged-out` sets `authToken: undefined` so a screen's
 * `authToken === undefined` check behaves like a real cleared token), and
 * JSON drops undefined-valued keys. The wire format lists those keys
 * explicitly; the device re-materializes them as own-properties with value
 * `undefined` (the context proxy's `hasOwnProperty` overlay needs the key to
 * exist). This is also the documented DATA/CODE boundary: function values
 * cannot travel as data and are encoded as `undefined` — exactly what the old
 * baked serializer emitted for them — so nothing function-bearing ever rides
 * the data path. (Should a future scenario field carry real functions, it
 * must stay baked generated code, tracked by contentHash.)
 */
export interface NativeScenarioSeedWire {
  /** JSON-serializable seed entries. */
  context: Record<string, unknown>;
  /** Keys seeded with literal `undefined` (dropped by JSON, re-added on decode). */
  undefinedKeys?: string[];
}

/** Encode a raw scenario seed into the wire format (see {@link NativeScenarioSeedWire}). */
export function encodeScenarioSeedWire(seed: Record<string, unknown>): NativeScenarioSeedWire {
  const context: Record<string, unknown> = {};
  const undefinedKeys: string[] = [];
  for (const [k, v] of Object.entries(seed)) {
    // Functions can't travel as data — degrade to `undefined`, matching the
    // old baked serializer (JSON.stringify(fn) === undefined → `"k": undefined`).
    if (v === undefined || typeof v === 'function') undefinedKeys.push(k);
    else context[k] = v;
  }
  return undefinedKeys.length > 0 ? { context, undefinedKeys } : { context };
}

/**
 * Merge the built-in `logged-in`/`logged-out` seeds with the project's
 * `config.scenarios[name].native.context` (config wins per key; config-only
 * scenarios are added) and encode each to wire format. Shared by the baked
 * data module AND the host-side per-navigation payload, so a scenario edit in
 * `.validity/config.ts` reaches the device as data — no contentHash flip.
 */
export function resolveNativeScenarioSeeds(
  config?: Partial<ValidityConfig>,
): Record<string, NativeScenarioSeedWire> {
  const merged: Record<string, Record<string, unknown>> = {};
  // Built-ins first…
  for (const [name, ctx] of Object.entries(BUILTIN_CONTEXT_SEEDS)) merged[name] = { ...ctx };
  // …then the project's scenario context seeds (override/extend by key).
  for (const [name, scenario] of Object.entries(config?.scenarios ?? {})) {
    const ctx = scenario?.native?.context;
    if (ctx && typeof ctx === 'object') merged[name] = { ...(merged[name] ?? {}), ...ctx };
  }
  const wire: Record<string, NativeScenarioSeedWire> = {};
  for (const [name, seed] of Object.entries(merged)) wire[name] = encodeScenarioSeedWire(seed);
  return wire;
}

/**
 * Everything views/scenarios/mock-shaped the device consumes as pure DATA —
 * the payload behind the iteration-speed contract: editing any of it must
 * never cost a Metro `--clear` restart (it is EXCLUDED from contentHash; see
 * the hash computation in {@link prepareNative}). Delivery, freshest first:
 *   1. per-navigation, inline on the bridge `navigate` (view items /
 *      scenarioSeed / mockNetwork) — authoritative for the driven path;
 *   2. at boot, from the host bridge's GET /data endpoint (the host calls
 *      `bridge.setNativeData(prepared.dataPayload)` each call) — refreshes
 *      the home listing + scenario/mock state after a reload;
 *   3. the baked `validity-native-data.ts` fallback — possibly stale, but
 *      only reachable when no host is driving (offline / manual use).
 */
export interface NativeDataPayload {
  views: Record<string, NativeViewItem[]>;
  scenarios: Record<string, NativeScenarioSeedWire>;
  mockNetwork: NativeMockNetworkData;
  /** AsyncStorage seed pairs (from `mockNetwork.asyncStorage`). */
  asyncStorage: Array<[string, string]>;
}

/**
 * validity-native-data.ts — the baked DATA module (delivery rung 3 above).
 * Written via writeIfChanged but NOT tracked into contentHash: that exclusion
 * is the whole point (data edits must not trigger the kill-Metro + `--clear`
 * + relaunch path), and it is exactly scoped to THIS module so the hash keeps
 * covering every body that is genuinely code. Old-bundle safety: a device
 * still running a pre-data bundle announces its old contentHash in the bridge
 * hello, the host's stale-bundle guard reloads it onto the current template
 * (which understands the data path), and even before that reload it already
 * renders inline `navigate.items` — so unconditional exclusion never strands
 * an old bundle (it just keeps its baked fallback, same as today).
 */
function renderNativeDataModule(payload: NativeDataPayload): string {
  return `// @validity-generated — DATA consumed by the native playground (views,
// scenario context seeds, mock-network handlers, AsyncStorage seed). Pure
// JSON — deliberately EXCLUDED from contentHash so editing it never restarts
// Metro; the host ships fresher copies inline per-navigation and over the
// bridge's GET /data boot fetch, falling back to this module when offline.
/* eslint-disable */
// @ts-nocheck
export const views = ${JSON.stringify(payload.views, null, 2)};

export const scenarios = ${JSON.stringify(payload.scenarios, null, 2)};

export const mockNetwork = ${JSON.stringify(payload.mockNetwork, null, 2)};

export const asyncStorageSeed = ${JSON.stringify(payload.asyncStorage, null, 2)};
`;
}

/** Build the static component-registry module source (one import per component). */
function renderRegistry(outDir: string, projectRoot: string, paths: string[]): string {
  const imports: string[] = [];
  const entries: string[] = [];
  paths.forEach((p, i) => {
    const spec = rel(outDir, resolve(projectRoot, p)).replace(/\.(tsx|jsx|ts|js)$/i, '');
    const base = p
      .split('/')
      .pop()!
      .replace(/\.(tsx|jsx|ts|js)$/i, '');
    // Namespace import + pick() — NOT a default import. Many RN projects
    // (e.g. Ignite) export components as NAMED exports matching the file name
    // (`export function Button`) with no default, so `import C from …` would be
    // undefined → "No component registered".
    imports.push(`import * as M${i} from ${JSON.stringify(spec)};`);
    entries.push(`  ${JSON.stringify(p)}: pick(M${i}, ${JSON.stringify(base)}),`);
  });
  return `// @validity-generated — static component registry for the native playground.
// Metro can't require a dynamic path, so every mountable component is imported
// here and keyed by its project-relative path (the harness looks it up by the
// ?component= / ?view= param). Views are DATA, not registry code — they live in
// validity-native-data.ts (and travel inline over the bridge), so creating or
// editing a view never changes this module. Regenerate via 'validity browse --native'.
/* eslint-disable */
// @ts-nocheck
import type { ComponentType } from 'react';
${imports.join('\n')}

// Resolve the renderable component from a module namespace, covering default
// exports, named exports matching the file base name (case-insensitive), and a
// first-function-export fallback. Handles default-AND-named export styles.
function pick(mod: Record<string, any>, name: string): ComponentType<any> | undefined {
  if (!mod) return undefined;
  if (mod.default) return mod.default;
  if (name && mod[name]) return mod[name];
  const keys = Object.keys(mod);
  const ci = keys.find((k) => k.toLowerCase() === String(name).toLowerCase());
  if (ci) return mod[ci];
  const fn = keys.find((k) => typeof mod[k] === 'function');
  return fn ? mod[fn] : undefined;
}

export const registry: Record<string, ComponentType<any>> = {
${entries.join('\n')}
};
`;
}

/** Build the native entry source — registers the playground root. */
function renderEntry(detection: NativeDetection, bridgeUrl?: string): string {
  const register = detection.usesExpo
    ? `import { registerRootComponent } from 'expo';\nregisterRootComponent(Root);`
    : `import { AppRegistry } from 'react-native';\nAppRegistry.registerComponent('main', () => Root);`;
  const bridge = bridgeUrl ? JSON.stringify(bridgeUrl) : 'undefined';
  return `// @validity-generated — React Native playground entry.
// Point your app's root at this file (or run a Validity dev build) to mount a
// single component selected by the ?component= deep-link / launch param.
/* eslint-disable */
// @ts-nocheck
// MUST be first: installs runtime globals (queueMicrotask) BEFORE any host
// component module — and therefore reanimated/worklets — is evaluated.
import './validity-native-polyfills';
import React from 'react';
import { ValidityNativeRoot } from './ValidityNativeRoot';
// Install the createContext deep-default auto-mock AFTER ValidityNativeRoot's
// subtree has evaluated @react-navigation/native (its contexts keep their real
// undefined defaults) but BEFORE component-registry imports the user's screens.
// Precisely: contexts imported ONLY by user screens (through component-registry)
// get a proxy default → useAuth-style guards pass. Contexts imported transitively
// via ValidityNativeRoot / mock-provider-shell / wrapper.native are created
// BEFORE the patch and keep their real defaults — they render only because the
// wrapper mounts their provider (else the RenderErrorBoundary points the user
// there). DO NOT reorder above ValidityNativeRoot — see the patch module header.
import './validity-native-context-patch';
import { registry } from './component-registry';
// Views/scenarios/mock data are DATA (excluded from contentHash): this baked
// copy is only the offline fallback — the host ships fresher payloads inline
// per-navigation and via the bridge's GET /data boot fetch.
import { views, scenarios, asyncStorageSeed } from './validity-native-data';
import { startMockNetwork } from './validity-native-mocks';
import { seedAsyncStorage } from './validity-native-asyncstorage';
import { loadFonts } from './validity-native-fonts';

startMockNetwork();

function Root() {
  return (
    <ValidityNativeRoot
      registry={registry}
      views={views}
      scenarios={scenarios}
      asyncStorageSeed={asyncStorageSeed}
      seedAsyncStorage={seedAsyncStorage}
      loadFonts={loadFonts}
      bridgeUrl={${bridge}}
      router=${JSON.stringify(detection.router)}
    />
  );
}

${register}
`;
}

/**
 * Package-INTERNAL module paths the generated runtime couples to. Each was
 * verified against the installed package at ONE version, and each fails
 * SILENTLY into a degraded mode at runtime (a try/catch require, a warn-once
 * fallback) — which historically resurfaced as the FormData cold-open redbox /
 * null-navigationRef crash with zero signal after an expo-router or RN bump.
 * Exported (and interpolated into the generated bodies below, so the probe and
 * the generated code can never drift) for the readiness preflight
 * (`checkPackageInternalPaths` in native-readiness.ts), which resolution-checks
 * them against the HOST's installed node_modules at prepare time and emits a
 * readiness 'todo' naming the exact unresolved path + installed version.
 * The expo-router store specifier lives in prepare-native-app.ts
 * (EXPO_ROUTER_STORE_SPECIFIER) next to the metro redirect that matches it.
 */
/** RN's core init — renderPolyfills front-loads it to materialize the lazy web globals. */
export const RN_INITIALIZE_CORE_SPECIFIER = 'react-native/Libraries/Core/InitializeCore';
/**
 * Canary for the lazy-RN-global force-resolve list in {@link renderPolyfills}:
 * the module backing the lazy `FormData` global (InitializeCore's setUpXHR
 * installs it via `polyfillGlobal('FormData', () => require('../Network/
 * FormData'))`). The list itself is global NAMES, not paths — nothing to
 * resolution-check directly — but if an RN release moves/renames this backing
 * module, RN's lazy-global landscape changed and the enumerated list needs
 * review (the "Property 'FormData' doesn't exist" redbox class).
 */
export const RN_LAZY_GLOBAL_CANARY_SPECIFIER = 'react-native/Libraries/Network/FormData';
/** expo-router internal providing LocalRouteParamsContext (useLocalSearchParams). */
export const EXPO_ROUTER_ROUTE_SPECIFIER = 'expo-router/build/Route';

/**
 * Runtime polyfills loaded FIRST (before any host component / reanimated /
 * worklets). reanimated 4 + react-native-worklets reference `queueMicrotask`
 * while their modules evaluate; if the JS runtime hasn't defined it yet (it's
 * not guaranteed before InitializeCore's timer setup on every engine), that
 * throws an uncaught "Property 'queueMicrotask' doesn't exist" and redboxes the
 * whole app on cold open. Defining it up front is a no-op where the engine
 * already provides one.
 *
 * The same failure mode hits the WHATWG web-API globals. React Native installs
 * several of them LAZILY — e.g. setUpXHR does
 * `polyfillGlobal('FormData', () => require('../Network/FormData').default)`,
 * a getter that only materializes the concrete class on FIRST access. A host
 * component / library that reads bare `FormData` (or `Blob`, `Headers`,
 * `Response`, …) during early module evaluation — before anything else has
 * touched the getter — redboxes with an uncaught
 * "Property 'FormData' doesn't exist". We force-resolve each lazy global here,
 * in the module native-entry imports FIRST, so the concrete value is installed
 * before any other module evaluates. It's a READ-ONLY touch (`void global[x]`):
 * we never ASSIGN over an existing global (RN freezes some of them — writing
 * one throws "property is not writable" and itself redboxes), so this is a
 * no-op where the engine already provides the value eagerly.
 */
function renderPolyfills(): string {
  return `// @validity-generated — runtime polyfills, imported FIRST by native-entry.
/* eslint-disable */
// @ts-nocheck
// CRITICAL — run React Native's core init BEFORE anything else evaluates.
// RN installs the web-API globals (FormData, Blob, URL, …) LAZILY inside
// InitializeCore via polyfillGlobal. Expo's "winter" runtime
// (expo/src/winter/runtime.native.ts) then, at MODULE SCOPE, EAGERLY reads the
// bare \`FormData\` global — \`installFormDataPatch(FormData)\` — to monkey-patch
// it. In the companion the entry's dependency order can evaluate winter before
// anything has required react-native, so InitializeCore hasn't installed the
// lazy getter yet and that bare read throws an uncaught
// "[runtime not ready]: Property 'FormData' doesn't exist" → cold-open redbox.
// Because this module is imported FIRST by native-entry, forcing InitializeCore
// here guarantees the lazy globals exist before winter (or any host component)
// can reference them. This is exactly what react-native/index.js does at its
// top; we only front-load it. Same module instance (resolver pins the single
// react-native copy) so it can't double-init.
try { require('${RN_INITIALIZE_CORE_SPECIFIER}'); } catch (e) {}
if (typeof globalThis.queueMicrotask !== 'function') {
  const flushed = Promise.resolve();
  globalThis.queueMicrotask = (cb) => {
    flushed.then(cb).catch((err) => setTimeout(() => { throw err; }, 0));
  };
}
// DOM event globals that Hermes/RN do NOT provide but msw's interceptors
// reference at setup — the WebSocket interceptor reads bare \`MessageEvent\`/
// \`CloseEvent\`, so without these \`server.listen()\` throws "Property
// 'MessageEvent' doesn't exist" and ALL network mocking (HTTP included) silently
// degrades to "disabled". These aren't RN lazy globals, so a plain assign-if-
// absent is safe (nothing frozen to overwrite). Minimal but spec-shaped enough
// for interceptor setup; real WS isn't mocked by Validity.
if (typeof globalThis.EventTarget === 'undefined') {
  globalThis.EventTarget = class EventTarget {
    constructor() { this.__l = Object.create(null); }
    addEventListener(type, cb) { (this.__l[type] || (this.__l[type] = [])).push(cb); }
    removeEventListener(type, cb) {
      const a = this.__l[type]; if (a) this.__l[type] = a.filter((f) => f !== cb);
    }
    dispatchEvent(event) {
      const a = this.__l[event && event.type]; if (!a) return true;
      for (const f of a.slice()) { try { (f.handleEvent || f).call(this, event); } catch (e) {} }
      return true;
    }
  };
}
if (typeof globalThis.Event === 'undefined') {
  globalThis.Event = class Event {
    constructor(type, init) { this.type = String(type); if (init) Object.assign(this, init); }
  };
}
if (typeof globalThis.MessageEvent === 'undefined') {
  globalThis.MessageEvent = class MessageEvent extends globalThis.Event {
    constructor(type, init) { super(type, init); this.data = init ? init.data : undefined; }
  };
}
if (typeof globalThis.CloseEvent === 'undefined') {
  globalThis.CloseEvent = class CloseEvent extends globalThis.Event {
    constructor(type, init) {
      super(type, init);
      this.code = init ? init.code : undefined;
      this.reason = init ? init.reason : undefined;
      this.wasClean = init ? !!init.wasClean : false;
    }
  };
}
// msw core's WebSocketClientManager touches BroadcastChannel at module scope to
// sync mock clients across tabs — meaningless in RN, so a no-op stub. DOMException
// is referenced by the streams/abort plumbing. Both are the LAST globals msw's
// setup needs beyond what RN + Expo-winter already install.
if (typeof globalThis.BroadcastChannel === 'undefined') {
  globalThis.BroadcastChannel = class BroadcastChannel {
    constructor(name) { this.name = name; this.onmessage = null; this.onmessageerror = null; }
    postMessage() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() { return true; }
  };
}
if (typeof globalThis.DOMException === 'undefined') {
  globalThis.DOMException = class DOMException extends Error {
    constructor(message, name) { super(message); this.name = name || 'Error'; }
  };
}
// Belt-and-suspenders: force-resolve RN's LAZY web-API globals so their
// concrete classes are installed before any host component / worklet / mock /
// winter module reads a bare reference (e.g. \`new FormData()\`,
// \`class X extends Response\`). Read-only: touching the lazy getter materializes
// it; we never assign (frozen globals throw on write). Wrapped per-name so one
// getter's require can't take down the rest. See the doc comment above.
for (const __name of [
  'FormData', 'Blob', 'File', 'FileReader', 'Headers', 'Request', 'Response',
  'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
  'ReadableStream', 'WritableStream', 'TransformStream',
  'TextEncoder', 'TextDecoder',
]) {
  try { void globalThis[__name]; } catch (e) {}
}
export {};
`;
}

/**
 * validity-native-splash.ts — owns the native launch-screen / splash lifecycle.
 *
 * The companion never runs the host app's startup (its entry is native-entry →
 * ValidityNativeRoot, not the host App), so the native launch storyboard is
 * never dismissed and stays painted ON TOP of every rendered target — the
 * capture flow then screenshots the splash even though the a11y tree shows the
 * real content underneath.
 *
 * We can't put `import 'expo-splash-screen'` in the raw template (it's copied
 * verbatim into every project; a static import would fail the Metro bundle for
 * an Expo app that doesn't ship expo-splash-screen). So, like the mocks/fonts
 * modules, we GENERATE this per-project: when the dep is present we own the
 * splash (prevent the default auto-hide at module load, then expose hideSplash()
 * for the root to call once content is committed); otherwise it's a no-op and
 * imports nothing, so the template's import always resolves either way.
 */
function renderNativeSplashModule(detection: NativeDetection): string {
  if (!detection.hasSplashScreen) {
    return `// @validity-generated — no expo-splash-screen detected; nothing to manage.
/* eslint-disable */
// @ts-nocheck
export function hideSplash(): void {}
`;
  }
  return `// @validity-generated — owns the native splash/launch-screen lifecycle.
// The companion never runs the host app's startup, so the native launch
// storyboard is never auto-dismissed and stays painted over the rendered
// target. Prevent the default auto-hide at load (so we control the timing),
// then ValidityNativeRoot calls hideSplash() once real content is committed.
/* eslint-disable */
// @ts-nocheck
import * as SplashScreen from 'expo-splash-screen';

// Own the splash explicitly. Guarded: a stubbed/older module without these
// methods (or a rejection) must never take down the playground.
try {
  const p = SplashScreen.preventAutoHideAsync?.();
  if (p && typeof p.catch === 'function') p.catch(() => {});
} catch {}

let __hidden = false;
export function hideSplash(): void {
  if (__hidden) return;
  __hidden = true;
  try {
    const p = SplashScreen.hideAsync?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}
`;
}

/**
 * Content-hash announcement module. Written AFTER the contentHash is computed
 * and deliberately EXCLUDED from the hash inputs (it is derived FROM them —
 * tracking it would be circular). ValidityNativeRoot sends this constant in the
 * bridge `hello`, so the host can compare what the device is actually running
 * against the freshly-prepared hash and prove a stale bundle (the "warm
 * re-target confidently rendered old code after a content Metro restart"
 * class). It always reaches the device with the content it describes: the only
 * event that changes it is a contentHash change, which itself triggers the
 * Metro --clear restart that rebundles this module.
 */
export function renderContentHashModule(contentHash: string): string {
  return `// @validity-generated — the contentHash of the generated source this bundle
// was built from. Sent in the bridge hello (see ValidityNativeRoot) so the
// host can detect a stale bundle. Excluded from the hash inputs (derived).
/* eslint-disable */
// @ts-nocheck
export const VALIDITY_CONTENT_HASH = ${JSON.stringify(contentHash)};
`;
}

/**
 * Stable device identity for the bridge `hello` (host↔device correlation +
 * future multi-device pinning). Like the splash/mocks modules this is
 * GENERATED per project because the template can't statically import optional
 * deps: expo-application (vendor id / android id — the closest JS-obtainable
 * analog of the simulator UDID / device serial) and AsyncStorage (persisted
 * installation id) are only imported when the host actually ships them.
 * Resolution order, every step best-effort:
 *   1. expo-application: getAndroidId() on Android, getIosIdForVendorAsync()
 *      on iOS — stable per device install.
 *   2. AsyncStorage-persisted random installation id — stable across reloads
 *      and relaunches on one device.
 *   3. In-memory random id — stable for this JS session only (still enough to
 *      tell two concurrently-connected devices apart).
 */
export function renderNativeIdentityModule(detection: NativeDetection): string {
  const expoApplicationBlock = detection.hasExpoApplication
    ? `      // 1. expo-application: the device's own stable identifier.
      try {
        const Application = require('expo-application');
        if (Platform.OS === 'android' && typeof Application.getAndroidId === 'function') {
          const id = Application.getAndroidId();
          if (typeof id === 'string' && id) return 'android:' + id;
        }
        if (Platform.OS === 'ios' && typeof Application.getIosIdForVendorAsync === 'function') {
          const id = await Application.getIosIdForVendorAsync();
          if (typeof id === 'string' && id) return 'ios-vendor:' + id;
        }
      } catch {}
`
    : `      // (expo-application not installed in this project — skipped.)
`;
  const asyncStorageBlock = detection.hasAsyncStorage
    ? `      // 2. Persisted installation id (stable across reloads/relaunches).
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const KEY = '__validity_installation_id__';
        const existing = await AsyncStorage.getItem(KEY);
        if (typeof existing === 'string' && existing) return existing;
        const minted = 'install:' + randomId();
        await AsyncStorage.setItem(KEY, minted);
        return minted;
      } catch {}
`
    : `      // (AsyncStorage not installed in this project — skipped.)
`;
  return `// @validity-generated — stable device identity for the bridge hello.
// Best-effort and never throwing: identity is diagnostics/correlation data,
// so every failure degrades to the next rung instead of breaking the bridge.
/* eslint-disable */
// @ts-nocheck
import { Platform } from 'react-native';

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Session fallback minted once per JS session (rung 3).
const sessionId = 'session:' + randomId();

let resolved: Promise<string> | null = null;

export function getDeviceIdentity(): Promise<string> {
  if (!resolved) {
    resolved = (async () => {
${expoApplicationBlock}${asyncStorageBlock}      // 3. Session-scoped fallback.
      return sessionId;
    })().catch(() => sessionId);
  }
  return resolved;
}
`;
}

/** The introspected expo-router route shape published on globalThis for the store mock. */
export interface ExpoRouteInfo {
  unstable_globalHref: string;
  pathname: string;
  params: Record<string, unknown>;
  segments: string[];
  isIndex: boolean;
  routeNode: null;
}

/**
 * Pure expo-router route introspection from a screen's file path. Embedded
 * VERBATIM into the generated nav module (via `.toString()`) AND unit-tested
 * directly, so the runtime behaviour and the test can't drift. Must stay
 * self-contained (no references to module scope) since it's serialized.
 *
 * `app/(tabs)/post/[id].tsx` → pathname `/post/id`, segments `['(tabs)','post','[id]']`
 * (expo-router's useSegments KEEPS group + bracket segments; the URL pathname
 * drops groups and resolves `[id]` to its placeholder value), params `{ id:'id' }`.
 */
export function deriveExpoRouteInfo(routePath: string): ExpoRouteInfo {
  const p = String(routePath || '').replace(/\.(t|j)sx?$/, '');
  const m = p.match(/(?:^|\/)app\/(.+)$/);
  const relPath = (m ? m[1] : p.split('/').pop()) || '';
  const raw = relPath.split('/').filter(Boolean);
  let segments = raw.slice();
  if (segments[segments.length - 1] === 'index') segments = segments.slice(0, -1);
  const params: Record<string, unknown> = {};
  const parts = segments
    .filter((s) => !(s[0] === '(' && s[s.length - 1] === ')'))
    .map((s) => {
      const rest = s.match(/^\[\.\.\.(.+)\]$/);
      const one = s.match(/^\[(.+)\]$/);
      if (rest && rest[1]) {
        params[rest[1]] = [rest[1]];
        return rest[1];
      }
      if (one && one[1]) {
        params[one[1]] = one[1];
        return one[1];
      }
      return s;
    });
  const pathname = '/' + parts.join('/');
  return {
    unstable_globalHref: pathname,
    pathname: pathname.length > 1 ? pathname.replace(/\/$/, '') : '/',
    params,
    segments,
    isIndex: raw[raw.length - 1] === 'index',
    routeNode: null,
  };
}

/**
 * A deeply-defaulting Proxy that survives essentially any property access,
 * method call, coercion, or iteration without throwing. It is the NATIVE port
 * of the web sandbox's factory (packages/verify-web/src/prepare.ts:1387-1458) and
 * is kept behaviourally identical — it uses only standard ES (Proxy, Symbol.*,
 * generators) that Hermes fully supports. Embedded VERBATIM into the generated
 * context-patch module via `.toString()` (so the unit-tested impl and the
 * runtime impl can't drift) AND exported so tests can drive it directly on V8
 * (pure ES → representative of Hermes).
 *
 *   .foo → another proxy · .length → 0 · .map → [] · .isX → false ·
 *   String(p) → '' · Number(p) → 0 · for-of → nothing · p.then → undefined
 *
 * Seeded as the default value of any `createContext(undefined|null)` so a
 * consumer's `const c = useContext(C); if (!c) throw 'must be used within …'`
 * guard PASSES and the screen renders in isolation. A real Provider still wins.
 */
export function makeDeepDefaultProxy(callable = false): unknown {
  const recurse = () => makeDeepDefaultProxy(true);
  const target: Record<string | symbol, unknown> = callable
    ? (function shim() {
        return recurse();
      } as unknown as Record<string | symbol, unknown>)
    : {};
  return new Proxy(target, {
    get(target, prop) {
      // Function targets have non-configurable length/name; Hermes/React clone
      // via ownKeys+get and throw if the trap disagrees with the target.
      const desc = Reflect.getOwnPropertyDescriptor(target, prop);
      if (desc && desc.configurable === false && 'value' in desc) return desc.value;
      if (prop === Symbol.toPrimitive) {
        return (hint: string) => (hint === 'number' ? 0 : hint === 'string' ? '' : 0);
      }
      if (prop === 'toString') return () => '';
      if (prop === 'valueOf') return () => 0;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.asyncIterator) return async function* () {};
      if (prop === 'then') return undefined;
      if (typeof prop === 'symbol') return undefined;
      // Scenario context seed (top-level only): when a scenario like 'logged-in'
      // is active, ValidityNativeRoot publishes its seed on globalThis; a seeded
      // key (e.g. isAuthenticated) returns the seeded value instead of the
      // heuristic default, so `useAuth().isAuthenticated` reflects the scenario.
      if (!callable && typeof prop === 'string') {
        const seed = (globalThis as { __VALIDITY_CONTEXT_SEED__?: Record<string, unknown> })
          .__VALIDITY_CONTEXT_SEED__;
        if (seed && Object.prototype.hasOwnProperty.call(seed, prop)) return seed[prop];
      }
      if (prop === 'length' || prop === 'size') return 0;
      if (prop === 'map' || prop === 'filter') return () => [];
      if (prop === 'reduce' || prop === 'reduceRight') return (_fn: unknown, init: unknown) => init;
      if (prop === 'forEach' || prop === 'flat' || prop === 'flatMap') return () => [];
      if (prop === 'every') return () => true;
      if (prop === 'some') return () => false;
      if (prop === 'find' || prop === 'findIndex' || prop === 'findLast') {
        return () => (prop === 'findIndex' ? -1 : undefined);
      }
      if (prop === 'includes' || prop === 'indexOf') {
        return () => (prop === 'includes' ? false : -1);
      }
      if (prop === 'join') return () => '';
      if (prop === 'concat' || prop === 'slice' || prop === 'splice') return () => [];
      if (prop === 'toFixed' || prop === 'toPrecision' || prop === 'toExponential')
        return () => '0';
      if (prop === 'toLocaleString') return () => '0';
      if (typeof prop === 'string') {
        const lower = prop.toLowerCase();
        if (/^(is|has|can|should|did|was|will|are)[A-Z_]/.test(prop)) return false;
        if (/^loading$|^pending$|^error$|^errored$|^disabled$|^success$/.test(lower)) return false;
        if (lower === 'count' || lower === 'total' || lower === 'index' || /count$/.test(lower)) {
          return 0;
        }
        // Verb-prefixed method names (fetchEpisodes, getUsers, toggleFavorites)
        // also END in 's' but are FUNCTIONS, not plural nouns — fall through to a
        // callable proxy so calling them no-ops instead of "X is not a function".
        // (A callable proxy still satisfies .map()->[], .length->0.) Must precede
        // the plural-noun rule below, which would otherwise return [].
        if (
          /^(get|set|fetch|load|create|update|delete|remove|add|submit|save|handle|toggle|clear|reset|select|find|refresh|open|close|on)[A-Z]/.test(
            prop,
          )
        ) {
          return recurse();
        }
        if (/^[a-z][a-z0-9_]+s$/i.test(prop) && !/(ss|us|is|os|as)$/.test(lower)) return [];
      }
      return recurse();
    },
    has(target, prop) {
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

/**
 * validity-native-context-patch.ts — auto-mocks app context providers.
 *
 * Patches `React.createContext` so any context created with an `undefined`/`null`
 * default is seeded with {@link makeDeepDefaultProxy} instead. A consumer guard
 * like `useAuth()` (`const c = useContext(AuthContext); if (!c) throw 'must be
 * used within an AuthProvider'`) then PASSES in isolation and the screen renders
 * — the native analog of the web sandbox's createContext patch
 * (packages/verify-web/src/prepare.ts:337-345), using `globalThis` (RN has no
 * `window`).
 *
 * CRITICAL ORDERING (enforced by renderEntry + an import-order unit assertion):
 * native-entry imports this AFTER ValidityNativeRoot — whose subtree evaluates
 * `@react-navigation/native` (and the wrapper), creating those contexts with their
 * REAL `undefined` defaults — and BEFORE component-registry, which statically
 * imports every user screen. So ONLY contexts reached exclusively via a user
 * screen get the proxy default; contexts created earlier in the ValidityNativeRoot
 * /wrapper subtree keep their real default and render via their mounted provider.
 * This ordering is load-bearing:
 * validity-native-nav deliberately does NOT mount IsFocusedContext so
 * `useIsFocused()` falls back to `navigation.isFocused()`; a proxy default there
 * would make `isFocused !== undefined` true and blank focus-gated screens. So the
 * patch must NOT move into validity-native-polyfills or above ValidityNativeRoot.
 */
function renderContextPatch(): string {
  return `// @validity-generated — createContext deep-default auto-mock (app providers).
// Imported by native-entry AFTER ValidityNativeRoot (so @react-navigation's
// contexts keep their real undefined defaults) and BEFORE component-registry (so
// user screens' contexts get a proxy default → useAuth-style guards pass). DO NOT
// move this earlier — see renderContextPatch docs in @validity.ai/verify-native.
/* eslint-disable */
// @ts-nocheck
import React from 'react';

${makeDeepDefaultProxy.toString()}

globalThis.__VALIDITY_DEEP_DEFAULT__ = makeDeepDefaultProxy;

try {
  if (!React.__validityContextPatched) {
    const __validityRealCreateContext = React.createContext;
    React.createContext = function validityCreateContext(defaultValue) {
      const proxyFactory = globalThis.__VALIDITY_DEEP_DEFAULT__;
      const seeded =
        (defaultValue === undefined || defaultValue === null) && proxyFactory
          ? proxyFactory()
          : defaultValue;
      return __validityRealCreateContext(seeded);
    };
    React.__validityContextPatched = true;
  }
} catch (e) {
  // Safe-degrade: if the assignment fails, leave the real createContext in place.
}
export {};
`;
}

/**
 * Built-in scenario context seeds. A scenario name carried by native_browse
 * (`scenario: 'logged-in'`) selects a flat overlay applied to the auto-mocked
 * contexts — so "show me this screen in a logged-in context" makes
 * `useAuth().isAuthenticated` (and the common auth-shaped fields across libraries)
 * read truthy without the user wiring anything. `logged-out` is the explicit
 * inverse (the no-scenario default already renders logged-out via the proxy
 * heuristics). Config scenarios' `native.context` OVERRIDE/EXTEND these per app.
 * `undefined` values are preserved (via the wire format's `undefinedKeys` —
 * see {@link NativeScenarioSeedWire}) so a screen's `authToken === undefined`
 * check behaves like a real cleared token.
 */
const BUILTIN_CONTEXT_SEEDS: Record<string, Record<string, unknown>> = {
  'logged-in': {
    isAuthenticated: true,
    isLoggedIn: true,
    authenticated: true,
    isSignedIn: true,
    isAnonymous: false,
    isGuest: false,
    authToken: 'validity-mock-token',
    token: 'validity-mock-token',
    accessToken: 'validity-mock-token',
    authEmail: 'test@example.com',
    email: 'test@example.com',
    user: { id: '1', name: 'Test User', email: 'test@example.com' },
    currentUser: { id: '1', name: 'Test User', email: 'test@example.com' },
    role: 'user',
    status: 'authenticated',
    isLoading: false,
    loading: false,
    validationError: '',
  },
  'logged-out': {
    isAuthenticated: false,
    isLoggedIn: false,
    authenticated: false,
    isSignedIn: false,
    isAnonymous: true,
    authToken: undefined,
    token: undefined,
    accessToken: undefined,
    authEmail: undefined,
    email: undefined,
    user: null,
    currentUser: null,
    status: 'unauthenticated',
    isLoading: false,
    loading: false,
    validationError: '',
  },
};

/**
 * validity-native-nav.tsx — auto-mocked navigation context.
 *
 * Real screens call React Navigation / expo-router hooks imported from
 * '@react-navigation/native' (useNavigation/useRoute/useScrollToTop/useIsFocused)
 * — NOT the shell's local stubs. In isolation those throw ("Couldn't find a
 * route object / navigation object") because no NavigationContext /
 * NavigationRouteContext is mounted above the component. This module mounts those
 * contexts with a MOCK navigation+route so the hooks resolve, while RECORDING
 * navigation calls instead of executing them (eyes, not hands).
 *
 * It is GENERATED per-project (not a copied template) because the
 * '@react-navigation/native' import must be CONDITIONAL: an app with no
 * navigation lib ('none') doesn't have the package, and a static import would
 * break the Metro bundle. When a router IS detected (react-navigation, or
 * expo-router which depends on @react-navigation/native) we emit the real
 * import; otherwise a zero-import passthrough. Mirrors the conditional-generation
 * idiom already used for splash/fonts.
 *
 * Implementation notes (verified against @react-navigation v7 source):
 *   • We mount NavigationContext + NavigationRouteContext directly rather than
 *     the library's <NavigationProvider>, because that helper derives
 *     IsFocusedContext = (focusedRouteKey === route.key) → false with no parent,
 *     which would make useIsFocused() return false and blank focus-gated screens.
 *     By NOT providing IsFocusedContext, useIsFocused() falls back to
 *     navigation.isFocused() (we return true). See useIsFocused.js / NavigationProvider.js.
 *   • useScrollToTop walks getParent() and reads getState().type / routes[0].key,
 *     and addListener() must return an unsubscribe fn — the mock supplies all three.
 */
function renderNativeNavModule(detection: NativeDetection): string {
  const hasRouter = detection.router === 'react-navigation' || detection.router === 'expo-router';
  if (!hasRouter) {
    return `// @validity-generated — no navigation library detected; passthrough (imports nothing).
/* eslint-disable */
// @ts-nocheck
import React from 'react';
export const recordedNavCalls = [];
export function NavigationMockProvider({ children }) {
  return <>{children}</>;
}
`;
  }

  const isExpoRouter = detection.router === 'expo-router';

  // Shared React Navigation v7 mock (covers useNavigation/useRoute/useScrollToTop/
  // useIsFocused AND the link hooks useLinkTo/useLinkProps + <Link> for BOTH
  // react-navigation and expo-router, since expo-router screens use these RN
  // primitives under the hood).
  const rnCore = `import React from 'react';
import {
  NavigationContext,
  NavigationRouteContext,
  NavigationContainerRefContext,
  NavigationHelpersContext,
  LinkingContext,
} from '@react-navigation/native';

export const recordedNavCalls = [];
// NAVIGATION INTENT CHANNEL: the navigator here is a MOCK, so navigate() is a
// no-op — a spec asserting "pressing this advances off the screen" can never
// pass in isolation. Recording the intent locally is not enough; the host has
// to know one was attempted so it can demote that check to unverifiable
// instead of reporting a confident FAIL about a product that works. Push it
// over the bridge (best-effort: the sender is absent until the socket opens,
// and an older host simply ignores an unknown message type).
const rec =
  (method) =>
  (...args) => {
    recordedNavCalls.push({ method, args, at: Date.now() });
    try {
      if (typeof globalThis.__validitySendNavIntent === 'function') {
        globalThis.__validitySendNavIntent(method);
      }
    } catch (e) {
      /* never let telemetry break a render */
    }
    return undefined;
  };

// route.key MUST equal getState().routes[0].key — useScrollToTop compares them.
export const mockRoute = { key: 'validity', name: 'validity', params: {} };

const baseNavigation = {
  navigate: rec('navigate'),
  push: rec('push'),
  replace: rec('replace'),
  goBack: rec('goBack'),
  reset: rec('reset'),
  popTo: rec('popTo'),
  popToTop: rec('popToTop'),
  setParams: rec('setParams'),
  setOptions: () => {},
  dispatch: rec('dispatch'),
  canGoBack: () => false,
  isFocused: () => true,
  getId: () => undefined,
  getParent: () => undefined, // terminates useScrollToTop's parent while-loop
  getState: () => ({
    type: 'stack',
    key: 'stack-validity',
    index: 0,
    routeNames: ['validity'],
    routes: [mockRoute],
    stale: false,
  }),
  addListener: () => () => {}, // MUST return an unsubscribe fn
  removeListener: () => {},
};

// Proxy so a newer/uncommon navigation method we didn't stub still records a
// no-op instead of throwing "navigation.X is not a function". Symbols and \`then\`
// pass through as undefined so the object isn't mistaken for a thenable.
export const mockNavigation = new Proxy(baseNavigation, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'symbol' || prop === 'then') return undefined;
    return rec(String(prop));
  },
});

// useLinkBuilder/useLinkProps destructure \`options\` from LinkingContext; an
// undefined context value would throw at render. \`{ options: undefined }\` is the
// shape they tolerate (verified against @react-navigation/native v7).
const LINKING_VALUE = { options: undefined };

// Mount EVERY context the nav hooks + link primitives read, so useNavigation/
// useRoute/useScrollToTop/useIsFocused AND useLinkTo/useLinkProps/<Link> all
// resolve. useLinkTo reads ONLY NavigationContainerRefContext and throws
// "Couldn't find a navigation object" without it; useLinkProps additionally needs
// NavigationHelpersContext + LinkingContext (verified vs useLinkTo.js/useLinkBuilder.js).
export function NavContexts({ children, route = mockRoute, navigation = mockNavigation }) {
  return (
    <NavigationContainerRefContext.Provider value={navigation}>
      <NavigationHelpersContext.Provider value={navigation}>
        <LinkingContext.Provider value={LINKING_VALUE}>
          <NavigationContext.Provider value={navigation}>
            <NavigationRouteContext.Provider value={route}>
              {children}
            </NavigationRouteContext.Provider>
          </NavigationContext.Provider>
        </LinkingContext.Provider>
      </NavigationHelpersContext.Provider>
    </NavigationContainerRefContext.Provider>
  );
}

// A realistic route NAME from the screen file so useRoute().name isn't always
// 'validity' (screens that branch on it get a sane value). The key stays
// 'validity' so useScrollToTop's route.key === getState().routes[0].key holds.
export function deriveRouteName(routePath) {
  const base = String(routePath || '')
    .split('/')
    .pop() || '';
  const name = base.replace(/\\.(t|j)sx?$/, '');
  return name || 'validity';
}

// React Navigation hands \`navigation\`/\`route\` to screen components as PROPS
// (function Screen({ navigation }) { … } / this.props.navigation) — the
// contexts above only serve the HOOKS. Inject the same recording mock into the
// isolated child so a prop-consuming screen doesn't redbox with
// "Cannot read property 'navigate' of undefined". Explicit props win: a
// fixture that supplies its own navigation/route is never clobbered.
export function withNavProps(children, navigation, route) {
  if (!React.isValidElement(children)) return children;
  const props = children.props || {};
  const inject = {};
  if (props.navigation === undefined) inject.navigation = navigation;
  if (props.route === undefined) inject.route = route;
  return Object.keys(inject).length > 0 ? React.cloneElement(children, inject) : children;
}
`;

  if (!isExpoRouter) {
    return `// @validity-generated — mounts MOCK React Navigation v7 contexts so screens that
// call useNavigation()/useRoute()/useScrollToTop()/useIsFocused()/useLinkTo()/
// useLinkProps() or render <Link> resolve in isolation WITHOUT "Couldn't find a
// route/navigation object" throws. Navigation is RECORDED, never executed (eyes,
// not hands). The static '@react-navigation/native' import is safe: this file is
// generated ONLY when that package is a resolvable dependency.
/* eslint-disable */
// @ts-nocheck
${rnCore}
export function NavigationMockProvider({ children, routePath }) {
  const route = React.useMemo(
    () => ({ key: 'validity', name: deriveRouteName(routePath), params: {} }),
    [routePath],
  );
  return <NavContexts route={route}>{withNavProps(children, mockNavigation, route)}</NavContexts>;
}
`;
  }

  // expo-router: the RN core (above) covers useNavigation/useRoute/<Link>, but
  // expo-router's OWN hooks + components (useRouter/useSegments/usePathname/
  // useGlobalSearchParams/Link/Redirect/router) read its global store singleton,
  // which is mocked separately (validity-expo-router-store-mock, aliased in via
  // metro.config). Here we (1) INTROSPECT the screen's app/ route path into
  // pathname/segments/params and publish it on globalThis for that store mock to
  // serve, and (2) provide LocalRouteParamsContext so useLocalSearchParams returns
  // the introspected params (it reads a React context, not the store).
  return `// @validity-generated — expo-router isolation harness. Mounts the React
// Navigation v7 contexts (for useNavigation/useRoute/useScrollToTop/<Link>) AND
// introspects the mounted screen's app/ route into pathname/segments/params,
// publishing it for the mocked expo-router store. Navigation is RECORDED, never
// executed (eyes, not hands).
/* eslint-disable */
// @ts-nocheck
${rnCore}
// expo-router route introspection — embedded verbatim from @validity.ai/verify-native's
// deriveExpoRouteInfo() so the generated runtime behaviour and the unit-tested
// implementation never drift. 'app/(tabs)/post/[id].tsx' -> pathname '/post/id',
// segments ['(tabs)','post','[id]'], params { id:'id' }.
${deriveExpoRouteInfo.toString()}

// useLocalSearchParams reads LocalRouteParamsContext (a React context), NOT the
// store. Best-effort require of expo-router's internal Route module — if the path
// moved across versions the hook just returns {} (its documented default), which
// is non-crashing. We warn once so an agent can tell WHY params are empty.
let LocalRouteParamsContext = null;
try {
  LocalRouteParamsContext = require('${EXPO_ROUTER_ROUTE_SPECIFIER}').LocalRouteParamsContext;
} catch (e) {
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      '[validity] expo-router LocalRouteParamsContext unavailable — useLocalSearchParams() will return {}:',
      (e && e.message) || e,
    );
  }
}

export function NavigationMockProvider({ children, routePath }) {
  // Memoised so the published route keeps a STABLE identity across re-renders
  // (the store mock's snapshots must not churn).
  const info = React.useMemo(() => deriveExpoRouteInfo(routePath), [routePath]);
  globalThis.__validityExpoRoute = info;
  const route = React.useMemo(
    () => ({ key: 'validity', name: deriveRouteName(routePath), params: info.params }),
    [routePath, info],
  );

  let tree = <NavContexts route={route}>{withNavProps(children, mockNavigation, route)}</NavContexts>;
  if (LocalRouteParamsContext) {
    tree = (
      <LocalRouteParamsContext.Provider value={info.params}>{tree}</LocalRouteParamsContext.Provider>
    );
  }
  return tree;
}
`;
}

/**
 * validity-expo-router-store-mock.js — a stand-in for expo-router's global store
 * singleton (`expo-router/build/global-state/router-store`). The companion's
 * metro.config aliases the REAL store module to this one (matched by resolved
 * path, so it works however expo-router imports it internally).
 *
 * Why replace the store at all: in isolation there is no <NavigationContainer>,
 * so the real store's `syncStoreRootState()` calls `store.navigationRef.isReady()`
 * on a null ref and throws — which is exactly the "not inside a navigator" class
 * of crash for expo-router screens. Every expo-router hook AND component
 * (useRouter / useSegments / usePathname / useGlobalSearchParams / Link / Redirect
 * / the imperative `router`) funnels through this singleton, so mocking it makes
 * all of them render. Navigation is RECORDED, never executed.
 *
 * The route info served here is INTROSPECTED per-screen by validity-native-nav
 * and published on `globalThis.__validityExpoRoute`. The surface below is the
 * complete set of store members other expo-router build modules reference
 * (enumerated from the installed package), so nothing reads `undefined`.
 *
 * Plain CommonJS (the real module is CJS and is `require()`d by expo-router's
 * compiled output); we set `__esModule` so ESM-interop importers also work.
 */
function renderExpoRouterStoreMock(): string {
  return `// @validity-generated — MOCK of expo-router/build/global-state/router-store.
/* eslint-disable */
'use strict';
Object.defineProperty(exports, '__esModule', { value: true });

function rec(method) {
  return function () {
    var calls = (globalThis.__validityNavCalls = globalThis.__validityNavCalls || []);
    calls.push({ method: method, args: Array.prototype.slice.call(arguments), at: Date.now() });
    // Mirror of the RN mock's intent channel — see prepare-native.ts's rnCore.
    try {
      if (typeof globalThis.__validitySendNavIntent === 'function') {
        globalThis.__validitySendNavIntent(method);
      }
    } catch (e) {
      /* never let telemetry break a render */
    }
    return undefined;
  };
}

var DEFAULT_ROUTE = {
  unstable_globalHref: '/',
  pathname: '/',
  params: {},
  segments: [],
  isIndex: true,
  routeNode: null,
};
function getRouteInfo() {
  return globalThis.__validityExpoRoute || DEFAULT_ROUTE;
}

var ROOT_STATE = {
  stale: false,
  type: 'stack',
  key: 'stack-validity',
  index: 0,
  routeNames: ['validity'],
  routes: [{ key: 'validity', name: 'validity' }],
};

var navigationRef = {
  current: null,
  isReady: function () {
    return false;
  },
  getRootState: function () {
    return ROOT_STATE;
  },
  addListener: function () {
    return function () {};
  },
  removeListener: function () {},
  canGoBack: function () {
    return false;
  },
  navigate: rec('navigate'),
  dispatch: rec('dispatch'),
};

var store = {
  navigationRef: navigationRef,
  routeNode: null,
  rootState: ROOT_STATE,
  linking: {
    getStateFromPath: function () {
      return undefined;
    },
    getPathFromState: function () {
      return '/';
    },
  },
  push: rec('push'),
  replace: rec('replace'),
  navigate: rec('navigate'),
  goBack: rec('goBack'),
  dismiss: rec('dismiss'),
  dismissAll: rec('dismissAll'),
  dismissTo: rec('dismissTo'),
  reload: rec('reload'),
  setParams: rec('setParams'),
  // <Link> presses go through useExpoRouter().linkTo(href) — without this every
  // Link throws 'store.linkTo is not a function' on press.
  linkTo: rec('linkTo'),
  canGoBack: function () {
    return false;
  },
  canDismiss: function () {
    return false;
  },
  getStateFromPath: function () {
    return undefined;
  },
  // Sitemap (expo-router's unmatched/first-launch screen) maps over this — it
  // MUST return an array, which the Proxy fallback below can't guarantee.
  getSortedRoutes: function () {
    return [];
  },
  cleanup: function () {
    return function () {};
  },
  subscribeToRootState: function () {
    return function () {};
  },
  rootStateSnapshot: function () {
    return ROOT_STATE;
  },
  routeInfoSnapshot: function () {
    return getRouteInfo();
  },
  getRouteInfo: function () {
    return getRouteInfo();
  },
  initialize: function () {},
};

// Proxy fallback: any store member we didn't stub (e.g. one that moves/appears
// across expo-router SDKs) becomes a recording no-op instead of crashing the
// screen. Explicit members above win (notably getSortedRoutes, which must return
// an array, and the value props navigationRef/rootState/linking). Symbols and
// \`then\` pass through as undefined so the store isn't mistaken for a thenable.
var storeProxy = new Proxy(store, {
  get: function (target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'symbol' || prop === 'then') return undefined;
    return rec(typeof prop === 'string' ? prop : 'unknown');
  },
});

exports.store = storeProxy;
exports.RouterStore = function RouterStore() {
  return storeProxy;
};
exports.useExpoRouter = function useExpoRouter() {
  return storeProxy;
};
exports.useStoreRootState = function useStoreRootState() {
  return ROOT_STATE;
};
exports.useStoreRouteInfo = function useStoreRouteInfo() {
  return getRouteInfo();
};
exports.useInitializeExpoRouter = function useInitializeExpoRouter() {
  return storeProxy;
};
`;
}

/**
 * validity-native-gh.tsx — auto-mounted GestureHandlerRootView.
 *
 * react-native-gesture-handler's GestureDetector / Swipeable / Drawer throw a
 * hard "GestureDetector must be used as a descendant of GestureHandlerRootView"
 * in isolation (the host normally mounts it at the app root). The shell wraps
 * every isolated render in `GestureRoot`. Generated conditionally — only when the
 * dep is present do we statically import it, so a non-gesture app's bundle never
 * pulls (or breaks on) the package. Passthrough otherwise, so the shell's import
 * always resolves.
 */
function renderGestureRootModule(detection: NativeDetection): string {
  if (!detection.hasGestureHandler) {
    return `// @validity-generated — no react-native-gesture-handler detected; passthrough.
/* eslint-disable */
// @ts-nocheck
import React from 'react';
export function GestureRoot({ children }) {
  return <>{children}</>;
}
`;
  }
  return `// @validity-generated — wraps the isolated screen in GestureHandlerRootView so
// GestureDetector/Swipeable/Drawer render instead of throwing "must be used as a
// descendant of GestureHandlerRootView". Generated only when the dep is installed.
/* eslint-disable */
// @ts-nocheck
import React from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
export function GestureRoot({ children }) {
  return <GestureHandlerRootView style={{ flex: 1 }}>{children}</GestureHandlerRootView>;
}
`;
}

/**
 * validity-native-wrapper.tsx — the app-providers seam, mirroring the web
 * sandbox's wrapper convention. The MockProviderShell wraps every isolated
 * component/view in this, so a screen that needs e.g. a ThemeProvider renders
 * instead of throwing "useAppTheme must be used within a ThemeProvider".
 *
 * If the project has `.validity/wrapper.native.tsx` (where the user puts their
 * NATIVE providers — kept separate from web's wrapper.user.tsx so the web flow
 * is untouched), re-export it; otherwise emit a passthrough so the companion's
 * import always resolves.
 */
function isUnmodifiedNativeWrapperScaffold(
  projectRoot: string,
  detection: NativeDetection,
): boolean {
  const p = resolve(projectRoot, '.validity', 'wrapper.native.tsx');
  if (!existsSync(p)) return true;
  return readFileSync(p, 'utf-8') === renderNativeWrapperScaffold(detection);
}

/**
 * Native isolation wrapper: a customized `.validity/wrapper.native.tsx` wins;
 * otherwise reuse `wrapper.gen.tsx` from `validity init` (cloned app providers).
 * The empty native scaffold is not a real provider tree — treating it as one
 * left ThemeProvider on the web wrapper only and crashed isolation.
 */
function resolveNativeUserWrapper(
  projectRoot: string,
  detection: NativeDetection,
): { abs: string; kind: 'native' | 'gen' } | undefined {
  const nativeAbs = resolve(projectRoot, '.validity', 'wrapper.native.tsx');
  const genAbs = resolve(projectRoot, '.validity', 'wrapper.gen.tsx');
  const nativeCustom =
    existsSync(nativeAbs) && !isUnmodifiedNativeWrapperScaffold(projectRoot, detection);
  if (nativeCustom) return { abs: nativeAbs, kind: 'native' };
  if (existsSync(genAbs)) return { abs: genAbs, kind: 'gen' };
  if (existsSync(nativeAbs)) return { abs: nativeAbs, kind: 'native' };
  return undefined;
}

function renderNativeWrapper(
  outDir: string,
  projectRoot: string,
  detection: NativeDetection,
): string {
  const chosen = resolveNativeUserWrapper(projectRoot, detection);
  if (chosen) {
    let rel = relative(outDir, chosen.abs.replace(/\.tsx$/, '')).replaceAll('\\', '/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    const label =
      chosen.kind === 'gen'
        ? '.validity/wrapper.gen.tsx (init-cloned providers; add wrapper.native.tsx to override)'
        : '.validity/wrapper.native.tsx providers';
    return `// @validity-generated — re-exports your ${label}.
/* eslint-disable */
// @ts-nocheck
export { default } from ${JSON.stringify(rel)};
`;
  }
  return `// @validity-generated — passthrough (no .validity/wrapper.native.tsx found).
// Add your app providers (e.g. <ThemeProvider>, query client, auth) in
// .validity/wrapper.native.tsx and they'll wrap every isolated component/view
// the companion app renders (kept separate from web's wrapper.user.tsx).
/* eslint-disable */
// @ts-nocheck
import React from 'react';
export default function ValidityUserWrapper({ children }) {
  return <>{children}</>;
}
`;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/**
 * Starter `.validity/wrapper.native.tsx` source — a real passthrough the user
 * edits to add their app providers (theme, query client, auth). It is COMMITTED
 * (the user owns it), so unlike the generated re-export this is written once and
 * never overwritten. The commented examples are tailored to the detected
 * navigation lib so the user sees the providers their screens actually need.
 */
export function renderNativeWrapperScaffold(detection: NativeDetection): string {
  const routerHint =
    detection.router === 'expo-router'
      ? `//   • expo-router: useNavigation/useRoute/useScrollToTop/useIsFocused are
//     AUTO-MOCKED (record-only) — do NOT add a NavigationContainer here. Store
//     hooks (useRouter/useLocalSearchParams/useSegments) are best-effort; seed
//     specific params via .validity/config.ts if a screen needs them. Add the
//     data/theme/auth providers your screens read (e.g. a QueryClientProvider).`
      : detection.router === 'react-navigation'
        ? `//   • react-navigation: useNavigation/useRoute/useScrollToTop/useIsFocused
//     are AUTO-MOCKED (record-only) — do NOT add a NavigationContainer here. Add
//     the theme/query/auth providers your screens read.`
        : `//   • Add the providers your components read (theme, query client, auth).`;
  return `// .validity/wrapper.native.tsx — your NATIVE app-providers seam.
//
// Validity renders each component/screen in ISOLATION inside the companion app.
// Whatever you wrap here wraps every isolated render — so a component that calls
// e.g. useAppTheme() or useQuery() gets its provider instead of render-erroring.
// Kept separate from the web wrapper (.validity/wrapper.user.tsx) so each
// platform's providers stay independent. This file is yours to edit — Validity
// scaffolds it once and never overwrites it.
//
// Notes:
${routerHint}
//   • Keep it light: only the providers isolated components depend on.
//   • Navigation AND react-native-gesture-handler are auto-mocked — don't add a
//     NavigationContainer or GestureHandlerRootView here.
//   • Fonts are handled automatically: Validity scans your useFonts/
//     Font.loadAsync map and loads it before mounting, so you do NOT need a font
//     provider here. Override or add fonts via \`native.fonts\` in
//     .validity/config.ts if the scan misses one.
import React from 'react';
import type { ReactNode } from 'react';

// Add the providers your screens read. Common ones (uncomment + adapt the ones
// your app uses):
//
//   import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
//   import { Provider as ReduxProvider } from 'react-redux';
//   import { ThemeProvider } from './path/to/your/theme';   // restyle/styled/etc.
//   const queryClient = new QueryClient();
//   // zustand/jotai stores need no provider — they're module singletons.

export default function ValidityNativeWrapper({ children }: { children: ReactNode }) {
  // return (
  //   <ThemeProvider>
  //     <QueryClientProvider client={queryClient}>
  //       <ReduxProvider store={store}>{children}</ReduxProvider>
  //     </QueryClientProvider>
  //   </ThemeProvider>
  // );
  return <>{children}</>;
}
`;
}

/**
 * Write a starter `.validity/wrapper.native.tsx` if the project is native and
 * none exists yet. Idempotent: never overwrites a user-authored wrapper (the
 * re-export path in {@link renderNativeWrapper} picks it up once present).
 * Returns the absolute path if it scaffolded one, else undefined.
 */
export function scaffoldNativeWrapper(
  projectRoot: string,
  detection: NativeDetection,
): string | undefined {
  if (!detection.isNative) return undefined;
  const dir = resolve(projectRoot, '.validity');
  const wrapperPath = resolve(dir, 'wrapper.native.tsx');
  if (existsSync(wrapperPath)) return undefined;
  // init already cloned providers into wrapper.gen.tsx — don't drop an empty
  // native stub in front of that tree.
  if (existsSync(resolve(dir, 'wrapper.gen.tsx'))) return undefined;
  ensureDir(dir);
  writeFileSync(wrapperPath, renderNativeWrapperScaffold(detection));
  return wrapperPath;
}

/**
 * Write only when the content actually differs. prepareNative runs on every
 * `native_browse` call; rewriting identical files would bump mtimes and make
 * Metro log "config changed — restart the server" mid-session (and clobber a
 * live bundle). Idempotent regeneration keeps the running playground stable.
 */
function writeIfChanged(path: string, content: string): void {
  try {
    if (existsSync(path) && readFileSync(path, 'utf-8') === content) return;
  } catch {
    /* fall through to write */
  }
  writeFileSync(path, content);
}

/**
 * Generate the playground into `outDir`. Returns the written paths + the
 * detection result + the target contract. Pure file emission — safe to call
 * repeatedly (overwrites the generated files).
 */
export function prepareNative(opts: PrepareNativeOptions): PrepareNativeResult {
  const { projectRoot } = opts;
  const outDir = opts.outDir ?? resolve(projectRoot, 'node_modules', '.validity-native');
  const max = opts.maxComponents ?? 500;
  const detection = detectNative(projectRoot);

  ensureDir(outDir);

  // Scaffold the user-owned native providers seam once (before rendering the
  // re-export, so the generated wrapper re-exports it on this same run instead
  // of emitting a throwaway passthrough). Never overwrites an existing one.
  const scaffoldedWrapperPath =
    opts.scaffoldWrapper === false ? undefined : scaffoldNativeWrapper(projectRoot, detection);

  // Which components/screens can we mount? Reuse the catalog so screens +
  // components + explicit config entries all register.
  const catalog = buildCatalog(projectRoot, opts.config ?? {}, { max });
  const registeredComponents = catalog.entries
    .filter((e) => e.kind === 'component' || e.kind === 'screen')
    .map((e) => e.path);

  // Accumulate every body Metro will actually bundle so we can hash the exact
  // SERVED content (see contentHash below). Keyed by file so the order of the
  // hash input is stable regardless of write order.
  const contentParts: Record<string, string> = {};
  const writeTracked = (path: string, body: string): void => {
    contentParts[path] = body;
    writeIfChanged(path, body);
  };

  // Copy the raw RN templates (they import react-native; never compiled here).
  const tdir = templatesDir();
  for (const file of ['ValidityNativeRoot.tsx', 'mock-provider-shell.tsx']) {
    const src = resolve(tdir, file);
    if (existsSync(src)) writeTracked(resolve(outDir, file), readFileSync(src, 'utf-8'));
  }

  // Build the views map (compositions) — same concept as the web sandbox.
  // Each item references a registered component + resolved props (explicit
  // props, else the named fixture's props). Items whose component isn't
  // registered are dropped. Views are DATA: they ride the dataPayload below
  // (bridge-inline / boot fetch / baked data module), never the registry.
  const registeredSet = new Set(registeredComponents);
  const components = opts.config?.components ?? {};
  const views: Record<string, NativeViewItem[]> = {};
  for (const [name, view] of Object.entries(opts.config?.views ?? {})) {
    const items = resolveNativeViewItems(view, registeredSet, components);
    if (items.length) views[name] = items;
  }

  // The full data payload (views + scenario seeds + mock-network + the
  // AsyncStorage seed). Baked below as the offline fallback AND returned so
  // the host can serve it from the bridge's GET /data endpoint and ship the
  // per-target slices inline with every navigate.
  const dataPayload: NativeDataPayload = {
    views,
    scenarios: resolveNativeScenarioSeeds(opts.config),
    mockNetwork: resolveNativeMockData(opts.config?.mockNetwork),
    asyncStorage: Object.entries(opts.config?.mockNetwork?.asyncStorage ?? {}),
  };

  // Bake the data payload as the offline/cold fallback (delivery rung 3 — see
  // NativeDataPayload). Written via writeIfChanged and NOT writeTracked: it is
  // EXCLUDED from contentHash by construction (it never enters `contentParts`),
  // which is the whole iteration-speed contract — a views_create / scenario /
  // mock edit must not flip contentHash and trigger the kill-Metro + --clear
  // path. The host delivers fresher copies out-of-band (bridge GET /data +
  // inline navigate slices), so this staleness only matters when no host is
  // driving (genuinely offline / manual use).
  const dataModulePath = resolve(outDir, 'validity-native-data.ts');
  writeIfChanged(dataModulePath, renderNativeDataModule(dataPayload));

  const registryPath = resolve(outDir, 'component-registry.tsx');
  writeTracked(registryPath, renderRegistry(outDir, projectRoot, registeredComponents));

  const mockModulePath = resolve(outDir, 'validity-native-mocks.ts');
  writeTracked(mockModulePath, renderNativeMockModule());

  const asyncStorageModulePath = resolve(outDir, 'validity-native-asyncstorage.ts');
  writeTracked(asyncStorageModulePath, renderAsyncStorageSeed());

  const polyfillsPath = resolve(outDir, 'validity-native-polyfills.ts');
  writeTracked(polyfillsPath, renderPolyfills());

  // Own the native splash/launch-screen lifecycle (the companion never runs the
  // host startup that would dismiss it). Per-project: real when the app ships
  // expo-splash-screen, a no-op otherwise — the template's import resolves either way.
  const splashModulePath = resolve(outDir, 'validity-native-splash.ts');
  writeTracked(splashModulePath, renderNativeSplashModule(detection));

  // Stable device identity for the bridge hello (per-project conditional
  // imports, like the splash module) — the template's import always resolves.
  const identityModulePath = resolve(outDir, 'validity-native-identity.ts');
  writeTracked(identityModulePath, renderNativeIdentityModule(detection));

  // Replicate the host's runtime font loading (useFonts/Font.loadAsync) so
  // isolated components render with the design-system typography, not the
  // system fallback. Scanned from source + .validity/config.ts native.fonts.
  const fonts = resolveNativeFonts(projectRoot, opts.config?.native?.fonts);
  const fontsModulePath = resolve(outDir, 'validity-native-fonts.ts');
  writeTracked(fontsModulePath, renderNativeFontsModule(outDir, fonts));

  // Auto-mocked navigation contexts (generated, conditional import) — the shell
  // imports NavigationMockProvider from here so screens that call React
  // Navigation / expo-router hooks render in isolation. Written before the
  // wrapper/entry so the file exists by the time Metro resolves the shell.
  const navModulePath = resolve(outDir, 'validity-native-nav.tsx');
  writeTracked(navModulePath, renderNativeNavModule(detection));

  // createContext deep-default auto-mock — lets app context hooks (useAuth/
  // useTheme/…) render in isolation. Imported by native-entry in a specific
  // position (after the nav contexts, before user screens); see renderEntry.
  const contextPatchPath = resolve(outDir, 'validity-native-context-patch.ts');
  writeTracked(contextPatchPath, renderContextPatch());

  // expo-router store mock — the companion's metro.config aliases the real
  // expo-router store module to this so the router's hooks AND components render
  // in isolation. Generated only for expo-router; harmless otherwise (the alias
  // that points at it is likewise only emitted for expo-router apps).
  if (detection.router === 'expo-router') {
    writeTracked(
      resolve(outDir, 'validity-expo-router-store-mock.js'),
      renderExpoRouterStoreMock(),
    );
  }

  // GestureHandlerRootView wrapper (conditional import) — the shell mounts this
  // around every isolated screen so gesture components don't hard-crash.
  const ghModulePath = resolve(outDir, 'validity-native-gh.tsx');
  writeTracked(ghModulePath, renderGestureRootModule(detection));

  const wrapperPath = resolve(outDir, 'validity-native-wrapper.tsx');
  writeTracked(wrapperPath, renderNativeWrapper(outDir, projectRoot, detection));

  const entryPath = resolve(outDir, 'native-entry.tsx');
  writeTracked(entryPath, renderEntry(detection, opts.bridgeUrl));

  // Views are NOT part of the structure: they ship inline per-navigation
  // (see the structureHash doc above — the hash itself no longer gates
  // rebuilds, but it must stay a truthful identity of the registered set).
  const structureHash = createHash('sha256')
    .update(JSON.stringify({ components: [...registeredComponents].sort() }))
    .digest('hex')
    .slice(0, 16);

  // contentHash = the EXACT generated/copied CODE Metro serves (every tracked
  // body above, keyed + sorted for determinism). UNLIKE structureHash, this
  // changes whenever a generated file's CONTENT changes — a fixed polyfills
  // body, a new registry import, an edited template. The companion-Metro
  // helper uses it to decide when to restart Metro with --clear: a
  // transform-cache hit would otherwise keep serving the OLD bundle even
  // though the file on disk is fixed (the "my edit never took effect" class of
  // bug). It is NOT folded into buildHash — content changes need a Metro cache
  // reset, not a multi-minute native rebuild.
  //
  // EXCLUSION BOUNDARY (exactly two derived/data modules, nothing wider —
  // over-excluding would reintroduce the "edit never took effect" class the
  // hash exists to prevent, so prepare-native.test.ts pins the scope with
  // negative cases):
  //   - validity-content-hash.ts — derived FROM the hash (circular otherwise);
  //   - validity-native-data.ts — pure DATA (views / scenario seeds /
  //     mock-network / AsyncStorage seed) that the host delivers out-of-band
  //     (inline navigate payloads + the bridge's GET /data boot fetch), so a
  //     views_create or a mock-handler edit costs a warm bridge re-target, not
  //     a kill-Metro + --clear + relaunch. Old-bundle safety is documented on
  //     renderNativeDataModule: the one-time template change that introduced
  //     the data path flipped contentHash itself, and any still-older bundle
  //     is caught by the hello stale-bundle guard and reloaded — so the
  //     exclusion needs no capability gating.
  const contentHash = createHash('sha256')
    .update(
      JSON.stringify(
        Object.keys(contentParts)
          .sort()
          .map((k) => [relative(outDir, k).replaceAll('\\', '/'), contentParts[k]]),
      ),
    )
    .digest('hex')
    .slice(0, 16);

  // Bake the contentHash itself into the bundle (ValidityNativeRoot sends it
  // in the bridge hello so the host can detect a stale running bundle). Written
  // AFTER the hash is computed and NOT tracked — it is derived from the tracked
  // content, so hashing it would be circular; and because it only ever changes
  // when contentHash changes, the --clear restart that change triggers is what
  // delivers it (no extra invalidation needed).
  writeIfChanged(resolve(outDir, 'validity-content-hash.ts'), renderContentHashModule(contentHash));

  return {
    outDir,
    entryPath,
    registryPath,
    mockModulePath,
    asyncStorageModulePath,
    dataModulePath,
    dataPayload,
    fontsModulePath,
    splashModulePath,
    navModulePath,
    registeredFontCount: fonts.entries.length,
    registeredComponents,
    detection,
    targetContract: {
      params: ['component', 'view', 'fixture', 'scenario', 'overrides'],
      example: 'myapp://validity?component=src/components/Button.tsx&fixture=primary',
    },
    structureHash,
    contentHash,
    scaffoldedWrapperPath,
  };
}
