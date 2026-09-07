/**
 * In-iframe inspector + theme-override module for `validity browse`.
 *
 * Runs inside the rendered component iframe. Idle by default — the
 * parent canvas posts `{ type: 'validity:inspect:enable' }` to turn it
 * on, and `{ type: 'validity:inspect:disable' }` to turn it off. While
 * verify runs, no enable message is sent and this module never touches
 * the page.
 *
 * Protocol (parent → iframe, posted via window.postMessage):
 *
 *   { type: 'validity:inspect:enable' }
 *   { type: 'validity:inspect:disable' }
 *   { type: 'validity:inspect:clear-selection' }
 *   { type: 'validity:theme:set', mode: 'light' | 'dark' | 'system' }
 *   { type: 'validity:ping' }
 *
 * (iframe → parent, posted on window.parent):
 *
 *   { type: 'validity:inspect:ready', frameId }
 *   { type: 'validity:inspect:hover', payload }        — throttled
 *   { type: 'validity:inspect:select', payload }       — on click
 *   { type: 'validity:inspect:distance', payload }     — alt-hover
 *   { type: 'validity:inspect:clear', frameId }
 *
 * `frameId` is the data-validity-frame attribute the parent passes on
 * the iframe element; the browse template reads it back to route the
 * message to the right frame (multiple iframes are open simultaneously,
 * each posts its own messages).
 *
 * Keeping this in a separate file (rather than inlining it into the
 * entry.tsx template literal) makes the inspector code readable and
 * lints/typechecks like real TypeScript instead of as a string.
 */
/// <reference lib="dom" />

interface ElementMetrics {
  tagName: string;
  id: string;
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
  /**
   * Project-relative path of the user component this element belongs to,
   * if we can detect one via React fiber's `_debugSource.fileName`. Used
   * by the parent to render a "Jump to <Component>" button.
   */
  componentPath?: string;
  /** Best-effort component display name. */
  componentName?: string;
  /** Computed-style snapshot (small subset that's useful to copy). */
  computedSnapshot: Array<{ property: string; value: string }>;
}

interface DistanceReport {
  /** Distance in CSS pixels. Negative means overlapping in that axis. */
  horizontal: number;
  vertical: number;
  /** Rects of both elements (for the parent to draw guide lines). */
  selectionRect: { x: number; y: number; width: number; height: number };
  hoverRect: { x: number; y: number; width: number; height: number };
}

const OVERLAY_ID = '__validity_inspector_overlay__';
const LABEL_ID = '__validity_inspector_label__';
const HOVER_OVERLAY_ID = '__validity_inspector_hover_overlay__';
const DISTANCE_OVERLAY_ID = '__validity_inspector_distance__';
const STYLE_ID = '__validity_inspector_style__';

let active = false;
let frameId = '';
let selectedEl: Element | null = null;
let lastHover: Element | null = null;
let mouseX = 0;
let mouseY = 0;
let altHeld = false;

// Throttle hover events to roughly 30 fps. Anything more than that
// floods the parent without visible benefit and slows down the iframe's
// own paint.
let hoverThrottleScheduled = false;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID}, #${HOVER_OVERLAY_ID}, #${DISTANCE_OVERLAY_ID} {
      position: fixed;
      pointer-events: none;
      z-index: 2147483646;
      box-sizing: border-box;
      transition: top 60ms ease-out, left 60ms ease-out,
                  width 60ms ease-out, height 60ms ease-out;
    }
    #${OVERLAY_ID} {
      border: 2px solid #3b82f6;
      background: rgba(59, 130, 246, 0.10);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4) inset;
    }
    #${HOVER_OVERLAY_ID} {
      border: 1px dashed rgba(59, 130, 246, 0.8);
      background: rgba(59, 130, 246, 0.06);
    }
    #${DISTANCE_OVERLAY_ID} {
      border: 0;
      background: transparent;
    }
    #${LABEL_ID} {
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      background: #3b82f6;
      color: #fff;
      padding: 2px 6px;
      font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      border-radius: 3px;
      white-space: nowrap;
      max-width: 90vw;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
  document.head.appendChild(style);
}

function removeOverlays(): void {
  for (const id of [OVERLAY_ID, HOVER_OVERLAY_ID, LABEL_ID, DISTANCE_OVERLAY_ID]) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
}

function setOverlay(id: string, rect: DOMRect | null): HTMLElement | null {
  if (!rect) {
    const existing = document.getElementById(id);
    if (existing) existing.remove();
    return null;
  }
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }
  el.style.left = rect.left + 'px';
  el.style.top = rect.top + 'px';
  el.style.width = rect.width + 'px';
  el.style.height = rect.height + 'px';
  return el;
}

