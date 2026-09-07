/**
 * The shared component vocabulary — CSS + HTML-string helpers.
 *
 * Every Validity surface (report.html, trends/compare, the dashboard)
 * composes these instead of declaring its own panels, pills, tables, or
 * status colors. Class names carry a `v-` prefix. Visual values come from
 * the token custom properties only — no literals here, so restyling stays a
 * tokens.ts edit.
 *
 * Status is never hue-alone: every status color ships with its glyph or
 * uppercase word (see GLYPHS / statusTone in tokens.ts).
 */
import { FONT_MONO, FONT_SANS, GLYPHS, RADII, SHELL, statusTone, toneVars } from './tokens.js';
import { esc } from './html.js';

/** Base document CSS: reset, typography, links, selection, focus. */
export function baseCss(): string {
  return `*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font-family:${FONT_SANS};-webkit-font-smoothing:antialiased}
a{color:var(--blu);text-decoration:none}
a:hover{color:var(--tx);text-decoration:underline}
table{border-collapse:collapse}
:focus-visible{outline:2px solid var(--blu);outline-offset:2px}
.v-mono{font-family:${FONT_MONO}}
.v-desk{display:var(--desk)}
.v-deskflex{display:var(--deskflex)}
.v-mob{display:var(--mob)}`;
}

/**
 * Declaration blocks for the vocabulary's core recipes.
 *
 * `componentCss()` below is their only in-package consumer, but they are
 * exported so a surface carrying LEGACY hook class names (report.html's
 * `report-*` selectors, which tests and the embedded JS pin) can ALIAS those
 * hooks onto the shared recipe instead of re-declaring the visual values.
 * One copy of every recipe, in this file — that is the whole point.
 */
export const RECIPES = {
  /** Wash-background uppercase pill (`.v-pill`). */
  pill: `display:inline-block;font-family:${FONT_MONO};font-size:10.5px;font-weight:600;letter-spacing:.06em;padding:4px 9px;border-radius:${RADII.tag}px;text-transform:uppercase`,
  /** Denser pill (`.v-pill--sm`). */
  pillSmall: `padding:3px 8px`,
  /** Bordered mono chip (`.v-chip`). */
  chip: `display:inline-block;border:1px solid var(--bd);background:var(--panel);border-radius:${RADII.chip}px;padding:5px 10px;font-family:${FONT_MONO};font-size:11.5px;color:var(--dim);white-space:nowrap`,
  /** Unfilled framed chip (`.v-chip--frame`). */
  chipFrame: `border-color:var(--bd2);background:transparent;padding:4px 9px;font-size:11px`,
  /** Full-width note banner (`.v-banner`). */
  banner: `display:flex;align-items:center;gap:9px;border-radius:${RADII.block}px;padding:10px 16px;font-size:13px`,
  /** Attested banner — DASHED means unproven (`.v-banner--attested`). */
  bannerAttested: `border:1px dashed var(--grnbd);background:var(--grnbg)`,
  /** Bordered surface panel (`.v-panel`). */
  panel: `border:1px solid var(--bd);background:var(--panel);border-radius:${RADII.panel}px;padding:20px`,
  /** Uppercase mono eyebrow label (`.v-stat-label`). */
  eyebrow: `font-family:${FONT_MONO};font-size:10.5px;letter-spacing:.09em;color:var(--dim2);text-transform:uppercase`,
  /** Mono chrome caption (`.v-cap`). */
  cap: `font-family:${FONT_MONO};font-size:11px;color:var(--dim2)`,
} as const;

