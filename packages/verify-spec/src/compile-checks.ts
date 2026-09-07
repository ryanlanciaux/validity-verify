/**
 * NL → checks compiler. Turns a natural-language acceptance criterion into
 * deterministic, executable `checks[]` where it safely can, and leaves
 * everything else `soft`.
 *
 * THERE IS NO LLM HERE (by design — Validity has no model inside it). This is a
 * conservative, deterministic pattern matcher. Two consequences fall out of
 * "no LLM + text only":
 *
 *  1. The field/button NAMES needed to DRIVE an interaction (fill/click) are
 *     almost never present in the criterion text, so the compiler does NOT
 *     fabricate interaction steps. It compiles the shapes that are observable on
 *     the base render: the console-error invariant, element presence/absence,
 *     and a load-performance budget. Interaction-gated network assertions stay
 *     `soft` unless BOTH a URL and a trigger are explicit (rare) — emitting an
 *     unreachable network check would only ever resolve `unverifiable` and drag
 *     the coverage ratio down.
 *
 *  2. **Demote by default.** Gate integrity beats coverage: when intent is
 *     ambiguous, negated, or conditional (so the pass-semantics of a naive
 *     check would be INVERTED — "cannot submit", "disabled until valid"), the
 *     criterion stays `soft`. A false `soft` is harmless; a false `hard` could
 *     false-green. The executor is the second safety net — a selector that
 *     doesn't resolve yields `unverifiable`, never a pass.
 *
 * The host agent can always promote a criterion the matcher left soft by
 * supplying explicit `checks` via `validity__spec_update`.
 */
import type { AcceptanceCriterion } from './types.js';
import {
  CHECK_TIMEOUT_MS,
  isExpectCheck,
  type Check,
  type DataState,
  type MockingMode,
  type SpecCriterion,
} from './spec-schema.js';

/**
 * Contract version for the compiler. Bumped when the compilation RULES change
 * in a way that alters the mechanical bar. Stamped onto a spec's
 * `source.compiledWith` (and thus into its content hash) so a spec compiled
 * under one version is never silently re-judged under another.
 *
 * Note: verify runs a spec's FROZEN `checks` — it never re-compiles — so an
 * already-frozen spec's bar can't drift when this version bumps. The stamp is
 * provenance + hash-differentiation for NEWLY compiled specs; surfacing a
 * "compiled under an older version" notice in `doctor`/`spec_review` is a
 * documented follow-up.
 */
export const CHECK_COMPILER_VERSION = '4';

export interface CompiledCriterion {
  tier: 'hard' | 'soft';
  checks?: Check[];
  mocking?: MockingMode;
  /**
   * Data-state condition detected from the criterion text (A2) — stamped on
   * BOTH tiers (a soft "the empty state feels friendly" wants scoring against
   * a real empty render just as much as a hard Shape C check does).
   */
  dataState?: DataState;
}

/* ------------------------------------------------------------------ *
 * Guards — when in doubt, stay soft.                                  *
 * ------------------------------------------------------------------ */

/**
 * Words that invert or condition the pass-semantics. A naive presence/network
 * check on these would assert the OPPOSITE of intent (e.g. "cannot submit"),
 * so we refuse to compile and leave the criterion soft. The console/empty
 * shapes below handle their own "no ..." phrasing explicitly BEFORE this guard
 * runs, so they're unaffected.
 */
const INTENT_FLIPPERS =
  /\b(cannot|can'?t|unless|until|without|only\s+if|do(?:es)?n'?t|never|shouldn'?t|won'?t|prevent(?:s|ed)?|block(?:s|ed)?\s+from|requires\b[^.]*\bbefore)\b/i;

/**
 * Interaction-gated phrasing: the asserted element only appears AFTER a user
 * action ("shown after submitting", "modal opens on click", "error on invalid
 * input"). The compiler can't synthesize the triggering interaction, so on the
 * base render the element isn't present — a `visible` assertion there would
 * resolve `unverifiable` (never a pass, but wasted coverage). Demote such
 * PRESENCE criteria to soft. Note: empty-state ABSENCE ("no results when empty")
 * is reachable on the default render and is handled before this guard, so it is
 * unaffected.
 */
