/**
 * Page chrome: the document shell, the sticky brand/nav header, and the
 * theme toggle. Every surface uses these so the whole product reads as one
 * tool — the ACTUAL Validity wordmark on every page, the same nav grammar,
 * the same theme behavior.
 *
 * Scripts are progressive enhancement only: without JS the header still
 * renders (toggle stays hidden), theming follows the OS via
 * prefers-color-scheme, and every artifact stays readable from file://.
 */
import { BREAKPOINT_MOBILE, FONT_MONO, RADII, SHELL } from './tokens.js';
import { esc } from './html.js';
import { FONT_FACE_CSS } from './fonts.js';
import { tokenCss } from './tokens.js';
import { baseCss, componentCss } from './components.js';
import { CHART_CSS } from './charts.js';
import { WORDMARK_DARK_DATA_URI, WORDMARK_LIGHT_DATA_URI } from './wordmark-data.js';

export const THEME_STORAGE_KEY = 'validity-theme';

/**
 * Synchronous head script: honors a stored explicit theme choice before
 * first paint (no flash). Absent JS or storage, the attribute never appears
 * and prefers-color-scheme rules.
 */
export const themeBootScript = `(()=>{try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

/**
 * Toggle behavior: stamps data-theme, persists, and reveals the control
 * (it ships hidden so script-less rendering has no dead button).
 */
export const themeToggleScript = `(()=>{var b=document.querySelector('[data-theme-toggle]');if(!b)return;b.hidden=false;var K=${JSON.stringify(
  THEME_STORAGE_KEY,
)};var cur=()=>document.documentElement.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark');var paint=()=>{var t=cur();b.querySelector('[data-theme-label]').textContent=t;b.querySelector('[data-theme-dot]').style.background=t==='dark'?'transparent':'currentColor';};b.addEventListener('click',()=>{var next=cur()==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',next);try{localStorage.setItem(K,next);}catch(e){}paint();});paint();})();`;

/**
 * Reveals any `[data-served-link][hidden]` nav item (e.g. a "back to the
 * dashboard" link) ONLY when the document is actually served over http(s) —
 * mirrors report.html's `data-dashboard-link` up-link. A self-contained file
 * artifact is usually opened from `file://` or unpacked from a CI artifact,
 * where a root-relative `href="/"` resolves to nothing; the markup ships
 * `hidden` so file:// / CI stay inert and the output byte-deterministic.
 */
export const revealServedLinksScript = `(()=>{if(location.protocol!=='http:'&&location.protocol!=='https:')return;document.querySelectorAll('[data-served-link][hidden]').forEach(function(el){el.removeAttribute('hidden');});})();`;

/** Chrome-specific CSS (header, nav, toggle, footer). */
export function chromeCss(): string {
  return `
.v-top{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--bd);padding:0 var(--pad)}
.v-top-inner{max-width:${SHELL.page};margin:0 auto;display:flex;align-items:center;gap:24px;height:60px}
.v-top-inner--report{max-width:${SHELL.report}}
.v-brand{display:flex;align-items:center;flex:none}
.v-brand img{height:22px;display:block}
.v-brand .v-wm-light{display:none}
:root[data-theme="light"] .v-brand .v-wm-dark{display:none}
:root[data-theme="light"] .v-brand .v-wm-light{display:block}
@media (prefers-color-scheme: light){
  :root:not([data-theme]) .v-brand .v-wm-dark{display:none}
  :root:not([data-theme]) .v-brand .v-wm-light{display:block}
}
.v-nav{display:flex;gap:2px;margin-left:8px}
.v-nav a{padding:6px 12px;border-radius:${RADII.chip}px;font-size:13px;font-weight:500;color:var(--dim)}
.v-nav a:hover{color:var(--tx);text-decoration:none}
.v-nav a[aria-current]{color:var(--tx);background:var(--panel)}
.v-top-spacer{flex:1}
.v-live{display:var(--deskflex);align-items:center;gap:8px;font-family:${FONT_MONO};font-size:11px;color:var(--dim2)}
.v-live .v-live-dot{width:6px;height:6px;border-radius:50%;background:var(--grn)}
/* Never-false-green: the dot is green ONLY in the confirmed 'live' state. A
   page that has not connected yet (or whose watcher died) shows neutral/amber,
   so a script-less render can never imply a running watcher. */
.v-live[data-live-state="idle"] .v-live-dot{background:var(--dim2)}
.v-live[data-live-state="warn"] .v-live-dot{background:var(--amb)}
.v-live[data-live-state="warn"]{color:var(--amb)}
.v-themetoggle{display:flex;align-items:center;gap:7px;border:1px solid var(--bd);background:var(--panel);border-radius:${RADII.control}px;padding:6px 11px;cursor:pointer;font-size:12px;font-family:${FONT_MONO};color:var(--dim);flex:none}
.v-themetoggle:hover{border-color:var(--bd2);color:var(--tx)}
.v-themetoggle .v-theme-dot{width:9px;height:9px;border-radius:50%;border:1.5px solid currentColor}
/* Narrow chrome: the topbar GROWS A ROW rather than hiding destinations. The
   nav used to scroll inside itself, which cut "Trends" in half with no
   affordance saying more existed — a horizontal scroller with no scrollbar
   reads as a truncation bug. It now wraps onto its own full-width line under
   the wordmark, and the theme toggle drops to its dot (the button keeps its
   aria-label, so hiding the word costs no accessible name). The live pill is
   already desk-only. The body still never scrolls horizontally. */
@media (max-width:${BREAKPOINT_MOBILE}px){
  .v-top-inner{gap:10px 12px;height:auto;min-height:60px;padding:9px 0;flex-wrap:wrap}
  .v-nav{margin-left:0;order:3;flex:1 1 100%;min-width:0;flex-wrap:wrap}
  .v-nav a{padding:6px 9px}
  .v-top-spacer{display:none}
  .v-themetoggle{margin-left:auto;padding:6px 9px}
  .v-themetoggle [data-theme-label]{display:none}
}`;
}

