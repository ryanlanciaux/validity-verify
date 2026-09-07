// Canonical help text rendered by `validity help` and shipped as
// `packages/skill/validity/HELP.md`. The skill falls back to reading HELP.md
// when the `validity` binary isn't on PATH, so the two must match byte-for-
// byte. A vitest test (`help-text.test.ts`) enforces that.

export const HELP_TEXT = `# Validity — quick reference

Validity verifies what your AI agent claimed to build. After UI changes, it
renders components in an isolated Vite sandbox, captures screenshots, and the
agent scores them against the user's acceptance criteria.

Supported toolchains: **Vite + React**, **Next.js** (client components), and
**React Native / Expo** — rendered on a real simulator/emulator through the
Validity companion app. Expo's \`react-native-web\` build ("Expo Web") is
available as an opt-in, never as an automatic substitute for the device.

## If the user isn't set up yet

Two options, both better than reconstructing the sequence from memory:

- **Do it for them.** Run \`validity start --prompt\` — it emits a prompt
  covering every remaining setup step for THIS project, ending in a smoke
  test. Follow it. Stop and ask when it says a step needs the user (Xcode,
  an Android SDK).
- **Hand it over.** Tell them to run \`validity start\` in their project
  directory. It prints the single step they're on plus its exact command, and
  they re-run it after each step.

Don't send them to \`validity doctor\` first — that answers "is anything
broken?", which is the wrong question before anything has run.

**Already-configured React Native projects.** A project set up before RN
defaulted to the device still has \`renderMode: 'web'\` in \`.validity/config.ts\`
(init never rewrites an existing config). Verify routes to the device anyway,
but that value stamps a spec's \`runtime\`, so new specs become web specs and
then fail in \`validity verify --all\`. \`validity doctor\` flags it as
**validation target**; the fix is \`renderMode: 'native'\` +
\`framework: 'expo-native'\`, plus \`runtime: web\` → \`runtime: native\` in any
existing \`.validity/specs/*/spec.yaml\`.

## When to use

- The user asked for a UI/UX change with a spec, checklist, or acceptance
  criteria.
- The user said "validate", "verify", "check this matches the prompt", or
  "did it actually work?".
- You're about to declare a UI task done.

Skip for: pure refactors with no rendered output change, backend-only changes,
doc-only edits.

## The three-call flow (or two for trivial tweaks)

For **non-trivial UI work** (multiple requirements, new components, new
features), the flow is three MCP tool calls:

1. \`validity__plan\` — BEFORE you do the work. Extract structured
   acceptance criteria from the prompt; Validity validates the shape +
   persists them; returns a \`planId\`. Surface the criteria in your reply
   so the user can correct misinterpretation early.
2. \`validity__verify({ planId })\` — after the work. Renders the
   components and returns screenshots + the persisted criteria as the
   explicit scoring rubric.
3. \`validity__submit_report({ planId })\` — score the criteria, send the
   verdict + per-file notes back. Returns a clickable \`file://\` URL.

For **trivial tweaks** (one-line styling, typos, single-prop changes)
skip \`validity__plan\` and call \`validity__verify\` directly with just the
prompt. The plan ceremony costs more than it adds when there's only one
requirement.

Don't skip \`submit_report\` unless \`.validity/config.ts\` has
\`report: false\`.

**Lean responses.** Re-verifying a spec with prior runs defaults to
\`detail: 'lean'\`: verdicts, regression deltas, and \`structuredContent\`
stay whole, but screenshots that provably changed nothing (all checks
pass, no soft criterion open, pixels byte-identical to the previous run)
are omitted, and already-scored soft criteria are carried forward
explicitly. The first verify of a spec is always full. Pass
\`detail: 'full'\` to force every screenshot + source. Presentation-only —
the gate and everything on disk are unchanged.

## Why \`validity__plan\` exists

The same model extracts criteria AND scores against them. Without a
persisted plan, the criteria can drift between build-time interpretation
("what should I build for?") and verify-time interpretation ("what
should I score against?"). Persisting them locks the contract — build
and verify use the same rubric, so misinterpretation can't slip through
twice.

## The two modes

- **Isolation (default).** Validity's own Vite sandbox renders one component
  wrapped in your provider stack (\`.validity/wrapper.gen.tsx\`, generated
  from your real entry file, optionally composed with a hand-written
  \`.validity/wrapper.user.tsx\`). Use whenever the user is asking about
  a _component_.
- **URL (opt-in).** Playwright drives the user's already-running dev server.
  Use only when the prompt is page/route/flow-shaped _and_ the user already
  started their dev server.

## Hard rules

1. **Never start the project's dev server.** Isolation mode is the default;
   if you reach for \`npm run dev\` / \`pnpm dev\` / \`yarn dev\`, stop and use
   isolation.
2. **For login-gated UI, do not log in through the real app.** Seed cookies,
   \`localStorage\`, \`sessionStorage\`, and fetch handlers in
   \`.validity/config.ts\` scenarios, then pass \`scenarios: ["logged-in"]\`.
3. **Isolation is not a fallback.** If isolation throws a render error, read
   the message and fix the wrapper or scenario — do not "escape" to URL mode.
4. **Never validate a React Native app through a browser.** On Expo / bare-RN
   projects, \`validity__verify\` and browse both go to a simulator/emulator
   automatically. The \`react-native-web\` proxy is a different runtime than the
   app ships on, so a pass there is not a pass. Use it (\`webTarget: true\`,
   \`validity browse --web\`, or \`framework: 'expo-web'\` in config) only when
   the user explicitly asked for the web target — never because a device is
   missing, slow, or unbuilt. If no simulator is booted, say so.

## Three levers

- **Scenarios** — global, per-render network/auth state (who is signed in,
  what the API returns, what's in localStorage). Pass via \`scenarios: [...]\`
  to \`validity__verify\`.
- **Fixtures** — component-scoped prop sets that drive a component into a
  known visual state. When a component has fixtures, scenarios are ignored
  for that component.
- **Play** — async callback (\`{ page }\`, real Playwright) that drives the
  rendered DOM before the screenshot. Use for hover/focus, opened menus,
  form-after-submit. Capped at 10s.

## App plugins (wired by \`validity init\`, close real fidelity gaps)

- \`@validity.ai/verify-plugin-vite\` — add \`validity()\` to the app's
  \`vite.config.ts\` (or run \`validity init --plugins\`). It writes
  \`.validity/app-manifest.json\` (generated + committable; don't hand-edit),
  and the sandbox then uses the app's REAL \`.env\`, PostCSS config, and entry
  module. Diagnostic shortcut: "unstyled render on a Tailwind v3 project" and
  "\`import.meta.env.VITE_*\` is empty" are fixable setup problems — install
  the plugin — not Validity bugs. Opt-out: \`web: { useAppManifest: false }\`
  in \`.validity/config.ts\`. First run after install can change screenshots
  (the real \`.env\` now loads) — expected, one-time. TanStack Start apps are
  Vite apps — this is their plugin too.
- \`@validity.ai/verify-plugin-next\` — the same manifest, produced by a Next.js app.
  Wrap the export in \`next.config.{js,mjs,ts}\` with
  \`withValidity(...)\` (or run \`validity init --plugins\`). It returns the
  config unchanged — the only effect is writing
  \`.validity/app-manifest.json\` during \`next dev\` — so the sandbox picks up
  the app's real \`NEXT_PUBLIC_*\` env, tsconfig \`paths\` aliases, and
  PostCSS/Tailwind setup instead of guessing at them.
- \`@validity.ai/verify-plugin-expo\` — an Expo config plugin for the USER'S app: it
  guarantees the app owns a deep-link URL scheme (needed for \`.ad\` device
  journeys and dev-client opens) and carries the mocking deps. Add
  \`"plugins": ["@validity.ai/verify-plugin-expo"]\` to the Expo config, or run
  \`validity init --plugins\`. It never touches the Validity companion app
  and never registers a \`validity-*\` scheme on the user's app.

\`validity init\` wires plugins BY DEFAULT, picking the web plugin by what
the app actually builds with — plugin-next for a Next.js app, plugin-vite
otherwise (there is no separate flag for it). \`--no-plugins\` skips wiring;
\`--plugins=web|native|all\` scopes it explicitly. Configs that can't be
edited provably safely get a printed paste stanza instead of a rewrite, and
re-runs report 'unchanged' — an existing project is never re-edited.

## Render errors are bugs in the user's project

If \`validity__verify\` returns \`render error: <message>\`, the error came
from the user's React tree. Read the message literally — it points at user
code (missing Provider, mismatched react/react-dom versions, invalid URL
passed to a client library, etc.). **Do not investigate Validity's own
source.** Add the missing Provider to \`.validity/wrapper.user.tsx\` (Validity
composes it around the generated tree on every render), then re-run verify.
Two or three iterations is normal for a deeply-providered tree.

## Scoring rubric

For each screenshot:

1. Read the screenshot — it's the ground truth, not the source.
2. Extract acceptance criteria from the user's prompt verbatim.
3. For each criterion: pass / fail / unverifiable. Quote what you saw.
4. Mark \`unverifiable\` only when the screenshot truly cannot show it
   (animations, click handlers) — not when you're just unsure.
5. Emit verdict + criteria as JSON in \`validity__submit_report\`, then
   summarize for the user in plain prose.

All criteria pass → say so concisely, mention the runId, stop. Some fail →
fix what's clearly fixable and re-verify; surface ambiguous cases to the
user. Two iteration loops is fine; after that, surface failures instead of
grinding.

## \`validity export <run-id> --target=playwright\` (for the user)

After a verify run, the user can run
\`validity export <run-id> --target=playwright [--out tests/e2e/]\` to turn
that run into Playwright \`.spec.ts\` **scaffolds**. The exporter translates
the run's \`mockNetwork\` handlers into \`page.route()\` calls, the scenario's
\`cookies\` / \`localStorage\` into pre-navigation seeds, the \`play({ page })\`
body into inline code, and each acceptance criterion into a
\`test.step('TODO assertion: …')\` block.

**This is not test generation. It's boilerplate elimination.** Every
emitted \`test.step\` is a TODO — the user replaces it with a real
\`expect(...)\` before the spec is worth running. The CLI prints that
caveat on every successful export.

This legacy run-exporter only supports \`--target=playwright\`; Cypress /
Maestro are NOT supported here and the CLI errors instead of falling back.
(The separate **spec** exporter — \`validity spec export\`, below — DOES emit
Maestro for native specs; this restriction is only about \`validity export
<run-id>\`.)

You should keep using \`validity__verify\` for acceptance checks — the
exporter is a one-shot hand-off the user runs themselves.

## \`validity browse\` (for the user, not for you)

The user can run \`validity browse\` from their project root to open a
Storybook-style component browser. It boots Validity's own Vite (not the
project's dev server — Hard Rule #1 still applies) and prints a URL. If a
browse server is running, your \`validity__verify\` calls automatically
reuse its port (faster verifies).

You should keep calling \`validity__verify\` for acceptance checks. Browse
is the user's developer-iteration lane.

## React Native / Expo — the device is the default

Expo and bare React Native projects validate on a booted iOS Simulator /
Android emulator via the Validity companion app. \`validity__verify\` routes
there on its own (no \`native: true\` needed), \`validity browse\` opens the
device playground, and \`validity__browse_open\` refuses and redirects you to
\`validity__native_browse\`. The first native call runs a readiness check and
builds the companion once; later calls are instant.

**Remote devices (advanced).** \`native: { remote: { configPath: '...' } }\` in
\`.validity/config.ts\` points at an agent-device remote profile (cloud
provider, proxied Mac, BrowserStack/Limrun/AWS Device Farm — see
\`agent-device help remote\`). Every device command Validity spawns then
carries \`--remote-config <path>\`; unset changes nothing. Requires
agent-device 0.20.5+ (the enforced floor).

**Device evidence (advisory).** \`native: { deviceEvidence: true }\` (default
false) captures perf metrics/frame health and a network summary through the
verify capture's own device session into \`<run-dir>/device-evidence.json\`,
rendered as an advisory, never-scored Device evidence section in the report.
Costs two extra agent-device spawns per capture; it never affects a verdict.
The report's Setup panel also states the render environment (target,
dev-server provenance, Tailwind shim, app-manifest mirrored/recorded, dep
pre-scan) whenever any of it is notable.

**Expo Web is opt-in.** \`framework: 'auto'\` deliberately REFUSES a web render
on an Expo project instead of quietly substituting \`react-native-web\`. When
the user does ask for it, the core RN primitives (\`<View>\`, \`<Text>\`,
\`<FlatList>\`, \`<Image>\`, \`<ScrollView>\`), StyleSheet styles, and \`expo-router\`
navigation render visually in screenshots — but animations
(\`react-native-reanimated\`), gestures (\`react-native-gesture-handler\`), native
modules, and \`Platform.OS === 'ios'/'android'\` conditional branches are **not**
exercised. That gap is why it is never chosen for the user: a green Expo Web
run can sit on top of a broken app on device and nothing in the screenshots
would say so.

## Next.js — what works, what doesn't

For Next.js projects, Validity renders the **client-component subset**:
Pages-Router and \`'use client'\` App-Router components render through the web
Vite sandbox with \`next/*\` imports aliased to DOM-friendly stubs.

| Feature                         | Exercised | Notes                                            |
| ------------------------------- | --------- | ------------------------------------------------ |
| \`'use client'\` components       | yes       | Rendered through Vite + React                    |
| \`next/link\`                     | yes       | Stubbed to \`<a href>\`                            |
| \`next/router\` (Pages)           | partial   | Mock router — navigation calls are no-ops        |
| \`next/navigation\` (App)         | partial   | Mock \`useRouter\`/\`usePathname\`/\`useSearchParams\` |
| \`next/image\`                    | yes       | Renders \`<img>\` (no optimizer)                   |
| \`next/font\`                     | no        | Stubbed to empty className                       |
| Server Components               | no        | Requires a server runtime — out of scope         |
| Route Handlers / API routes     | no        | Not UI                                           |
| Middleware                      | no        | Edge runtime — out of scope                      |
| \`next/headers\` / \`next/cookies\` | no        | Server-only — stubbed to **throw**               |

Server Components, Route Handlers, and Middleware are out of scope. The
server-only \`next/headers\` / \`next/cookies\` stubs **throw** when called rather
than silently no-op, so a component reaching for a server-only API surfaces as
a render error, never a false-green blank screenshot.

## Specs — durable, reviewable, exportable (advanced)

\`validity__plan\` now creates and freezes a versioned **spec** under
\`.validity/specs/<id>/spec.yaml\` (the returned id is what you pass as
\`planId\`). The solo three-call flow is unchanged. When a contract needs
review, use the lifecycle tools: \`validity__spec_create\` →
\`validity__spec_review\` (structured findings) → \`validity__spec_update\` →
\`validity__spec_freeze\`, then \`validity__verify({ planId: "<specId>" })\`.

Criteria have **tiers**. \`hard\`/\`property\` criteria carry a structured
\`checks\` block (navigate/click/press/hover/fill/wait/waitForRequest/select/scroll/expect) that Validity runs
**deterministically** — mechanical PROOFS, reported separately from \`soft\`
criteria you score from the screenshot. Never present a soft score as proof.

Every spec carries a **derived maturity level** — probation → dev → team →
certified — computed from properties the system already records (never an
authored field). \`certified\` means the frozen contract is CURRENTLY PROVEN:
every gate-relevant criterion passes on fresh, untainted evidence at the
current frozen content, held across consecutive clean verifications at
distinct commits. Export health is a separate, optional **portable** badge
(shown only when \`.validity/config.ts\` has an \`export\` stanza) — it never
moves the level. \`spec ls\` shows the level; \`spec show <id>\` lists the
exact steps to the next rung (the hardening backlog).

CLI (for the user):

- \`validity spec ls|show|freeze\` — list / inspect / lock specs (ls shows
  MATURITY; show prints the path-to-certified backlog).
- \`validity spec export <id>\` — deterministically compile a spec into
  \`.validity/exports/\` (Playwright for web, Maestro for native) + a manifest
  row; hard checks become real assertions, soft criteria become
  \`test.fixme\` stubs (each stub is an export warning — zero warnings ⇒
  portable). Maestro (native) export is a PREVIEW parked behind
  \`export.maestro.enabled: true\` — only element-visibility checks map
  cleanly, so native export refuses without the opt-in. When enabled, flows
  are runnable (\`maestro test\`): a launch preamble +
  \`export.maestro.routes\` navigation bridge Validity's isolated render to the
  whole app — run them against a release/preview build. Author native selectors
  with \`selector.testId\` when the source exposes a \`testID\` (exports as a
  durable \`id:\`; \`text:\` matchers are flagged i18n-risk).
- \`validity spec export --all\` — export every export-eligible frozen
  spec (\`--allow-stubs\` to export lossy ones too — they are never portable).
- \`validity spec export --check [--fix]\` — the CI drift gate: recompiles
  every exported artifact and byte-compares (hand edits, stale specs, and
  exporter upgrades all fail with distinct causes; \`--fix\` regenerates).
- \`validity spec export --run [--platform ios|android] [--device <id>]\` —
  execute the exported Maestro flow(s) on a booted device through
  agent-device's Maestro engine (0.20.5+). The verdict is recorded on the
  exports manifest and a failed/unsupported run blocks the portable badge;
  a flow nobody has run keeps its standing. \`--dry-run\` validates the
  flows against the engine's supported subset with no device at all.
  \`export.maestro.run\` in \`.validity/config.ts\` supplies default
  \`platform\`/\`device\` bindings (per-field: explicit flags win, config
  fills what the command line omitted, neither set uses the active
  session); the run stanza never affects exported bytes or
  \`spec export --check\`.
- \`validity verify --all --changed [--report junit]\` — re-run every changed
  spec's mechanical checks (CI/regression; no LLM).

## Command criteria — repo-level typecheck/test/lint proofs

Declare NAMED commands in \`.validity/config.ts\`:

\`\`\`ts
commands: {
  typecheck: 'tsc --noEmit',
  test: 'vitest run',
},
\`\`\`

A spec criterion can then assert one with the \`command\` expect family:
\`checks: [{ expect: { command: { run: 'typecheck', exitCode: 0 } } }]\`.
The frozen spec carries only the NAME — never a shell string — and Validity
runs the resolved command ONCE per verify run (cwd = project root, \`CI=1\`,
180s default budget; tune with \`commandTimeoutMs\`). The exact resolved
command is stamped into the verdict, so a post-freeze config edit is
auditable. A name that isn't configured scores \`unverifiable\` (never
pass); a timeout or wrong exit code is a \`fail\`. When \`tsconfig.json\`
exists and \`commands.typecheck\` is declared, \`validity__plan\`
auto-attaches a blocking \`repo-typecheck\` criterion to every plan, so a
type error can never sign off.

## Continuous monitoring & the scorecard

Validity keeps a durable scorecard (\`.validity/scorecard.json\`) + signal queue
(\`.validity/signals.json\`) of every frozen spec's standing. All local — nothing
is uploaded. Two engines, split on the LLM line:

- **Mechanical re-check (no LLM)** — re-run frozen hard/property checks:
  - \`validity verify --all\` — sweep every frozen spec.
  - \`validity signals list [--all]\` — print the signal queue (open by default; \`--all\` includes resolved + suppressed).
  - \`validity signals suppress <id> [--note]\` — park a signal until the spec's files change past HEAD.
  - \`validity signals resolve <id> [--note]\` — manually close a signal (\`resolvedBy: manual\`).
  - \`validity doctor --rebuild-signals\` — replay \`.validity/history/signals.jsonl\` into a fresh \`signals.json\`.
  - \`validity trends\` — write a self-contained \`.validity/reports/trends.html\`:
    per-spec verdict/coverage timelines, per-criterion strips, perf
    sparklines, the score line, and the signal history.
  - \`validity compare <runA> <runB>\` — side-by-side HTML for two verify runs
    (screenshots paired by render slug, criteria verdict deltas, perf deltas).
  - \`validity attest verify <run-dir>\` — re-check the run's Ed25519 attestation
    chain (run-meta, every screenshot's sha256, report.html, frozen spec). Names
    the exact field or file that changed and exits non-zero. This one DOES gate:
    a failed attestation means the artifacts were edited after Validity wrote them.
  - \`validity replay <run-dir | report.html>\` — the command a skeptical reviewer
    runs. Verifies the attestation, then RE-EXECUTES the deterministic lane (the
    hard + property checks from the frozen spec the run cited, loaded by
    \`specHash\`) against the current working tree and diffs the fresh verdicts
    against the attested ones per criterion: reproduced / regressed / improved /
    unverifiable-now. Soft criteria are never re-scored — they print as "judged
    lane, not replayed" with their recorded provenance. A native run carrying a
    signed \`.ad\` recording (\`replay.ad\`, on by default via
    \`native.recordReplay\`) also re-executes that on-device journey — attach-only,
    it never boots a device or installs the companion. \`--keep-session\` leaves
    the device session up after the journey (native \`.ad\` only) so you can keep
    inspecting the screen it landed on — and so Validity captures advisory
    perf/network evidence into \`replay-device-evidence.json\`. A diverged
    journey writes \`replay-divergence.json\` (ranked selector suggestions plus
    the exact \`--from N --plan-digest <sha>\` resume line) and appends
    \`.validity/runs/replay-divergence.jsonl\`; the \`--save-script\` repair is
    yours to run — Validity never heals a recording it will then report on.
    A divergence also opens a \`replay-divergence\` signal on the scorecard,
    which closes when a later replay of that recording reproduces or when a
    fresh verify publishes a new signed recording for the spec. Both evidence
    files render in the run's \`report.html\` as a folded Journey drift /
    Device evidence section the next time the report is baked (the divergence
    is written after the run was signed — re-open it from the dashboard or
    after the next \`verify --all\`).
    Mark login values secret with \`scenarios[].secrets\` and they publish as
    \`\${NAME}\` placeholders, resolved from the environment at replay time. This one DOES gate: exit
    1 on a hard regression (or a broken chain), 3 when the lane could not be
    fully re-executed, 0 only when everything reproduced. \`--json\` for the
    structured result. 0 LLM tokens.
  - Both are local-only VIEWERS: they always exit 0 and never gate. Set
    \`historyCommitted: true\` in \`.validity/config.ts\` to also append
    committable run summaries to \`.validity/history/<specId>.jsonl\`
    (default off) so trends survive across machines.
- **The soft tier is scored by the agent, not the watcher** —
  \`validity__score_soft_criteria({ specId })\` (returns open soft criteria, the
  rubric, and screenshots) → score from the screenshots →
  \`validity__record_soft_scores({ specId, scores })\`. Wrap in \`/loop\` to keep a
  whole project current. Inspect or close the queue with
  \`validity__signals({ action: 'list' | 'suppress' | 'resolve', id?, note?, all? })\`
  (same three actions as \`validity signals\` on the CLI).

The repo-level **Validity Score** is a weighted pass-rate over every blocking
criterion. Informational only: it never gates sign-off or exit codes.

Cold-start a codebase with the onboard loop: \`validity__onboard_enumerate\`
(paginated worklist of un-specced components) → draft criteria +
\`validity__spec_create\`/\`spec_freeze\` → \`validity__onboard_progress\`.

## Fresh-context judging (kill self-grading)

Soft criteria are scored from screenshots — by default by the same agent
that built the change (the report badges this "self-scored"). To have a
clean-context judge score instead:

- Set \`scoring: { judge: 'fresh-context' }\` in \`.validity/config.ts\`.
- \`validity judge-pack <run-id>\` writes a self-contained bundle
  (\`.validity/runs/<run-id>/judge-pack/\`): screenshots + the frozen rubric +
  \`SCORING.md\`. It contains NO component source, NO diff, and NO prompt
  history — the judge scores blind.
- Spawn a fresh subagent (or hand the directory to a human), have it score
  (\`validity__score_soft_criteria\` with \`context: 'fresh'\` adds the
  blind-judging rubric), then record via \`validity__record_soft_scores\`
  with a distinct \`scoredBy\`. Validity warns when the judge identity
  matches the builder — and an unrecorded judge identity badges as
  self-scored, so the posture can't be claimed without evidence.
  Verdicts and sign-off math never change with judge mode — only badges and
  warnings do.

## Automated model judge (\`validity judge\`)

Instead of a human/subagent, an LLM can score the blind judge-pack — so soft
scores never depend on the agent that built the change, and CI can score them
too. Configure a provider in \`.validity/config.ts\`:

- \`scoring: { judgeModel: { provider: 'anthropic' | 'openai' | 'openai-compatible', model: '<id>', apiKeyEnv?, baseUrl? } }\`.
  The API key is read from the environment at call time (\`ANTHROPIC_API_KEY\` /
  \`OPENAI_API_KEY\` by default), never persisted, and sent only to your provider.
  \`openai-compatible\` requires \`baseUrl\`.
- \`validity judge <run-id>\` (or \`--spec <id>\` / \`--all\`) sends the pack to the
  model, validates the reply against \`scores.schema.json\` (one retry), and folds
  the scores through the SAME citation gate as \`record_soft_scores\` — an uncited
  soft pass is rejected. The report badges these "model-judged", distinct from
  self-attested.
- \`validity verify --all --judge\` scores soft criteria in CI after the mechanical
  checks. Any judge failure (missing key, provider error, schema-invalid twice)
  is a skipped-with-reason, never a pass; the exit gate stays hard/property-only.

## More

Full skill instructions: \`~/.claude/skills/validity/SKILL.md\`.
`;
