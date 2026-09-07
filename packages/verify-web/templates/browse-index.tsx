/**
 * `<Index />` — design-tool-style home page of `validity browse`.
 *
 * Layout, post-redesign:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │                                                                  │
 *   │   ┌───── floating glass toolbar (top-center, draggable position) │
 *   │                                                                  │
 *   │              ╔═══════════════════════╗     ┌─ flyout inspector ─┐│
 *   │              ║                       ║     │  (default closed,   ││
 *   │   canvas →   ║   artboard (iframes)  ║     │   slides over canvas││
 *   │              ║                       ║     │   via ↹ rail)       ││
 *   │              ╚═══════════════════════╝     └─────────────────────┘│
 *   │                                                                  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * The persistent sidebar is gone. Component search lives in a ⌘P / Ctrl+P
 * palette (`<CommandPalette />`), which fuzzy-matches across every
 * known component + screen. The palette is the *only* way to navigate
 * between components — by design.
 *
 * Rendered when the URL has NO `?component=` param. Browse-only — the
 * verify path mounts the user's component directly via entry.tsx and
 * never hits this tree. That asymmetry is load-bearing: any change to
 * this file is invisible to the LLM verify pipeline, and the URL
 * contract verify depends on (`?component=…&fixture=…&scenario=…&propsId=…`
 * for single render) is untouched. The detail view frames simply iframe
 * into those very URLs, so what the user sees here matches the verify
 * screenshot.
 *
 * Routes (all encoded in the URL — share-link friendly):
 *
 *   /                                          → Auto-focus first item
 *   /?focus=<componentPath>                    → Specific component
 *   …&scenario=<id>                            → Scenario override
 *   …&inspect=1                                → Inspector mode on (default)
 *   …&inspect=0                                → Inspector mode off
 *   …&fullscreen=<frameId>                     → One frame, no chrome
 *   …&theme=light|dark|system                  → Iframe color-scheme
 *   …&bg=checker|grid|light|dark               → Canvas background
 *   …&flyout=1                                 → Flyout open
 *   …&palette=1                                → Palette open (auto-clears)
 *
 * Per-component viewport selection (Desktop / Tablet / Mobile) is stored
 * in localStorage (`validity:browse:viewports:<path>`) — too noisy for URL.
 *
 * The iframe inspector + theme override live inside the iframe itself
 * (validity-inspector.ts) — this template only sends postMessage commands
 * and renders the reported metrics in the flyout panel.
 *
 * This file is bundled by Vite at runtime. Keep it dependency-free
 * (just React) so the sandbox optimizeDeps list doesn't grow.
 */
/// <reference lib="dom" />
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

declare global {
  interface Window {
    __validityReady?: boolean;
  }
}

/* ----------------------------- Types ------------------------------ */

interface FixtureLike {
  description?: string;
  props?: Record<string, unknown>;
  inferred?: boolean;
}

interface ComponentEntry {
  props?: Record<string, unknown>;
  fixtures?: Record<string, FixtureLike>;
  /** Per-component scenario allow-list. Undefined → show every scenario.
   * Empty array → no scenarios apply (dropdown hidden).
   */
  scenarios?: string[];
  discovered?: boolean;
}

interface ScenarioEntry {
  description?: string;
}

interface NavigationEdgeLite {
  from: string;
  to: string;
  toPath: string;
  trigger: string;
  line: number;
  column: number;
}

interface ScreensEnvelope {
  screens: Array<{ path: string; routePath?: string }>;
  navigation: NavigationEdgeLite[];
  /** screenPath → array of component paths used inside that screen. */
  componentUsage?: Record<string, string[]>;
}

interface ViewItemLite {
  componentPath: string;
  fixtureName?: string;
  props?: Record<string, unknown>;
  label?: string;
  /** Frame group id — items sharing a value render in one device frame. */
  frame?: string;
}

interface ViewLite {
  name: string;
  title?: string;
  description?: string;
  layout?: 'stack' | 'grid';
  items: ViewItemLite[];
}

interface ViewsEnvelope {
  views: ViewLite[];
}

interface ValidityConfigLite {
  components?: Record<string, ComponentEntry>;
  scenarios?: Record<string, ScenarioEntry>;
  _screens?: ScreensEnvelope;
  _views?: ViewsEnvelope;
}

interface ViewportSpec {
  key: string;
  label: string;
  shortLabel: string;
  width: number;
  height: number;
}

/* --------------------------- Constants ---------------------------- */

const BUILTIN_VIEWPORTS: Record<'desktop' | 'tablet' | 'mobile', ViewportSpec> = {
  desktop: { key: 'desktop', label: 'Desktop', shortLabel: 'D', width: 1280, height: 800 },
  tablet: { key: 'tablet', label: 'Tablet', shortLabel: 'T', width: 768, height: 1024 },
  mobile: { key: 'mobile', label: 'Mobile', shortLabel: 'M', width: 375, height: 667 },
};

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 4.0;
const ZOOM_BUTTON_STEP = 0.1;

const STORAGE_KEY_VIEWPORTS_PREFIX = 'validity:browse:viewports:';
const STORAGE_KEY_DETAIL_ZOOM = 'validity:browse:detail-zoom';
const STORAGE_KEY_CHROME_THEME = 'validity:browse:chrome-theme';
const STORAGE_KEY_TOOLBAR_POS = 'validity:browse:toolbar-pos';
const STORAGE_KEY_PROP_OVERRIDES_PREFIX = 'validity:browse:overrides:';

function readPropOverrides(componentPath: string): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_PROP_OVERRIDES_PREFIX + componentPath);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function persistPropOverrides(
  componentPath: string,
  overrides: Record<string, unknown> | null,
): void {
  const key = STORAGE_KEY_PROP_OVERRIDES_PREFIX + componentPath;
  try {
    if (overrides === null || Object.keys(overrides).length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(overrides));
  } catch {
    /* ignore */
  }
}

/* ------------------------- URL state helpers ---------------------- */

interface CanvasUrlState {
  focus?: string;
  scenario?: string;
  inspect?: boolean;
  fullscreen?: string;
  iframeTheme?: 'light' | 'dark' | 'system';
  bgMode?: 'checker' | 'grid' | 'light' | 'dark';
  flyout?: boolean;
  propsFlyout?: boolean;
  palette?: boolean;
}

/* ------------------ Extracted props (from server) ----------------- */

interface ExtractedPropInfo {
  name: string;
  type: string;
  optional: boolean;
}

interface ExtractedPropsResponse {
  componentName: string | null;
  props: ExtractedPropInfo[];
}

function readCanvasUrl(): CanvasUrlState {
  const p = new URLSearchParams(window.location.search);
  const theme = p.get('theme');
  const bg = p.get('bg');
  const inspectParam = p.get('inspect');
  return {
    focus: p.get('focus') ?? undefined,
    scenario: p.get('scenario') ?? undefined,
    inspect: inspectParam === '1' ? true : inspectParam === '0' ? false : undefined,
    fullscreen: p.get('fullscreen') ?? undefined,
    iframeTheme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : undefined,
    bgMode: bg === 'checker' || bg === 'grid' || bg === 'light' || bg === 'dark' ? bg : undefined,
    flyout: p.get('flyout') === '1',
    propsFlyout: p.get('propsFlyout') === '1',
    palette: p.get('palette') === '1',
  };
}

function writeCanvasUrl(state: CanvasUrlState): void {
  const p = new URLSearchParams();
  if (state.focus) p.set('focus', state.focus);
  if (state.scenario) p.set('scenario', state.scenario);
  if (state.inspect === false) p.set('inspect', '0');
  if (state.fullscreen) p.set('fullscreen', state.fullscreen);
  if (state.iframeTheme && state.iframeTheme !== 'system') p.set('theme', state.iframeTheme);
  if (state.bgMode && state.bgMode !== 'checker') p.set('bg', state.bgMode);
  if (state.flyout) p.set('flyout', '1');
  if (state.propsFlyout) p.set('propsFlyout', '1');
  const qs = p.toString();
  const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, '', next);
}

function readDetailZoom(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_DETAIL_ZOOM);
    const n = raw ? parseFloat(raw) : 1;
    return Number.isFinite(n) ? clamp(n, ZOOM_MIN, ZOOM_MAX) : 1;
  } catch {
    return 1;
  }
}

function persistDetailZoom(zoom: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_DETAIL_ZOOM, String(zoom));
  } catch {
    /* ignore */
  }
}

function readChromeTheme(): 'light' | 'dark' {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_CHROME_THEME);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    /* ignore */
  }
  return 'dark';
}

function persistChromeTheme(t: 'light' | 'dark'): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_CHROME_THEME, t);
  } catch {
    /* ignore */
  }
}

type ToolbarPosition = 'top-center' | 'bottom-center' | 'top-left';

function readToolbarPosition(): ToolbarPosition {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_TOOLBAR_POS);
    if (raw === 'top-center' || raw === 'bottom-center' || raw === 'top-left') return raw;
  } catch {
    /* ignore */
  }
  return 'top-center';
}

function persistToolbarPosition(p: ToolbarPosition): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_TOOLBAR_POS, p);
  } catch {
    /* ignore */
  }
}

function readViewportSelection(componentPath: string): Set<string> {
  // Viewport is single-select; coerce any legacy multi-selection to its first
  // valid entry so old localStorage values don't re-introduce multi-frames.
  const key = STORAGE_KEY_VIEWPORTS_PREFIX + componentPath;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      if (Array.isArray(parsed)) {
        const first = parsed.find((v) => v === 'desktop' || v === 'tablet' || v === 'mobile');
        if (first) return new Set([first]);
      }
    }
  } catch {
    /* ignore */
  }
  return new Set(['desktop']);
}

function persistViewportSelection(componentPath: string, set: Set<string>): void {
  const key = STORAGE_KEY_VIEWPORTS_PREFIX + componentPath;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(set)));
  } catch {
    /* ignore */
  }
}

/* ----------- Build the iframe URL the verify path uses ------------ */

/**
 * Encode a prop-overrides record as a URL-safe base64 string. The iframe's
 * entry.tsx (generated from prepare.ts) decodes this and merges the result
 * over the resolved props before mount. base64 keeps URLs out of the
 * "looks scary" reserved-char territory and survives copy-paste; for big
 * payloads users should be authoring fixtures, not URL overrides.
 */
function encodeOverrides(overrides: Record<string, unknown>): string {
  const json = JSON.stringify(overrides);
  if (typeof window !== 'undefined' && typeof window.btoa === 'function') {
    // btoa expects Latin-1. JSON output may include non-ASCII, so route
    // through encodeURIComponent → unescape to widen the safe input range.
    return window.btoa(unescape(encodeURIComponent(json)));
  }
  // SSR/test path — fall back to raw JSON. The iframe still parses it
  // via the same `decodeOverrides` route.
  return encodeURIComponent(json);
}

function buildFrameUrl(
  componentPath: string,
  stateId: string,
  scenarioId: string,
  overrides?: Record<string, unknown>,
): string {
  const p = new URLSearchParams();
  p.set('component', componentPath);
  if (stateId) p.set('fixture', stateId);
  if (scenarioId) p.set('scenario', scenarioId);
  if (overrides && Object.keys(overrides).length > 0) {
    p.set('overrides', encodeOverrides(overrides));
  }
  return `/?${p.toString()}`;
}

function buildViewFrameUrl(viewName: string, scenarioId: string, frameKey?: string): string {
  const p = new URLSearchParams();
  p.set('view', viewName);
  if (frameKey) p.set('frame', frameKey);
  if (scenarioId) p.set('scenario', scenarioId);
  return `/?${p.toString()}`;
}

/**
 * Frame grouping key for a view item — MUST match the iframe side
 * (prepare.ts): an item's explicit `frame`, else "auto:" + componentPath.
 * Items sharing a key render together in one device frame.
 */
function viewFrameKeyFor(item: ViewItemLite): string {
  return item.frame ?? 'auto:' + item.componentPath;
}

/**
 * Collapse a view's items into ordered frame groups (first appearance wins),
 * with a human label per group: the explicit frame id, else the component's
 * base filename (sans extension).
 */
function viewFrameGroups(view: ViewLite): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  const seen = new Set<string>();
  for (const item of view.items) {
    const key = viewFrameKeyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const base = item.componentPath.split('/').pop() ?? item.componentPath;
    const label = item.frame ?? base.replace(/\.(t|j)sx?$/, '');
    out.push({ key, label });
  }
  return out;
}

function makeFrameId(componentPath: string, stateId: string, viewportKey: string): string {
  return `${componentPath}__${stateId || 'default'}__${viewportKey}`;
}

/* ------------------------ Fuzzy match ----------------------------- */

/**
 * Case-insensitive subsequence with word-boundary bonus + early-match
 * bonus. Returns -1 when the query doesn't fully match. Tuned to feel
 * close to VS Code's Cmd+P — exact prefix is best, contiguous substring
 * next, then scattered chars.
 */
function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let ti = 0;
  let score = 0;
  let streak = 0;
  let firstMatch = -1;
  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      if (firstMatch < 0) firstMatch = ti;
      streak += 1;
      score += 4 + streak * 2;
      if (ti === 0 || /[/.\-_ ]/.test(t[ti - 1]!)) score += 6;
      qi += 1;
    } else {
      streak = 0;
    }
    ti += 1;
  }
  if (qi < q.length) return -1;
  score -= firstMatch * 0.3;
  return score;
}

interface PaletteItem {
  /** For components/screens: project-relative file path. For views: the view name. */
  path: string;
  name: string;
  /** 'view' = author-defined composition; not a real file path. */
  kind: 'screen' | 'component' | 'primitive' | 'view';
  routePath?: string;
  fixtures?: number;
}

function fuzzyRank(query: string, items: PaletteItem[]): PaletteItem[] {
  if (!query) return items;
  return items
    .map((it) => ({
      it,
      score: Math.max(fuzzyScore(query, it.name), fuzzyScore(query, it.path) - 1),
    }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.it);
}

/* ----------- Highlight matched chars (palette + flyout) ----------- */

function HighlightMatch(props: { text: string; query: string }): React.ReactElement {
  const { text, query } = props;
  if (!query) return <>{text}</>;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let qi = 0;
  let last = 0;
  for (let i = 0; i < text.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      if (i > last) parts.push(<span key={`n${last}`}>{text.slice(last, i)}</span>);
      parts.push(
        <span key={`m${i}`} style={{ color: '#9ec6ff', fontWeight: 600 }}>
          {text[i]}
        </span>,
      );
      last = i + 1;
      qi += 1;
    }
  }
  if (last < text.length) parts.push(<span key={`e${last}`}>{text.slice(last)}</span>);
  return <>{parts}</>;
}

/* --------------------- Inspector message types -------------------- */

interface InspectorPayload {
  tagName: string;
  id?: string;
  classList: string[];
  rect: { x: number; y: number; width: number; height: number };
  padding: { top: number; right: number; bottom: number; left: number };
  margin: { top: number; right: number; bottom: number; left: number };
  border: { top: number; right: number; bottom: number; left: number };
  font: {
    family: string;
    size: string;
    weight: string;
    lineHeight: string;
    color: string;
  };
  background: string;
  display: string;
  position: string;
  opacity: string;
  componentPath?: string;
  componentName?: string;
  computedSnapshot: Array<{ property: string; value: string }>;
  sourceFrameId?: string;
}

interface DistancePayload {
  horizontal: number;
  vertical: number;
  selectionRect: { x: number; y: number; width: number; height: number };
  hoverRect: { x: number; y: number; width: number; height: number };
}

/* ====================================================================== *
 *                              <Index />                                 *
 * ====================================================================== */

