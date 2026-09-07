---
name: validity
description: >
  Use when the user asks you to build, change, or fix a UI feature against an
  acceptance spec, or whenever they say "validate", "verify against the prompt",
  "check this matches the spec", "acceptance criteria", or "validity". For
  non-trivial UI work, call `validity__plan` FIRST to capture structured
  acceptance criteria (so build-time and verify-time score against the same
  contract). Then make code changes. Then call `validity__verify` with the
  returned planId, look at the screenshots, and score them against the
  persisted criteria. Validity defaults to an isolated Vite sandbox — it does
  not require the project's dev server, and you must NOT start `npm run dev`
  / `pnpm dev` / `yarn dev` for it. For login-gated UI, seed cookies /
  localStorage in `.validity/config.ts` scenarios rather than logging in
  through the real app. Vite, Next.js, and React Native / Expo are supported —
  RN/Expo projects validate on a simulator/emulator by default, and you must
  NOT route them through the react-native-web proxy unless the user explicitly
  asked for the web target. For
  ongoing work, Validity also keeps a durable **scorecard** + signal queue:
  `validity verify --all` re-runs the deterministic checks, and you keep
  the soft (screenshot-scored) criteria current via
  `validity__score_soft_criteria` / `validity__record_soft_scores`; cold-start a
  codebase's specs with the `validity__onboard_*` loop. Triggers also include
  "watch", "monitor", "scorecard", "onboard", "what regressed".
---

# Validity Skill

Validity is the closing-the-loop check on your own work. When the user asks
for a UI change in a Vite/React or Expo project that has Validity installed,
you are expected to **render and verify** the result before declaring
success — not just compile-check or trust your own diff reading.

Supported toolchains:

- **Vite + React.** The original target. Components rendered into a Vite
  sandbox via `createRoot`.
- **React Native + Expo.** Rendered on a real iOS Simulator / Android
  emulator through the Validity companion app — the runtime the app ships on.
- **Expo Web** (opt-in). Expo projects can instead render via
  `react-native-web` — `<View>`/`<Text>`/`<FlatList>`/`<Image>` compose onto
  DOM nodes. This is a **proxy for the app, not the app**; see "Expo Web
  limitations" below for what's _not_ exercised.

## "Validate this app" — Validity picks the target for you

You don't choose the toolchain; Validity detects it (`detectAppTarget`):

- **Vite / Next.js** → web sandbox (isolation by default).
- **Expo** → **native**, on a simulator/emulator. Expo Web is available but
  never automatic.
- **Bare React Native** → on-device **native** only.

### The React Native rule — read this before you reach for `react-native-web`

**On a React Native / Expo project, BOTH browse and verify go to the device.
Never route a mobile app through Expo Web to save time, to avoid a build, or
because no simulator is booted.**

This is the single most common way to produce a confidently wrong report.
`react-native-web` composes RN primitives onto DOM nodes, so what you capture
is a browser's interpretation of the app — different layout engine, different
gesture system, no native modules. Passing screenshots from it are evidence
about something the user never asked you to validate, and the "verified" claim
reads exactly like a real one.

So:

- **Browse / "show me the app"** → `validity__native_browse` (takes a
  `component` OR a `view`). The first call runs a readiness checklist and
  builds the companion app once; later calls are instant. `validity__browse_open`
  will refuse an RN/Expo project and redirect you here.
- **Verify / "validate it works"** → `validity__verify` routes to the device
  automatically on an RN/Expo project. You do **not** need to pass
  `native: true` — it is already the default there.
- **No booted simulator?** Say so and let the user boot one (or run
  `validity browse --native` once to build the companion). Do **not** substitute
  the web proxy and report a pass.

**Expo Web is opt-in, and only the user can opt in.** It is correct when they
explicitly ask ("check it on web", "use Expo Web", "we ship an Expo web build")
or when the project already pins `framework: 'expo-web'` in
`.validity/config.ts`. For a single call, pass `webTarget: true`. If you find
yourself reasoning "the device path is slow / unavailable, so I'll use Expo
Web" — that is the exact mistake this rule exists to prevent.

So: Vite/Next → web. Expo/RN → **native for browse AND verify**; Expo Web only
when the user asked for it by name.

## If the user isn't set up yet

If Validity isn't configured — no `.validity/` — you have two options. Never
reassemble the setup sequence from memory, and don't send them to
`validity doctor` first: that answers "is anything broken?", which is the
wrong question before anything has run.

**Do it for them (preferred when they asked you to set it up).** Run
`validity start --prompt`. It emits a prompt covering every remaining step for
THIS project — correct for its toolchain, ending in a smoke test. Follow it in
order. It will tell you which steps only the user can do (picking a directory,
installing Xcode / an Android SDK) — stop there and ask, rather than guessing
or working around it.

**Hand it over.** Otherwise tell them to run `validity start` in their project
root and stop. It prints the single step they're on plus its exact command,
with both an agent prompt and manual instructions, and they re-run it after
each step.

On a React Native / Expo project the sequence includes a **one-time companion
build** (`validity browse --native`, after booting a simulator). That build is
the setup — if it stalls, fix it or report it. Switching to Expo Web to get
past it is the failure mode described above, not a workaround.

### Already-configured React Native projects

A project set up before Validity defaulted RN to the device still has
`renderMode: 'web'` in `.validity/config.ts`, and `validity init` never
rewrites an existing config. Verify still routes to the device (it decides on
detection), so nothing looks wrong — but that value is what stamps a spec's
`runtime` at creation, so new specs are minted as web specs and then fail in
`validity verify --all`.

`validity doctor` flags this as **validation target**, and `validity start`
inserts a "Point this project at the device" step. The fix is two lines in
`.validity/config.ts` — `renderMode: 'native'`, `framework: 'expo-native'` —
plus `runtime: web` → `runtime: native` in any existing
`.validity/specs/*/spec.yaml`. Leave mocks, scenarios, and components alone.

## App plugins — make the sandbox see the real app

Validity renders in its own isolated sandbox, never the user's dev server —
so three kinds of app facts are structurally invisible to it: `.env` files
(env-gated branches silently render their fallbacks), PostCSS/Tailwind-v3
setup (components render unstyled), and path aliases a static config read
can't see. The **app plugins** close those gaps from inside the user's own
toolchain, and `validity init --plugins` wires the right one automatically:

| App is built with   | Plugin wired                      | How it hooks in                        |
| ------------------- | --------------------------------- | -------------------------------------- |
| Vite                | `@validity.ai/verify-plugin-vite` | entry in `vite.config.*` `plugins: []` |
| TanStack Start      | `@validity.ai/verify-plugin-vite` | same — Start IS a Vite plugin          |
| Next.js             | `@validity.ai/verify-plugin-next` | `withValidity(...)` around next.config |
| Expo / React Native | `@validity.ai/verify-plugin-expo` | entry in the Expo config `plugins`     |

Facts you must not reassemble from memory:

- **Wiring is the default.** Plain `validity init` auto-detects the app and
  wires the matching plugin; `--no-plugins` is the opt-out. `web`, `native`,
  and `all` scope it explicitly, and the web half is bundler-aware — there
  is no `--plugins=next`; a Next app given `--plugins=web` gets plugin-next.
  Every step is idempotent (re-runs report 'unchanged'), and if the config
  isn't a shape Validity can provably edit (a wrapped
  `withBundleAnalyzer(...)` next.config, a function config), init prints a
  paste stanza instead — relay it to the user, don't improvise the edit.
- **The web plugins write one file**: `.validity/app-manifest.json`
  (committable, deterministic), during the app's own `vite dev` / `next dev`
  — NOT during a Validity run. If the manifest is missing after wiring, the
  user's dev server simply hasn't run yet; say that, and do not start their
  dev server yourself.
- **Diagnosis rule.** A verify where `import.meta.env.VITE_*` /
  `process.env.NEXT_PUBLIC_*` is empty, Tailwind v3 renders unstyled, or a
  tsconfig alias fails to resolve is a fixable SETUP problem — recommend
  wiring the plugin — not a Validity bug and not a reason to hand-copy env
  values into scenarios. The report's Setup panel says what the manifest
  recorded versus what the sandbox mirrored; trust that provenance line.
- **First verify after wiring can change screenshots** (the real `.env`
  finally loads). Expected, one-time — tell the user before they assume a
  regression. Opt-out lives at `web: { useAppManifest: false }`.
- **The Expo plugin is different in kind**: it writes no manifest. It
  guarantees the USER's app owns a deep-link scheme (never a `validity-*`
  one — that namespace belongs to the companion app) and stamps
  `expo.extra.validity` so readiness checks can prove it ran. Native
  readiness output distinguishes "listed in expo.plugins" (attested) from
  "stamp present in resolved config" (proven) — only the second means it
  actually executed. Wiring is a safe-edit or a paste stanza — an Ignite `app.json` without an "expo" key cannot be auto-wired.
- Apps on toolchains with no producer (Remix, Astro, CRA, bare
  non-Expo React Native) get no plugin from init — that is expected, not an
  error; Validity still works there with inferred setup.

## Handling arguments

If the user invoked this skill with one of these `ARGUMENTS` values, treat it
as a request for help and **do not do verification work**:

- `help`
- `--help`
- `-h`
- empty (no arguments)

In that case:

1. Run `validity help` via Bash and output the stdout **verbatim** — no
   paraphrasing, no preface, no trailing summary.
2. If the `validity` binary is not on `PATH` (the Bash call exits non-zero
   with `command not found`), read this file's sibling `HELP.md` (same
   directory as `SKILL.md`) and output its contents verbatim instead.
3. Stop after that. Do not continue into the verification flow below.

For any other `ARGUMENTS` value, treat the argument string as part of the
user's task and ignore it for routing — the rest of this skill applies.

## Hard rules — read this first

1. **Never start the project's dev server.** Validity has its own Vite
   sandbox (isolation mode, the default). If you find yourself reaching for
   `npm run dev` / `pnpm dev` / `yarn dev` / `vite` — stop. Use isolation
   mode instead. Starting the dev server is almost always a sign that you've
   defaulted to URL mode without warrant; URL mode requires _the user_ to
   have a dev server already running for an explicit page-level prompt.
2. **For login-gated UI, do not log in through a real app.** Seed cookies,
   `localStorage`, `sessionStorage`, and fetch handlers in
   `.validity/config.ts` scenarios, then pass `scenarios: ["logged-in"]` to
   `validity__verify`. The auth provider sees the seeded session at mount
   time, no real auth flow needed.
3. **Isolation is not a fallback target — it's the default.** URL mode is
   the opt-in. Pick URL mode only when (a) the user's prompt is explicitly
   page/route/flow-shaped _and_ (b) the user has started their own dev
   server. If isolation throws a render error, read the error and fix the
   wrapper or scenario — do not "escape" to URL mode.
4. **Never validate a React Native app through a browser.** On an Expo /
   bare-RN project, browse and verify both run on a simulator/emulator. The
   `react-native-web` proxy renders a different runtime than the app ships on,
   so a pass there is not a pass. Use it only when the user explicitly asked
   for the web target — never as a fallback when a device is missing or slow.
5. **Consult specs first.** If the project has `.validity/specs/`, find the
   spec targeting the screen/component you're about to change
   (`validity__spec_list`, or read `.validity/specs/<id>/spec.yaml`) and read
   its criteria BEFORE editing — they are the acceptance contract for that
   surface. After the change, verify against that spec
   (`validity__verify({ planId: "<specId>" })`). Never edit a frozen
   `spec.yaml` by hand — use `validity__spec_update`.