const INTERACTION_GATED =
  /\b(?:after|on|upon|when|once|whenever)\s+(?:the\s+)?(?:user\s+)?(?:\w+\s+){0,2}(clicks?|taps?|presses?|submits?|submitting|types?|typing|hovers?|selects?|enters?|opens?|closes?|focus(?:es)?|navigat\w+)\b|\bon\s+(?:click|submit|hover|focus|blur|change|tap|press|invalid|valid)\b|\b(clicking|tapping|typing|submitting|hovering|selecting|pressing)\b|\bafter\s+\w+ing\b/i;

/** Purely aesthetic / judgement language — always soft (B0 §3). */
const AESTHETIC =
  /\b(polished|on-?brand|beautiful|clean|elegant|modern|professional|trustworthy|intuitive|friendly|delightful|aesthetic|looks?\s+good|feels?\b|visually|nice|pleasant|calm|uncluttered|breathable|consistent\s+with|matches?\s+the\s+design|color|colour|smooth|animation|transition)\b/i;

/* ------------------------------------------------------------------ *
 * Small extractors.                                                   *
 * ------------------------------------------------------------------ */

/** Accessible role keywords → ARIA role. Order matters (longer phrases first). */
const ROLE_PATTERNS: Array<[RegExp, string]> = [
  [
    /\b(success\s+(?:messages?|confirmation|banner)|confirmation\s+messages?|toast|notification|status\s+messages?)\b/i,
    'status',
  ],
  [/\b(error\s+messages?|alert|warning\s+messages?)\b/i, 'alert'],
  [/\b(modal|dialog|popup|pop-?over)\b/i, 'dialog'],
  [/\b(heading|title|header)\b/i, 'heading'],
  [/\b(button|cta|call[-\s]to[-\s]action)\b/i, 'button'],
  [/\b(link|anchor)\b/i, 'link'],
  [/\b(checkbox|toggle|switch)\b/i, 'checkbox'],
  [/\b(text\s?box|input\s+field|text\s+field|input)\b/i, 'textbox'],
  [/\b(image|img|icon|avatar|logo)\b/i, 'img'],
  [/\b(table|grid)\b/i, 'table'],
  [/\b(list)\b/i, 'list'],
  [/\b(row)\b/i, 'row'],
  [/\b(tab)\b/i, 'tab'],
];

/** First double/single-quoted phrase, used as an accessible name when present. */
function quotedName(text: string): { value: string; index: number } | undefined {
  const m = /["“'']([^"”'']{1,60})["”'']/.exec(text);
  return m ? { value: m[1]!.trim(), index: m.index } : undefined;
}

/**
 * A quoted test id introduced by "testId" / "testID" / "test id" /
 * "data-testid", optionally with an `=`/`:`/"of"/"is" connective. Quote class
 * mirrors `quotedName`'s (straight/curly) plus backtick — agents often write
 * criteria with backticked ids. Must be extracted BEFORE `quotedName`: the
 * first quoted phrase in such a criterion is the testId VALUE, and misfiling
 * it as an accessible name yields a name-only selector no executor can use.
 */
const TESTID_RE = /\b(?:data-)?test[-\s]?id\b\s*(?:of|=|:|is)?\s*["“”'`]([^"“”'`]{1,80})["“”'`]/i;
function testIdFor(text: string): { value: string; index: number } | undefined {
  const m = TESTID_RE.exec(text);
  if (!m) return undefined;
  // Group 1 is the id VALUE. The match ends with `<value><closing-quote>`, so
  // the value's first char sits one closing quote (1 char) plus its own length
  // back from the match end — that index feeds the exemplar lookback below.
  const index = m.index + m[0].length - 1 - m[1]!.length;
  return { value: m[1]!.trim(), index };
}

/**
 * Exemplar guard (B7 §2). A quoted literal that merely ILLUSTRATES the shape of
 * content — "the badge shows the remaining count, e.g. \"2 left\"" — is not a
 * contract on that exact string. Asserting `name: "2 left"` against a live
 * render false-greens (the live value is "5 left", "1 of 3 done · 33%", ...).
 * Detect an exemplar marker ("e.g.", "for example", "such as", "like", ...)
 * within ~30 chars preceding the literal, allowing a short bridge of
 * comma/colon/space/opening-quote/paren between the marker and the literal so
 * "e.g., \"2 left\"" and "such as: (\"1 of 3 done\")" both qualify. Pure.
 *
 * `literalIndex` is the index of the literal's first character (the opening
 * quote or the value itself) in `text`. Returns true when the literal is an
 * exemplar and so must NOT become an exact `name:`/`testId:` assertion.
 */
// Markers ending in a word char get a trailing `\b`; "e.g."/"eg." end in a dot
// (non-word) so a `\b` after them would NOT fire before a space — hence no
// trailing `\b` on those. Leading `\b` on every marker so "alike" can't match.
const EXEMPLAR_TAIL =
  /(?:\be\.g\.|\beg\.|\bfor\s+example\b|\bfor\s+instance\b|\bsuch\s+as\b|\blike\b)[\s,:"“'`()—-]{0,10}$/i;