export function Index(): React.ReactElement {
  const [config, setConfig] = useState<ValidityConfigLite | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const initialUrl = useMemo(readCanvasUrl, []);

  const [focus, setFocus] = useState<string | null>(initialUrl.focus ?? null);
  const [scenarioId, setScenarioId] = useState<string>(initialUrl.scenario ?? '');
  const [inspect, setInspect] = useState<boolean>(
    initialUrl.inspect !== undefined ? initialUrl.inspect : true,
  );
  const [fullscreen, setFullscreen] = useState<string | null>(initialUrl.fullscreen ?? null);
  const [iframeTheme, setIframeTheme] = useState<'light' | 'dark' | 'system'>(
    initialUrl.iframeTheme ?? 'system',
  );
  const [bgMode, setBgMode] = useState<'checker' | 'grid' | 'light' | 'dark'>(
    initialUrl.bgMode ?? 'checker',
  );
  const [chromeTheme, setChromeTheme] = useState<'light' | 'dark'>(readChromeTheme);
  // Toolbar position is read once and never reset from the UI today (the
  // user's localStorage carries forward); future setter wiring will live
  // alongside a position-picker in the toolbar overflow menu.
  const [toolbarPosition] = useState<ToolbarPosition>(readToolbarPosition);

  // Flyout: defaults to CLOSED unless the URL says open. Auto-opens when
  // the user pins an element in design mode (so they see the details
  // without a second click).
  const [flyoutOpen, setFlyoutOpen] = useState<boolean>(initialUrl.flyout ?? false);
  // Props flyout (left side, mirror of the right-side inspector). Toggled
  // via the toolbar button or bare "P" — the user authors live prop
  // overrides here while the iframe re-renders with the new ?overrides=…
  // payload baked into the URL.
  const [propsFlyoutOpen, setPropsFlyoutOpen] = useState<boolean>(initialUrl.propsFlyout ?? false);
  // Palette state isn't sticky in localStorage — the URL flag is one-shot
  // and we clear it the first render.
  const [paletteOpen, setPaletteOpen] = useState<boolean>(initialUrl.palette ?? false);

  const [detailZoom, setDetailZoom] = useState<number>(readDetailZoom);
  const [detailPan, setDetailPan] = useState<{ x: number; y: number }>({ x: 32, y: 32 });
  const [fitTick, setFitTick] = useState(1);

  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  const [inspectorSelection, setInspectorSelection] = useState<InspectorPayload | null>(null);
  const [inspectorHover, setInspectorHover] = useState<InspectorPayload | null>(null);
  const [inspectorDistance, setInspectorDistance] = useState<DistancePayload | null>(null);
  const [inspectActiveFrameId, setInspectActiveFrameId] = useState<string | null>(null);

  const [viewportSelection, setViewportSelection] = useState<Set<string>>(new Set(['desktop']));

  // Per-component prop overrides. The props flyout writes here; the iframe
  // URL embeds them as base64 JSON so the verify-path entry can merge them
  // over the auto-mocked / fixture-resolved props at mount time. Empty
  // entries are pruned when persisted to localStorage.
  const [propOverridesByComponent, setPropOverridesByComponent] = useState<
    Record<string, Record<string, unknown>>
  >({});

  // Cached prop-type metadata keyed by component path. The Props flyout
  // fetches /__validity/api/props on focus change and stores the result
  // here so subsequent navigation back is instant. `null` means "request
  // in flight", missing means "not yet requested".
  const [extractedPropsByComponent, setExtractedPropsByComponent] = useState<
    Record<string, ExtractedPropsResponse | null>
  >({});

  const refreshConfig = useCallback((): Promise<void> => {
    return fetch('/__validity/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('non-2xx'))))
      .then((cfg: ValidityConfigLite) => {
        setConfig(cfg);
        setLoadError(null);
      })
      .catch((err: unknown) => setLoadError((err as Error).message ?? String(err)));
  }, []);

  useEffect(() => {
    void refreshConfig();
  }, [refreshConfig]);

  // Persist URL state on every change.
  useEffect(() => {
    writeCanvasUrl({
      focus: focus ?? undefined,
      scenario: scenarioId || undefined,
      inspect,
      fullscreen: fullscreen ?? undefined,
      iframeTheme,
      bgMode,
      flyout: flyoutOpen ? true : undefined,
      propsFlyout: propsFlyoutOpen ? true : undefined,
    });
  }, [focus, scenarioId, inspect, fullscreen, iframeTheme, bgMode, flyoutOpen, propsFlyoutOpen]);

  useEffect(() => {
    persistDetailZoom(detailZoom);
  }, [detailZoom]);

  useEffect(() => {
    persistChromeTheme(chromeTheme);
    document.documentElement.setAttribute('data-validity-chrome', chromeTheme);
  }, [chromeTheme]);

  useEffect(() => {
    persistToolbarPosition(toolbarPosition);
  }, [toolbarPosition]);

  // navigate({ viewport }) stashes the requested viewport here so the
  // focus-change effect applies it instead of the persisted/default one
  // (one-shot — cleared on read). Without this, navigating to a view (or
  // component) with an explicit viewport would be clobbered when the focus
  // effect fires immediately after focus commits.
  const pendingViewportRef = useRef<string | null>(null);

  // Load per-component viewport selection when focus changes.
  useEffect(() => {
    if (focus) {
      const pendingViewport = pendingViewportRef.current;
      pendingViewportRef.current = null;
      setViewportSelection(
        pendingViewport ? new Set([pendingViewport]) : readViewportSelection(focus),
      );
      setDetailPan({ x: 32, y: 32 });
      setDetailZoom(1);
      setFitTick((t) => t + 1);
      // Hydrate persisted prop overrides for the new focus. Only seeds the
      // entry for this component — others (cached or stale) are pruned to
      // keep the state object small.
      setPropOverridesByComponent((prev) => {
        const persisted = readPropOverrides(focus);
        if (Object.keys(persisted).length === 0) {
          if (!prev[focus]) return prev;
          const next = { ...prev };
          delete next[focus];
          return next;
        }
        return { ...prev, [focus]: persisted };
      });
    }
    setInspectorSelection(null);
    setInspectorHover(null);
    setInspectorDistance(null);
    setInspectActiveFrameId(null);
    // Also drop scenarioId when it's no longer in the component's allow-list.
    // The effect below (after config load) handles that case via filter.
  }, [focus]);

  useEffect(() => {
    if (focus) persistViewportSelection(focus, viewportSelection);
  }, [focus, viewportSelection]);

  // Fetch extracted prop types for the current focus when the Props flyout
  // is open and we haven't cached this component yet. Sentinel value `null`
  // distinguishes "request in flight" from "haven't asked yet". A 200 with
  // an empty `props` array is a legitimate response (inference failed
  // gracefully); we still cache it so the spinner doesn't hang.
  //
  // We deliberately exclude extractedPropsByComponent from deps and read it
  // through a ref: depending on it would mean every successful setState
  // (including our own `[focus]: null` placeholder) re-runs the effect,
  // which fires the cleanup → cancels the in-flight fetch → leaves the
  // panel stuck on "Loading props…" forever.
  const extractedPropsRef = useRef(extractedPropsByComponent);
  extractedPropsRef.current = extractedPropsByComponent;
  useEffect(() => {
    if (!focus || !propsFlyoutOpen) return;
    if (focus in extractedPropsRef.current) return;
    setExtractedPropsByComponent((prev) => ({ ...prev, [focus]: null }));
    let cancelled = false;
    fetch(`/__validity/api/props?component=${encodeURIComponent(focus)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('non-2xx'))))
      .then((data: ExtractedPropsResponse) => {
        if (cancelled) return;
        setExtractedPropsByComponent((prev) => ({ ...prev, [focus]: data }));
      })
      .catch(() => {
        if (cancelled) return;
        // Fall back to an empty result so the UI can render "no inferred
        // props" instead of a perpetual spinner.
        setExtractedPropsByComponent((prev) => ({
          ...prev,
          [focus]: { componentName: null, props: [] },
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [focus, propsFlyoutOpen]);

  // Auto-focus the first available item once the config arrives so the
  // user lands directly on a component.
  useEffect(() => {
    if (focus || !config) return;
    const comps = config.components ?? {};
    const screens = config._screens?.screens ?? [];
    const firstScreen =
      screens.length > 0
        ? [...screens].sort((a, b) => a.path.localeCompare(b.path))[0]?.path
        : undefined;
    const firstComponent = Object.keys(comps).sort()[0];
    const next = firstScreen ?? firstComponent;
    if (next) setFocus(next);
  }, [config, focus]);

  // Ready signal — same shape verify's wait uses.
  useEffect(() => {
    window.__validityReady = true;
    document.documentElement.setAttribute('data-validity-ready', 'true');
  }, []);

  // LLM → page bridge. Subscribes to /__validity/bridge and dispatches
  // navigate / scenario / propOverrides commands into the same state setters
  // the toolbar uses. Strictly one-way (server → page); the socket sends
  // nothing back. If the dev server hasn't attached a bridge (verify mode,
  // older builds), the WS upgrade fails silently and the reconnect loop
  // keeps trying at a slow cadence — harmless.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let cancelled = false;
    let reconnectTimer: number | null = null;

    const connect = (): void => {
      if (cancelled) return;
      try {
        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${proto}//${window.location.host}/__validity/bridge`);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.addEventListener('message', (evt) => {
        let msg: unknown;
        try {
          msg = typeof evt.data === 'string' ? JSON.parse(evt.data) : null;
        } catch {
          return;
        }
        handleBridgeMessage(msg);
      });
      ws.addEventListener('close', () => {
        if (!cancelled) scheduleReconnect();
      });
      ws.addEventListener('error', () => {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      });
    };

    const scheduleReconnect = (): void => {
      if (cancelled || reconnectTimer !== null) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2000);
    };

    const handleBridgeMessage = (msg: unknown): void => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string } & Record<string, unknown>;
      switch (m.type) {
        case 'configRefresh': {
          void refreshConfig();
          break;
        }
        case 'navigate': {
          // View navigation takes precedence — refresh config first so a
          // just-created view is visible by the time we set focus.
          const viewName = typeof m.view === 'string' ? m.view : null;
          if (viewName) {
            // Stash the viewport so the focus-change effect (which fires after
            // setFocus commits) applies it rather than overwriting it with the
            // persisted/default selection.
            if (m.viewport === 'desktop' || m.viewport === 'tablet' || m.viewport === 'mobile') {
              pendingViewportRef.current = m.viewport;
              setViewportSelection(new Set([m.viewport]));
            }
            void refreshConfig().then(() => setFocus(viewName));
            if (typeof m.scenario === 'string') setScenarioId(m.scenario);
            break;
          }
          const path = typeof m.path === 'string' ? m.path : null;
          if (m.viewport === 'desktop' || m.viewport === 'tablet' || m.viewport === 'mobile') {
            pendingViewportRef.current = m.viewport;
            setViewportSelection(new Set([m.viewport]));
          }
          if (path) setFocus(path);
          if (typeof m.scenario === 'string') setScenarioId(m.scenario);
          if (m.propOverrides && typeof m.propOverrides === 'object' && path) {
            const overrides = m.propOverrides as Record<string, unknown>;
            setPropOverridesByComponent((prev) => ({ ...prev, [path]: overrides }));
            persistPropOverrides(path, overrides);
          } else if (m.propOverrides === null && path) {
            setPropOverridesByComponent((prev) => {
              if (!prev[path]) return prev;
              const next = { ...prev };
              delete next[path];
              return next;
            });
            persistPropOverrides(path, null);
          }
          break;
        }
        case 'scenario': {
          if (typeof m.id === 'string') setScenarioId(m.id);
          break;
        }
        case 'propOverrides': {
          const component = typeof m.component === 'string' ? m.component : null;
          if (!component) break;
          if (m.overrides === null) {
            setPropOverridesByComponent((prev) => {
              if (!prev[component]) return prev;
              const next = { ...prev };
              delete next[component];
              return next;
            });
            persistPropOverrides(component, null);
          } else if (m.overrides && typeof m.overrides === 'object') {
            const overrides = m.overrides as Record<string, unknown>;
            setPropOverridesByComponent((prev) => ({ ...prev, [component]: overrides }));
            persistPropOverrides(component, overrides);
          }
          break;
        }
        case 'ping':
          // Heartbeat from the MCP server — nothing to do, but logging at
          // info would be useful if debugging connectivity later.
          break;
      }
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only effect: connect() opens the websocket once; listing closure deps (refreshConfig) would tear down and reopen the socket on every render
  }, []);

  // Wheel handling — shared between the canvas's own listener and
  // forwarded wheel events from inside iframes (validity-inspector.ts).
  const applyDetailWheel = useCallback(
    (
      deltaX: number,
      deltaY: number,
      ctrlKey: boolean,
      shiftKey: boolean,
      cursorX: number,
      cursorY: number,
    ): void => {
      if (ctrlKey) {
        setDetailZoom((prevZoom) => {
          // Design-tool zoom response: cap one event's contribution so a
          // single mouse-wheel notch steps ~20%, while a trackpad pinch
          // (a stream of small deltas) tracks the gesture smoothly and
          // proportionally. The old uncapped 0.0015 made pinches feel
          // dead (a delta-5 pinch event moved zoom by <1%).
          const scaled = clamp(deltaY, -60, 60);
          const factor = Math.exp(-scaled * 0.003);
          const next = clamp(prevZoom * factor, ZOOM_MIN, ZOOM_MAX);
          if (next === prevZoom) return prevZoom;
          setDetailPan((prevPan) => {
            const scaleRatio = next / prevZoom;
            return {
              x: cursorX - scaleRatio * (cursorX - prevPan.x),
              y: cursorY - scaleRatio * (cursorY - prevPan.y),
            };
          });
          return next;
        });
      } else {
        const dx = shiftKey ? -deltaY : -deltaX;
        const dy = shiftKey ? 0 : -deltaY;
        setDetailPan((prevPan) => ({ x: prevPan.x + dx, y: prevPan.y + dy }));
      }
    },
    [],
  );

  // Pinch / ⌘+wheel ANYWHERE must zoom the canvas — never the browser page.
  // The canvas viewport and the iframes have their own listeners (which call
  // preventDefault); this window-level net catches everything else — the
  // toolbar, flyouts, empty chrome — so native page-zoom (which scales the
  // whole UI, toolbar included) can never fire. The zoom still anchors to
  // the cursor: the canvas sits full-screen behind the chrome, so the
  // cursor's viewport position is always a meaningful focal point.
  useEffect(() => {
    const onWindowWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.defaultPrevented) return; // the canvas listener already handled it
      e.preventDefault();
      const viewportEl = document.querySelector<HTMLElement>(
        '[data-validity-detail-viewport="true"]',
      );
      if (!viewportEl) return; // no canvas on screen — just block page zoom
      const rect = viewportEl.getBoundingClientRect();
      const deltaScale = e.deltaMode === 1 ? 16 : 1;
      applyDetailWheel(
        e.deltaX * deltaScale,
        e.deltaY * deltaScale,
        true,
        e.shiftKey,
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
    };
    // Safari doesn't synthesize ctrl+wheel for trackpad pinch — it fires
    // proprietary gesture events that trigger page zoom unless cancelled.
    const preventGesture = (e: Event): void => e.preventDefault();
    window.addEventListener('wheel', onWindowWheel, { passive: false });
    window.addEventListener('gesturestart', preventGesture);
    window.addEventListener('gesturechange', preventGesture);
    return () => {
      window.removeEventListener('wheel', onWindowWheel);
      window.removeEventListener('gesturestart', preventGesture);
      window.removeEventListener('gesturechange', preventGesture);
    };
  }, [applyDetailWheel]);

  // Receive inspector messages from any iframe.
  useEffect(() => {
    const handler = (e: MessageEvent): void => {
      const data = e.data as {
        type: string;
        frameId?: string;
        payload?: unknown;
        mode?: string;
      } | null;
      if (!data || typeof data.type !== 'string') return;
      if (!data.type.startsWith('validity:inspect:')) return;
      const incomingFrameId = data.frameId;
      switch (data.type) {
        case 'validity:inspect:ready': {
          let resolvedFrameId = incomingFrameId ?? null;
          if (!resolvedFrameId) {
            const frames = Array.from(
              document.querySelectorAll<HTMLIFrameElement>('iframe[data-validity-iframe]'),
            );
            for (const f of frames) {
              if (f.contentWindow === e.source) {
                resolvedFrameId = f.getAttribute('data-validity-iframe');
                break;
              }
            }
          }
          if (resolvedFrameId) {
            postToFrame(resolvedFrameId, {
              type: inspect ? 'validity:inspect:enable' : 'validity:inspect:disable',
            });
            if (iframeTheme !== 'system') {
              postToFrame(resolvedFrameId, { type: 'validity:theme:set', mode: iframeTheme });
            }
          }
          break;
        }
        case 'validity:inspect:select': {
          const payload = data.payload as InspectorPayload;
          setInspectorSelection({ ...payload, sourceFrameId: incomingFrameId });
          setInspectActiveFrameId(incomingFrameId ?? null);
          // Pop the flyout open on pin — central UX for design mode.
          setFlyoutOpen(true);
          break;
        }
        case 'validity:inspect:hover': {
          const payload = data.payload as InspectorPayload;
          setInspectorHover({ ...payload, sourceFrameId: incomingFrameId });
          break;
        }
        case 'validity:inspect:distance': {
          const payload = data.payload as DistancePayload;
          setInspectorDistance(payload);
          break;
        }
        case 'validity:inspect:clear':
          setInspectorSelection(null);
          setInspectorDistance(null);
          break;
        case 'validity:inspect:wheel': {
          if (!focus) return;
          const fid = incomingFrameId;
          if (!fid) return;
          const iframeEl = document.querySelector<HTMLIFrameElement>(
            `iframe[data-validity-iframe="${cssEscape(fid)}"]`,
          );
          const viewportEl = document.querySelector<HTMLElement>(
            '[data-validity-detail-viewport="true"]',
          );
          if (!iframeEl || !viewportEl) return;
          const iframeRect = iframeEl.getBoundingClientRect();
          const viewportRect = viewportEl.getBoundingClientRect();
          const wheel = data as unknown as {
            deltaX: number;
            deltaY: number;
            ctrlKey: boolean;
            shiftKey: boolean;
            iframeX: number;
            iframeY: number;
          };
          const parentCursorX = iframeRect.left + wheel.iframeX * detailZoom - viewportRect.left;
          const parentCursorY = iframeRect.top + wheel.iframeY * detailZoom - viewportRect.top;
          applyDetailWheel(
            wheel.deltaX,
            wheel.deltaY,
            wheel.ctrlKey,
            wheel.shiftKey,
            parentCursorX,
            parentCursorY,
          );
          break;
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [inspect, iframeTheme, focus, detailZoom, applyDetailWheel]);

  // Broadcast on inspect toggle.
  useEffect(() => {
    broadcastToFrames({
      type: inspect ? 'validity:inspect:enable' : 'validity:inspect:disable',
    });
    if (!inspect) {
      setInspectorSelection(null);
      setInspectorDistance(null);
    }
  }, [inspect]);

  // Theme override broadcast.
  useEffect(() => {
    broadcastToFrames({ type: 'validity:theme:set', mode: iframeTheme });
  }, [iframeTheme]);

  // Keyboard shortcuts.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      // ⌘/Ctrl+P opens the palette — works from anywhere INCLUDING fields
      // (it's the only way to navigate, so blocking it on focus would
      // be too punishing).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // Cmd/Ctrl+\ toggles flyout (Cmd/Ctrl-B kept as an alternate).
      if ((e.metaKey || e.ctrlKey) && (e.key === '\\' || e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        setFlyoutOpen((v) => !v);
        return;
      }
      if (inField) return;
      if (e.altKey) return;
      switch (e.key) {
        case 'Escape':
          if (paletteOpen) setPaletteOpen(false);
          else if (fullscreen) setFullscreen(null);
          else if (inspectorSelection) {
            broadcastToFrames({ type: 'validity:inspect:clear-selection' });
            setInspectorSelection(null);
          } else if (helpOpen) setHelpOpen(false);
          else if (flyoutOpen) setFlyoutOpen(false);
          else if (propsFlyoutOpen) setPropsFlyoutOpen(false);
          break;
        case 'i':
        case 'I':
          setInspect((v) => !v);
          break;
        case 'f':
        case 'F':
          if (fullscreen) setFullscreen(null);
          else if (inspectActiveFrameId) setFullscreen(inspectActiveFrameId);
          break;
        case '\\':
          setFlyoutOpen((v) => !v);
          break;
        case 'p':
        case 'P':
          // Bare P toggles the Props flyout. ⌘P / Ctrl+P (palette) is
          // handled in the early-return block above, so by the time we
          // reach the switch we're guaranteed no modifier was held.
          if (focus) setPropsFlyoutOpen((v) => !v);
          break;
        case '?':
        case '/':
          if (e.shiftKey || e.key === '?') setHelpOpen((v) => !v);
          break;
        case '+':
        case '=':
          if (focus) setDetailZoom((z) => clamp(z + ZOOM_BUTTON_STEP, ZOOM_MIN, ZOOM_MAX));
          break;
        case '-':
        case '_':
          if (focus) setDetailZoom((z) => clamp(z - ZOOM_BUTTON_STEP, ZOOM_MIN, ZOOM_MAX));
          break;
        case '0':
          if (focus) {
            setDetailZoom(1);
            setDetailPan({ x: 32, y: 32 });
          }
          break;
        case 'd':
        case 'D':
          if (focus) toggleViewport('desktop');
          break;
        case 't':
        case 'T':
          if (focus) toggleViewport('tablet');
          break;
        case 'm':
        case 'M':
          if (focus) toggleViewport('mobile');
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    focus,
    inspect,
    inspectorSelection,
    inspectActiveFrameId,
    fullscreen,
    helpOpen,
    paletteOpen,
    flyoutOpen,
    propsFlyoutOpen,
  ]);

  // Viewport is single-select: picking a device shows ALL frames at that one
  // size (Desktop | Tablet | Mobile tabs), rather than toggling device frames
  // on/off. Selecting the already-active viewport is a no-op.
  function toggleViewport(key: string): void {
    setViewportSelection((prev) => (prev.has(key) && prev.size === 1 ? prev : new Set([key])));
  }

  // Derived data — compute even when config is null so hook order stays
  // stable through the loading state.
  // These derived values are intentionally recomputed each render (cheap, and
  // this is a dev-only browse UI). Wrapping them in useMemo purely to satisfy
  // exhaustive-deps would add ceremony without benefit, and a lint pass must
  // not change the template's runtime behavior.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const components = config?.components ?? {};
  const scenarios = useMemo(() => Object.keys(config?.scenarios ?? {}), [config]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see note above; fresh literal each render is intentional
  const screensEnvelope: ScreensEnvelope = config?._screens ?? {
    screens: [],
    navigation: [],
    componentUsage: {},
  };
  const screenPathSet = useMemo(
    () => new Set(screensEnvelope.screens.map((s) => s.path)),
    [screensEnvelope],
  );
  const routePathByScreen = useMemo(() => {
    const m = new Map<string, string | undefined>();
    for (const s of screensEnvelope.screens) m.set(s.path, s.routePath);
    return m;
  }, [screensEnvelope]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- see note above; fresh literal each render is intentional
  const viewsEnvelope: ViewsEnvelope = config?._views ?? { views: [] };
  const viewByName = useMemo(() => {
    const m = new Map<string, ViewLite>();
    for (const v of viewsEnvelope.views) m.set(v.name, v);
    return m;
  }, [viewsEnvelope]);

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    // Views first — author-defined groupings sort above auto-discovered
    // files. The fuzzy ranker can still bump a closer-text match higher.
    for (const v of viewsEnvelope.views) {
      items.push({
        path: v.name,
        name: v.title ?? v.name,
        kind: 'view',
      });
    }
    for (const [path, entry] of Object.entries(components)) {
      const fixtureCount = entry.fixtures ? Object.keys(entry.fixtures).length : 0;
      items.push({
        path,
        name: basename(path),
        kind: kindForPath(path, screenPathSet),
        routePath: routePathByScreen.get(path),
        fixtures: fixtureCount,
      });
    }
    items.sort((a, b) => {
      if (a.kind !== b.kind) {
        const rank = { view: 0, screen: 1, component: 2, primitive: 3 } as const;
        return rank[a.kind] - rank[b.kind];
      }
      return a.name.localeCompare(b.name);
    });
    return items;
  }, [components, screenPathSet, routePathByScreen, viewsEnvelope]);

  const focusedView: ViewLite | undefined = focus ? viewByName.get(focus) : undefined;
  const focusedEntry = focus && !focusedView ? components[focus] : undefined;
  const applicableScenarios = useMemo(
    () => computeApplicableScenarios(focusedEntry, scenarios),
    [focusedEntry, scenarios],
  );

  // If the URL had a scenario that doesn't apply to this component,
  // drop it silently — user can re-pick from the dropdown.
  useEffect(() => {
    if (scenarioId && !applicableScenarios.includes(scenarioId)) {
      setScenarioId('');
    }
  }, [focus, applicableScenarios, scenarioId]);

  if (loadError) {
    return <ErrorScreen message={`Failed to load /__validity/api/config: ${loadError}`} />;
  }
  if (!config) return <LoadingScreen />;

  const isFullscreen = fullscreen !== null;
  const currentItem: PaletteItem | undefined = focus
    ? paletteItems.find((p) => p.path === focus)
    : undefined;

  return (
    <div
      data-validity-canvas="true"
      data-validity-chrome={chromeTheme}
      style={{
        ...styles.shell,
        ...(chromeTheme === 'light' ? styles.shellLight : null),
      }}
    >
      {/* Canvas — full screen behind the chrome */}
      {focus && focusedView ? (
        <ViewDetailView
          view={focusedView}
          viewports={viewportSelection}
          zoom={detailZoom}
          pan={detailPan}
          scenarioId={scenarioId}
          bgMode={bgMode}
          inspect={inspect}
          fullscreen={fullscreen}
          fitTick={fitTick}
          onFullscreen={setFullscreen}
          onPan={setDetailPan}
          onZoom={(z) => setDetailZoom(clamp(z, ZOOM_MIN, ZOOM_MAX))}
          onWheel={(e, viewportRect) => {
            e.preventDefault();
            const deltaScale = e.deltaMode === 1 ? 16 : 1;
            applyDetailWheel(
              e.deltaX * deltaScale,
              e.deltaY * deltaScale,
              e.ctrlKey || e.metaKey,
              e.shiftKey,
              e.clientX - viewportRect.left,
              e.clientY - viewportRect.top,
            );
          }}
        />
      ) : focus && focusedEntry ? (
        <DetailView
          componentPath={focus}
          entry={focusedEntry}
          viewports={viewportSelection}
          zoom={detailZoom}
          pan={detailPan}
          scenarioId={scenarioId}
          propOverrides={propOverridesByComponent[focus]}
          bgMode={bgMode}
          inspect={inspect}
          fullscreen={fullscreen}
          fitTick={fitTick}
          onFullscreen={setFullscreen}
          onPan={setDetailPan}
          onZoom={(z) => setDetailZoom(clamp(z, ZOOM_MIN, ZOOM_MAX))}
          onWheel={(e, viewportRect) => {
            e.preventDefault();
            const deltaScale = e.deltaMode === 1 ? 16 : 1;
            applyDetailWheel(
              e.deltaX * deltaScale,
              e.deltaY * deltaScale,
              e.ctrlKey || e.metaKey,
              e.shiftKey,
              e.clientX - viewportRect.left,
              e.clientY - viewportRect.top,
            );
          }}
        />
      ) : Object.keys(components).length === 0 && viewsEnvelope.views.length === 0 ? (
        <EmptyCanvas onOpenPalette={() => setPaletteOpen(true)} />
      ) : (
        <section style={styles.detailViewport} aria-hidden="true" />
      )}

      {/* Floating toolbar */}
      {!isFullscreen && (
        <Toolbar
          position={toolbarPosition}
          flyoutOpen={flyoutOpen}
          current={currentItem}
          viewports={viewportSelection}
          onToggleViewport={toggleViewport}
          inspect={inspect}
          onInspectToggle={() => setInspect((v) => !v)}
          zoom={detailZoom}
          onZoomIn={() => setDetailZoom((z) => clamp(z + ZOOM_BUTTON_STEP, ZOOM_MIN, ZOOM_MAX))}
          onZoomOut={() => setDetailZoom((z) => clamp(z - ZOOM_BUTTON_STEP, ZOOM_MIN, ZOOM_MAX))}
          onZoomFit={() => setFitTick((t) => t + 1)}
          onZoomReset={() => {
            setDetailZoom(1);
            setDetailPan({ x: 32, y: 32 });
          }}
          iframeTheme={iframeTheme}
          onIframeTheme={setIframeTheme}
          chromeTheme={chromeTheme}
          onChromeTheme={setChromeTheme}
          bgMode={bgMode}
          onBgMode={setBgMode}
          hasFocus={!!focus}
          propsFlyoutOpen={propsFlyoutOpen}
          onTogglePropsFlyout={() => setPropsFlyoutOpen((v) => !v)}
          onOpenPalette={() => setPaletteOpen(true)}
          onHelp={() => setHelpOpen(true)}
          onCopyLink={() => {
            try {
              navigator.clipboard.writeText(window.location.href);
              setLinkCopied(true);
              window.setTimeout(() => setLinkCopied(false), 1500);
            } catch {
              /* ignore */
            }
          }}
          linkCopied={linkCopied}
          saveStatus={saveStatus}
        />
      )}

      {/* Flyout inspector */}
      {!isFullscreen && (
        <InspectorFlyout
          open={flyoutOpen}
          onToggle={() => setFlyoutOpen((v) => !v)}
          chromeTheme={chromeTheme}
          componentPath={focus}
          entry={focusedEntry}
          isScreen={focus ? screenPathSet.has(focus) : false}
          routePath={focus ? routePathByScreen.get(focus) : undefined}
          usedComponents={focus ? (screensEnvelope.componentUsage?.[focus] ?? []) : []}
          navigation={screensEnvelope.navigation}
          allComponents={components}
          inspect={inspect}
          selection={inspectorSelection}
          distance={inspectorDistance}
          hover={inspectorHover}
          onJumpTo={(path) => setFocus(path)}
          onCopyText={(text) => {
            try {
              navigator.clipboard.writeText(text);
            } catch {
              /* ignore */
            }
          }}
          onClearSelection={() => {
            broadcastToFrames({ type: 'validity:inspect:clear-selection' });
            setInspectorSelection(null);
          }}
          onSaveFixture={(state) => {
            void saveFixtureFlow(state, setSaveStatus, refreshConfig);
          }}
        />
      )}

      {/* Props flyout (left side) — live prop overrides for the focus */}
      {!isFullscreen && focus && (
        <PropsFlyout
          open={propsFlyoutOpen}
          onToggle={() => setPropsFlyoutOpen((v) => !v)}
          componentPath={focus}
          extracted={extractedPropsByComponent[focus]}
          overrides={propOverridesByComponent[focus] ?? {}}
          onSetOverride={(name, value) => {
            setPropOverridesByComponent((prev) => {
              const current = prev[focus] ?? {};
              const next = { ...current, [name]: value };
              persistPropOverrides(focus, next);
              return { ...prev, [focus]: next };
            });
          }}
          onClearOverride={(name) => {
            setPropOverridesByComponent((prev) => {
              const current = prev[focus] ?? {};
              if (!(name in current)) return prev;
              const next = { ...current };
              delete next[name];
              if (Object.keys(next).length === 0) {
                persistPropOverrides(focus, null);
                const out = { ...prev };
                delete out[focus];
                return out;
              }
              persistPropOverrides(focus, next);
              return { ...prev, [focus]: next };
            });
          }}
          onResetAll={() => {
            setPropOverridesByComponent((prev) => {
              if (!prev[focus]) return prev;
              const next = { ...prev };
              delete next[focus];
              return next;
            });
            persistPropOverrides(focus, null);
          }}
        />
      )}

      {/* Command palette */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
        currentPath={focus}
        onPick={(item) => {
          setFocus(item.path);
          setPaletteOpen(false);
        }}
      />

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

/* ====================================================================== *
 *                              <Toolbar />                                *
 * ====================================================================== */

interface ToolbarProps {
  position: ToolbarPosition;
  flyoutOpen: boolean;
  current?: PaletteItem;
  viewports: Set<string>;
  onToggleViewport: (key: string) => void;
  inspect: boolean;
  onInspectToggle: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  onZoomReset: () => void;
  iframeTheme: 'light' | 'dark' | 'system';
  onIframeTheme: (t: 'light' | 'dark' | 'system') => void;
  chromeTheme: 'light' | 'dark';
  onChromeTheme: (t: 'light' | 'dark') => void;
  bgMode: 'checker' | 'grid' | 'light' | 'dark';
  onBgMode: (m: 'checker' | 'grid' | 'light' | 'dark') => void;
  /** Whether a component is focused — Props button is disabled when not. */
  hasFocus: boolean;
  propsFlyoutOpen: boolean;
  onTogglePropsFlyout: () => void;
  onOpenPalette: () => void;
  onHelp: () => void;
  onCopyLink: () => void;
  linkCopied: boolean;
  saveStatus: string | null;
}

function Toolbar(props: ToolbarProps): React.ReactElement {
  const {
    position,
    current,
    viewports,
    onToggleViewport,
    inspect,
    onInspectToggle,
    zoom,
    onZoomIn,
    onZoomOut,
    onZoomFit,
    onZoomReset,
    iframeTheme,
    onIframeTheme,
    chromeTheme,
    onChromeTheme,
    bgMode,
    onBgMode,
    hasFocus,
    propsFlyoutOpen,
    onTogglePropsFlyout,
    onOpenPalette,
    onHelp,
    onCopyLink,
    linkCopied,
    saveStatus,
  } = props;

  const positionStyles: React.CSSProperties = {
    'top-center': { top: 18, left: '50%', transform: 'translateX(-50%)' },
    'bottom-center': { bottom: 22, left: '50%', transform: 'translateX(-50%)' },
    'top-left': { top: 18, left: 18 },
  }[position];

  return (
    <div
      role="toolbar"
      aria-label="Validity browse toolbar"
      style={{
        ...styles.toolbar,
        ...positionStyles,
      }}
    >
      {/* Identity chip / palette trigger */}
      <button
        type="button"
        onClick={onOpenPalette}
        style={{
          ...styles.btn,
          height: 30,
          paddingLeft: 6,
          paddingRight: 8,
          gap: 8,
          background: 'rgba(255,255,255,0.04)',
          maxWidth: 280,
        }}
        title="Find component (⌘P / Ctrl+P)"
      >
        <span style={styles.brandV}>V</span>
        {current ? (
          <span style={styles.toolbarIdentInner}>
            <KindGlyph kind={current.kind} />
            <span style={styles.toolbarIdentName}>{current.name}</span>
          </span>
        ) : (
          <span style={{ opacity: 0.85 }}>Find a component</span>
        )}
        <span style={{ display: 'flex', gap: 2, marginLeft: 'auto', flex: '0 0 auto' }}>
          <Kbd>⌘</Kbd>
          <Kbd>P</Kbd>
        </span>
      </button>

      <Divider />

      {/* Viewport */}
      <SegGroup ariaLabel="Viewport">
        {(['desktop', 'tablet', 'mobile'] as const).map((k) => (
          <Seg
            key={k}
            active={viewports.has(k)}
            onClick={() => onToggleViewport(k)}
            title={`${BUILTIN_VIEWPORTS[k].label} (${BUILTIN_VIEWPORTS[k].shortLabel})`}
            ariaLabel={`Show ${BUILTIN_VIEWPORTS[k].label} viewport`}
          >
            {BUILTIN_VIEWPORTS[k].shortLabel}
          </Seg>
        ))}
      </SegGroup>

      <Divider />

      {/* Design mode pill — visually obvious ON/OFF state */}
      <button
        type="button"
        onClick={onInspectToggle}
        style={{
          ...styles.btn,
          height: 30,
          paddingLeft: 10,
          paddingRight: 10,
          gap: 7,
          background: inspect
            ? 'linear-gradient(180deg, #2f5fd9, #2354c7)'
            : 'rgba(255,255,255,0.04)',
          color: inspect ? '#fff' : 'rgba(230,235,245,0.85)',
          boxShadow: inspect
            ? '0 1px 0 rgba(255,255,255,0.18) inset, 0 2px 6px rgba(35,84,199,0.4)'
            : 'none',
        }}
        title={
          inspect
            ? 'Design mode ON — click to disable (I)'
            : 'Design mode OFF — click to enable (I)'
        }
        aria-pressed={inspect}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: 99,
            background: inspect ? '#9ec6ff' : 'rgba(255,255,255,0.25)',
            boxShadow: inspect ? '0 0 6px #9ec6ff' : 'none',
          }}
        />
        <span>Design</span>
        <Kbd dim={!inspect}>I</Kbd>
      </button>

      <Divider />

      {/* Zoom */}
      <div style={styles.zoomGroup}>
        <IconBtn onClick={onZoomOut} title="Zoom out (-)" ariaLabel="Zoom out">
          <svg width="11" height="11" viewBox="0 0 11 11">
            <path d="M2 5.5H9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </IconBtn>
        <button type="button" onClick={onZoomReset} style={styles.zoomLabel} title="Reset zoom (0)">
          {Math.round(zoom * 100)}%
        </button>
        <IconBtn onClick={onZoomIn} title="Zoom in (+)" ariaLabel="Zoom in">
          <svg width="11" height="11" viewBox="0 0 11 11">
            <path
              d="M2 5.5H9M5.5 2V9"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </IconBtn>
        <button
          type="button"
          onClick={onZoomFit}
          style={{ ...styles.miniBtn, paddingLeft: 7, paddingRight: 7 }}
          title="Fit to viewport"
        >
          Fit
        </button>
      </div>

      <Divider />

      {/* Theme */}
      <SegGroup ariaLabel="Component color scheme">
        <Seg
          active={iframeTheme === 'system'}
          onClick={() => onIframeTheme('system')}
          title="Auto theme"
        >
          <ThemeAutoIcon />
        </Seg>
        <Seg
          active={iframeTheme === 'light'}
          onClick={() => onIframeTheme('light')}
          title="Light theme"
        >
          <ThemeLightIcon />
        </Seg>
        <Seg
          active={iframeTheme === 'dark'}
          onClick={() => onIframeTheme('dark')}
          title="Dark theme"
        >
          <ThemeDarkIcon />
        </Seg>
      </SegGroup>

      <Divider />

      {/* Background */}
      <SegGroup ariaLabel="Canvas background">
        <Seg active={bgMode === 'checker'} onClick={() => onBgMode('checker')} title="Checker">
          <BgCheckerIcon />
        </Seg>
        <Seg active={bgMode === 'light'} onClick={() => onBgMode('light')} title="Light">
          <BgSwatch color="#f3f5fa" />
        </Seg>
        <Seg active={bgMode === 'dark'} onClick={() => onBgMode('dark')} title="Dark">
          <BgSwatch color="#0a0f1a" />
        </Seg>
        <Seg active={bgMode === 'grid'} onClick={() => onBgMode('grid')} title="Grid">
          <BgGridIcon />
        </Seg>
      </SegGroup>

      <Divider />

      {/*
       * Scenario picker intentionally removed from the toolbar — `propOverrides`
       * via the Props flyout (and validity__browse_navigate) is the primary
       * live-edit surface now. Scenarios remain configured in
       * `.validity/config.ts` and still apply to verify renders + the
       * `?scenario=` URL param. To bring the dropdown back, restore the
       * <ScenarioMenu /> render here and re-pass `scenarios` / `onScenario` /
       * `scenarioOpen` through Toolbar props — see docs/scenarios-ui.md.
       */}

      {/* Props flyout toggle — disabled when no component is focused */}
      <button
        type="button"
        onClick={onTogglePropsFlyout}
        disabled={!hasFocus}
        style={{
          ...styles.btn,
          height: 26,
          paddingLeft: 9,
          paddingRight: 9,
          gap: 6,
          background: propsFlyoutOpen ? 'rgba(124, 158, 255, 0.18)' : 'rgba(255,255,255,0.04)',
          color: propsFlyoutOpen ? '#cfddff' : 'rgba(230,235,245,0.85)',
          boxShadow: propsFlyoutOpen ? '0 0 0 1px rgba(124,158,255,0.25) inset' : 'none',
          opacity: hasFocus ? 1 : 0.5,
          cursor: hasFocus ? 'pointer' : 'not-allowed',
        }}
        title={
          hasFocus
            ? propsFlyoutOpen
              ? 'Hide props panel (P)'
              : 'Edit props (P)'
            : 'Select a component to edit props'
        }
        aria-pressed={propsFlyoutOpen}
        aria-label="Toggle props panel"
      >
        <span style={{ fontSize: 9.5, letterSpacing: 1.4, opacity: 0.55 }}>{'{ }'}</span>
        <span>Props</span>
        <Kbd dim={!propsFlyoutOpen}>P</Kbd>
      </button>

      <Divider />

      {/* Misc icon buttons */}
      <IconBtn onClick={onCopyLink} title="Copy shareable link" ariaLabel="Copy shareable link">
        <span style={{ fontSize: 13 }}>{linkCopied ? '✓' : '⎘'}</span>
      </IconBtn>
      <IconBtn
        onClick={() => onChromeTheme(chromeTheme === 'dark' ? 'light' : 'dark')}
        title={`Switch UI to ${chromeTheme === 'dark' ? 'light' : 'dark'}`}
        ariaLabel="Toggle chrome theme"
      >
        <span style={{ fontSize: 13 }}>{chromeTheme === 'dark' ? '☀' : '☾'}</span>
      </IconBtn>
      <IconBtn onClick={onHelp} title="Keyboard shortcuts (?)" ariaLabel="Keyboard shortcuts">
        <span style={{ fontSize: 13 }}>?</span>
      </IconBtn>

      {saveStatus && (
        <>
          <Divider />
          <span
            style={{
              fontSize: 11,
              padding: '0 6px',
              color: saveStatus.startsWith('!') ? '#fda4a4' : '#9be3a8',
            }}
          >
            {saveStatus.replace(/^!/, '')}
          </span>
        </>
      )}
    </div>
  );
}

/* ----- Toolbar primitives ----------------------------------------- */

function SegGroup(props: { children: React.ReactNode; ariaLabel: string }): React.ReactElement {
  return (
    <div role="group" aria-label={props.ariaLabel} style={styles.segGroup}>
      {props.children}
    </div>
  );
}

function Seg(props: {
  active?: boolean;
  onClick: () => void;
  title?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      aria-label={props.ariaLabel ?? props.title}
      aria-pressed={!!props.active}
      style={{
        ...styles.btn,
        height: 22,
        minWidth: 24,
        padding: '0 7px',
        background: props.active ? 'rgba(124, 158, 255, 0.18)' : 'transparent',
        color: props.active ? '#cfddff' : 'rgba(230,235,245,0.7)',
        boxShadow: props.active ? '0 0 0 1px rgba(124,158,255,0.25) inset' : 'none',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3,
      }}
    >
      {props.children}
    </button>
  );
}

function IconBtn(props: {
  onClick: () => void;
  title?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      aria-label={props.ariaLabel ?? props.title}
      style={{
        ...styles.btn,
        height: 24,
        width: 24,
        padding: 0,
        color: 'rgba(230,235,245,0.75)',
      }}
    >
      {props.children}
    </button>
  );
}

function Divider(): React.ReactElement {
  return <div style={styles.divider} aria-hidden="true" />;
}

function Kbd(props: { children: React.ReactNode; dim?: boolean }): React.ReactElement {
  return (
    <kbd
      style={{
        ...styles.kbd,
        color: props.dim ? 'rgba(230,235,245,0.6)' : 'rgba(230,235,245,0.85)',
      }}
    >
      {props.children}
    </kbd>
  );
}

/* ----- Glyphs ----------------------------------------------------- */

function KindGlyph(props: { kind: PaletteItem['kind']; active?: boolean }): React.ReactElement {
  const color = props.active ? '#9ec6ff' : 'rgba(230,235,245,0.55)';
  if (props.kind === 'view') {
    // Three stacked horizontal bars — evokes "a composition of pieces".
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <rect
          x="2"
          y="3"
          width="12"
          height="2.5"
          rx="1"
          fill="none"
          stroke={color}
          strokeWidth="1.2"
        />
        <rect
          x="2"
          y="6.75"
          width="12"
          height="2.5"
          rx="1"
          fill="none"
          stroke={color}
          strokeWidth="1.2"
        />
        <rect
          x="2"
          y="10.5"
          width="12"
          height="2.5"
          rx="1"
          fill="none"
          stroke={color}
          strokeWidth="1.2"
        />
      </svg>
    );
  }
  if (props.kind === 'primitive') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <rect
          x="3"
          y="3"
          width="10"
          height="10"
          rx="2"
          fill="none"
          stroke={color}
          strokeWidth="1.4"
        />
      </svg>
    );
  }
  if (props.kind === 'component') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M8 2L14 8L8 14L2 8Z"
          fill="none"
          stroke={color}
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect
        x="2"
        y="3"
        width="12"
        height="9"
        rx="1.5"
        fill="none"
        stroke={color}
        strokeWidth="1.4"
      />
      <path d="M2 6H14" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}

function ThemeAutoIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11">
      <circle cx="5.5" cy="5.5" r="3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      <path d="M5.5 2A3.5 3.5 0 0 1 5.5 9" fill="currentColor" />
    </svg>
  );
}
function ThemeLightIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11">
      <circle cx="5.5" cy="5.5" r="2.2" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
        <path d="M5.5 1V2" />
        <path d="M5.5 9V10" />
        <path d="M1 5.5H2" />
        <path d="M9 5.5H10" />
      </g>
    </svg>
  );
}
function ThemeDarkIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11">
      <path d="M8.5 6.4A3.5 3.5 0 1 1 4.6 2.5 3 3 0 0 0 8.5 6.4Z" fill="currentColor" />
    </svg>
  );
}
function BgCheckerIcon(): React.ReactElement {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11">
      <rect width="11" height="11" fill="rgba(255,255,255,0.08)" />
      <rect x="0" y="0" width="5.5" height="5.5" fill="currentColor" opacity="0.5" />
      <rect x="5.5" y="5.5" width="5.5" height="5.5" fill="currentColor" opacity="0.5" />
    </svg>
  );
}
function BgGridIcon(): React.ReactElement {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 11 11"
      fill="none"
      stroke="currentColor"
      strokeWidth="0.8"
    >
      <path d="M0 3.7H11M0 7.3H11M3.7 0V11M7.3 0V11" />
    </svg>
  );
}
function BgSwatch(props: { color: string }): React.ReactElement {
  return (
    <div
      style={{
        width: 11,
        height: 11,
        borderRadius: 2,
        background: props.color,
        boxShadow: '0 0 0 1px rgba(255,255,255,0.15) inset',
      }}
      aria-hidden="true"
    />
  );
}