## When to use this skill

Trigger on any of these:

- The user asked for a UI/UX change ("add a logout button", "make the cart
  show a total", "build a login form that…").
- The user supplied explicit acceptance criteria, a checklist, a spec, a
  Figma description, or said "make sure it does X, Y, Z".
- The user said "validate", "verify", "check this against the prompt", or
  "did it actually work?".
- You are about to declare a UI task done.

Do **not** trigger on:

- Pure refactors with no rendered output change.
- Backend-only changes (server functions, schema, migrations) with no UI surface.
- Doc-only edits.

## How Validity is shaped

Validity's MCP server does **deterministic** work only — it captures
screenshots and hands them back to you. You score them. No LLM runs inside
the server, no Anthropic API key required.

There are **two modes**. **Default to isolation mode.** Switch to URL mode
only when the prompt is explicitly about a page, route, or full-app flow.

### Isolation mode (default)

Web isolation uses Vite with wrapper.gen optionally composed with wrapper.user.
Native isolation uses wrapper.gen unless a customized wrapper.native overrides it;
explicitly import AND render gen to retain cloned providers. This is what you use
whenever the user is asking about a _component_ — even if their words are casual
("verify the clock", "check the new button works", "does the cart total show up").

This mode does not touch the project's dev server. See Hard Rule #1 if
you're tempted to start one.

### URL mode (opt-in)

Validity drives the user's already-running dev server with Playwright and
screenshots one or more pages. Use only when _both_ are true:

- The user's prompt is explicitly page/route/flow-shaped — "the page",
  "the route", "the dashboard view", "the login flow" — language about
  _navigation_, not _components_.
- The user has _already_ started their dev server (you can see it in the
  conversation, or they tell you the URL).

If the dev server isn't running, ask the user to start it. Do not start it
yourself (Hard Rule #1). If the URL is unreachable, `validity__verify`
will fail loudly with the same correction.

URL mode is not a fallback for a broken isolation render. If isolation
returns `render error: <message>`, read the message — it points at
something in the user's React tree (missing provider, bad import, etc.).
Fix the wrapper or pass the right `scenarios`, then re-run isolation.

## How to drive it

For **non-trivial UI work** (multiple requirements, new components, new
features), the flow is **three MCP tool calls**:

1. `validity__plan` — BEFORE you do the work. Extract structured
   acceptance criteria from the user prompt, persist them via this tool,
   get back a `planId`. Surface the criteria in your reply so the user
   can correct any misinterpretation before you start.
2. `validity__verify({ planId })` — after the work. Validity renders the
   components / pages and returns screenshots + the persisted criteria as
   the explicit scoring rubric (instead of asking you to re-extract them
   from the prompt).
3. `validity__submit_report({ planId })` — score the criteria in your
   context, send the verdict + per-file notes back. Validity writes a
   self-contained `report.html` and a `report.md` and returns a clickable
   `file://` URL.

The `validity__plan` step locks the contract between build and verify —
the same criteria drive what you build for AND what you score against, so
misinterpretation can't slip through twice. **Skip `validity__plan` only
for trivial tweaks** (one-line styling, typos, single-prop changes) where
the ceremony costs more than it adds. For those, call `validity__verify`
directly with just the prompt.

**Do not skip `submit_report`** — the user expects a viewable report
after every verify, and your scoring + commentary is what makes that
report useful. (Skip submit_report only if `.validity/config.ts` sets
`report: false`. If that's the case, the verify response will tell you so
— just say so to the user.)

**`validity__plan` is now spec-backed.** Under the hood it creates a
durable, versioned **spec** (a reviewable `.validity/specs/<id>/spec.yaml`)
and freezes it; the returned id works everywhere `planId` did. You don't
have to change anything — the three-call flow above is unchanged. The spec
file just means the user can review and edit the criteria later and re-run
verify, and you can promote a criterion to a deterministic, exportable proof
(see "Spec tiers" and "Spec-first flows" below). This is mostly transparent;
mention the spec file only if the user asks where their criteria live.

**Plans carry a `contentHash` for drift detection.** A persisted plan records a
`contentHash` over its criteria, so a later read can tell whether the plan's
content was edited out from under a run. For a long-running build→verify→score
**loop**, prefer the **frozen spec** as the contract you gate on: a frozen spec
is the loop-grade, hash-bound, reviewable acceptance contract (severity +
`softThreshold` are frozen into it), whereas a plan's `contentHash` is only a
drift signal. If you need the contract to hold across many iterations, freeze a
spec (`validity__plan` already does, or `validity__spec_freeze`) and verify
against its id rather than re-deriving criteria each round.

### Enforcement mode — advisory vs. strict

`.validity/config.ts` can set `enforcement: 'advisory' | 'strict'` (absent =
`'advisory'`).

- **Advisory (default):** a verify without a `planId` still runs, but the run
  is stamped `planned: false` (echoed as `structuredContent.verdict.planned`)
  and the report carries an **unplanned** badge; the GitHub Action's PR
  comment renders unplanned check metadata as
  `UNPLANNED — criteria extracted after the work` (note `verify --all` is
  spec-driven by construction, so it always stamps `unplanned: false`). It's a
  provenance flag, not a verdict — the run is visibly second-class, never
  blocked.
- **Strict:** `validity__verify` without a resolvable **frozen spec** (no id,
  a legacy `plan_…` id, or an unfrozen spec) returns a plan-first **redirect**
  instead of running; `validity__submit_report` on an unplanned run does the
  same. **A redirect is not an error** — follow its instructions (call
  `validity__plan`, then retry with the returned id). It carries a
  `structuredContent.redirect` block and NO verdict, so never treat it as a
  pass or a failure.
- Browse tools (`validity__browse_open` / `browse_navigate` / `native_browse`,
  catalog/resolve/tokens/views) are **never gated** — exploration needs no
  plan; don't self-gate browsing in strict projects.

### `requireFreshJudge` — refuse sign-off on self-scored soft passes

`.validity/config.ts` can also set `requireFreshJudge: true` (default `false`).
When on, a **blocking soft criterion's pass does not count toward sign-off**
if it was `selfScored` (scored in the same session that ran verify, or an
unproven judge claim) — it must come from a fresh-context judge (a separate
scoring pass with no build context) or the automated model judge
(`validity judge`) instead. The criterion still **renders its actual
verdict** (a self-scored pass still shows as `pass`) — the knob only affects
whether `signedOff` can be `true`, never what's displayed. `submit_report`'s
response names why: e.g. `"1 soft pass is self-scored; requireFreshJudge is
on"` in both the text and `structuredContent.requireFreshJudgeBlocked`. To
clear it, re-score from a fresh context or run the automated judge.

**First verify in a project is slow** (~10-30s) because Vite pre-bundles
the project's dependencies into `node_modules/.validity/.vite-cache`.
Every later verify reuses that cache and runs in a few seconds. If the
first call seems to hang, it isn't — it's caching. Tell the user this
once if they ask why it's taking a while; don't retry or escalate.

### Spec tiers — keep "proven" separate from "scored"

Every spec criterion has a **tier**, and the two kinds are evidenced
differently. Never blur them — the credibility of a Validity report lives
on this line:

- **`hard`** (and `property`) — machine-checkable. Carries a structured
  `checks` block (the small verb set: `navigate` / `click` / `press` /
  `hover` / `fill` / `wait` / `waitForRequest` / `select` / `scroll` /
  `expect` of `element` | `network` | `console` | `screenshot` |
  `performance` | `a11y` | `command`, selected by
  accessibility `role`/`name`). Validity executes these **deterministically**
  in the sandbox and returns a **mechanical** verdict. These are PROOFS —
  report them verbatim; do not re-judge a proven `fail` as a pass.
- **`soft`** — no checks; you score it from the screenshot. This is an
  opinion ("looks polished"), not a proof. Present it as scored, never as
  proven.

When you verify against a spec, the response shows a **"Deterministic checks
(PROVEN)"** block (the hard/property verdicts) separately from the soft
criteria you still score. Copy the proven verdicts as-is; score only the
soft ones. If a hard check reports `unverifiable` because an element has no
accessible name, that's a **finding** ("AC-1 unverifiable: the Send button
has no accessible name — add one"), not a checker bug — surface it.

### Check verbs — wait / waitForRequest / select / scroll / element-scoped press

Author these in a hard criterion's `checks` (or let the NL compiler emit the
conservative patterns below). `wait.ms` is capped at 5000 (the per-check
budget); longer waits are rejected at parse time.

```yaml
- wait: { ms: 200 }
- wait: { for: { text: 'Message sent' }, state: visible } # visible | hidden | attached
- waitForRequest: { url: /api/save, method: POST } # timeoutMs optional, ≤ 5000
- select: { selector: { label: Country }, option: 'United States' }
- scroll: { to: bottom } # or to: top, by: { y: 400 }, intoView: true + selector
- press: { key: Enter, selector: { label: Email } } # omit selector for page-level press
```

Native: `wait.ms` sleeps; `wait.for` uses the a11y snapshot; `select` is
`unverifiable` (pickers differ per platform); pixel `scroll.by` is
`unverifiable`; `press` stays `unverifiable` (no hardware keyboard). A
`select` against something that is not a native `<select>` **fails** with
"not a native select — use click + click on the option" — never a silent
pass. `waitForRequest` with no matching request **fails** after timeout.

Compiler patterns: "wait for 'X' to appear" still compiles to
`expect.element` visible (not a wait ACTION). Action verbs (`wait.ms`,
`select`, `scroll`, element-scoped `press`) are emitted only when an
assertion also compiled — an action-only criterion stays `soft` so a sleep
or scroll cannot false-green a screenshot-scored AC. Author YAML is the
primary surface for standalone wait/select/scroll/press checks.

### Performance criteria — deterministic timing budgets

Validity measures performance on **every** web render and shows the numbers
in a **Performance** panel in the report (no config, no AC needed) — time to
ready, page load, first contentful paint, initial render (mount), and the
slowest re-render (update). So baseline perf is always visible; you don't
have to ask for it.

To turn a timing requirement into a **proof**, add a `hard`-tier criterion
whose `checks` use the `performance` expect family:

```yaml
- id: AC-perf
  tier: hard
  text: 'The dashboard renders within 1s and re-renders instantly on data change'
  checks:
    - expect: { performance: { metric: ready, maxMs: 1000 } }
    - expect: { performance: { metric: update, maxMs: 50 } }
```

`metric` is one of:

- **`ready`** — navigation → first usable render (the truest "how fast does
  this screen load"). Prefer this for load-speed ACs.
- **`load`** — full page load (Navigation Timing).
- **`firstContentfulPaint`** — FCP.
- **`mount`** — React's initial-mount commit cost.
- **`update`** — the slowest re-render commit (including any `play`
  interaction) — this is "how fast it re-renders when data changes".

`maxMs` is the budget; the measured value must be `<= maxMs` to pass. The
verdict is **mechanical** and appears in the PROVEN block — never also
soft-score "feels fast".

**Add a perf AC only when the prompt states a timing requirement** ("within
1s", "no jank when data changes", "instant"). When it doesn't, the passive
panel already covers observability — don't invent budgets.

**Don't duplicate perf specs.** Budget each metric **once per target**: one
`ready` and/or one `update` criterion, not several. Never pair a hard perf
budget with a soft "should feel fast" criterion — that double-counts the same
property. `validity__spec_review` flags duplicate metrics and redundant
soft+hard perf overlaps under "Performance hygiene".

Performance is **proven on web and native** — but native proves only a
subset. On native the companion measures `ready`, `mount`, and `update` in-app
(React.Profiler + a monotonic navStart→paint stamp) and ships them over the
bridge, so those three metrics are real deterministic verdicts. `load` and
`firstContentfulPaint` stay `unverifiable` on native (no RN Navigation/Paint
Timing analog), as does frame-rate (out of scope). A native run against an
old companion that predates the perf channel degrades to `unverifiable`
("rebuild the companion"), never a silent pass. Exported Playwright/Maestro
suites still can't measure perf, so there a perf check becomes a `TODO`
comment, never a silent pass.

### Command criteria — repo-level typecheck/test/lint proofs (`expect.command`)

Specs can prove repo-level invariants ("it typechecks", "the unit suite is
green") with the `command` expect family. The command's shell string lives in
`.validity/config.ts` — the spec references it by NAME only, so a frozen spec
can never smuggle executable shell:

```ts
// .validity/config.ts
commands: {
  typecheck: 'tsc --noEmit',
  test: 'vitest run',        // prefer non-watch invocations
},
```

```yaml
- id: repo-typecheck
  tier: property
  text: 'Repo typechecks after the change'
  checks:
    - expect: { command: { run: 'typecheck', exitCode: 0 } }
```

Semantics you can rely on:

- **Run-level, once per verify.** A command check never runs inside a render
  — Validity executes each referenced command once per verify run (cwd =
  project root, `CI=1`, 180s default budget; tune with `commandTimeoutMs` in
  config, max 600s). A criterion may not mix command checks with page checks
  — split them into two criteria.
- **Honest verdicts.** A name that isn't configured scores `unverifiable`
  with a finding ("add commands.<name> to .validity/config.ts") — never pass.
  A no-op resolution (`true`, `exit 0`) is also `unverifiable`. A timeout or
  a non-matching exit code is a `fail`. Only a real observed exit code equal
  to `exitCode` (default 0) passes.
- **Audit stamp.** The EXACT resolved shell string is stamped into the
  verdict (`command.resolved`) and the detail line, so a post-freeze edit of
  the config's command map is visible next to the green — surface it if it
  looks vacuous.
- **Plan auto-attach.** When `tsconfig.json` exists and `commands.typecheck`
  is declared, `validity__plan` auto-attaches a blocking `repo-typecheck`
  property criterion, so a type error blocks sign-off with zero ceremony.
  `validity__spec_create` does NOT auto-attach — you're in full control there.
- **Exports degrade honestly.** Playwright/Maestro exports emit a TODO
  comment for command checks ("run it as its own CI step"), never a green
  assertion.

### Data states (loading / empty / error / populated)

Most UI bugs that ship are in the branches nobody screenshots. Validity has a
**data-state axis**: a criterion can declare the data condition it is scored
under, and Validity forces the data layer into that condition for its own
render.

```yaml
- id: AC-3
  tier: hard
  text: 'A spinner is visible while the user list is loading'
  dataState: loading
  checks:
    - expect: { element: { role: 'progressbar', visible: true } }
- id: AC-4
  tier: soft
  text: 'The empty state explains how to add the first user'
  dataState: empty
```

The four states: `loading` (requests hang in flight), `empty` (200s with no
rows), `error` (fetch fails with a 500), `populated` (the normal render — the
default when `dataState` is absent).

**How forcing works.** In the web sandbox, Validity's network layer intercepts
every request _before_ your declared handlers and answers per the forced state
— `loading` hangs, `error` returns a 500, `empty` returns a permissive body
whose `.json()` resolves to a deep-default Proxy (`[]` for plural props, `false`
for `is*`/`has*`/`loading`/`error`, `0` for counts). That Proxy is why an empty
render is crash-safe on a component written for real data. Forcing deliberately
overrides your mocks: the question is "what does this UI do when the data layer
is in state S", not "what did the user configure".

**What you write.** Put `dataState` on the criterion. Validity mints one extra
render per (component × required state), cloned from the component's base
render — no scenario/fixture/viewport/theme multiplication, and no `play`
(interaction under a hung network is undefined behavior). You can also force
states project-wide with `dataStates: ['empty','error']` in `.validity/config.ts`,
or per spec with `conditions.dataStates`. Setting `dataStates: []` turns the
axis OFF.

**A `dataState` criterion binds ONLY to its own state's render.** A
populated-content criterion can never pass against an empty render, and vice
versa.

**When the branch never renders, you get `unverifiable` — never a pass.** Three
things can prevent the forced render: the render budget dropped the clone
(reported as `droppedDataStates` — "NOT rendered (render budget)" in the verify
response), the axis was configured off, or the runtime can't force data states
at all (native — see below). In every case the criterion is stamped with the
demoting **`data-state` evidence taint** and reads `unverifiable` with
"`<state>` branch not rendered". The taint is sticky: a soft `pass` you submit
later is clamped back to `unverifiable`, because the branch you claim to have
judged was never on screen.

**Coverage hints.** Validity scans your target's source (and its direct
imports) for branch indicators — `isLoading`, `isError`, `?.length`,
`<Suspense>`, `ErrorBoundary`, … — and, when it finds one no criterion covers,
prints `ℹ <Component> has a loading branch but no criterion covers dataState:
loading` and lists it under `structuredContent.coverage.dataStateHints`. It is
a shallow source scan, so it can be wrong: treat it as a prompt to consider a
criterion, never as a finding.

**Native holds these criteria.** The forced-data axis is web-only. On a
`validity__verify({ native: true })` run, every non-`populated` criterion is
held out of the device checks and returns `unverifiable` with the
`data-state` taint — scoring one against the natural (populated) screenshot
would prove the wrong premise. Verify it with a web isolation run, or drop the
`dataState` condition.

### Spec-first flows

There are three ways to use the spec layer. Pick by the situation:

1. **Solo (default, unchanged):** `validity__plan` → build → `validity__verify({ planId })`
   → `validity__submit_report`. Plan mints + freezes a spec for you; nothing
   new to learn.
2. **Author / review (multi-agent or careful single-agent):** when the
   contract deserves scrutiny before you build —
   - `validity__spec_create` — compile the prompt into a draft spec (you can
     mark criteria `hard` with `checks`, or leave them `soft`).
   - `validity__spec_review` — get structured findings: prompt clauses with
     no matching criterion, soft criteria that should be promoted to hard,
     missing nemesis (viewport/network) coverage, selectors that won't be
     durable. It only reports — it never edits.
   - `validity__spec_update` — apply fixes (amends a draft in place; a frozen
     spec versions to v(n+1) with lineage).
   - `validity__spec_freeze` — lock the content + bind a hash (honors the
     `specApproval` config: `always` requires an out-of-band `approved`
     status first).
   - then build → `validity__verify({ planId: "<specId>" })` → `submit_report`.
3. **Suite / CI:** `validity verify --all --changed [--report junit]` re-runs
   the mechanical hard/property checks for every spec whose target components
   changed — no LLM, deterministic, non-zero exit on a hard fail. The team /
   regression wedge.

**The user can review and modify a spec anytime** — edit
`.validity/specs/<id>/spec.yaml` by hand, or call `validity__spec_update`,
then re-run verify (or regenerate exported tests). Editing a frozen spec
creates a new version with lineage; the old one is kept under `history/`.

### Export — specs become real e2e tests

`validity spec export <id>` compiles a spec's hard/property checks into a
runnable test suite — **Playwright** for web specs, **Maestro** for native
specs (target derives from the spec's `runtime`; `--target` overrides).
Hard checks become real assertions (`getByRole(...).click()`,
`waitForResponse(...)`); soft criteria become visible `test.fixme()` stubs,
never silently dropped. Generated files carry a `GENERATED from <id>@v<n> —
DO NOT EDIT` header + content hash. This is the exit-ramp:
the user's specs accumulate into their own e2e suite as a byproduct.

**Maestro (native) export is a PREVIEW, parked behind
`export.maestro.enabled: true`**: only element-visibility checks map cleanly
to Maestro steps (network/console/perf/a11y/command checks degrade to TODO
comments), so native export refuses with an honest notice until the project
opts in. When enabled, the flow is runnable (`maestro test`), not a stub:
it opens with a launch preamble (`clearState` + best-effort dismissal of
dev-build overlays) and compiles each `navigate` check to real steps when
`export.maestro.routes` maps the target (a deep link or a tap sequence). Tune
this in config — `export.maestro: { enabled, clearState, dismissDevOverlays,
routes }` — and run the flow against a release/preview build. When you author a native
spec, set `selector.testId` (alongside role/name, not instead) wherever the
component source exposes a stable `testID`: it exports as a durable Maestro
`id:` that survives copy/i18n drift, where a bare `text:` matcher would not. The
`native_browse` / `verify` output lists the testIDs it finds in source to make
this easy.

By default exports land in `.validity/exports/` as **drift-checked derived
files** (an `exports-manifest.json` pins spec hash + exporter version):
`validity spec export --check` recompiles every artifact and fails CI on any
byte divergence — hand edits, stale specs, and Validity upgrades each get
their own message (`--fix` regenerates); `--all` exports every
export-eligible frozen spec.

### The maturity ladder — probation → dev → team → certified

Every spec has a DERIVED maturity level (never an authored field):
**probation** (bulk-drafted, unconfirmed) → **dev** (not frozen) → **team**
(frozen contract) → **certified** (the contract is CURRENTLY PROVEN: every
gate criterion passes on fresh, untainted evidence at the current frozen
content, held across consecutive clean verifications at distinct commits).
Export health is a separate, optional **portable** badge — shown only when
the project configures an `export` stanza; it never moves the level.
`validity__spec_list`
shows levels; `validity__spec_get` lists each spec's exact steps to the next
rung plus any pending **hardening candidates** (machine-proposed hard
replacements for soft criteria that passed 5 consecutive runs on
byte-identical evidence — apply via `validity__spec_update`, never
auto-applied). Keep genuinely subjective criteria as `severity: 'advisory'`
instead of deleting them — advisory criteria stay visible and scoreable but
never block certification.

The mode for `validity__verify` is selected by which arguments you pass.

### First verify auto-configures the project

The first time `validity__verify` runs in a project, Validity inspects
the project's entry file (`src/main.tsx` and friends), clones the
real-app provider tree into `.validity/wrapper.gen.tsx`, seeds
`.validity/config.ts` with example `mockNetwork` + scenarios, and
writes a `.validity/.shape-signature.json` so subsequent verifies can
detect drift cheaply. **You do not need to run anything before the
first verify.**

If the cloner hits something it couldn't infer (a project-local
provider whose runtime input depends on env vars, an i18n bundle, a
custom Convex client), the verify response surfaces a `Setup health`
block telling you exactly what's missing. Add those providers to
`.validity/wrapper.user.tsx` (which Validity composes around the
generated tree on every render) and re-run.

If you want to seed the project ahead of time (or force a regen after
changing your real entry), run `validity init --force`. Same code path
as the auto-bootstrap, just with a CLI surface.

When `validity doctor` shows "wrapper appropriate: warn — wrapper.tsx is
a passthrough but project uses…" (the generated `wrapper.gen.tsx` failed to
clone your real providers), that's a signal that auto-config hasn't run
yet — run `validity init --force` or trigger any verify.

### Isolation mode (default)

```
tool: mcp__validity__validity__verify
args: {
  prompt: "<the user's original request, verbatim>",
  projectRoot: "<absolute path>",
  changedFiles: ["src/components/Foo.tsx", ...]   // optional; omit to use git diff
}
```

The component renders inside Validity's own Vite sandbox, wrapped in
`.validity/wrapper.gen.tsx` (+ `.validity/wrapper.user.tsx` if you've added
one). Network requests (`fetch`, `XMLHttpRequest`) are
intercepted by `@mswjs/interceptors` based on `.validity/config.ts` →
`mockNetwork.handlers`. Cookies and `localStorage`/`sessionStorage` are
seeded from `mockNetwork.cookies` / `mockNetwork.localStorage` /
`mockNetwork.sessionStorage` before navigation, so an auth provider that
reads a Bearer from `localStorage` on mount sees it.

#### Scenarios, fixtures, and play — pick the right tool

Three orthogonal levers control what each screenshot captures. Use the
right one or your screenshots won't differ from each other.

**Scenarios** — global, per-render network/auth state. Set in
`.validity/config.ts`:

```ts
scenarios: {
  'logged-in':  { mockNetwork: { cookies: { session: 'mock' }, handlers: [{ url: '/api/me', json: { id: '1' } }] } },
  'logged-out': { mockNetwork: { handlers: [{ url: '/api/me', status: 401 }] } },
}
```

Use scenarios for: who is signed in, what the API returns, what's in
localStorage. Pass via the `scenarios: [...]` arg to `validity__verify`.

**Fixtures** — component-scoped sets of props that drive a specific
component into a known visual state. Set in `.validity/config.ts`:

```ts
components: {
  'src/components/ui/Button.tsx': {
    fixtures: {
      primary:   { props: { children: 'Sign in', variant: 'primary' } },
      loading:   { props: { children: 'Saving',  isLoading: true } },
      disabled:  { props: { children: 'Disabled', disabled: true } },
    },
  },
}
```

Use fixtures for: button states (primary/secondary/disabled/loading),
form inputs (empty/with-value/with-error), card layouts (compact/full).
**When a component has fixtures, Validity renders one screenshot per
fixture and ignores the requested scenarios for that component** — they
serve different needs and combining them rarely produces more signal.

**Play** — async callback that drives the rendered DOM via Playwright
_before_ the screenshot. Set on a scenario or a fixture:

```ts
scenarios: {
  'invalid-submit': {
    play: async ({ page }) => { await page.click('button[type=submit]'); },
  },
}
```

Use play for: form-after-failed-submit, hover/focus states, opened
menus, anything that requires interaction to be visible. Capped at 10s
(longer = render error, not a hang). The Playwright `Page` object is the
real Playwright API — use `page.fill`, `page.click`, `page.hover`, etc.

**When to pick which:**

| Goal                                         | Use                        |
| -------------------------------------------- | -------------------------- |
| Component renders nothing without props      | fixtures                   |
| Same component, different visual variants    | fixtures                   |
| Auth state, mocked endpoints, cookies        | scenarios                  |
| Form with validation errors visible          | scenario or fixture + play |
| Hover / focus / opened-menu / typed-in-input | play                       |
| Compare logged-in vs logged-out user pages   | scenarios                  |

#### Calling verify with fixtures or scenarios

```
args: {
  ...,
  scenarios: ["logged-in", "logged-out"],   // applies to components without fixtures
}
```

If you change `Button.tsx` (which has fixtures defined) AND `LoginForm.tsx`
(which doesn't), passing `scenarios: ["logged-in"]` produces:

- Button × primary, Button × loading, Button × disabled (fixtures, scenarios ignored)
- LoginForm × logged-in (no fixtures, scenarios applied)

Each render runs in its own fresh Playwright context, so cookies / storage
from one render don't leak into the next.

Total renders are capped at 24 per verify call. If you'd exceed that
(e.g. 5 fixtures × 6 components = 30), narrow `changedFiles`, trim
fixtures in `.validity/config.ts`, or pass fewer scenarios.

#### Reading the report's notices

Validity surfaces two warnings on screenshot slides automatically:

- **"This screenshot looks empty"** (yellow) — the captured PNG is
  suspiciously small. Almost always means the component renders nothing
  with default props. Add fixtures with realistic props in
  `.validity/config.ts`. The notice includes the exact snippet to paste.
- **"Pixels identical to {other}"** (blue) — two scenarios/fixtures of
  the same component produced byte-equal screenshots. Either the mocks
  differ but the rendered output doesn't (consider whether you need both),
  or one of them needs a `play` function to drive the component into a
  different visible state.

#### Unmatched fetches

If the rendered component fetches a URL no handler matched, Validity's
`mockNetwork.fallback` (`'permissive'` by default → 200 + `{}`) handles it,
and the URL appears in the response under "Unmatched fetch(es) under
'<scenario>'". Treat that as a hint — if the response shape matters for
what you're scoring, ask the user to add a handler in
`.validity/config.ts` (or pass `'reject'` as the fallback to make
unmatched URLs fail loudly).

### URL mode (opt-in only)

Use only when the prompt is explicitly about a page, _and_ the user already
has their dev server running.

```
tool: mcp__validity__validity__verify
args: {
  prompt: "<the user's original request, verbatim>",
  projectRoot: "<absolute path>",

  # Either one URL …
  url: "http://localhost:5173/dashboard",

  # … or a list of paths joined against an auto-detected base URL.
  paths: ["/", "/login", "/dashboard"],
  baseUrl: "http://localhost:3000",   // optional

  # Optional: same `scenarios` arg as isolation mode. Multiplies (urls × scenarios).
  scenarios: ["logged-in", "logged-out"],
}
```

URL mode reads `.validity/config.ts` if present and applies the same
`mockNetwork` + `scenarios` machinery as isolation mode, but via Playwright
route interception instead of `@mswjs/interceptors`. Differences worth
knowing:

- **NO mechanical criterion is evaluated.** URL mode points a browser at the
  user's dev server and captures screenshots; there is no Validity sandbox in
  the loop, so no element / network / console / screenshot / perf check runs.
  Every hard and property criterion comes back `unverifiable` with that reason,
  and the tool response and report both say so. The screenshots are real
  evidence and soft criteria score against them normally — but **do not report
  a hard criterion as passing from a URL run.** For mechanical proof, use
  isolation mode.
- **Only browser-side fetches are interceptable.** Data the dev server
  fetches in its own Node process (Next.js server components, SSR loaders,
  `getServerSideProps`) is NOT visible — Playwright only sees what leaves
  the browser. If your scenario depends on server-rendered data, isolation
  mode is the right tool.
- **Passthrough by default.** Unlike isolation mode, requests that match
  no handler pass through to the real dev server (otherwise every
  framework asset would 200-`{}` and the page wouldn't render). The
  `fallback` setting in `mockNetwork` is therefore effectively ignored in
  URL mode for unmatched requests.
- **Unmatched-URL warnings still fire.** Same surfacing as isolation:
  API-shaped requests (filtered to skip `.js`/`.css`/HMR/etc.) that no
  handler matched are listed under "Unmatched fetch(es) under
  '<scenario>'". Treat the same way — add a handler if the response
  shape matters.
- **Cookie / localStorage / sessionStorage seeding works.** Pulled from
  `mockNetwork.cookies` / `localStorage` / `sessionStorage` (base merged
  with the active scenario's overrides) and applied to the BrowserContext
  before navigation, just like isolation mode.
- **`play` functions work** (when defined on a scenario in
  `.validity/config.ts`). Receives the real Playwright `Page`; bounded by
  the same 10s cap.

Each (url × scenario) pair runs in its own fresh BrowserContext.

### Response shape (both modes)

The response is a sequence of content blocks:

- A header identifying the mode and run id.
- For each captured component (or page): a label line, then an **image**
  block with the screenshot. Isolation mode also includes the component
  source. If you passed `scenarios`, each component appears once per
  scenario, labeled accordingly.
- A trailing scoring-instructions block telling you exactly how to format
  your verdict.

#### Structured verdict — the loop stop signal

Alongside the human-readable content blocks, `validity__verify` now returns a
machine-readable `structuredContent.verdict` so an automated loop can gate on
the result without re-parsing prose:

```jsonc
structuredContent: {
  verdict: {
    status: "pass" | "fail" | "partial" | "unverifiable", // rollup over criterionVerdicts
    runId: "<run id>",
    signedOff: true | false,        // THE stop signal — see below
    criterionVerdicts: [ /* { id, tier, status } per spec criterion — soft appear as `unverifiable` placeholders until you host-score them */ ],
    recentRuns: [ /* present only when a specId is in scope: the last few runs, newest-LAST, each { runId, createdAt, verdict, signedOff } — `verdict` here uses the SAME rollup as `status` above (pass|fail|partial|unverifiable), so the final element matches this run's `status`; cross-iteration history without a file read; see "Per-run history" below */ ]
  }
}
```

**`signedOff` is THE single "done" signal — gate your loop on it, not on
`status`.** It is true only when every **blocking** criterion passes:

- `hard` / `property`: the mechanical verdict is `pass`.
- `soft`: you scored it `pass`. If the frozen spec set a `softThreshold`, the
  numeric gate (`score >= softThreshold`) is enforced on the
  `record_soft_scores` path — that's where you supply a numeric `score`. At
  verify time soft criteria are still `unverifiable` (unscored), so `signedOff`
  stays `false` until you record scores.
- `advisory` criteria (`severity: 'advisory'`) are ignored — they may fail
  without blocking sign-off.
- An empty criteria set is never signed off, and `unverifiable` / unscored
  criteria never count as a pass (a false-green is impossible).

`severity` (`blocking` | `advisory`, default `blocking`) and `softThreshold`
are **frozen in the spec** — they are part of the accepted contract, not
something you decide at verify time. So in a build→verify→score loop, keep
going until `signedOff` is `true`; `status: "partial"` with everything
blocking still open means there is work left, while `status: "partial"` whose
only failing criteria are advisory can still be `signedOff: true`.

`submit_report` likewise returns `signedOff` in its `structuredContent`,
computed over the run's final criterion verdicts after your submitted soft
scores are reconciled into them — the same stop rule. `submit_report` also
writes those soft scores through to the durable `scorecard.json` (see "After
scoring" below), so the plain verify → submit loop keeps the scorecard current.
Creating a spec's scorecard entry in the first place still belongs to the
deterministic tick — a spec-scoped `validity__verify` or `validity verify --all` — so
that standing state is only ever founded on a mechanical observation.

#### The fold receipt — did this run change the scorecard?

A spec-scoped verify also folds its mechanical verdicts into `scorecard.json`.
That fold is best-effort by design (a scorecard write must never fail a run),
which used to make it silent: a draft spec, an unreadable scorecard, or URL
mode all produced the same output as a successful write. `verdict`'s sibling
`receipt` says what actually happened, and the last line of the text response
says it in one sentence.

```jsonc
structuredContent: {
  verdict: { /* … */ },
  receipt: {
    written: true | false,          // did the scorecard/signals change on disk?
    reason: "…",                    // present only when `written: false` — WHY (e.g. draft spec, URL mode)
    specId: "<spec id>",            // absent when no frozen spec was in scope
    criteriaWritten: 3,             // hard/property rows recorded
    signalsOpened: [ /* { id, kind, criterionId } */ ],
    signalsResolved: [ /* same shape */ ],
    historyAppended: true | false
  }
}
```

`written: false` is **not** a failure — it's the honest answer for a run that
had nothing durable to record (a draft spec is deliberately kept out of the
scorecard; URL mode evaluates no mechanical criteria). Read `reason` before
concluding a spec's standing state is stale. Never report a scorecard update to
the user that the receipt doesn't show.

#### Environment keys — "the machine broke, not the code"

Two **sibling** keys of `verdict` name the cause when a native (simulator /
emulator) run lost evidence to the environment rather than to your changes. Both
are **omitted entirely** on a healthy run, so a clean payload is byte-identical
to one from before the feature — presence is the whole signal.

```jsonc
structuredContent: {
  verdict: { /* … unchanged, and untouched by either key below … */ },

  // NOTHING rendered this run. Present ⇒ there is no evidence to score.
  environmentBlocked: {
    cause: "phantom-device-claim",   // open string — future probes add causes
    symptom: "…what was observed, concretely…",
    detail: "…what it means, and why verdicts were withheld…",
    fixCommand: "kill $(cat daemon.pid)\nrm -rf \"$HOME/.agent-device/sessions\"", // absent ⇒ no one-command fix
    confidence: "confirmed" | "suspected"
  },

  // SOME targets rendered, some were lost. Present ⇒ partial evidence.
  environmentDegraded: {
    cause: "session-decay",          // same five fields as above, plus:
    symptom: "…", detail: "…", fixCommand: "…", confidence: "suspected",
    affectedRenders: 2,                                  // how many were lost
    affectedTargets: ["src-button__base", "src-button__dark"] // which ones
  }
}
```

**They are not interchangeable — react to them differently:**

- **`environmentBlocked`** — this run produced **no usable evidence at all**.
  Don't iterate on the code: run `fixCommand`, then re-run the verify. Looping
  on edits here just burns turns against a broken machine.
- **`environmentDegraded`** — this run **did** produce evidence, and the verdict
  for the targets that captured is **trustworthy**; only the renders named in
  `affectedTargets` are missing. Keep going — do **not** abort the sweep. Fix
  the environment when convenient and re-verify to cover the gap.

**Neither key ever moves `verdict` or `signedOff`** — naming a cause is inert in
both directions, so it can never manufacture a green (an unrendered criterion
stays `unverifiable`) and never manufactures a red either. The human `content`
blocks carry the same cause as a `LIKELY CAUSE` line on the affected render;
these keys exist so you never have to parse that prose.

#### Per-run history — "what was the verdict N iterations ago"

`signedOff` and the verdict above are the **current** snapshot. For the **timeline**
— "what did this spec look like two runs ago," "when did it last sign off" — every
run a spec produces is appended to a per-spec regression log:

```
.validity/specs/<id>/runs.jsonl
```

One JSON object per line, **append-only and newest-LAST** (gitignored). Each line
is a compact snapshot of that run, now carrying the loop-relevant fields:

- `runId`, `createdAt`, and the aggregate `verdict` + `counts`.
- `signedOff` — the stop signal AT that run (the same `computeSignedOff` rule),
  so you can see which iteration first crossed the line.
- `criteria` — a **per-criterion snapshot** for that run: `{ id, tier, status }`
  for each spec criterion (severity/numeric score live in the spec/scorecard and
  are intentionally not duplicated here).

Three ways to read it, cheapest first:

1. **`recentRuns` in verify's `structuredContent.verdict`** (above) — when you
   verify against a spec, the response already carries the last few runs
   (newest-last, the just-finished run is the final element). For a loop that just
   called verify, this is the no-extra-call way to compare against prior iterations.
2. **`readSpecRunHistory(projectRoot, specId, limit)`** — the programmatic reader;
   returns the enriched summaries in the same newest-last order. Read the tail and
   count back `N` for "N iterations ago."
3. **Tail the file** — `tail -n <N> .validity/specs/<id>/runs.jsonl` and parse the
   lines when you want raw history outside an MCP call.

**Soft scores enter this timeline when `submit_report` folds them.** A bare
`validity__verify` append captures soft criteria as `unverifiable` placeholders
(they're unscored at verify time). The timeline append from `submit_report` runs
AFTER your submitted soft scores are reconciled into the run, so that row carries
the **scored** soft statuses and the post-scoring `signedOff` — meaning a single
build→verify→score iteration can land **two** lines for the same run (the
pre-scoring verify snapshot, then the scored submit_report snapshot). Both survive
(append-only); read the tail for the final, soft-inclusive state.

#### Lean responses — `detail: 'full' | 'lean'`

In a build→verify→score loop, most iterations re-send screenshots you have
already seen. `validity__verify` therefore auto-selects a detail level: the
**first** verify of a spec is always `full` (you must see everything once);
once the spec has prior runs it defaults to `lean`. Lean keeps the proven
verdicts, regression deltas, and the whole `structuredContent` — it only omits
screenshots that provably hide nothing (every mechanical check passed, no soft
criterion needs scoring, and the pixels are byte-identical to the previous
run's screenshot) and component source unless a render errored. Soft criteria
you already scored on byte-identical evidence are listed as **carried
forward**: report them with their recorded status and a reasoning prefixed
`carried forward:` — do NOT re-judge them from memory. Anything failing,
unverifiable, unscored, or pixel-changed always arrives in full. Pass
`detail: 'full'` to force every screenshot + source (e.g. when the user asks
to see the UI), or `detail: 'lean'` to force lean on a first run. The response
states the resolved level, and `structuredContent.presentation`
(`{ detail, autoSelected, screenshotsShown, screenshotsTotal, omittedRenderIds,
carriedForwardSoft }`) lets a driver re-request omitted evidence mechanically.
Lean is presentation-only: run-meta, screenshots on disk, verdicts, and
`signedOff` are identical either way, and `validity__score_soft_criteria`
always serves the latest run's images from disk. URL mode ignores lean
(nothing can be proven unchanged there); the legacy `lean: true` arg is a
deprecated alias for `detail: 'lean'`.

### After scoring: call `validity__submit_report`

When the user is asking about a _component_ (isolation mode), follow up
with:

```
tool: mcp__validity__validity__submit_report
args: {
  runId: "<the runId from the verify response header>",
  projectRoot: "<same absolute path you passed to verify>",
  verdict: "pass" | "fail" | "partial",
  summary: "<1 paragraph for the report header>",
  criteria: [
    {
      description: "<the acceptance criterion>",
      status: "pass" | "fail" | "unverifiable",
      reasoning: "<what you saw in the screenshot, quoted specifics>",
      suggestion: "<concrete fix, only if status=fail>"
    }
  ],
  fileNotes: {
    "src/components/Foo.tsx": "1-3 sentence note: what changed and why.",
    "src/api/login.ts": "..."
  }
}
```

The response gives you a clickable `file://` URL pointing at `report.html`
— **relay it to the user** so they can open the report directly. A
fallback `npx http-server <runDir>` command is included for browsers that
block local file access.

`fileNotes` keys are project-relative paths (matching what's in the diff).
Only include files you actually changed in this round; skip ones that just
moved due to formatting.

URL mode writes the same `run-meta.json` isolation mode does (its response
carries a `Run: <runId>`), so `submit_report({ runId, planId })` works the
same in URL mode as in isolation and native — call it to produce the report.

**Your soft judgments in `criteria` are written to the scorecard, not just the
report.** When the run is bound to a frozen spec, `submit_report` folds every
soft criterion you scored through the same gate `record_soft_scores` uses:
mechanical hard/property verdicts stay authoritative and can't be overridden, a
soft `pass` still needs a `screenshotIds` citation, and the `needs-scoring`
signal for that criterion is resolved. So the ordinary
**verify → submit_report** loop leaves the scorecard current on its own — you
do **not** need a separate `record_soft_scores` call for criteria you already
judged here, and you don't need `validity verify --all` running. Use
`score_soft_criteria` + `record_soft_scores` for the standalone case: refreshing
stale soft scores later, or judging with a distinct model.

`structuredContent.receipt` reports what was written —
`{ softScoresApplied, softScoresRejected, signalsRaised, signalsResolved }`.
Read `softScoresRejected` when a score you submitted didn't land; each entry
names the `criterionId` and the `reason`.

## Reading the response and scoring

Rubric version: 1

That marker is the version of the scoring rules below — the tiers, the
"never a false green" lattice, and the screenshot-citation floor. Pass it as
`rubricVersion: '1'` on `validity__submit_report` / `validity__record_soft_scores`
so the judgment records which rules produced it. Omit it and Validity stamps
its own current rubric and flags `rubricVersionAssumed: true` (recorded, but
not attested by you). Nothing about this gates: it exists so two soft scores
that disagree can be told apart from two soft scores written against different
instructions.

If a spec carries a rubric stamp that differs from the current one, verify says
so (`Spec frozen under rubric v0, current rubric v1 — soft scores may not be
comparable; re-freeze to re-baseline.`) in `structuredContent.warnings`. It does
not block — re-freeze the spec when you want its soft history re-baselined.

A spec with NO stamp — frozen before rubric versioning existed — gets no
warning. That is unknown, not drift, and the next freeze stamps it.

For each component returned:

1. Read the screenshot. Don't just read the source — the whole point is
   that the screenshot is the ground truth.
2. Extract acceptance criteria from the user's prompt. Treat any explicit
   "must", "should", or numbered/bulleted requirement as a criterion.
3. For each criterion, decide pass / fail / unverifiable. Quote what you saw
   in the screenshot in your reasoning. Mark `unverifiable` only when the
   screenshot truly cannot show it (animations, click handlers, etc.) — not
   when you're just unsure.
4. Emit a single JSON object in this shape (the trailing instructions in the
   tool response repeat this verbatim):

   ```json
   {
     "verdict": "pass" | "fail" | "partial",
     "criteria": [
       {
         "description": "<criterion>",
         "status": "pass" | "fail" | "unverifiable",
         "reasoning": "<what you saw in the screenshot>",
         "suggestion": "<concrete fix, if status=fail>"
       }
     ]
   }
   ```

5. Then summarize the verdict for the user in plain prose.

## What to do on the result

- **All criteria pass** → say so concisely, mention the run id, and stop.
  Don't re-render to "double check".
- **Some criteria fail** → decide whether the failure is something you can
  fix (mis-wired prop, missing element, wrong copy) or something that needs
  the user's call (ambiguous spec, missing design decision, missing data).
  - If it's clearly fixable: make the fix and re-run `validity__verify` with
    the same `prompt` so you're scored against the same criteria. Two
    iteration loops is fine; after that, surface the failures to the user
    instead of grinding.
  - If it's ambiguous: stop and ask the user with the specific failing
    criterion quoted.
- **No components rendered (isolation mode)** → the response includes a
  tip with the auto-detected dev-server URL. Retry in URL mode with `url`
  or `paths` instead.

### Render errors are bugs in the user's project, not in Validity

If `validity__verify` returns a `render error: <message>` line for a
component, that error came from **the project's React tree** — caught by
the sandbox's `window.onerror` / `unhandledrejection` traps. The error
points at user code (a missing context, a thrown constructor, a broken
import, an invalid config value passed to a library, etc.). Common
patterns:

- _"Could not find react-redux context value"_ → the generated wrapper is
  missing `<Provider store={store}>` (or your entry's store setup couldn't
  be cloned). Add it via `.validity/wrapper.user.tsx`.
- _"Invalid base URL: /auth"_ (or similar URL-parsing error) → a client
  library was given a relative URL where it expected absolute. Fix the
  call site in user code.
- _"Cannot read properties of undefined (reading 'S')"_ deep in
  `react-dom-client` → `react` and `react-dom` major versions are
  mismatched. Fix `package.json`.
- _"undefined is not a function"_ in a hook → the wrapper isn't providing
  the context that hook reads from. Add the right Provider.
- _"useFoo must be used within FooProvider"_ → a project-specific React
  Context the cloner couldn't auto-discover. Validity surfaces an
  inline `→ fix:` hint with the exact provider name. Follow it:
  1. Stay in isolation mode. Never start the dev server in response to
     this error.
  2. Find the provider's source file:
     `grep -r "export.*FooProvider" src/`.
  3. Create or edit `.validity/wrapper.user.tsx` (Validity composes
     it around the generated tree on every render):
     ```tsx
     import type { ReactNode } from 'react';
     import { FooProvider } from '../src/contexts/FooContext';
     export default function UserWrapper({ children }: { children: ReactNode }) {
       return <FooProvider>{children}</FooProvider>;
     }
     ```
  4. If the provider needs props (a value, a client, a store), give it
     realistic stubs — or add a scenario in `.validity/config.ts` that
     seeds the underlying state via `mockNetwork`.
  5. Re-run `validity__verify`. The wrapper-user toggle is part of
     Validity's drift signature, so the next verify regenerates
     `wrapper.gen.tsx` to wrap your provider around `{children}`
     automatically.

  Multiple missing providers in sequence is normal — fix each one as it
  surfaces, re-running verify between fixes. Two or three iterations is
  expected for a deeply-providered dashboard; that's still cheaper than
  starting a real dev server and walking the auth/ToS/paywall gauntlet.

**Do not investigate Validity's own source code** (`packages/verify-web/`,
`packages/verify-spec/`, `node_modules/.validity/`, etc.) when you see a render
error. The error is almost certainly the user's code. Read the message
literally, locate the line in the user's project that triggers it, fix
it, re-run verify. If after one fix attempt you still don't understand
the error, surface the exact error text to the user and ask — don't
grind on Validity internals.

The only exceptions where Validity itself is the cause:

- The error is `Validity sandbox error: <something about MSW or the dev
server>` (rare; if you see it, surface to the user — it's our bug).
- The verify call itself returned a non-`render error:` MCP error
  (e.g. _"Scenario not defined"_ — those are config errors, not render errors).

## Continuous monitoring, onboarding & the scorecard

Beyond the per-task three-call flow, Validity maintains a durable **scorecard**
(`.validity/scorecard.json`) — the current pass / fail / unverifiable / unscored
standing of every frozen spec's criteria — plus a local **signal queue**
(`.validity/signals.json`) of what drifted (regressions, newly-unverifiable
checks, coverage drops, soft criteria needing (re)scoring, recoveries). This turns
Validity from an end-of-task check into an always-current picture of "does the UI
still meet its accepted specs." Both files are local — nothing is sent anywhere.

Two engines maintain it, split on the LLM line:

### 1. The watcher (deterministic — no LLM)

`validity verify --all` (a CLI process the user runs in a terminal) re-runs the
**hard/property** checks when source changes and updates the scorecard + signals.
It scores NONE of the soft tier — it has no model — it only flags soft criteria
as `needs-scoring` / `needs-rescoring`.

- `validity verify --all` — re-verifies frozen specs' hard/property checks when you run it. A changed
  file affects (debounced). This is the "box that watches the codebase."
- `validity verify --all` — a single deterministic pass (also useful in CI).
- `validity signals list` — print the current scorecard + open signals (no re-run).
- `validity signals list [--all]` / `suppress <id>` / `resolve <id>` — inspect
  or close the queue without a verify tick. MCP twin: `validity__signals`.
- `validity doctor --rebuild-signals` — rebuild `signals.json` by replaying
  `.validity/history/signals.jsonl`.
- `validity trends` — write a self-contained `.validity/reports/trends.html` of
  every spec's run history: verdict/coverage timelines, per-criterion strips,
  perf sparklines, the score line, and the signal history (including
  recoveries).
- `validity compare <runA> <runB>` — a side-by-side HTML of two verify runs:
  screenshots paired by render slug, criteria verdict deltas, perf deltas.
  Works even when one run's artifacts were cleaned up (it degrades to the
  indexed timeline summary, clearly badged).

`trends` and `compare` are local-only VIEWERS: they always exit 0, never gate,
and never affect `signedOff` — never present them as verification. By default
run history is per-machine; if the user wants trends that survive across
machines/branches, suggest `historyCommitted: true` in `.validity/config.ts` —
each verify then also appends a compact summary row (verdict + criterion
statuses + sha; no screenshots, no source, no prompts) to committable
`.validity/history/<specId>.jsonl` files (merge-safe via a `merge=union`
gitattribute Validity writes for you).

The repo-level **Validity Score** is a weighted pass-rate over every blocking
criterion. Informational only: it never gates sign-off or exit codes, so never
treat it as the stop signal (`signedOff` is).

Suggest the user run `validity verify --all` after UI changes — it's
their live regression signal for the provable tier, and needs no agent.

### 2. You are the loop for the soft tier

The watcher can't judge "looks on-brand" — that's you. To keep the soft (~71%)
criteria current (after UI changes, or when the user asks), run the soft-scoring
loop:

1. `validity__score_soft_criteria({ specId })` — returns the spec's OPEN soft
   criteria (unscored or stale), the frozen criterion text as the rubric, and the
   screenshots from the spec's most recent verify run. If there's no run yet, call
   `validity__verify` first so there are screenshots to score.
2. Score each against EXACTLY that criterion text, quoting screenshot evidence.
3. `validity__record_soft_scores({ specId, scoredBy, scores: [{ id, status, reasoning, screenshotIds?, score? }] })`
   — folds your scores into the scorecard and emits signals. Mechanical
   hard/property verdicts are authoritative and **cannot** be overridden here; a
   non-soft or unknown id is rejected and reported back. Score every open soft
   criterion — an omitted one keeps its prior status and never silently flips to
   pass. A soft **`pass` must carry `screenshotIds: [<render id>]`** citing the
   screenshot(s) you scored it from (the render ids are printed next to each
   screenshot by `score_soft_criteria`); a pass without a valid citation is
   rejected, exactly like `submit_report`. `fail`/`unverifiable` need only
   `reasoning`. Pass an optional numeric `score` (`[0,1]`) per criterion when the
   spec set a `softThreshold` — sign-off compares your score against that frozen
   threshold.

   **Pass `scoredBy` and prefer a DISTINCT judge model.** `scoredBy` records
   which model scored the soft criteria. When it equals the builder
   (`VALIDITY_BUILDER_MODEL`), the response flags `selfScored: true` and prepends
   a one-line warning — the model is grading its own work. This is a **warning,
   not an error** (it won't block sign-off), but a self-graded soft tier is weak
   evidence: for loop-grade sign-off, have a separate judge model run the
   soft-scoring step and pass its identifier as `scoredBy`.

   **Fresh-context judging is the recommended posture.** Suggest the user set
   `scoring: { judge: 'fresh-context' }` in `.validity/config.ts`. To judge
   blind, spawn a clean subagent with NO build context: either have it call
   `validity__score_soft_criteria({ specId, context: 'fresh' })` (adds the
   blind-judging rubric), or run `validity judge-pack <run-id>` and hand it the
   bundle (`.validity/runs/<run-id>/judge-pack/` — screenshots + frozen rubric +
   `SCORING.md`; no source, no diff, no prompt history). The judge records via
   `validity__record_soft_scores` with its own distinct `scoredBy`. Validity
   warns when the judge identity matches the builder, and an unrecorded judge
   identity badges as self-scored — the posture can't be claimed without
   evidence. Judge mode changes badges and warnings only; verdicts and sign-off
   math are untouched.

Run it for one spec, or wrap it in `/loop` to keep the whole project fresh:
`/loop score Validity's open soft criteria across all specs`.

**The combined model:** `validity verify --all` holds the deterministic tier live; you
(or a `/loop`) score the soft tier on top. They meet at the scorecard — the
watcher never calls you, so the soft tier refreshes only when an agent runs it.
There is no autonomous watcher→LLM bridge; if the user wants the soft tier kept
current hands-free, a `/loop` running the soft-scoring step is the way.

### Onboarding an existing codebase — `validity__onboard_*`

To cold-start specs across a codebase that has none, loop the onboard tools:

1. `validity__onboard_enumerate` — returns a PAGE of components/screens with no
   spec yet (path + source preview + suggested targets + **deterministic DRAFT
   criteria**). Each entry's `draftCriteria` are ≤4 **normative mechanical**
   criteria (renders without error under each scenario, zero console errors,
   accessible names on interactive elements, literal-union variants render,
   known nav edges resolve); anything judgment-flavored is emitted
   `tier: soft, severity: advisory` — **the bulk pass cannot manufacture
   blocking red.** **REVIEW AND EDIT the drafts — do NOT rubber-stamp them.**
   They are mechanical starting points; the agent owns the judgement.
   Paginated so large repos never truncate — re-call with the returned
   `nextCursor` until `hasMore` is false. Every call stamps the coverage
   baseline (first-write-wins) for the final report.
2. For each entry: edit the draft criteria as needed, then
   `validity__spec_create` with `bulk: true` and **one shared `batchId` per
   pass** (so the batch lands on probation — see the invariant below) + the
   criteria + `targets.components = suggestedTargets`, then
   `validity__spec_freeze`. Under `specApproval: 'always'` you cannot freeze
   one at a time — tell the human to run `validity onboard review --approve`
   to approve **and** freeze the whole batch in ONE action (the probation
   marker survives freeze; only a confirmed clean pass clears it).
3. `validity__onboard_progress({ path, status: "done" | "skipped", specId })` —
   records progress so the loop is resumable and converges. Skipped targets
   are excluded from later enumerate pages.
4. When the pass is done, `validity__onboard_report` — coverage before →
   after, per-spec criterion counts by tier (hard / property / soft), and the
   FULL skipped list with reasons (no silent caps, same posture as ripple
   truncation).

**Probation invariant — no high-severity signals from bulk specs until
confirmed once.** A bulk-created spec carries a `probation` marker
(`{ since, batchId }`, excluded from its content hash). Until its **first
confirmed clean pass — an attended `validity__verify`, NOT a watch tick** —
its failures open `needs-review` (low) instead of `regression` (high), so
one wrong bulk spec can't poison the inbox. The watcher never clears
probation; only an attended verify confirms the spec and lifts the marker.

This is a goal/loop: when the user says "onboard Validity" or "create specs for my
components," run it end to end (ideal under `/loop` for a big repo). Skipped
components are excluded from later pages; already-specced ones are auto-excluded.

### Proactive behavior (do this without being asked)

- Starting non-trivial UI work in a Validity project → call `validity__plan`
  first (unchanged), so the new spec joins the scorecard.
- After you change UI a frozen spec targets → re-score that spec's open soft
  criteria so the scorecard doesn't go stale, and mention any new signals.
- User asks "what's the state / what regressed / is everything passing?" → read
  `validity signals list` (or the scorecard file) and report the open signals,
  highest severity first.

## Browse mode — driving a live preview for the user

Validity has a Storybook-style component browser ("browse mode") that boots
its own persistent Vite server and opens a real browser tab. When the user
asks to **see** a component ("show me my Button", "open the LoginForm in
validity", "switch to the dropdown", "render Button with label='Cancel'"),
that's a browse-mode request — they want a tab to look at, not a
screenshot pipeline. Use the MCP tools below to drive it.

**Browse is for the user to look at — not for you to score.** Keep using
`validity__verify` for acceptance scoring. Opening a browser tab proves
nothing.

> **⚠️ Web vs native — read before picking a tool.** `browse_open` /
> `browse_navigate` / `views_*` below are the **WEB** surface (Vite, Next,
> Expo **Web**). If the project is **React Native / Expo** and the user wants
> to _see_ anything — a component, a screen, **or a view/composition** like
> "Button Variants" — use **`validity__native_browse`** (it takes a
> `component` OR a `view` name — its own dedicated args — plus
> fixture/scenario/propOverrides). Do **not**
> open the web browser for a native app, even for views. `native_browse`
> supports views too. (`detectAppTarget`: Expo/RN browse → native.)
> `browse_open` enforces this — on an RN/Expo project it returns an error
> redirecting you to `native_browse` unless you pass `webTarget: true`, which
> you should do only when the user explicitly asked for the web target.

### `validity__browse_open` — start (or reuse) a live session (WEB)

```
tool: mcp__validity__validity__browse_open
args: {
  projectRoot: "<absolute path>",
  component: "src/components/Button.tsx"   // optional
}
```

Boots Validity's persistent Vite sandbox for `projectRoot` (or reuses the
running one) and opens the user's default browser at `/?focus=<component>`.
If you know which component the user wants to see, pass it — the page
lands directly there instead of dumping them on the index. The arg
accepts a project-relative path; pick the best match yourself from the
codebase if the user gave you a casual name ("Button" → `src/components/Button.tsx`).

Returns the URL plus a hint to use `validity__browse_navigate` next.

### `validity__browse_navigate` — drive an already-open tab

```
tool: mcp__validity__validity__browse_navigate
args: {
  projectRoot: "<absolute path>",
  component:    "src/components/Dropdown.tsx",
  scenario:     "logged-in",        // optional
  viewport:     "desktop"|"tablet"|"mobile",   // optional
  propOverrides: { label: "Cancel", disabled: true }   // optional
}
```

Pushes a navigate message to whichever browse tab is currently connected
to the dev server. Use this whenever the user wants to **switch** in an
already-open session — "now show me the dropdown", "switch to the cart",
"open the login form." It's strictly server→page; the tab won't talk
back. If the user closed the tab the tool will error and tell you to
reopen.

**Components gallery all their variants by default.** Navigating to a
component renders one frame per fixture on the canvas — and when the
component has no authored fixtures, Validity auto-enumerates
literal-union props (`variant: 'primary' | 'ghost'`, `size: …`) into
labeled variant fixtures. So "show me my buttons" is ONE navigate call;
don't loop over fixtures or build a view just to show variants. The same
default applies on native: `validity__native_browse` renders a
multi-fixture component as one scrollable gallery of labeled variants
(pass `fixture` or `propOverrides` to get a single render instead).

**`propOverrides`** is the live-edit lever — push explicit prop values
without touching `.validity/config.ts`. Pair with requests like "render
the button with label='Cancel'": one `validity__browse_navigate` call
with `propOverrides: { label: 'Cancel' }`. The overrides merge over the
component's auto-mocked / fixture defaults at mount. Pass
`propOverrides: null` to clear.

### When to use which

- "Show me X" / "open X in validity" → `validity__browse_open({ component: X })`
- "Switch to Y" / "now show Y" in an already-open session →
  `validity__browse_navigate({ component: Y })`
- "Render X with prop A=…" / "show the disabled state of Y" →
  `validity__browse_navigate({ component, propOverrides: { … } })`
- "Verify the new button works" / "check the dashboard against the spec"
  → still `validity__verify`, NOT browse. Browse is preview only.

### Discovering the library — `validity__catalog` + `validity__resolve`

Before driving browse, you can ask Validity what the project actually
contains — no guessing from filenames.

- **`validity__catalog`** — lists the component / screen / view library:
  `validity__catalog({ projectRoot })`. Each entry shows its path, kind,
  route (screens), fixture count, and usage (which screens import a
  component / which components a screen uses). Filter with `kind`
  (`'component' | 'screen' | 'view'`) or a `query` substring, and pass
  `includeProps: true` for prop-type summaries. It's a cheap read — call it
  freely when the user asks "what components do I have" or before you pick a
  path to show.

- **`validity__resolve`** — turns a casual name into a concrete path:
  `validity__resolve({ query: "the login form" })`. Returns one confident
  match (then open it with `validity__browse_open`), or — when two entries
  tie — the candidate list. **On a tie it does not pick for you**: surface
  the candidates and ask the user which one (don't infer the target).

Use these to make "show me my Button" reliable: `resolve("button")` →
`browse_open({ component: <resolved path> })`. If `resolve` comes back
ambiguous, ask before opening.

### Design tokens — `validity__tokens`

When the user asks for a visual/design change in token terms ("make the
primary warmer", "bump the base radius", "tighten the body font"), call
`validity__tokens({ projectRoot })` first. It reports the project's CSS
custom properties (from `:root` / Tailwind `@theme`) and Tailwind theme
colors **with the source file each lives in** — so you edit the right token
in the right file. Filter with `group` (`color | spacing | font | radius |
shadow`).

**Validity is the eyes here, not the hands.** It does not write tokens.
Read the token + its source, make the edit in that source file yourself,
then re-render (browse or verify) to see the result. This keeps the design
change in the codebase (reviewable, committable) rather than in a throwaway
in-tool editor.

### Views — composing multiple frames on one canvas

`validity__views_create` saves a named **view**: a composition that renders as
separate device **frames** on the browse canvas. Reach for it when the user
wants several things side by side — "a view of all my Text sizes", "my Button
plus the Login and Settings screens", "save this layout as a view".

How items become frames (this is the important part):

- Items passed **without** a `frame` auto-group by `componentPath`. Variants of
  the **same** component collapse into **one** frame (e.g. every Text size = one
  spec-sheet frame); **distinct** components/screens each get their **own** frame
  (e.g. Button + 2 screens = one Button frame + two screen frames).
- Set an explicit `frame: "<id>"` to override: the **same** id on **different**
  components groups them into one frame; **distinct** ids on the **same**
  component split it across separate frames.

**Ask before guessing.** When the grouping isn't obvious — e.g. the user lists
several different components and it's unclear whether they belong in one frame
or separate ones — confirm with the user rather than picking silently. The
auto-group-by-component default only covers the clear cases ("all the X
variants" → one frame; "X and these screens" → X's frame + a frame per screen).

Render a view **on web** with `validity__browse_navigate({ view: "<name>" })`
— **but if this is a React Native / Expo app, render the view on the simulator
with `validity__native_browse({ view: "<view name>" })` instead** (pass the
view name as the dedicated `view` arg and it mounts the composition
natively). A name
matching a component/screen **path** is always rejected; a name matching an
**existing view** is rejected unless you pass `force: true` to overwrite it.
Either way you get a structured error — surface it verbatim, don't invent your
own wording. The browse viewport control is single-select (Desktop | Tablet |
Mobile): switching it re-renders every frame at that one device size.

### Fallback — `validity browse` CLI

If for some reason the MCP tools aren't available (very old install, the
MCP server hasn't reconnected, etc.), the CLI is still a working surface:
`validity browse <component>` from a terminal does the same thing.
**Don't reach for it when the MCP tools are present** — Bash invocations
are slower, produce noisier output, and don't keep the session under MCP
control for follow-up navigation. Use the MCP tools by default.

### Other browse facts worth knowing

- `node_modules/.validity/.browse.lock` indicates a browse session is
  live. Your `validity__verify` calls automatically reuse that Vite
  server (faster — no cold start), so you don't need to do anything
  special with it.
- Browse renders the same components, with the same wrapper, the same
  `mockNetwork`, and the same fixtures as verify. If a fixture looks
  right in browse, it'll look right in verify.
- Browse has a "Save as fixture" button (in the inspector flyout) that
  writes a fixture entry into `.validity/config.ts`. If the user
  mentions they just saved one, you can render it next verify by
  passing `changedFiles: ['<component path>']`.
- Like verify, browse runs Validity's own Vite — Hard Rule #1 still
  applies. Do NOT start `npm run dev` / `pnpm dev` / `yarn dev`.
- Scenarios still apply to verify renders via `.validity/config.ts`, but
  the browse UI no longer surfaces a scenario picker — `propOverrides`
  on `validity__browse_navigate` is the live-edit lever.

## `validity export` — Playwright scaffolds from a verify run

After a verify run lands clean, the user can run
`validity export <run-id> --target=playwright [--out tests/e2e/]` to turn
that run into Playwright `.spec.ts` scaffolds and commit them as
regression tests. Validity translates:

- `mockNetwork.handlers` → `page.route(...)` calls
- `mockNetwork.cookies` → `context.addCookies(...)`
- `mockNetwork.localStorage` / `sessionStorage` → `context.addInitScript(...)`
- scenario's `play({ page })` body → inlined Playwright code
- each acceptance criterion → a `test.step('TODO assertion: ...')` block

**This is a scaffold generator, not test generation.** Every emitted
`test.step` is a TODO the user is expected to replace with a real
`expect(...)` before the spec is worth running. The CLI prints that
caveat. Don't oversell the feature to the user when they ask about it.

Only `--target=playwright` is supported in this version. Cypress and
Maestro export are explicitly NOT supported — if the user asks for
them, say so honestly.

You don't need to call this yourself: it's a CLI surface the user
runs after a green verify when they want to commit a regression test.
Keep using `validity__verify` for acceptance checks.

## Mobile — React Native playground

Beyond Expo **Web**, Validity has a React **Native** playground
(`@validity.ai/verify-native`, renderMode `'native'`) that renders the REAL React Native
build on a booted simulator / emulator (the Validity companion app). It mirrors
web exactly, in two tools:

- **`validity__native_browse`** — the native analog of **browse**: mount ONE
  component / screen / view to **look** at it (preview, no report).
- **`validity__verify({ native: true })`** — the native analog of **verify**:
  the same **plan → verify → submit_report** contract web uses, just driven onto
  the device instead of the Vite sandbox (see "Native verify" below).

Both use the SAME target contract as web
(`?component=&fixture=&scenario=&overrides=<b64>`), delivered via a deep link,
and the SAME `.validity/config.ts` mocks.

What's mocked for you (no extra config — it reuses `.validity/config.ts`):

- **Network** — your `mockNetwork.handlers` are translated to `msw/native`.
- **Navigation** — `useNavigation()` / `router.push()` are stubbed to
  _record_ calls, so an isolated screen that navigates doesn't crash.
- **Auth/storage** — `mockNetwork.asyncStorage` seeds AsyncStorage before mount.

Native modules run for real on the device. Config knobs live under `native`
in `.validity/config.ts` (`scheme`, `target: ios|android|expo-go`,
`recordReplay` — the `.ad` replay recording, on by default).

### `validity__native_browse` — drive the simulator

```
tool: mcp__validity__validity__native_browse
args: {
  component: "Button",            // name or path; resolved like validity__resolve
  view:      "Button Variants",   // OR a view name — mutually exclusive with component, pass one
  platform: "ios" | "android",    // optional; defaults to native.target / ios
  scheme: "...",                  // optional OVERRIDE; defaults to native.scheme, else a
                                  // companion-unique derived scheme — never pass the app's own scheme
  device: "<udid|serial>",        // optional; auto-pinned when ONE device is booted; with
                                  // several booted, the call errors with MULTIPLE_DEVICES + the list
  fixture / scenario / propOverrides   // optional, same contract as web
}
```

It mounts that component — **or a named view** (a multi-component
composition, same as web; pass the view name as the dedicated **`view`** arg,
NOT `component`, and it's resolved/rendered as a stacked composition) — in
isolation on the booted
device (via **agent-device**, Callstack's MIT device-automation CLI) and
returns a **screenshot + accessibility snapshot**. Components, screens, views,
fixtures, scenarios, and prop overrides all work, matching the web sandbox.
Use it BOTH ways:

- **"show me my Button in the simulator"** → call it, look at the screenshot.
- **"build this feature and validate it works"** (native) → after your code
  change, call it and **score the returned screenshot + a11y tree against the
  plan**, exactly like `validity__verify` on web. The playground applies the
  SAME mocked network/nav/auth.

**Stale UI after an edit → `reload: true`.** Fast Refresh normally pushes
source edits to the device live, but if the screenshot after your edit shows
the OLD UI (the device's HMR socket can die when Metro restarts), do NOT keep
re-editing or second-guessing your change — call `native_browse` again with
`reload: true`. That refreshes the companion with a guaranteed-fresh bundle
(an in-place reload when the companion is live; a cold relaunch as the last
resort). Validity does this automatically whenever the running bundle is
provably stale; the explicit flag is your recovery for everything else.

CLI equivalent: `validity browse --native <component> [--platform] [--scheme]`.

**No flipping your app root.** Validity builds a SEPARATE "Validity" app
(its own bundle id / scheme) and installs it beside your real app in the same
simulator — your app is never edited or swapped. The companion app shares your
project's `node_modules`, so your native modules autolink and render for real.

**Prerequisites (the tool tells the user if missing, it doesn't crash):** a
booted iOS Simulator / Android emulator; `agent-device` on PATH (`npm i -g
agent-device`) for capture; the mocking dev deps (`msw`,
`react-native-url-polyfill`, `fast-text-encoding`,
`@react-native-async-storage/async-storage`). The FIRST call builds the
companion app once (`expo run:ios|android`, a few minutes); every later call
just deep-links + screenshots automatically. Native verify runs in CI on a simulator/emulator-equipped runner (iOS on macOS
with Xcode, or Android with the SDK + an AVD via `--native-avd` / `--native-apk`).
Ordinary headless web CI covers web specs only. agent-device (MIT) is the default
driver; `@swmansion/argent` is a pluggable alternative (note its proprietary
iOS-binary license terms).

### Native verify — `validity__verify({ native: true })`

`native_browse` is for **looking** (one component at a time, no report). For the
full **plan → verify → submit_report** contract on native, call `validity__verify`
— it is the native sibling of isolation/URL mode. **On an RN/Expo project this
is already the default**, so `native: true` is only needed to force the device
path somewhere detection can't see it (e.g. a mixed repo whose root looks like
a web app). Passing it on an RN/Expo project is harmless and redundant:

```
tool: mcp__validity__validity__verify
args: {
  prompt: "...",                  // required, same as web
  native: true,                   // route to the simulator instead of the Vite sandbox
  planId: "...",                  // re-injects the persisted plan criteria (same as web)
  changedFiles: [...],            // selects the components to render (same heuristic as web)
  scenarios: [...],               // fan each component across scenarios
  platform / device / scheme / reload   // optional native knobs (see native_browse)
}
```

What it does, in ONE warm session: selects the changed component(s) like
isolation mode, drives each onto the pinned device (navigate → ack → screenshot),
and writes the SAME `run-meta.json` web does — so the response carries a
`Run: <runId>` and **`validity__submit_report({ runId, planId })` works exactly
the same on native** (it produces `report.html` with the native screenshots +
your plan criteria). Score the returned screenshots + a11y snapshots against the
plan, then submit the report — don't skip it.

Native specifics to know:

- **Render status is authoritative.** A render that the device could not confirm
  comes back as a `RENDER_FAILED` / `RENDER_UNCONFIRMED` block instead of a
  screenshot — that is a real failure to score (or retry with `reload: true`),
  never a passing image. A deliberately-broken component yields a render error,
  not a scored screenshot.
- **Mock-network state is reported.** The response leads with
  `MOCK_NETWORK: ACTIVE` (screens served by your fixtures) or
  `MOCK_NETWORK: DISABLED (reason)`. If it's DISABLED, the screens hit the REAL
  network — do **not** score fixture-dependent criteria as if mocks applied; fix
  the mock setup (`msw` / polyfill dev deps, `.validity/config.ts mockNetwork`)
  and re-verify.
- **Fanout is capped** at a handful of renders per call (one device renders
  serially, unlike web's parallel sandbox). If you pass more (component × scenario)
  targets than the cap, the response says how many were truncated — narrow
  `changedFiles` / `scenarios` or run another native verify to cover them.
- **The run records a replayable `.ad`.** A native verify saves its device
  session as an agent-device replay script at `<run-dir>/replay.ad` — the
  deep-link `open` plus a `wait` on the run's render marker as the destination
  guard — and signs its sha256 into `attestation.json` as a third signature.
  `validity replay <run-dir>` hands it back to `agent-device replay`, which
  re-verifies the destination element by its RECORDED IDENTITY, not just its
  label; that lane is attach-only (no boot, no install) and exits 3 with a
  named notice when no device is attached. On by default; set
  `native.recordReplay: false` to skip it. Upstream allows ONE recording per
  device session, so in a `verify --all` sweep it lands in the run dir of the
  spec that opened the session — the other runs having none is not a failure.

Same prerequisites as `native_browse` (booted device + companion dev build);
still can't run in CI.

## Expo Web — what's exercised, what isn't

The **Expo Web** target is Expo's web build: React Native primitives mapped
onto DOM nodes through `react-native-web`. It is **opt-in and never
automatic** — `framework: 'auto'` on an Expo project deliberately REFUSES a
web render rather than quietly substituting one, because the browser is not
the runtime the app ships on. To use it, the project pins
`framework: 'expo-web'` in `.validity/config.ts`, or a single call passes
`webTarget: true` (`validity browse --web` on the CLI). Otherwise Expo and
bare-RN projects validate on a simulator/emulator.

Read the rest of this section as the case FOR the device, not as a menu.

**What works** (verified visually in screenshots):

- `<View>`, `<Text>`, `<Pressable>`, `<TouchableOpacity>`, `<Image>` —
  the core RN primitives.
- `<FlatList>` and `<ScrollView>` — render as scrollable DOM containers.
- Styles via `StyleSheet.create` — RN-Web translates them to CSS.
- `expo-router`'s `<Slot/>` mounts as a passthrough; Validity inserts
  `{children}` at that splice point automatically.

**What's NOT exercised** by the **Expo Web** target (these need the native
runner — `native_browse` / `validity__verify({ native: true })` on a booted
device, see "Mobile — React Native playground" above):

- `react-native-reanimated` worklets — Validity routes to the
  package's `/mock` entry (or a passthrough stub). Animations don't
  run; final-frame styles are captured.
- `react-native-gesture-handler` — passthrough stub. Pan/swipe/long-press
  gestures aren't simulated.
- Native modules (`NativeModules.X`, anything that talks to platform
  APIs) — will throw at runtime and surface as a render error.
- `Platform.OS === 'ios' | 'android'` conditional code paths —
  RN-Web reports `Platform.OS === 'web'`, so platform-specific branches
  take the web path.

That list is why Expo Web is not the default. Even when it renders cleanly,
it silently skips gestures, animations, native modules, and every
`Platform.OS`-conditional branch — so a green Expo Web run can coexist with a
broken app on device, and nothing in the screenshots would say so. If the user
opted into Expo Web, say plainly in your summary which parts of their UI it
could not exercise. Otherwise use the native runner (`native_browse` preview
or `validity__verify` on an RN/Expo project, which is native by default) on a
booted simulator — it renders the real React Native build.

## Next.js — what works, what doesn't

Validity supports Next.js projects by rendering the **client-component
subset** through the web target. When `detectFramework()` sees `next` in
`package.json` (or finds `next.config.{js,ts,mjs}`), the sandbox routes to
the `next-web` prepare path — the standard Vite web sandbox with `next/*`
imports aliased to DOM-friendly stubs. `framework: 'auto'` does the right
thing; you can also pin `framework: 'next'` explicitly.

| Feature                         | Exercised | Notes                                            |
| ------------------------------- | --------- | ------------------------------------------------ |
| `'use client'` components       | yes       | Rendered through Vite + React                    |
| `next/link`                     | yes       | Stubbed to `<a href>`                            |
| `next/router` (Pages)           | partial   | Mock router — navigation calls are no-ops        |
| `next/navigation` (App)         | partial   | Mock `useRouter`/`usePathname`/`useSearchParams` |
| `next/image`                    | yes       | Renders `<img>` (no optimizer)                   |
| `next/font`                     | no        | Stubbed to empty className                       |
| Server Components               | no        | Requires a server runtime — out of scope         |
| Route Handlers / API routes     | no        | Not UI                                           |
| Middleware                      | no        | Edge runtime — out of scope                      |
| `next/headers` / `next/cookies` | no        | Server-only — stubbed to **throw**               |

Server Components, Route Handlers, and Middleware are out of scope. The
server-only `next/headers` / `next/cookies` stubs **throw** when called
rather than silently no-op, so a component reaching for a server-only API
surfaces as a render error — never a false-green blank screenshot. Validity's
value is verifying UI, which is overwhelmingly client components.

**Validity names the split for you.** On a Next project, `validity__catalog`
and `validity__verify` report which files are client-verifiable and which are
Server Components, e.g. `Excluded (server component, no 'use client'):
app/page.tsx · Verifiable: components/Button.tsx, …`, with the same split in
`structuredContent.rsc`. A file is called a server component when it lives
under `app/` (or `src/app/`) and has no `'use client'` directive prologue —
Pages Router files and anything with the directive are verifiable. To verify a
server component's UI, extract the interactive part into a `'use client'`
component and target that, or verify the rendered page in URL mode
(`validity__verify({ url })`) against the running `next dev`.

A Next app should also have `@validity.ai/verify-plugin-next` wired (see "App
plugins" above): without it the sandbox sees no `.env*` (every
`NEXT_PUBLIC_*` branch renders its fallback), no tsconfig `paths` aliases,
and no PostCSS/Tailwind config. `validity init --plugins` wraps
`next.config.*` with `withValidity(...)`; the manifest is written during the
user's own `next dev`. If a Next verify shows empty env or unstyled
Tailwind, recommend that wiring first — it is the fix, not a workaround.

## Important conventions

- **Always pass the user's original prompt verbatim** in the `prompt` arg.
  Don't paraphrase — your own scoring relies on the actual words the user
  used.
- **Don't run Validity on every edit** — only after a meaningful chunk of
  work that changes rendered output. It's an end-of-loop check, not a linter.
- **Never claim a feature is done because the build passed and types are
  clean.** Those are necessary, not sufficient. Looking at the rendered
  screenshot is what tells you the user-visible behavior is right.
- **Don't ignore "unverifiable" criteria.** Usually the renderer didn't reach
  the relevant state. Fix the wrapper / config so the component renders in
  the verifiable state, then re-run.
