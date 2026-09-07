# Security

## Alpha scope and reporting

Validity is alpha software. Security fixes target the latest published alpha and the current main branch; older alpha versions are not separately maintained. There is no security sandbox or offline-execution guarantee.

Please report vulnerabilities privately using this repository's **Security → Advisories → Report a vulnerability** on GitHub, when private vulnerability reporting is available. If that option is unavailable, open an issue asking maintainers to enable a private reporting channel, without exploit details, credentials, or sensitive artifacts. Do not put sensitive reports in public issues or pull requests.

## Trust boundary

Use Validity only with projects, dependencies, local OS users, and local processes you trust. Loading `.validity/config.ts` or `.js` executes project code before schema validation; web rendering can also evaluate Vite configuration. Configured commands, callbacks, plugins, and dependencies execute with the invoking user's privileges and environment. Do not run untrusted projects or PR configurations with real secrets or privileged CI tokens.

Validity's web sandbox and native control bridge bind loopback. Their Validity HTTP APIs and control WebSocket endpoints check loopback Host/bound port and exact Origin when supplied; mutations require JSON Content-Type. Foreign and `null` browser origins are rejected. Local/native clients may omit Origin (React Native may supply the endpoint's HTTP origin). These checks defend against foreign browser origins and DNS rebinding, **not local users/processes: they are trusted, not authenticated**. Do not expose or proxy the control services to a network. Project Expo/Metro hosting is managed separately and is not covered by the bridge's loopback binding. MCP uses stdio and trusts its agent host.

File containment checks reject symlink screenshot sources and untracked diff files, including relative parent-directory symlinks. They are not a defense against a malicious local process racing filesystem changes. Project code, screenshots, and artifact contents remain trusted inputs, not comprehensively sanitized data.

## Outbound data and execution

- There is no first-party telemetry sender in the current code, but verification is not offline. Native companion setup runs a package manager, Expo prebuild/build, and potentially `npx pod-install`; downloads and install/build scripts can access the network.
- Generated synthetic fixtures and network mocks can reference `i.pravatar.cc` and `picsum.photos`. Rendering these images can contact those services, redirects, and CDNs. Project assets and browser/device requests can also leave the host.
- Mocking is not a firewall. URL mode permits navigation and unmatched requests; native mock initialization failures can fall back to real networking while rendering continues. Use synthetic credentials and external egress controls when isolation matters.
- Automated judging is opt-in (`validity judge` or `verify --all --judge`). It sends screenshots, soft criterion text, screenshot labels (including full captured URLs), and abbreviated render errors to Anthropic, OpenAI, or the configured compatible endpoint, and may retry once. Blind packs exclude source, diff, and prompt fields, but pixels, URLs, and rubric text are not generally secret-redacted. Judge transport requires HTTPS except loopback development HTTP and refuses redirects. `judge-pack` alone writes a local bundle.
- MCP returns screenshot bytes and diagnostics to the selected agent host. Full-detail or failing lean renders can include component source excerpts; `get_config` returns serialized configuration. The agent host/model provider's handling applies independently of the judge setting.
- `native.remote.configPath` delegates device commands to the configured agent-device remote profile. The GitHub composite action installs Validity, uploads report/check artifacts, creates a check, and defaults PR commenting on. Ordinary CLI report generation does not upload artifacts. The removed CLI `watch` command is not a current automatic-upload feature.

## Sensitive artifacts

Reports are enabled by default and can collect repository-wide tracked and untracked changes, not just requested component files. Reports, run metadata, logs, command strings/output tails, screenshots, URLs, source excerpts, and judge packs can contain confidential data. Filename-based secret exclusions are not comprehensive secret detection. PNG signature/header/trailer checks establish a screenshot file type, not that its pixels or metadata are safe to share.

Native replay recording defaults on; device network/performance evidence defaults off. Declared replay/fill secret values are replaced with placeholders in supported diagnostics and recordings, but this is not general redaction of application output, screenshots, or undeclared secrets.

Review artifacts before uploading, sharing with an agent/model, or publishing CI results. Keep `.validity` artifacts out of public source control, use synthetic data, and apply your own retention/access controls.