/* ====================================================================== *
 *                          <ScenarioMenu />                                *
 * ====================================================================== */

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately-preserved dead code; <ScenariosSection/> (its only caller) is kept for revival, see docs/scenarios-ui.md
function ScenarioMenu(props: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  value: string;
  scenarios: string[];
  onChange: (v: string) => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!props.open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [props.open, props]);

  const empty = props.scenarios.length === 0;
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={props.onOpen}
        disabled={empty}
        style={{
          ...styles.btn,
          height: 26,
          paddingLeft: 10,
          paddingRight: 8,
          gap: 8,
          background: 'rgba(255,255,255,0.04)',
          opacity: empty ? 0.5 : 1,
          cursor: empty ? 'not-allowed' : 'pointer',
        }}
        title={empty ? 'No scenarios apply to this component' : 'Scenario'}
        aria-haspopup="menu"
        aria-expanded={props.open}
      >
        <span style={{ fontSize: 9.5, letterSpacing: 1.4, opacity: 0.55 }}>SCN</span>
        <span style={{ opacity: 0.9 }}>{props.value || '— base —'}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.55 }}>
          <path
            d="M2 4L5 7L8 4"
            stroke="currentColor"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {props.open && (
        <div role="menu" style={styles.scenarioMenu}>
          <button
            type="button"
            onClick={() => props.onChange('')}
            style={{
              ...styles.scenarioOption,
              ...(props.value === '' ? styles.scenarioOptionActive : null),
            }}
            role="menuitemradio"
            aria-checked={props.value === ''}
          >
            — base —
          </button>
          {props.scenarios.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => props.onChange(s)}
              style={{
                ...styles.scenarioOption,
                ...(props.value === s ? styles.scenarioOptionActive : null),
              }}
              role="menuitemradio"
              aria-checked={props.value === s}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ====================================================================== *
 *                          <CommandPalette />                              *
 * ====================================================================== */

function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
  currentPath: string | null;
  onPick: (item: PaletteItem) => void;
}): React.ReactElement | null {
  const { open, onClose, items, currentPath, onPick } = props;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => fuzzyRank(query, items).slice(0, 80), [query, items]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector('[data-active="true"]') as HTMLElement | null;
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[active];
      if (pick) onPick(pick);
    }
  };

  return (
    <div
      onClick={onClose}
      style={styles.paletteScrim}
      role="dialog"
      aria-modal="true"
      aria-label="Find a component or screen"
    >
      <div onClick={(e) => e.stopPropagation()} style={styles.paletteModal}>
        <div style={styles.paletteSearchRow}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.55 }}>
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M14 14L11 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder="Find a component or screen…"
            style={styles.paletteInput}
            aria-label="Search components and screens"
          />
          <kbd style={styles.kbd}>esc</kbd>
        </div>

        <div ref={listRef} style={styles.paletteList}>
          {results.length === 0 && (
            <div style={styles.paletteEmpty}>
              No matches for <code style={{ color: 'rgba(230,235,245,0.7)' }}>{query}</code>
            </div>
          )}
          {results.map((it, i) => {
            const isActive = i === active;
            const isCurrent = currentPath === it.path;
            return (
              <div
                key={it.path}
                data-active={isActive}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(it);
                }}
                style={{
                  ...styles.paletteRow,
                  background: isActive ? 'rgba(124, 158, 255, 0.12)' : 'transparent',
                }}
                role="option"
                aria-selected={isActive}
              >
                <KindGlyph kind={it.kind} active={isActive} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={styles.paletteRowMain}>
                    <span style={styles.paletteRowName}>
                      <HighlightMatch text={it.name} query={query} />
                    </span>
                    {isCurrent && <span style={styles.paletteOpenBadge}>OPEN</span>}
                    {it.routePath && <span style={styles.paletteRoute}>{it.routePath}</span>}
                  </div>
                  <div style={styles.paletteRowPath}>{it.path}</div>
                </div>
                <span style={styles.paletteKind}>{it.kind}</span>
                {isActive && (
                  <span style={{ color: 'rgba(230,235,245,0.55)', fontSize: 12 }}>↵</span>
                )}
              </div>
            );
          })}
        </div>

        <div style={styles.paletteFooter}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <span>
              <kbd style={styles.kbd}>↑</kbd>
              <kbd style={{ ...styles.kbd, marginLeft: 4 }}>↓</kbd> navigate
            </span>
            <span>
              <kbd style={styles.kbd}>↵</kbd> open
            </span>
          </div>
          <div>
            {results.length} {results.length === 1 ? 'match' : 'matches'} · {items.length} indexed
          </div>
        </div>
      </div>
    </div>
  );
}