function setLabel(text: string, rect: DOMRect | null): void {
  if (!rect) {
    const existing = document.getElementById(LABEL_ID);
    if (existing) existing.remove();
    return;
  }
  let el = document.getElementById(LABEL_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = LABEL_ID;
    document.body.appendChild(el);
  }
  el.textContent = text;
  // Position above the rect when there's room, otherwise inside.
  const top = rect.top > 24 ? rect.top - 22 : rect.top + 4;
  el.style.left = rect.left + 'px';
  el.style.top = top + 'px';
}

function pxToNumber(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Walk the React fiber tree up from a DOM node, looking for a fiber
 * whose `_debugSource.fileName` matches a known file. Returns the
 * deepest matching component (i.e., the LEAF component, not the root
 * App). Falls back to `null` when React's debug info isn't available
 * (production-only React or non-React DOM nodes).
 */
function findComponentForElement(el: Element): { path: string; name: string } | null {
  const node = el as unknown as Record<string, unknown>;
  // React 17+ stores the fiber under a randomly-named __reactFiber$xxxx key.
  // Find it by prefix scan.
  let fiberKey: string | null = null;
  for (const key of Object.keys(node)) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
      fiberKey = key;
      break;
    }
  }
  if (!fiberKey) return null;
  let fiber = node[fiberKey] as Record<string, unknown> | undefined;
  while (fiber) {
    const debugSource = fiber._debugSource as { fileName?: string } | undefined;
    const type = fiber.type as { displayName?: string; name?: string } | string | undefined;
    const isComponent =
      typeof type === 'function' ||
      (typeof type === 'object' && type !== null && ('displayName' in type || 'name' in type));
    if (isComponent && debugSource?.fileName) {
      const fileName = debugSource.fileName;
      const componentName =
        (typeof type === 'function'
          ? ((type as { displayName?: string; name?: string }).displayName ??
            (type as { displayName?: string; name?: string }).name)
          : ((type as { displayName?: string; name?: string }).displayName ??
            (type as { displayName?: string; name?: string }).name)) ?? 'Component';
      return { path: fileName, name: componentName };
    }
    fiber = fiber.return as Record<string, unknown> | undefined;
  }
  return null;
}

function readMetrics(el: Element): ElementMetrics {
  const rect = el.getBoundingClientRect();
  const cs = window.getComputedStyle(el);
  const component = findComponentForElement(el);
  // Curated computed-style snapshot — the same properties Chrome
  // DevTools surfaces by default, ordered for human scanning.
  const props = [
    'display',
    'position',
    'box-sizing',
    'width',
    'height',
    'min-width',
    'min-height',
    'max-width',
    'max-height',
    'margin',
    'padding',
    'border',
    'border-radius',
    'font',
    'color',
    'background',
    'opacity',
    'overflow',
    'flex',
    'gap',
    'grid-template-columns',
    'grid-template-rows',
    'z-index',
    'transform',
    'transition',
    'cursor',
  ];
  const computedSnapshot = props
    .map((p) => ({ property: p, value: cs.getPropertyValue(p).trim() }))
    .filter((kv) => kv.value !== '');

  return {
    tagName: el.tagName.toLowerCase(),
    id: (el as HTMLElement).id ?? '',
    classList: Array.from(el.classList),
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    padding: {
      top: pxToNumber(cs.paddingTop),
      right: pxToNumber(cs.paddingRight),
      bottom: pxToNumber(cs.paddingBottom),
      left: pxToNumber(cs.paddingLeft),
    },
    margin: {
      top: pxToNumber(cs.marginTop),
      right: pxToNumber(cs.marginRight),
      bottom: pxToNumber(cs.marginBottom),
      left: pxToNumber(cs.marginLeft),
    },
    border: {
      top: pxToNumber(cs.borderTopWidth),
      right: pxToNumber(cs.borderRightWidth),
      bottom: pxToNumber(cs.borderBottomWidth),
      left: pxToNumber(cs.borderLeftWidth),
    },
    font: {
      family: cs.fontFamily,
      size: cs.fontSize,
      weight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      color: cs.color,
    },
    background: cs.backgroundColor,
    display: cs.display,
    position: cs.position,
    opacity: cs.opacity,
    componentPath: component?.path,
    componentName: component?.name,
    computedSnapshot,
  };
}

function rectToPlain(rect: DOMRect): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function computeDistance(a: DOMRect, b: DOMRect): DistanceReport {
  // Horizontal gap: if rects don't overlap vertically, this is the
  // shortest horizontal distance between their nearest edges. We use a
  // signed value — negative means "the rects overlap in this axis".
  let horizontal: number;
  if (b.left >= a.right) horizontal = b.left - a.right;
  else if (a.left >= b.right) horizontal = a.left - b.right;
  else horizontal = -Math.min(a.right, b.right) + Math.max(a.left, b.left);

  let vertical: number;
  if (b.top >= a.bottom) vertical = b.top - a.bottom;
  else if (a.top >= b.bottom) vertical = a.top - b.bottom;
  else vertical = -Math.min(a.bottom, b.bottom) + Math.max(a.top, b.top);

  return {
    horizontal: Math.round(horizontal),
    vertical: Math.round(vertical),
    selectionRect: rectToPlain(a),
    hoverRect: rectToPlain(b),
  };
}