function isExemplarLiteral(text: string, literalIndex: number): boolean {
  const start = Math.max(0, literalIndex - 30);
  return EXEMPLAR_TAIL.test(text.slice(start, literalIndex));
}

function roleFor(text: string): string | undefined {
  for (const [re, role] of ROLE_PATTERNS) if (re.test(text)) return role;
  return undefined;
}

/** A bare HTTP path (e.g. /api/contact), optionally prefixed by a METHOD. */
function networkFor(text: string): { method?: string; url: string } | undefined {
  // METHOD optionally pluralized ("POSTs"), optionally with a connective
  // ("to"/"request to"/"call to") before the path: "POST /x", "POSTs to /x".
  const withMethod =
    /\b(GET|POST|PUT|PATCH|DELETE)(?:s|es)?\b(?:\s+(?:a\s+|the\s+)?(?:request|call)?\s*(?:to|at)?)?\s+(\/[\w\-./:]+)/i.exec(
      text,
    );
  if (withMethod) {
    return { method: withMethod[1]!.toUpperCase(), url: stripTrailingPunct(withMethod[2]!) };
  }
  const bare = /(?:^|\s)(\/(?:api|graphql|v\d)[\w\-./:]*)/i.exec(text);
  if (bare) return { url: stripTrailingPunct(bare[1]!) };
  return undefined;
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[).,;:]+$/, '');
}

/* ------------------------------------------------------------------ *
 * Data-state detection (A2).                                          *
 * ------------------------------------------------------------------ */

const DS_EMPTY =
  /\bempty[\s-]state\b|\bno\s+(results?|items?|matches?|data|records?|entries)\b(?:\s+found)?|\bnothing\s+to\s+(show|display)\b|\bzero\s+(results?|items?)\b|\bwhen\s+(?:the\s+)?(list|data|results?|inbox|feed)\s+is\s+empty\b/i;
const DS_LOADING =
  /\bskeleton\b|\bspinner\b|\bloading\s+(state|indicator|placeholder|screen|view)\b|\bwhile\s+(?:\w+\s+)?(?:is\s+)?loading\b|\bis\s+loading\b|\bshimmer\b/i;
const DS_ERROR =
  /\berror[\s-]state\b|\bfails?\s+to\s+load\b|\bload(?:ing)?\s+fails?\b|\bfetch(?:ing)?\s+fails?\b|\brequest\s+fails?\b|\b(network|server|api)\s+error\b|\b5\d\d\b|\bwhen\s+the\s+(api|server|request|fetch)\s+(errors?|fails?|is\s+down)\b/i;

/**
 * Detect which forced data state a criterion's text is about, if any.
 * Conservative patterns; one state per criterion by FIXED precedence
 * loading > empty > error ("skeleton while loading, then no-results if empty"
 * is really two criteria — spec_review nudges the split). `error` requires
 * fetch/server/network context AND is suppressed under INTERACTION_GATED so
 * form-validation text ("error after submitting an invalid email") never
 * forces a fetch-error render. Pure — unit-tested directly.
 */
export function detectDataState(text: string): DataState | undefined {
  if (DS_LOADING.test(text)) return 'loading';
  if (DS_EMPTY.test(text)) return 'empty';
  if (DS_ERROR.test(text) && !INTERACTION_GATED.test(text)) return 'error';
  return undefined;
}

/* ------------------------------------------------------------------ *
 * The compiler.                                                       *
 * ------------------------------------------------------------------ */

/**
 * Compile ONE criterion. Returns `{ tier: 'soft' }` whenever it cannot safely
 * prove the criterion mechanically. Never throws.
 */