/** Component CSS. One string, deterministic, token-driven. */
export function componentCss(): string {
  return `
/* ---- shell + page scaffolding ---- */
.v-shell{max-width:${SHELL.page};margin:0 auto;padding:0 var(--pad)}
.v-shell--report{max-width:${SHELL.report}}
.v-pagehead{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:32px 0 20px}
.v-h1{font-size:var(--h1);font-weight:700;letter-spacing:-.02em}
.v-h1 .v-mono{font-weight:600}
.v-pagehead-sub{font-size:13px;color:var(--dim);margin-top:5px}
/* Wraps rather than squeezing: on a narrow viewport the caption drops to its
   own line instead of the title losing words. No breakpoint needed. */
.v-section-head{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:2px 14px;margin-top:32px}
.v-section-title{font-size:16px;font-weight:600}
.v-cap{${RECIPES.cap}}

/* ---- panels ---- */
.v-panel{${RECIPES.panel}}
.v-panel--pad22{padding:22px}
.v-panel--quiet{background:var(--panel2);padding:16px 20px}
.v-panel-title{font-size:14px;font-weight:600}
.v-cols{display:grid;grid-template-columns:var(--chartcols);gap:16px;margin-top:16px;align-items:start}

/* ---- hero stat grid ---- */
.v-statgrid{display:grid;grid-template-columns:var(--herocols);gap:1px;background:var(--bd);border:1px solid var(--bd);border-radius:${RADII.panel}px;overflow:hidden}
.v-stat{background:var(--panel);padding:20px 20px 18px}
.v-stat-label{${RECIPES.eyebrow}}
.v-stat-row{display:flex;align-items:baseline;gap:10px;margin-top:10px}
.v-stat-num{font-size:var(--heronum);font-weight:600;letter-spacing:-.035em;line-height:1}
.v-stat-suffix{font-size:14px;color:var(--dim2);font-weight:500}
.v-stat-note{display:flex;align-items:center;gap:7px;margin-top:12px}
.v-stat-trend{font-family:${FONT_MONO};font-size:12px;font-weight:600;white-space:nowrap}
.v-stat-sub{font-size:12px;color:var(--dim2)}
.v-stat-spark{display:var(--desk);margin-top:14px;height:26px}

/* ---- verdict hero ----
   The page's first answer. Cells are separated by the 1px --bd gap (the stat
   grid's signature), so the hero reads as one instrument, not three panels.
   The verdict cell's wash is EARNED: only the pass tone tints green. */
.v-hero{display:grid;grid-template-columns:var(--herolay);gap:1px;background:var(--bd);border:1px solid var(--bd);border-radius:${RADII.panel}px;overflow:hidden;margin-top:8px}
.v-hero-verdict{background:var(--panel);padding:22px 22px 20px;display:flex;flex-direction:column;gap:12px}
.v-hero-verdict--pass{background:var(--grnbg)}
.v-hero-verdict--fail{background:var(--redbg)}
.v-hero-verdict--warn{background:var(--ambbg)}
.v-hero-lockup{display:flex;align-items:center;gap:14px}
.v-hero-glyph{font-size:30px;line-height:1;flex:none}
.v-hero-word{font-size:var(--verdictnum);font-weight:600;letter-spacing:-.03em;line-height:1.05;margin-top:4px}
.v-hero-reason{margin:0;font-size:14px;line-height:1.5;color:var(--tx);text-wrap:pretty;max-width:52ch}
.v-hero-sub{font-family:${FONT_MONO};font-size:11.5px;color:var(--dim2);line-height:1.7;margin-top:auto;padding-top:4px;overflow-wrap:anywhere}
.v-hero-sub code{color:var(--dim)}
.v-hero-metrics{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--bd)}
/* A hero with no plottable history keeps one full-width numeral cell rather
   than a half-empty pair. */
.v-hero-metrics>.v-hero-cell:only-child{grid-column:1/-1}
.v-hero-cell{background:var(--panel);padding:20px 20px 18px;min-width:0;display:flex;flex-direction:column}
.v-hero-spark{margin-top:14px;height:44px;flex:1 1 auto;min-height:44px}
.v-hero-note{margin-top:12px}

/* ---- jump-off tiles ---- */
.v-tilegrid{display:grid;grid-template-columns:var(--tilecols);gap:10px;margin-top:12px}
.v-tile{display:flex;flex-direction:column;gap:10px;border:1px solid var(--bd);background:var(--panel);border-radius:${RADII.card}px;padding:15px 16px 14px;color:inherit;text-decoration:none;min-width:0}
a.v-tile:hover{border-color:var(--blubd);background:var(--panel2);text-decoration:none;color:inherit}
.v-tile-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.v-tile-go{font-family:${FONT_MONO};font-size:12px;color:var(--dim2)}
a.v-tile:hover .v-tile-go{color:var(--blu)}
.v-tile-row{display:flex;align-items:baseline;gap:7px}
.v-tile-num{font-size:30px;font-weight:600;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.v-tile-suffix{font-size:12.5px;color:var(--dim2);font-weight:500}
.v-tile-visual{height:10px;display:flex;align-items:center}
.v-tile-sub{font-size:12px;color:var(--dim);line-height:1.5;text-wrap:pretty}
.v-tile-foot{${RECIPES.cap};line-height:1.5;margin-top:auto}

/* ---- action cards ("what needs attention") ---- */
.v-actions{display:grid;grid-template-columns:var(--cardcols);gap:10px;margin-top:12px;list-style:none;padding:0}
.v-action{display:flex;gap:11px;align-items:flex-start;border:1px solid var(--bd);background:var(--panel);border-radius:${RADII.card}px;padding:13px 15px;color:inherit;text-decoration:none;min-width:0}
.v-action--fail{border-color:var(--redbd);background:var(--redbg)}
.v-action--warn{border-color:var(--ambbd);background:var(--ambbg)}
a.v-action:hover{border-color:var(--blubd);text-decoration:none;color:inherit}
.v-action-glyph{font-size:11px;line-height:18px;flex:none}
.v-action-main{min-width:0;flex:1 1 auto}
.v-action-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.v-action-kind{font-size:13px;font-weight:600}
.v-action-age{${RECIPES.cap};margin-left:auto;white-space:nowrap}
.v-action-loc{font-family:${FONT_MONO};font-size:11px;color:var(--dim2);overflow-wrap:anywhere}
.v-action-body{font-size:12.5px;color:var(--dim);margin-top:6px;line-height:1.5;text-wrap:pretty}
.v-action-quiet{border:1px solid var(--bd);background:var(--panel2);border-radius:${RADII.block}px;padding:13px 16px;margin-top:12px;font-size:13px;color:var(--dim);display:flex;align-items:center;gap:9px}
.v-action-quiet .v-action-glyph{line-height:1}

/* ---- card grid (spec cards) ---- */
.v-cardgrid{display:grid;grid-template-columns:var(--cardcols);gap:10px;margin-top:12px;align-items:start}
/* An expanded card owns the full row: the drawer is a reading surface, not a
   column. Failing cards ship open, so failures are also the widest thing here. */
.v-cardgrid>[open]{grid-column:1/-1}

/* ---- quiet meta strip (page footer chrome) ---- */
.v-strip{display:flex;flex-wrap:wrap;gap:6px 20px;align-items:baseline;border:1px solid var(--bd);background:var(--panel2);border-radius:${RADII.block}px;padding:12px 16px;margin-top:12px;font-family:${FONT_MONO};font-size:11.5px;color:var(--dim)}
.v-strip-item{display:flex;align-items:baseline;gap:8px;min-width:0}
.v-strip-k{${RECIPES.eyebrow}}
.v-strip-v{color:var(--tx);overflow-wrap:anywhere}
.v-strip code{color:var(--tx)}

/* ---- status vocabulary ---- */
.v-tone--pass{color:var(--grn)}
.v-tone--fail{color:var(--red)}
.v-tone--warn{color:var(--amb)}
.v-tone--neutral{color:var(--dim2)}
.v-dotstat{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600}
.v-dotstat .v-dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.v-pill{${RECIPES.pill}}
.v-pill--sm{${RECIPES.pillSmall}}
.v-pill--pass{background:var(--grnbg);color:var(--grn)}
.v-pill--fail{background:var(--redbg);color:var(--red)}
.v-pill--warn{background:var(--ambbg);color:var(--amb)}
.v-pill--info{background:var(--blubg);color:var(--blu)}
.v-pill--judge{background:var(--viobg);color:var(--vio)}
.v-pill--neutral{background:var(--panel2);color:var(--dim2)}
.v-chip{${RECIPES.chip}}
.v-chip--pass{border-color:var(--grnbd);background:var(--grnbg);color:var(--grn);font-weight:600}
.v-chip--warn{border-color:var(--ambbd);background:var(--ambbg);color:var(--amb);font-weight:600}
.v-chip--fail{border-color:var(--redbd);background:var(--redbg);color:var(--red);font-weight:600}
.v-chip--dashed{border-style:dashed}
.v-chip--frame{${RECIPES.chipFrame}}
.v-banner{${RECIPES.banner}}
.v-banner--attested{${RECIPES.bannerAttested}}

/* ---- tables (desktop) + cards (mobile) ---- */
.v-tablewrap{display:var(--desk);border:1px solid var(--bd);border-radius:${RADII.panel}px;overflow:hidden;margin-top:12px;background:var(--panel)}
.v-table{width:100%;font-size:13px}
.v-table thead tr{background:var(--panel2)}
.v-table th{text-align:left;padding:11px 16px;font-family:${FONT_MONO};font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim2);font-weight:500;border-bottom:1px solid var(--bd)}
.v-table th.v-num,.v-table td.v-num{text-align:right;white-space:nowrap}
.v-table td{padding:12px 16px;border-bottom:1px solid var(--bd)}
.v-table tbody tr:last-child td{border-bottom:0}
.v-table a.v-rowlink{font-family:${FONT_MONO};font-size:12px}
.v-table .v-cell-id{font-family:${FONT_MONO};font-size:12px;color:var(--blu)}
.v-table .v-cell-mono{font-family:${FONT_MONO};font-size:12px;color:var(--tx)}
.v-table .v-cell-dim{font-family:${FONT_MONO};font-size:12px;color:var(--dim)}
.v-table .v-cell-faint{font-family:${FONT_MONO};font-size:12px;color:var(--dim2)}
.v-table .v-cell-score{font-family:${FONT_MONO};font-size:12.5px;font-weight:600}
tr.v-row--link{cursor:pointer}
tr.v-row--link:hover{background:var(--panel2)}
.v-cards{display:var(--mob);margin-top:12px}
.v-card{border:1px solid var(--bd);background:var(--panel);border-radius:${RADII.panel}px;padding:14px 16px;margin-bottom:8px}
.v-card-top{display:flex;justify-content:space-between;align-items:center}
.v-card-row{display:flex;align-items:baseline;gap:14px;margin-top:10px}
.v-card-score{font-size:30px;font-weight:600;letter-spacing:-.03em}

/* ---- numerals: comparable numbers never jitter ---- */
.v-stat-num,.v-stat-trend,.v-cell-score,.v-card-score,.v-table td{font-variant-numeric:tabular-nums}

/* ---- key/value meta rows ---- */
.v-kv{display:flex;justify-content:space-between;gap:16px;padding:6px 0;font-family:${FONT_MONO};font-size:11.5px}
.v-kv-k{color:var(--dim2);letter-spacing:.06em;text-transform:uppercase;font-size:10.5px;padding-top:1px}
.v-kv-v{color:var(--tx)}

/* ---- cert stepper ---- */
.v-steps{display:flex;flex-direction:column;margin-top:20px}
.v-step{display:grid;grid-template-columns:20px 1fr auto;gap:14px;align-items:start}
.v-step-rail{display:flex;flex-direction:column;align-items:center;align-self:stretch}
.v-step-ring{width:15px;height:15px;border-radius:50%;border:2px solid var(--bd2);background:transparent;flex:none}
.v-step--done .v-step-ring{border-color:var(--grn);background:var(--grn)}
.v-step--next .v-step-ring{border-color:var(--amb)}
.v-step-line{width:2px;flex:1;min-height:24px;background:var(--bd2)}
.v-step--done .v-step-line{background:var(--grn)}
.v-step--last .v-step-line{background:transparent}
.v-step-body{padding-bottom:18px}
.v-step-title{font-size:13.5px;font-weight:600}
.v-step--future .v-step-title{color:var(--dim2)}
.v-step-text{font-size:12.5px;color:var(--dim);margin-top:4px;text-wrap:pretty}
.v-step-meta{${RECIPES.cap};padding-top:2px}

/* ---- signals ---- */
.v-signal{border:1px solid var(--bd);background:var(--panel2);border-radius:${RADII.block}px;padding:11px 13px}
.v-signal-head{display:flex;align-items:center;gap:9px}
.v-signal-dot{width:7px;height:7px;border-radius:50%;flex:none}
.v-signal-title{font-size:13px;font-weight:600}
.v-signal-age{${RECIPES.cap};margin-left:auto}
.v-signal-body{font-size:12.5px;color:var(--dim);margin-top:6px;text-wrap:pretty}

/* ---- criterion history strip ---- */
.v-hist{display:var(--deskflex);gap:3px}
.v-hist span{width:7px;height:22px;border-radius:${RADII.mark}px}
.v-hist--pass{background:var(--grn)}
.v-hist--fail{background:var(--red)}
.v-hist--unv{background:var(--dim2)}

/* ---- stacked ratio bars (tier breakdown / runs per spec) ---- */
.v-ratio{display:flex;height:10px;border-radius:5px;overflow:hidden;gap:2px}
.v-ratio--runs{height:16px;border-radius:${RADII.bar}px;background:var(--panel2)}
.v-legendrow{display:flex;align-items:center;gap:10px;font-size:13px}
.v-legend-swatch{width:8px;height:8px;border-radius:${RADII.mark}px;flex:none}
.v-legendrow .v-legend-count{font-family:${FONT_MONO};color:var(--dim)}
.v-legendrow .v-legend-pct{font-family:${FONT_MONO};color:var(--dim2);width:42px;text-align:right}
.v-barrow{display:grid;grid-template-columns:150px 1fr 60px;align-items:center;gap:14px;color:inherit;text-decoration:none}
.v-barrow:hover{opacity:.75;text-decoration:none;color:inherit}
.v-barrow .v-barrow-id{font-family:${FONT_MONO};font-size:12px;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.v-barrow .v-barrow-count{font-family:${FONT_MONO};font-size:12px;color:var(--dim);text-align:right;white-space:nowrap}

/* ---- breadcrumbs ---- */
.v-crumbs{display:flex;align-items:center;gap:8px;font-family:${FONT_MONO};font-size:12.5px}
.v-crumbs .v-crumb-sep{color:var(--dim2)}
.v-crumbs .v-crumb-here{color:var(--dim)}`;
}

