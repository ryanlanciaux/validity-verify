import { describe, expect, it } from 'vitest';
import { HEADING_ROLES, matchName, parseRegexLiteral, roleMatches } from './selector-match.js';

describe('parseRegexLiteral', () => {
  it('compiles a /pattern/flags literal', () => {
    const re = parseRegexLiteral('/^Toggle Theme/i');
    expect(re).toBeInstanceOf(RegExp);
    expect(re!.test('Toggle Theme: dark')).toBe(true);
    expect(re!.flags).toContain('i');
  });

  it('returns null for a plain string', () => {
    expect(parseRegexLiteral('Submit')).toBeNull();
  });

  it('does NOT treat a bare URL path as a regex', () => {
    // `/api/users` has trailing `users`, not a flags-only tail → literal.
    expect(parseRegexLiteral('/api/users')).toBeNull();
  });

  it('returns null for an uncompilable pattern (treated as literal)', () => {
    expect(parseRegexLiteral('/[/')).toBeNull();
  });
});

describe('matchName', () => {
  it('does a case-insensitive substring match by default', () => {
    expect(matchName('toggle theme', 'Toggle Theme: dark')).toBe(true);
    expect(matchName('Reset', 'Toggle Theme: dark')).toBe(false);
  });

  it('honours a /regex/ literal', () => {
    expect(matchName('/^Toggle Theme/', 'Toggle Theme: dark')).toBe(true);
    expect(matchName('/dark$/', 'Toggle Theme: dark')).toBe(true);
    expect(matchName('/^dark/', 'Toggle Theme: dark')).toBe(false);
  });
});

describe('roleMatches', () => {
  it('is strict equality for ordinary roles', () => {
    expect(roleMatches('button', 'button', true)).toBe(true);
    expect(roleMatches('button', 'text', true)).toBe(false);
  });

  it('treats heading/header/sectionheader as one class', () => {
    expect(HEADING_ROLES.has('header')).toBe(true);
    expect(roleMatches('heading', 'header', false)).toBe(true);
    expect(roleMatches('header', 'sectionheader', false)).toBe(true);
  });

  it('falls back to a text/generic node for a NAMED heading selector (iOS)', () => {
    expect(roleMatches('heading', 'statictext', true)).toBe(true);
    expect(roleMatches('heading', 'text', true)).toBe(true);
    // …but only with a name to anchor on.
    expect(roleMatches('heading', 'statictext', false)).toBe(false);
  });

  it("falls back to iOS's `other` bucket — the role a real RN heading surfaces as", () => {
    // Regression guard (dogfood 2026-07-27): a multi-line RN <Text preset=
    // "heading"> came through the agent-device snapshot as
    // `@e4 [other] "Your app, almost ready for launch!"`, so a `role: header`
    // criterion reported a false `unverifiable` telling the user to add an
    // accessible name the element already had.
    expect(roleMatches('header', 'other', true)).toBe(true);
    expect(roleMatches('heading', 'other', true)).toBe(true);
    // Still gated on a name to anchor on — an unnamed heading selector must not
    // sweep up every unclassified node on the screen.
    expect(roleMatches('header', 'other', false)).toBe(false);
  });

  it("falls back to Android's `group` bucket — the role a real RN heading surfaces as", () => {
    // Regression guard (dogfood 2026-07-29, emulator-5554): RN sets
    // `nodeInfo.isHeading = true` for accessibilityRole="header", but
    // agent-device 0.20.1 carries no heading flag and derives the role from the
    // Android view class, so an RN header <Text> (android.view.View) came
    // through as `@e26 [group] "Log In"`. spec-e221 AC-4's `role: header
    // name: "Log In"` passed on iOS 26 and was unverifiable on Android for
    // exactly this reason.
    expect(roleMatches('header', 'group', true)).toBe(true);
    expect(roleMatches('heading', 'group', true)).toBe(true);
    expect(roleMatches('sectionheader', 'group', true)).toBe(true);
    // Same name gate as every other fallback bucket.
    expect(roleMatches('header', 'group', false)).toBe(false);
  });

  it('never lets a non-heading role fall back to a text node', () => {
    expect(roleMatches('button', 'statictext', true)).toBe(false);
    // …including the new `other` bucket: `role: button` must stay strict.
    expect(roleMatches('button', 'other', true)).toBe(false);
    // …and `group`, so `role: button name: X` can never match Android's
    // labelled containers (a TextField wrapper surfaces as `[group] "Email"`).
    expect(roleMatches('button', 'group', true)).toBe(false);
  });
});