export function compileCriterion(
  text: string,
  observable?: AcceptanceCriterion['observable'],
): CompiledCriterion {
  const t = text.trim();

  // Data-state condition (A2) — detected BEFORE the aesthetic bail so soft
  // criteria carry it too ("the empty state feels friendly" is scored against
  // a real forced-empty render, not the populated one).
  const dataState = detectDataState(t);

  // Console-error invariant detection (B0 Shape D) — computed UP FRONT, before
  // the aesthetic bail, because "the console is clean" trips AESTHETIC on the
  // word "clean" yet is a stable, observable console check (not a judgement) and
  // must survive the bail (B7 §3).
  //
  // ROOT-CAUSE NOTE (B7 §3): the optional `(console\s+)?` in the old regex let a
  // bare "no errors" (no "console") trigger a console check, so a command
  // criterion phrased "...exits 0 with no errors" mis-compiled to `expect.console`
  // instead of routing to `expect.command`. Console checks now REQUIRE the word
  // "console" (or the `observable: 'console'` hint) — "no console errors",
  // "console is clean", "zero console errors", "console-free". A bare "no errors"
  // is too ambiguous to assert against the console channel specifically.
  const wantsNoConsole =
    /\bno\s+console\s+errors?\b/i.test(t) ||
    /\bwithout\s+console\s+errors?\b/i.test(t) ||
    /\bconsole[-\s]free\b/i.test(t) ||
    /\bconsole\s+is\s+clean\b/i.test(t) ||
    /\bzero\s+console\s+errors?\b/i.test(t) ||
    (/\berror[-\s]free\b/i.test(t) && /\bconsole\b/i.test(t)) ||
    observable === 'console';

  // Aesthetic / judgement language is ALWAYS soft (B0 §3) — bail before any
  // compilation so an aesthetic sentence that happens to contain a checkable
  // noun ("the empty state feels friendly") can never sprout a hard check. The
  // ONE exception is an explicit console invariant ("the console is clean"):
  // its "clean" trips AESTHETIC but the check is a real Shape-D observable, so
  // emit that check alone and stay otherwise soft.
  if (AESTHETIC.test(t)) {
    return wantsNoConsole
      ? { tier: 'hard', checks: [{ expect: { console: { errors: 0 } } }], dataState }
      : { tier: 'soft', dataState };
  }

  const checks: Check[] = [];

  // --- Run-level command criterion (A5): "the named command typecheck exits 0",
  // "command `lint` exits with code 0". Tried BEFORE every render-level shape
  // (console/absence/presence/network) because a command criterion is RUN-LEVEL,
  // not render-level: by the no-mixing refine a command criterion must be
  // command-ONLY, so once it matches we return a single-check hard criterion and
  // skip the render shapes entirely (a command criterion saying ".. exits 0"
  // must never also mint a console/element check). Compiled to `hard` per the
  // existing compiler policy (checks present ⇒ hard); `buildRepoTypecheckCriterion`
  // dedupes against a compiled `run: 'typecheck'` via its `alreadyChecked` guard.
  const cmd = compileCommand(t);
  if (cmd) return { tier: 'hard', checks: [cmd], dataState };

  // --- Console-error invariant (B0 Shape D). `wantsNoConsole` was detected
  // above the aesthetic bail (a console invariant is a stable observable, not a
  // judgement); the check is APPENDED LAST (below) so it pairs with whatever
  // substantive shape this criterion also carries. Its "no" is not an intent
  // flip, so it is exempt from the flip guard.

  // --- Performance budget (B0 Shape F): "loads in under 1s / within 800ms".
  const perf = compilePerf(t);
  if (perf) checks.push(perf);

  // --- Empty-state / explicit absence (B0 Shape C). Must run BEFORE the
  // intent-flip guard so "no results"/"empty" compile rather than bail.
  const absence = compileAbsence(t);
  if (absence) checks.push(absence);

  // Intent-flipped phrasing (and not already an absence/empty assertion) is
  // left to the agent scorer — never compiled. (Aesthetic text already bailed.)
  const blocked = INTENT_FLIPPERS.test(t) && !absence;

  // --- Action verbs (wait / select / scroll / element-scoped press).
  // Conservative: only prose that names the verb + a concrete target. These
  // are ACTIONS that pass whenever they execute, so they never promote a
  // criterion to hard on their own — see the action-only demotion below.
  // "wait for X to appear" stays expect.element (compilePresence); do not
  // steal that clause into a wait ACTION.
  const waitMs = compileWaitMs(t);
  if (waitMs) checks.push(waitMs);
  const select = compileSelect(t);
  if (select) checks.push(select);
  const scroll = compileScroll(t);
  if (scroll) checks.push(scroll);
  const pressIn = compilePressIn(t);
  if (pressIn) checks.push(pressIn);

  // --- Element presence (B0 Shape B): "a success message is shown",
  // "the Sign in button is visible". Only when we get a durable selector.
  if (!blocked && !absence) {
    const presence = compilePresence(t);
    if (presence) checks.push(presence);
  }

  // --- Network assertion (B0 Shape A) — only when explicit AND not blocked.
  // Conservative: a bare assertion without a compiled trigger usually resolves
  // `unverifiable`, so we only attach it when intent is clearly positive.
  let mocking: MockingMode | undefined;
  if (!blocked) {
    const net = networkFor(t);
    if (net) {
      checks.push({ expect: { network: { ...net, status: '2xx' } } } as Check);
      mocking = 'required';
    }
  }

  // Append the console invariant LAST so it pairs with the substantive check.
  if (wantsNoConsole) checks.push({ expect: { console: { errors: 0 } } } as Check);

  if (checks.length === 0) return { tier: 'soft', dataState };
  // Action-only HARD is a false-green: wait.ms / scroll / press / select pass
  // whenever they execute, with no assertion. A screenshot-scored criterion
  // would become a mechanical green with zero proof. Demote unless at least
  // one check is an expect (v4 never minted action-only hard criteria).
  if (!checks.some(isExpectCheck)) return { tier: 'soft', dataState };
  return { tier: 'hard', checks, mocking, dataState };
}