function postToParent(message: Record<string, unknown>): void {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ ...message, frameId }, '*');
  }
}

function elementFromPoint(x: number, y: number): Element | null {
  // Temporarily hide overlays so elementFromPoint returns the *actual*
  // element underneath. Otherwise the overlay catches it (since CSS
  // pointer-events: none is on the overlay div, but document.elementFromPoint
  // doesn't always honor that consistently across browsers — and the label
  // / hover overlay can shadow the underlying element). Cheap to toggle.
  const ids = [OVERLAY_ID, HOVER_OVERLAY_ID, LABEL_ID, DISTANCE_OVERLAY_ID];
  const hidden: Array<{ el: HTMLElement; prev: string }> = [];
  for (const id of ids) {
    const el = document.getElementById(id) as HTMLElement | null;
    if (el && el.style.display !== 'none') {
      hidden.push({ el, prev: el.style.display });
      el.style.display = 'none';
    }
  }
  const target = document.elementFromPoint(x, y);
  for (const { el, prev } of hidden) el.style.display = prev;
  return target;
}

function onMouseMove(e: MouseEvent): void {
  if (!active) return;
  mouseX = e.clientX;
  mouseY = e.clientY;
  altHeld = e.altKey;
  if (hoverThrottleScheduled) return;
  hoverThrottleScheduled = true;
  requestAnimationFrame(() => {
    hoverThrottleScheduled = false;
    const target = elementFromPoint(mouseX, mouseY);
    if (!target || target === lastHover) return;
    lastHover = target;
    const rect = target.getBoundingClientRect();
    setOverlay(HOVER_OVERLAY_ID, rect);
    setLabel(
      `${target.tagName.toLowerCase()} · ${Math.round(rect.width)}×${Math.round(rect.height)}`,
      rect,
    );
    if (altHeld && selectedEl && selectedEl !== target) {
      const sr = selectedEl.getBoundingClientRect();
      const distance = computeDistance(sr, rect);
      postToParent({ type: 'validity:inspect:distance', payload: distance });
    }
    postToParent({
      type: 'validity:inspect:hover',
      payload: readMetrics(target),
    });
  });
}

function onClick(e: MouseEvent): void {
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();
  const target = elementFromPoint(e.clientX, e.clientY);
  if (!target) return;
  selectedEl = target;
  const rect = target.getBoundingClientRect();
  setOverlay(OVERLAY_ID, rect);
  setLabel(
    `${target.tagName.toLowerCase()} · ${Math.round(rect.width)}×${Math.round(rect.height)}`,
    rect,
  );
  postToParent({
    type: 'validity:inspect:select',
    payload: readMetrics(target),
  });
}

/**
 * Forward wheel events to the parent canvas. Without this, panning /
 * pinch-zooming while the cursor is over an iframe falls into the
 * iframe's own scroll handler (or browser zoom on Cmd+wheel) and the
 * canvas-level pan/zoom appears to "die" in the middle of a drag.
 *
 * The iframe's own `iframe` element has `pointer-events: auto` so
 * the click-to-inspect path keeps working; this wheel handler lives
 * inside the iframe document and posts deltas up to the parent, which
 * applies them to the artboard transform.
 *
 * preventDefault is mandatory: without it, Cmd/Ctrl+wheel triggers
 * native browser zoom on the iframe contents, which fights the
 * canvas zoom.
 */
function onWheel(e: WheelEvent): void {
  // Zoom intent (pinch / Cmd/Ctrl+wheel) ALWAYS routes to the canvas — even
  // with the inspector off. Without this, pinching while the cursor happens
  // to be over a frame triggers native BROWSER zoom (the whole page, toolbar
  // included) instead of the artboard zoom. Plain wheel still only forwards
  // in Design mode, so normal mode keeps native scrolling inside a live
  // component.
  const zoomIntent = e.ctrlKey || e.metaKey;
  if (!active && !zoomIntent) return;
  // Don't fight an input/textarea/contenteditable inside the iframe
  // — if the user is typing/scrolling a real form, let them. (Zoom
  // intent is canvas-level and wins even there.)
  const target = e.target as HTMLElement | null;
  if (
    !zoomIntent &&
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  ) {
    return;
  }
  e.preventDefault();
  // The iframe's bounding rect lives in the parent — but the wheel
  // event coordinates are in the iframe's own viewport. The parent's
  // wheel handler needs both: the cursor's parent-viewport position
  // (for focal-point zoom) and the deltas. We can't compute the
  // parent-viewport position from inside the iframe directly; instead
  // the parent looks up the iframe's offsetLeft/Top via getBoundingClientRect
  // on receipt and adds our `iframeX`/`iframeY` (the cursor relative to
  // the iframe's own top-left).
  // Normalize line-mode deltas (Firefox + mouse wheel) to pixels so the
  // parent's zoom response is consistent across input devices.
  const deltaScale = e.deltaMode === 1 ? 16 : 1;
  postToParent({
    type: 'validity:inspect:wheel',
    deltaX: e.deltaX * deltaScale,
    deltaY: e.deltaY * deltaScale,
    ctrlKey: e.ctrlKey || e.metaKey,
    shiftKey: e.shiftKey,
    iframeX: e.clientX,
    iframeY: e.clientY,
  });
}