export type Tone = ReturnType<typeof statusTone>;

/** Verdict word + colored dot, shape-doubled ("● Pass"). */
export function dotStatus(word: string, tone: Tone): string {
  return `<span class="v-dotstat v-tone--${tone}"><span class="v-dot"></span>${esc(word)}</span>`;
}

export type PillKind = 'pass' | 'fail' | 'warn' | 'info' | 'judge' | 'neutral';

/** Wash-background uppercase pill (verdicts, tiers, provenance). */
export function pill(
  label: string,
  kind: PillKind,
  opts?: { small?: boolean; title?: string },
): string {
  const cls = `v-pill v-pill--${kind}${opts?.small ? ' v-pill--sm' : ''}`;
  const title = opts?.title ? ` title="${esc(opts.title)}"` : '';
  return `<span class="${cls}"${title}>${esc(label)}</span>`;
}

/** Status → pill kind under the never-false-green rule. */
export function statusPillKind(status: string): PillKind {
  const tone = statusTone(status);
  return tone === 'neutral' ? 'neutral' : tone === 'warn' ? 'warn' : tone;
}

/**
 * Bordered mono chip (commit, branch, meta values). `tone` tints the frame —
 * pass is earned by real health only (never-false-green applies to callers).
 * `dashed` is the doubt treatment: a claim resting on evidence that went
 * stale, or on a score an agent attested rather than a machine proved.
 */