/** Keys the compiler will emit for `press <Key> in <label>`. Conservative allow-list. */
const PRESS_IN_KEYS =
  /^(?:Shift\+)?(?:Tab|Enter|Escape|Esc|Space|Backspace|Delete|Home|End|Arrow(?:Up|Down|Left|Right))$/i;

function durationToMs(value: number, unit: string): number | undefined {
  const u = unit.toLowerCase();
  const maxMs = Math.round(u.startsWith('m') && u !== 's' ? value : value * 1000);
  if (!Number.isFinite(maxMs) || maxMs <= 0 || maxMs > CHECK_TIMEOUT_MS) return undefined;
  return maxMs;
}

/**
 * "after 500ms" / "wait 200ms" / "wait for 1s" → `{ wait: { ms } }`.
 * Does not match "wait for 'X' to appear" (no number). Stays soft when the
 * duration exceeds CHECK_TIMEOUT_MS (schema would reject it).
 */
function compileWaitMs(t: string): Check | undefined {
  const m =
    /\b(?:after|wait(?:\s+for)?)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i.exec(
      t,
    );
  if (!m) return undefined;
  const ms = durationToMs(parseFloat(m[1]!), m[2]!);
  if (ms === undefined) return undefined;
  return { wait: { ms } } as Check;
}

/**
 * "select 'United States' from Country" / "select 'Large' from the Size dropdown"
 * → `{ select: { selector: { label }, option } }`. Quoted option required.
 * From-label is a quoted phrase or a single word so this can pair with a
 * following assertion ("…and the 'State' field is visible").
 */
function compileSelect(t: string): Check | undefined {
  const m =
    /\bselect\s+["“'']([^"”'']{1,80})["”'']\s+from\s+(?:the\s+)?(?:["“'']([^"”'']{1,80})["”'']|([A-Za-z][\w-]{0,40}))(?:\s+(?:dropdown|select|list|picker))?\b/i.exec(
      t,
    );
  if (!m) return undefined;
  const option = m[1]!.trim();
  const label = (m[2] ?? m[3] ?? '').trim().replace(/[).,;:]+$/, '');
  if (!option || !label) return undefined;
  return { select: { selector: { label }, option } } as Check;
}

/**
 * "scroll to the bottom" / "scroll to top" → `{ scroll: { to } }`.
 * "scroll 'Footer' into view" → `{ scroll: { selector: { text }, intoView: true } }`.
 */
function compileScroll(t: string): Check | undefined {
  const to = /\bscroll\s+to\s+(?:the\s+)?(top|bottom)\b/i.exec(t);
  if (to) return { scroll: { to: to[1]!.toLowerCase() as 'top' | 'bottom' } } as Check;
  const into = /\bscroll\s+["“'']([^"”'']{1,80})["”'']\s+into\s+view\b/i.exec(t);
  if (into) {
    const text = into[1]!.trim();
    if (!text) return undefined;
    return { scroll: { selector: { text }, intoView: true } } as Check;
  }
  return undefined;
}

/**
 * "press Enter in 'Email'" / "press Tab in the Search box" → element-scoped press.
 * Key must be on the allow-list. Quoted label preferred; a trailing bare
 * capitalized word is accepted so "press Enter in Email" compiles.
 */
