import { describe, expect, it } from 'vitest';

import {
  VP_BODY_CSS,
  esc,
  fmtSignedMs,
  fmtSignedPct,
  fmtUtcDay,
  fmtUtcDayYear,
  fmtUtcMinute,
  isKnownStatus,
  pill,
  statusClassOf,
  statusGlyph,
  verdictClassOf,
} from './html-lib.js';

describe('esc', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(esc(`<a href="x" & 'y'>`)).toBe('&lt;a href=&quot;x&quot; &amp; &#39;y&#39;&gt;');
  });
});

describe('statusClassOf / statusGlyph (can-not-false-green)', () => {
  it('maps only the exact string "pass" to the pass class', () => {
    expect(statusClassOf('pass')).toBe('pass');
    expect(statusClassOf('fail')).toBe('fail');
    expect(statusClassOf('unverifiable')).toBe('unverifiable');
  });

  it('maps any unknown status to "unknown", never pass', () => {
    for (const s of ['passish', 'PASS', 'bogus', '', 'partial']) {
      expect(statusClassOf(s)).toBe('unknown');
    }
  });

  it('glyphs are shape-coded (not color-only)', () => {
    expect(statusGlyph('pass')).toBe('●');
    expect(statusGlyph('fail')).toBe('✕');
    expect(statusGlyph('unverifiable')).toBe('◌');
    expect(statusGlyph('whatever')).toBe('?');
  });
});

describe('verdictClassOf', () => {
  it('only exact pass earns pass; unknown falls through', () => {
    expect(verdictClassOf('pass')).toBe('pass');
    expect(verdictClassOf('fail')).toBe('fail');
    expect(verdictClassOf('partial')).toBe('partial');
    expect(verdictClassOf('passish')).toBe('unknown');
  });
});

describe('isKnownStatus', () => {
  it('recognizes only the three known statuses', () => {
    expect(isKnownStatus('pass')).toBe(true);
    expect(isKnownStatus('fail')).toBe(true);
    expect(isKnownStatus('unverifiable')).toBe(true);
    expect(isKnownStatus('bogus')).toBe(false);
  });
});

describe('pill', () => {
  it('escapes label and class and emits the color class', () => {
    const html = pill('<x>', 'pass');
    expect(html).toContain('vp-pill--pass');
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<x>');
  });
});

describe('fmtSignedMs / fmtSignedPct', () => {
  it('signs milliseconds', () => {
    expect(fmtSignedMs(12.4)).toBe('+12 ms');
    expect(fmtSignedMs(-3)).toBe('-3 ms');
    expect(fmtSignedMs(0)).toBe('0 ms');
  });
  it('signs percent and guards divide-by-zero', () => {
    expect(fmtSignedPct(100, 108)).toBe('+8%');
    expect(fmtSignedPct(100, 96)).toBe('-4%');
    expect(fmtSignedPct(0, 10)).toBeNull();
  });
});

describe('fmtUtcDay / fmtUtcDayYear / fmtUtcMinute', () => {
  it('formats in UTC, deterministic regardless of host locale', () => {
    expect(fmtUtcDay('2026-01-05T00:00:00.000Z')).toBe('Jan 5');
    expect(fmtUtcDayYear('2026-01-05T00:00:00.000Z')).toBe('Jan 5, 2026');
    expect(fmtUtcMinute('2026-01-05T14:32:00.000Z')).toBe('Jan 5, 14:32 UTC');
  });

  it('falls back to the raw string when unparseable', () => {
    expect(fmtUtcDay('not-a-date')).toBe('not-a-date');
  });
});

describe('VP_BODY_CSS (trends.html / compare.html body vocabulary)', () => {
  it('keeps the vp-* class names but resolves against @validity.ai/verify-report token names', () => {
    expect(VP_BODY_CSS).toContain('.vp-pill--pass');
    expect(VP_BODY_CSS).toContain('.vp-cell--pass');
    expect(VP_BODY_CSS).toContain('var(--grn)');
    expect(VP_BODY_CSS).toContain('var(--panel)');
    // never the old ad-hoc palette this replaced
    expect(VP_BODY_CSS).not.toContain('var(--pass)');
    expect(VP_BODY_CSS).not.toContain('var(--card-bg)');
    // no literal color or hardcoded font-stack — tokens only
    expect(VP_BODY_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