/* ====================================================================== *
 *                          <InspectorFlyout />                             *
 * ====================================================================== */

interface InspectorFlyoutProps {
  open: boolean;
  onToggle: () => void;
  chromeTheme: 'light' | 'dark';
  componentPath: string | null;
  entry: ComponentEntry | undefined;
  isScreen: boolean;
  routePath?: string;
  usedComponents: string[];
  navigation: NavigationEdgeLite[];
  allComponents: Record<string, ComponentEntry>;
  inspect: boolean;
  selection: InspectorPayload | null;
  distance: DistancePayload | null;
  hover: InspectorPayload | null;
  onJumpTo: (path: string) => void;
  onCopyText: (text: string) => void;
  onClearSelection: () => void;
  onSaveFixture: (state: { id: string; props: Record<string, unknown> }) => void;
}

function InspectorFlyout(props: InspectorFlyoutProps): React.ReactElement {
  const {
    open,
    onToggle,
    componentPath,
    entry,
    isScreen,
    routePath,
    usedComponents,
    navigation,
    allComponents,
    inspect,
    selection,
    distance,
    onJumpTo,
    onCopyText,
    onClearSelection,
    onSaveFixture,
  } = props;

  return (
    <>
      {/* Collapsed rail toggle — always visible, sits on the right edge */}
      <button
        type="button"
        onClick={onToggle}
        style={{
          ...styles.flyoutRail,
          right: open ? 320 : 0,
        }}
        title={open ? 'Collapse inspector (\\)' : 'Expand inspector (\\)'}
        aria-label={open ? 'Collapse inspector' : 'Expand inspector'}
        aria-expanded={open}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 12 12"
          style={{
            transform: open ? 'rotate(0deg)' : 'rotate(180deg)',
            transition: 'transform 200ms',
          }}
        >
          <path
            d="M3 2L7 6L3 10"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <aside
        style={{
          ...styles.flyoutPanel,
          transform: open ? 'translateX(0)' : 'translateX(100%)',
        }}
        aria-label="Inspector"
        aria-hidden={!open}
      >
        <div style={styles.flyoutHeader}>
          <span style={styles.flyoutEyebrow}>
            {selection ? 'ELEMENT' : componentPath ? 'COMPONENT' : 'INSPECTOR'}
          </span>
          <button
            type="button"
            onClick={onToggle}
            style={{
              ...styles.btn,
              height: 24,
              width: 24,
              padding: 0,
              color: 'rgba(230,235,245,0.55)',
            }}
            title="Collapse (\\)"
            aria-label="Collapse inspector"
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path
                d="M3 2L7 6L3 10"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div style={styles.flyoutBody}>
          {selection && (
            <PinnedElementPanel
              selection={selection}
              distance={distance}
              allComponents={allComponents}
              onJumpTo={onJumpTo}
              onClear={onClearSelection}
              onCopyText={onCopyText}
            />
          )}

          {componentPath && entry && (
            <div style={{ opacity: selection ? 0.7 : 1, transition: 'opacity 200ms' }}>
              <ComponentSummary
                componentPath={componentPath}
                isScreen={isScreen}
                routePath={routePath}
                inspect={inspect}
              />
              <FixturesSection entry={entry} onSaveFixture={onSaveFixture} />
              {/*
               * <ScenariosSection /> render intentionally removed — scenarios
               * are no longer surfaced in the browse UI. The component
               * definition is preserved for easy revival; see
               * docs/scenarios-ui.md.
               */}
              <UsedInSection
                isScreen={isScreen}
                usedComponents={usedComponents}
                onJumpTo={onJumpTo}
              />
              <FlowsSection
                isScreen={isScreen}
                componentPath={componentPath}
                navigation={navigation}
                onJumpTo={onJumpTo}
              />
            </div>
          )}

          {!componentPath && (
            <div style={styles.flyoutEmpty}>
              <p style={{ margin: 0, lineHeight: 1.5 }}>
                Press <Kbd>⌘</Kbd>
                <Kbd>P</Kbd> to find a component.
              </p>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

/* ====================================================================== *
 *                              <PropsFlyout />                             *
 * ====================================================================== */

interface PropsFlyoutProps {
  open: boolean;
  onToggle: () => void;
  componentPath: string;
  /** `undefined` = not yet requested, `null` = request in flight, else the
   * extracted prop metadata for this component (possibly with empty props). */
  extracted: ExtractedPropsResponse | null | undefined;
  /** Current override map for this component (may be empty). */
  overrides: Record<string, unknown>;
  onSetOverride: (name: string, value: unknown) => void;
  onClearOverride: (name: string) => void;
  /** Clear every override for this component (Reset to defaults). */
  onResetAll: () => void;
}

function PropsFlyout(props: PropsFlyoutProps): React.ReactElement {
  const {
    open,
    onToggle,
    componentPath,
    extracted,
    overrides,
    onSetOverride,
    onClearOverride,
    onResetAll,
  } = props;

  const hasOverrides = Object.keys(overrides).length > 0;
  const loading = extracted === null || extracted === undefined;
  const propList = extracted?.props ?? [];

  return (
    <>
      {/* Collapsed rail toggle — mirror of the right-side flyoutRail */}
      <button
        type="button"
        onClick={onToggle}
        style={{
          ...styles.propsFlyoutRail,
          left: open ? 320 : 0,
        }}
        title={open ? 'Collapse props panel (P)' : 'Expand props panel (P)'}
        aria-label={open ? 'Collapse props panel' : 'Expand props panel'}
        aria-expanded={open}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 12 12"
          style={{
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms',
          }}
        >
          <path
            d="M3 2L7 6L3 10"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <aside
        style={{
          ...styles.propsFlyoutPanel,
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
        }}
        aria-label="Props"
        aria-hidden={!open}
      >
        <div style={styles.flyoutHeader}>
          <span style={styles.flyoutEyebrow}>PROPS</span>
          <button
            type="button"
            onClick={onToggle}
            style={{
              ...styles.btn,
              height: 24,
              width: 24,
              padding: 0,
              color: 'rgba(230,235,245,0.55)',
            }}
            title="Close (P)"
            aria-label="Close props panel"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path
                d="M2 2L8 8M8 2L2 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div style={styles.flyoutBody}>
          {/* Sub-header: focused component path + AUTO badge when no
              overrides are set (i.e. we're rendering auto-mocked defaults). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 11,
                color: 'rgba(230,235,245,0.55)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                flex: 1,
                minWidth: 0,
              }}
              title={componentPath}
            >
              {componentPath}
            </span>
            {!hasOverrides && (
              <span
                style={styles.autoBadge}
                title="No overrides — rendering with auto-mocked props"
              >
                AUTO
              </span>
            )}
          </div>

          {loading ? (
            <div style={styles.flyoutEmpty}>Loading props…</div>
          ) : propList.length === 0 ? (
            <div style={styles.flyoutEmpty}>
              <p style={{ margin: 0, lineHeight: 1.5 }}>
                No props detected. Validity couldn't infer a prop type from{' '}
                <span style={{ fontFamily: MONO }}>{basename(componentPath)}</span>.
              </p>
            </div>
          ) : (
            <div>
              {propList.map((prop) => (
                <PropFieldRow
                  key={prop.name}
                  prop={prop}
                  hasOverride={prop.name in overrides}
                  currentValue={overrides[prop.name]}
                  onSet={(v) => onSetOverride(prop.name, v)}
                  onClear={() => onClearOverride(prop.name)}
                />
              ))}
            </div>
          )}
        </div>

        <div style={styles.propsFlyoutFooter}>
          <span style={{ fontSize: 11, color: 'rgba(230,235,245,0.45)' }}>
            {hasOverrides
              ? `${Object.keys(overrides).length} override${Object.keys(overrides).length === 1 ? '' : 's'}`
              : 'No overrides'}
          </span>
          <button
            type="button"
            onClick={onResetAll}
            disabled={!hasOverrides}
            style={{
              ...styles.secondaryButtonInline,
              opacity: hasOverrides ? 1 : 0.5,
              cursor: hasOverrides ? 'pointer' : 'not-allowed',
            }}
            title="Clear every override for this component"
          >
            Reset to defaults
          </button>
        </div>
      </aside>
    </>
  );
}

/* ----- Per-prop input row ---------------------------------------- */

/**
 * Parse a TS type string into a primitive-input descriptor. We only
 * understand a deliberately small set — string-literal unions, boolean,
 * number, string — everything else falls back to a read-only "complex
 * type" hint. The user's escape hatch for complex types is authoring a
 * fixture in .validity/config.ts (already documented to them).
 *
 * Special-case: `children` is conventionally typed as `React.ReactNode`
 * even when the realistic value is just a text label ("Click me"), so
 * treating it as opaque means buttons / chips / badges render invisible.
 * We map `React.ReactNode` (and `ReactNode`) and any union that includes
 * `string` to a string input — JSX-valued children remain a fixture job.
 */
function describePropField(typeText: string): {
  kind: 'string' | 'number' | 'boolean' | 'select' | 'complex';
  options?: string[];
} {
  // Strip `| undefined` and `| null` so optional primitives collapse to
  // their underlying kind without falling into the "complex union" bucket.
  const cleaned = typeText
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s !== 'undefined' && s !== 'null')
    .join(' | ');

  if (cleaned === 'string') return { kind: 'string' };
  if (cleaned === 'number') return { kind: 'number' };
  if (
    cleaned === 'boolean' ||
    cleaned === 'true' ||
    cleaned === 'false' ||
    cleaned === 'true | false'
  )
    return { kind: 'boolean' };

  // React.ReactNode / ReactNode — author-facing string is the overwhelmingly
  // common case (button labels, headings, etc.). JSX children stay a fixture
  // concern but at least the typical button isn't invisible by default.
  if (cleaned === 'React.ReactNode' || cleaned === 'ReactNode') {
    return { kind: 'string' };
  }

  // String-literal union: every alternative is a quoted string. Single
  // literals (`'a'`) also land here — useful for the rare case of a single
  // permitted value.
  const alts = cleaned.split('|').map((s) => s.trim());
  if (alts.length >= 1 && alts.every((s) => /^(['"]).*\1$/.test(s))) {
    const opts = alts.map((s) => s.slice(1, -1));
    return { kind: 'select', options: opts };
  }

  // Union containing `string` (e.g. `string | ReactElement`) — accept a
  // string value; the other arms need a fixture to express.
  if (alts.includes('string')) return { kind: 'string' };
  return { kind: 'complex' };
}

function PropFieldRow(props: {
  prop: ExtractedPropInfo;
  hasOverride: boolean;
  currentValue: unknown;
  onSet: (value: unknown) => void;
  onClear: () => void;
}): React.ReactElement {
  const { prop, hasOverride, currentValue, onSet, onClear } = props;
  const desc = describePropField(prop.type);

  return (
    <div style={styles.propsFieldRow}>
      <div style={styles.propsFieldHeader}>
        <span style={styles.propsFieldName} title={prop.name}>
          {prop.name}
          {prop.optional && (
            <span style={{ color: 'rgba(230,235,245,0.4)', marginLeft: 3 }}>?</span>
          )}
        </span>
        <span style={styles.propsFieldType} title={prop.type}>
          {prop.type}
        </span>
        <button
          type="button"
          onClick={onClear}
          disabled={!hasOverride}
          style={{
            ...styles.propsFieldResetBtn,
            opacity: hasOverride ? 1 : 0.25,
            cursor: hasOverride ? 'pointer' : 'default',
          }}
          title={hasOverride ? 'Clear this override (revert to auto-mock)' : 'No override set'}
          aria-label={`Reset ${prop.name}`}
        >
          ↺
        </button>
      </div>

      {desc.kind === 'select' && (
        <select
          value={hasOverride ? String(currentValue ?? '') : ''}
          onChange={(e) => onSet(e.target.value)}
          style={styles.propsFieldInput}
        >
          {!hasOverride && <option value="">— auto —</option>}
          {desc.options!.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}

      {desc.kind === 'boolean' && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: 'rgba(230,235,245,0.85)',
            cursor: 'pointer',
            padding: '2px 0',
          }}
        >
          <input
            type="checkbox"
            checked={hasOverride ? Boolean(currentValue) : false}
            onChange={(e) => onSet(e.target.checked)}
            style={{ accentColor: '#7c9eff' }}
          />
          <span>{hasOverride ? String(Boolean(currentValue)) : 'auto'}</span>
        </label>
      )}

      {desc.kind === 'number' && (
        <input
          type="number"
          value={
            hasOverride && (typeof currentValue === 'number' || typeof currentValue === 'string')
              ? String(currentValue)
              : ''
          }
          placeholder="auto"
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              onClear();
              return;
            }
            const n = Number(raw);
            onSet(Number.isFinite(n) ? n : raw);
          }}
          style={styles.propsFieldInput}
        />
      )}

      {desc.kind === 'string' && (
        <input
          type="text"
          value={hasOverride && typeof currentValue === 'string' ? currentValue : ''}
          placeholder="auto"
          onChange={(e) => {
            const v = e.target.value;
            // Empty string is a valid override (`""`), but we treat a
            // freshly-cleared input as "revert to auto" — matches the
            // behavior the user gets from clicking the ↺ button. To
            // explicitly set "" they can type a single space and then
            // delete it after the override has been recorded, or use
            // a fixture.
            if (v === '') onClear();
            else onSet(v);
          }}
          style={styles.propsFieldInput}
        />
      )}

      {desc.kind === 'complex' && (
        <div style={styles.propsFieldComplex}>
          complex type — author a fixture in{' '}
          <span style={{ fontFamily: MONO }}>.validity/config.ts</span>
        </div>
      )}
    </div>
  );
}

/* ----- Pinned element details (the DevTools view) ---------------- */

function PinnedElementPanel(props: {
  selection: InspectorPayload;
  distance: DistancePayload | null;
  allComponents: Record<string, ComponentEntry>;
  onJumpTo: (path: string) => void;
  onClear: () => void;
  onCopyText: (text: string) => void;
}): React.ReactElement {
  const { selection, distance, allComponents, onJumpTo, onClear, onCopyText } = props;
  const jumpPath = selection.componentPath
    ? findKnownComponentPath(selection.componentPath, allComponents)
    : null;
  const jumpName = jumpPath ? (selection.componentName ?? basename(jumpPath)) : null;

  const cssText = selection.computedSnapshot.map((kv) => `${kv.property}: ${kv.value};`).join('\n');

  return (
    <section style={{ marginBottom: 22 }}>
      {/* Selector header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
        <div style={styles.elemGlyph}>{'</>'}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.elemSelector}>
            <span style={{ color: '#9ec6ff' }}>{selection.tagName}</span>
            {selection.id ? <span style={{ color: '#cfddff' }}>#{selection.id}</span> : null}
            {selection.classList.slice(0, 4).map((c, i) => (
              <span key={i} style={{ color: 'rgba(230,235,245,0.55)' }}>
                .{c}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={onClear}
          title="Clear selection (Esc)"
          aria-label="Clear selection"
          style={{
            ...styles.btn,
            height: 22,
            width: 22,
            padding: 0,
            background: 'rgba(255,255,255,0.04)',
            color: 'rgba(230,235,245,0.55)',
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M2 2L8 8M8 2L2 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {jumpPath && (
        <button
          type="button"
          onClick={() => onJumpTo(jumpPath)}
          style={styles.jumpButton}
          title={`Open ${jumpName} in the canvas`}
        >
          ↗ Jump to {jumpName}
        </button>
      )}

      {/* Box stats */}
      <div style={{ display: 'flex', gap: 6, marginTop: 14, marginBottom: 14 }}>
        <BoxStat label="W" value={Math.round(selection.rect.width)} />
        <BoxStat label="H" value={Math.round(selection.rect.height)} />
        <BoxStat label="X" value={Math.round(selection.rect.x)} dim />
        <BoxStat label="Y" value={Math.round(selection.rect.y)} dim />
      </div>

      {/* Box model */}
      <BoxModel
        margin={selection.margin}
        border={selection.border}
        padding={selection.padding}
        width={Math.round(selection.rect.width)}
        height={Math.round(selection.rect.height)}
      />

      {/* Style grid */}
      <div style={styles.styleGrid}>
        <StyleRow k="color" v={selection.font.color} swatch={selection.font.color} />
        <StyleRow
          k="background"
          v={selection.background}
          swatch={
            selection.background !== 'transparent' && selection.background !== 'rgba(0, 0, 0, 0)'
              ? selection.background
              : null
          }
        />
        <StyleRow k="font" v={`${selection.font.size} / ${selection.font.weight}`} />
        <StyleRow k="family" v={firstToken(selection.font.family)} />
        <StyleRow k="line" v={selection.font.lineHeight} />
        <StyleRow k="display" v={selection.display} />
        <StyleRow k="position" v={selection.position} />
        {selection.opacity !== '1' && <StyleRow k="opacity" v={selection.opacity} />}
      </div>

      {distance && (
        <div style={styles.distanceCard}>
          <strong style={{ color: '#9ec6ff', fontSize: 10, letterSpacing: 1.4 }}>DISTANCE</strong>
          <div style={{ fontSize: 12, color: '#eaf0fb' }}>
            {distance.horizontal}px × {distance.vertical}px to hovered element
          </div>
        </div>
      )}

      {/* Computed CSS (expandable) */}
      <details style={{ marginTop: 14 }}>
        <summary style={styles.detailsSummary}>
          Computed CSS ({selection.computedSnapshot.length})
        </summary>
        <pre style={styles.cssBlock}>{cssText}</pre>
        <button type="button" onClick={() => onCopyText(cssText)} style={styles.secondaryButton}>
          Copy CSS
        </button>
      </details>
    </section>
  );
}

function BoxStat(props: { label: string; value: number; dim?: boolean }): React.ReactElement {
  return (
    <div
      style={{
        flex: 1,
        padding: '7px 8px',
        background: props.dim ? 'rgba(255,255,255,0.02)' : 'rgba(124, 158, 255, 0.1)',
        border: props.dim
          ? '1px solid rgba(255,255,255,0.05)'
          : '1px solid rgba(124, 158, 255, 0.2)',
        borderRadius: 6,
        fontFamily: MONO,
      }}
    >
      <div
        style={{
          fontSize: 9,
          letterSpacing: 1.2,
          color: props.dim ? 'rgba(230,235,245,0.4)' : '#9ec6ff',
        }}
      >
        {props.label}
      </div>
      <div
        style={{
          fontSize: 13,
          color: props.dim ? 'rgba(230,235,245,0.7)' : '#eaf0fb',
          marginTop: 1,
        }}
      >
        {props.value}
      </div>
    </div>
  );
}

function StyleRow(props: { k: string; v: string; swatch?: string | null }): React.ReactElement {
  return (
    <>
      <div style={{ color: 'rgba(230,235,245,0.45)' }}>{props.k}</div>
      <div
        style={{
          color: '#eaf0fb',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          overflow: 'hidden',
        }}
      >
        {props.swatch && (
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 3,
              background: props.swatch,
              boxShadow: '0 0 0 1px rgba(255,255,255,0.15) inset',
              flex: '0 0 10px',
            }}
          />
        )}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {props.v}
        </span>
      </div>
    </>
  );
}

function BoxModel(props: {
  margin: { top: number; right: number; bottom: number; left: number };
  border: { top: number; right: number; bottom: number; left: number };
  padding: { top: number; right: number; bottom: number; left: number };
  width: number;
  height: number;
}): React.ReactElement {
  return (
    <div style={styles.boxModelWrap}>
      <div style={{ ...styles.boxModelLayer, ...styles.boxModelMargin }}>
        <span style={styles.boxModelLabel}>margin</span>
        <span style={styles.boxModelTop}>{props.margin.top}</span>
        <span style={styles.boxModelRight}>{props.margin.right}</span>
        <span style={styles.boxModelBottom}>{props.margin.bottom}</span>
        <span style={styles.boxModelLeft}>{props.margin.left}</span>
        <div style={{ ...styles.boxModelLayer, ...styles.boxModelBorder }}>
          <span style={styles.boxModelLabel}>border</span>
          <span style={styles.boxModelTop}>{props.border.top}</span>
          <span style={styles.boxModelRight}>{props.border.right}</span>
          <span style={styles.boxModelBottom}>{props.border.bottom}</span>
          <span style={styles.boxModelLeft}>{props.border.left}</span>
          <div style={{ ...styles.boxModelLayer, ...styles.boxModelPadding }}>
            <span style={styles.boxModelLabel}>padding</span>
            <span style={styles.boxModelTop}>{props.padding.top}</span>
            <span style={styles.boxModelRight}>{props.padding.right}</span>
            <span style={styles.boxModelBottom}>{props.padding.bottom}</span>
            <span style={styles.boxModelLeft}>{props.padding.left}</span>
            <div style={styles.boxModelContent}>
              {props.width} × {props.height}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----- Component summary card ------------------------------------ */

function ComponentSummary(props: {
  componentPath: string;
  isScreen: boolean;
  routePath?: string;
  inspect: boolean;
}): React.ReactElement {
  return (
    <section style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <KindGlyph kind={props.isScreen ? 'screen' : 'component'} />
        <div style={{ fontSize: 15, fontWeight: 600 }}>{basename(props.componentPath)}</div>
      </div>
      <div
        style={{ fontFamily: MONO, fontSize: 11, color: 'rgba(230,235,245,0.45)', marginBottom: 8 }}
      >
        {props.componentPath}
      </div>
      {props.isScreen && props.routePath && <div style={styles.routePill}>{props.routePath}</div>}
      {props.inspect && (
        <div style={styles.designModeHint}>
          <strong style={{ color: '#cfddff' }}>Design mode on</strong> — hover for read-out, click
          an element to pin. <Kbd>I</Kbd> toggles.
        </div>
      )}
    </section>
  );
}

/* ----- Fixtures section ------------------------------------------ */

function FixturesSection(props: {
  entry: ComponentEntry;
  onSaveFixture: (s: { id: string; props: Record<string, unknown> }) => void;
}): React.ReactElement {
  const entries = props.entry.fixtures ? Object.entries(props.entry.fixtures) : [];
  return (
    <Section title="Fixtures">
      {entries.length === 0 ? (
        <Empty>
          No fixtures defined. {props.entry.props ? 'Rendering with default props.' : ''}
        </Empty>
      ) : (
        entries.map(([id, fx]) => (
          <details key={id} style={styles.fixtureRow}>
            <summary style={styles.fixtureSummary}>
              <span style={{ width: 6, height: 6, borderRadius: 99, background: '#9ec6ff' }} />
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: '#eaf0fb' }}>{id}</span>
              {fx.inferred && <span style={styles.autoBadge}>AUTO</span>}
              {fx.description && (
                <span
                  style={{
                    fontSize: 11,
                    color: 'rgba(230,235,245,0.5)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fx.description}
                </span>
              )}
            </summary>
            <pre style={styles.fixtureJson}>{JSON.stringify(fx.props ?? {}, null, 2)}</pre>
            {fx.inferred && (
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() => props.onSaveFixture({ id, props: fx.props ?? {} })}
              >
                Save as fixture…
              </button>
            )}
          </details>
        ))
      )}
    </Section>
  );
}

/* ----- Scenarios section — pick + manage per-component allow-list  */

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- render intentionally removed, definition preserved for revival, see docs/scenarios-ui.md
function ScenariosSection(props: {
  componentPath: string;
  entry: ComponentEntry;
  allScenarios: string[];
  applicableScenarios: string[];
  activeScenario: string;
  onSelectScenario: (id: string) => void;
  onSaveAllowList: (next: string[]) => void;
}): React.ReactElement {
  const allowSet = useMemo(() => new Set(props.applicableScenarios), [props.applicableScenarios]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(allowSet);

  // Reset draft whenever the component or the allow-list changes.
  useEffect(() => {
    setDraft(new Set(props.applicableScenarios));
  }, [props.componentPath, props.applicableScenarios]);

  const allEmpty = props.allScenarios.length === 0;

  if (allEmpty) {
    return (
      <Section title="Scenarios">
        <Empty>
          No scenarios defined. Add one under <code style={styles.inlineCode}>scenarios</code> in{' '}
          <code style={styles.inlineCode}>.validity/config.ts</code>.
        </Empty>
      </Section>
    );
  }

  if (editing) {
    return (
      <Section
        title="Scenarios for this component"
        action={
          <span style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              style={styles.secondaryButtonInline}
              onClick={() => {
                setEditing(false);
                setDraft(new Set(props.applicableScenarios));
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              style={styles.primaryButtonInline}
              onClick={() => {
                props.onSaveAllowList(Array.from(draft));
                setEditing(false);
              }}
            >
              Save
            </button>
          </span>
        }
      >
        <p style={{ ...styles.muted, marginBottom: 6 }}>
          Pick the scenarios that should appear in this component's dropdown. The list is written to{' '}
          <code style={styles.inlineCode}>components['{props.componentPath}'].scenarios</code> in
          your config.
        </p>
        {props.allScenarios.map((s) => {
          const active = draft.has(s);
          return (
            <label key={s} style={styles.scenarioCheckRow}>
              <input
                type="checkbox"
                checked={active}
                onChange={() => {
                  setDraft((prev) => {
                    const next = new Set(prev);
                    if (active) next.delete(s);
                    else next.add(s);
                    return next;
                  });
                }}
              />
              <span style={{ fontFamily: MONO, fontSize: 12 }}>{s}</span>
            </label>
          );
        })}
      </Section>
    );
  }

  return (
    <Section
      title="Scenarios"
      action={
        <button
          type="button"
          onClick={() => setEditing(true)}
          style={styles.secondaryButtonInline}
          title="Edit which scenarios show up for this component"
        >
          Configure…
        </button>
      }
    >
      <ScenarioPickRow
        label="— base —"
        active={props.activeScenario === ''}
        onClick={() => props.onSelectScenario('')}
      />
      {props.applicableScenarios.length === 0 ? (
        <Empty>
          No scenarios apply to this component. Click <strong>Configure…</strong> to pick some.
        </Empty>
      ) : (
        props.applicableScenarios.map((s) => (
          <ScenarioPickRow
            key={s}
            label={s}
            active={props.activeScenario === s}
            onClick={() => props.onSelectScenario(s)}
          />
        ))
      )}
    </Section>
  );
}

function ScenarioPickRow(props: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        ...styles.scenarioPickRow,
        background: props.active ? 'rgba(124, 158, 255, 0.1)' : 'rgba(255,255,255,0.025)',
        border: props.active
          ? '1px solid rgba(124,158,255,0.25)'
          : '1px solid rgba(255,255,255,0.04)',
      }}
      aria-pressed={props.active}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 99,
          background: props.active ? '#9ec6ff' : 'rgba(255,255,255,0.2)',
        }}
      />
      <span
        style={{
          fontSize: 12.5,
          color: props.active ? '#cfddff' : '#eaf0fb',
          fontFamily: MONO,
        }}
      >
        {props.label}
      </span>
    </button>
  );
}

/* ----- Used-in / Flows sections ---------------------------------- */

function UsedInSection(props: {
  isScreen: boolean;
  usedComponents: string[];
  onJumpTo: (path: string) => void;
}): React.ReactElement | null {
  if (!props.isScreen || props.usedComponents.length === 0) return null;
  return (
    <Section title="Used in this screen">
      {props.usedComponents.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => props.onJumpTo(p)}
          style={styles.relatedRow}
          title={p}
        >
          <KindGlyph kind="component" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: '#eaf0fb' }}>{basename(p)}</div>
            <div style={styles.relatedPath}>{dirName(p)}</div>
          </div>
        </button>
      ))}
    </Section>
  );
}