function compilePressIn(t: string): Check | undefined {
  const quoted =
    /\bpress\s+(?:the\s+)?([A-Za-z][A-Za-z0-9+]*)\s+in\s+(?:the\s+)?["“'']([^"”'']{1,80})["”'']/i.exec(
      t,
    );
  if (quoted) {
    const key = quoted[1]!;
    const label = quoted[2]!.trim();
    if (!PRESS_IN_KEYS.test(key) || !label) return undefined;
    return { press: { key, selector: { label } } } as Check;
  }
  const bare =
    /\bpress\s+(?:the\s+)?([A-Za-z][A-Za-z0-9+]*)\s+in\s+(?:the\s+)?([A-Z][\w]{0,40})\b/i.exec(t);
  if (!bare) return undefined;
  const key = bare[1]!;
  const label = bare[2]!.trim();
  if (!PRESS_IN_KEYS.test(key) || !label) return undefined;
  return { press: { key, selector: { label } } } as Check;
}

function compilePerf(t: string): Check | undefined {
  // "loads/renders/ready in under 800ms" | "within 1.5 seconds" | "< 2s"
  const m =
    /\b(?:in\s+under|within|in\s+less\s+than|under|below|<)\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?)\b/i.exec(
      t,
    );
  if (!m) return undefined;
  // Stems (no trailing boundary) so plurals/inflections match: loads, renders,
  // loading, rendered, interactive.
  if (!/\b(load|render|ready|paint|appear|display|interactiv|usable|fast)/i.test(t))
    return undefined;
  const value = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  const maxMs = Math.round(unit.startsWith('m') && unit !== 's' ? value : value * 1000);
  if (!Number.isFinite(maxMs) || maxMs <= 0) return undefined;
  return { expect: { performance: { metric: 'ready', maxMs } } } as Check;
}

// Exit-code-zero expectation: "exits 0", "exits with code 0", "returns 0".
// Conservative — only exit code ZERO compiles ("exits 1" stays soft); a
// non-zero exit expectation is rare in AC text and ambiguous to anchor.
const COMMAND_EXIT_ZERO_RE = /\b(?:exits?|returns?)\s+(?:with\s+(?:exit\s+)?code\s+)?0\b/i;

/**
 * Run-level command criterion (A5). Matches phrasings that CLEARLY name a
 * command AND an exit-code-zero expectation, e.g.:
 *   "the named command typecheck exits 0"
 *   "command `lint` exits with code 0"
 *   "`typecheck` command returns 0"
 *   "the typecheck command exits 0"
 * Emits `{ expect: { command: { run: '<name>', exitCode: 0 } } }`. The name is
 * resolved from .validity/config.ts `commands` at run time (never stored as a
 * shell string). The command NAME charset mirrors `commandExpectSchema`
 * (`^[A-Za-z0-9_-]{1,64}$`). Returns undefined when intent isn't unambiguously a
 * command+exit-0 phrasing — a false `soft` is harmless, a false command check
 * could only ever `unverifiable` anyway, but conservatism keeps the gate honest.
 */
function compileCommand(t: string): Check | undefined {
  if (!COMMAND_EXIT_ZERO_RE.test(t)) return undefined;
  // Must clearly be about a command ("command" word present). Guards against
  // e.g. "the process exits 0" compiling to a command check.
  if (!/\bcommand\b/i.test(t)) return undefined;

  const NAME = /^[A-Za-z0-9_-]{1,64}$/;
  let name: string | undefined;

  // Backticked command name: `typecheck` command / command `lint`.
  const bt = /`([A-Za-z0-9_-]{1,64})`/.exec(t);
  if (bt && NAME.test(bt[1]!)) name = bt[1];

  // "the named command typecheck" — bare word after "named command".
  if (!name) {
    const m = /\bnamed\s+command\s+([A-Za-z0-9_-]{1,64})\b/i.exec(t);
    if (m && NAME.test(m[1]!)) name = m[1];
  }

  // "the typecheck command" / "a build command" — bare word immediately before
  // "command" (with an optional article). Excludes generic words so "the named
  // command" can't capture "named" here (already handled above).
  if (!name) {
    const m = /\b(?:the|a|an)\s+([A-Za-z0-9_-]{1,64})\s+command\b/i.exec(t);
    if (m && NAME.test(m[1]!) && !/^(?:named|the|a|an)$/i.test(m[1]!)) name = m[1];
  }

  if (!name) return undefined;
  return { expect: { command: { run: name, exitCode: 0 } } } as Check;
}