export function chip(
  label: string,
  opts?: {
    tone?: 'pass' | 'warn' | 'fail';
    frame?: boolean;
    dashed?: boolean;
    title?: string;
    attrs?: string;
  },
): string {
  const cls =
    `v-chip${opts?.tone ? ` v-chip--${opts.tone}` : ''}` +
    `${opts?.frame ? ' v-chip--frame' : ''}${opts?.dashed ? ' v-chip--dashed' : ''}`;
  const title = opts?.title ? ` title="${esc(opts.title)}"` : '';
  return `<span class="${cls}"${title}${opts?.attrs ? ` ${opts.attrs}` : ''}>${esc(label)}</span>`;
}

export interface StatCard {
  label: string;
  value: string;
  suffix?: string;
  tone?: Tone | 'text';
  trend?: { text: string; tone: Tone };
  sub?: string;
  /** Pre-rendered sparkline SVG (charts.sparkline). */
  spark?: string;
}

/** One cell of the hero stat grid. */
export function statCard(s: StatCard): string {
  const numClass = s.tone && s.tone !== 'text' ? ` v-tone--${s.tone}` : '';
  const parts = [
    `<div class="v-stat-label">${esc(s.label)}</div>`,
    `<div class="v-stat-row"><div class="v-stat-num${numClass}">${esc(s.value)}</div>${
      s.suffix ? `<div class="v-stat-suffix">${esc(s.suffix)}</div>` : ''
    }</div>`,
  ];
  if (s.trend || s.sub) {
    parts.push(
      `<div class="v-stat-note">${
        s.trend
          ? `<span class="v-stat-trend v-tone--${s.trend.tone}">${esc(s.trend.text)}</span>`
          : ''
      }${s.sub ? `<span class="v-stat-sub">${esc(s.sub)}</span>` : ''}</div>`,
    );
  }
  if (s.spark) parts.push(`<div class="v-stat-spark">${s.spark}</div>`);
  return `<div class="v-stat">${parts.join('')}</div>`;
}