function FlowsSection(props: {
  isScreen: boolean;
  componentPath: string;
  navigation: NavigationEdgeLite[];
  onJumpTo: (path: string) => void;
}): React.ReactElement | null {
  if (!props.isScreen) return null;
  const outgoing = props.navigation.filter((e) => e.from === props.componentPath);
  const incoming = props.navigation.filter((e) => e.toPath === props.componentPath);
  if (outgoing.length === 0 && incoming.length === 0) return null;
  return (
    <Section title="Flows">
      {outgoing.length > 0 && (
        <>
          <div style={styles.flowSubhead}>Outgoing</div>
          {outgoing.map((e, i) => (
            <button
              key={`o${i}`}
              type="button"
              onClick={() => props.onJumpTo(e.toPath)}
              style={styles.flowRow}
            >
              <div style={{ fontSize: 12, color: '#eaf0fb' }}>
                <code style={{ color: '#fbbf24', fontFamily: MONO }}>{e.trigger}</code> →{' '}
                <code style={{ color: '#9ec6ff', fontFamily: MONO }}>{e.to}</code>
              </div>
              <div style={styles.relatedPath}>{e.toPath}</div>
            </button>
          ))}
        </>
      )}
      {incoming.length > 0 && (
        <>
          <div style={styles.flowSubhead}>Incoming</div>
          {incoming.map((e, i) => (
            <button
              key={`i${i}`}
              type="button"
              onClick={() => props.onJumpTo(e.from)}
              style={styles.flowRow}
            >
              <div style={{ fontSize: 12, color: '#eaf0fb' }}>
                <code style={{ color: '#fbbf24', fontFamily: MONO }}>{e.trigger}</code> from{' '}
                <code style={{ color: '#9ec6ff', fontFamily: MONO }}>{basename(e.from)}</code>
              </div>
              <div style={styles.relatedPath}>{e.from}</div>
            </button>
          ))}
        </>
      )}
    </Section>
  );
}

