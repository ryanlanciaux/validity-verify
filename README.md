# validity-verify

Frozen acceptance specs for UI. A coding agent plans criteria, Validity renders the live UI in isolation, mechanical checks run against that render, screenshots are scored for the soft lane, and a report is written.

Two runtimes. Vite / Next → a Vite sandbox + Playwright. Expo / React Native → a real simulator or emulator, through a companion app. Same spec, same `plan → verify → submit_report` loop, same `report.html`.

```
spec.yaml
    │
    ├─ browser     Vite isolation + Playwright     @validity.ai/verify-web
    └─ simulator   companion + agent-device        @validity.ai/verify-native
              │
              ▼
         report.html                               @validity.ai/verify-report
```

```
@validity.ai/verify              CLI + MCP
@validity.ai/verify-spec         schema, freeze, hash, fold
@validity.ai/verify-web          browser runtime
@validity.ai/verify-native       simulator runtime
@validity.ai/verify-report       report.html
@validity.ai/verify-plugin-vite  app-manifest for Vite
@validity.ai/verify-plugin-next  app-manifest for Next
@validity.ai/verify-plugin-expo  deep-link scheme + native mocks
```

Plugins run in the app under test so isolated verify sees real env, aliases, and CSS. They are not runtimes.

Hard checks are machine-proven. Soft checks are scored from screenshots. `unverifiable` is not a pass.

`validity install-wizard` is the MCP setup for both paths. It detects Claude Code, Cursor, and OpenCode, registers `validity-mcp` with them, and copies the skill. Codex gets a TOML snippet to paste. You do not hand-edit MCP JSON for those agents. After a later `npm install -g`, `validity install-wizard --non-interactive` refreshes whatever is already wired.

Validity is alpha software for trusted local projects, not a sandbox. See [Security](SECURITY.md) for the trust model, outbound data, sensitive artifacts, and private vulnerability reporting.

## Web (Vite / Next)

The isolation sandbox uses **Vite 6**. Vite 8 / Rolldown plugins are not
compatible yet (including the current `create-vite` default). For a React Vite
app, use the tested pair before running `validity init`:

```sh
npm install -D vite@6.4.3 @vitejs/plugin-react@4.7.0
```

`validity install-browser` installs Chromium using Validity's own Playwright
version; no globally exposed `playwright` binary or separate `npx` install is needed.

```sh
npm install -g @validity.ai/verify
validity install-browser
validity install-wizard
```

```sh
cd /path/to/your-app
validity init
```

That writes `.validity/config.ts`, clones your providers into `.validity/wrapper.gen.tsx`, and wires the Vite or Next plugin.

Ask the agent to verify the UI. It renders in Validity's Vite sandbox (Playwright). It does not start your app's dev server.

```
validity__plan → build → validity__verify → validity__submit_report
```

Mechanical regression (no LLM):

```sh
validity verify --all
validity spec ls
validity spec export <id>
validity doctor
validity start
```

CI:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npm install -g @validity.ai/verify
- run: validity install-browser --with-deps
- run: validity verify --all --report-html validity-report.html --check-output validity-check.json
```

`packages/verify-action` posts the check JSON as a PR comment when you point it at those files.

## Native (Expo / React Native)

No Playwright. Validity renders on a real simulator or emulator through a **companion app** — a separate Validity install (own bundle id / scheme) beside yours. Your app is never edited or replaced.

```sh
npm install -g @validity.ai/verify
npm i -g agent-device
validity install-wizard
```

```sh
cd /path/to/your-app
validity init
```

That pins the project to the device (`renderMode: 'native'`). Plugin wiring is a
safe-edit or a printed paste stanza — an Ignite `app.json` without an `"expo"` key
cannot be auto-wired. Add `"@validity.ai/verify-plugin-expo"` to the `plugins`
array in the app's effective Expo config (often `app.config.ts` in Ignite),
then install dependencies. Do not add an `"expo"` wrapper to Ignite's metadata
just to satisfy auto-wiring.

Boot a simulator or emulator **before** the first native command — there is nothing
to install onto otherwise:

```sh
open -a Simulator                 # iOS (macOS / Xcode)
emulator -list-avds               # then: emulator -avd <name>
validity browse --native
```

That prints a readiness checklist (Xcode / Android SDK, mock deps, scheme). Work it down and re-run until every line is a ✓. The first `expo run:ios` / `expo run:android` takes a few minutes. After that, verify and browse reuse the companion and take seconds.

`validity start` surfaces this as the one-time "Build the device companion" step. Later renders do not rebuild it.

Ask the agent to verify the UI. `validity__verify` goes to the simulator automatically:

```
validity__plan → build → validity__verify → validity__submit_report
```

Plan a spec with a meaningful criterion that includes at least one hard/mechanical
check (soft criteria are skipped by verify --all), verify the existing UI and show
the screenshot/verdict, then freeze that spec via `validity__plan freeze:true` or
`validity spec freeze <id>`, then run the mechanical regression:

```sh
validity verify --all
```

Do not route it through Expo Web (`react-native-web`) to skip a device build. That is opt-in only (`webTarget: true`, or `framework: 'expo-web'` in config) — a different runtime than the app ships on.

Ordinary headless web CI (Playwright/Chromium only) covers web specs only. Native
mechanical checks need a simulator/emulator-equipped runner: iOS on macOS with
Xcode, or Android with the SDK + an AVD (`--native-avd` / `--native-apk`).

## CLI

| Command                                        | What                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `validity install-browser`                     | Install matching Chromium (`--with-deps` for Linux CI)              |
| `validity init`                                | Scaffold `.validity/`                                               |
| `validity start`                               | Next setup step                                                     |
| `validity doctor`                              | Local diagnostics                                                   |
| `validity install-wizard`                      | MCP + skill hosts                                                   |
| `validity verify --all`                        | Mechanical sweep of frozen specs                                    |
| `validity spec ls \| show \| freeze \| export` | Specs                                                               |
| `validity export <run-id>`                     | Playwright scaffolds from a run                                     |
| `validity accept <run-id>`                     | Promote screenshots to baselines                                    |
| `validity attest verify <run-dir>`             | Check run attestation                                               |
| `validity replay <run-dir>`                    | Re-run deterministic checks                                         |
| `validity judge`                               | Soft-score with a separate model                                    |
| `validity judge-pack`                          | Blind scoring bundle                                                |
| `validity signals`                             | Local signal queue                                                  |
| `validity trends`                              | History HTML                                                        |
| `validity compare`                             | Side-by-side two runs                                               |
| `validity onboard`                             | Bulk-draft specs                                                    |
| `validity clean`                               | Remove old runs                                                     |
| `validity help`                                | Agent reference                                                     |
| `validity browse`                              | Debug render (not verification). Native: `validity browse --native` |

## Packages

Consumers of the spec format only need `@validity.ai/verify-spec` (YAML schema, freeze, hash, `foldCheckVerdicts`). The CLI depends on the web and native runtimes. Do not import `@validity.ai/verify-web` from a native-only host, or the reverse.

## This repo

```sh
pnpm install
pnpm build
pnpm --filter @validity.ai/verify exec playwright install chromium
pnpm validity verify --all --cwd examples/basic-vite-app
```