function compileAbsence(t: string): Check | undefined {
  // Explicit empty-state / absence phrasings. The "no console errors" case is
  // NOT an element absence — exclude it so it routes to the console shape.
  if (/\bno\s+(console\s+)?errors?\b/i.test(t)) return undefined;

  // A concrete empty-state MESSAGE — "No results", "No items found" — that is
  // shown. Bare "empty state" is too vague (no element has that text), so it is
  // NOT a trigger; we require the actual "no <noun>" message phrase. When that
  // phrase is also quoted we use the full quoted string as the assertion text.
  const emptyMsg =
    /\b(no\s+(?:results?|items?|matches?|data|records?|users?|entries)\b(?:\s+found)?)\b/i.exec(t);
  if (emptyMsg && /\b(shown|shows?|display(?:s|ed)?|see|sees|render|appears?)\b/i.test(t)) {
    // The quoted name is the concrete empty-state copy ("No results found").
    // If it is an exemplar ("shows an empty message, e.g. \"2 left\"") drop it
    // and fall back to the detected "no <noun>" phrase so the literal never
    // becomes an exact `text:` assertion the live render can't satisfy.
    const qn = quotedName(t);
    const name = qn && !isExemplarLiteral(t, qn.index) ? qn.value : emptyMsg[1]!.trim();
    return { expect: { element: { text: name, state: 'visible' } } } as Check;
  }

  // "X is hidden / not shown / not visible" → element hidden (needs a testId
  // or role/name).
  if (/\b(hidden|not\s+(?:shown|visible|displayed)|is\s+removed)\b/i.test(t)) {
    const testId = testIdFor(t);
    // testId ONLY — see compilePresence for why it must not mix with role/name.
    // An exemplar testId literal ("e.g. testId `foo`") must not pin an exact id.
    if (testId && !isExemplarLiteral(t, testId.index)) {
      return { expect: { element: { testId: testId.value, state: 'hidden' } } } as Check;
    }
    const role = roleFor(t);
    const qn = quotedName(t);
    const name = qn && !isExemplarLiteral(t, qn.index) ? qn.value : undefined;
    if (role || name) {
      return {
        expect: {
          element: { ...(role ? { role } : {}), ...(name ? { name } : {}), state: 'hidden' },
        },
      } as Check;
    }
  }
  return undefined;
}