/** The hero stat grid (1px-gap bordered cells). */
export function statGrid(cards: StatCard[]): string {
  return `<div class="v-statgrid">${cards.map(statCard).join('')}</div>`;
}

export interface VerdictHeroOptions {
  /** Shape half of the verdict — always travels with the word (GLYPHS). */
  glyph: string;
  /** The verdict word itself ("Healthy", "Failing", …). */
  word: string;
  /** Eyebrow above the word. */
  label: string;
  /**
   * Tone of the verdict. Only `pass` tints the cell green — callers must have
   * earned it (never-false-green is the caller's contract, `capTone`'s job).
   */
  tone: Tone;
  /** The ONE-LINE reason the verdict is what it is. Plain text; escaped here. */
  reason: string;
  /** Extra class on the reason line, for surface-specific test/anchor hooks. */
  reasonClass?: string;
  /** Pre-escaped HTML receipt line (observed-through sha, ages). */
  sub?: string;
  /** The headline numeral cell (Validity score). */
  score: StatCard;
  /** The trend cell: label + a pre-rendered sparkline + caption. */
  trend?: { label: string; spark: string; caption?: string };
}

/**
 * The verdict hero — the dashboard's first answer to "is my project OK?".
 *
 * Three cells sharing one 1px-ruled frame: the shape-doubled verdict with its
 * one-line reason and freshness receipt, the Validity-score numeral, and the
 * score trend. The verdict cell's wash is tone-driven and, per the
 * never-false-green rule, green ONLY for the `pass` tone.
 */