/* ----- Section primitive ----------------------------------------- */

function Section(props: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={styles.sectionHeader}>
        <span style={styles.sectionTitle}>{props.title.toUpperCase()}</span>
        {props.action}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{props.children}</div>
    </div>
  );
}

function Empty(props: { children: React.ReactNode }): React.ReactElement {
  return <div style={styles.empty}>{props.children}</div>;
}

/* ====================================================================== *
 *                              <DetailView />                              *
 * ====================================================================== */

interface DetailViewProps {
  componentPath: string;
  entry: ComponentEntry;
  viewports: Set<string>;
  zoom: number;
  pan: { x: number; y: number };
  scenarioId: string;
  /**
   * Active per-component prop overrides. When non-empty, the frame URL
   * embeds them as base64 JSON in `?overrides=…` and the entry merges them
   * over the resolved auto-mocked / fixture props before mount.
   */
  propOverrides?: Record<string, unknown>;
  bgMode: 'checker' | 'grid' | 'light' | 'dark';
  inspect: boolean;
  fullscreen: string | null;
  fitTick: number;
  onFullscreen: (frameId: string | null) => void;
  onPan: (next: { x: number; y: number }) => void;
  onZoom: (next: number) => void;
  onWheel: (e: WheelEvent, viewportRect: DOMRect) => void;
}