function compilePresence(t: string): Check | undefined {
  // Any negation near a presence verb flips intent ("does NOT show an error
  // message") — asserting `visible` there would be a false-green. Bail to soft.
  if (/\b(no|not|never|n'?t|hidden|removed|disabled)\b/i.test(t)) return undefined;
  // Interaction-gated presence isn't on the base render — leave it soft so we
  // don't emit a hard check that can only ever resolve `unverifiable`.
  if (INTERACTION_GATED.test(t)) return undefined;
  // A positive visibility/presence verb is required so we don't compile
  // arbitrary mentions of a noun.
  if (
    !/\b(is|are|be)\s+(?:visible|shown|displayed|present)\b|\b(shows?|displays?|renders?|appears?|contains?|includes?|see|sees|has\s+a)\b/i.test(
      t,
    )
  ) {
    return undefined;
  }
  // testId ONLY when the criterion names one: the first quoted phrase IS the
  // testId value (quotedName would misfile it as an accessible name), and the
  // executor's role branch ignores testId when role is set, so pairing them
  // would silently drop the testId. Runs AFTER the guards above so negated /
  // interaction-gated testId criteria still stay soft.
  const testId = testIdFor(t);
  if (testId && !isExemplarLiteral(t, testId.index)) {
    return { expect: { element: { testId: testId.value, state: 'visible' } } } as Check;
  }
  // An exemplar testId ("e.g. testId `foo`") is dropped here and the criterion
  // falls through to role/name (or soft if neither resolves). See EXEMPLAR docs.
  const role = roleFor(t);
  const qn = quotedName(t);
  const name = qn && !isExemplarLiteral(t, qn.index) ? qn.value : undefined;
  if (!role && !name) return undefined; // no durable selector → soft
  return {
    expect: { element: { ...(role ? { role } : {}), ...(name ? { name } : {}), state: 'visible' } },
  } as Check;
}

/**
 * Compile a plan's NL criteria into spec criteria, promoting the observable
 * ones to hard `checks`. Replaces the old all-soft mapping. Order + ids
 * preserved.
 */
export function compileCriteria(criteria: AcceptanceCriterion[]): SpecCriterion[] {
  return criteria.map((c): SpecCriterion => {
    const compiled = compileCriterion(c.description, c.observable);
    if (compiled.tier === 'soft' || !compiled.checks || compiled.checks.length === 0) {
      return {
        id: c.id,
        text: c.description,
        tier: 'soft',
        ...(compiled.dataState ? { dataState: compiled.dataState } : {}),
      };
    }
    return {
      id: c.id,
      text: c.description,
      tier: 'hard',
      checks: compiled.checks,
      ...(compiled.mocking ? { mocking: compiled.mocking } : {}),
      ...(compiled.dataState ? { dataState: compiled.dataState } : {}),
    };
  });
}

/* ------------------------------------------------------------------ *
 * Compiler migration (W2 #4).                                        *
 *                                                                    *
 * verify runs a spec's FROZEN checks and never re-compiles, so a     *
 * spec compiled under an OLDER contract keeps its old mechanical bar *
 * forever. When that bar has a bug the newer compiler fixes, the     *
 * only repair was silent hand-editing per spec. These helpers make   *
 * the drift visible: detect a stale `compiledWith`, recompile the    *
 * stored criteria under the CURRENT contract, and diff. The result   *
 * is ADVISORY — a frozen contract is never rewritten silently; the   *
 * agent confirms a version bump (see spec_review / spec_freeze).     *
 * ------------------------------------------------------------------ */

/**
 * True when a spec's `source.compiledWith` stamp does not match the current
 * compiler contract. A spec with NO stamp (authored before stamping shipped)
 * reads as stale — we can't prove its bar matches the current rules.
 */
export function isCompilerStale(compiledWith: string | undefined): boolean {
  return compiledWith !== CHECK_COMPILER_VERSION;
}

/**
 * Recompile stored spec criteria under the CURRENT compiler contract. The
 * criterion text is the compiler's only input we persist, so `observable` (a
 * non-persisted authoring hint) is unavailable on a recompile — a criterion
 * that was promoted purely BY that hint may recompile softer. That's
 * acceptable: the output is a diff the agent reviews, never an auto-applied
 * rewrite. Ids/order/text are preserved so the diff aligns per-criterion.
 */
export function recompileSpecCriteria(criteria: SpecCriterion[]): SpecCriterion[] {
  return compileCriteria(criteria.map((c) => ({ id: c.id, description: c.text })));
}

/** One criterion's mechanical delta between the frozen and recompiled forms. */
export interface CriterionCompileChange {
  id: string;
  text: string;
  fromTier: SpecCriterion['tier'];
  toTier: SpecCriterion['tier'];
  fromCheckCount: number;
  toCheckCount: number;
}

/** Result of comparing a spec's frozen criteria against a fresh recompile. */
export interface CompilerMigrationReport {
  stale: boolean;
  fromVersion: string | undefined;
  toVersion: string;
  /** Only the criteria whose tier or check-set changed. Empty ⇒ bar unchanged. */
  changes: CriterionCompileChange[];
  /** The full recompiled criteria set, ready to feed a spec_update patch. */
  recompiled: SpecCriterion[];
}

const checksKey = (c: SpecCriterion): string => JSON.stringify(c.checks ?? []);

/**
 * Compare a spec's stored criteria against a recompile under the current
 * contract. `changes` lists only criteria whose mechanical bar actually moved
 * (tier flip or a different check set) — an empty list means re-stamping the
 * version is safe because the bar is identical.
 */
export function compilerMigrationReport(
  criteria: SpecCriterion[],
  compiledWith: string | undefined,
): CompilerMigrationReport {
  const recompiled = recompileSpecCriteria(criteria);
  const byId = new Map(recompiled.map((c) => [c.id, c]));
  const changes: CriterionCompileChange[] = [];
  for (const before of criteria) {
    const after = byId.get(before.id);
    if (!after) continue;
    if (before.tier !== after.tier || checksKey(before) !== checksKey(after)) {
      changes.push({
        id: before.id,
        text: before.text,
        fromTier: before.tier,
        toTier: after.tier,
        fromCheckCount: (before.checks ?? []).length,
        toCheckCount: (after.checks ?? []).length,
      });
    }
  }
  return {
    stale: isCompilerStale(compiledWith),
    fromVersion: compiledWith,
    toVersion: CHECK_COMPILER_VERSION,
    changes,
    recompiled,
  };
}