export function verdictHero(opts: VerdictHeroOptions): string {
  const wash = opts.tone === 'neutral' ? '' : ` v-hero-verdict--${opts.tone}`;
  const trendCell = opts.trend
    ? `<div class="v-hero-cell">` +
      `<div class="v-stat-label">${esc(opts.trend.label)}</div>` +
      `<div class="v-hero-spark">${opts.trend.spark}</div>` +
      (opts.trend.caption
        ? `<div class="v-cap v-hero-note">${esc(opts.trend.caption)}</div>`
        : '') +
      `</div>`
    : '';
  const s = opts.score;
  const numClass = s.tone && s.tone !== 'text' ? ` v-tone--${s.tone}` : '';
  const scoreCell =
    `<div class="v-hero-cell">` +
    `<div class="v-stat-label">${esc(s.label)}</div>` +
    `<div class="v-stat-row"><div class="v-stat-num${numClass}">${esc(s.value)}</div>` +
    (s.suffix ? `<div class="v-stat-suffix">${esc(s.suffix)}</div>` : '') +
    `</div>` +
    (s.trend || s.sub
      ? `<div class="v-stat-note v-hero-note">${
          s.trend
            ? `<span class="v-stat-trend v-tone--${s.trend.tone}">${esc(s.trend.text)}</span>`
            : ''
        }${s.sub ? `<span class="v-stat-sub">${esc(s.sub)}</span>` : ''}</div>`
      : '') +
    `</div>`;
  return (
    `<div class="v-hero">` +
    `<div class="v-hero-verdict${wash}">` +
    `<div class="v-hero-lockup">` +
    `<span class="v-hero-glyph v-tone--${opts.tone}" aria-hidden="true">${esc(opts.glyph)}</span>` +
    `<div><div class="v-stat-label">${esc(opts.label)}</div>` +
    `<div class="v-hero-word v-tone--${opts.tone}">${esc(opts.word)}</div></div>` +
    `</div>` +
    `<p class="v-hero-reason${opts.reasonClass ? ` ${opts.reasonClass}` : ''}">${esc(opts.reason)}</p>` +
    (opts.sub ? `<div class="v-hero-sub">${opts.sub}</div>` : '') +
    `</div>` +
    `<div class="v-hero-metrics">${scoreCell}${trendCell}</div>` +
    `</div>`
  );
}

export interface JumpTile {
  /** Uppercase eyebrow — what this tile counts. */
  label: string;
  value: string;
  suffix?: string;
  tone?: Tone | 'text';
  /** Pre-rendered ratioBar / sparkline / strip. Reserves its row when absent. */
  visual?: string;
  /** One readable line of breakdown. */
  sub?: string;
  /** Quiet mono tail (secondary counts). */
  foot?: string;
  /** Destination. A tile with nowhere to go renders as a plain div. */
  href?: string;
}

/**
 * The jump-off tile row: a number, a shape for its distribution, and one link
 * into the surface that explains it. Whole-tile links — a tile that goes
 * nowhere renders as a `<div>` so it never looks clickable.
 */
export function jumpTiles(tiles: JumpTile[]): string {
  const cells = tiles
    .map((t) => {
      const numClass = t.tone && t.tone !== 'text' ? ` v-tone--${t.tone}` : '';
      const inner =
        `<div class="v-tile-head"><span class="v-stat-label">${esc(t.label)}</span>` +
        (t.href ? `<span class="v-tile-go" aria-hidden="true">→</span>` : '') +
        `</div>` +
        `<div class="v-tile-row"><span class="v-tile-num${numClass}">${esc(t.value)}</span>` +
        (t.suffix ? `<span class="v-tile-suffix">${esc(t.suffix)}</span>` : '') +
        `</div>` +
        `<div class="v-tile-visual">${t.visual ?? ''}</div>` +
        (t.sub ? `<div class="v-tile-sub">${esc(t.sub)}</div>` : '') +
        (t.foot ? `<div class="v-tile-foot">${esc(t.foot)}</div>` : '');
      return t.href
        ? `<a class="v-tile" href="${esc(t.href)}">${inner}</a>`
        : `<div class="v-tile">${inner}</div>`;
    })
    .join('');
  return `<div class="v-tilegrid">${cells}</div>`;
}

/**
 * One "needs attention" card: a shape-doubled severity glyph, the signal kind,
 * its locator, age, and the one-line detail. Never pass-toned — an open signal
 * is never good news (`tone` is fail | warn | neutral by type).
 */