/**
 * Forward drag-pan-style mousedown to parent so dragging on empty space
 * inside an iframe (e.g., a screen's background area) pans the canvas.
 * We only forward middle-mouse (button 1) drags — left clicks remain
 * for selection. Middle-mouse pan is the design-tool standard
 * (Photoshop, Figma, etc.).
 */
function onMouseDownForward(e: MouseEvent): void {
  if (!active) return;
  if (e.button !== 1) return;
  e.preventDefault();
  postToParent({
    type: 'validity:inspect:pan-start',
    iframeX: e.clientX,
    iframeY: e.clientY,
  });
}

function onKey(e: KeyboardEvent): void {
  if (!active) return;
  if (e.key === 'Escape' && selectedEl) {
    clearSelection();
  }
  if (e.key === 'Alt' || e.altKey) altHeld = true;
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === 'Alt') altHeld = false;
}

function clearSelection(): void {
  selectedEl = null;
  removeOverlays();
  postToParent({ type: 'validity:inspect:clear' });
}

function enable(): void {
  if (active) return;
  active = true;
  ensureStyle();
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKeyUp, true);
  // Non-passive so preventDefault stops native browser zoom on
  // Cmd/Ctrl+wheel. Without this, the browser zooms the iframe page
  // contents and the canvas zoom appears broken.
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  document.addEventListener('mousedown', onMouseDownForward, true);
  postToParent({ type: 'validity:inspect:ready' });
}

function disable(): void {
  if (!active) return;
  active = false;
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('keyup', onKeyUp, true);
  document.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  document.removeEventListener('mousedown', onMouseDownForward, true);
  removeOverlays();
  selectedEl = null;
  lastHover = null;
}

/**
 * Apply a theme override to the page. Posts the iframe's color-scheme
 * via a manually-inserted <style> that flips `color-scheme` plus a
 * `data-validity-theme` attribute on <html>. Components that ship a
 * `@media (prefers-color-scheme: dark)` rule won't react (those queries
 * are user-agent driven), but anything tied to a CSS class or the
 * `color-scheme` property will. The 'system' mode removes the override.
 */
function setTheme(mode: 'light' | 'dark' | 'system'): void {
  let style = document.getElementById('__validity_theme_style__') as HTMLStyleElement | null;
  if (mode === 'system') {
    if (style) style.remove();
    document.documentElement.removeAttribute('data-validity-theme');
    document.documentElement.style.colorScheme = '';
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = '__validity_theme_style__';
    document.head.appendChild(style);
  }
  style.textContent = `:root { color-scheme: ${mode}; } html[data-validity-theme="${mode}"] { color-scheme: ${mode}; }`;
  document.documentElement.setAttribute('data-validity-theme', mode);
  document.documentElement.style.colorScheme = mode;
}

interface InspectMessage {
  type: string;
  frameId?: string;
  mode?: 'light' | 'dark' | 'system';
}

function onMessage(e: MessageEvent): void {
  const data = e.data as InspectMessage | null;
  if (!data || typeof data.type !== 'string') return;
  if (data.frameId) frameId = data.frameId;
  switch (data.type) {
    case 'validity:inspect:enable':
      enable();
      break;
    case 'validity:inspect:disable':
      disable();
      break;
    case 'validity:inspect:clear-selection':
      clearSelection();
      break;
    case 'validity:theme:set':
      if (data.mode) setTheme(data.mode);
      break;
    case 'validity:ping':
      postToParent({ type: 'validity:pong' });
      break;
  }
}

export function startValidityInspector(): void {
  // Only meaningful inside an iframe — verify mode runs the same entry
  // top-level, no parent, no listener wiring needed.
  if (typeof window === 'undefined') return;
  if (window.parent === window) return;
  window.addEventListener('message', onMessage);
  // Announce readiness so the parent can flush queued commands (enable +
  // theme typically arrive in the same tick the iframe loads).
  postToParent({ type: 'validity:inspect:ready' });
}