/**
 * The ACTUAL Validity wordmark — theme-paired raster-in-SVG data URIs so it
 * renders offline, from file://, on every artifact. The dark-theme file is
 * shown on dark backgrounds and vice versa; CSS does the swap.
 */
export function wordmark(opts?: { href?: string }): string {
  const imgs =
    `<img class="v-wm-dark" src="${WORDMARK_DARK_DATA_URI}" alt="Validity"/>` +
    `<img class="v-wm-light" src="${WORDMARK_LIGHT_DATA_URI}" alt=""/>`;
  return opts?.href
    ? `<a class="v-brand" href="${esc(opts.href)}">${imgs}</a>`
    : `<span class="v-brand">${imgs}</span>`;
}

export interface NavItem {
  label: string;
  href: string;
  current?: boolean;
  /** For links revealed only when served over http(s) (report up-link). */
  attrs?: string;
}

export interface TopbarOptions {
  /** Brand link target; omit for non-navigable artifacts. */
  brandHref?: string;
  nav?: NavItem[];
  /**
   * Right-edge live status, e.g. `{ text: 'watching · 6 specs' }`.
   *
   * `state` drives the dot under the never-false-green rule: `live` (green) is
   * a CONFIRMED connection, `idle` (neutral) the honest server-render default,
   * `warn` (amber) a degraded watcher. Give an `id` when a client script needs
   * to repaint it — the element carries `data-live-state` for that.
   */
  live?: { text: string; id?: string; state?: 'live' | 'idle' | 'warn' };
  /** Include the (JS-revealed) theme toggle. Default true. */
  themeToggle?: boolean;
  /** Narrow report shell. */
  report?: boolean;
  /**
   * Show the Validity wordmark. Default true. `false` is for artifacts a
   * caller asked to be UNBRANDED (report.html's `brand: 'none'`) — the nav and
   * the rest of the chrome stay, because navigation is not branding.
   */
  brand?: boolean;
}

/** The sticky brand/nav header. */
export function topbar(opts: TopbarOptions = {}): string {
  const { brandHref, nav = [], live, themeToggle = true, report = false, brand = true } = opts;
  const navHtml = nav.length
    ? `<nav class="v-nav">${nav
        .map(
          (n) =>
            `<a href="${esc(n.href)}"${n.current ? ' aria-current="page"' : ''}${
              n.attrs ? ` ${n.attrs}` : ''
            }>${esc(n.label)}</a>`,
        )
        .join('')}</nav>`
    : '';
  const liveHtml = live
    ? `<div class="v-live"${live.id ? ` id="${esc(live.id)}"` : ''} data-live-state="${
        live.state ?? 'live'
      }" aria-live="polite"><span class="v-live-dot"></span><span data-live-text>${esc(
        live.text,
      )}</span></div>`
    : '';
  const toggleHtml = themeToggle
    ? `<button type="button" class="v-themetoggle" data-theme-toggle hidden title="Toggle theme" aria-label="Toggle theme"><span class="v-theme-dot" data-theme-dot></span><span data-theme-label>dark</span></button>`
    : '';
  const brandHtml = brand ? wordmark({ href: brandHref }) : '';
  return `<header class="v-top"><div class="v-top-inner${report ? ' v-top-inner--report' : ''}">${brandHtml}${navHtml}<div class="v-top-spacer"></div>${liveHtml}${toggleHtml}</div></header>`;
}

export interface PageShellOptions {
  title: string;
  /** Surface-specific CSS appended after the shared layers. */
  css?: string;
  /** Rendered topbar (chrome.topbar) or custom header HTML. */
  header?: string;
  /** Page body HTML (inside the shell container). */
  body: string;
  /** Narrow report shell. */
  report?: boolean;
  /** Extra <head> HTML (meta, inline data). */
  head?: string;
  /** Body-end scripts (progressive enhancement only). Joined verbatim. */
  scripts?: string[];
  /** Include theme boot + toggle scripts. Default true. */
  themed?: boolean;
}

/**
 * The full HTML document. Single-file and self-contained by construction:
 * fonts, tokens, component CSS, and the wordmark all inline; no external
 * requests anywhere.
 */
export function pageShell(opts: PageShellOptions): string {
  const { title, css = '', header = '', body, report = false, head = '', themed = true } = opts;
  const scripts = [...(themed ? [themeToggleScript] : []), ...(opts.scripts ?? [])];
  const styles = [FONT_FACE_CSS, tokenCss(), baseCss(), chromeCss(), componentCss(), CHART_CSS, css]
    .filter(Boolean)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="dark light"/>
<title>${esc(title)}</title>
${themed ? `<script>${themeBootScript}</script>\n` : ''}<style>
${styles}
</style>
${head}</head>
<body>
${header}
<main class="v-shell${report ? ' v-shell--report' : ''}">
${body}
</main>
${scripts.map((s) => `<script>${s}</script>`).join('\n')}
</body>
</html>
`;
}