export function actionCard(opts: {
  glyph: string;
  tone: 'fail' | 'warn' | 'neutral';
  kind: string;
  /** Pre-escaped locator HTML (a `<code>` spec/criterion pair). */
  locator?: string;
  detail: string;
  age: string;
  href?: string;
  tag?: 'div' | 'li';
  attrs?: string;
}): string {
  const tag = opts.tag ?? 'div';
  const toneCls = opts.tone === 'neutral' ? '' : ` v-action--${opts.tone}`;
  const inner =
    `<span class="v-action-glyph v-tone--${opts.tone}" aria-hidden="true">${esc(opts.glyph)}</span>` +
    `<span class="v-action-main">` +
    `<span class="v-action-head"><span class="v-action-kind">${esc(opts.kind)}</span>` +
    (opts.locator ?? '') +
    `<span class="v-action-age">${esc(opts.age)}</span></span>` +
    `<span class="v-action-body">${esc(opts.detail)}</span>` +
    `</span>`;
  const body = opts.href
    ? `<a class="v-action${toneCls}" href="${esc(opts.href)}">${inner}</a>`
    : `<span class="v-action${toneCls}">${inner}</span>`;
  return tag === 'li'
    ? `<li${opts.attrs ? ` ${opts.attrs}` : ''}>${body}</li>`
    : `<div${opts.attrs ? ` ${opts.attrs}` : ''}>${body}</div>`;
}

/**
 * The quiet page-foot meta strip: mono key/value pairs on one line, wrapping
 * on narrow viewports. Values are PRE-ESCAPED HTML so callers can carry
 * `<code>`/`<time>` marks; keys are plain text.
 */
export function metaStrip(items: Array<{ k: string; v: string }>): string {
  const cells = items
    .map(
      (i) =>
        `<span class="v-strip-item"><span class="v-strip-k">${esc(i.k)}</span>` +
        `<span class="v-strip-v">${i.v}</span></span>`,
    )
    .join('');
  return `<div class="v-strip">${cells}</div>`;
}

export interface Crumb {
  label: string;
  /** In-page anchor or URL. Omit for a plain (non-navigable) crumb. */
  href?: string;
  /** The current location — rendered dim, never a link. */
  here?: boolean;
}

/**
 * Mono breadcrumb row. Static artifacts pass `href`-less crumbs so a page
 * opened from file:// never shows a dead link.
 */
export function crumbs(items: Crumb[]): string {
  const parts = items.map((c) =>
    c.href
      ? `<a href="${esc(c.href)}">${esc(c.label)}</a>`
      : `<span class="${c.here ? 'v-crumb-here' : ''}">${esc(c.label)}</span>`,
  );
  return `<div class="v-crumbs">${parts.join('<span class="v-crumb-sep">/</span>')}</div>`;
}

/** Criterion run-history strip: 'p' | 'f' | 'u' per run, oldest → newest. */
export function historyStrip(pattern: string, opts?: { ariaLabel?: string }): string {
  const cls: Record<string, string> = { p: 'v-hist--pass', f: 'v-hist--fail', u: 'v-hist--unv' };
  const bars = [...pattern]
    .map((ch) => `<span class="${cls[ch] ?? 'v-hist--unv'}"></span>`)
    .join('');
  const aria = opts?.ariaLabel ? ` role="img" aria-label="${esc(opts.ariaLabel)}"` : '';
  return `<div class="v-hist"${aria}>${bars}</div>`;
}

/**
 * One lane of a stacked ratio bar. `color` is a token expression (never a
 * literal); `width` is a CSS length/percentage the caller already rounded, so
 * the emitted string is byte-stable.
 */
export interface RatioSegment {
  width: string;
  color: string;
  /** Optional tooltip; the legend beside the bar carries the readable label. */
  title?: string;
}

/**
 * Stacked ratio bar (criteria tier breakdown, runs-per-spec lanes). Zero-width
 * segments are dropped so a lane with no members leaves no hairline artifact.
 * `runs` picks the taller, trough-backed variant used inside table-ish rows.
 */
export function ratioBar(segments: RatioSegment[], opts?: { runs?: boolean }): string {
  const lanes = segments
    .filter((s) => s.width !== '0%' && s.width !== '0')
    .map(
      (s) =>
        `<span style="width:${esc(s.width)};background:${esc(s.color)}"${
          s.title ? ` title="${esc(s.title)}"` : ''
        }></span>`,
    )
    .join('');
  return `<span class="v-ratio${opts?.runs ? ' v-ratio--runs' : ''}">${lanes}</span>`;
}

/** One legend line under a ratio bar: swatch, label, count, percentage. */
export interface LegendEntry {
  label: string;
  color: string;
  count: string;
  pct: string;
}