function DetailView(props: DetailViewProps): React.ReactElement {
  const {
    componentPath,
    entry,
    viewports,
    zoom,
    pan,
    scenarioId,
    propOverrides,
    bgMode,
    inspect,
    fullscreen,
    fitTick,
    onFullscreen,
    onPan,
    onZoom,
    onWheel,
  } = props;

  const activeViewports: ViewportSpec[] = [];
  if (viewports.has('desktop')) activeViewports.push(BUILTIN_VIEWPORTS.desktop);
  if (viewports.has('tablet')) activeViewports.push(BUILTIN_VIEWPORTS.tablet);
  if (viewports.has('mobile')) activeViewports.push(BUILTIN_VIEWPORTS.mobile);

  const fixtures = entry.fixtures ? Object.entries(entry.fixtures) : [];
  const hasFixtures = fixtures.length > 0;
  const hasDefaultProps = entry.props && Object.keys(entry.props).length > 0;
  const showPlaceholder = !hasFixtures && !hasDefaultProps;

  const fixturesToRender: Array<{
    id: string;
    label: string;
    description?: string;
    inferred?: boolean;
  }> = hasFixtures
    ? fixtures.map(([id, fx]) => ({
        id,
        label: id,
        description: fx.description,
        inferred: fx.inferred,
      }))
    : hasDefaultProps
      ? [{ id: '', label: 'default' }]
      : [];

  const viewportRef = useRef<HTMLElement | null>(null);
  const artboardRef = useRef<HTMLDivElement | null>(null);

  const dragState = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );

  const onPanRef = useRef(onPan);
  onPanRef.current = onPan;
  const onWheelRef = useRef(onWheel);
  onWheelRef.current = onWheel;
  const panRef = useRef(pan);
  panRef.current = pan;

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = dragState.current;
      if (!drag) return;
      onPanRef.current({
        x: drag.baseX + (e.clientX - drag.startX),
        y: drag.baseY + (e.clientY - drag.startY),
      });
    };
    const onUp = (): void => {
      if (dragState.current) {
        dragState.current = null;
        document.body.style.cursor = '';
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handler = (e: WheelEvent): void => {
      const rect = el.getBoundingClientRect();
      onWheelRef.current(e, rect);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent): void => {
      const data = e.data as { type?: string; iframeX?: number; iframeY?: number } | null;
      if (!data || data.type !== 'validity:inspect:pan-start') return;
      dragState.current = {
        startX: 0,
        startY: 0,
        baseX: panRef.current.x,
        baseY: panRef.current.y,
      };
      document.body.style.cursor = 'grabbing';
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>): void => {
      const target = e.target as HTMLElement | null;
      const isIframeArea = !!target?.closest('iframe[data-validity-iframe]');
      if (isIframeArea && e.button === 0) return;
      if (e.button !== 0 && e.button !== 1) return;
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: pan.x,
        baseY: pan.y,
      };
      document.body.style.cursor = 'grabbing';
    },
    [pan.x, pan.y],
  );

  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;
  const onPanRefForFit = useRef(onPan);
  onPanRefForFit.current = onPan;
  useEffect(() => {
    if (fitTick === 0) return;
    const handles: number[] = [];
    let lastFitZoom = 0;
    const runFit = (): void => {
      const vp = viewportRef.current;
      const ab = artboardRef.current;
      if (!vp || !ab) return;
      const vpRect = vp.getBoundingClientRect();
      const prevTransform = ab.style.transform;
      ab.style.transform = 'translate(0, 0) scale(1)';
      const abRect = ab.getBoundingClientRect();
      ab.style.transform = prevTransform;
      const naturalWidth = abRect.width;
      const naturalHeight = abRect.height;
      if (naturalWidth === 0 || naturalHeight === 0) return;
      const padding = 80;
      const zoomX = (vpRect.width - padding * 2) / naturalWidth;
      const zoomY = (vpRect.height - padding * 2) / naturalHeight;
      const next = clamp(Math.min(zoomX, zoomY), ZOOM_MIN, ZOOM_MAX);
      if (Math.abs(next - lastFitZoom) < 0.001) return;
      lastFitZoom = next;
      onZoomRef.current(next);
      onPanRefForFit.current({
        x: (vpRect.width - naturalWidth * next) / 2,
        y: (vpRect.height - naturalHeight * next) / 2,
      });
    };
    const raf = requestAnimationFrame(runFit);
    handles.push(window.setTimeout(runFit, 60));
    handles.push(window.setTimeout(runFit, 240));
    return () => {
      cancelAnimationFrame(raf);
      for (const h of handles) window.clearTimeout(h);
    };
  }, [fitTick]);

  return (
    <section
      ref={viewportRef}
      style={{
        ...styles.detailViewport,
        ...detailBgStyle(bgMode),
        // When design mode is on, a subtle inner ring on the canvas
        // signals "you're inspecting, not browsing". Cheap visual cue
        // that fixes the "design mode doesn't seem to do anything"
        // confusion.
        boxShadow: inspect
          ? 'inset 0 0 0 1px rgba(124, 158, 255, 0.18), inset 0 0 60px rgba(124, 158, 255, 0.06)'
          : 'none',
        cursor: inspect ? 'crosshair' : 'grab',
      }}
      onMouseDown={onMouseDown}
      data-validity-detail-viewport="true"
      aria-label={`Detail view for ${componentPath}`}
    >
      {showPlaceholder ? (
        <div style={styles.placeholderCentered}>
          <PlaceholderCard
            componentPath={componentPath}
            reason={entry.discovered ? 'discovered' : 'no-fixtures'}
          />
        </div>
      ) : (
        <div
          ref={artboardRef}
          style={{
            ...styles.detailArtboard,
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        >
          {fixturesToRender.map((fx) => (
            <section key={fx.id || 'default'} style={styles.detailFixture}>
              <header style={styles.detailFixtureHeader}>
                <h3 style={styles.detailFixtureTitle}>{fx.label}</h3>
                {fx.inferred && (
                  <span style={styles.autoBadge} title="Props synthesized from TypeScript types">
                    AUTO
                  </span>
                )}
                {fx.description && (
                  <span style={styles.detailFixtureDescription}>{fx.description}</span>
                )}
              </header>
              <div style={styles.detailFrameRow}>
                {activeViewports.map((vp) => {
                  const fid = makeFrameId(componentPath, fx.id, vp.key);
                  return (
                    <DetailFrame
                      key={fid}
                      componentPath={componentPath}
                      stateId={fx.id}
                      stateLabel={fx.label}
                      viewport={vp}
                      scenarioId={scenarioId}
                      propOverrides={propOverrides}
                      frameId={fid}
                      inspect={inspect}
                      fullscreen={fullscreen === fid}
                      onFullscreen={() => onFullscreen(fullscreen === fid ? null : fid)}
                    />
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <div style={styles.canvasHint}>
        {inspect ? (
          <>
            Hover to inspect · <strong style={{ color: 'rgba(230,235,245,0.8)' }}>click</strong> to
            pin · <Kbd>esc</Kbd> deselect
          </>
        ) : (
          <>Drag to pan · ⌘/Ctrl + wheel to zoom · turn on Design to inspect</>
        )}
      </div>
    </section>
  );
}

/* ====================================================================== *
 *                          <ViewDetailView />                              *
 * ====================================================================== */

interface ViewDetailViewProps {
  view: ViewLite;
  viewports: Set<string>;
  zoom: number;
  pan: { x: number; y: number };
  scenarioId: string;
  bgMode: 'checker' | 'grid' | 'light' | 'dark';
  inspect: boolean;
  fullscreen: string | null;
  fitTick: number;
  onFullscreen: (frameId: string | null) => void;
  onPan: (next: { x: number; y: number }) => void;
  onZoom: (next: number) => void;
  onWheel: (e: WheelEvent, viewportRect: DOMRect) => void;
}

/**
 * Canvas for browse-mode views. Shares the pan/zoom/wheel/fit scaffolding
 * with DetailView but renders a single iframe per active viewport (the view
 * itself is the composition — there are no fixtures to grid out). Each
 * iframe loads `?view=<name>` and the sandbox entry reads
 * `window.__VALIDITY_VIEWS__[<name>]` to drive its multi-component render.
 */
function ViewDetailView(props: ViewDetailViewProps): React.ReactElement {
  const {
    view,
    viewports,
    zoom,
    pan,
    scenarioId,
    bgMode,
    inspect,
    fullscreen,
    fitTick,
    onFullscreen,
    onPan,
    onZoom,
    onWheel,
  } = props;

  const activeViewports: ViewportSpec[] = [];
  if (viewports.has('desktop')) activeViewports.push(BUILTIN_VIEWPORTS.desktop);
  if (viewports.has('tablet')) activeViewports.push(BUILTIN_VIEWPORTS.tablet);
  if (viewports.has('mobile')) activeViewports.push(BUILTIN_VIEWPORTS.mobile);

  const viewportRef = useRef<HTMLElement | null>(null);
  const artboardRef = useRef<HTMLDivElement | null>(null);

  const dragState = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );
  const onPanRef = useRef(onPan);
  onPanRef.current = onPan;
  const onWheelRef = useRef(onWheel);
  onWheelRef.current = onWheel;
  const panRef = useRef(pan);
  panRef.current = pan;

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = dragState.current;
      if (!drag) return;
      onPanRef.current({
        x: drag.baseX + (e.clientX - drag.startX),
        y: drag.baseY + (e.clientY - drag.startY),
      });
    };
    const onUp = (): void => {
      if (dragState.current) {
        dragState.current = null;
        document.body.style.cursor = '';
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const handler = (e: WheelEvent): void => {
      const rect = el.getBoundingClientRect();
      onWheelRef.current(e, rect);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLElement>): void => {
      const target = e.target as HTMLElement | null;
      const isIframeArea = !!target?.closest('iframe[data-validity-iframe]');
      if (isIframeArea && e.button === 0) return;
      if (e.button !== 0 && e.button !== 1) return;
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseX: pan.x,
        baseY: pan.y,
      };
      document.body.style.cursor = 'grabbing';
    },
    [pan.x, pan.y],
  );

  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;
  const onPanRefForFit = useRef(onPan);
  onPanRefForFit.current = onPan;
  useEffect(() => {
    if (fitTick === 0) return;
    let lastFitZoom = 0;
    const handles: number[] = [];
    const runFit = (): void => {
      const vp = viewportRef.current;
      const ab = artboardRef.current;
      if (!vp || !ab) return;
      const vpRect = vp.getBoundingClientRect();
      const prevTransform = ab.style.transform;
      ab.style.transform = 'translate(0, 0) scale(1)';
      const abRect = ab.getBoundingClientRect();
      ab.style.transform = prevTransform;
      const naturalWidth = abRect.width;
      const naturalHeight = abRect.height;
      if (naturalWidth === 0 || naturalHeight === 0) return;
      const padding = 80;
      const zoomX = (vpRect.width - padding * 2) / naturalWidth;
      const zoomY = (vpRect.height - padding * 2) / naturalHeight;
      const next = clamp(Math.min(zoomX, zoomY), ZOOM_MIN, ZOOM_MAX);
      if (Math.abs(next - lastFitZoom) < 0.001) return;
      lastFitZoom = next;
      onZoomRef.current(next);
      onPanRefForFit.current({
        x: (vpRect.width - naturalWidth * next) / 2,
        y: (vpRect.height - naturalHeight * next) / 2,
      });
    };
    const raf = requestAnimationFrame(runFit);
    handles.push(window.setTimeout(runFit, 60));
    handles.push(window.setTimeout(runFit, 240));
    return () => {
      cancelAnimationFrame(raf);
      for (const h of handles) window.clearTimeout(h);
    };
  }, [fitTick]);

  return (
    <section
      ref={viewportRef}
      style={{
        ...styles.detailViewport,
        ...detailBgStyle(bgMode),
        boxShadow: inspect
          ? 'inset 0 0 0 1px rgba(124, 158, 255, 0.18), inset 0 0 60px rgba(124, 158, 255, 0.06)'
          : 'none',
        cursor: inspect ? 'crosshair' : 'grab',
      }}
      onMouseDown={onMouseDown}
      data-validity-detail-viewport="true"
      data-validity-view-canvas={view.name}
      aria-label={`View canvas for ${view.name}`}
    >
      <div
        ref={artboardRef}
        style={{
          ...styles.detailArtboard,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        {viewFrameGroups(view).map((group, gi) => (
          <section key={group.key} style={styles.detailFixture}>
            <header style={styles.detailFixtureHeader}>
              <h3 style={styles.detailFixtureTitle}>{group.label}</h3>
              {gi === 0 && (
                <span style={styles.autoBadge} title={`Author-defined view: ${view.name}`}>
                  VIEW
                </span>
              )}
              {gi === 0 && view.description && (
                <span style={styles.detailFixtureDescription}>{view.description}</span>
              )}
            </header>
            <div style={styles.detailFrameRow}>
              {activeViewports.map((vp) => {
                const fid = `view:${view.name}__${group.key}__${vp.key}`;
                return (
                  <ViewDetailFrame
                    key={fid}
                    viewName={view.name}
                    frameKey={group.key}
                    viewport={vp}
                    scenarioId={scenarioId}
                    frameId={fid}
                    inspect={inspect}
                    fullscreen={fullscreen === fid}
                    onFullscreen={() => onFullscreen(fullscreen === fid ? null : fid)}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <div style={styles.canvasHint}>
        {inspect ? (
          <>
            Hover to inspect · <strong style={{ color: 'rgba(230,235,245,0.8)' }}>click</strong> to
            pin · <Kbd>esc</Kbd> deselect
          </>
        ) : (
          <>Drag to pan · ⌘/Ctrl + wheel to zoom · turn on Design to inspect</>
        )}
      </div>
    </section>
  );
}

interface ViewDetailFrameProps {
  viewName: string;
  /** Which frame group of the view this iframe renders (see viewFrameKeyFor). */
  frameKey: string;
  viewport: ViewportSpec;
  scenarioId: string;
  frameId: string;
  inspect: boolean;
  fullscreen: boolean;
  onFullscreen: () => void;
}

const ViewDetailFrame = React.memo(function ViewDetailFrameImpl(
  props: ViewDetailFrameProps,
): React.ReactElement {
  const { viewName, frameKey, viewport, scenarioId, frameId, inspect, fullscreen, onFullscreen } =
    props;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  const baseKey = `${viewName}__${frameKey}__${scenarioId}`;
  const stableSrc = useMemo(
    () => buildViewFrameUrl(viewName, scenarioId, frameKey),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseKey],
  );

  useEffect(() => {
    setLoaded(false);
  }, [baseKey]);

  return (
    <div
      style={{
        ...styles.detailFrameOuter,
        ...(fullscreen ? styles.detailFrameOuterFullscreen : null),
      }}
      data-validity-frame={frameId}
    >
      <header style={styles.detailFrameHeader}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={styles.detailFrameViewportLabel}>{viewport.label}</span>
          <span style={styles.detailFrameDims}>
            {viewport.width}×{viewport.height}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            onClick={onFullscreen}
            style={styles.detailFrameIconButton}
            title={fullscreen ? 'Exit fullscreen (F / Esc)' : 'Fullscreen this frame (F)'}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen this frame'}
          >
            {fullscreen ? '⤡' : '⤢'}
          </button>
          <a
            href={stableSrc}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.detailFrameIconButton}
            title="Open in new tab"
          >
            ↗
          </a>
        </div>
      </header>
      <div
        style={{
          ...styles.detailFrameShell,
          width: viewport.width,
          height: viewport.height,
        }}
      >
        <iframe
          ref={iframeRef}
          title={`View ${viewName} — ${viewport.label}`}
          src={stableSrc}
          style={{
            ...styles.detailFrameIframe,
            opacity: loaded ? 1 : 0,
            transition: 'opacity 120ms ease-out',
          }}
          data-validity-iframe={frameId}
          onLoad={() => {
            setLoaded(true);
            try {
              iframeRef.current?.contentWindow?.postMessage(
                {
                  type: inspect ? 'validity:inspect:enable' : 'validity:inspect:disable',
                  frameId,
                },
                '*',
              );
            } catch {
              /* ignore */
            }
          }}
          onError={() => setLoaded(true)}
        />
        {!loaded && (
          <div style={styles.detailFrameShimmer}>
            <span>{viewport.label}…</span>
          </div>
        )}
      </div>
    </div>
  );
});

function detailBgStyle(mode: 'checker' | 'grid' | 'light' | 'dark'): React.CSSProperties {
  switch (mode) {
    case 'light':
      return { background: '#f3f5fa' };
    case 'dark':
      return { background: '#0a0f1a' };
    case 'grid':
      return {
        background: '#0a0f1a',
        backgroundImage:
          'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      };
    case 'checker':
    default:
      return {
        background: '#0a0f1a',
        backgroundImage:
          'linear-gradient(45deg, rgba(255,255,255,0.04) 25%, transparent 25%), linear-gradient(-45deg, rgba(255,255,255,0.04) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.04) 75%), linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.04) 75%)',
        backgroundSize: '20px 20px',
        backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
      };
  }
}

/* ====================================================================== *
 *                             <DetailFrame />                              *
 * ====================================================================== */

interface DetailFrameProps {
  componentPath: string;
  stateId: string;
  stateLabel: string;
  viewport: ViewportSpec;
  scenarioId: string;
  propOverrides?: Record<string, unknown>;
  frameId: string;
  inspect: boolean;
  fullscreen: boolean;
  onFullscreen: () => void;
}

const DetailFrame = React.memo(function DetailFrameImpl(
  props: DetailFrameProps,
): React.ReactElement {
  const {
    componentPath,
    stateId,
    stateLabel,
    viewport,
    scenarioId,
    propOverrides,
    frameId,
    inspect,
    fullscreen,
    onFullscreen,
  } = props;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  // The iframe `src` is computed once per *real* navigation
  // (component/state/scenario change) and deliberately omits later override
  // changes — those flow through postMessage instead so the iframe doesn't
  // re-navigate (and FOUC) on every dropdown click. The initial URL still
  // carries the current overrides so the first paint is correct.
  //
  // `urlForOpen` is the always-current URL used by the "open in new tab"
  // affordance — opening externally should preserve the user's edits even
  // though the in-page iframe wouldn't have used them as src.
  const baseKey = `${componentPath}__${stateId}__${scenarioId}`;
  const overridesRef = useRef(propOverrides);
  overridesRef.current = propOverrides;
  const stableSrc = useMemo(
    () => buildFrameUrl(componentPath, stateId, scenarioId, overridesRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseKey],
  );
  const urlForOpen = buildFrameUrl(componentPath, stateId, scenarioId, propOverrides);

  useEffect(() => {
    setLoaded(false);
  }, [baseKey]);

  // Push override changes into the iframe in-place once it has loaded.
  // Skipping until `loaded` flips true avoids posting to a still-empty
  // contentWindow during the first paint (the URL already carries the
  // initial overrides, so the iframe wakes up with the correct props).
  useEffect(() => {
    if (!loaded) return;
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    try {
      win.postMessage({ type: 'validity:overrides:set', overrides: propOverrides ?? {} }, '*');
    } catch {
      /* ignore — receiving page hasn't subscribed yet */
    }
  }, [propOverrides, loaded]);

  return (
    <div
      style={{
        ...styles.detailFrameOuter,
        ...(fullscreen ? styles.detailFrameOuterFullscreen : null),
      }}
      data-validity-frame={frameId}
    >
      <header style={styles.detailFrameHeader}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={styles.detailFrameViewportLabel}>{viewport.label}</span>
          <span style={styles.detailFrameDims}>
            {viewport.width}×{viewport.height}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            onClick={onFullscreen}
            style={styles.detailFrameIconButton}
            title={fullscreen ? 'Exit fullscreen (F / Esc)' : 'Fullscreen this frame (F)'}
            aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen this frame'}
          >
            {fullscreen ? '⤡' : '⤢'}
          </button>
          <a
            href={urlForOpen}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.detailFrameIconButton}
            title="Open in new tab"
          >
            ↗
          </a>
        </div>
      </header>
      <div
        style={{
          ...styles.detailFrameShell,
          width: viewport.width,
          height: viewport.height,
        }}
      >
        <iframe
          ref={iframeRef}
          title={`${componentPath} — ${stateLabel} — ${viewport.label}`}
          src={stableSrc}
          style={{
            ...styles.detailFrameIframe,
            // Keep the old frame visible behind the loader until the new
            // navigation has actually painted. The opacity flip pairs with
            // the shimmer overlay above to mask the inter-page white flash
            // browsers show during a same-origin iframe navigation.
            opacity: loaded ? 1 : 0,
            transition: 'opacity 120ms ease-out',
          }}
          data-validity-iframe={frameId}
          onLoad={() => {
            setLoaded(true);
            try {
              iframeRef.current?.contentWindow?.postMessage(
                {
                  type: inspect ? 'validity:inspect:enable' : 'validity:inspect:disable',
                  frameId,
                },
                '*',
              );
              const win = iframeRef.current?.contentWindow;
              if (win) {
                try {
                  win.scrollTo(0, 0);
                } catch {
                  /* ignore */
                }
              }
            } catch {
              /* ignore */
            }
          }}
          onError={() => setLoaded(true)}
        />
        {!loaded && (
          <div style={styles.detailFrameShimmer}>
            <span>{viewport.label}…</span>
          </div>
        )}
      </div>
    </div>
  );
});

/* ====================================================================== *
 *                              Helpers                                    *
 * ====================================================================== */

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

function dirName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function firstToken(s: string): string {
  return (s.split(',')[0] ?? '').replace(/['"]/g, '').trim();
}

function kindForPath(path: string, screens: Set<string>): PaletteItem['kind'] {
  if (screens.has(path)) return 'screen';
  // Heuristic: anything in /ui/ or /primitives/ is a primitive.
  if (/\/(ui|primitives)\//i.test(path)) return 'primitive';
  return 'component';
}

function computeApplicableScenarios(
  entry: ComponentEntry | undefined,
  allScenarios: string[],
): string[] {
  if (!entry) return allScenarios;
  if (entry.scenarios === undefined) return allScenarios;
  // Filter to entries that actually exist (avoid stale ids in config).
  const existing = new Set(allScenarios);
  return entry.scenarios.filter((s) => existing.has(s));
}

function findKnownComponentPath(
  absOrRelative: string,
  allComponents: Record<string, ComponentEntry>,
): string | null {
  if (allComponents[absOrRelative]) return absOrRelative;
  let best: string | null = null;
  const normalized = absOrRelative.replace(/\\/g, '/');
  for (const key of Object.keys(allComponents)) {
    if (normalized.endsWith('/' + key) || normalized === key) {
      if (!best || key.length > best.length) best = key;
    }
  }
  return best;
}

function broadcastToFrames(message: Record<string, unknown>): void {
  const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-validity-iframe]');
  frames.forEach((f) => {
    const fid = f.getAttribute('data-validity-iframe') ?? '';
    try {
      f.contentWindow?.postMessage({ ...message, frameId: fid }, '*');
    } catch {
      /* iframe still loading */
    }
  });
}

function postToFrame(frameId: string, message: Record<string, unknown>): void {
  const frame = document.querySelector<HTMLIFrameElement>(
    `iframe[data-validity-iframe="${cssEscape(frameId)}"]`,
  );
  if (!frame) return;
  try {
    frame.contentWindow?.postMessage({ ...message, frameId }, '*');
  } catch {
    /* ignore */
  }
}

function cssEscape(s: string): string {
  const ce = (window as unknown as { CSS?: { escape?: (s: string) => string } }).CSS?.escape;
  return typeof ce === 'function' ? ce(s) : s.replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}

/* ====================================================================== *
 *                         Save fixture flow                               *
 * ====================================================================== */

async function saveFixtureFlow(
  state: { id: string; props: Record<string, unknown> },
  setStatus: (s: string | null) => void,
  refreshConfig: () => Promise<void>,
): Promise<void> {
  const defaultName = state.id || 'captured';
  const name = window.prompt('Fixture name (lowercase, hyphenated):', defaultName);
  if (!name) return;
  try {
    const url = new URL(window.location.href);
    const path = url.searchParams.get('focus');
    if (!path) {
      setStatus('!no focus component');
      return;
    }
    const res = await fetch('/__validity/api/fixture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ componentPath: path, fixtureName: name, props: state.props }),
    });
    const body = (await res.json()) as { ok?: boolean; mode?: string; error?: string };
    if (!res.ok || body.ok === false) {
      setStatus('!' + (body.error ?? 'save failed'));
      return;
    }
    setStatus(`saved (${body.mode ?? 'ast'})`);
    await refreshConfig();
    setTimeout(() => setStatus(null), 4000);
  } catch (err) {
    setStatus('!' + ((err as Error).message ?? String(err)));
  }
}

/**
 * Persist a component-level `scenarios` allow-list to `.validity/config.ts`
 * via the same fixture endpoint (extended). The server handler patches the
 * file in place; if the patch fails (e.g. exotic config layout) we surface
 * the error and the user keeps the in-memory selection.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- part of the preserved scenarios feature (see <ScenariosSection/>), kept for revival
async function saveComponentScenariosFlow(
  componentPath: string,
  next: string[],
  setStatus: (s: string | null) => void,
  refreshConfig: () => Promise<void>,
): Promise<void> {
  try {
    const res = await fetch('/__validity/api/component-scenarios', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ componentPath, scenarios: next }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setStatus('!' + (body.error ?? `HTTP ${res.status}`));
      return;
    }
    setStatus('scenarios saved');
    await refreshConfig();
    setTimeout(() => setStatus(null), 4000);
  } catch (err) {
    setStatus('!' + ((err as Error).message ?? String(err)));
  }
}

/* ====================================================================== *
 *                          <HelpOverlay />                                *
 * ====================================================================== */

function HelpOverlay(props: { onClose: () => void }): React.ReactElement {
  const rows: Array<{ keys: string; label: string }> = [
    { keys: '⌘P / Ctrl+P', label: 'Find a component' },
    { keys: 'I', label: 'Toggle Design mode' },
    { keys: '\\', label: 'Toggle inspector flyout' },
    { keys: 'D / T / M', label: 'Toggle Desktop / Tablet / Mobile viewport' },
    { keys: 'F', label: 'Fullscreen the active frame' },
    { keys: '+ / -', label: 'Zoom in / out' },
    { keys: '0', label: 'Reset zoom' },
    { keys: 'Esc', label: 'Close overlays / clear selection' },
    { keys: '?', label: 'Toggle this help' },
    { keys: 'Alt + hover', label: 'Distance to hovered element' },
  ];
  return (
    <div style={styles.helpScrim} onClick={props.onClose}>
      <div
        style={styles.helpModal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
      >
        <header style={styles.helpHeader}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#eaf0fb' }}>
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            style={{
              ...styles.btn,
              height: 26,
              width: 26,
              padding: 0,
              color: 'rgba(230,235,245,0.6)',
            }}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <ul style={{ listStyle: 'none', margin: 0, padding: '14px 18px 18px' }}>
          {rows.map((r) => (
            <li
              key={r.keys}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '6px 0',
                color: '#eaf0fb',
                fontSize: 13,
              }}
            >
              <Kbd>{r.keys}</Kbd>
              <span>{r.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ====================================================================== *
 *                          <PlaceholderCard />                            *
 * ====================================================================== */

function PlaceholderCard(props: {
  componentPath: string;
  reason: 'discovered' | 'no-fixtures';
}): React.ReactElement {
  return (
    <div style={styles.placeholderCard}>
      <div style={styles.placeholderHeading}>
        {props.reason === 'discovered' ? 'Auto-discovered · no fixture yet' : 'No fixture defined'}
      </div>
      <p style={styles.placeholderBody}>
        Validity isn't rendering this component because it doesn't know what props to give it.
        Define a fixture (or default <code style={styles.inlineCode}>props</code>) under{' '}
        <code style={styles.inlineCode}>{props.componentPath}</code> in{' '}
        <code style={styles.inlineCode}>.validity/config.ts</code>, then reload.
      </p>
    </div>
  );
}

function EmptyCanvas(props: { onOpenPalette: () => void }): React.ReactElement {
  return (
    <div style={styles.emptyCanvas}>
      <h2 style={{ fontSize: 18, fontWeight: 500, margin: 0, color: '#eaf0fb' }}>
        No components yet.
      </h2>
      <p
        style={{
          maxWidth: 520,
          color: 'rgba(230,235,245,0.55)',
          fontSize: 13,
          lineHeight: 1.6,
          margin: '12px 0 18px',
        }}
      >
        Add a <code style={styles.inlineCode}>.tsx</code> /{' '}
        <code style={styles.inlineCode}>.jsx</code> component to your project or define one under{' '}
        <code style={styles.inlineCode}>components</code> in{' '}
        <code style={styles.inlineCode}>.validity/config.ts</code>.
      </p>
      <button type="button" onClick={props.onOpenPalette} style={styles.primaryButton}>
        Open find <Kbd>⌘</Kbd>
        <Kbd>P</Kbd>
      </button>
    </div>
  );
}

/* ====================================================================== *
 *                         Loading / Error                                 *
 * ====================================================================== */

function LoadingScreen(): React.ReactElement {
  return <div style={styles.loadingScreen}>Loading Validity browse…</div>;
}

function ErrorScreen(props: { message: string }): React.ReactElement {
  return <div style={styles.errorScreen}>{props.message}</div>;
}

/* ====================================================================== *
 *                              Styles                                     *
 * ====================================================================== */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

const styles: Record<string, React.CSSProperties> = {
  /* ---- Shell ---- */
  shell: {
    position: 'fixed',
    inset: 0,
    background: '#070b15',
    color: '#e6ebf5',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
    overflow: 'hidden',
  },
  shellLight: {
    background: '#f1f5f9',
    color: '#0f172a',
  },

  /* ---- Toolbar ---- */
  toolbar: {
    position: 'fixed',
    zIndex: 50,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: 5,
    background: 'rgba(17, 25, 42, 0.78)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 12,
    backdropFilter: 'blur(20px) saturate(140%)',
    WebkitBackdropFilter: 'blur(20px) saturate(140%)',
    boxShadow: '0 10px 32px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.02) inset',
    color: '#e6ebf5',
    fontSize: 12,
    maxWidth: 'min(1100px, calc(100vw - 40px))',
    flexWrap: 'wrap',
  },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 28,
    padding: '0 8px',
    border: 0,
    borderRadius: 7,
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
    background: 'transparent',
    transition: 'background 120ms',
  },
  miniBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 22,
    padding: '0 8px',
    border: 0,
    borderRadius: 6,
    color: 'rgba(230,235,245,0.85)',
    fontFamily: 'inherit',
    fontSize: 11,
    cursor: 'pointer',
    background: 'transparent',
  },
  divider: {
    width: 1,
    height: 18,
    background: 'rgba(255,255,255,0.08)',
    margin: '0 2px',
    flex: '0 0 auto',
  },
  brandV: {
    display: 'inline-flex',
    width: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    background: 'linear-gradient(135deg, #9ec6ff, #5778d8)',
    color: '#0d1424',
    fontWeight: 800,
    fontSize: 10,
    letterSpacing: -0.3,
    flex: '0 0 18px',
  },
  toolbarIdentInner: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minWidth: 0,
    maxWidth: 200,
  },
  toolbarIdentName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: '#eaf0fb',
  },
  segGroup: {
    display: 'flex',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 7,
    padding: 2,
  },
  zoomGroup: {
    display: 'flex',
    alignItems: 'center',
    background: 'rgba(255,255,255,0.04)',
    borderRadius: 7,
    padding: 2,
  },
  zoomLabel: {
    height: 22,
    minWidth: 48,
    border: 0,
    background: 'transparent',
    color: 'rgba(230,235,245,0.9)',
    cursor: 'pointer',
    font: 'inherit',
    fontVariantNumeric: 'tabular-nums',
    fontSize: 11.5,
  },
  kbd: {
    display: 'inline-block',
    padding: '1px 6px',
    fontSize: 10.5,
    fontFamily: MONO,
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 4,
    color: 'rgba(230,235,245,0.7)',
    lineHeight: 1.4,
  },

  /* ---- Scenario menu ---- */
  scenarioMenu: {
    position: 'absolute',
    top: 'calc(100% + 6px)',
    right: 0,
    minWidth: 200,
    background: '#11192a',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 8,
    padding: 6,
    boxShadow: '0 20px 48px rgba(0,0,0,0.5)',
    zIndex: 60,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  scenarioOption: {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    padding: '7px 10px',
    background: 'transparent',
    border: 0,
    borderRadius: 5,
    color: '#eaf0fb',
    cursor: 'pointer',
    font: 'inherit',
    fontFamily: MONO,
    fontSize: 12,
    textAlign: 'left',
  },
  scenarioOptionActive: {
    background: 'rgba(124, 158, 255, 0.16)',
    color: '#cfddff',
  },

  /* ---- Palette ---- */
  paletteScrim: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    background: 'rgba(6, 10, 18, 0.55)',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    display: 'flex',
    justifyContent: 'center',
    paddingTop: '12vh',
  },
  paletteModal: {
    width: 'min(640px, 92vw)',
    background: '#11192a',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 14,
    boxShadow: '0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.02) inset',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '70vh',
  },
  paletteSearchRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '14px 18px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  paletteInput: {
    flex: 1,
    background: 'transparent',
    border: 0,
    outline: 'none',
    color: '#e6ebf5',
    fontSize: 15,
    fontFamily: 'inherit',
    padding: '4px 0',
  },
  paletteList: { overflowY: 'auto', padding: 6 },
  paletteEmpty: {
    padding: '40px 20px',
    textAlign: 'center',
    color: 'rgba(230,235,245,0.45)',
    fontSize: 13,
  },
  paletteRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 12px',
    borderRadius: 8,
    cursor: 'pointer',
  },
  paletteRowMain: {
    fontSize: 14,
    color: '#eaf0fb',
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
  },
  paletteRowName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  paletteRowPath: {
    fontSize: 11.5,
    color: 'rgba(230,235,245,0.42)',
    marginTop: 2,
    fontFamily: MONO,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  paletteOpenBadge: {
    fontSize: 9.5,
    letterSpacing: 1,
    color: '#7c9eff',
    border: '1px solid rgba(124,158,255,0.4)',
    padding: '1px 6px',
    borderRadius: 4,
  },
  paletteRoute: {
    fontSize: 10,
    color: '#7dd3fc',
    fontFamily: MONO,
  },
  paletteKind: {
    fontSize: 10,
    color: 'rgba(230,235,245,0.4)',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  paletteFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 14px',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    fontSize: 11,
    color: 'rgba(230,235,245,0.45)',
  },

  /* ---- Flyout ---- */
  flyoutPanel: {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: 320,
    zIndex: 30,
    background: 'rgba(13, 19, 32, 0.92)',
    backdropFilter: 'blur(18px) saturate(140%)',
    WebkitBackdropFilter: 'blur(18px) saturate(140%)',
    borderLeft: '1px solid rgba(255,255,255,0.07)',
    color: '#e6ebf5',
    fontSize: 13,
    transition: 'transform 240ms cubic-bezier(0.32, 0.72, 0, 1)',
    display: 'flex',
    flexDirection: 'column',
  },
  flyoutHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 18px 14px',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  },
  flyoutEyebrow: {
    fontSize: 10,
    letterSpacing: 1.6,
    opacity: 0.55,
  },
  flyoutBody: {
    flex: 1,
    overflowY: 'auto',
    padding: 18,
  },
  flyoutEmpty: {
    padding: '20px 4px',
    color: 'rgba(230,235,245,0.55)',
    fontSize: 13,
  },
  flyoutRail: {
    position: 'fixed',
    top: '50%',
    zIndex: 40,
    transform: 'translateY(-50%)',
    height: 64,
    width: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(17, 25, 42, 0.88)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRight: 0,
    borderTopLeftRadius: 8,
    borderBottomLeftRadius: 8,
    color: 'rgba(230,235,245,0.7)',
    cursor: 'pointer',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    transition: 'right 240ms cubic-bezier(0.32, 0.72, 0, 1)',
    padding: 0,
  },

  /* ---- Props flyout (left-side mirror of InspectorFlyout) ---- */
  propsFlyoutPanel: {
    position: 'fixed',
    top: 0,
    left: 0,
    bottom: 0,
    width: 320,
    zIndex: 30,
    background: 'rgba(13, 19, 32, 0.92)',
    backdropFilter: 'blur(18px) saturate(140%)',
    WebkitBackdropFilter: 'blur(18px) saturate(140%)',
    borderRight: '1px solid rgba(255,255,255,0.07)',
    color: '#e6ebf5',
    fontSize: 13,
    transition: 'transform 240ms cubic-bezier(0.32, 0.72, 0, 1)',
    display: 'flex',
    flexDirection: 'column',
  },
  propsFlyoutRail: {
    position: 'fixed',
    top: '50%',
    zIndex: 40,
    transform: 'translateY(-50%)',
    height: 64,
    width: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(17, 25, 42, 0.88)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderLeft: 0,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
    color: 'rgba(230,235,245,0.7)',
    cursor: 'pointer',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    transition: 'left 240ms cubic-bezier(0.32, 0.72, 0, 1)',
    padding: 0,
  },
  propsFlyoutFooter: {
    padding: '12px 18px',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  propsFieldRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '10px 0',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
  },
  propsFieldHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    minHeight: 18,
  },
  propsFieldName: {
    fontFamily: MONO,
    fontSize: 12.5,
    color: '#eaf0fb',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  propsFieldType: {
    fontFamily: MONO,
    fontSize: 10.5,
    color: 'rgba(230,235,245,0.4)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    minWidth: 0,
  },
  propsFieldInput: {
    width: '100%',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 5,
    color: '#eaf0fb',
    fontFamily: MONO,
    fontSize: 12,
    padding: '5px 8px',
    outline: 'none',
    boxSizing: 'border-box',
  },
  propsFieldComplex: {
    fontSize: 10.5,
    color: 'rgba(230,235,245,0.45)',
    fontStyle: 'italic',
    lineHeight: 1.4,
    marginTop: 2,
  },
  propsFieldResetBtn: {
    width: 18,
    height: 18,
    minWidth: 18,
    padding: 0,
    border: 0,
    borderRadius: 4,
    background: 'transparent',
    color: 'rgba(230,235,245,0.55)',
    cursor: 'pointer',
    fontSize: 11,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
  },

  /* ---- Section primitive ---- */
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    minHeight: 22,
  },
  sectionTitle: {
    fontSize: 10,
    letterSpacing: 1.5,
    color: 'rgba(230,235,245,0.45)',
  },
  empty: {
    fontSize: 12,
    color: 'rgba(230,235,245,0.35)',
    padding: '4px 2px',
    lineHeight: 1.45,
  },
  muted: {
    fontSize: 12,
    color: 'rgba(230,235,245,0.55)',
    lineHeight: 1.5,
    margin: 0,
  },

  /* ---- Pinned element ---- */
  elemGlyph: {
    width: 22,
    height: 22,
    flex: '0 0 22px',
    background: 'linear-gradient(135deg, #9ec6ff, #5778d8)',
    color: '#0d1424',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 700,
  },
  elemSelector: {
    fontFamily: MONO,
    fontSize: 13,
    wordBreak: 'break-word',
  },
  jumpButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 500,
    border: '1px solid rgba(124, 158, 255, 0.3)',
    background: 'rgba(124, 158, 255, 0.12)',
    color: '#cfddff',
    borderRadius: 5,
    cursor: 'pointer',
    width: 'fit-content',
    fontFamily: 'inherit',
  },
  styleGrid: {
    background: 'rgba(255,255,255,0.025)',
    border: '1px solid rgba(255,255,255,0.05)',
    borderRadius: 8,
    padding: '10px 12px',
    display: 'grid',
    gridTemplateColumns: '78px 1fr',
    rowGap: 6,
    columnGap: 10,
    fontFamily: MONO,
    fontSize: 11.5,
    marginTop: 14,
  },
  distanceCard: {
    marginTop: 12,
    padding: '8px 10px',
    border: '1px solid rgba(124, 158, 255, 0.18)',
    background: 'rgba(124, 158, 255, 0.06)',
    borderRadius: 6,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  detailsSummary: {
    fontSize: 11,
    color: 'rgba(230,235,245,0.6)',
    cursor: 'pointer',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    padding: '6px 0',
  },
  cssBlock: {
    margin: '6px 0',
    background: 'rgba(255,255,255,0.04)',
    padding: '8px 10px',
    borderRadius: 6,
    fontSize: 11,
    fontFamily: MONO,
    color: '#eaf0fb',
    overflowX: 'auto',
    maxHeight: 220,
    whiteSpace: 'pre',
  },
  secondaryButton: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 500,
    border: '1px solid rgba(255,255,255,0.1)',
    background: 'rgba(255,255,255,0.04)',
    color: '#eaf0fb',
    borderRadius: 5,
    cursor: 'pointer',
    width: 'fit-content',
    fontFamily: 'inherit',
  },
  secondaryButtonInline: {
    padding: '3px 9px',
    fontSize: 11,
    fontWeight: 500,
    border: '1px solid rgba(255,255,255,0.1)',
    background: 'rgba(255,255,255,0.04)',
    color: '#eaf0fb',
    borderRadius: 5,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  primaryButtonInline: {
    padding: '3px 9px',
    fontSize: 11,
    fontWeight: 600,
    border: '1px solid rgba(124, 158, 255, 0.3)',
    background: 'rgba(124, 158, 255, 0.18)',
    color: '#cfddff',
    borderRadius: 5,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  primaryButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 500,
    border: '1px solid rgba(124, 158, 255, 0.3)',
    background: 'rgba(124, 158, 255, 0.16)',
    color: '#cfddff',
    borderRadius: 7,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },

  /* ---- Box model ---- */
  boxModelWrap: { padding: 0, marginTop: 0 },
  boxModelLayer: {
    position: 'relative',
    borderRadius: 4,
  },
  boxModelMargin: {
    background: 'rgba(251, 191, 36, 0.14)',
    border: '1px solid rgba(251, 191, 36, 0.3)',
    padding: '20px 28px',
  },
  boxModelBorder: {
    background: 'rgba(148, 163, 184, 0.2)',
    border: '1px solid rgba(148, 163, 184, 0.35)',
    padding: '14px 22px',
  },
  boxModelPadding: {
    background: 'rgba(34, 197, 94, 0.14)',
    border: '1px solid rgba(34, 197, 94, 0.28)',
    padding: '14px 22px',
  },
  boxModelContent: {
    position: 'relative',
    background: 'rgba(59, 130, 246, 0.16)',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    padding: '10px 14px',
    borderRadius: 3,
    textAlign: 'center',
    fontSize: 12,
    fontFamily: MONO,
    fontWeight: 600,
    color: '#eaf0fb',
  },
  boxModelLabel: {
    position: 'absolute',
    top: 2,
    left: 4,
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'rgba(230,235,245,0.55)',
    fontWeight: 600,
  },
  boxModelTop: {
    position: 'absolute',
    top: 2,
    left: '50%',
    transform: 'translateX(-50%)',
    fontSize: 10,
    color: '#eaf0fb',
    fontFamily: MONO,
  },
  boxModelRight: {
    position: 'absolute',
    right: 4,
    top: '50%',
    transform: 'translateY(-50%)',
    fontSize: 10,
    color: '#eaf0fb',
    fontFamily: MONO,
  },
  boxModelBottom: {
    position: 'absolute',
    bottom: 2,
    left: '50%',
    transform: 'translateX(-50%)',
    fontSize: 10,
    color: '#eaf0fb',
    fontFamily: MONO,
  },
  boxModelLeft: {
    position: 'absolute',
    left: 4,
    top: '50%',
    transform: 'translateY(-50%)',
    fontSize: 10,
    color: '#eaf0fb',
    fontFamily: MONO,
  },

  /* ---- Component summary ---- */
  routePill: {
    fontSize: 10,
    color: '#7dd3fc',
    padding: '2px 6px',
    borderRadius: 999,
    background: 'rgba(56, 189, 248, 0.14)',
    border: '1px solid rgba(56, 189, 248, 0.32)',
    fontFamily: MONO,
    display: 'inline-block',
    width: 'fit-content',
    marginBottom: 10,
  },
  designModeHint: {
    background: 'rgba(124, 158, 255, 0.08)',
    border: '1px solid rgba(124, 158, 255, 0.18)',
    borderRadius: 8,
    padding: '11px 13px',
    fontSize: 12,
    lineHeight: 1.55,
    marginTop: 8,
    color: 'rgba(207,221,255,0.92)',
  },
  autoBadge: {
    fontSize: 9,
    color: '#7dd3fc',
    padding: '1px 6px',
    borderRadius: 3,
    background: 'rgba(56, 189, 248, 0.18)',
    border: '1px solid rgba(56, 189, 248, 0.32)',
    letterSpacing: 1,
    fontWeight: 600,
  },

  /* ---- Fixtures ---- */
  fixtureRow: {
    background: 'rgba(255,255,255,0.025)',
    border: '1px solid rgba(255,255,255,0.05)',
    borderRadius: 6,
    padding: '8px 10px',
  },
  fixtureSummary: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer',
    listStyle: 'none',
  },
  fixtureJson: {
    margin: '8px 0',
    background: 'rgba(0,0,0,0.25)',
    padding: '8px 10px',
    borderRadius: 6,
    fontSize: 11,
    fontFamily: MONO,
    color: '#eaf0fb',
    overflowX: 'auto',
    maxHeight: 200,
  },

  /* ---- Scenario pick row ---- */
  scenarioPickRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: '#eaf0fb',
    textAlign: 'left',
    width: '100%',
  },
  scenarioCheckRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 4px',
    cursor: 'pointer',
    color: '#eaf0fb',
  },

  /* ---- Related row ---- */
  relatedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '7px 9px',
    borderRadius: 6,
    background: 'rgba(255,255,255,0.025)',
    border: '1px solid rgba(255,255,255,0.04)',
    cursor: 'pointer',
    width: '100%',
    color: '#eaf0fb',
    textAlign: 'left',
    fontFamily: 'inherit',
  },
  relatedPath: {
    fontSize: 10.5,
    color: 'rgba(230,235,245,0.4)',
    fontFamily: MONO,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  /* ---- Flow ---- */
  flowRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '7px 9px',
    background: 'rgba(255,255,255,0.025)',
    border: '1px solid rgba(255,255,255,0.04)',
    borderRadius: 6,
    cursor: 'pointer',
    width: '100%',
    color: '#eaf0fb',
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  flowSubhead: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: 'rgba(230,235,245,0.5)',
    marginTop: 6,
    marginBottom: 4,
  },

  /* ---- Detail viewport / artboard ---- */
  detailViewport: {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    cursor: 'grab',
  },
  detailArtboard: {
    position: 'absolute',
    top: 0,
    left: 0,
    transformOrigin: '0 0',
    display: 'flex',
    flexDirection: 'column',
    gap: 56,
    padding: 32,
    width: 'max-content',
  },
  placeholderCentered: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  detailFixture: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  detailFixtureHeader: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
  },
  detailFixtureTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    fontFamily: MONO,
    color: '#fff',
  },
  detailFixtureDescription: {
    fontSize: 12,
    color: 'rgba(230,235,245,0.55)',
    maxWidth: 480,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  detailFrameRow: {
    display: 'flex',
    flexDirection: 'row',
    gap: 24,
    alignItems: 'flex-start',
    flexWrap: 'wrap',
  },
  detailFrameOuter: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  detailFrameOuterFullscreen: {
    position: 'fixed',
    inset: 0,
    background: '#0b1220',
    zIndex: 80,
    padding: 24,
    margin: 0,
  },
  detailFrameHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    color: 'rgba(230,235,245,0.55)',
    paddingLeft: 2,
  },
  detailFrameViewportLabel: {
    fontSize: 11,
    color: '#eaf0fb',
    fontWeight: 500,
  },
  detailFrameDims: {
    fontSize: 10,
    color: 'rgba(230,235,245,0.5)',
    fontFamily: MONO,
  },
  detailFrameIconButton: {
    width: 22,
    height: 22,
    border: 0,
    background: 'transparent',
    color: 'rgba(230,235,245,0.6)',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 13,
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  detailFrameShell: {
    position: 'relative',
    background: '#fff',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 6,
    overflow: 'hidden',
    boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
  },
  detailFrameIframe: {
    width: '100%',
    height: '100%',
    border: 0,
    background: '#fff',
    display: 'block',
  },
  detailFrameShimmer: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'rgba(0,0,0,0.35)',
    fontSize: 12,
    background: '#f8fafc',
    pointerEvents: 'none',
  },

  /* ---- Canvas hint ---- */
  canvasHint: {
    position: 'absolute',
    bottom: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    fontSize: 11,
    color: 'rgba(230,235,245,0.45)',
    background: 'rgba(10,15,26,0.5)',
    padding: '5px 12px',
    borderRadius: 99,
    border: '1px solid rgba(255,255,255,0.05)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    pointerEvents: 'none',
  },

  /* ---- Placeholder ---- */
  placeholderCard: {
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px dashed rgba(148, 163, 184, 0.32)',
    borderRadius: 8,
    padding: '20px 24px',
    color: '#eaf0fb',
    maxWidth: 520,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  placeholderHeading: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: '#fbbf24',
    fontWeight: 600,
  },
  placeholderBody: {
    margin: 0,
    color: 'rgba(230,235,245,0.55)',
    fontSize: 12,
    lineHeight: 1.6,
  },
  inlineCode: {
    background: 'rgba(148, 163, 184, 0.18)',
    color: 'inherit',
    padding: '0 5px',
    borderRadius: 3,
    fontFamily: MONO,
    fontSize: '0.95em',
  },

  /* ---- Empty canvas ---- */
  emptyCanvas: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#eaf0fb',
    textAlign: 'center',
    padding: 40,
    background: '#0a0f1a',
  },

  /* ---- Help overlay ---- */
  helpScrim: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(6, 10, 18, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1100,
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
  },
  helpModal: {
    width: 420,
    maxWidth: '90vw',
    background: '#11192a',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 12,
    overflow: 'hidden',
    boxShadow: '0 30px 80px rgba(0,0,0,0.55)',
  },
  helpHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '14px 18px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },

  /* ---- Loading / Error ---- */
  loadingScreen: {
    padding: 24,
    color: '#eaf0fb',
    background: '#070b15',
    width: '100vw',
    height: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif',
  },
  errorScreen: {
    padding: 24,
    color: '#fda4a4',
    background: '#070b15',
    font: '13px ui-monospace, Menlo, monospace',
    width: '100vw',
    height: '100vh',
    boxSizing: 'border-box',
    whiteSpace: 'pre-wrap',
  },
};
