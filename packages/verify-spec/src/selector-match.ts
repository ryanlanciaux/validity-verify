/**
 * Shared selector-matching helpers used by BOTH check executors (the web
 * Playwright sandbox and the native agent-device driver), so a spec `Selector`
 * means the same thing on both runtimes. The web side resolves selectors via
 * Playwright locators and only needs the regex-literal parser; the native side
 * matches against a parsed a11y snapshot and uses the full set.
 *
 * Two ideas live here:
 *
 *   1. **`/regex/flags` name literals.** A selector `name`/`text`/`label`/
 *      `placeholder` is normally a case-insensitive SUBSTRING match (an exact
 *      label is a substring of itself). A value wrapped in slashes — e.g.
 *      `name: "/^Toggle Theme/"` — is compiled to a real `RegExp` instead, so
 *      a dynamic/anchored label ("Toggle Theme: dark" today, "…: light"
 *      tomorrow) can be matched without encoding the volatile suffix. Both
 *      runtimes honour it (Playwright `getByRole`/`getByText` accept
 *      `string | RegExp`), so the convention is portable and needs no schema
 *      shape change — `name` stays a string.
 *
 *   2. **Heading role class + native text-node fallback.** Web (react-native-web +
 *      Playwright) exposes `accessibilityRole="header"` as a real ARIA
 *      `heading` role, so `role: "heading"` resolves. iOS's accessibility
 *      snapshot DROPS the header trait — a header comes through as a plain
 *      `text`/`statictext`/generic node — so strict role equality could never
 *      match it. `roleMatches` treats `heading`/`header`/`sectionheader` as one
 *      role class and, WHEN A NAME is present to anchor on, also accepts a
 *      named text/generic node as the iOS-degraded heading. A bare
 *      `role: heading` with no name stays unmatchable (you can't tell a header
 *      from arbitrary text without a name) — that remains an honest
 *      `unverifiable`. Non-heading roles keep strict equality, so
 *      `role: button name: X` never spuriously matches a text node. Android
 *      degrades the same way but into a different bucket (`group`), so the
 *      fallback set has to cover both platforms — see `TEXT_FALLBACK_ROLES`.
 */

/**
 * Parse a `/pattern/flags` string literal into a `RegExp`, or return `null`
 * when the value is a plain string (no surrounding slashes / not compilable).
 * Pure — safe to call on every selector field.
 */
export function parseRegexLiteral(value: string): RegExp | null {
  // Require a leading slash, at least one body char, a closing slash, then
  // only valid flag letters to EOL. A bare path like "/api/users" has no
  // trailing-flags-only tail (`users` isn't a flag run) so it won't match.
  const m = /^\/(.+)\/([a-z]*)$/is.exec(value);
  if (!m) return null;
  try {
    return new RegExp(m[1]!, m[2]);
  } catch {
    // An invalid pattern is treated as a literal string by callers.
    return null;
  }
}

/**
 * Match a single selector needle against an element's accessible name. A
 * `/regex/` literal compiles to a RegExp test; anything else is a
 * case-insensitive substring match (today's default — an exact label is a
 * substring of itself).
 */
export function matchName(needle: string, value: string): boolean {
  const re = parseRegexLiteral(needle);
  if (re) return re.test(value);
  return value.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Roles that mean "section heading" across the two runtimes. Web/ARIA says
 * `heading`; React Native says `header`; iOS sometimes surfaces
 * `sectionheader`. Treated as one interchangeable class.
 */
export const HEADING_ROLES = new Set(['heading', 'header', 'sectionheader']);

/**
 * Roles a native header degrades to in the agent-device a11y snapshot once the
 * header trait is dropped (plain text / generic / unlabelled node). A heading
 * selector that carries a name may fall back to matching one of these.
 *
 * `other` is agent-device's bucket for a LABELLED node it can't classify, and
 * it is what a multi-line RN `<Text>` heading actually surfaces as on iOS —
 * observed on a real device (dogfood 2026-07-27), where the welcome heading
 * came through as `@e4 [other] "Your app, almost ready for launch!"` while its
 * single-line siblings came through as `[text]`. Omitting it made a
 * `role: header` criterion report `unverifiable: no element … (add an
 * accessible name/testId)` for an element that HAD both a name and a testID —
 * a false durability finding blamed on the app. It belongs with `generic` /
 * `none` / `''`: same "unclassified node" class, and the fallback only ever
 * applies to a HEADING selector that also carries a name to anchor on.
 *
 * `group` is the SAME degradation on Android, and it is the whole reason a
 * `role: header` criterion could pass on iOS and be unverifiable on Android.
 * React Native does mark the node — `ReactAccessibilityDelegate.kt` sets
 * `nodeInfo.isHeading = true` for `accessibilityRole="header"` (RN 0.83) — but
 * agent-device 0.20.1 does not carry `isHeading` into either the text snapshot
 * or `--json` (node keys are index/type/label/value/identifier/bundleId/rect/
 * enabled/visibleToUser/depth/ref/parentIndex/hittable). The role is derived
 * from the Android view class instead, and RN renders a header `<Text>` as
 * `android.view.View`, which agent-device buckets as `group`. Measured on
 * emulator-5554 (2026-07-29): `login-heading` — an RN `<Text>` with
 * `accessibilityRole="header"` and a testID — came through as
 * `@e26 [group] "Log In"` on Android and as `[text]`/`[other]` on iOS 26.
 *
 * Widening to `group` costs precision: on Android a labelled CONTAINER is also
 * a `group` (e.g. a TextField wrapper surfaces as `@e28 [group] "Email"`), so
 * `role: header name: "Email"` can now match that container. That is the same
 * trade already accepted for `other`/`generic` — the fallback is gated on a
 * heading selector that carries a name — and it is preferred over the previous
 * behaviour, which told the author to "add an accessible name/testId" to an
 * element that already had both. Drop `group` again once agent-device exposes
 * the Android heading flag.
 *
 * RE-VERIFY on 0.20.5: its selector grammar documents `role=heading` (help
 * workflow), but the degradation above is about what Android SNAPSHOTS carry
 * for an RN header `<Text>`, which only an on-device measurement can answer —
 * the key-list cited from 0.20.1 needs re-reading on 0.20.5 before dropping
 * the fallback.
 */
export const TEXT_FALLBACK_ROLES = new Set([
  'text',
  'statictext',
  'label',
  'generic',
  'group',
  'none',
  'other',
  '',
]);

/**
 * Does an element role satisfy a selector role? `selRole`/`elRole` are compared
 * case-insensitively. Heading roles match each other, and — only when the
 * selector also has a name to anchor on (`hasName`) — a text/generic node, to
 * heal the iOS dropped-header-trait case. Every other role is strict equality.
 */
export function roleMatches(selRole: string, elRole: string, hasName: boolean): boolean {
  const sel = selRole.toLowerCase();
  const el = elRole.toLowerCase();
  if (HEADING_ROLES.has(sel)) {
    if (HEADING_ROLES.has(el)) return true;
    return hasName && TEXT_FALLBACK_ROLES.has(el);
  }
  return el === sel;
}