/** Legend rows for a {@link ratioBar}, in the bar's own segment order. */
export function legendRows(entries: LegendEntry[]): string {
  return entries
    .map(
      (e) =>
        `<div class="v-legendrow"><span class="v-legend-swatch" style="background:${esc(e.color)}"></span>` +
        `<span style="flex:1">${esc(e.label)}</span>` +
        `<span class="v-legend-count">${esc(e.count)}</span>` +
        `<span class="v-legend-pct">${esc(e.pct)}</span></div>`,
    )
    .join('');
}

/**
 * One "runs per spec" row: mono id, stacked lanes, trailing count. Renders as
 * an `<a>` when `href` is given (the whole row is the target) and a plain
 * `<div>` otherwise — a row that goes nowhere must not look clickable.
 */
export function barRow(opts: {
  id: string;
  segments: RatioSegment[];
  count: string;
  href?: string;
  title?: string;
}): string {
  const inner =
    `<span class="v-barrow-id">${esc(opts.id)}</span>` +
    ratioBar(opts.segments, { runs: true }) +
    `<span class="v-barrow-count">${esc(opts.count)}</span>`;
  const title = opts.title ? ` title="${esc(opts.title)}"` : '';
  return opts.href
    ? `<a class="v-barrow" href="${esc(opts.href)}"${title}>${inner}</a>`
    : `<div class="v-barrow"${title}>${inner}</div>`;
}

/**
 * A signal card: severity dot + title + age, then the body sentence. The dot
 * is tone-driven and NEVER pass-toned — an open signal is never good news, so
 * callers pass 'fail' | 'warn' | 'neutral'.
 */
export function signalCard(opts: {
  title: string;
  body: string;
  tone: 'fail' | 'warn' | 'neutral';
  age?: string;
  /** Element name — `li` when the card lives in a semantic list. */
  tag?: 'div' | 'li';
  /** Extra classes appended after `v-signal`. */
  className?: string;
  /** Extra attributes on the card element (ids, data hooks). */
  attrs?: string;
  /**
   * Pre-escaped HTML placed between the dot and the title — the shape half of
   * a shape-doubled severity (a glyph), so the dot's hue is never the only
   * carrier.
   */
  lead?: string;
  /** Trailing controls (ack/copy buttons) placed after the age. */
  actions?: string;
  /** Pre-escaped HTML appended after the body (locator links). */
  extra?: string;
}): string {
  const dot = toneVars(opts.tone).fg;
  const tag = opts.tag ?? 'div';
  const cls = `v-signal${opts.className ? ` ${opts.className}` : ''}`;
  return (
    `<${tag} class="${cls}"${opts.attrs ? ` ${opts.attrs}` : ''}>` +
    `<div class="v-signal-head">` +
    `<span class="v-signal-dot" style="background:${dot}"></span>` +
    (opts.lead ?? '') +
    `<span class="v-signal-title">${esc(opts.title)}</span>` +
    (opts.age
      ? `<span class="v-signal-age">${esc(opts.age)}</span>`
      : `<span style="flex:1"></span>`) +
    (opts.actions ?? '') +
    `</div>` +
    `<div class="v-signal-body">${esc(opts.body)}${opts.extra ?? ''}</div>` +
    `</${tag}>`
  );
}

/** One rung of the certification stepper. */
export interface Step {
  title: string;
  body: string;
  /** Right-edge metadata (an age, "pending", "—"). */
  meta?: string;
  /** done = earned, next = the one in progress, future = not started. */
  state: 'done' | 'next' | 'future';
}

/**
 * The certification stepper. `done` rungs fill green (earned evidence only —
 * callers must never mark a rung done on a projection), `next` rings amber,
 * `future` stays neutral; the rail's last connector is transparent.
 */
export function steps(items: Step[]): string {
  const rows = items
    .map((s, i) => {
      const last = i === items.length - 1 ? ' v-step--last' : '';
      return (
        `<div class="v-step v-step--${s.state}${last}">` +
        `<span class="v-step-rail"><span class="v-step-ring"></span><span class="v-step-line"></span></span>` +
        `<div class="v-step-body"><div class="v-step-title">${esc(s.title)}</div>` +
        `<div class="v-step-text">${esc(s.body)}</div></div>` +
        `<div class="v-step-meta">${esc(s.meta ?? '')}</div>` +
        `</div>`
      );
    })
    .join('');
  return `<div class="v-steps">${rows}</div>`;
}

/** Uppercase-key / value metadata rows (the spec detail's right column). */
export function kvRows(rows: Array<{ k: string; v: string }>): string {
  return rows
    .map(
      (r) =>
        `<div class="v-kv"><span class="v-kv-k">${esc(r.k)}</span><span class="v-kv-v">${esc(r.v)}</span></div>`,
    )
    .join('');
}

export { GLYPHS, statusTone, toneVars };
